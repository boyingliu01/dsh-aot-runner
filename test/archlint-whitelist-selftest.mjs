#!/usr/bin/env node
/**
 * `.archlint.yaml` 入口脚本白名单的防漂移自检（issue #32 建议 3）。
 *
 * ## 为什么需要它
 *
 * `.archlint.yaml` 里那段白名单写着「保证将来真新增的孤儿模块仍会被检出来」——
 * 逐个列出入口脚本、在注释里承诺「新入口记得补进来」。但**这个承诺已经失效过一次**：
 * 白名单停在 3 条，而实际入口脚本已有 8 个，于是新增的 5 个全被 archlint
 * 报成 `Dead Code MEDIUM`（issue #32）。
 *
 * 后果很隐蔽：Gate 6 仍然判 PASS（0 high/critical），但分数被误报稀释
 * （8.5/10 而非 10/10），真正的问题会淹没在噪声里。靠人记得补是不可靠的，
 * 所以让机器盯。
 *
 * ## 判据
 *
 * 对 `scripts/*.mjs` 与 `bench/*.cjs` 里的每个文件：
 *
 *   1. 它是否被某处**引用**？（package.json script / ci.yml / build.sh /
 *      README / 其他脚本 import）
 *   2. 若被引用，它是否在 `.archlint.yaml` 的白名单里？
 *
 * 两个条件交叉出四种情况，只有一种需要报错：
 *
 * | 被引用 | 在白名单 | 结论 |
 * |---|---|---|
 * | 是 | 是 | ✅ 正常 |
 * | 是 | 否 | ❌ **报错** —— archlint 会误报它，要么补白名单要么确认它是库 |
 * | 否 | 是 | ⚠️ 提醒 —— 白名单里有僵尸条目，文件可能是孤儿 |
 * | 否 | 否 | ✅ 正常（真孤儿，archlint 该报就报） |
 *
 * 第 2 行是重点：`scripts/lib/xxx.mjs` 这种被 import 的**库**不该进白名单，
 * 所以判据不能是「scripts 下所有文件都必须在白名单里」。
 *
 * ## 用法
 *
 *   node test/archlint-whitelist-selftest.mjs
 *
 * 退出码 0 = 一致；1 = 有漂移（并打印具体怎么补）。
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, basename } from 'node:path';
import process from 'node:process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const WHITELIST_MARKER = '---- 直接执行的入口脚本 ----';
const WHITELIST_END_MARKER = '---- 非源码 / 生成物 ----';

/**
 * 解析 `.archlint.yaml` 里「入口脚本」那一段的白名单条目。
 *
 * 只在那一段范围内找，避免把测试夹具或生成物条目误算进来。
 */
function readWhitelist() {
  const text = readFileSync(resolve(ROOT, '.archlint.yaml'), 'utf8');
  const startIdx = text.indexOf(WHITELIST_MARKER);
  if (startIdx === -1) {
    throw new Error(
      `.archlint.yaml 里找不到标记「${WHITELIST_MARKER}」—— 注释结构变了，请同步更新本脚本。`,
    );
  }
  const endIdx = text.indexOf(WHITELIST_END_MARKER, startIdx);
  const section = endIdx === -1 ? text.slice(startIdx) : text.slice(startIdx, endIdx);

  const entries = [];
  for (const line of section.split('\n')) {
    const m = /^\s*-\s*'([^']+)'\s*$/.exec(line);
    if (m) entries.push(m[1].replace(/\\/g, '/'));
  }
  return entries;
}

/**
 * 收集候选入口脚本。
 *
 * 范围 = 「本仓库里会被工具按路径直接执行、因而不通过 import 被引用的文件」：
 *   scripts/*.{mjs,py}   被 package.json / build.sh / ci.yml 直接调用
 *   bench/*.cjs          被 README / npm script 直接调用
 *   根目录配置文件        被工具按名字加载（eslint.config.mjs）
 *
 * **故意不含** `scripts/lib/` 这类子目录：那些是被 import 的库，
 * 本来就该由 archlint 正常分析，不该进白名单。
 */
function collectCandidates() {
  const out = [];
  const patterns = [
    ['scripts', /\.(mjs|py)$/],
    ['bench', /\.cjs$/],
    ['.', /^eslint\.config\.mjs$|^jscpd\.conf\.json$/],
  ];
  for (const [dir, re] of patterns) {
    const abs = resolve(ROOT, dir);
    if (!existsSync(abs)) continue;
    for (const f of readdirSync(abs)) {
      if (!re.test(f)) continue;
      if (!existsSync(resolve(abs, f))) continue;   // 跳过目录
      out.push(dir === '.' ? f : `${dir}/${f}`);
    }
  }
  return out.sort();
}

/**
 * 汇总「引用证据」的文本来源。
 *
 * 把可能引用脚本的地方全部拼成一个大字符串再查找 basename ——
 * 这比逐个文件做 AST 分析简单得多，而且**宁可多算引用也不漏算**：
 * 漏算会让「该补白名单的文件」被静默放过，正是我们要防的。
 */
function readReferenceCorpus() {
  const files = [
    'package.json',
    'build.sh',
    '.github/workflows/ci.yml',
    'README.md',
    'ROADMAP.md',
    '.githooks/pre-commit',
    '.githooks/pre-push',
  ];
  const parts = [];
  for (const f of files) {
    const abs = resolve(ROOT, f);
    if (existsSync(abs)) parts.push(readFileSync(abs, 'utf8'));
  }

  // 所有 JS/脚本源码也可能 import 它们。
  for (const dir of ['scripts', 'test', 'bench', 'plugin/lib']) {
    const abs = resolve(ROOT, dir);
    if (!existsSync(abs)) continue;
    for (const f of readdirSync(abs)) {
      if (!/\.(mjs|cjs|js)$/.test(f)) continue;
      parts.push(readFileSync(resolve(abs, f), 'utf8'));
    }
  }
  return parts.join('\n');
}

/**
 * 判断某文件是否被引用。
 *
 * 用 basename 匹配（而不是完整路径）：`node scripts/foo.mjs` 与
 * `import './foo.mjs'` 两种写法都能覆盖；ill-formed 路径写法各种前缀都能命中。
 */
function isReferenced(relPath, corpus) {
  const name = basename(relPath);
  if (!corpus.includes(name)) return false;

  // 排除「只在自己文件里出现」的假阳性：该文件自己的内容也在地库里。
  const own = readFileSync(resolve(ROOT, relPath), 'utf8');
  const withoutOwn = corpus.split(own).join('');
  return withoutOwn.includes(name);
}

// ---- 主流程 ----

const whitelist = readWhitelist();
const candidates = collectCandidates();
const corpus = readReferenceCorpus();

const missing = [];   // 被引用但不在白名单 → 报错
const stale = [];     // 在白名单但无引用 → 提醒

for (const rel of candidates) {
  const inWhitelist = whitelist.includes(rel);
  const referenced = isReferenced(rel, corpus);
  if (referenced && !inWhitelist) missing.push(rel);
  if (!referenced && inWhitelist) stale.push(rel);
}

console.log('archlint 入口脚本白名单自检\n');
console.log(`  候选脚本：${candidates.length} 个   白名单：${whitelist.length} 条\n`);

let failed = 0;

if (missing.length > 0) {
  failed = 1;
  console.error(`  FAIL  ${missing.length} 个被引用的入口脚本不在白名单里：`);
  for (const f of missing) console.error(`          ${f}`);
  console.error(
    '\n        这些文件会被 archlint 报成 Dead Code（误报），稀释 Gate 6 分数。\n' +
    '        补进 .archlint.yaml 的「直接执行的入口脚本」段即可。',
  );
} else {
  console.log('  PASS  所有被引用的入口脚本都在白名单里');
}

if (stale.length > 0) {
  console.warn(`\n  WARN  ${stale.length} 条白名单条目已找不到引用（可能是孤儿文件）：`);
  for (const f of stale) console.warn(`          ${f}`);
  console.warn('        确认后从白名单删除，或确认它确实是入口（ci.yml 之外的调用方式）。');
} else {
  console.log('  PASS  白名单里没有僵尸条目');
}

// 交叉验证：白名单里不能有根本不存在于候选集的文件（拼写错误）。
const unknown = whitelist.filter((w) => !candidates.includes(w));
if (unknown.length > 0) {
  failed = 1;
  console.error(`\n  FAIL  ${unknown.length} 条白名单条目指向不存在的脚本（可能拼错了）：`);
  for (const f of unknown) console.error(`          ${f}`);
}

console.log('');
process.exit(failed === 0 ? 0 : 1);

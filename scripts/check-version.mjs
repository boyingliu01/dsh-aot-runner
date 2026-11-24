#!/usr/bin/env node
/**
 * 版本一致性检查（对应 xp-gate Gate 0）
 *
 * 检查三处版本号是否一致：
 *   VERSION          —— 项目版本的事实来源
 *   package.json     —— 仓库根（private，只管本地脚本）
 *   plugin/package.json —— 要发布到 npm 的插件包
 *
 * 为什么需要它：0.1.0 发布时 VERSION 还停在 1.0.0，两者相差一个大版本。
 * 版本号分裂不会让任何东西跑不起来，所以没人会注意到 —— 直到有人问
 * "到底哪个是当前版本"。Gate 0 存在的意义就是拦住这种沉默的漂移。
 *
 * 为什么还要检查 package-lock.json：它有两处版本号（顶层 version 与
 * packages[""].version），npm 只在前者上工作，后者是 lockfile v2/v3 的副本。
 * 升级版本时漏掉后者，`npm ci` 与 `npm install` 会给出不同的树 ——
 * 而且这个不一致**不会让任何命令失败**，只会让 lockfile 慢慢变得不可信。
 *
 * 用法：
 *   node scripts/check-version.mjs          # 检查
 *   node scripts/check-version.mjs --tag    # 额外校验 git tag 是否匹配
 *   node scripts/check-version.mjs --sync   # 以 VERSION 为准，把其余来源写齐
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import process from 'node:process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 需要与 VERSION 保持一致的 JSON 文件。
 *
 * 抽成常量而不是在每处重复字面量：这个清单曾在「加 package-lock.json」时
 * 只改了检查、漏了 --staged，于是暂存覆盖校验对着一个不完整的清单跑绿。
 */
const VERSION_FILES = ['package.json', 'plugin/package.json', 'package-lock.json'];

/** 读 JSON 文件，失败时给出可操作报错而不是堆栈。 */
function readJson(relPath) {
  const full = resolve(ROOT, relPath);
  try {
    return JSON.parse(readFileSync(full, 'utf8'));
  } catch (error) {
    throw new Error(`无法读取 ${relPath}: ${error.message}`);
  }
}

/** 读纯文本版本号（去空白）。 */
function readVersionFile(relPath) {
  try {
    return readFileSync(resolve(ROOT, relPath), 'utf8').trim();
  } catch {
    return null;
  }
}

/** 取最近的 git tag 并去掉前缀 v。 */
function latestTag() {
  try {
    const tag = execFileSync('git', ['describe', '--tags', '--abbrev=0'], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return tag.replace(/^v/, '');
  } catch {
    return null;
  }
}

/** 收集所有需要比对版本的来源。 */
function collectSources(checkTag) {
  const lock = readJson('package-lock.json');
  const sources = [
    { label: 'VERSION', value: readVersionFile('VERSION') },
    { label: 'package.json', value: readJson('package.json').version },
    { label: 'plugin/package.json', value: readJson('plugin/package.json').version },
    { label: 'package-lock.json (顶层)', value: lock.version },
    { label: 'package-lock.json (packages[""])', value: lock.packages?.['']?.version },
  ];

  if (checkTag) {
    sources.push({ label: 'git tag（最近）', value: latestTag() });
  }
  return sources;
}

/** 打印每个来源的当前值。 */
function printSources(sources) {
  console.log('版本一致性检查');
  console.log('─'.repeat(50));
  for (const { label, value } of sources) {
    console.log(`  ${label.padEnd(20)} ${value ?? '(缺失)'}`);
  }
  console.log('');
}

/** 检查是否有来源缺失版本号；全部齐全返回 true。 */
function checkMissing(sources) {
  const missing = sources.filter((s) => !s.value);
  if (missing.length === 0) return true;

  console.error(`❌ 以下来源缺失版本号：${missing.map((s) => s.label).join('、')}`);
  return false;
}

/** 检查所有来源是否一致；一致返回 true。 */
function checkMismatch(sources) {
  const unique = new Set(sources.map((s) => s.value));
  if (unique.size === 1) return true;

  console.error('❌ 版本号不一致，请统一为同一版本：');
  for (const { label, value } of sources) {
    console.error(`     ${label} = ${value}`);
  }
  console.error('\n修正方式：node scripts/check-version.mjs --sync');
  console.error('  （以 VERSION 为准写齐其余来源；不要手工改 package-lock.json 的两个字段）');
  return false;
}

/**
 * 检查「已同步到磁盘、但没被暂存」的版本文件。
 *
 * 为什么需要：xp-gate Gate 0 在 VERSION 被暂存时会自动跑 sync-version，
 * 但它只把**固定路径**（仓库根的 package.json、src/npm-package/…）加进暂存区。
 * 本仓库的 `plugin/package.json` 与 `package-lock.json` 不在那份清单里——
 * 于是脚本把它们改了、Gate 0 却只暂存了 package.json，提交里少两个文件。
 *
 * 这个缺口在 0.2.7 上真实发生过：Gate 0 报 PASSED，下一次提交才因为
 * 「VERSION 是 0.2.7 但这几个文件还是 0.2.6」被拦下。
 *
 * 检查的是「内容一致但暂存区里是旧版本」这个状态，而不是「工作区脏了」——
 * 后者太吵（任何一次编辑都会命中），前者则精确指向版本漂移。
 */
function checkStagedCoverage() {
  const unstaged = VERSION_FILES.filter((relPath) => {
    const staged = readStagedContent(relPath);
    if (staged === null) return false; // 不在暂存区：由 checkMismatch 负责
    return staged !== readFileSync(resolve(ROOT, relPath), 'utf8');
  });

  if (unstaged.length === 0) return true;

  console.error('');
  console.error('❌ 以下文件的版本号已同步，但没有被暂存（提交会漏掉它们）：');
  for (const file of unstaged) console.error(`     ${file}`);
  console.error('\n修正方式：');
  console.error(`  git add ${unstaged.join(' ')}`);
  console.error('  （xp-gate Gate 0 只自动暂存仓库根 package.json，见本脚本注释）');
  return false;
}

/** 读暂存区里的文件内容；不在暂存区时返回 null。 */
function readStagedContent(relPath) {
  try {
    return execFileSync('git', ['show', `:${relPath}`], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
}

/** 把 JSON 文件的某个字段改成 target，保持原有格式。返回是否改动。 */
function bumpJsonField(relPath, mutate, target) {
  const full = resolve(ROOT, relPath);
  const original = readFileSync(full, 'utf8');
  const data = JSON.parse(original);
  if (mutate(data, target) === false) return false;

  // 保持 2 空格缩进 + 尾随换行：与 npm 自己写出的形状一致，
  // 否则每次同步都会多出一条纯格式 diff。
  const next = `${JSON.stringify(data, null, 2)}\n`;
  if (next === original) return false;
  writeFileSync(full, next, 'utf8');
  return true;
}

/**
 * 每个版本文件的「怎么写版本号」。
 *
 * `package-lock.json` 单独一条：它有**两个** version 字段 —— 顶层的和
 * `packages[""]` 里的。npm 只在前者上工作，后者是 lockfile v2/v3 的副本；
 * 只改一个会让 `npm ci` 与 `npm install` 给出不同的树。
 */
const VERSION_WRITERS = {
  'package.json': setVersion,
  'plugin/package.json': setVersion,
  'package-lock.json': (lock, v) => {
    const topTouched = setVersion(lock, v);
    const root = lock.packages?.[''];
    const rootTouched = root !== undefined && setVersion(root, v);
    return topTouched || rootTouched;
  },
};

/** 把某个对象的 version 改成 v，返回是否改动。 */
function setVersion(obj, v) {
  if (obj.version === v) return false;
  obj.version = v;
  return true;
}

/** 以 VERSION 为准，把其余来源写齐。返回改动过的文件名。 */
function syncAll(target) {
  return VERSION_FILES.filter((file) => bumpJsonField(file, VERSION_WRITERS[file], target));
}

/** `--sync` 模式：以 VERSION 为准写齐其余来源。 */
function runSync(sources) {
  const canonical = sources[0].value;
  if (!canonical) {
    console.error('❌ VERSION 缺失，无法同步（VERSION 是版本号的事实来源）。');
    return 1;
  }

  const changed = syncAll(canonical);
  if (changed.length === 0) {
    console.log(`✅ 已一致，无需改动：${canonical}`);
    return 0;
  }

  console.log(`✅ 已同步 ${changed.length} 个文件到 ${canonical}：`);
  for (const file of changed) console.log(`     ${file}`);
  return 0;
}

/** 默认模式：只检查，不改文件。 */
function runCheck(sources) {
  if (!checkMissing(sources)) return 1;
  if (!checkMismatch(sources)) return 1;
  if (process.argv.includes('--staged') && !checkStagedCoverage()) return 1;

  console.log(`✅ 全部一致：${sources[0].value}`);
  return 0;
}

function main() {
  const sources = collectSources(process.argv.includes('--tag'));
  printSources(sources);

  return process.argv.includes('--sync') ? runSync(sources) : runCheck(sources);
}

process.exit(main());

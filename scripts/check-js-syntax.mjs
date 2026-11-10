#!/usr/bin/env node
/**
 * 全部 JS 文件的语法检查（`npm run lint:syntax`，CI 的 lint job 也调用它）。
 *
 * ## 为什么单独抽一个脚本
 *
 * 同一个判据（逐文件 `node --check`）原本在三处各写一遍 sh：
 * CI 的 lint job、本机 pre-commit 第 1 段、以及 CLAUDE/README 里的一句话说明。
 * 三份副本迟早漂移，而漂移是静默的 —— 某个目录被漏掉，检查依然打印 PASS。
 * 所以口径只在**这一个文件**里定义。
 *
 * ## 扫描口径
 *
 * 扫仓库内全部 `.js`/`.cjs`/`.mjs`，排除构建产物与依赖：
 * `node_modules/ bin/ obj/ dist/ coverage/ vendor/`
 *
 * `vendor/` 必须排除：那里是上游 `dsh-subprocess-local` 的补丁副本，
 * 语法错误属于上游，不该让本仓库 lint 变红（它的验证由
 * `vendor/patch-dsh.mjs verify` 负责）。
 *
 * @exitcode 0 = 全部通过；1 = 至少一个文件语法错误
 */
'use strict';

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 扫描时要跳过的目录名。用 Set 以便 O(1) 判断。 */
const SKIP_DIRS = new Set([
  'node_modules', 'bin', 'obj', 'dist', 'coverage', 'vendor',
  '.git', '.xp-gate', '.sprint-state', '.qoder', '.stryker-tmp',
  'TestResults',
]);

const JS_EXT = new Set(['.js', '.cjs', '.mjs']);

/** 递归收集仓库内需要检查的 JS 文件（返回相对路径）。 */
function collect(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out; // 目录不可读：跳过，而不是让整个检查崩掉
  }
  for (const e of entries) {
    const abs = join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      collect(abs, out);
    } else if (e.isFile() && JS_EXT.has(extname(e.name))) {
      out.push(relative(REPO_ROOT, abs));
    }
  }
  return out;
}

/**
 * 待检查的文件清单。
 *
 * 默认扫描全仓库（CI 与 `npm run lint` 用这个口径，必须全量）。
 *
 * 传 `--changed-from <file>` 时只检查该文件里列出的路径 —— pre-commit 用这个模式：
 * 它已经把改动集合算出来了，没必要为一次改 2 个文件的提交去启动 53 个 node 子进程。
 *
 * 用「文件清单」而不是「命令行参数列表」传路径：Windows 上命令行长度有限制，
 * 一次改动几百个文件时参数列表会被截断，而截断后少检查的文件不会报错 ——
 * 那正是「假装检查过了」。
 *
 * 传 `--list` 时**只输出文件清单并退出 0**，不做语法检查。
 * 给测试用：让 `test/aot-observe-verify.js` 能断言「扫描范围够不够」，
 * 而不必把扫描实现（ignore 集合、扩展名集合）复制一份到测试里 ——
 * 复制出来的那份会漂移，然后测试替一个错误的口径背书。
 *
 * ## 为什么不把全量模式也提速（实测过，都否决了）
 *
 * 全量的成本几乎全是进程启动：每个文件一次 `node --check` 约 102ms，
 * 53 个文件 ≈ 5.4s。改线程内的批量解析确实能快一个数量级，但都有硬伤：
 *
 * | 方案                        | 实测  | 否决理由                                  |
 * |-----------------------------|-------|-------------------------------------------|
 * | 逐文件 spawn（现状）        | 5400ms | ——                                        |
 * | 并行 spawn（Promise.all）   | 3377ms | 只省 37%，仍然每个文件一个进程             |
 * | vm.SourceTextModule 批量    |  483ms | 必须加 `--experimental-vm-modules`，         |
 * |                             |        | 实验性 API 可能变更/移除（不加时该导出是   |
 * |                             |        | undefined），语法门禁不能建在不稳定基础上  |
 * | --changed-from（已采用）    |  470ms | 快且无额外依赖，覆盖了 pre-commit 全部场景  |
 *
 * 结论：慢的那条路径只在 CI 与手动全量检查时走，5 秒可以接受；
 * 日常提交走改动集合，快 11 倍且判据完全一致。
 */
function readFileList(listPath) {
  let raw;
  try {
    raw = readFileSync(listPath, 'utf8');
  } catch (e) {
    // 拿不到清单不能当作「没有要检查的文件」—— 那会把「没检查」显示成「通过」。
    console.error(`[lint:syntax] 无法读取改动清单 ${listPath}: ${e.message}`);
    process.exit(1);
  }
  return raw
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((rel) => JS_EXT.has(extname(rel)));
}

const listArgIdx = process.argv.indexOf('--changed-from');
const files = listArgIdx === -1
  ? collect(REPO_ROOT).sort()
  : readFileList(process.argv[listArgIdx + 1]).sort();

// 扫到 0 个文件说明扫描路径出了问题（例如在错误目录执行）。
// 这时报 OK 等于「假装检查过了」—— 与 pre-commit 里同一条判据。
// 例外：--changed-from 模式下清单为空是合法的（调用方只会传有 JS 改动的清单，
// 能走进来说明它判错了）；这里仍然报错，让不一致立刻暴露而不是静默放行。
if (files.length === 0) {
  console.error('[lint:syntax] 没找到任何 JS 文件 —— 扫描路径可能不对');
  process.exit(1);
}

// --list：只交底「扫到了哪些」，给测试断言覆盖范围用。
// 放在「0 个文件」判据之后，所以扫描路径坏掉时 --list 也会失败而不是输出空清单。
if (process.argv.includes('--list')) {
  for (const rel of files) console.log(rel);
  process.exit(0);
}

let failed = 0;
for (const rel of files) {
  const abs = join(REPO_ROOT, rel);
  // 清单里的文件可能已被删除（先 add 后 delete），跳过而不是报语法错误。
  if (!existsSync(abs)) continue;
  const r = spawnSync(process.execPath, ['--check', abs], {
    encoding: 'utf8',
  });
  if (r.status !== 0) {
    failed++;
    console.error(`  语法错误: ${rel}`);
    const detail = (r.stderr || '').split('\n').slice(0, 3).join('\n');
    if (detail.trim()) console.error(`    ${detail.trim()}`);
  }
}

if (failed > 0) {
  console.error(`[lint:syntax] ${failed}/${files.length} 个文件语法检查未通过`);
  process.exit(1);
}

console.log(`[lint:syntax] ${files.length} 个文件通过`);

#!/usr/bin/env node
/**
 * VERSION → package.json / plugin/package.json / package-lock.json 的扇出。
 *
 * 为什么有这个文件：xp-gate 的 Gate 0 在 VERSION 被暂存时会**自动**调用
 * `scripts/sync-version.cjs`（hooks/gate-entries/gate-0-entry.sh:166），
 * 让「改版本号」和「其余文件跟上」变成一次原子提交。
 *
 * 如果这个文件不存在，那条自动扇出就静默跳过 —— 而**报错文案仍然无条件打印**
 * `node scripts/sync-version.cjs`（同文件 :362-363）。于是照提示执行会得到
 * `Cannot find module`，而且真正的不一致要等到下一次提交才由 Gate 0 拦下。
 * 0.2.7 的提交就撞上了这一幕。
 *
 * 真正的实现在 `scripts/check-version.mjs --sync` —— 那里已经知道
 * 「哪些文件需要同步」和「package-lock.json 有两个 version 字段」这两件事。
 * 本文件只是一层适配：把调用约定对齐到 xp-gate 期望的名字，避免逻辑分叉成两份。
 *
 * 手写 `.cjs` 而不是 `.mjs`：xp-gate 的探测顺序是 .cjs → .sh，
 * 且用 `node <path>` 直接执行（不经过 package.json 的 type 字段），
 * CommonJS 在两种情况下都能跑。
 */
const { spawnSync } = require('node:child_process');
const { dirname, resolve } = require('node:path');

const ROOT = resolve(dirname(__filename), '..');
const CHECKER = resolve(ROOT, 'scripts', 'check-version.mjs');

// `--sync` 是幂等的：已经一致时输出「无需改动」并以 0 退出。
const result = spawnSync(process.execPath, [CHECKER, '--sync'], {
  cwd: ROOT,
  stdio: 'inherit',
});

if (result.error) {
  console.error(`sync-version: 无法执行 ${CHECKER}: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);

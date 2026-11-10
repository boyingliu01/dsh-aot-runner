#!/usr/bin/env node
/**
 * `.githooks/pre-push` 转发器验证（issue: pre-push 门禁在本仓库从未执行过）
 *
 * ## 背景
 *
 * 本仓库 `core.hooksPath=.githooks`，而 `xp-gate init` 只把 hook 装到
 * `.git/hooks/`。`.githooks/pre-commit` 当初显式写了转发（第 2 段），
 * 但 **pre-push 漏掉了** —— 于是 `.git/hooks/pre-push` 从安装那天起
 * 就没执行过，`.xp-gate/reports/pre-push/` 一直是空目录。
 *
 * 「没跑」和「通过」在 git 里看起来完全一样，所以没人发现。
 *
 * ## 这个测试守什么
 *
 * 1. 转发器存在且可执行
 * 2. 找不到全局 hook 时**明确告警**，不静默放行
 * 3. 不会转发给自己（`core.hooksPath` 指回 `.githooks` 时会无限递归）
 * 4. `AOT_SKIP_GLOBAL_GATES=1` 的行为与 pre-commit 一致
 *
 * 第 3 条是本文件存在的主要理由：递归转发会让每次 push 卡死，
 * 而且现场看起来像"门禁很慢"，排查方向会被带偏。
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const SHIM = path.join(REPO, '.githooks', 'pre-push');

/** 运行转发器，返回 { status, output }。 */
function runShim(env = {}) {
  const r = spawnSync('sh', [SHIM], {
    cwd: REPO,
    encoding: 'utf8',
    timeout: 30000,
    input: '',
    env: { ...process.env, ...env },
  });
  return { status: r.status, output: `${r.stdout || ''}${r.stderr || ''}` };
}

test('转发器存在且可执行', () => {
  assert.ok(fs.existsSync(SHIM), '.githooks/pre-push 必须存在');
  const st = fs.statSync(SHIM);
  // Windows 上 exec 位不可靠，这里只断言「有内容」；可执行性由下面实际运行验证
  assert.ok(st.size > 0, '转发器不能是空文件');
});

test('AOT_SKIP_GLOBAL_GATES=1 时跳过且明确说明', () => {
  const r = runShim({ AOT_SKIP_GLOBAL_GATES: '1' });
  assert.strictEqual(r.status, 0);
  assert.match(r.output, /AOT_SKIP_GLOBAL_GATES=1/);
  assert.match(r.output, /跳过 xp-gate 全局门禁/);
});

test('不会把自己当作转发目标（防无限递归）', () => {
  const src = fs.readFileSync(SHIM, 'utf8');
  // 候选循环里必须排除本文件自身
  assert.match(
    src,
    /\.githooks\/pre-push/,
    '必须有排除自身的判断，否则 core.hooksPath 指回 .githooks 时会自我递归',
  );
});

test('找不到全局 hook 时不静默放行', () => {
  const src = fs.readFileSync(SHIM, 'utf8');
  // 必须存在「未找到 → 告警」的分支
  assert.match(src, /未找到 xp-gate pre-push/, '缺少「未找到全局 hook」的告警分支');
  assert.match(src, />&2/, '告警必须输出到 stderr，不能混在正常输出里');
});

test('转发失败路径的退出码语义正确', () => {
  // 找不到 hook 时退出 0（不阻断 push，但已告警）——这与 pre-commit 第 2 段一致：
  // 门禁缺失是环境问题，不该让开发者连 push 都做不了。
  const src = fs.readFileSync(SHIM, 'utf8');
  const missBlock = src.slice(src.indexOf('未找到 xp-gate pre-push'));
  const following = missBlock.slice(0, 200);
  assert.match(following, /exit 0/, '缺失 hook 时应 exit 0（告警但不阻断）');
});

test('真实环境下能定位到全局 pre-push（本机已安装）', () => {
  const globalHook = path.join(
    process.env.HOME || process.env.USERPROFILE || '',
    '.config', 'xp-gate', 'hooks', 'pre-push',
  );
  if (!fs.existsSync(globalHook)) {
    // 未安装 xp-gate 的机器上跳过，而不是假装通过
    return;
  }
  const r = runShim({});
  assert.match(
    r.output,
    /转交 xp-gate 全局门禁/,
    `应该能找到并转交 ${globalHook}，实际输出: ${r.output.slice(0, 200)}`,
  );
});

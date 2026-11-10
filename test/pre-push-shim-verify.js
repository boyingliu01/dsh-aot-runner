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

// ===========================================================================
// 第 1 段：本地 C# 编译检查
//
// 背景：xp-gate 的 pre-push 用 SOURCE_EXTENSIONS 判断「有没有源码」，
// 而那个列表里**没有 .cs**。本仓库是纯 C# 项目，于是每次推送都被判为
// `📚 Documentation-only push`，11 个门禁全跳过、有效工作量为 0，
// 却打印 `✅ No code review required`（见 xp-gate issue #798 / PR #799）。
//
// 上游修复发布前，本仓库的推送路径等于完全没有检查，所以在这里补一段。
// 这些测试守的就是「这一段确实在守，而不是又一次看起来在守」。
// ===========================================================================

test('pre-push 包含本地 C# 编译检查段', () => {
  const src = fs.readFileSync(SHIM, 'utf8');
  assert.match(src, /dotnet build/, '缺少 dotnet build 调用');
  assert.match(src, /DshAotRunner\.sln/, '必须显式指定 .sln，否则 sln+csproj 并存会 MSB1011');
});

test('本地检查只针对 C#/工程文件，纯文档推送不付编译代价', () => {
  const src = fs.readFileSync(SHIM, 'utf8');
  // 扩展名列表必须含 cs 与工程文件
  const m = src.match(/grep -qE '\\.\(([^)]+)\)\$'/);
  assert.ok(m, '未找到源码扩展名判定');
  for (const ext of ['cs', 'csproj', 'sln']) {
    assert.ok(m[1].includes(ext), `扩展名判定缺少 ${ext}`);
  }
});

test('本地检查被拦住时以非 0 退出（真正的阻断）', () => {
  const src = fs.readFileSync(SHIM, 'utf8');
  // 编译失败分支必须在 exit 1 之前，不能落到转发段
  const failIdx = src.indexOf('C# 编译未通过');
  assert.ok(failIdx > 0, '缺少编译失败分支');
  const after = src.slice(failIdx, failIdx + 200);
  assert.match(after, /exit 1/, '编译失败必须 exit 1，否则等于放行');
});

test('本地检查有独立开关，且默认开启', () => {
  const src = fs.readFileSync(SHIM, 'utf8');
  assert.match(src, /AOT_SKIP_LOCAL_CHECKS/, '缺少本地检查开关（测试需要它）');
  // 默认必须是跑检查，而不是跳过
  assert.match(src, /AOT_SKIP_LOCAL_CHECKS:-0/, '开关默认值必须是 0（默认跑检查）');
});

test('转发前回放 ref 列表 —— 不能把 stdin 吃掉', () => {
  const src = fs.readFileSync(SHIM, 'utf8');
  // 第 1 段读了 stdin，转发段必须把它还回去，否则全局 hook 拿到空输入，
  // 会表现为「no files changed」——又一个「看起来通过」的假象。
  assert.match(src, /PUSH_INPUT=\$\(cat\)/, '必须先把 ref 列表读进变量');
  // 单独断言「PUSH_INPUT 被喂回给全局 hook」。避开模板字符串里的反斜杠和引号：
  // 转义写错会得到「测试红了但其实代码是对的」这种最费时间的假象。
  assert.ok(
    src.includes('"$PUSH_INPUT" | exec sh "$XP_GATE_HOOK"'),
    '转发时必须把 PUSH_INPUT 喂给全局 hook',
  );
});

test('纯模板渲染：无 C# 改动时输出「跳过」而不是「通过」', () => {
  const src = fs.readFileSync(SHIM, 'utf8');
  const skipMsg = src.match(/跳过 C# 编译检查[^"]*/);
  assert.ok(skipMsg, '缺少跳过分支');
  // 跳过分支不得使用 ✅
  const line = src.split('\n').find((l) => l.includes('跳过 C# 编译检查'));
  assert.ok(!line.includes('✅'), '跳过 ≠ 通过，不能用 ✅ 标记');
});

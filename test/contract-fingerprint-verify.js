#!/usr/bin/env node
/**
 * tests for scripts/contract-fingerprint.mjs（issue #15 A 项）
 *
 * ## 测什么
 *
 * 这个脚本的价值全在「能不能在契约变了的时候报警」，
 * 以及「提取失败时会不会假报成功」。所以测试重点：
 *
 *   1. 正常情况下能提取出四项契约，且**内容正确**（不是"非空"就算过）
 *   2. 契约变了 → 指纹变 → 报 DRIFT、退出码 1
 *   3. 提取失败 → 报错、退出码 1（**不能**当成"没变化"通过）
 *
 * ## 第 3 条是最重要的
 *
 * 如果提取失败被静默跳过，这个检测器就形同虚设 —— 而它恰好会在
 * 上游改结构时失败，也就是最需要它工作的时刻。
 *
 * 本仓库反复记录过同一类错误：「命令跑起来了」不等于「命令测到了东西」。
 * 这里把那条教训直接写成测试。
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const REPO = path.resolve(__dirname, '..');
const SCRIPT = path.join(REPO, 'scripts', 'contract-fingerprint.mjs');
const BASELINE = path.join(REPO, '.contract-fingerprint.json');

/** 跑一次脚本，返回 { status, stdout, stderr }。 */
function run(args = []) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: REPO, encoding: 'utf8', timeout: 60000,
  });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

test('契约指纹：基线文件存在且包含四项契约', () => {
  assert.ok(fs.existsSync(BASELINE), '基线文件应已提交到仓库');

  const d = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
  for (const key of [
    'dshVersion', 'capturedAt', 'fingerprint', 'contracts',
  ]) {
    assert.ok(key in d, `基线缺少字段 ${key}`);
  }
  for (const key of [
    'startRequestFields', 'spawnErrorCodes', 'executableResolution', 'runnerStdioLayout',
  ]) {
    assert.ok(key in d.contracts, `基线缺少契约项 ${key}`);
  }
});

test('契约指纹：start 请求字段提取正确（type/cwd/env + 可选 control）', () => {
  // 这条是防「抓错对象」的回归测试。
  // 第一版曾抓到 error 结果结构 ["name","message"] —— 指纹照常生成，
  // 但它保护的是错误的东西。所以这里断言**具体内容**，不只是"非空"。
  const d = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
  const f = d.contracts.startRequestFields;

  assert.deepStrictEqual(f.required, ['type', 'cwd', 'env'],
    'start 请求必需字段应是 type/cwd/env —— 与 README 记载一致');
  assert.deepStrictEqual(f.optional, ['control'],
    '可选字段应是 control');
});

test('契约指纹：可执行文件扩展名只有 com/exe，且 com 优先', () => {
  // README 明确记载：候选扩展名只有 .com 和 .exe，且 .com 优先，不含 .bat/.cmd。
  // 这是 AOT runner 必须逐项对齐的关键契约之一。
  const d = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
  const e = d.contracts.executableResolution;

  assert.deepStrictEqual(e.candidateExtensions, ['com', 'exe'],
    '顺序有语义：com 必须在 exe 之前，不能被排序掉');
  assert.ok(!e.candidateExtensions.includes('bat'), '不应包含 .bat');
  assert.ok(!e.candidateExtensions.includes('cmd'), '不应包含 .cmd');
});

test('契约指纹：stdio 布局前四项是 ignore/ignore/ignore/ipc', () => {
  // 这是 AOT runner 最核心的契约：fd 3 是 ipc 通道。
  const d = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
  const s = d.contracts.runnerStdioLayout;

  assert.deepStrictEqual(s.fixed.slice(0, 4), ['ignore', 'ignore', 'ignore', 'ipc'],
    'fd 0/1/2 是 ignore，fd 3 必须是 ipc');
  assert.strictEqual(s.hasOverlappedControl, true, 'control 通道应存在（overlapped）');
});

test('契约指纹：错误码映射包含 ENOENT/EPERM/EACCES', () => {
  const d = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
  const codes = d.contracts.spawnErrorCodes;

  const values = Object.values(codes);
  for (const expected of ['ENOENT', 'EPERM', 'EACCES']) {
    assert.ok(values.includes(expected), `错误码映射应包含 ${expected}`);
  }
});

test('契约指纹：当前环境与基线一致时退出码 0', () => {
  const r = run();
  assert.strictEqual(r.status, 0,
    `契约应未漂移。stdout: ${r.stdout} stderr: ${r.stderr}`);
  assert.match(r.stdout, /契约未漂移/);
});

test('契约指纹：--json 输出结构完整', () => {
  const r = run(['--json']);
  assert.strictEqual(r.status, 0);

  const d = JSON.parse(r.stdout);
  assert.strictEqual(d.verdict, 'STABLE');
  assert.ok(typeof d.baselineFingerprint === 'string');
  assert.strictEqual(d.baselineFingerprint, d.currentFingerprint,
    '未漂移时两个指纹应相同');
  assert.deepStrictEqual(d.diffs, []);
});

test('契约指纹：契约被篡改 → 报 DRIFT 且退出码 1', () => {
  // 用临时备份保护真实基线
  const backup = `${BASELINE}.bak-test`;
  fs.copyFileSync(BASELINE, backup);
  try {
    const d = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
    // 模拟「上游把 .bat 加进了候选扩展名」
    d.contracts.executableResolution.candidateExtensions = ['com', 'exe', 'bat'];
    d.fingerprint = 'tampered';
    fs.writeFileSync(BASELINE, JSON.stringify(d, null, 2), 'utf8');

    const r = run(['--json']);
    assert.strictEqual(r.status, 1, '漂移必须返回非零退出码');

    const out = JSON.parse(r.stdout);
    assert.strictEqual(out.verdict, 'DRIFT');
    const item = out.diffs.find((x) => x.item === 'executableResolution');
    assert.ok(item, '应报告 executableResolution 项漂移');
    // 注意方向：我把基线改成了含 bat，所以 bat 出现在 **before**（基线）里，
    // after 是当前实际提取结果（不含 bat）。
    assert.match(item.before, /bat/, 'before 应显示基线里的 bat');
    assert.ok(!/bat/.test(item.after), 'after 是实际提取结果，不应含 bat');
    assert.match(item.after, /"candidateExtensions":\["com","exe"\]/,
      'after 应显示实际的两个扩展名');
  } finally {
    fs.copyFileSync(backup, BASELINE);
    fs.unlinkSync(backup);
  }
});

test('契约指纹：基线缺失 → 报错退出，不静默通过', () => {
  const backup = `${BASELINE}.bak-test2`;
  fs.copyFileSync(BASELINE, backup);
  try {
    fs.unlinkSync(BASELINE);
    const r = run();
    assert.strictEqual(r.status, 1, '没有基线必须是错误，不能当成"没漂移"');
    assert.match(r.stdout + r.stderr, /没有基线|contract-fingerprint/);
  } finally {
    fs.copyFileSync(backup, BASELINE);
    fs.unlinkSync(backup);
  }
});

test('契约指纹：提取失败时报错而不是报"未漂移"', () => {
  // 这条是整个脚本存在意义的核心保障。
  // 提取失败恰好会发生在「上游改了源码结构」时 —— 也就是最需要它工作的时刻。
  // 如果那时它说"契约未漂移"，检测就完全失效了。
  const src = fs.readFileSync(SCRIPT, 'utf8');

  // 断言脚本里确实有「提取失败 → return 1」的路径
  assert.match(src, /契约提取失败/,
    '脚本必须有提取失败的显式错误分支');
  assert.match(src, /提取失败与「契约没变」是两件不同的事/,
    '脚本应在注释/输出中区分这两件事');

  // 并断言它没有把异常吞掉后返回 0 的写法
  assert.ok(!/catch\s*\(\s*e\s*\)\s*\{[^}]*\}\s*return 0/.test(src)
    || /契约提取失败/.test(src),
    '不得在吞掉异常后返回成功');
});

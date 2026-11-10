/**
 * AOT 长期观测器 —— 单元测试
 *
 * 这个工具的作用是"判断优化值不值得继续投入"，所以它自己出错比测出错误数字更危险：
 * 一个把不可信轮次也算进去的聚合器，会给出一个漂亮但虚假的收益比例。
 * 因此这里重点测四件事：
 *   1. 解析不出 SUMMARY 时返回 null，而不是编一个 0
 *   2. 离散度超限/有失败/缺字段的轮次，一律判为不可信
 *   3. 全部轮次不可信时，聚合结果必须是"没结论"而不是"平均值"
 *   4. 中位数计算在偶数个样本下取中间两数的平均
 */
const { test } = require('node:test');
const assert = require('node:assert');

const {
  parseSummary,
  isTrustworthy,
  aggregate,
  median,
  DISPERSION_LIMIT,
} = require('../bench/aot-observe.js');

/** 造一条 d1-ab-bench.js 典型的 SUMMARY 行。 */
function summaryLine(obj) {
  return `some bench output\nmore lines\nSUMMARY ${JSON.stringify(obj)}`;
}

const GOOD = {
  n: 50, nodeP50: 234, aotP50: 108, floorP50: 32,
  gainPct: 62.6, dispNode: 5.2, dispAot: 6.1, nodeP99: 300, aotP99: 200,
  fails: 0, verdict: 'RELIABLE', cpu: 10, memGb: 11.7,
};

test('parseSummary 从末行 SUMMARY 提取对象', () => {
  const got = parseSummary(summaryLine(GOOD));
  assert.deepStrictEqual(got, GOOD);
});

test('parseSummary 拿不到 SUMMARY 时返回 null，不编造数字', () => {
  assert.strictEqual(parseSummary('no summary here\n'), null);
  assert.strictEqual(parseSummary('SUMMARY {broken json'), null);
  assert.strictEqual(parseSummary(''), null);
  assert.strictEqual(parseSummary(null), null);
});

test('isTrustworthy 只在离散度达标、无失败、字段齐全时为真', () => {
  assert.strictEqual(isTrustworthy(GOOD), true);

  // 离散度超限 —— 这正是 2026-11-03 三次实测的实际情况
  assert.strictEqual(
    isTrustworthy({ ...GOOD, dispAot: DISPERSION_LIMIT + 1 }),
    false,
  );
  // 有失败：runner 本身不稳定，数字再好看也不能用
  assert.strictEqual(isTrustworthy({ ...GOOD, fails: 1 }), false);
  // 缺离散度：无法判定，必须视为不可信，而不是默认通过
  assert.strictEqual(isTrustworthy({ ...GOOD, dispNode: undefined }), false);
  assert.strictEqual(isTrustworthy(null), false);
  assert.strictEqual(isTrustworthy(undefined), false);
});

test('median 在偶数样本下取中间两数的平均', () => {
  assert.strictEqual(median([3, 1, 2]), 2);
  assert.strictEqual(median([4, 1, 3, 2]), 2.5);
  assert.strictEqual(median([5]), 5);
  assert.strictEqual(median([]), null);
  assert.strictEqual(median(null), null);
});

test('aggregate 只统计可信轮次，并给出净收益中位数', () => {
  // 两轮可信、一轮被干扰（离散度 74.1%，正是实测到的那次）
  const noisy = { ...GOOD, nodeP50: 281, aotP50: 124, dispAot: 74.1, verdict: 'UNRELIABLE' };
  const good2 = { ...GOOD, nodeP50: 222, aotP50: 107, gainPct: 61.4 };
  const agg = aggregate([GOOD, noisy, good2]);

  assert.strictEqual(agg.verdict, 'MEASURED');
  assert.strictEqual(agg.rounds, 3);
  assert.strictEqual(agg.trustworthyRounds, 2, '不可信轮次不得计入');
  // 净收益 = nodeP50 - aotP50：Good(126) 与 good2(115) 的中位数 = 120.5 → 121
  assert.strictEqual(agg.netMs, 121);
  // gainPct 中位数 = (61.4 + 62.6)/2 = 62.0
  assert.strictEqual(agg.gainPct, 62);
});

test('aggregate 在全部轮次不可信时返回 UNRELIABLE 且不给数字', () => {
  const noisy1 = { ...GOOD, dispAot: 74.1 };
  const noisy2 = { ...GOOD, dispNode: 27.9 };
  const agg = aggregate([noisy1, noisy2]);

  assert.strictEqual(agg.verdict, 'UNRELIABLE');
  assert.strictEqual(agg.trustworthyRounds, 0);
  // 关键：不能把不可信的数字平均一下当结论
  assert.strictEqual(agg.gainPct, null);
  assert.strictEqual(agg.netMs, null);
  assert.match(agg.note, /离散度/);
});

test('aggregate 面对空输入不崩溃，也不假装测到了', () => {
  const agg = aggregate([]);
  assert.strictEqual(agg.verdict, 'UNRELIABLE');
  assert.strictEqual(agg.gainPct, null);

  const agg2 = aggregate([null, undefined]);
  assert.strictEqual(agg2.verdict, 'UNRELIABLE');
  assert.strictEqual(agg2.rounds, 0);
});

// ---------------------------------------------------------------------------
// pre-commit hook 的覆盖性
//
// 这个 hook 原先逐行列举要检查的 JS 文件，结果漏掉了 test/test-utils.js ——
// 漏检看不出来，所以必须由测试兜住，否则下次改动很容易退回手写清单。
//
// 2026-11-10 起口径收敛到 scripts/check-js-syntax.mjs（CI 与本机共用一份），
// 所以这里断言的对象从「hook 里有没有 find」变成「hook 有没有委托给那个脚本」，
// 再由下一条测试验证那个脚本自己扫得够全。这样改的理由：断言 "hook 里有 find"
// 是把实现细节写死，一旦实现搬到共享脚本里就会误报 —— 而真正要守的契约是
// 「有一个统一的地方在扫，且范围没有缩小」。
// ---------------------------------------------------------------------------

const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const HOOK = path.join(REPO, '.githooks', 'pre-commit');

test('pre-commit 用统一扫描脚本而非逐行列举检查 JS 语法', () => {
  const hook = fs.readFileSync(HOOK, 'utf8');
  // 逐行列举的痕迹：至少两行 `node --check <具体文件>`
  const listed = hook.match(/^\s*node --check\s+\S+\.js\s*$/gm) || [];
  assert.strictEqual(
    listed.length, 0,
    `hook 又退回了逐行列举（${listed.length} 行），新加文件会漏检`,
  );
  // 必须真的在扫描 —— 口径收敛到共享脚本，hook 只负责调用它
  assert.match(
    hook,
    /node\s+scripts\/check-js-syntax\.mjs/,
    'hook 应当委托给 scripts/check-js-syntax.mjs，而不是自带一份扫描实现',
  );
});

test('JS 语法扫描脚本的覆盖范围包含 test-utils.js 且不少于 10 个文件', () => {
  // 这里直接调用真实脚本的 --list 模式（若没有该模式则退化为读源码判断），
  // 断言的是「扫得够全」这个结果，而不是它的实现方式。
  const script = path.join(REPO, 'scripts', 'check-js-syntax.mjs');
  assert.ok(fs.existsSync(script), 'scripts/check-js-syntax.mjs 不存在');

  const { spawnSync } = require('node:child_process');
  const r = spawnSync(process.execPath, [script, '--list'], {
    cwd: REPO,
    encoding: 'utf8',
    timeout: 60000,
  });
  assert.strictEqual(r.status, 0, `--list 应当成功，实际 ${r.status}: ${r.stderr}`);
  const onDisk = String(r.stdout).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);

  // test-utils.js 正是历史上被漏掉的那个
  assert.ok(
    onDisk.some((f) => f.endsWith('test-utils.js')),
    '扫描范围应当包含 test/test-utils.js',
  );
  assert.ok(onDisk.length >= 10, `扫描范围过小（只找到 ${onDisk.length} 个）`);
});

// ───────────────────────────────────────────────────────────────────────────
// 跨轮收益一致性（GAIN_CONSISTENT）—— 2026-11-04 新增
//
// 背景：本机常态负载 50~75%，单轮离散度几乎压不到 10% 以下。
// 但「收益比例」对负载不敏感，多轮一致时仍可下结论。
//
// ⚠️ 这条路径最大的风险是「变得太宽松、什么都算可信」，
// 所以下面专门测它的边界：跨度超限必须拒绝、轮数不够必须拒绝、
// 且**绝不输出绝对值**。
// ───────────────────────────────────────────────────────────────────────────

const { crossRoundGain, GAIN_SPREAD_LIMIT } = require('../bench/aot-observe.js');

/** 造一轮只含收益比例的数据。 */
const mk = (gainPct, extra = {}) => ({ gainPct, fails: 0, ...extra });

test('跨轮收益：比例一致时给出比例，且不带绝对值', () => {
  const r = crossRoundGain([mk(60.7), mk(63.2), mk(62.9), mk(64.1), mk(61.7), mk(65.0)]);
  assert.ok(r, '跨度 4.3pp 应当通过');
  assert.ok(r.gainPct > 60 && r.gainPct < 65, `比例应在区间内，实际 ${r.gainPct}`);
  assert.equal(r.netMs, undefined, '不得输出 netMs');
  assert.equal(r.nodeP50, undefined, '不得输出 nodeP50');
});

test('跨轮收益：跨度超过阈值必须拒绝', () => {
  // 跨度 20pp，明显不一致 —— 这是噪声主导的信号
  const r = crossRoundGain([mk(40), mk(50), mk(60)]);
  assert.equal(r, null, `跨度 20pp > ${GAIN_SPREAD_LIMIT}pp 应被拒绝`);
});

test('跨轮收益：轮数不足 3 时拒绝', () => {
  assert.equal(crossRoundGain([mk(60), mk(61)]), null, '2 轮谈不上一致');
  assert.equal(crossRoundGain([mk(60)]), null, '1 轮谈不上一致');
});

test('跨轮收益：有失败轮次时不得采信（防止掩盖不稳定）', () => {
  const r = crossRoundGain([mk(60), mk(61), mk(62), { gainPct: 60, fails: 1 }]);
  // 有失败那轮被剔除后只剩 3 轮，跨度 2pp —— 仍可信，但必须确实剔除了它
  assert.ok(r, '剔除失败轮后仍足够');
  assert.equal(r.rounds, 3, '失败轮必须被剔除，不能计入轮数');
});

test('跨轮收益：全部轮次都有失败时拒绝', () => {
  const r = crossRoundGain([
    { gainPct: 60, fails: 1 },
    { gainPct: 61, fails: 1 },
    { gainPct: 62, fails: 1 },
  ]);
  assert.equal(r, null, '全失败不能因为比例接近就算可信');
});

test('聚合：单轮全不可信但跨轮一致时，verdict 为 GAIN_CONSISTENT 且 netMs 为 null', () => {
  // 模拟真实高负载场景：离散度全部超限，但收益比例稳定在 ~62%
  const rounds = [60.7, 63.2, 62.9, 64.1, 61.7, 65.0].map((g) => ({
    gainPct: g, fails: 0, dispNode: 30, dispAot: 40, nodeP50: 250, aotP50: 110, floorP50: 50,
  }));
  const agg = aggregate(rounds);
  assert.equal(agg.verdict, 'GAIN_CONSISTENT');
  assert.equal(agg.netMs, null, '绝对值不可信时必须为 null');
  assert.equal(agg.trustworthyRounds, 0, '单轮一个都不可信');
  assert.ok(agg.gainPct > 60 && agg.gainPct < 65);
  assert.equal(typeof agg.gainSpread, 'number');
});

test('聚合：跨轮也不一致时，verdict 必须是 UNRELIABLE', () => {
  const rounds = [40, 55, 70].map((g) => ({
    gainPct: g, fails: 0, dispNode: 30, dispAot: 40, nodeP50: 250, aotP50: 110, floorP50: 50,
  }));
  const agg = aggregate(rounds);
  assert.equal(agg.verdict, 'UNRELIABLE');
  assert.equal(agg.gainPct, null, '不可信时不得给出比例');
});

test('聚合：有可信轮次时仍优先第一层（给出绝对值）', () => {
  const rounds = [
    { gainPct: 62, fails: 0, dispNode: 5, dispAot: 5, nodeP50: 300, aotP50: 110, floorP50: 50 },
    { gainPct: 63, fails: 0, dispNode: 6, dispAot: 7, nodeP50: 305, aotP50: 112, floorP50: 52 },
  ];
  const agg = aggregate(rounds);
  assert.equal(agg.verdict, 'MEASURED', '有可信轮次时不该降级到跨轮路径');
  assert.equal(typeof agg.netMs, 'number', 'MEASURED 才给绝对值');
});

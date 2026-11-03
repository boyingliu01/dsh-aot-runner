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

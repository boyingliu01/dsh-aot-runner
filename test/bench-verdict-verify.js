#!/usr/bin/env node
/**
 * tests for lib/bench-verdict.mjs（issue #17 B 项）
 *
 * 这个库的职责不是「算得更准」，而是**在不可信时拒绝给结论**。
 * 所以测试重点全在边界与拒绝路径上，而不是「正常情况能算出数」：
 *
 *   - 离散度恰好 10% 算通过，10.01% 不算
 *   - 缺离散度一律不可信（不能把「没测到」当成「合格」）
 *   - 有失败的轮次不能用，哪怕数字很漂亮
 *   - GAIN_CONSISTENT 下**绝对不能**给出绝对值
 *
 * 最后一条是整个库存在的理由：绝对值和比例混着用，
 * 会得到一个"看起来很精确"的错误结论。
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

/** 造一轮"可信"的样本。 */
const goodRound = (over = {}) => ({
  gainPct: 60,
  dispNode: 5,
  dispAot: 5,
  nodeP50: 276,
  aotP50: 114,
  floorP50: 30,
  fails: 0,
  ...over,
});

/** 造一轮"离散度超限但比例可用"的样本。 */
const noisyRound = (over = {}) => ({
  gainPct: 62,
  dispNode: 16,
  dispAot: 28,
  nodeP50: 300,
  aotP50: 114,
  floorP50: 30,
  fails: 0,
  ...over,
});

async function load() {
  return import('../lib/bench-verdict.mjs');
}

test('bench-verdict：全部可信 → MEASURED，给绝对值', async () => {
  const { aggregate, VERDICT } = await load();
  const v = aggregate([goodRound(), goodRound({ gainPct: 64 })]);

  assert.strictEqual(v.verdict, VERDICT.MEASURED);
  assert.strictEqual(v.trustworthyRounds, 2);
  assert.ok(Number.isFinite(v.netMs), 'MEASURED 必须给出净省毫秒');
  assert.ok(Number.isFinite(v.gainPct), 'MEASURED 必须给出比例');
});

test('bench-verdict：离散度边界 —— 恰好 10 通过，10.01 不通过', async () => {
  const { isTrustworthy, DISPERSION_LIMIT } = await load();

  assert.strictEqual(DISPERSION_LIMIT, 10, '上限应是 10%，这是判据的一部分');
  assert.ok(isTrustworthy(goodRound({ dispNode: 10, dispAot: 10 })), '恰好 10 应当通过');
  assert.ok(!isTrustworthy(goodRound({ dispNode: 10.01, dispAot: 5 })), '10.01 不应通过');
});

test('bench-verdict：缺离散度一律不可信（不能把没测到当合格）', async () => {
  const { isTrustworthy } = await load();

  assert.ok(!isTrustworthy(goodRound({ dispNode: undefined })), 'undefined 不可信');
  assert.ok(!isTrustworthy(goodRound({ dispAot: null })), 'null 不可信');
  assert.ok(!isTrustworthy(goodRound({ dispNode: NaN })), 'NaN 不可信');
  assert.ok(!isTrustworthy(goodRound({ dispAot: '5' })), "字符串 '5' 不可信 —— 类型不对就是没测到");
});

test('bench-verdict：有失败的轮次不可信，哪怕数字很漂亮', async () => {
  const { isTrustworthy } = await load();

  assert.ok(!isTrustworthy(goodRound({ fails: 1 })), '有失败说明 runner 不稳');
  assert.ok(isTrustworthy(goodRound({ fails: 0 })), '0 次失败是正常的');
});

test('bench-verdict：单轮全不可信但比例一致 → GAIN_CONSISTENT', async () => {
  const { aggregate, VERDICT } = await load();
  const v = aggregate([noisyRound(), noisyRound({ gainPct: 64 }), noisyRound({ gainPct: 66 })]);

  assert.strictEqual(v.verdict, VERDICT.GAIN_CONSISTENT);
  assert.ok(Number.isFinite(v.gainPct), '比例可用');
});

test('bench-verdict：GAIN_CONSISTENT 下绝不给出绝对值', async () => {
  // 这是整个库存在的理由。绝对值和比例混用会得到"看起来很精确"的错误结论。
  const { aggregate, VERDICT } = await load();
  const v = aggregate([noisyRound(), noisyRound({ gainPct: 64 }), noisyRound({ gainPct: 65 })]);

  assert.strictEqual(v.verdict, VERDICT.GAIN_CONSISTENT);
  assert.strictEqual(v.netMs, null, '净省毫秒必须为 null');
  assert.strictEqual(v.nodeP50, null, 'nodeP50 必须为 null');
  assert.strictEqual(v.aotP50, null, 'aotP50 必须为 null');
  assert.strictEqual(v.floorP50, null, 'floorP50 必须为 null');
});

test('bench-verdict：轮数不足 3 时不给跨轮结论', async () => {
  const { aggregate, VERDICT, MIN_ROUNDS_FOR_SPREAD } = await load();

  assert.strictEqual(MIN_ROUNDS_FOR_SPREAD, 3);
  const v = aggregate([noisyRound(), noisyRound({ gainPct: 62 })]);
  assert.strictEqual(v.verdict, VERDICT.UNRELIABLE, '2 轮不足以谈"一致"');
});

test('bench-verdict：比例跨度超 5pp → UNRELIABLE', async () => {
  const { aggregate, VERDICT } = await load();
  // 60 / 70 / 80 跨度 20pp，远超 5pp 上限
  const v = aggregate([noisyRound({ gainPct: 60 }), noisyRound({ gainPct: 70 }), noisyRound({ gainPct: 80 })]);

  assert.strictEqual(v.verdict, VERDICT.UNRELIABLE);
  assert.strictEqual(v.gainPct, null, 'UNRELIABLE 什么都不给');
});

test('bench-verdict：空输入 → UNRELIABLE 而不是崩或给 0', async () => {
  const { aggregate, VERDICT } = await load();

  for (const input of [[], null, undefined, [null, undefined]]) {
    const v = aggregate(input);
    assert.strictEqual(v.verdict, VERDICT.UNRELIABLE, `输入 ${JSON.stringify(input)} 应是 UNRELIABLE`);
    assert.strictEqual(v.gainPct, null);
  }
});

test('bench-verdict：median 空数组返回 null 而不是 0', async () => {
  const { median } = await load();

  assert.strictEqual(median([]), null, '0 会被当成真实测量值，必须是 null');
  assert.strictEqual(median(null), null);
  assert.strictEqual(median([5]), 5);
  assert.strictEqual(median([1, 3]), 2, '偶数个取中间两个的平均');
  assert.strictEqual(median([3, 1, 2]), 2, '要先排序');
});

test('bench-verdict：只用可信轮次算中位数，不可信的不能混进去', async () => {
  const { aggregate } = await load();
  // 两轮可信（gainPct 60/60）+ 一轮离群但离散度超限（gainPct 5）
  const v = aggregate([
    goodRound({ gainPct: 60 }),
    goodRound({ gainPct: 60 }),
    noisyRound({ gainPct: 5 }),
  ]);

  assert.strictEqual(v.trustworthyRounds, 2);
  assert.strictEqual(v.gainPct, 60, '离群那轮不可信，不得污染中位数');
});

test('bench-verdict：判据阈值可覆盖，便于不同机器调整', async () => {
  const { aggregate, isTrustworthy, VERDICT } = await load();

  // 默认 10% 上限下不可信（dispNode=16, dispAot=28）
  assert.ok(!isTrustworthy(noisyRound(), 10));
  // 放宽到 20%：dispNode=16 过关但 dispAot=28 仍超限 —— 两项都要达标
  assert.ok(!isTrustworthy(noisyRound(), 20), '只放宽一项阈值不应整体放行');
  // 放宽到 30% 两项才都过
  assert.ok(isTrustworthy(noisyRound(), 30));

  const v = aggregate([noisyRound()], { dispersionLimit: 30 });
  assert.strictEqual(v.verdict, VERDICT.MEASURED, '放宽阈值后应走 MEASURED 路径');
});

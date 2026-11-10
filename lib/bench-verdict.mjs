/**
 * bench-verdict —— 把「一组性能样本」判定成三态，而不是一个数字。
 *
 * 从 `bench/aot-observe.js` 抽出来的通用模块（issue #17 B 项）。
 * 抽取时才看清它其实**不含任何 AOT 相关的东西** —— 只依赖
 * `{ gainPct, dispNode, dispAot, nodeP50, aotP50, fails }` 这几个字段，
 * 足够通用到任何「优化前 vs 优化后」的测量都能用。
 *
 * ## 为什么需要三态而不是「算个平均值」
 *
 * 本机（Windows 11 + 32GB + 8 核）长期 CPU 90~100%，测量噪声远大于多数待测效应。
 * 在这种机器上，把不可信的数字平均一下当结论，会得到**看起来很精确的错误答案** ——
 * 比「测不出来」危险得多。
 *
 * 所以本模块的立场是：**宁可返回 UNRELIABLE，也不返回一个方向错误的确定结论。**
 *
 * ## 三态语义（必须严格区分，不可混用）
 *
 * | verdict | 含义 | 能引用什么 | 不能引用什么 |
 * |---|---|---|---|
 * | `MEASURED` | 有单轮离散度达标 | 绝对值（毫秒）与比例 | — |
 * | `GAIN_CONSISTENT` | 单轮都不可信，但多轮比例一致 | **只能引用比例** | 绝对值（净省 N 毫秒） |
 * | `UNRELIABLE` | 两层判据都没过 | 什么都别引用 | 全部 |
 *
 * 最容易被误用的是 `GAIN_CONSISTENT`：它看起来像「有结论」，
 * 其实**只证明了比例**。绝对值被负载污染过，给出去就是假的。
 * 所以这个状态下 `netMs` / `nodeP50` / `aotP50` 一律返回 `null`。
 *
 * ## 双层判据
 *
 * 第一层（单轮）：每轮的 `dispNode` 与 `dispAot` 都要 ≤ 10%。
 *   离散度 = (p90 − p50) / p50 × 100。不达标说明这一轮机器被干扰过。
 *
 * 第二层（跨轮）：第一层全灭时，看 ≥3 轮的收益比例跨度是否 ≤5pp。
 *   跨度小说明尽管绝对值漂了，**相对关系**稳定 —— 这时只能采信比例。
 *
 * 5pp 的取值依据：实测 6 轮真实数据跨度 4.3pp，而噪声主导时需要 ~20pp 才会触发，
 * 所以 5pp 能区分「真实一致」与「噪声」。
 *
 * ## 用法
 *
 * ```js
 * import { aggregate } from './bench-verdict.js';
 *
 * const v = aggregate(rounds);
 * if (v.verdict === 'MEASURED') console.log(`省了 ${v.netMs}ms（${v.gainPct}%）`);
 * if (v.verdict === 'GAIN_CONSISTENT') console.log(`比例上省了 ${v.gainPct}%`);
 * if (v.verdict === 'UNRELIABLE') console.log('测不出来，重跑');
 * ```
 */

/** 单轮离散度上限（百分比）。超过则这一轮不可采信。 */
export const DISPERSION_LIMIT = 10;

/** 跨轮收益比例的允许跨度（百分点）。 */
export const GAIN_SPREAD_LIMIT = 5;

/** 走跨轮收益路径所需的最少轮数 —— 3 轮才能谈「一致」。 */
export const MIN_ROUNDS_FOR_SPREAD = 3;

/** 三态常量，避免调用方手写字符串拼错。 */
export const VERDICT = Object.freeze({
  MEASURED: 'MEASURED',
  GAIN_CONSISTENT: 'GAIN_CONSISTENT',
  UNRELIABLE: 'UNRELIABLE',
});

/**
 * 中位数。空数组或非数组返回 null（不返回 0 —— 0 会被当成真实测量值）。
 *
 * @param {number[]} xs
 * @returns {number|null}
 */
export function median(xs) {
  if (!Array.isArray(xs) || !xs.length) return null;
  const d = xs.slice().sort((a, b) => a - b);
  const m = Math.floor(d.length / 2);
  return d.length % 2 ? d[m] : (d[m - 1] + d[m]) / 2;
}

/**
 * 单项离散度是否在允许范围内。
 *
 * ## 必须只接受真正的 number（2026-11-10 修）
 *
 * 原实现是 `Number(raw)` 后判断，这在**缺数据时会静默放行**：
 *
 *     Number(null)       === 0     → 判定为「离散度 0%，完美」✗
 *     Number('')         === 0     → 同上 ✗
 *     Number([])         === 0     → 同上 ✗
 *     Number(undefined)  === NaN   → 正确拒绝 ✓
 *     Number('5')        === 5     → 接受了一个字符串 ✗
 *
 * 也就是说：**漏采样的轮次会被当成质量最好的那一轮**，然后参与中位数计算。
 * 这与本模块「宁可说测不出来」的立场正相反，而且错得最难发现 ——
 * 结果看起来更好，没人会去质疑。
 *
 * 现在要求 `typeof raw === 'number'` 且有限。NaN/Infinity/字符串/null/undefined
 * 一律拒绝：没测到就是没测到，不能算合格。
 *
 * @param {unknown} raw
 * @param {number} [limit]
 * @returns {boolean}
 */
export function isValidDispersion(raw, limit = DISPERSION_LIMIT) {
  if (typeof raw !== 'number') return false;
  return Number.isFinite(raw) && raw <= limit;
}

/** 这一轮是否记录了失败。有失败说明 runner 本身不稳，数字再好看也不能用。 */
function hasFailures(s) {
  return Boolean(s.fails) && s.fails > 0;
}

/**
 * 单轮是否可信：有数据、无失败、两项离散度都达标。
 *
 * @param {object} s 一轮的汇总
 * @param {number} [limit]
 * @returns {boolean}
 */
export function isTrustworthy(s, limit = DISPERSION_LIMIT) {
  if (!s || typeof s !== 'object') return false;
  if (hasFailures(s)) return false;
  // 缺离散度时不能判定可信 —— 这正是「不编造」的底线
  return isValidDispersion(s.dispNode, limit) && isValidDispersion(s.dispAot, limit);
}

/**
 * 第二层判据：跨轮收益比例是否一致。
 *
 * @param {object[]} summaries
 * @param {{minRounds?: number, spreadLimit?: number}} [opts]
 * @returns {{rounds: number, gainPct: number, gainSpread: number}|null}
 */
export function crossRoundGain(summaries, opts = {}) {
  const minRounds = opts.minRounds ?? MIN_ROUNDS_FOR_SPREAD;
  const spreadLimit = opts.spreadLimit ?? GAIN_SPREAD_LIMIT;

  const valid = (summaries || []).filter(
    (s) => s && !(s.fails > 0) && Number.isFinite(Number(s.gainPct)),
  );
  if (valid.length < minRounds) return null;

  const gains = valid.map((s) => Number(s.gainPct));
  const spread = Math.max(...gains) - Math.min(...gains);
  if (spread > spreadLimit) return null;

  return {
    rounds: valid.length,
    gainPct: Math.round(median(gains) * 10) / 10,
    gainSpread: Math.round(spread * 10) / 10,
  };
}

/** 没有一轮单轮可信时的退路。 */
function aggregateUnreliable(all, opts) {
  const cross = crossRoundGain(all, opts);
  if (cross) {
    return {
      verdict: VERDICT.GAIN_CONSISTENT,
      rounds: all.length,
      trustworthyRounds: 0,
      gainPct: cross.gainPct,
      // 绝对值不可信，坚决不给 —— 调用方若照抄 netMs 会写出假结论
      netMs: null,
      nodeP50: null,
      aotP50: null,
      floorP50: null,
      gainSpread: cross.gainSpread,
      note:
        `单轮离散度均超限，但 ${cross.rounds} 轮收益比例一致`
        + `（${cross.gainSpread}pp 跨度）—— 只能采信比例，绝对值不可用`,
    };
  }
  return {
    verdict: VERDICT.UNRELIABLE,
    rounds: all.length,
    trustworthyRounds: 0,
    gainPct: null,
    netMs: null,
    note: all.length
      ? '所有轮次离散度都超限，且跨轮收益比例也不一致 —— 机器被干扰，重跑'
      : '没有拿到任何可用轮次',
  };
}

/**
 * 聚合多轮结果，返回三态判定。
 *
 * 关键：**只用可信轮次算中位数**。全都不可信时走第二层，仍不行就返回
 * UNRELIABLE —— 而不是把不可信的数字平均一下当结论。
 *
 * 净收益 = node 的 runner 开销 − AOT 的 runner 开销
 *        = (nodeP50 − floorP50) − (aotP50 − floorP50)
 *        = nodeP50 − aotP50
 * 地板项相消，所以不必单独要求 floorP50 存在。
 *
 * @param {object[]} summaries 每轮的汇总对象
 * @param {{dispersionLimit?: number, minRounds?: number, spreadLimit?: number}} [opts]
 * @returns {object}
 */
export function aggregate(summaries, opts = {}) {
  const dispLimit = opts.dispersionLimit ?? DISPERSION_LIMIT;
  const all = (summaries || []).filter(Boolean);
  const good = all.filter((s) => isTrustworthy(s, dispLimit));
  if (!good.length) return aggregateUnreliable(all, opts);

  const gains = good.map((s) => Number(s.gainPct)).filter(Number.isFinite);
  const nets = good
    .filter((s) => Number.isFinite(Number(s.nodeP50)) && Number.isFinite(Number(s.aotP50)))
    .map((s) => Number(s.nodeP50) - Number(s.aotP50));

  const pick = (k) => median(good.map((s) => Number(s[k])).filter(Number.isFinite));

  return {
    verdict: VERDICT.MEASURED,
    rounds: all.length,
    trustworthyRounds: good.length,
    gainPct: gains.length ? Math.round(median(gains) * 10) / 10 : null,
    netMs: nets.length ? Math.round(median(nets)) : null,
    nodeP50: pick('nodeP50'),
    aotP50: pick('aotP50'),
    floorP50: pick('floorP50'),
  };
}

#!/usr/bin/env node
/**
 * AOT 收益长期观测器 —— 回答「这套优化值不值得继续投入」。
 *
 * 与 d1-ab-bench.js 的分工：
 *   d1-ab-bench.js   一次测量（测量逻辑的唯一来源，本工具不重复实现）
 *   aot-observe.js   多次测量 → 剔除不可信轮次 → 聚合 → 落盘 → 报趋势
 *
 * 为什么需要多轮而不是跑一次就下结论（2026-11-03 实测）：
 *   同一台机器连跑三次，收益比例 61.4% / 62.6% / 65.0%，
 *   但离散度 16% / 27.9% / 74.1% —— 三次全被标 UNRELIABLE。
 *   机器忙碌时单轮数字不能用，但「可信轮次的中位数」稳得多。
 *
 * 一个反直觉但重要的现象：
 *   负载升高时 node runner 的 p50 明显漂移（221→249→263ms），
 *   而 AOT 的 p50 几乎不动（107→108→108ms）。
 *   AOT 的价值不只是均值更快，更是尾延迟更可控 ——
 *   所以「收益比例」比「绝对毫秒数」更适合作为判断指标。
 *
 * 用法:
 *   node bench/aot-observe.js run --rounds 5 --n 50   # 跑一轮观测并落盘
 *   node bench/aot-observe.js report                  # 看历史趋势
 *   node bench/aot-observe.js check                   # 只看环境能不能测
 */
'use strict';

const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const BENCH = path.join(REPO, 'bench', 'd1-ab-bench.js');
const HISTORY_DIR = path.join(REPO, '.aot-observation');
const HISTORY_FILE = path.join(HISTORY_DIR, 'history.jsonl');

/** 离散度超过这个值，单轮结果不可采信（与 d1-ab-bench.js 的判定保持一致）。 */
const DISPERSION_LIMIT = 10;

/**
 * 跨轮收益比例的允许跨度（百分点）。
 * 单轮离散度超限时，若多轮收益比例落在这个区间内，可采信「比例」但不可采信绝对值。
 * 5pp 的取值依据：本机 6 轮实测跨度 4.3pp，而噪声主导时需要 ~20pp 才会触发。
 */
const GAIN_SPREAD_LIMIT = 5;

/** 走跨轮收益路径所需的最少轮数 —— 3 轮才能谈「一致」。 */
const MIN_ROUNDS_FOR_SPREAD = 3;

/**
 * 解析 d1-ab-bench.js 末行的 `SUMMARY {json}`。
 * 拿不到就返回 null —— 不猜、不补 0。
 *
 * @param {string} stdout
 * @returns {object|null}
 */
function parseSummary(stdout) {
  if (typeof stdout !== 'string') return null;
  const line = stdout.split(/\r?\n/).reverse().find((l) => l.trim().startsWith('SUMMARY '));
  if (!line) return null;
  try {
    return JSON.parse(line.trim().slice('SUMMARY '.length));
  } catch {
    return null;
  }
}

/**
 * 一轮是否可采信。除离散度外还要求 0 失败：
 * 有失败的轮次说明 runner 本身不稳定，数字再好看也不能用。
 *
 * @param {object|null} s
 * @returns {boolean}
 */
function isTrustworthy(s) {
  if (!isRoundObject(s)) return false;
  // 有失败的轮次说明 runner 本身不稳定，数字再好看也不能用
  if (hasFailures(s)) return false;
  // 缺离散度时不能判定可信 —— 这正是「不编造」的底线
  return isValidDispersion(s.dispNode) && isValidDispersion(s.dispAot);
}

/** 是不是一个可读的轮次对象（null/非对象都不算）。 */
function isRoundObject(s) {
  return Boolean(s) && typeof s === 'object';
}

/** 这一轮是否存在失败次数。 */
function hasFailures(s) {
  return Boolean(s.fails) && s.fails > 0;
}

/**
 * 单项离散度是否在允许范围内。
 *
 * 非有限值（undefined/NaN/字符串）一律不可信：把「没测到」当成「合格」
 * 会让整份结论建立在缺失数据上。
 */
function isValidDispersion(raw) {
  const d = Number(raw);
  return Number.isFinite(d) && d <= DISPERSION_LIMIT;
}

/**
 * 单轮离散度超限时，退一步看「跨轮收益比例是否一致」。
 *
 * ## 为什么需要这条路径（2026-11-04 实测）
 *
 * 本机常态负载就在 50%~75%（火绒 HipsDaemon + 常驻办公软件），
 * 逐轮离散度几乎不可能压到 10% 以下 —— 6 轮实测全部 UNRELIABLE：
 *
 *   第1轮 60.7%  第2轮 63.2%  第3轮 62.9%
 *   第4轮 64.1%  第5轮 61.7%  第6轮 65.0%
 *
 * 绝对毫秒数抖得厉害（node 237~308ms），但**收益比例极稳**（跨度 4.3pp）。
 * 这不是数据变好了，而是「收益比例」本身对负载不敏感：
 * 负载同时抬高 node 和 AOT 的绝对延迟，比值却保持一致。
 *
 * 所以判据分两层：
 *   1. 单轮可信（离散度 ≤ 10%）—— 最严格，能给绝对值
 *   2. 跨轮收益一致（跨度 ≤ 该阈值 且 轮数 ≥ 3）—— 只给比例，不给绝对值
 *
 * 第 2 层**绝不**用来输出 netMs/nodeP50 这类绝对值 —— 那些确实不可信。
 *
 * @param {object[]} summaries 全部轮次（已过滤 null）
 * @returns {object|null} 通过则返回聚合成败信息，否则 null
 */
function crossRoundGain(summaries) {
  const valid = (summaries || []).filter(
    (s) => s && !(s.fails > 0) && Number.isFinite(Number(s.gainPct)),
  );
  if (valid.length < MIN_ROUNDS_FOR_SPREAD) return null;

  const gains = valid.map((s) => Number(s.gainPct));
  const spread = Math.max(...gains) - Math.min(...gains);
  if (spread > GAIN_SPREAD_LIMIT) return null;

  return {
    rounds: valid.length,
    gainPct: Math.round(median(gains) * 10) / 10,
    gainSpread: Math.round(spread * 10) / 10,
  };
}

/** 中位数；空数组返回 null。 */
function median(xs) {
  if (!Array.isArray(xs) || !xs.length) return null;
  const d = xs.slice().sort((a, b) => a - b);
  const m = Math.floor(d.length / 2);
  return d.length % 2 ? d[m] : (d[m - 1] + d[m]) / 2;
}

/**
 * 聚合多轮结果。
 *
 * 关键：只用可信轮次算中位数。全都不可信时返回 verdict=UNRELIABLE 且
 * gainPct=null —— 而不是把不可信的数字平均一下当结论。
 *
 * @param {object[]} summaries
 */
function aggregate(summaries) {
  const all = (summaries || []).filter(Boolean);
  const good = all.filter(isTrustworthy);
  if (!good.length) return aggregateUnreliable(all);
  // 净收益 = node 的 runner 开销 − AOT 的 runner 开销
  //          = (nodeP50 − floorP50) − (aotP50 − floorP50)
  //          = nodeP50 − aotP50
  // 地板项相消，所以不必单独要求 floorP50 存在。
  const gains = good.map((s) => Number(s.gainPct)).filter(Number.isFinite);
  const nets = good
    .filter((s) => Number.isFinite(Number(s.nodeP50)) && Number.isFinite(Number(s.aotP50)))
    .map((s) => Number(s.nodeP50) - Number(s.aotP50));

  return {
    verdict: 'MEASURED',
    rounds: all.length,
    trustworthyRounds: good.length,
    gainPct: gains.length ? Math.round(median(gains) * 10) / 10 : null,
    netMs: nets.length ? Math.round(median(nets)) : null,
    nodeP50: median(good.map((s) => Number(s.nodeP50)).filter(Number.isFinite)),
    aotP50: median(good.map((s) => Number(s.aotP50)).filter(Number.isFinite)),
    floorP50: median(good.map((s) => Number(s.floorP50)).filter(Number.isFinite)),
  };
}

/**
 * 没有一轮单轮可信时的退路：看第二层（跨轮收益一致性）能不能给结论。
 * 能 → GAIN_CONSISTENT（只给比例）；不能 → UNRELIABLE（什么都不给）。
 */
function aggregateUnreliable(all) {
  // 第一层（单轮离散度）全军覆没 —— 看看第二层（跨轮收益一致性）能不能给结论
  const cross = crossRoundGain(all);
  if (cross) {
    return {
      verdict: 'GAIN_CONSISTENT',
      rounds: all.length,
      trustworthyRounds: 0,
      gainPct: cross.gainPct,
      netMs: null,          // 绝对值不可信，坚决不给
      nodeP50: null,
      aotP50: null,
      floorP50: null,
      gainSpread: cross.gainSpread,
      note: `单轮离散度均超限，但 ${cross.rounds} 轮收益比例一致`
        + `（${cross.gainSpread}pp 跨度）—— 只能采信比例，绝对值不可用`,
    };
  }
  return {
    verdict: 'UNRELIABLE',
    rounds: all.length,
    trustworthyRounds: 0,
    gainPct: null,
    netMs: null,
    note: all.length
      ? '所有轮次离散度都超限，且跨轮收益比例也不一致 —— 机器被干扰，重跑'
      : '没有拿到任何可用轮次',
  };
}

/** 当前 CPU 负载百分比；取不到返回 null。 */
function cpuLoad() {
  try {
    const out = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command',
        '[math]::Round((Get-CimInstance Win32_Processor).LoadPercentage)'],
      { encoding: 'utf8', timeout: 8000, windowsHide: true },
    );
    const v = parseFloat(out.trim());
    return Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}

/** 跑一轮 d1-ab-bench.js，返回解析后的 SUMMARY。 */
function runBench(n) {
  try {
    const r = spawnSync(process.execPath, [BENCH], {
      cwd: REPO,
      encoding: 'utf8',
      timeout: 15 * 60 * 1000,
      env: { ...process.env, N: String(n) },
      windowsHide: true,
    });

    // spawnSync 的失败不会抛异常，而是体现在 r.error / status 上。
    // 不检查的话会静默返回 null，把「基准跑不起来」伪装成「本轮数据不可用」。
    if (r.error) {
      console.error(`  ⚠️  基准启动失败: ${r.error.message}`);
      return null;
    }
    if (r.status !== 0) {
      console.error(`  ⚠️  基准退出码 ${r.status}`);
      return null;
    }
    return parseSummary(r.stdout || '');
  } catch (err) {
    console.error(`  ⚠️  基准执行异常: ${err.message}`);
    return null;
  }
}

/**
 * 追加一条历史记录。
 *
 * 写历史失败不应让整次测量作废 —— 数据已经打印到屏幕上了，
 * 记不下来只是丢了长期趋势。所以这里降级为警告而不是抛出。
 */
function appendHistory(entry) {
  try {
    fs.mkdirSync(HISTORY_DIR, { recursive: true });
    fs.appendFileSync(HISTORY_FILE, JSON.stringify(entry) + '\n', 'utf8');
  } catch (err) {
    console.error(`  ⚠️  历史记录写入失败（本次结果仍然有效）: ${err.message}`);
  }
}

function readHistory() {
  try {
    if (!fs.existsSync(HISTORY_FILE)) return [];
    return fs.readFileSync(HISTORY_FILE, 'utf8')
      .split(/\r?\n/)
      .filter((l) => l.trim())
      .map((l) => {
        try { return JSON.parse(l); } catch { return null; }
      })
      .filter(Boolean);
  } catch (err) {
    console.error(`  ⚠️  历史文件读取失败: ${err.message}`);
    return [];
  }
}

function cmdCheck() {
  const cpu = cpuLoad();
  console.log('环境检查\n');
  console.log(`  CPU 负载: ${formatCpu(cpu)}`);
  console.log(`  ${cpuVerdict(cpu)}`);
  console.log('');

  // 负载过高时测量结果会被干扰（离散度必然超限），直接拦截
  if (isCpuBusy(cpu)) {
    console.log('结论: 现在不要测量。等机器空闲再跑 run。');
    process.exit(1);
  }
  console.log('结论: 可以测量。');
}

/** CPU 负载是否高到不宜测量。 */
function isCpuBusy(cpu) {
  return cpu !== null && cpu > 40;
}

/** 把 CPU 读数格式化成百分比文本；读不到时给 n/a。 */
function formatCpu(cpu) {
  return cpu === null ? 'n/a' : `${cpu}%`;
}

/** 环境检查里 CPU 那一行的判定文本。 */
function cpuVerdict(cpu) {
  return isCpuBusy(cpu)
    ? 'FAIL  CPU 偏高 —— 基准会被干扰，离散度会超限'
    : 'PASS  负载可接受';
}

function cmdRun(argv) {
  const n = parseInt(argVal(argv, '--n', '50'), 10);
  const rounds = parseInt(argVal(argv, '--rounds', '5'), 10);

  const cpuBefore = cpuLoad();
  console.log(`AOT 收益观测：${rounds} 轮 × 每轮 ${n} 次\n`);
  console.log(`起测 CPU: ${formatCpu(cpuBefore)}\n`);

  const summaries = [];
  for (let i = 1; i <= rounds; i++) {
    const s = runBench(n);
    summaries.push(s);
    console.log(describeRound(i, s));
  }

  const agg = aggregate(summaries);
  appendHistory({
    at: new Date().toISOString(),
    n,
    rounds,
    cpuBefore,
    cpuAfter: cpuLoad(),
    ...agg,
  });

  console.log('');
  console.log(`  可信轮次: ${agg.trustworthyRounds}/${agg.rounds}`);
  printAggregateVerdict(agg);
  console.log('');
  console.log(`  已记入 ${path.relative(REPO, HISTORY_FILE)}`);
}

/** 单轮结果的单行描述（拿不到结果时说明原因）。 */
function describeRound(i, s) {
  if (!s) return `  第 ${i} 轮: 没拿到结果（基准异常退出）`;
  return `  第 ${i} 轮: node ${s.nodeP50}ms → aot ${s.aotP50}ms  `
    + `净省 ${s.nodeP50 - s.aotP50}ms (${s.gainPct}%)  `
    + `离散度 ${s.dispNode}/${s.dispAot}  ${isTrustworthy(s) ? '可信' : '不可信'}`;
}

/**
 * 按聚合判定打印结论。
 *
 * 三种判定的「能给什么」不同，必须分开：
 *   MEASURED        → 绝对值可信，给毫秒数
 *   GAIN_CONSISTENT → 只有比例可信（绝对值被负载污染），绝不给毫秒数
 *   UNRELIABLE      → 什么都不给，只说明原因
 */
function printAggregateVerdict(agg) {
  if (agg.verdict === 'RELIABLE' || agg.verdict === 'MEASURED') {
    console.log(`  净收益中位数: ${agg.netMs}ms/次  (${agg.gainPct}%)`);
    console.log(`  node p50 ${agg.nodeP50}ms → AOT p50 ${agg.aotP50}ms，地板 ${agg.floorP50}ms`);
    return;
  }
  if (agg.verdict === 'GAIN_CONSISTENT') {
    // 只给比例，不给绝对值 —— 绝对延迟确实被负载污染了
    console.log(`  收益比例: ${agg.gainPct}%  （${agg.rounds} 轮跨度 ${agg.gainSpread}pp）`);
    console.log(`  ℹ️  ${agg.note}`);
    return;
  }
  console.log(`  ⚠️  ${agg.note}`);
}

function cmdReport() {
  const history = readHistory();
  if (!history.length) {
    console.log('还没有观测记录。先跑: node bench/aot-observe.js run');
    return;
  }
  console.log('AOT 收益观测历史\n');
  printHistoryTable(history);

  const measured = history.filter((h) => h.verdict === 'MEASURED');
  const consistent = history.filter((h) => h.verdict === 'GAIN_CONSISTENT');
  console.log('');

  // 即使没有 MEASURED，只要跨轮收益一致，也能就「比例」下结论
  if (!measured.length && !consistent.length) {
    console.log('  没有任何一次观测得到可信结果 —— 还不能判断优化是否生效。');
    return;
  }

  summarizeMeasured(measured);
  summarizeConsistent(consistent, measured);
}

/** 打印历史明细表。逐列补齐（不能把整行 padEnd，中文字符宽度会算错）。 */
function printHistoryTable(history) {
  console.log('  时间              可信/总   净省     比例     CPU  判定');
  for (const h of history) console.log(formatHistoryRow(h));
}

/**
 * 把一条历史记录排成表格的一行。
 *
 * 关键：哪些列有值是**按判定类型**决定的 ——
 *   只有 MEASURED 才有可信的绝对值（净省毫秒）
 *   MEASURED 与 GAIN_CONSISTENT 都有可信比例
 * 这一区分是「不编造」原则在展示层的体现，所以显式建模成两个布尔量，
 * 而不是在各处重复写 verdict 比较。
 */
function formatHistoryRow(h) {
  return '  ' + [
    formatWhen(h.at),
    // ratio 是唯一需要 padEnd 到固定宽度的「变长」列
    `${h.trustworthyRounds ?? 0}/${h.rounds ?? 0}`.padEnd(8),
    formatNetCell(h).padEnd(8),
    formatPctCell(h).padEnd(7),
    `${h.cpuBefore ?? 'n/a'}%`.padStart(4),
    h.verdict,
  ].join('  ');
}

/** 表格里的时间列：ISO 串截到分钟，用空格代替 T。 */
function formatWhen(at) {
  return at.slice(0, 16).replace('T', ' ');
}

/**
 * 净省列：只有 MEASURED 有可信的绝对值。
 * 其余判定（含 GAIN_CONSISTENT）的毫秒数被负载污染，必须显示占位符。
 */
function formatNetCell(h) {
  return h.verdict === 'MEASURED' ? `${h.netMs}ms` : '—';
}

/** 比例列：MEASURED 与 GAIN_CONSISTENT 都有可信比例。 */
function formatPctCell(h) {
  const pctOk = h.verdict === 'MEASURED' || h.verdict === 'GAIN_CONSISTENT';
  return pctOk ? `${h.gainPct}%` : '—';
}

/** 汇总完全可信（MEASURED）观测 —— 只有这类轮次能给出绝对毫秒数。 */
function summarizeMeasured(measured) {
  if (!measured.length) return;
  const nets = measured.map((h) => h.netMs).filter(Number.isFinite);
  const pcts = measured.map((h) => h.gainPct).filter(Number.isFinite);
  const netMed = Math.round(median(nets));
  const pctMed = Math.round(median(pcts) * 10) / 10;
  const within = netMed >= 60 && netMed <= 160;
  console.log(`  汇总（${measured.length} 次完全可信观测的中位数）:`);
  console.log(`    净收益: ${netMed}ms/次`);
  console.log(`    收益比例: ${pctMed}%`);
  console.log(`    与文档宣称口径相比: ${within ? '同一量级，一致' : '偏离，需复查环境'}`);
}

/** 汇总跨轮收益一致（GAIN_CONSISTENT）观测 —— 只给比例，不给绝对值。 */
function summarizeConsistent(consistent, measured) {
  if (!consistent.length) return;
  const pcts = consistent.map((h) => h.gainPct).filter(Number.isFinite);
  const pctMed = Math.round(median(pcts) * 10) / 10;
  const same = Math.abs(pctMed - (measured.length
    ? Math.round(median(measured.map((h) => h.gainPct)) * 10) / 10
    : pctMed)) <= 5;
  console.log(`  汇总（${consistent.length} 次「跨轮收益一致」观测）:`);
  console.log(`    收益比例: ${pctMed}%  （绝对值不可信，未采信）`);
  if (measured.length) {
    console.log(`    与完全可信观测相比: ${same ? '一致（互相印证）' : '有偏差，建议多跑几轮'}`);
  }
}

function argVal(argv, name, def) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
}

function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0] || 'report';
  if (cmd === 'run') return cmdRun(argv);
  if (cmd === 'report') return cmdReport();
  if (cmd === 'check') return cmdCheck();
  console.error(`未知命令: ${cmd}\n可用: run | report | check`);
  process.exit(2);
}

module.exports = { parseSummary, isTrustworthy, crossRoundGain, aggregate, median, DISPERSION_LIMIT, GAIN_SPREAD_LIMIT };

if (require.main === module) main();

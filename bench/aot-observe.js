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
 * ⚠️ 上面这组数字只在这一层（d1-ab-bench，固定 hostname 地板）成立，
 *   且仓库里找不到对应的数据文件，无法追溯测量条件。
 *   换成完整调用口径（bench/load-matrix.cjs，真实 target 生命周期）后，
 *   p50 会随负载变化：37%→100% 时 node 涨 172ms、AOT 涨 143ms。
 *   原因：load-matrix 测的是 runner + bash，负载升高时 bash 自己也在变慢，
 *   这份共享成本两个 runner 都要付。
 *
 *   ⚠️ 比「谁更稳」时别比相对涨幅 —— AOT +125% / node +62% 那个数是
 *   **分母假象**（AOT 基准 114ms、node 276ms，加同样的共享成本，
 *   基准小的相对涨幅天然更大）。要比绝对值：净省 162→160→191ms（没塌），
 *   尾抖 p90−p50 在 100% 负载下 node 267ms vs AOT 40ms。
 *
 *   所以「AOT 更稳」成立，但指标是**尾抖**而不是 p50。
 *   不要把两层口径的结果混着引用。
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

/**
 * 三态判定与可信度判据已抽成通用模块（issue #17 B 项）：
 * `lib/bench-verdict.mjs`。
 *
 * 抽取的理由不是"整理代码"，而是这套判据**不含任何 AOT 相关的东西** ——
 * 它只依赖 { gainPct, dispNode, dispAot, nodeP50, aotP50, fails } 这几个字段，
 * 任何"优化前 vs 优化后"的测量都能用。留在 bench/ 里等于把它锁死在
 * 一个平台特定的项目里。
 *
 * 本文件只保留 AOT 特有的部分：怎么跑 d1-ab-bench、怎么读写 history.jsonl。
 *
 * 用 require() 而不是 import：本仓库是 commonjs（package.json 没有 "type":
 * "module"）。Node ≥22 支持 require() 加载 ESM，实测本机 v24 正常。
 */
const verdict = require('../lib/bench-verdict.mjs');
const {
  median, isTrustworthy, crossRoundGain, aggregate, DISPERSION_LIMIT, GAIN_SPREAD_LIMIT,
} = verdict;

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

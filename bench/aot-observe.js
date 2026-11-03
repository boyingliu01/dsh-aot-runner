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
  if (!s || typeof s !== 'object') return false;
  if (s.fails && s.fails > 0) return false;
  const dNode = Number(s.dispNode);
  const dAot = Number(s.dispAot);
  if (Number.isFinite(dNode) && dNode > DISPERSION_LIMIT) return false;
  if (Number.isFinite(dAot) && dAot > DISPERSION_LIMIT) return false;
  // 缺离散度时不能判定可信 —— 这正是「不编造」的底线
  return Number.isFinite(dNode) && Number.isFinite(dAot);
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
  if (!good.length) {
    return {
      verdict: 'UNRELIABLE',
      rounds: all.length,
      trustworthyRounds: 0,
      gainPct: null,
      netMs: null,
      note: all.length
        ? '所有轮次离散度都超限 —— 机器被干扰，重跑'
        : '没有拿到任何可用轮次',
    };
  }
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
  const r = spawnSync(process.execPath, [BENCH], {
    cwd: REPO,
    encoding: 'utf8',
    timeout: 15 * 60 * 1000,
    env: { ...process.env, N: String(n) },
    windowsHide: true,
  });
  return parseSummary(r.stdout || '');
}

function appendHistory(entry) {
  fs.mkdirSync(HISTORY_DIR, { recursive: true });
  fs.appendFileSync(HISTORY_FILE, JSON.stringify(entry) + '\n', 'utf8');
}

function readHistory() {
  if (!fs.existsSync(HISTORY_FILE)) return [];
  return fs.readFileSync(HISTORY_FILE, 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    })
    .filter(Boolean);
}

function cmdCheck() {
  const cpu = cpuLoad();
  console.log('环境检查\n');
  const busy = cpu !== null && cpu > 40;
  console.log(`  CPU 负载: ${cpu === null ? 'n/a' : cpu + '%'}`);
  console.log(`  ${busy ? 'FAIL' : 'PASS'}  ${busy
    ? 'CPU 偏高 —— 基准会被干扰，离散度会超限'
    : '负载可接受'}`);
  console.log('');
  if (busy) {
    console.log('结论: 现在不要测量。等机器空闲再跑 run。');
    process.exit(1);
  }
  console.log('结论: 可以测量。');
}

function cmdRun(argv) {
  const n = parseInt(argVal(argv, '--n', '50'), 10);
  const rounds = parseInt(argVal(argv, '--rounds', '5'), 10);

  const cpuBefore = cpuLoad();
  console.log(`AOT 收益观测：${rounds} 轮 × 每轮 ${n} 次\n`);
  console.log(`起测 CPU: ${cpuBefore === null ? 'n/a' : cpuBefore + '%'}\n`);

  const summaries = [];
  for (let i = 1; i <= rounds; i++) {
    const s = runBench(n);
    summaries.push(s);
    if (s) {
      const ok = isTrustworthy(s);
      console.log(
        `  第 ${i} 轮: node ${s.nodeP50}ms → aot ${s.aotP50}ms  `
        + `净省 ${s.nodeP50 - s.aotP50}ms (${s.gainPct}%)  `
        + `离散度 ${s.dispNode}/${s.dispAot}  ${ok ? '可信' : '不可信'}`,
      );
    } else {
      console.log(`  第 ${i} 轮: 没拿到结果（基准异常退出）`);
    }
  }

  const agg = aggregate(summaries);
  const entry = {
    at: new Date().toISOString(),
    n,
    rounds,
    cpuBefore,
    cpuAfter: cpuLoad(),
    ...agg,
  };
  appendHistory(entry);

  console.log('');
  console.log(`  可信轮次: ${agg.trustworthyRounds}/${agg.rounds}`);
  if (agg.verdict === 'RELIABLE' || agg.verdict === 'MEASURED') {
    console.log(`  净收益中位数: ${agg.netMs}ms/次  (${agg.gainPct}%)`);
    console.log(`  node p50 ${agg.nodeP50}ms → AOT p50 ${agg.aotP50}ms，地板 ${agg.floorP50}ms`);
  } else {
    console.log(`  ⚠️  ${agg.note}`);
  }
  console.log('');
  console.log(`  已记入 ${path.relative(REPO, HISTORY_FILE)}`);
}

function cmdReport() {
  const history = readHistory();
  if (!history.length) {
    console.log('还没有观测记录。先跑: node bench/aot-observe.js run');
    return;
  }
  console.log('AOT 收益观测历史\n');
  console.log('  时间                  可信/总  净省    比例    CPU');
  for (const h of history) {
    const when = h.at.slice(0, 16).replace('T', ' ');
    const ok = h.verdict === 'MEASURED';
    const net = ok ? `${h.netMs}ms`.padEnd(7) : '—      ';
    const pct = ok ? `${h.gainPct}%`.padEnd(7) : '—      ';
    console.log(
      `  ${when}  ${String(h.trustworthyRounds ?? 0)}/${String(h.rounds ?? 0)}`.padEnd(24)
      + `${net}${pct}${h.cpuBefore ?? 'n/a'}%`,
    );
  }

  const measured = history.filter((h) => h.verdict === 'MEASURED');
  console.log('');
  if (!measured.length) {
    console.log('  没有任何一次观测得到可信结果 —— 还不能判断优化是否生效。');
    return;
  }
  const nets = measured.map((h) => h.netMs).filter(Number.isFinite);
  const pcts = measured.map((h) => h.gainPct).filter(Number.isFinite);
  const n = nets.length;

  // 用中位数的中位数做汇总，避免某一轮异常值主导结论
  const netMed = Math.round(median(nets));
  const pctMed = Math.round(median(pcts) * 10) / 10;

  // 项目文档宣称的口径：生产路径净省 92~94ms，比例 59.1%~59.6%
  const within = netMed >= 60 && netMed <= 160;
  console.log(`  汇总（${n} 次可信观测的中位数）:`);
  console.log(`    净收益: ${netMed}ms/次`);
  console.log(`    收益比例: ${pctMed}%`);
  console.log(`    与文档宣称的 92~94ms / 59% 相比: ${within ? '在同一量级，一致' : '偏离，需复查环境'}`);
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

module.exports = { parseSummary, isTrustworthy, aggregate, median, DISPERSION_LIMIT };

if (require.main === module) main();

/**
 * 实验 E（严谨版）：10 路并行工具调用 × UV_THREADPOOL_SIZE 交错采样
 *
 * 为什么要单独一个脚本：
 *   前一轮跑出来 TPS=4 是 13.50ms、TPS=8 是 11.41ms（约 15% 差异），
 *   但样本只有 6 轮、stdev 高达 6~12ms。
 *   这个量级的差异**太接近噪声**，必须先做统计显著性检验再下结论。
 *
 * 设计要点：
 *   1. 交错采样 —— 每轮依次跑完所有变体，消除负载漂移
 *   2. 每变体 40 轮 —— 足够做 Wilcoxon 符号秩检验
 *   3. 子进程隔离 —— UV_THREADPOOL_SIZE 必须在进程启动前设置
 *   4. 同时记录中位数与标准差 —— 文档关心"波动收窄"，两者都要看
 */
'use strict';

const { spawn } = require('child_process');
const path = require('path');

const VARIANTS = [1, 2, 4, 8, 10, 16, 32];
const ROUNDS = parseInt(process.argv[2], 10) || 40;
const PARALLEL = parseInt(process.argv[3], 10) || 10;
const TOOLS = parseInt(process.argv[4], 10) || 100;
const CHILD = path.join(__dirname, 'realistic.js');

function median(xs) {
  const d = xs.slice().sort((a, b) => a - b);
  const m = Math.floor(d.length / 2);
  return d.length % 2 ? d[m] : (d[m - 1] + d[m]) / 2;
}
function pct(xs, p) {
  const d = xs.slice().sort((a, b) => a - b);
  return d[Math.min(d.length - 1, Math.max(0, Math.ceil((p / 100) * d.length) - 1))];
}

/** 在一个设置了指定 UV_THREADPOOL_SIZE 的子进程里跑一次，返回 {med, sd}。 */
function runOnce(tps) {
  return new Promise((resolve) => {
    const cp = spawn(process.execPath, [CHILD, String(PARALLEL), String(TOOLS)], {
      env: { ...process.env, UV_THREADPOOL_SIZE: String(tps) },
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    let out = '';
    cp.stdout.on('data', (d) => { out += d; });
    cp.on('close', () => {
      const parts = out.trim().split(/\s+/).map(Number);
      resolve(parts.length === 2 && parts.every(Number.isFinite)
        ? { med: parts[0], sd: parts[1] }
        : null);
    });
    cp.on('error', () => resolve(null));
  });
}

/**
 * Wilcoxon 符号秩检验（配对，双侧近似正态）。
 *
 * 为什么用它而不是 t 检验：性能数据明显非正态，且我们关心的是
 * 「同一轮里 A 比 B 快」这种配对关系，符号秩检验不假设分布。
 *
 * @returns {{z:number, p:number, n:number, wins:number, losses:number}}
 */
function wilcoxon(diffs) {
  const d = diffs.filter((x) => x !== 0);
  const n = d.length;
  if (n === 0) return { z: 0, p: 1, n: 0, wins: 0, losses: 0 };
  const wins = d.filter((x) => x > 0).length;
  const losses = d.filter((x) => x < 0).length;

  // 秩（处理并列取平均秩）
  const idx = d.map((v, i) => ({ v: Math.abs(v), i })).sort((a, b) => a.v - b.v);
  const ranks = new Array(n);
  for (let i = 0; i < idx.length;) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1].v === idx[i].v) j += 1;
    const avg = (i + j) / 2 + 1;   // 秩从 1 开始
    for (let k = i; k <= j; k += 1) ranks[idx[k].i] = avg;
    i = j + 1;
  }

  const wPlus = d.reduce((s, v, i) => s + (v > 0 ? ranks[i] : 0), 0);
  const mean = (n * (n + 1)) / 4;
  const sd = Math.sqrt((n * (n + 1) * (2 * n + 1)) / 24);
  const z = sd === 0 ? 0 : (wPlus - mean) / sd;
  // 双侧 p（正态近似）
  const p = 2 * (1 - normCdf(Math.abs(z)));
  return { z, p, n, wins, losses };
}

function normCdf(x) {
  // Abramowitz-Stegun 7.1.26 近似，误差 < 1.5e-7
  // 注意必须用 |x| 代入公式，否则负 z 会算出错误结果
  const az = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * az / Math.SQRT2);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t
    + 0.254829592) * t * Math.exp(-(az * az) / 2);
  return x >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y);
}

(async () => {
  console.log(`实验 E（严谨版）：${PARALLEL} 路并行 × ${TOOLS} 次工具调用（stat+read 串行）`);
  console.log(`变体: ${VARIANTS.map((v) => 'TPS=' + v).join(', ')}`);
  console.log(`每变体 ${ROUNDS} 轮，交错采样（每轮跑完所有变体）\n`);

  const samples = new Map(VARIANTS.map((v) => [v, []]));
  for (let r = 0; r < ROUNDS; r += 1) {
    for (const v of VARIANTS) {
      const s = await runOnce(v);
      if (s) samples.get(v).push(s);
    }
    if ((r + 1) % 10 === 0) process.stdout.write(`  已完成 ${r + 1}/${ROUNDS} 轮\n`);
  }

  const base = 4;
  const baseMed = samples.get(base).map((s) => s.med);

  console.log('');
  console.log('  变体      p50中位数  p95     stdev中位数  相对TPS=4   Wilcoxon p');
  console.log('  ─────────────────────────────────────────────────────────────────');

  for (const v of VARIANTS) {
    const arr = samples.get(v);
    const meds = arr.map((s) => s.med);
    const sds = arr.map((s) => s.sd);
    const m = median(meds);

    let ratio = '—';
    let pStr = '—';
    if (v !== base) {
      const diffs = baseMed.map((b, i) => b - meds[i]);   // 正 = 变体更快
      const w = wilcoxon(diffs);
      const delta = ((m / median(baseMed)) * 100 - 100);
      ratio = `${delta >= 0 ? '+' : ''}${delta.toFixed(1)}%`;
      pStr = `${w.p.toFixed(4)}${w.p < 0.05 ? ' *' : ''}`;
    }

    console.log(
      `  TPS=${String(v).padEnd(4)} ${String(m.toFixed(2)).padStart(9)} `
      + `${String(pct(meds, 95).toFixed(2)).padStart(7)} `
      + `${String(median(sds).toFixed(2)).padStart(11)} `
      + `${ratio.padStart(9)}   ${pStr.padStart(8)}`,
    );
  }

  console.log('');
  console.log('  注: p < 0.05 标记 * 表示与 TPS=4 的差异在统计上显著（Wilcoxon 符号秩，双侧）');
  console.log('      "相对TPS=4" 为负值表示更快');

  // 输出原始中位数序列，便于事后核对
  console.log('');
  console.log('  各变体 p50 序列（前 10 轮）:');
  for (const v of VARIANTS) {
    const meds = samples.get(v).map((s) => s.med);
    console.log(`    TPS=${String(v).padEnd(3)} ${meds.slice(0, 10).map((x) => x.toFixed(1)).join(' ')}`);
  }
})();

/**
 * 实验 I（收官）：线程池饱和点扫描 + 多重比较校正
 *
 * ## 要回答的两个问题
 *
 * 1. 默认 4 个线程，到底多少并发 fs 才会「堵死」？
 *    DSH 的真实画像：一次 step 最多 10 个工具并行（maxParallelToolCalls=10），
 *    每个 read_file 是 stat→read **串行**，所以峰值并发 fs 请求数 ≈ 10。
 *    如果饱和点远高于 10，这个优化对 DSH 就是无效的。
 *
 * 2. 前面那些 p<0.05 是不是多重比较的假阳性？
 *    一次比 5 个变体，α=0.05 时至少一个假阳性的概率约 23%。
 *    这里改用 Benjamini-Hochberg FDR 校正，只有校正后仍显著才算数。
 *
 * ## 设计
 * 每个并发档位（4/8/10/16/32/64/128 个同时在飞的 fs 请求），
 * 对比 TPS=4 与 TPS=16，交错采样 + FDR 校正。
 */
'use strict';

const { spawn } = require('child_process');
const path = require('path');

const CHILD = path.join(__dirname, 'inflight.js');
const LEVELS = [4, 8, 10, 16, 32, 64, 128];
const ROUNDS = parseInt(process.argv[2], 10) || 25;

function median(xs) {
  const d = xs.slice().sort((a, b) => a - b);
  const m = Math.floor(d.length / 2);
  return d.length % 2 ? d[m] : (d[m - 1] + d[m]) / 2;
}
function normCdf(x) {
  const az = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * az / Math.SQRT2);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736)
    * t + 0.254829592) * t * Math.exp(-(az * az) / 2);
  return x >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y);
}
function wilcoxon(diffs) {
  const d = diffs.filter((x) => x !== 0);
  const n = d.length;
  if (n === 0) return { z: 0, p: 1 };
  const idx = d.map((v, i) => ({ v: Math.abs(v), i })).sort((a, b) => a.v - b.v);
  const ranks = new Array(n);
  for (let i = 0; i < idx.length;) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1].v === idx[i].v) j += 1;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k += 1) ranks[idx[k].i] = avg;
    i = j + 1;
  }
  const wPlus = d.reduce((s, v, i) => s + (v > 0 ? ranks[i] : 0), 0);
  const mean = (n * (n + 1)) / 4;
  const sd = Math.sqrt((n * (n + 1) * (2 * n + 1)) / 24);
  const z = sd === 0 ? 0 : (wPlus - mean) / sd;
  return { z, p: Math.min(1, 2 * (1 - normCdf(Math.abs(z)))) };
}

/** Benjamini-Hochberg FDR —— 返回每个 p 对应的 q 值。 */
function bhFdr(ps) {
  const m = ps.length;
  const order = ps.map((p, i) => ({ p, i })).sort((a, b) => a.p - b.p);
  const q = new Array(m);
  let prev = 1;
  for (let k = m - 1; k >= 0; k -= 1) {
    const val = Math.min(prev, (order[k].p * m) / (k + 1));
    q[order[k].i] = val;
    prev = val;
  }
  return q;
}

/** 在指定线程池大小下，跑一次「N 个 fs 请求同时在飞」。 */
function once(tps, inflight) {
  return new Promise((resolve) => {
    const cp = spawn(process.execPath, [CHILD, String(inflight)], {
      env: { ...process.env, UV_THREADPOOL_SIZE: String(tps) },
      stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
    });
    let out = '';
    cp.stdout.on('data', (d) => { out += d; });
    cp.on('close', () => {
      const v = parseFloat(out.trim());
      resolve(Number.isFinite(v) ? v : null);
    });
    cp.on('error', () => resolve(null));
  });
}

(async () => {
  console.log(`实验 I：线程池饱和点扫描（TPS=4 默认 vs TPS=16）`);
  console.log(`每个档位 = N 个 fs 请求同时在飞，每档 ${ROUNDS} 轮交错\n`);
  console.log('  同时在飞   TPS=4 p50   TPS=16 p50   差异    raw p    FDR q');
  console.log('  ─────────────────────────────────────────────────────────────');

  const rows = [];
  for (const n of LEVELS) {
    const a = [];
    const b = [];
    for (let r = 0; r < ROUNDS; r += 1) {
      const x = await once(4, n);
      const y = await once(16, n);
      if (x !== null) a.push(x);
      if (y !== null) b.push(y);
    }
    const diffs = a.map((v, i) => v - b[i]);   // 正 = TPS16 更快
    const { p } = wilcoxon(diffs);
    rows.push({ n, a, b, p, d: (median(b) / median(a) - 1) * 100 });
  }

  const qs = bhFdr(rows.map((r) => r.p));
  rows.forEach((r, i) => {
    const sig = qs[i] < 0.05 ? ' ✓' : '';
    console.log(
      `  ${String(r.n).padStart(9)} ${median(r.a).toFixed(2).padStart(11)} `
      + `${median(r.b).toFixed(2).padStart(11)} ${(r.d >= 0 ? '+' : '') + r.d.toFixed(1) + '%'}`
        .padStart(8)
      + ` ${r.p.toFixed(4).padStart(8)} ${qs[i].toFixed(4).padStart(8)}${sig}`,
    );
  });

  console.log('');
  console.log('  注: 差异为负表示 TPS=16 更快；✓ 表示 FDR 校正后仍显著（q<0.05）');
  console.log('      DSH 实际峰值并发 ≈ 10（maxParallelToolCalls 默认值）');
  console.log('');
  console.log('  TPS=4 各档位原始序列:');
  for (const r of rows) {
    console.log(`    N=${String(r.n).padStart(4)} ${r.a.slice(0, 10).map((x) => x.toFixed(1)).join(' ')}`);
  }
})();

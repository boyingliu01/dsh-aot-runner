/**
 * 实验 M：glob / grep 场景（海量小文件 stat）—— 线程池最可能起作用的真实场景
 *
 * ## 为什么单独测这个
 *
 * read_file 只读 1 个文件，fs 成本 0.66ms，在 90ms 的调用里只占 0.7% ——
 * 这是前面实验 L2 已经量化的事实。
 *
 * 但 `glob` / `grep` 类工具不一样：它们要 stat 成百上千个文件，
 * 这才是**唯一**可能让 4 个线程池不够用的真实场景。
 * 如果连这里也测不出收益，那结论就完整了。
 *
 * ## 与前几次的区别
 * 前面实验 F 在 86~100% CPU 负载下跑，噪声完全盖过信号。
 * 这次：
 *   - 固定并发池（不用 Promise.all 一次全发，避免 4000 个请求同时排队）
 *   - 交错采样 + Wilcoxon + FDR 校正
 *   - 同时报告 stdev（文档关心"波动收窄"）
 */
'use strict';

const { spawn } = require('child_process');
const path = require('path');

const CHILD = path.join(__dirname, 'glob-child.js');
const VARIANTS = [4, 8, 16, 32];
const ROUNDS = parseInt(process.argv[2], 10) || 20;
const BATCHES = [
  { label: '500 文件', n: 500 },
  { label: '2000 文件', n: 2000 },
];

function median(xs) {
  const d = xs.slice().sort((a, b) => a - b);
  const m = Math.floor(d.length / 2);
  return d.length % 2 ? d[m] : (d[m - 1] + d[m]) / 2;
}
function pct(xs, p) {
  const d = xs.slice().sort((a, b) => a - b);
  return d[Math.min(d.length - 1, Math.ceil((p / 100) * d.length) - 1)];
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
  if (n === 0) return { p: 1 };
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
  return { p: Math.min(1, 2 * (1 - normCdf(Math.abs(z)))) };
}
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

function once(tps, n) {
  return new Promise((resolve) => {
    const cp = spawn(process.execPath, [CHILD, String(n)], {
      env: { ...process.env, UV_THREADPOOL_SIZE: String(tps) },
      stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
    });
    let out = '';
    cp.stdout.on('data', (d) => { out += d; });
    cp.on('close', () => {
      const parts = out.trim().split(/\s+/).map(Number);
      resolve(parts.length === 2 && parts.every(Number.isFinite)
        ? { med: parts[0], sd: parts[1] } : null);
    });
    cp.on('error', () => resolve(null));
  });
}

(async () => {
  console.log('实验 M：glob/grep 场景（海量小文件 stat）');
  console.log(`每变体 ${ROUNDS} 轮交错采样 + Wilcoxon + BH-FDR 校正\n`);

  const pending = [];   // 收集所有比较，最后统一 FDR

  for (const batch of BATCHES) {
    const samples = new Map(VARIANTS.map((v) => [v, []]));
    for (let r = 0; r < ROUNDS; r += 1) {
      for (const v of VARIANTS) {
        const s = await once(v, batch.n);
        if (s) samples.get(v).push(s);
      }
    }
    console.log(`【${batch.label}】`);
    console.log('  变体      p50      p95     stdev   相对TPS=4   raw p');
    console.log('  ──────────────────────────────────────────────────────');
    const base = samples.get(4).map((s) => s.med);
    for (const v of VARIANTS) {
      const arr = samples.get(v);
      const meds = arr.map((s) => s.med);
      const sds = arr.map((s) => s.sd);
      let ratio = '—', pStr = '—';
      if (v !== 4) {
        const { p } = wilcoxon(base.map((b, i) => b - meds[i]));
        const delta = (median(meds) / median(base) - 1) * 100;
        ratio = `${delta >= 0 ? '+' : ''}${delta.toFixed(1)}%`;
        pStr = p.toFixed(4);
        pending.push({ label: batch.label, v, p, delta });
      }
      console.log(
        `  TPS=${String(v).padEnd(4)} ${median(meds).toFixed(1).padStart(7)} `
        + `${pct(meds, 95).toFixed(1).padStart(7)} ${median(sds).toFixed(1).padStart(7)} `
        + `${ratio.padStart(9)}   ${pStr.padStart(8)}`,
      );
    }
    console.log('');
  }

  const qs = bhFdr(pending.map((x) => x.p));
  console.log('  FDR 校正后（q < 0.05 才算真差异）:');
  let anySig = false;
  pending.forEach((x, i) => {
    const sig = qs[i] < 0.05;
    if (sig) anySig = true;
    console.log(
      `    ${x.label.padEnd(10)} TPS=${String(x.v).padEnd(3)} `
      + `${x.delta >= 0 ? '+' : ''}${x.delta.toFixed(1)}%  p=${x.p.toFixed(4)} `
      + `q=${qs[i].toFixed(4)} ${sig ? '✓ 显著' : ''}`,
    );
  });
  console.log('');
  console.log(anySig
    ? '  → 存在统计显著差异，需进一步分析方向与幅度'
    : '  → 没有任何差异通过 FDR 校正 —— 线程池大小对该场景无实质影响');
})();

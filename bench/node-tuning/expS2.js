/**
 * 实验 S2（最终定论）：真实项目文件 + 10 路并发 + 完整 stat→read 序列
 *
 * dsh-fs-local 内部就是从 node:fs/promises 导入的（chmod,link,lstat,mkdir,
 * open,readFile,readdir,rename,rm,stat），所以直接用同一模块等价。
 * dsh-tool-fs 的 read_file 序列是 stat → read，这里完整复现。
 */
'use strict';

const { spawn } = require('child_process');
const path = require('path');

const CHILD = path.join(__dirname, 'hostchild.js');
const VARIANTS = [4, 8, 16, 32];
const ROUNDS = parseInt(process.argv[2], 10) || 40;

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
  const m = (n * (n + 1)) / 4;
  const sd = Math.sqrt((n * (n + 1) * (2 * n + 1)) / 24);
  const z = sd === 0 ? 0 : (wPlus - m) / sd;
  return { p: Math.min(1, 2 * (1 - normCdf(Math.abs(z)))) };
}

function once(tps) {
  return new Promise((resolve) => {
    const cp = spawn(process.execPath, [CHILD], {
      env: { ...process.env, UV_THREADPOOL_SIZE: String(tps) },
      stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
    });
    let out = '';
    cp.stdout.on('data', (d) => { out += d; });
    cp.on('close', () => {
      const p = out.trim().split(/\s+/).map(Number);
      resolve(p.length === 2 && p.every(Number.isFinite) ? { med: p[0], sd: p[1] } : null);
    });
    cp.on('error', () => resolve(null));
  });
}

(async () => {
  console.log('实验 S2：真实项目文件（stat→read 完整序列）× 10 路并发');
  console.log(`${ROUNDS} 轮交错采样\n`);
  console.log('  变体       p50       stdev    相对TPS=4    Wilcoxon p');
  console.log('  ──────────────────────────────────────────────────────');

  const s = new Map(VARIANTS.map((v) => [v, []]));
  for (let r = 0; r < ROUNDS; r += 1) {
    for (const v of VARIANTS) {
      const x = await once(v);
      if (x) s.get(v).push(x);
    }
    if ((r + 1) % 10 === 0) process.stdout.write(`  ${r + 1}/${ROUNDS}\n`);
  }

  const base = s.get(4).map((x) => x.med);
  for (const v of VARIANTS) {
    const arr = s.get(v);
    const meds = arr.map((x) => x.med);
    const sds = arr.map((x) => x.sd);
    let ratio = '—', ps = '—';
    if (v !== 4) {
      const { p } = wilcoxon(base.map((b, i) => b - meds[i]));
      const d = (median(meds) / median(base) - 1) * 100;
      ratio = `${d >= 0 ? '+' : ''}${d.toFixed(1)}%`;
      ps = `${p.toFixed(4)}${p < 0.05 ? ' *' : ''}`;
    }
    console.log(
      `  TPS=${String(v).padEnd(4)} ${median(meds).toFixed(3).padStart(8)}ms `
      + `${median(sds).toFixed(3).padStart(8)}ms ${ratio.padStart(10)} ${ps.padStart(11)}`,
    );
  }
})();

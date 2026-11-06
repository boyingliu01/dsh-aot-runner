/**
 * 实验 Q：用大文件证实 fs 确实走 libuv 线程池（修正机理判断）
 *
 * 之前我用 43KB 小文件测出"TPS 无影响"，错误地归因为
 * "Windows 文件 IO 走 IOCP 不走线程池"。大文件测试推翻了这一点。
 *
 * 真相：libuv 在 Windows 上 uv_fs_read 就是提交到线程池的。
 * 小文件测不出差异，是因为单次 fs 只有 0.1ms —— 线程池根本来不及排队，
 * 且 OS 页缓存让读取变成纯内存拷贝。
 *
 * 本实验用交错采样严格确认这个修正。
 */
'use strict';

const { spawn } = require('child_process');
const path = require('path');

const CHILD = path.join(__dirname, 'bigread.js');
const VARIANTS = [4, 8, 16, 32];
const LEVELS = [8, 16, 32];
const ROUNDS = parseInt(process.argv[2], 10) || 15;

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

function once(tps, n) {
  return new Promise((resolve) => {
    const cp = spawn(process.execPath, [CHILD, String(n)], {
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
  console.log(`实验 Q：64MB 大文件并发读 —— 证实 fs 走线程池（${ROUNDS} 轮交错）\n`);

  for (const n of LEVELS) {
    const s = new Map(VARIANTS.map((v) => [v, []]));
    for (let r = 0; r < ROUNDS; r += 1) {
      for (const v of VARIANTS) {
        const x = await once(v, n);
        if (x !== null) s.get(v).push(x);
      }
    }
    const base = s.get(4);
    console.log(`【${n} 个 64MB 文件同时读 = ${n * 64}MB】`);
    console.log('  TPS       p50       相对TPS=4    p');
    for (const v of VARIANTS) {
      const xs = s.get(v);
      let ratio = '—', ps = '—';
      if (v !== 4) {
        const { p } = wilcoxon(base.map((b, i) => b - xs[i]));
        const d = (median(xs) / median(base) - 1) * 100;
        ratio = `${d >= 0 ? '+' : ''}${d.toFixed(1)}%`;
        ps = `${p.toFixed(4)}${p < 0.05 ? ' *' : ''}`;
      }
      console.log(`  TPS=${String(v).padEnd(3)} ${median(xs).toFixed(1).padStart(8)}ms ${ratio.padStart(11)}   ${ps}`);
    }
    console.log('');
  }
})();

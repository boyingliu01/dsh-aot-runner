/**
 * 实验 K：终极阳性对照 —— 用铁定走线程池的操作验证测量能力
 *
 * ## 为什么前面"测不出"值得怀疑
 *
 * 实验 J 人为加重了 fs 负载，结果 TPS=4 / 16 / 32 仍然没差别。
 * 这有两种解释：
 *   (a) Windows 上 fs 操作确实不吃 libuv 线程池（走 IOCP）
 *   (b) 我的测量方法有问题
 *
 * 必须用**确定的**线程池操作来区分这两种可能。
 *
 * `crypto.pbkdf2` 是教科书级的例子：
 *   - 纯 CPU 计算，明确由 libuv 线程池执行
 *   - 单次耗时可控（通过 iterations 调节）
 *   - 不受磁盘缓存、IOCP、杀软影响
 *
 * 如果 pbkdf2 在 TPS=4→16 下**也没有加速**，说明我的实验方法有缺陷，
 * 前面所有"无收益"的结论都要推翻重做。
 * 如果 pbkdf2 **明显加速**，那说明方法没问题，
 * fs 操作测不出差异是真实情况（Windows fs 不走线程池）。
 */
'use strict';

const { spawn } = require('child_process');
const path = require('path');

const CHILD = path.join(__dirname, 'pbkdf2-child.js');
const ROUNDS = parseInt(process.argv[2], 10) || 10;

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
  const mean = (n * (n + 1)) / 4;
  const sd = Math.sqrt((n * (n + 1) * (2 * n + 1)) / 24);
  const z = sd === 0 ? 0 : (wPlus - mean) / sd;
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
  console.log('实验 K：阳性对照 —— crypto.pbkdf2（确定走 libuv 线程池）');
  console.log(`每档 ${ROUNDS} 轮交错\n`);
  console.log('  任务数  TPS=4 p50   TPS=16 p50   TPS=32 p50   加速比16/4   加速比32/4   p');
  console.log('  ─────────────────────────────────────────────────────────────────────────');

  for (const n of [4, 8, 16, 32]) {
    const a = [], b = [], c = [];
    for (let r = 0; r < ROUNDS; r += 1) {
      const x = await once(4, n);
      const y = await once(16, n);
      const z = await once(32, n);
      if (x !== null) a.push(x);
      if (y !== null) b.push(y);
      if (z !== null) c.push(z);
    }
    const { p } = wilcoxon(a.map((v, i) => v - b[i]));
    console.log(
      `  ${String(n).padStart(6)} ${median(a).toFixed(0).padStart(11)} `
      + `${median(b).toFixed(0).padStart(11)} ${median(c).toFixed(0).padStart(11)} `
      + `${(median(a) / median(b)).toFixed(2).padStart(12)}x `
      + `${(median(a) / median(c)).toFixed(2).padStart(12)}x  ${p.toFixed(4)}`,
    );
  }

  console.log('');
  console.log('  判读: 加速比应随任务数增长而显著 >1。若无，则本套测量方法不可信。');
})();

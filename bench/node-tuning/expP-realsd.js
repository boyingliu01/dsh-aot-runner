/**
 * 实验 P：真实项目目录 glob —— 严谨版，检验"波动收窄"这个说法
 *
 * ## 为什么单独做这一轮
 *
 * 文档的原话是「并发上来直接堵死」+「波动收窄」。
 * 前面实验证明**中位数**没变化，但文档还声称**波动**会收窄。
 * 初步数据里 TPS=4 的 stdev 出现过 34.8 / 15.3，而 TPS=16 多在 1~3 ——
 * 这可能是真信号，也可能只是 6 轮小样本的偶然。
 *
 * 必须用足够轮数 + 配对检验来区分。
 *
 * ## 测什么
 *   主指标: stdev（文档声称会收窄的就是这个）
 *   副指标: p50（绝对值）、p95（尾部）
 *
 * 配对方式: 同一轮里跑 TPS=4 和 TPS=16，比较各自的 stdev。
 */
'use strict';

const { spawn } = require('child_process');
const path = require('path');

const CHILD = path.join(__dirname, 'real-glob.js');
const TARGET = 'D:/projects/dsh-aot-runner';
const ROUNDS = parseInt(process.argv[2], 10) || 30;

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
    const cp = spawn(process.execPath, [CHILD, TARGET], {
      env: { ...process.env, UV_THREADPOOL_SIZE: String(tps) },
      stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true,
    });
    let out = '';
    cp.stdout.on('data', (d) => { out += d; });
    cp.on('close', () => {
      const p = out.trim().split(/\s+/).map(Number);
      resolve(p.length === 3 && p.every(Number.isFinite)
        ? { med: p[0], sd: p[1], n: p[2] } : null);
    });
    cp.on('error', () => resolve(null));
  });
}

(async () => {
  console.log(`实验 P：真实项目目录 glob（${TARGET}，253 个文件全部 stat）`);
  console.log(`TPS=4 vs TPS=16，${ROUNDS} 轮交错\n`);

  const a = [], b = [];
  for (let r = 0; r < ROUNDS; r += 1) {
    const x = await once(4);
    const y = await once(16);
    if (x) a.push(x);
    if (y) b.push(y);
    if ((r + 1) % 10 === 0) process.stdout.write(`  ${r + 1}/${ROUNDS}\n`);
  }

  const amed = a.map((x) => x.med), bmed = b.map((x) => x.med);
  const asd = a.map((x) => x.sd), bsd = b.map((x) => x.sd);

  console.log('');
  console.log('  ── p50（绝对值延迟）──');
  console.log(`    TPS=4  : 中位 p50 = ${median(amed).toFixed(2)}ms`);
  console.log(`    TPS=16 : 中位 p50 = ${median(bmed).toFixed(2)}ms`);
  const pMed = wilcoxon(amed.map((v, i) => v - bmed[i])).p;
  console.log(`    差异: ${((median(bmed) / median(amed) - 1) * 100).toFixed(1)}%   p = ${pMed.toFixed(4)}`);

  console.log('');
  console.log('  ── stdev（文档声称"波动收窄"的就是这个）──');
  console.log(`    TPS=4  : 各轮 stdev 的中位数 = ${median(asd).toFixed(2)}ms`);
  console.log(`    TPS=16 : 各轮 stdev 的中位数 = ${median(bsd).toFixed(2)}ms`);
  const pSd = wilcoxon(asd.map((v, i) => v - bsd[i])).p;
  console.log(`    差异: ${((median(bsd) / median(asd) - 1) * 100).toFixed(1)}%   p = ${pSd.toFixed(4)}`);

  console.log('');
  console.log('  ── TPS=4 的 stdev 序列（看是否存在极端离群）──');
  console.log(`    ${asd.map((x) => x.toFixed(1)).join(' ')}`);
  console.log('  ── TPS=16 的 stdev 序列 ──');
  console.log(`    ${bsd.map((x) => x.toFixed(1)).join(' ')}`);

  console.log('');
  const sigP = pMed < 0.05;
  const sigS = pSd < 0.05;
  console.log(`  结论: p50 ${sigP ? '显著不同' : '无显著差异'}；stdev ${sigS ? '显著不同' : '无显著差异'}`);
  if (!sigP && !sigS) {
    console.log('  → 在这个场景下，调大线程池没有任何可测得的影响');
  }
})();

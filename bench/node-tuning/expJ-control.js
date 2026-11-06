/**
 * 实验 J：阳性对照 —— 先证明测量能"看见"线程池效应
 *
 * ## 为什么必须先做这一步
 *
 * 前面所有实验都显示 UV_THREADPOOL_SIZE 无显著收益。
 * 但"测不出差异"有两种可能：
 *   (a) 确实没有差异
 *   (b) 我的测试方法根本检测不到这个效应
 *
 * 不做阳性对照，"无收益"这个结论就不可信 —— 这正是
 * docs/测量方法论 里反复强调的规则 1「先证明工具能看见东西」。
 *
 * ## 怎么造出可控的慢 fs
 *
 * 真实磁盘 IO 太快（缓存命中 ~0.1ms），线程池瞬间就排空了。
 * 所以这里用**人为阻塞**的 fs 操作：读一个命名管道或大文件，
 * 让每个请求实际占用一个线程池槽位数毫秒。
 *
 * 如果在线程池真被打满的场景下 TPS=16 仍无收益，
 * 才能断定这个优化对本机 DSH 无效。
 */
'use strict';

const { spawn } = require('child_process');
const path = require('path');

const CHILD = path.join(__dirname, 'slowfs.js');
const LEVELS = [4, 8, 16, 32];
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
  console.log('实验 J：阳性对照 —— 用人为阻塞的 fs 操作压满线程池');
  console.log(`每个档位 = N 个阻塞 fs 请求同时在飞，每档 ${ROUNDS} 轮\n`);
  console.log('  同时在飞   TPS=4 p50   TPS=16 p50   TPS=32 p50   加速比(16/4)  p');
  console.log('  ──────────────────────────────────────────────────────────────────────');

  for (const n of LEVELS) {
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
    const speed = median(a) / median(b);
    console.log(
      `  ${String(n).padStart(9)} ${median(a).toFixed(1).padStart(11)} `
      + `${median(b).toFixed(1).padStart(11)} ${median(c).toFixed(1).padStart(11)} `
      + `${speed.toFixed(2).padStart(12)}x  ${p.toFixed(4)}`,
    );
  }

  console.log('');
  console.log('  判读: 若加速比明显 >1 且 p<0.05，说明测量**能**看见线程池效应，');
  console.log('        后续"无收益"的结论才有意义。若这里也测不出，说明实验设计有问题。');
})();

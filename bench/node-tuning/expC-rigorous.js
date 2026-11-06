/**
 * 实验 C（严谨版）：环境变量对 Node 启动开销的影响
 *
 * 为什么重要：DSH 每次工具调用（bash 类）都要 spawn node；
 * 即使只有几毫秒差异，乘以调用次数也可观。
 * 但启动过程本身不涉及大量并发 fs，理论上 UV_THREADPOOL_SIZE 应当无效。
 * 这里用统计检验确认"无效"，而不是靠肉眼看小数点。
 */
'use strict';
const { spawn } = require('child_process');

const VARIANTS = [
  { label: '默认(干净环境)', env: {} },
  { label: 'TPS=16', env: { UV_THREADPOOL_SIZE: '16' } },
  { label: 'TPS=32', env: { UV_THREADPOOL_SIZE: '32' } },
  { label: 'NOS_4G', env: { NODE_OPTIONS: '--max-old-space-size=4096' } },
  { label: 'NOS_4G+noWarn', env: { NODE_OPTIONS: '--max-old-space-size=4096 --no-warnings' } },
];

const ROUNDS = parseInt(process.argv[2], 10) || 50;

function median(xs) {
  const d = xs.slice().sort((a, b) => a - b);
  const m = Math.floor(d.length / 2);
  return d.length % 2 ? d[m] : (d[m - 1] + d[m]) / 2;
}
function stdev(xs) {
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (xs.length - 1));
}
function pct(xs, p) {
  const d = xs.slice().sort((a, b) => a - b);
  return d[Math.min(d.length - 1, Math.ceil((p / 100) * d.length) - 1)];
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
  // 必须用 |z| 再取双侧 —— 否则 z 为负时会得到 p > 1
  // （踩过：直接传 z 得到 p=1.5018，一个不可能的概率值）
  const az = Math.abs(z);
  const t = 1 / (1 + 0.3275911 * az / Math.SQRT2);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736)
    * t + 0.254829592) * t * Math.exp(-(az * az) / 2);
  const upper = 1 - 0.5 * (1 + y);   // P(Z > |z|)
  return { z, p: Math.min(1, 2 * upper) };
}

function once(env) {
  return new Promise((resolve) => {
    const clean = { ...process.env };
    delete clean.UV_THREADPOOL_SIZE;
    delete clean.NODE_OPTIONS;
    const t0 = process.hrtime.bigint();
    const cp = spawn(process.execPath, ['-e', ''], {
      env: { ...clean, ...env }, stdio: 'ignore', windowsHide: true,
    });
    cp.on('close', () => resolve(Number(process.hrtime.bigint() - t0) / 1e6));
    cp.on('error', () => resolve(null));
  });
}

(async () => {
  console.log(`实验 C（严谨版）：Node 启动开销（node -e ""）`);
  console.log(`每变体 ${ROUNDS} 轮交错采样\n`);

  const s = new Map(VARIANTS.map((v) => [v.label, []]));
  for (let r = 0; r < ROUNDS; r += 1) {
    for (const v of VARIANTS) {
      const x = await once(v.env);
      if (x !== null) s.get(v.label).push(x);
    }
    if ((r + 1) % 25 === 0) process.stdout.write(`  ${r + 1}/${ROUNDS}\n`);
  }

  const base = s.get('默认(干净环境)');
  console.log('');
  console.log('  变体                p50     p95    stdev   相对默认   Wilcoxon p');
  console.log('  ───────────────────────────────────────────────────────────────');
  for (const v of VARIANTS) {
    const xs = s.get(v.label);
    let ratio = '—', pStr = '—';
    if (v.label !== '默认(干净环境)') {
      const diffs = base.map((b, i) => b - xs[i]);
      const { p } = wilcoxon(diffs);
      const delta = (median(xs) / median(base) - 1) * 100;
      ratio = `${delta >= 0 ? '+' : ''}${delta.toFixed(1)}%`;
      pStr = `${p.toFixed(4)}${p < 0.05 ? ' *' : ''}`;
    }
    console.log(
      `  ${v.label.padEnd(18)} ${median(xs).toFixed(1).padStart(6)} `
      + `${pct(xs, 95).toFixed(1).padStart(6)} ${stdev(xs).toFixed(1).padStart(6)} `
      + `${ratio.padStart(9)}   ${pStr.padStart(8)}`,
    );
  }
})();

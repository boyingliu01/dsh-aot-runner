/**
 * 实验 H：真实 DSH 工具调用路径的端到端 A/B
 *
 * 前面的实验都是合成基准。这一步用**真实的 AOT runner + 真实 target**
 * 走一遍和 DSH 完全相同的调用契约，对比不同 UV_THREADPOOL_SIZE。
 *
 * 如果连真实路径都没有差异，那这个优化措施对本项目就是无效的。
 *
 * 关键区别（vs 合成基准）：
 *   - 真实走 AOT exe → spawn target → 等待退出
 *   - 包含 Windows Job Object 创建、进程创建、stdin/stdout 管道
 *   - 这才是 DSH 里真正发生的链路
 */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');
const AOT = path.join(REPO, 'dist', 'dsh-aot-runner.exe');

const VARIANTS = ['default', '16', '32'];
const ROUNDS = parseInt(process.argv[2], 10) || 20;
const PARALLEL = parseInt(process.argv[3], 10) || 10;

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

/** 通过 AOT runner 执行一次 target，返回耗时 ms。 */
function callOnce(env) {
  return new Promise((resolve) => {
    const t0 = process.hrtime.bigint();
    const cp = spawn(AOT, ['cmd.exe', '/c', 'exit 0'], {
      env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    cp.stdout.on('data', () => {});
    cp.stderr.on('data', () => {});
    cp.on('close', () => resolve(Number(process.hrtime.bigint() - t0) / 1e6));
    cp.on('error', () => resolve(null));
  });
}

/** 并发发起 PARALLEL 次工具调用（模拟 DSH 一次 step 里并行 10 个工具）。 */
function callBatch(env) {
  return new Promise((resolve) => {
    const t0 = process.hrtime.bigint();
    let done = 0;
    let failed = 0;
    for (let i = 0; i < PARALLEL; i += 1) {
      const cp = spawn(AOT, ['cmd.exe', '/c', 'exit 0'], {
        env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
      });
      cp.stdout.on('data', () => {});
      cp.stderr.on('data', () => {});
      cp.on('close', () => {
        done += 1;
        if (done === PARALLEL) {
          resolve({ ms: Number(process.hrtime.bigint() - t0) / 1e6, failed });
        }
      });
      cp.on('error', () => { failed += 1; });
    }
  });
}

(async () => {
  if (!fs.existsSync(AOT)) {
    console.error(`找不到 AOT runner: ${AOT}`);
    process.exit(1);
  }

  console.log(`实验 H：真实 DSH 调用链路端到端`);
  console.log(`  runner: ${AOT}`);
  console.log(`  target: cmd.exe /c exit 0`);
  console.log(`  场景: 单次顺序 + ${PARALLEL} 路并发`);

  const env = (v) => {
    const e = { ...process.env };
    delete e.UV_THREADPOOL_SIZE;
    delete e.NODE_OPTIONS;
    if (v !== 'default') e.UV_THREADPOOL_SIZE = v;
    return e;
  };

  // 预热
  await callOnce(env('default'));

  // ── 单次顺序调用 ──
  console.log(`\n【场景 1】单次顺序调用，每变体 ${ROUNDS * 2} 次交错`);
  const seq = new Map(VARIANTS.map((v) => [v, []]));
  for (let r = 0; r < ROUNDS * 2; r += 1) {
    for (const v of VARIANTS) {
      const ms = await callOnce(env(v));
      if (ms !== null) seq.get(v).push(ms);
    }
  }
  const seqBase = seq.get('default');
  console.log('  变体        p50      p95     stdev   相对默认   Wilcoxon p');
  for (const v of VARIANTS) {
    const xs = seq.get(v);
    let ratio = '—', pStr = '—';
    if (v !== 'default') {
      const { p } = wilcoxon(seqBase.map((b, i) => b - xs[i]));
      const delta = (median(xs) / median(seqBase) - 1) * 100;
      ratio = `${delta >= 0 ? '+' : ''}${delta.toFixed(1)}%`;
      pStr = `${p.toFixed(4)}${p < 0.05 ? ' *' : ''}`;
    }
    console.log(
      `  ${v.padEnd(9)} ${median(xs).toFixed(1).padStart(7)} `
      + `${pct(xs, 95).toFixed(1).padStart(7)} ${stdev(xs).toFixed(1).padStart(7)} `
      + `${ratio.padStart(9)}   ${pStr.padStart(8)}`,
    );
  }

  // ── 并发调用 ──
  console.log(`\n【场景 2】${PARALLEL} 路并发调用，每变体 ${ROUNDS} 轮交错`);
  const con = new Map(VARIANTS.map((v) => [v, []]));
  for (let r = 0; r < ROUNDS; r += 1) {
    for (const v of VARIANTS) {
      const res = await callBatch(env(v));
      con.get(v).push(res.ms);
    }
    if ((r + 1) % 10 === 0) process.stdout.write(`  ${r + 1}/${ROUNDS}\n`);
  }
  const conBase = con.get('default');
  console.log('  变体        p50      p95     stdev   相对默认   Wilcoxon p');
  for (const v of VARIANTS) {
    const xs = con.get(v);
    let ratio = '—', pStr = '—';
    if (v !== 'default') {
      const { p } = wilcoxon(conBase.map((b, i) => b - xs[i]));
      const delta = (median(xs) / median(conBase) - 1) * 100;
      ratio = `${delta >= 0 ? '+' : ''}${delta.toFixed(1)}%`;
      pStr = `${p.toFixed(4)}${p < 0.05 ? ' *' : ''}`;
    }
    console.log(
      `  ${v.padEnd(9)} ${median(xs).toFixed(1).padStart(7)} `
      + `${pct(xs, 95).toFixed(1).padStart(7)} ${stdev(xs).toFixed(1).padStart(7)} `
      + `${ratio.padStart(9)}   ${pStr.padStart(8)}`,
    );
  }
})();

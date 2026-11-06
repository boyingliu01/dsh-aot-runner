/**
 * 实验 N（收官）：证明真正的瓶颈是「NTFS 元数据串行」，不是线程池
 *
 * ## 推理线索
 *
 * 实验 I 的原始数据里有个极强的信号：
 *
 *   同时在飞   TPS=4 耗时     每 op 摊薄
 *        4      0.11ms       0.0275ms
 *        8      0.16ms       0.0200ms
 *       16      0.28ms       0.0175ms
 *       32      0.54ms       0.0169ms
 *       64      1.20ms       0.0188ms
 *      128      2.78ms       0.0217ms
 *
 * 注意：**耗时随并发数几乎严格线性增长**，每 op 摊薄成本恒定在 0.017~0.027ms。
 * 这是「完全串行资源」的典型特征 —— 并发度再高，吞吐量不变。
 * 如果是线程池瓶颈，增加线程数就该看到每 op 成本下降。
 *
 * ## 本次要证伪/证实的命题
 *   H1: stat 吞吐随并发度线性饱和（串行瓶颈，符合 NTFS MFT 锁）
 *   H2: 提高 UV_THREADPOOL_SIZE 不改变这个饱和点
 *
 * 两个都成立 → 文档提的优化措施在原理上就达不到目的。
 */
'use strict';

const { spawn } = require('child_process');
const path = require('path');

const CHILD = path.join(__dirname, 'throughput-child.js');
const ROUNDS = parseInt(process.argv[2], 10) || 8;

function median(xs) {
  const d = xs.slice().sort((a, b) => a - b);
  const m = Math.floor(d.length / 2);
  return d.length % 2 ? d[m] : (d[m - 1] + d[m]) / 2;
}

function once(tps, inflight, total) {
  return new Promise((resolve) => {
    const cp = spawn(process.execPath, [CHILD, String(inflight), String(total)], {
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
  const TOTAL = 2000;
  const LEVELS = [1, 2, 4, 8, 16, 32, 64];

  console.log('实验 N：stat 吞吐 vs 并发度（固定总任务数 2000）');
  console.log(`每档 ${ROUNDS} 轮\n`);
  console.log('  并发度   TPS=4 耗时   TPS=4 吞吐      TPS=16 耗时   TPS=16 吞吐');
  console.log('          (ms)        (ops/s)         (ms)         (ops/s)');
  console.log('  ──────────────────────────────────────────────────────────────');

  const rows = [];
  for (const n of LEVELS) {
    const a = [], b = [];
    for (let r = 0; r < ROUNDS; r += 1) {
      const x = await once(4, n, TOTAL);
      const y = await once(16, n, TOTAL);
      if (x !== null) a.push(x);
      if (y !== null) b.push(y);
    }
    const ma = median(a);
    const mb = median(b);
    rows.push({ n, ma, mb, tpa: TOTAL / ma * 1000, tpb: TOTAL / mb * 1000 });
    console.log(
      `  ${String(n).padStart(6)} ${ma.toFixed(1).padStart(12)} `
      + `${Math.round(TOTAL / ma * 1000).toLocaleString().padStart(13)} `
      + `${mb.toFixed(1).padStart(13)} ${Math.round(TOTAL / mb * 1000).toLocaleString().padStart(13)}`,
    );
  }

  console.log('');
  console.log('  ── 吞吐随并发度的变化 ──');
  const base = rows[0];
  for (const r of rows) {
    const scaleA = r.tpa / base.tpa;
    const scaleB = r.tpb / base.tpb;
    console.log(
      `    并发=${String(r.n).padStart(3)}  TPS=4 吞吐 ×${scaleA.toFixed(2)}   `
      + `TPS=16 吞吐 ×${scaleB.toFixed(2)}`,
    );
  }

  console.log('');
  console.log('  判读:');
  console.log('    若吞吐随并发度提升后**饱和在某个倍数**（比如 ×3~×5 就不再涨），');
  console.log('    说明存在串行资源（NTFS 元数据锁），加线程池无效。');
  console.log('    若吞吐一直线性上涨到并发=64，说明线程池是唯一瓶颈。');
})();

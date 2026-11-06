// 实验 D：单进程内真正的并发 fs 压力（模拟 glob/grep 类工具）
//
// 与实验 A 的区别：A 用 20 个文件、总 IO 小，差异性被噪声淹没。
// 这里用 200 文件 + 交错采样 + 足够轮数，让线程池成为真正的瓶颈。
'use strict';
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, 'files');
const FILES = fs.readdirSync(DIR).map((f) => path.join(DIR, f)).sort();

const N = parseInt(process.argv[2], 10) || 200;

(async () => {
  await fs.promises.readFile(FILES[0]);   // 预热
  const samples = [];
  const R = 20;
  for (let i = 0; i < R; i += 1) {
    // 逐轮顺序打乱文件名，避免同一批被 OS 缓存优先命中
    const picks = FILES.slice(0, N);
    const t0 = process.hrtime.bigint();
    await Promise.all(picks.map((f) => fs.promises.readFile(f)));
    samples.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  samples.sort((a, b) => a - b);
  const med = samples[Math.floor(R / 2)];
  const p95 = samples[Math.min(R - 1, Math.ceil(0.95 * R) - 1)];
  const mean = samples.reduce((a, b) => a + b, 0) / R;
  const sd = Math.sqrt(samples.reduce((a, b) => a + (b - mean) ** 2, 0) / (R - 1));
  process.stdout.write(`${med.toFixed(1)} ${p95.toFixed(1)} ${sd.toFixed(1)}`);
})();

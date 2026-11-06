// 在 libuv 线程池里制造 N 个同时"在飞"的 fs 请求。
// 用 stat 而不是 read：stat 是元数据操作，纯线程池工作，不做磁盘带宽测量。
'use strict';
const { stat } = require('node:fs/promises');
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, 'tiny');
const FILES = fs.readdirSync(DIR).map((f) => path.join(DIR, f)).sort();
const N = parseInt(process.argv[2], 10) || 16;

(async () => {
  await stat(FILES[0]);   // 预热
  const samples = [];
  const R = 10;
  for (let r = 0; r < R; r += 1) {
    const picks = FILES.slice(0, N);
    const t0 = process.hrtime.bigint();
    await Promise.all(picks.map((f) => stat(f)));
    samples.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  samples.sort((a, b) => a - b);
  process.stdout.write(samples[Math.floor(R / 2)].toFixed(3));
})();

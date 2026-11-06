// 模拟 glob/grep：对 N 个小文件并发 stat，用固定并发池而不是一次全发
'use strict';
const { stat } = require('node:fs/promises');
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, 'tiny');
const FILES = fs.readdirSync(DIR).map((f) => path.join(DIR, f)).sort();
const N = parseInt(process.argv[2], 10) || 500;
const CONCURRENCY = 16;   // 固定并发池，模拟真实的 walk 语义

(async () => {
  await stat(FILES[0]);
  const samples = [];
  const R = 8;
  for (let r = 0; r < R; r += 1) {
    const t0 = process.hrtime.bigint();
    let next = 0;
    const worker = async () => {
      while (next < N) {
        const i = next;
        next += 1;
        await stat(FILES[i % FILES.length]);
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    samples.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  samples.sort((a, b) => a - b);
  const med = samples[Math.floor(R / 2)];
  const mean = samples.reduce((a, b) => a + b, 0) / R;
  const sd = Math.sqrt(samples.reduce((a, b) => a + (b - mean) ** 2, 0) / (R - 1));
  process.stdout.write(`${med.toFixed(2)} ${sd.toFixed(2)}`);
})();

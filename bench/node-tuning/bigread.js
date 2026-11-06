// 读 N 个 64MB 文件（首读会被页缓存，所以先清一个足够大的量再读）
'use strict';
const { readFile } = require('node:fs/promises');
const fs = require('fs');
const path = require('path');
const DIR = path.join(__dirname, 'big');
const FILES = fs.readdirSync(DIR).map(f => path.join(DIR, f)).sort();
const N = parseInt(process.argv[2], 10) || 4;

(async () => {
  const samples = [];
  const R = 5;
  for (let r = 0; r < R; r++) {
    const t0 = process.hrtime.bigint();
    await Promise.all(Array.from({length:N}, (_, i) => readFile(FILES[i % FILES.length])));
    samples.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  samples.sort((a,b)=>a-b);
  process.stdout.write(samples[Math.floor(R/2)].toFixed(1));
})();

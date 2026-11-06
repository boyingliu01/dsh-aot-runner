// 人为让每个 fs 读变慢：读一个大文件（会被 OS 缓存，但仍有内存拷贝成本），
// 并做多次 hash 计算强制占用线程。
// 目的：在 libuv 线程池里制造可观测的排队。
'use strict';
const { readFile } = require('node:fs/promises');
const crypto = require('node:crypto');
const path = require('path');

const N = parseInt(process.argv[2], 10) || 8;
const FILE = path.join(__dirname, 'files', 'f000.js');

(async () => {
  await readFile(FILE);   // 预热

  const samples = [];
  const R = 6;
  for (let r = 0; r < R; r += 1) {
    const t0 = process.hrtime.bigint();
    await Promise.all(Array.from({ length: N }, async () => {
      const buf = await readFile(FILE);
      // crypto 也在线程池里跑，叠加压力
      crypto.createHash('sha256').update(buf).digest();
    }));
    samples.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  samples.sort((a, b) => a - b);
  process.stdout.write(samples[Math.floor(R / 2)].toFixed(3));
})();

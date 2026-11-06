// crypto.pbkdf2 确定由 libuv 线程池执行。
// 每次调用约 5~15ms，并发 N 个时能明显看出线程池大小的影响。
'use strict';
const { pbkdf2 } = require('node:crypto');

const N = parseInt(process.argv[2], 10) || 8;
const KEYLEN = 64;
const ITER = 60000;   // 调到单次约 10ms 量级

function one() {
  return new Promise((resolve, reject) => {
    pbkdf2('password', 'salt', ITER, KEYLEN, 'sha512', (e) => (e ? reject(e) : resolve()));
  });
}

(async () => {
  await one();   // 预热
  const samples = [];
  const R = 5;
  for (let r = 0; r < R; r += 1) {
    const t0 = process.hrtime.bigint();
    await Promise.all(Array.from({ length: N }, one));
    samples.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  samples.sort((a, b) => a - b);
  process.stdout.write(samples[Math.floor(R / 2)].toFixed(3));
})();

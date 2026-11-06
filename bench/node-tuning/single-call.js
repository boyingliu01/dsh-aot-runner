// 决定性实验：模拟 DSH 一次 read_file 的真实 fs 序列。
//
// 从 dsh-tool-fs/lib/index.js 读到的实际行为：
//   1. 先 stat 一次（判断类型、路由、版本）
//   2. 再 readFile 一次
// 两次是**串行**的（stat 结果决定怎么读），不是并发。
//
// 如果这个序列是串行的，那么 libuv 线程池里永远只有 1 个任务在飞，
// UV_THREADPOOL_SIZE 开多大都一样 —— 这是本实验要证明或推翻的核心命题。
'use strict';
const { stat, readFile } = require('node:fs/promises');

const file = process.argv[2];
const ROUNDS = parseInt(process.argv[3], 10) || 50;

(async () => {
  // 预热，排除首次模块加载与冷缓存
  await stat(file);
  await readFile(file);

  const samples = [];
  for (let i = 0; i < ROUNDS; i += 1) {
    const t0 = process.hrtime.bigint();
    // 严格按 DSH 的调用序列：先 stat，再 read
    await stat(file);
    await readFile(file);
    const t1 = process.hrtime.bigint();
    samples.push(Number(t1 - t0) / 1e6);
  }
  samples.sort((a, b) => a - b);
  const med = samples[Math.floor(samples.length / 2)];
  const p95 = samples[Math.min(samples.length - 1, Math.ceil(0.95 * samples.length) - 1)];
  process.stdout.write(`median=${med.toFixed(3)} p95=${p95.toFixed(3)}`);
})();

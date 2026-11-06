// 实验 E：最贴近真实 DSH 的场景
//
// 依据（从 dsh-agent-loop 源码读到）：
//   maxParallelToolCalls 默认 10，工具可并行执行。
// 依据（从 dsh-tool-fs 源码读到）：
//   一次 read_file = 先 stat（判类型/版本）再 readFile，两次串行。
//
// 所以真实负载画像 = 最多 10 路并行，每路 1 个 fs 操作在飞。
// 这正好处在「默认 4 线程」可能不够的边界上 —— 本次要测的就是这里。
'use strict';
const { stat, readFile } = require('node:fs/promises');
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, 'files');
const FILES = fs.readdirSync(DIR).map((f) => path.join(DIR, f)).sort();

const PARALLEL = parseInt(process.argv[2], 10) || 10;   // 并行工具数
const TOOLS = parseInt(process.argv[3], 10) || 100;    // 本批总共发起多少次工具调用

/** 模拟一次 read_file：stat 然后 read，串行。 */
async function oneToolCall(file) {
  const info = await stat(file);
  if (!info.isFile()) return 0;
  const buf = await readFile(file);
  return buf.length;
}

(async () => {
  await oneToolCall(FILES[0]);   // 预热

  const samples = [];
  const R = 15;
  for (let r = 0; r < R; r += 1) {
    const t0 = process.hrtime.bigint();
    // 固定并发池：同时最多 PARALLEL 个工具在飞（DSH 调度器语义）
    let next = 0;
    const worker = async () => {
      while (next < TOOLS) {
        const i = next;
        next += 1;
        await oneToolCall(FILES[i % FILES.length]);
      }
    };
    await Promise.all(Array.from({ length: PARALLEL }, worker));
    samples.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }

  samples.sort((a, b) => a - b);
  const med = samples[Math.floor(R / 2)];
  const mean = samples.reduce((a, b) => a + b, 0) / R;
  const sd = Math.sqrt(samples.reduce((a, b) => a + (b - mean) ** 2, 0) / (R - 1));
  process.stdout.write(`${med.toFixed(2)} ${sd.toFixed(2)}`);
})();

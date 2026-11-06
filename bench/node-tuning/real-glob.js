// 在真实项目目录上模拟 glob：遍历所有文件并 stat
// 这是 fs 唯一可能主导的场景，必须验证
'use strict';
const { stat, readdir } = require('node:fs/promises');
const path = require('path');

const ROOT = process.argv[2];

async function walk(dir, out, limit) {
  if (out.length >= limit) return;
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (out.length >= limit) return;
    if (e.name === 'node_modules' || e.name === '.git') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await walk(p, out, limit);
    else out.push(p);
  }
}

(async () => {
  const files = [];
  await walk(ROOT, files, 3000);
  const samples = [];
  const R = 5;
  for (let r = 0; r < R; r += 1) {
    const t0 = process.hrtime.bigint();
    await Promise.all(files.map((f) => stat(f)));
    samples.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  samples.sort((a, b) => a - b);
  const med = samples[Math.floor(R / 2)];
  const mean = samples.reduce((a, b) => a + b, 0) / R;
  const sd = Math.sqrt(samples.reduce((a, b) => a + (b - mean) ** 2, 0) / (R - 1));
  process.stdout.write(`${med.toFixed(2)} ${sd.toFixed(2)} ${files.length}`);
})();

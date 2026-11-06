/**
 * 实验 L2：直接量出「fs 在工具调用总耗时里的占比」
 *
 * 上一版用线性拟合，在 86% CPU 负载下算出了负斜率（-3.18ms/文件），
 * 明显是被噪声带偏了 —— 负的边际成本在物理上不可能。
 * 这正好又踩中「测量方法」那个坑，这次改成分离测量：
 *
 *   1. 纯 fs 成本：单进程内反复 stat+read，取中位数（微秒级，噪声小）
 *   2. 工具调用总耗时：真实 AOT runner 走完整链路（毫秒级）
 *   3. 占比 = fs / total
 *
 * 两个量分开测，避免把不同量级的东西塞进一个回归里。
 */
'use strict';

const { spawn } = require('child_process');
const { stat, readFile } = require('node:fs/promises');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');
const AOT = path.join(REPO, 'dist', 'dsh-aot-runner.exe');
const FILE = path.join(__dirname, 'files', 'f000.js');

function median(xs) {
  const d = xs.slice().sort((a, b) => a - b);
  const m = Math.floor(d.length / 2);
  return d.length % 2 ? d[m] : (d[m - 1] + d[m]) / 2;
}
function pct(xs, p) {
  const d = xs.slice().sort((a, b) => a - b);
  return d[Math.min(d.length - 1, Math.ceil((p / 100) * d.length) - 1)];
}

/** 纯 fs：DSH 一次 read_file 的完整序列（stat → read）。 */
async function measureFs(rounds) {
  await stat(FILE);
  await readFile(FILE);
  const s = [];
  for (let i = 0; i < rounds; i += 1) {
    const t0 = process.hrtime.bigint();
    await stat(FILE);
    await readFile(FILE);
    s.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  return s;
}

/** 真实链路：AOT runner → cmd.exe。 */
function measureCall(rounds) {
  return new Promise((resolve) => {
    const s = [];
    let done = 0;
    for (let i = 0; i < rounds; i += 1) {
      const t0 = process.hrtime.bigint();
      const cp = spawn(AOT, ['cmd.exe', '/c', 'exit 0'], {
        env: process.env, stdio: 'ignore', windowsHide: true,
      });
      cp.on('close', () => {
        s.push(Number(process.hrtime.bigint() - t0) / 1e6);
        done += 1;
        if (done === rounds) resolve(s);
      });
      cp.on('error', () => { done += 1; if (done === rounds) resolve(s); });
    }
  });
}

/** 纯 node 启动（不含 AOT 与 target）。 */
function measureNodeStart(rounds) {
  return new Promise((resolve) => {
    const s = [];
    let done = 0;
    for (let i = 0; i < rounds; i += 1) {
      const t0 = process.hrtime.bigint();
      const cp = spawn(process.execPath, ['-e', ''], {
        env: process.env, stdio: 'ignore', windowsHide: true,
      });
      cp.on('close', () => {
        s.push(Number(process.hrtime.bigint() - t0) / 1e6);
        done += 1;
        if (done === rounds) resolve(s);
      });
    }
  });
}

(async () => {
  const fsRounds = 200;
  const callRounds = 30;

  const fsv = await measureFs(fsRounds);
  const fsMed = median(fsv);

  const nodeStart = await measureNodeStart(callRounds);
  const callV = await measureCall(callRounds);
  const callMed = median(callV);

  console.log('实验 L2：fs 成本 vs 工具调用总耗时\n');
  console.log('  【纯 fs】DSH 一次 read_file 的序列（stat → read，43KB 文件）');
  console.log(`    n=${fsRounds}   p50 = ${fsMed.toFixed(3)}ms   p95 = ${pct(fsv, 95).toFixed(3)}ms`);
  console.log('');
  console.log('  【纯 node 启动】node -e ""');
  console.log(`    n=${callRounds}   p50 = ${median(nodeStart).toFixed(1)}ms`);
  console.log('');
  console.log('  【真实工具调用】AOT runner → cmd.exe /c exit 0');
  console.log(`    n=${callRounds}   p50 = ${callMed.toFixed(1)}ms   p95 = ${pct(callV, 95).toFixed(1)}ms`);
  console.log('');
  console.log('  ── 占比分析 ──');
  console.log(`    fs 占工具调用总耗时: ${(fsMed / callMed * 100).toFixed(3)}%`);
  console.log(`    fs 占纯 node 启动:   ${(fsMed / median(nodeStart) * 100).toFixed(3)}%`);
  console.log('');
  console.log('  即使 fs 变成 0 成本，工具调用最多也只能改善:');
  console.log(`    AOT 链路: ${fsMed.toFixed(3)}ms / ${callMed.toFixed(0)}ms = ${(fsMed / callMed * 100).toFixed(3)}%`);
  console.log('');
  console.log('  推论: UV_THREADPOOL_SIZE 的优化上限就是这个占比。');
  console.log('        若占比远小于测量噪声，则该优化在实践中不可观测。');
})();

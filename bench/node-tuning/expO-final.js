/**
 * 实验 O：收官 —— 在干净基线上下最终结论
 *
 * ## 要回答的最后一组事实
 *
 * 1. 真实工具调用的 p50 到底是多少？（前面测出 283ms 和 1617ms 两个值，
 *    相差 6 倍 —— 必须搞清是负载噪声还是我的测量有别的问题）
 * 2. fs 在这个总耗时里占多少？（决定 UV_THREADPOOL_SIZE 的理论上限）
 * 3. fs 的 p95 尾巴有多长？（如果尾延迟很大，均值优化没意义但尾部可能有）
 *
 * ## 测量策略
 * 交错采样 + 同时记录 CPU 负载，让读者能判断数据可信度。
 * 不再试图把不同量级（0.66ms vs 90ms）的东西塞进同一个回归。
 */
'use strict';

const { spawn, execFileSync } = require('child_process');
const { stat, readFile } = require('node:fs/promises');
const path = require('path');

const REPO = 'D:/projects/dsh-aot-runner';
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
function cpuNow() {
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      '[math]::Round((Get-CimInstance Win32_Processor).LoadPercentage)'],
    { encoding: 'utf8', timeout: 10000, windowsHide: true });
    const v = parseFloat(out.trim());
    return Number.isFinite(v) ? v : null;
  } catch { return null; }
}

/** fs 序列：DSH read_file 的真实模式（stat → read）。 */
async function fsSeries(n) {
  await stat(FILE); await readFile(FILE);
  const s = [];
  for (let i = 0; i < n; i += 1) {
    const t0 = process.hrtime.bigint();
    await stat(FILE);
    await readFile(FILE);
    s.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  return s;
}

/** 单次 AOT 工具调用。 */
function aotOnce() {
  return new Promise((resolve) => {
    const t0 = process.hrtime.bigint();
    const cp = spawn(AOT, ['cmd.exe', '/c', 'exit 0'], {
      env: process.env, stdio: 'ignore', windowsHide: true,
    });
    cp.on('close', () => resolve(Number(process.hrtime.bigint() - t0) / 1e6));
    cp.on('error', () => resolve(null));
  });
}

/** 单次纯 node 启动。 */
function nodeOnce() {
  return new Promise((resolve) => {
    const t0 = process.hrtime.bigint();
    const cp = spawn(process.execPath, ['-e', ''], {
      env: process.env, stdio: 'ignore', windowsHide: true,
    });
    cp.on('close', () => resolve(Number(process.hrtime.bigint() - t0) / 1e6));
    cp.on('error', () => resolve(null));
  });
}

(async () => {
  const cpuStart = cpuNow();
  console.log(`实验 O：收官测量（起测 CPU ${cpuStart}%）\n`);

  // 1) fs 序列
  const fsSamples = await fsSeries(300);
  console.log('【1】纯 fs：一次 read_file 的 fs 成本（stat + read 43KB）');
  console.log(`    n=300  p50=${median(fsSamples).toFixed(3)}ms  `
    + `p95=${pct(fsSamples, 95).toFixed(3)}ms  p99=${pct(fsSamples, 99).toFixed(3)}ms  `
    + `max=${Math.max(...fsSamples).toFixed(3)}ms`);

  // 2) AOT 工具调用
  await aotOnce();
  const aot = [];
  for (let i = 0; i < 40; i += 1) {
    const v = await aotOnce();
    if (v !== null) aot.push(v);
  }
  console.log('');
  console.log('【2】真实工具调用（AOT runner → cmd.exe /c exit 0）');
  console.log(`    n=${aot.length}  p50=${median(aot).toFixed(1)}ms  `
    + `p95=${pct(aot, 95).toFixed(1)}ms  max=${Math.max(...aot).toFixed(1)}ms`);

  // 3) 纯 node 启动
  const nd = [];
  for (let i = 0; i < 40; i += 1) {
    const v = await nodeOnce();
    if (v !== null) nd.push(v);
  }
  console.log('');
  console.log('【3】纯 node 启动（node -e ""）');
  console.log(`    n=${nd.length}  p50=${median(nd).toFixed(1)}ms  `
    + `p95=${pct(nd, 95).toFixed(1)}ms  max=${Math.max(...nd).toFixed(1)}ms`);

  const cpuEnd = cpuNow();

  // 4) 占比
  console.log('');
  console.log('【4】占比与理论上限');
  const fsP50 = median(fsSamples);
  const aotP50 = median(aot);
  console.log(`    fs 占 AOT 调用总耗时  : ${(fsP50 / aotP50 * 100).toFixed(3)}%  `
    + `(${fsP50.toFixed(2)}ms / ${aotP50.toFixed(0)}ms)`);
  console.log(`    fs 占纯 node 启动     : ${(fsP50 / median(nd) * 100).toFixed(3)}%  `
    + `(${fsP50.toFixed(2)}ms / ${median(nd).toFixed(0)}ms)`);
  console.log('');
  console.log(`    → 即使 fs 变成零成本，AOT 调用也只能快 ${(fsP50 / aotP50 * 100).toFixed(2)}%`);
  console.log(`    → 这就是 UV_THREADPOOL_SIZE 的理论收益上限`);
  console.log('');
  console.log(`    fs p95 绝对量: ${pct(fsSamples, 95).toFixed(2)}ms  （尾延迟的上限贡献）`);
  console.log('');
  console.log(`结束 CPU: ${cpuEnd}%`);
})();

#!/usr/bin/env node
/**
 * 负载矩阵对照测试：在低/中/高负载下分别对比 node runner 与 AOT runner。
 *
 * 与 d1-ab-bench.js 的区别：
 *   d1-ab-bench  固定 hostname 地板，单次交错采样
 *   本文件       以**真实 target**（可选 bash/node）为对象，测完整调用生命周期，
 *                并按目标负载自动生成 CPU 压力，验证「负载越高 AOT 收益越大」是否成立
 *
 * 为什么需要它：用户在实际使用中观察到的耗时（~150ms）远高于基准里的 66ms，
 * 因为基准只测 runner 跳，而真实一次 bash 调用还要加 bash 自身启动。
 * 本脚本测的正是后者。
 *
 * 用法:
 *   node bench/load-matrix.cjs --target bash --n 20
 *   node bench/load-matrix.cjs --target bash --n 20 --load 0,50,100
 */
'use strict';

const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const rc = require('../test/runner-client.js');

function argVal(name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const N = parseInt(argVal('--n', '20'), 10);
const LOADS = argVal('--load', '0,50,100').split(',').map((s) => parseInt(s.trim(), 10));
const TARGET_NAME = argVal('--target', 'bash');

const CORES = os.cpus().length;

/** 真实 target 的 argv。bash 是最贴近实际使用的场景。 */
function targetArgv(name) {
  const bash = 'C:/Program Files/Git/usr/bin/bash.exe';
  if (name === 'bash') return [bash, '-c', 'echo hi'];
  if (name === 'node') return [process.execPath, '-e', 'process.stdout.write("hi")'];
  return [path.join(process.env.SystemRoot || 'C:/Windows', 'System32/hostname.exe')];
}
const ARGV = targetArgv(TARGET_NAME);

function median(a) {
  if (!a.length) return null;
  const s = a.slice().sort((x, y) => x - y);
  return Math.round(s[Math.floor(s.length / 2)]);
}
function p90(a) {
  if (!a.length) return null;
  const s = a.slice().sort((x, y) => x - y);
  return Math.round(s[Math.floor(s.length * 0.9)]);
}
/** 离散度 = (p90-p50)/p50，越小越可信。 */
function dispersion(a) {
  const m = median(a); const p = p90(a);
  if (!m || m <= 0) return null;
  return Math.round(((p - m) / m) * 1000) / 10;
}

/**
 * 起 CPU 压力进程，把负载抬到目标百分比。
 * 用忙等循环而不是外部工具，保证跨平台且不依赖安装。
 */
function startLoad(percent) {
  const workers = [];
  const count = Math.round((percent / 100) * CORES);
  for (let i = 0; i < count; i++) {
    const w = spawn(process.execPath, ['-e', 'for(;;){}'], { stdio: 'ignore', windowsHide: true });
    w.unref();
    workers.push(w);
  }
  return workers;
}

function stopLoad(workers) {
  for (const w of workers) {
    try { w.kill('SIGKILL'); } catch { /* 已退出 */ }
  }
}

/** 当前 CPU 负载百分比。 */
function cpuLoad() {
  try {
    const { execFileSync } = require('child_process');
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      '[math]::Round((Get-CimInstance Win32_Processor).LoadPercentage)'],
    { encoding: 'utf8', timeout: 8000, windowsHide: true });
    const v = parseFloat(out.trim());
    return Number.isFinite(v) ? v : null;
  } catch { return null; }
}

async function measure(kind, n) {
  const times = [];
  let fails = 0;
  for (let i = 0; i < n; i++) {
    const r = kind === 'node' ? await rc.runNode({ argv: ARGV }) : await rc.runAot({ argv: ARGV });
    if (typeof r.ms === 'number') times.push(r.ms);
    else fails++;
  }
  return { times, fails };
}

(async () => {
  console.log(`负载矩阵对照测试  target=${TARGET_NAME}  每档 n=${N}  核心数=${CORES}\n`);
  const results = [];

  for (const target of LOADS) {
    const workers = target > 0 ? startLoad(target) : [];
    // 让压力进程先稳定下来，否则第一轮测的是"正在爬坡"的瞬时状态
    await new Promise((r) => setTimeout(r, 3000));
    const actual = cpuLoad();

    const node = await measure('node', N);
    const aot = await measure('aot', N);

    stopLoad(workers);
    await new Promise((r) => setTimeout(r, 1500));

    const row = {
      targetLoadPct: target,
      actualCpuPct: actual,
      nodeP50: median(node.times), nodeP90: p90(node.times), nodeDisp: dispersion(node.times),
      aotP50: median(aot.times), aotP90: p90(aot.times), aotDisp: dispersion(aot.times),
      netGainMs: median(node.times) !== null && median(aot.times) !== null
        ? median(node.times) - median(aot.times) : null,
      fails: node.fails + aot.fails,
    };
    results.push(row);
    console.log(
      `目标负载 ${String(target).padStart(3)}% (实测 ${String(row.actualCpuPct).padStart(3)}%)  `
      + `node ${row.nodeP50}ms → AOT ${row.aotP50}ms  净省 ${row.netGainMs}ms  `
      + `离散度 ${row.nodeDisp}/${row.aotDisp}%  失败 ${row.fails}`,
    );
  }

  const outFile = path.join(__dirname, '..', '.aot-observation', `matrix-${Date.now()}.json`);
  require('fs').mkdirSync(path.dirname(outFile), { recursive: true });
  require('fs').writeFileSync(outFile, JSON.stringify({
    at: new Date().toISOString(), target: TARGET_NAME, n: N, cores: CORES, results,
  }, null, 2));
  console.log(`\n已保存: ${outFile}`);
})();

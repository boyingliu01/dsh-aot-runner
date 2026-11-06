#!/usr/bin/env node
/**
 * 实验 A/B/C：验证 UV_THREADPOOL_SIZE 对 fs 并发与进程启动的影响
 *
 * 核心假设（待验证，不是结论）：
 *   UV_THREADPOOL_SIZE 只在**同一进程内**有 ≥4 个并发 fs 操作时才有意义。
 *   如果一个进程只做 1 次 fs 读，线程池调多大都没用。
 *
 * 三个子实验：
 *   A  单进程内并发读 N 个文件   —— 线程池直接受益场景
 *   B  跨进程并发（模拟 DSH 工具调用）—— 每进程只读 1 个文件
 *   C  纯启动开销              —— 线程池变大是否拖慢启动
 *
 * 用法:
 *   node tp-bench.js A --concurrency 20 --rounds 15
 *   node tp-bench.js B --concurrency 8  --rounds 15
 *   node tp-bench.js C --rounds 30
 */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, 'files');
const FILES = fs.readdirSync(DIR).map((f) => path.join(DIR, f)).sort();

/** 中位数 */
function median(xs) {
  if (!xs.length) return null;
  const d = xs.slice().sort((a, b) => a - b);
  const m = Math.floor(d.length / 2);
  return d.length % 2 ? d[m] : (d[m - 1] + d[m]) / 2;
}

/** 标准差（样本） */
function stdev(xs) {
  if (xs.length < 2) return null;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const v = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(v);
}

function pct(xs, p) {
  if (!xs.length) return null;
  const d = xs.slice().sort((a, b) => a - b);
  const i = Math.min(d.length - 1, Math.max(0, Math.ceil((p / 100) * d.length) - 1));
  return d[i];
}

function r1(x) { return x === null ? 'n/a' : Math.round(x * 10) / 10; }

// ───────────────────────────────────────────────────────────────────────────
// 实验 A：单进程内并发读，直接测 libuv 线程池
// ───────────────────────────────────────────────────────────────────────────

/**
 * 在**当前进程**里并发读 count 个文件，返回耗时 ms。
 * 用 Promise.all 让所有 readFile 同时进入队列 —— 这是线程池真正被压的场景。
 */
async function readManyConcurrent(count) {
  const t0 = process.hrtime.bigint();
  const picks = FILES.slice(0, count);
  await Promise.all(picks.map((f) => fs.promises.readFile(f)));
  const t1 = process.hrtime.bigint();
  return Number(t1 - t0) / 1e6;
}

// ───────────────────────────────────────────────────────────────────────────
// 实验 B：跨进程并发（每个子进程只读 1 个文件，模拟一次工具调用）
// ───────────────────────────────────────────────────────────────────────────

/**
 * 子进程任务脚本路径。
 *
 * 踩过的坑：最开始用 `spawn(node, ['-e', SRC, file])` 传脚本，
 * 但在 `-e` 模式下 argv[1] 是第一个额外参数、argv[2] 才是文件 ——
 * 导致子进程 process.argv[2] === undefined，全部 spawn 失败（失败 96 次）。
 * 改成独立脚本文件后 argv 布局才是常规的 [node, script, file]。
 * 这个坑很隐蔽：失败被 `close` 事件吞掉，只看墙钟会以为"变快了"。
 */
const CHILD_SCRIPT = path.join(__dirname, 'child-read.js');

/**
 * 并发 spawn 多个子进程，每个读 1 个文件。
 * 返回 { wallMs, spawnMs, childMs[] }
 *   wallMs  —— 从第一个 spawn 到最后一个退出（墙钟，最贴近用户体感）
 *   spawnMs —— Node 侧 spawn() 调用本身返回的耗时（进程创建开销）
 */
function spawnConcurrent(count, env) {
  return new Promise((resolve) => {
    const wallT0 = process.hrtime.bigint();
    const spawnMs = [];
    const childMs = [];
    let done = 0;
    let failed = 0;

    for (let i = 0; i < count; i += 1) {
      const t0 = process.hrtime.bigint();
      const cp = spawn(process.execPath, [CHILD_SCRIPT, FILES[i]], {
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      spawnMs.push(Number(process.hrtime.bigint() - t0) / 1e6);

      let out = '';
      cp.stdout.on('data', (d) => { out += d; });
      cp.on('error', () => { failed += 1; });
      cp.on('close', () => {
        const v = parseFloat(out.trim());
        if (Number.isFinite(v)) childMs.push(v);
        else failed += 1;
        done += 1;
        if (done === count) {
          resolve({
            wallMs: Number(process.hrtime.bigint() - wallT0) / 1e6,
            spawnMs,
            childMs,
            failed,
          });
        }
      });
    }
  });
}

// ───────────────────────────────────────────────────────────────────────────
// 实验 C：纯启动开销
// ───────────────────────────────────────────────────────────────────────────

/** 测 node -e "" 的端到端启动耗时（含线程池创建）。 */
function measureStartup(env) {
  return new Promise((resolve) => {
    const t0 = process.hrtime.bigint();
    const cp = spawn(process.execPath, ['-e', ''], {
      env, stdio: 'ignore', windowsHide: true,
    });
    cp.on('close', () => resolve(Number(process.hrtime.bigint() - t0) / 1e6));
    cp.on('error', () => resolve(null));
  });
}

// ───────────────────────────────────────────────────────────────────────────
// 交错采样：避免负载漂移导致的假差异
// ───────────────────────────────────────────────────────────────────────────

/**
 * 关键设计：交错（interleaved）而不是分批。
 *
 * 先跑完 A 组再跑 B 组，机器负载漂移会被误判成组间差异 ——
 * 这正是本项目踩过的坑（见 docs/测量方法论）。
 * 所以每轮都跑一次所有变体，再按变体聚合。
 */
async function interleaved(variants, rounds, fn) {
  const samples = new Map(variants.map((v) => [v.label, []]));
  for (let r = 0; r < rounds; r += 1) {
    for (const v of variants) {
      const s = await fn(v);
      if (s !== null && s !== undefined) samples.get(v.label).push(s);
    }
  }
  return samples;
}

async function runA(concurrency, rounds) {
  const variants = [1, 2, 4, 8, 16, 32].map((n) => ({
    label: `TPS=${n}`,
    size: n,
    env: { ...process.env, UV_THREADPOOL_SIZE: String(n) },
  }));

  console.log(`\n实验 A：单进程内并发读 ${concurrency} 个文件（约 43KB each）`);
  console.log(`每变体跑 ${rounds} 轮，交错采样\n`);
  console.log('  线程池   p50     p95     stdev   相对默认(4)');
  console.log('  ─────────────────────────────────────────────');

  // 注意：实验 A 必须让变体在**子进程里**跑，因为
  // UV_THREADPOOL_SIZE 在进程启动后无法改变（libuv 初始化时就定了）。
  const samples = new Map();
  for (const v of variants) samples.set(v.label, []);

  for (let r = 0; r < rounds; r += 1) {
    for (const v of variants) {
      const ms = await new Promise((resolve) => {
        const cp = spawn(process.execPath, [__filename, '--child-read', String(concurrency),
          String(v.size)], {
          env: { ...process.env, UV_THREADPOOL_SIZE: String(v.size) },
          stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true,
        });
        let out = '';
        cp.stdout.on('data', (d) => { out += d; });
        cp.on('close', () => {
          const inner = parseFloat(out.trim());
          // 用子进程内部计时（纯 fs 耗时），排除进程启动开销
          resolve(Number.isFinite(inner) ? inner : null);
        });
      });
      if (ms !== null) samples.get(v.label).push(ms);
    }
  }

  const base = median(samples.get('TPS=4') || []);
  for (const v of variants) {
    const xs = samples.get(v.label) || [];
    if (!xs.length) { console.log(`  ${v.label.padEnd(8)} 未取得数据`); continue; }
    const m = median(xs);
    const ratio = base ? ((m / base) * 100).toFixed(0) + '%' : 'n/a';
    console.log(
      `  ${v.label.padEnd(8)} ${String(r1(m)).padStart(6)}  ${String(r1(pct(xs, 95))).padStart(6)}  `
      + `${String(r1(stdev(xs))).padStart(6)}   ${ratio}`,
    );
  }
}

async function runB(concurrency, rounds) {
  const variants = [4, 8, 16, 32].map((n) => ({
    label: `TPS=${n}`,
    size: n,
    env: { ...process.env, UV_THREADPOOL_SIZE: String(n) },
  }));

  console.log(`\n实验 B：跨进程并发 ${concurrency} 个 Node 子进程，每进程读 1 个文件`);
  console.log('（模拟 DSH 工具调用：一次调用 = 一个新进程 + 少量 fs）');
  console.log(`每变体跑 ${rounds} 轮，交错采样\n`);

  const wall = new Map(variants.map((v) => [v.label, []]));
  const spawnT = new Map(variants.map((v) => [v.label, []]));
  const fails = new Map(variants.map((v) => [v.label, 0]));

  for (let r = 0; r < rounds; r += 1) {
    for (const v of variants) {
      const res = await spawnConcurrent(concurrency, v.env);
      if (res.failed) fails.set(v.label, fails.get(v.label) + res.failed);
      wall.get(v.label).push(res.wallMs);
      spawnT.get(v.label).push(median(res.spawnMs));
    }
  }

  console.log('  线程池   墙钟p50  墙钟p95  墙钟stdev  spawnCall_p50  失败');
  console.log('  ──────────────────────────────────────────────────────────');
  for (const v of variants) {
    const xs = wall.get(v.label);
    console.log(
      `  ${v.label.padEnd(8)} ${String(r1(median(xs))).padStart(7)}  ${String(r1(pct(xs, 95))).padStart(7)}  `
      + `${String(r1(stdev(xs))).padStart(8)}  ${String(r1(median(spawnT.get(v.label)))).padStart(11)}  `
      + `${String(fails.get(v.label)).padStart(4)}`,
    );
  }
  const base = median(wall.get('TPS=4') || []);
  console.log('');
  console.log('  相对默认(4) 的墙钟变化:');
  for (const v of variants) {
    const m = median(wall.get(v.label));
    if (base && m) {
      const delta = m - base;
      console.log(`    ${v.label}: ${delta >= 0 ? '+' : ''}${r1(delta)}ms (${((m / base) * 100).toFixed(1)}%)`);
    }
  }
}

async function runC(rounds) {
  const variants = [
    { label: '默认(无变量)', env: { ...process.env } },
    { label: 'TPS=16', env: { ...process.env, UV_THREADPOOL_SIZE: '16' } },
    { label: 'TPS=32', env: { ...process.env, UV_THREADPOOL_SIZE: '32' } },
    { label: 'NOS_4G', env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=4096 --no-warnings' } },
    { label: 'TPS16+NOS', env: { ...process.env, UV_THREADPOOL_SIZE: '16', NODE_OPTIONS: '--max-old-space-size=4096 --no-warnings' } },
  ];
  // 清掉可能从父进程继承的变量
  for (const v of variants) { delete v.env.UV_THREADPOOL_SIZE; delete v.env.NODE_OPTIONS; }
  variants[1].env.UV_THREADPOOL_SIZE = '16';
  variants[2].env.UV_THREADPOOL_SIZE = '32';
  variants[3].env.NODE_OPTIONS = '--max-old-space-size=4096 --no-warnings';
  variants[4].env.UV_THREADPOOL_SIZE = '16';
  variants[4].env.NODE_OPTIONS = '--max-old-space-size=4096 --no-warnings';

  console.log(`\n实验 C：纯 Node 启动开销（node -e ""）`);
  console.log(`每变体跑 ${rounds} 轮，交错采样\n`);

  const samples = await interleaved(variants, rounds, async (v) => measureStartup(v.env));
  const base = median(samples.get('默认(无变量)') || []);

  console.log('  变体              p50     p95     stdev   相对默认');
  console.log('  ────────────────────────────────────────────────');
  for (const v of variants) {
    const xs = samples.get(v.label) || [];
    if (!xs.length) continue;
    const m = median(xs);
    const diff = base ? m - base : null;
    const sign = diff === null ? '' : (diff >= 0 ? '+' : '');
    console.log(
      `  ${v.label.padEnd(16)} ${String(r1(m)).padStart(6)}  ${String(r1(pct(xs, 95))).padStart(6)}  `
      + `${String(r1(stdev(xs))).padStart(6)}  ${sign}${r1(diff)}ms`,
    );
  }
}

// ───────────────────────────────────────────────────────────────────────────
// 子进程入口（实验 A 用）
// ───────────────────────────────────────────────────────────────────────────

if (process.argv[2] === '--child-read') {
  const count = parseInt(process.argv[3], 10);
  (async () => {
    // 预热一次，避免把首次模块加载算进来
    await fs.promises.readFile(FILES[0]);
    const ms = await readManyConcurrent(count);
    console.log(ms.toFixed(3));
  })();
} else {
  (async () => {
    const mode = (process.argv[2] || 'A').toUpperCase();
    const arg = (name, def) => {
      const i = process.argv.indexOf(name);
      return i >= 0 && process.argv[i + 1] ? parseInt(process.argv[i + 1], 10) : def;
    };

    if (mode === 'A') await runA(arg('--concurrency', 20), arg('--rounds', 15));
    else if (mode === 'B') await runB(arg('--concurrency', 8), arg('--rounds', 15));
    else if (mode === 'C') await runC(arg('--rounds', 30));
    else { console.error('用法: node tp-bench.js A|B|C [--concurrency N] [--rounds N]'); process.exit(2); }
  })();
}

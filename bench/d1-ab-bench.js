#!/usr/bin/env node
/**
 * D1: 同时段 A/B 基准 —— node runner vs AOT runner
 *
 * 严格按 DSH 真实调用契约构造：
 *   spawn(program, args, { cwd, env: runnerEnvironment(...), stdio: runnerStdio(...) })
 *
 * runnerStdio (ipc=true):
 *   ["ignore","ignore","ignore","ipc", stdinCarrier, stdout, stderr, (control?)]
 *     0        1        2        3      4(fd4)         5(fd5)  6(fd6)    7
 *
 * AOT runner 用 NDJSON 取代 Node IPC，所以 stdio 布局：
 *   ["pipe"(协议in), "pipe"(协议out), "pipe"(stderr诊断), "pipe"(fd3占位),
 *    "pipe"(fd4 target stdin), "pipe"(fd5 target stdout), "pipe"(fd6 target stderr)]
 */
const { spawn } = require('child_process');
const path = require('path');

// ---------------- 配置 ----------------
// runner 路径解析复用 test/runner-client.js，避免同一套查找逻辑在两处漂移。
const { resolveNodeRunner, resolveAotRunner } = require('../test/runner-client.js');

const NODE = process.execPath;
const NODE_RUNNER = process.argv[2] && process.argv[2].endsWith('runner.js')
  ? process.argv[2]
  : resolveNodeRunner();
const AOT_RUNNER = process.argv[2] && process.argv[2].endsWith('.exe')
  ? process.argv[2]
  : resolveAotRunner();
const FLOOR = path.join(process.env.SystemRoot || 'C:/Windows', 'System32/hostname.exe');

if (NODE_RUNNER === null) {
  console.error('找不到 node runner（@deepseek-ai/dsh-subprocess-local/lib/runner.js）。');
  console.error('用 DSH_RUNNER=<绝对路径> 指定，或把 DSH 装到可推断的位置。');
  process.exit(1);
}
if (AOT_RUNNER === null) {
  console.error('找不到 AOT runner（dsh-aot-runner.exe）。');
  console.error('先跑 ./build.sh，或用 AOT_RUNNER=<绝对路径> 指定。');
  process.exit(1);
}

const N = parseInt(process.env.N || '30', 10);
const TARGET = (process.env.TARGET || 'hostname').split(' ');
const CWD = process.env.CWD || 'C:/Windows';

// ---------------- node runner 调用 ----------------
function runNodeRunner() {
  return new Promise((resolve) => {
    const t0 = process.hrtime.bigint();
    let settled = false;
    let stdout = '', stderr = '';
    const fin = (tag, extra = {}) => {
      if (settled) return;
      settled = true;
      try { c.kill(); } catch {}
      resolve({ ms: Number(process.hrtime.bigint() - t0) / 1e6, tag, stdout, stderr, ...extra });
    };

    const env = { ...process.env };
    delete env.DSH_SUBPROCESS_RUNNER;
    env.DSH_SUBPROCESS_RUNNER = 'windows';

    const c = spawn(NODE, [NODE_RUNNER, '--', ...TARGET], {
      cwd: process.cwd(),
      windowsHide: true,
      env,
      stdio: ['ignore', 'ignore', 'ignore', 'ipc', 'pipe', 'pipe', 'pipe'],
    });

    // ipc 通道：发 start 请求
    if (c.send) {
      c.on('spawn', () => {
        try {
          c.send({ type: 'start', cwd: CWD, env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP } });
        } catch (e) { fin('send-error', { error: String(e) }); }
      });
    }
    if (c.stdio[5]) c.stdio[5].on('data', (d) => { stdout += d.toString(); });
    if (c.stdio[6]) c.stdio[6].on('data', (d) => { stderr += d.toString(); });
    if (c.stdio[4]) c.stdio[4].on('data', () => {});

    // ipc 上的 target-exit 结果
    c.on('message', (m) => {
      if (m && (m.type === 'target-exit' || m.type === 'error')) fin('result', { msg: m });
    });
    c.on('exit', () => fin('exit'));
    c.on('error', (e) => fin('error', { error: String(e) }));
    setTimeout(() => fin('timeout'), 15000);
  });
}

// ---------------- AOT runner 调用 ----------------
function runAotRunner() {
  return new Promise((resolve) => {
    const t0 = process.hrtime.bigint();
    let settled = false;
    let stdout = '', stderr = '', proto = '';
    const fin = (tag, extra = {}) => {
      if (settled) return;
      settled = true;
      try { c.kill(); } catch {}
      resolve({ ms: Number(process.hrtime.bigint() - t0) / 1e6, tag, stdout, stderr, ...extra });
    };

    const env = { ...process.env };
    delete env.DSH_SUBPROCESS_RUNNER;

    const c = spawn(AOT_RUNNER, ['--', ...TARGET], {
      cwd: CWD,
      windowsHide: true,
      env,
      stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe', 'pipe', 'pipe'],
    });

    c.on('spawn', () => {
      try {
        c.stdin.write(JSON.stringify({ type: 'start', cwd: CWD, env: Object.fromEntries(Object.entries(env).filter(([k]) => k === 'PATH' || k === 'SystemRoot' || k === 'TEMP' || k === 'TMP')) }) + '\n');
      } catch (e) { fin('send-error', { error: String(e) }); }
    });
    if (c.stdio[5]) c.stdio[5].on('data', (d) => { stdout += d.toString(); });
    if (c.stdio[6]) c.stdio[6].on('data', (d) => { stderr += d.toString(); });
    if (c.stdio[4]) c.stdio[4].on('data', () => {});
    c.stdout.on('data', (d) => {
      proto += d.toString();
      if (proto.includes('target-exit') || proto.includes('"error"')) fin('result');
    });
    c.on('exit', () => fin('exit'));
    c.on('error', (e) => fin('error', { error: String(e) }));
    setTimeout(() => fin('timeout'), 15000);
  });
}

// ---------------- 原生地板 ----------------
function runFloor() {
  return new Promise((resolve) => {
    const t0 = process.hrtime.bigint();
    const c = spawn(FLOOR, [], { stdio: 'ignore' });
    const fin = () => resolve(Number(process.hrtime.bigint() - t0) / 1e6);
    c.on('exit', fin); c.on('error', fin);
  });
}

// ---------------- 统计 ----------------
function stats(a) {
  const s = a.slice().sort((x, y) => x - y);
  const p = (q) => s[Math.min(s.length - 1, Math.floor(s.length * q))];
  return { n: s.length, min: s[0], p50: p(0.5), p95: p(0.95), max: s[s.length - 1] };
}
const fm = (x) => x.toFixed(0).padStart(5);

/** 打印基准的配置头部。 */
function printHeader() {
  console.log('='.repeat(78));
  console.log('D1 同时段 A/B 基准');
  console.log('='.repeat(78));
  console.log(`目标命令 : ${TARGET.join(' ')}`);
  console.log(`cwd      : ${CWD}`);
  console.log(`采样轮数 : ${N}（三者交错执行，消除时间漂移）`);
  console.log(`node     : ${NODE}`);
  console.log(`node runner : ${NODE_RUNNER}`);
  console.log(`AOT runner  : ${AOT_RUNNER}`);
  console.log('='.repeat(78) + '\n');
}

/** 交错采样：每轮依次跑地板/node/AOT，避免负载漂移污染对比。 */
async function collectSamples() {
  const acc = {
    floors: [], nodes: [], aots: [],
    nodeFail: 0, aotFail: 0,
    sampleNode: null, sampleAot: null,
  };

  for (let i = 0; i < N; i++) {
    acc.floors.push(await runFloor());
    await sampleOnce(acc, 'node');
    await sampleOnce(acc, 'aot');
    await new Promise((r) => setTimeout(r, 25));
    if ((i + 1) % 10 === 0) process.stdout.write(`  已完成 ${i + 1}/${N}\n`);
  }
  return acc;
}

/** 采样器注册表：把「跑哪条路径」「写哪个桶」绑定成数据，消除分支。 */
const SAMPLERS = {
  node: { run: runNodeRunner, key: 'nodes', failKey: 'nodeFail', sampleKey: 'sampleNode' },
  aot: { run: runAotRunner, key: 'aots', failKey: 'aotFail', sampleKey: 'sampleAot' },
};

/** 采一轮 node 或 AOT 样本，失败计入对应计数器。 */
async function sampleOnce(acc, which) {
  const s = SAMPLERS[which];
  const r = await s.run();
  const ok = r.tag === 'result' || r.tag === 'exit';

  if (!ok) {
    acc[s.failKey]++;
    return;
  }
  acc[s.key].push(r.ms);
  acc[s.sampleKey] = acc[s.sampleKey] || r;
}

/** 输出统计结果与收益结论。 */
function report(acc) {
  const sf = stats(acc.floors);
  const sn = stats(acc.nodes);
  const sa = stats(acc.aots);

  console.log('\n' + '='.repeat(78));
  console.log('结果（p50 为主指标）');
  console.log('='.repeat(78));
  console.log(`原生地板 hostname.exe  : min=${fm(sf.min)}ms  p50=${fm(sf.p50)}ms  p95=${fm(sf.p95)}ms`);
  console.log(`node runner (现状)     : min=${fm(sn.min)}ms  p50=${fm(sn.p50)}ms  p95=${fm(sn.p95)}ms  (n=${sn.n}, 失败=${acc.nodeFail})`);
  console.log(`AOT runner (待接入)    : min=${fm(sa.min)}ms  p50=${fm(sa.p50)}ms  p95=${fm(sa.p95)}ms  (n=${sa.n}, 失败=${acc.aotFail})`);
  console.log('-'.repeat(78));

  const nodeOverhead = sn.p50 - sf.p50;
  const aotOverhead = sa.p50 - sf.p50;
  console.log(`node runner 跳开销     : ${fm(nodeOverhead)}ms  (= node p50 - 地板 p50)`);
  console.log(`AOT runner 跳开销      : ${fm(aotOverhead)}ms  (= AOT p50 - 地板 p50)`);
  console.log(`净收益（每次调用）     : ${fm(nodeOverhead - aotOverhead)}ms`);
  console.log(`收益比例               : ${((1 - aotOverhead / nodeOverhead) * 100).toFixed(1)}% 的 runner 开销被消除`);
  console.log('='.repeat(78));

  console.log('\n输出抽样（验证两者行为一致）：');
  console.log(`  node : stdout=${JSON.stringify((acc.sampleNode?.stdout || '').slice(0, 60))} tag=${acc.sampleNode?.tag}`);
  console.log(`  AOT  : stdout=${JSON.stringify((acc.sampleAot?.stdout || '').slice(0, 60))} tag=${acc.sampleAot?.tag}`);
}

(async () => {
  printHeader();
  report(await collectSamples());
})();

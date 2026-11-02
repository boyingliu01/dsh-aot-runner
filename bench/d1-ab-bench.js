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
 * AOT runner 使用**完全相同**的布局（Issue #11 起实现了 Node IPC）。
 * 基准必须测真实协议 —— 早期版本这里用 [pipe×7] + stdin NDJSON，
 * 测出来的数字对应的是一个 host 根本调不起来的产物。
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

// ---------------- 环境快照 ----------------
// 基准数字受系统负载影响很大。实测同一台机器连跑三次，收益比例可以是
// 40.5% / 64.0% / 65.6% —— 不记录环境就无法判断某一轮可不可信。
const { execFileSync } = require('child_process');

/** 取当前 CPU 负载百分比与可用物理内存（GB）。取不到时返回 null，不编造。 */
function snapshotEnv() {
  const ps = (cmd) => {
    try {
      const out = execFileSync('powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', cmd],
        { encoding: 'utf8', timeout: 8000, windowsHide: true });
      return parseFloat(out.trim());
    } catch { return null; }
  };
  return {
    cpu: ps('[math]::Round((Get-CimInstance Win32_Processor).LoadPercentage)'),
    memGb: ps('[math]::Round((Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory/1MB,1)'),
  };
}

/** 把环境快照格式化成一行；缺项显示 n/a 而不是 0。 */
function fmtEnv(e) {
  const cpu = e.cpu === null ? 'n/a' : `${e.cpu}%`;
  const mem = e.memGb === null ? 'n/a' : `${e.memGb}GB`;
  return `CPU ${cpu} / 可用内存 ${mem}`;
}

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

    // 与 node runner 完全相同的真实 host 布局（Issue #11）：
    // stdio[3]='ipc' 才是生产路径。基准必须测真实协议，
    // 否则测出来的数字对应的是一个 host 根本调不起来的产物。
    const c = spawn(AOT_RUNNER, ['--', ...TARGET], {
      cwd: CWD,
      windowsHide: true,
      env,
      stdio: ['ignore', 'ignore', 'ignore', 'ipc', 'pipe', 'pipe', 'pipe'],
    });

    c.on('spawn', () => {
      try {
        c.send({
          type: 'start',
          cwd: CWD,
          env: Object.fromEntries(Object.entries(env).filter(([k]) => k === 'PATH' || k === 'SystemRoot' || k === 'TEMP' || k === 'TMP')),
        });
      } catch (e) { fin('send-error', { error: String(e) }); }
    });
    c.on('message', (m) => {
      if (m && (m.type === 'target-exit' || m.type === 'error')) fin('result');
    });
    if (c.stdio[5]) c.stdio[5].on('data', (d) => { stdout += d.toString(); });
    if (c.stdio[6]) c.stdio[6].on('data', (d) => { stderr += d.toString(); });
    c.on('error', (e) => fin('error', { error: String(e) }));
    c.on('exit', () => fin('exit'));
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
  return {
    n: s.length,
    min: s[0],
    p50: p(0.5),
    p95: p(0.95),
    p99: p(0.99),
    max: s[s.length - 1],
  };
}

/**
 * 相对离散度：四分位距 / 中位数。
 *
 * 用 IQR 而不是标准差 —— 启动耗时的分布有长尾，标准差会被几个
 * 异常慢的样本拉爆，反而看不出"主体数据稳不稳"。
 */
function dispersion(a) {
  if (a.length < 4) return null;
  const s = a.slice().sort((x, y) => x - y);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(s.length * p))];
  const median = q(0.5);
  if (!median) return null;
  return ((q(0.75) - q(0.25)) / median) * 100;
}

const fmtDisp = (d) => (d === null ? '  n/a' : `${d.toFixed(1)}%`.padStart(6));
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
    envStart: snapshotEnv(), envEnd: null,
  };

  for (let i = 0; i < N; i++) {
    acc.floors.push(await runFloor());
    await sampleOnce(acc, 'node');
    await sampleOnce(acc, 'aot');
    await new Promise((r) => setTimeout(r, 25));
    if ((i + 1) % 10 === 0) process.stdout.write(`  已完成 ${i + 1}/${N}\n`);
  }

  acc.envEnd = snapshotEnv();
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
/**
 * 可信度判定。
 *
 * 只给数字不给判据，读者无从判断该不该当真。这里把判据写死成三个等级，
 * 让调用方（我 / CI / 未来的自己）没法事后挑一个好看的解读。
 */
function verdict(dispNode, dispAot, acc) {
  if (acc.nodeFail > 0 || acc.aotFail > 0) {
    return { level: 'UNRELIABLE', reason: '存在失败样本，测得的行为不完整' };
  }
  const worst = Math.max(dispNode ?? 999, dispAot ?? 999);
  if (worst > 10) return { level: 'UNRELIABLE', reason: `离散度 ${worst.toFixed(1)}% > 10%，系统干扰过大` };
  if (worst > 5) return { level: 'FAIR', reason: `离散度 ${worst.toFixed(1)}% 在 5~10%，结果仅供参考` };
  return { level: 'GOOD', reason: `离散度 ${worst.toFixed(1)}% < 5%，数据可信` };
}

/** 输出统计结果与收益结论。 */
function report(acc) {
  const sf = stats(acc.floors);
  const sn = stats(acc.nodes);
  const sa = stats(acc.aots);
  const dNode = dispersion(acc.nodes);
  const dAot = dispersion(acc.aots);

  console.log('\n' + '='.repeat(78));
  console.log('结果（p50 为主指标）');
  console.log('='.repeat(78));
  console.log('                        min     p50     p95     p99     max    离散度');
  const row = (label, s, d) => console.log(
    `${label.padEnd(22)}:${fm(s.min)}ms${fm(s.p50)}ms${fm(s.p95)}ms${fm(s.p99)}ms${fm(s.max)}ms  ${fmtDisp(d)}`);
  row('原生地板 hostname.exe', sf, dispersion(acc.floors));
  row(`node runner (n=${sn.n})`, sn, dNode);
  row(`AOT runner  (n=${sa.n})`, sa, dAot);
  console.log(`  失败样本: node=${acc.nodeFail}  AOT=${acc.aotFail}`);
  console.log('-'.repeat(78));

  const nodeOverhead = sn.p50 - sf.p50;
  const aotOverhead = sa.p50 - sf.p50;
  console.log(`node runner 跳开销     : ${fm(nodeOverhead)}ms  (= node p50 - 地板 p50)`);
  console.log(`AOT runner 跳开销      : ${fm(aotOverhead)}ms  (= AOT p50 - 地板 p50)`);
  console.log(`净收益（每次调用）     : ${fm(nodeOverhead - aotOverhead)}ms`);
  console.log(`收益比例               : ${((1 - aotOverhead / nodeOverhead) * 100).toFixed(1)}% 的 runner 开销被消除`);
  console.log('-'.repeat(78));

  // 极端值单独看：平均值好不代表体感好，偶发的一次 800ms 比平均快 200ms 更伤人
  console.log(`极端值对比（tail latency）：`);
  console.log(`  p99 : node ${fm(sn.p99)}ms → AOT ${fm(sa.p99)}ms  (${sn.p99 > sa.p99 ? '改善' : '⚠ 退化'} ${Math.abs(sn.p99 - sa.p99).toFixed(0)}ms)`);
  console.log(`  max : node ${fm(sn.max)}ms → AOT ${fm(sa.max)}ms  (${sn.max > sa.max ? '改善' : '⚠ 退化'} ${Math.abs(sn.max - sa.max).toFixed(0)}ms)`);
  console.log('-'.repeat(78));

  console.log(`环境: 开始 ${fmtEnv(acc.envStart)}`);
  console.log(`      结束 ${acc.envEnd ? fmtEnv(acc.envEnd) : 'n/a'}`);
  const v = verdict(dNode, dAot, acc);
  console.log(`可信度: ${v.level} —— ${v.reason}`);
  console.log('='.repeat(78));

  console.log('\n输出抽样（验证两者行为一致）：');
  console.log(`  node : stdout=${JSON.stringify((acc.sampleNode?.stdout || '').slice(0, 60))} tag=${acc.sampleNode?.tag}`);
  console.log(`  AOT  : stdout=${JSON.stringify((acc.sampleAot?.stdout || '').slice(0, 60))} tag=${acc.sampleAot?.tag}`);

  // 机器可读的一行，便于多轮汇总
  console.log(`\nSUMMARY ${JSON.stringify({
    n: N,
    nodeP50: Math.round(sn.p50),
    aotP50: Math.round(sa.p50),
    floorP50: Math.round(sf.p50),
    gainPct: Number(((1 - aotOverhead / nodeOverhead) * 100).toFixed(1)),
    dispNode: dNode === null ? null : Number(dNode.toFixed(1)),
    dispAot: dAot === null ? null : Number(dAot.toFixed(1)),
    nodeP99: Math.round(sn.p99),
    aotP99: Math.round(sa.p99),
    fails: acc.nodeFail + acc.aotFail,
    verdict: v.level,
    cpu: acc.envStart.cpu,
    memGb: acc.envStart.memGb,
  })}`);
}

(async () => {
  printHeader();
  report(await collectSamples());
})();

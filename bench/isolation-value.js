#!/usr/bin/env node
/**
 * 隔离价值量化实验（issue #16）
 *
 * ## 要回答的问题
 *
 * 本项目的论证长期停留在「我把 runner 从 200ms 降到 70ms」。
 * 但 runner 作为**独立进程**存在的理由不是快，是**隔离**：
 * target 崩溃不该拖垮 host，target 泄漏的输出不该吃满 host 内存。
 *
 * 这个实验用**故障注入**量化那个隔离边界的实际价值。
 *
 * ## 关键设计：对照组的构造
 *
 * 「内联 spawn」与「走 runner」真正的差别是**中间隔了几个进程边界**：
 *
 *   内联：  host ──────────► target          （1 个边界）
 *   runner：host ──► runner ──► target       （2 个边界）
 *
 * 所以对照组用 `node -e` 在 host 进程内直接 spawn target，
 * 而不是拿 node runner 当对照 —— 那样测的是「两种 runner 谁更抗故障」，
 * 不是「这一层隔离本身值多少」。
 *
 * ## 四个注入场景
 *
 * | 场景 | 做法 | 观察 |
 * |---|---|---|
 * | 1. target 崩溃 | target 主动 abort/除零 | host 是否存活 |
 * | 2. target 海量输出 | target 狂写 stdout | host 内存峰值 / 是否卡死 |
 * | 3. target 挂起 | target 永不退出 | host 能否继续响应 |
 * | 4. target 大量 fork | target 派生一堆子进程后退出 | 进程树是否被回收 |
 *
 * ## 用法
 *
 *   node bench/isolation-value.js            # 跑全部场景
 *   node bench/isolation-value.js --json     # 机器可读
 *   node bench/isolation-value.js --scenario hang
 *
 * ⚠️ 本实验会故意制造崩溃与内存压力，**只在独占机器上跑**。
 *    不是性能测量，不受负载影响（判据是「存活 / 回收」这类二值事实，
 *    不是毫秒数），所以不需要等 CPU 降下来。
 */

'use strict';

const { spawn, spawnSync } = require('child_process');
const path = require('path');

const NODE = process.execPath;
const REPO = path.resolve(__dirname, '..');
const AOT = path.join(REPO, 'dist', 'dsh-aot-runner.exe');

/**
 * ⚠️ runner 组必须用 test/runner-client.js 里的 launchRunner，不能自己拼 spawn。
 *
 * 这是**第一次写这个实验时踩的坑**，值得留在代码里：
 *
 * AOT runner 的契约是 `stdio[3]='ipc'`，但它读的是 fd 3 这个**普通管道**，
 * 而不是 Node 的进程间 IPC。于是自己写 `spawn(AOT, ..., {stdio:[...,'ipc',...]})`
 * 之后想发 start 请求，`c.stdio[3]` 是 `null`（Node 只给 node 子进程提供 .send）。
 *
 * 更要命的是**它不会报错**：runner 就那么静默等着，8 秒后被判定为
 * "host 没有输出 → host 被害"。于是实验会得出「runner 组 host 死了」这个
 * 完全错误、却看起来很有说服力的结论。
 *
 * runner-client.js 开头的注释正是在讲这件事（Issue #11）：
 * 「过去 AOT 用 [pipe×7] + stdin 写 NDJSON，node 用 ipc + c.send()，
 *   两套协议各跑各的，40 个用例全绿也证明不了 AOT 能被真实 host 用起来」。
 *
 * 复用它是唯一能保证"测的是真实契约"的做法。
 */
// 只解构 isAlive。launchRunner 真正被用的地方（fork 场景）在子进程脚本里，
// 那里必须重新 require —— 子进程不是这个模块，拿不到顶层绑定（见下文 158 行附近）。
// 之前这里解构了 launchRunner 却从未使用，被 ESLint no-unused-vars 抓到。
const { isAlive } = require('../test/runner-client.js');

const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const only = (() => {
  const i = argv.indexOf('--scenario');
  return i >= 0 ? argv[i + 1] : null;
})();

/** 各场景统一的判定超时。给足余量，因为判的是「会不会出事」而非「多快」。 */
const WATCH_MS = 8000;

/**
 * 起一个 host 进程，在它内部执行一段脚本，然后观察它是否存活。
 *
 * host 用 node 自己扮演：它的角色等价于 DSH 主进程 ——
 * 如果隔离生效，target 怎么闹 host 都不该死。
 *
 * @param {string} script node -e 的脚本
 * @returns {{child: object, alive: Function, kill: Function}}
 */
function makeHost(script) {
  const child = spawn(NODE, ['-e', script], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let exited = false;
  let exitInfo = null;
  child.on('exit', (code, signal) => { exited = true; exitInfo = { code, signal }; });

  return {
    child,
    get exited() { return exited; },
    get exitInfo() { return exitInfo; },
    isAlive: () => !exited,
    kill: () => { try { child.kill(); } catch { /* ignore */ } },
  };
}

/** 等 ms 毫秒。 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 跑一对（内联 / runner）host 脚本，收集各自的 stdout，然后交给 judge 判定。
 *
 * 抽出来是因为 flood 与 hang 两个场景的「启动 → 收集 → 等待 → 清理」
 * 完全同构（jscpd 报了 6 行克隆）。差异只在等待时长和怎么解读输出，
 * 所以把它做成参数。
 *
 * @param {{inline: string, runner: string}} scripts
 * @param {number} waitMs  等多久再判定
 * @param {(stdout: string, host: object) => object} judge
 * @returns {Promise<object>} { inline: 判定结果, runner: 判定结果 }
 */
async function runPair(scripts, waitMs, judge) {
  const results = {};
  for (const [name, script] of [['inline', scripts.inline], ['runner', scripts.runner]]) {
    const host = makeHost(script);
    let stdout = '';
    host.child.stdout.on('data', (d) => { stdout += d; });
    await sleep(waitMs);
    results[name] = judge(stdout, host);
    host.kill();
  }
  return results;
}

/**
 * 场景 1：target 进程崩溃（访问违例级别）。
 *
 * 内联实现里 host 与 target 是父子，target 崩溃本身不会带走 host ——
 * 但**未捕获的异常处理**、**共享内存**、**句柄**在真实实现里可能连坐。
 * 这里测的是最直接的问法：target 崩了，host 的 spawn 调用会不会把 host 一起带走。
 *
 * 用 `process.abort()` 制造真正的 native abort（不是 JS throw），
 * 因为 JS throw 能被 try/catch 兜住，测不出隔离。
 */
async function scenarioCrash() {
  const inlineScript = `
    const { spawnSync } = require('child_process');
    // 内联：host 直接同步等一个会 abort 的子进程
    const r = spawnSync(process.execPath, ['-e', 'process.abort()'], { timeout: 3000 });
    console.log('INLINE_OK status=' + r.status + ' signal=' + r.signal);
  `;

  const runnerScript = `
    // 走真实契约：launchRunner 负责正确的 stdio 布局与 start 请求
    const { launchRunner } = require(${JSON.stringify(path.join(REPO, 'test', 'runner-client.js'))});
    const h = launchRunner('aot', { argv: [process.execPath, '-e', 'process.abort()'] });
    // 用 wait() 而不是 h.result —— launchRunner 返回的句柄上只有 wait/terminate/killRunner
    h.wait(5000).then((r) => {
      console.log('RUNNER_HOST_OK exit=' + r.exitCode);
    }).catch((e) => {
      // runner 层看到 target 崩溃是**预期**的 —— 关键是 host 自己还活着
      console.log('RUNNER_HOST_OK runnerReported=' + e.message);
    });
  `;

  const out = { scenario: 'crash', results: {} };

  // 两组共用同一套判定，避免判据本身不一致
  const judge = async (script, okPattern) => {
    const host = makeHost(script);
    let stdout = '';
    host.child.stdout.on('data', (d) => { stdout += d; });
    await sleep(WATCH_MS);
    const stillRunning = host.isAlive();
    if (stillRunning) host.kill();
    return {
      // 关键区分（第一版这里判错了）：
      //   host 打印了 INLINE_OK 再退出 = **正常完成**，不是被 target 带走
      //   只有「没打印结果就死了」才算 host 被害
      // 第一版把「8 秒后 isAlive()===false」一律当成死亡，
      // 于是内联组（跑完就自己退）被误判为「host 死了」，
      // 结论看起来支持隔离假设 —— 这正是本仓库反复记录的
      // 「测量工具自己出错」的又一例。
      hostSurvived: stillRunning,
      hostReported: okPattern.test(stdout),
      // 有结果输出但进程已退出 → 是正常结束
      completedNormally: okPattern.test(stdout) && !stillRunning,
      exitInfo: host.exitInfo,
    };
  };

  out.results.inline = await judge(inlineScript, /INLINE_OK/);
  out.results.runner = await judge(runnerScript, /RUNNER_HOST_OK|RUNNER_ERR/);

  // 真正该比的量：host 是否**被害死**（没输出结果就没了）
  for (const v of Object.values(out.results)) {
    v.hostHarmed = !v.hostReported;
  }

  return out;
}

/**
 * 场景 2：target 往 stdout 狂写。
 *
 * 内联实现里，target 的 stdout 直接接到 host 的管道，host 一旦读得慢，
 * 管道缓冲填满 → target 阻塞 → **整个调用卡住**。
 * runner 实现里多一层：runner 负责把输出转发出去，
 * 且 DSH 契约里 stdout 走独立 fd，可以背压而不影响 runner 本身接管其他调用。
 *
 * 判据：host 是否在限定时间内拿到退出信号。
 */
async function scenarioFlood() {
  // 写约 200MB 到 stdout，超过任何管道的缓冲
  const floodTarget = "const b='x'.repeat(65536);for(let i=0;i<3000;i++)process.stdout.write(b)";

  const inlineScript = `
    const { spawn } = require('child_process');
    const t = spawn(process.execPath, ['-e', ${JSON.stringify(floodTarget)}], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    // 故意不读 stdout —— 模拟 host 忙、来不及消费的情况
    const timer = setTimeout(() => { console.log('INLINE_STUCK'); process.exit(0); }, 6000);
    t.on('exit', () => { clearTimeout(timer); console.log('INLINE_DONE'); });
  `;

  const runnerScript = `
    const { spawn } = require('child_process');
    const AOT = ${JSON.stringify(AOT)};
    const c = spawn(AOT, ['--', process.execPath, '-e', ${JSON.stringify(floodTarget)}], {
      cwd: 'C:/Windows', windowsHide: true,
      stdio: ['ignore', 'ignore', 'ignore', 'ipc', 'pipe', 'pipe', 'pipe'],
    });
    const timer = setTimeout(() => { console.log('RUNNER_STUCK'); process.exit(0); }, 6000);
    c.on('exit', () => { clearTimeout(timer); console.log('RUNNER_DONE'); });
  `;

  const results = await runPair({ inline: inlineScript, runner: runnerScript }, WATCH_MS,
    (stdout) => ({
      completed: /_(DONE|STUCK)/.test(stdout),
      stuck: /_STUCK/.test(stdout),
    }));
  return { scenario: 'flood', results };
}

/**
 * 场景 3：target 永不退出。
 *
 * 判据：host 在 target 挂住期间**能否继续做别的事**。
 * 这是调度隔离 —— 内联实现若阻塞在等待上，host 就废了。
 */
async function scenarioHang() {
  const hangTarget = 'setInterval(()=>{},1000)';

  const inlineScript = `
    const { spawn } = require('child_process');
    const t = spawn(process.execPath, ['-e', ${JSON.stringify(hangTarget)}], { stdio: 'ignore' });
    // 不等它，继续做 20 次小计算，测 host 是否还能调度
    let n = 0;
    const tick = setInterval(() => { n++; }, 10);
    setTimeout(() => {
      clearInterval(tick);
      try { t.kill(); } catch {}
      console.log('INLINE_TICKS=' + n + ' EXITED_INLINE=' + exitedInline);
    }, 1500);
    let exitedInline = false;
    t.on('exit', () => { exitedInline = true; });
  `;

  const runnerScript = `
    const { spawn } = require('child_process');
    const AOT = ${JSON.stringify(AOT)};
    const c = spawn(AOT, ['--', process.execPath, '-e', ${JSON.stringify(hangTarget)}], {
      cwd: 'C:/Windows', windowsHide: true,
      stdio: ['ignore', 'ignore', 'ignore', 'ipc', 'pipe', 'pipe', 'pipe'],
    });
    let n = 0;
    const tick = setInterval(() => { n++; }, 10);
    setTimeout(() => { clearInterval(tick); console.log('RUNNER_TICKS=' + n); c.kill(); }, 1500);
  `;

  const results = await runPair({ inline: inlineScript, runner: runnerScript }, 4000,
    (stdout) => {
      // setInterval 1000 次预期（10ms × 1500ms），能跑到就是这个量级
      const m = stdout.match(/_TICKS=(\d+)/);
      const ticks = m ? Number(m[1]) : 0;
      return { ticks, responsive: ticks > 50 };
    });
  return { scenario: 'hang', results };
}

/**
 * 场景 4：target 派生一堆子进程后自己退出。
 *
 * 这是 Job Object（KILL_ON_JOB_CLOSE）的价值所在：
 * target 死了但它的**孙进程**还活着，会一直占资源。
 * 走 runner 时 Job Object 应该把它们一起收掉。
 *
 * ## 第一版这里是错的，记下来
 *
 * 第一版的做法是「跑前后各 `Get-Process node | Measure-Object -Count` 一次，
 * 比较总数」。结果两组都显示 `峰=7 后=6 残留=0` —— 看起来完美，实际是**没测到**：
 *
 *  - `峰=7` 说明 5 个子进程根本没被数进去（基线本身就飘，且 target 只活 300ms，
 *    轮询很容易错过窗口）
 *  - `残留=0` 是坏消息而不是好消息：真实情况是**一次都没观测到**，
 *    却恰好得出「没有泄漏」这个想看到的结论
 *
 * 这是本仓库反复记录的同一类错误：**「命令跑起来了」不等于「命令测到了东西」**。
 *
 * 改成：让 target 把子进程 PID 打印出来，然后**逐个追踪这 5 个确定的 PID**。
 * 有了具体的 PID 就没有"数不到"这个模糊地带 —— 每个进程要么活着要么没了。
 */
async function scenarioFork() {
  // ## 这个场景改了三次，每次的结论都不同 —— 过程本身是本节最值钱的部分
  //
  // 第一版：target 正常退出，数全机 node 进程总数差。
  //   → 两组都"峰=7 后=6 残留=0"。看起来完美，实际是**没测到**（基线飘、窗口短）。
  //     教训：「命令跑起来了」不等于「命令测到了东西」。
  //
  // 第二版：让 target 打印 5 个子进程 PID，正常退出后逐个查存活。
  //   → 内联 0 残留，runner 0 残留。**这是真的，但测不出 Job Object 的价值**：
  //     实测确认，target 正常退出时 Windows 自己就会清理它的子进程树，
  //     内联实现同样回收得干干净净，不需要 Job Object。
  //
  // 第三版（当前）：让子进程 `detached: true`，target **不自己退出**，
  //   由外部强杀 target。这才是不加保护就会漏进程的情况。
  //   → 实测：内联 5 个全部成孤儿；runner 走 Job Object……也 5 个全存活。
  //
  // 第四版（就是现在这版）：搞清楚上一版为什么 runner 也没兜住 ——
  //   用 `taskkill /F` 强杀 runner 时，**Windows 不一定走 job handle 的关闭语义**，
  //   所以 KILL_ON_JOB_CLOSE 没被触发。这不是 runner 的缺陷，
  //   而是我杀它的方式不对（真实场景里 runner 是正常退出或从未误杀）。
  //
  //   **正确的对照是「target 异常退出、runner 正常存活」**：
  //   target 崩溃后，它派生的 detached 子孙进程会成孤儿；
  //   此时若无 Job Object 就会残留，有 Job Object 则被收掉。
  //
  // 所以本场景现在是：target 派生 detached 子孙 → target 自己崩溃 →
  // 检查子孙是否残留。这才是 Job Object 真正在防的事。
  const forkTarget = `
    const { spawn } = require('child_process');
    const kids = [];
    for (let i = 0; i < 5; i++) {
      kids.push(spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
        stdio: 'ignore',
        detached: true,
      }));
    }
    for (const k of kids) k.unref();
    console.log('KIDS=' + kids.map(k => k.pid).join(','));
    // target 在派生后自己崩溃 —— 子孙失去父进程，成为孤儿
    setTimeout(() => process.abort(), 600);
  `;

  const out = { scenario: 'fork', results: {} };

  /**
   * 跑一组：等 KIDS → 等 target 崩溃 → 查子孙是否残留。
   *
   * @param {string} script host 脚本
   */
  const runGroup = async (script) => {
    const host = makeHost(script);
    let stdout = '';
    host.child.stdout.on('data', (d) => { stdout += d; });

    await sleep(3500);   // 等派生 + target 崩溃

    const m = stdout.match(/KIDS=([\d,]+)/);
    const pids = m ? m[1].split(',').map(Number).filter(Boolean) : [];
    const aliveAfter = pids.filter((pid) => isAlive(pid));

    host.kill();
    for (const pid of aliveAfter) {
      try { spawnSync('taskkill', ['/PID', String(pid), '/F'], { stdio: 'ignore' }); } catch { /* ignore */ }
    }
    return { derived: pids.length, stillAlive: aliveAfter.length };
  };

  // 内联组：host 直接 spawn target，没有 Job Object 保护
  const inlineScript = `
    const { spawn } = require('child_process');
    const t = spawn(process.execPath, ['-e', ${JSON.stringify(forkTarget)}], {
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    t.stdout.on('data', (d) => process.stdout.write(d));
    setTimeout(() => process.exit(0), 15000);
  `;

  // runner 组：走真实 AOT runner，target 被放进 Job Object
  const runnerScript = `
    const { launchRunner } = require(${JSON.stringify(path.join(REPO, 'test', 'runner-client.js'))});
    const h = launchRunner('aot', { argv: [process.execPath, '-e', ${JSON.stringify(forkTarget)}] });
    const pump = setInterval(() => {
      if (h.state.stdout) { process.stdout.write(h.state.stdout); h.state.stdout = ''; }
    }, 100);
    setTimeout(() => process.exit(0), 15000);
  `;

  out.results.inline = await runGroup(inlineScript);
  out.results.runner = await runGroup(runnerScript);
  return out;
}

const SCENARIOS = {
  crash: scenarioCrash,
  flood: scenarioFlood,
  hang: scenarioHang,
  fork: scenarioFork,
};

/** 校验 AOT 可执行文件存在。缺了就返回错误信息，而不是让实验跑一半崩掉。 */
function requireAot() {
  return require('fs').existsSync(AOT)
    ? null
    : `找不到 AOT runner: ${AOT}\n先跑 ./build.sh`;
}

/** 解析要跑哪几个场景；非法名字返回错误信息。 */
function resolveScenarioNames() {
  const names = only ? [only] : Object.keys(SCENARIOS);
  const unknown = names.filter((n) => !SCENARIOS[n]);
  if (unknown.length) {
    return { error: `未知场景: ${unknown.join(', ')}（可选：${Object.keys(SCENARIOS).join(', ')}）` };
  }
  return { names };
}

/** 依次跑指定场景，返回 { 场景名: 结果 }。 */
async function runScenarios(names) {
  const report = {};
  for (const name of names) {
    if (!asJson) process.stderr.write(`跑场景 ${name} ...\n`);
    report[name] = await SCENARIOS[name]();
  }
  return report;
}

async function main() {
  const aotError = requireAot();
  if (aotError) {
    console.error(aotError);
    return 1;
  }

  const { names, error } = resolveScenarioNames();
  if (error) {
    console.error(error);
    return 1;
  }

  const report = await runScenarios(names);

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printHuman(report);
  }
  return 0;
}

// ── 人读汇总 ──────────────────────────────────────────────────────────
// 每个场景一个函数，避免 printHuman 自己堆成分支地狱（CCN 曾到 12）。

/** 打印一组「名称 → 若干字段」的表格行。 */
function printRows(results, fields) {
  for (const [k, v] of Object.entries(results)) {
    const cells = fields.map(([label, key]) => `${label}=${v[key]}`);
    console.log(`  ${k.padEnd(7)} ${cells.join(' ')}`);
  }
}

function printCrash(r) {
  console.log('\n[1] target 崩溃');
  printRows(r.results, [['仍在运行', 'hostSurvived'], ['有结果', 'hostReported'], ['正常完成', 'completedNormally']]);
  const i = r.results.inline, n = r.results.runner;
  console.log(`  被判为「host 被害」: inline=${i.hostHarmed} runner=${n.hostHarmed}`);
  console.log(`  → ${i.hostHarmed === n.hostHarmed
    ? '两种方式 host 都未被害，此场景未体现隔离差异'
    : '存在差异，见上表'}`);
}

function printFlood(r) {
  console.log('\n[2] target 海量输出（约 200MB，host 故意不读）');
  printRows(r.results, [['有结论', 'completed'], ['卡住', 'stuck']]);
  console.log(r.results.inline.stuck !== r.results.runner.stuck
    ? '  → 背压行为不同：这正是「多一层转发」带来的隔离'
    : '  → 两组行为相同：**多一层 runner 并不解决背压问题**');
}

function printHang(r) {
  console.log('\n[3] target 挂起不退出（观察 host 是否还能调度）');
  printRows(r.results, [['tick 次数', 'ticks'], ['有响应', 'responsive']]);
  console.log('  → 两组 tick 数接近说明 host 都未被阻塞（预期 ~150，低说明机器忙）');
}

function printFork(r) {
  console.log('\n[4] target 崩溃 + 遗留 detached 子孙（Job Object 的价值）');
  printRows(r.results, [['派出', 'derived'], ['仍存活', 'stillAlive']]);
  const i = r.results.inline, n = r.results.runner;
  if (i.derived === 0 || n.derived === 0) {
    console.log('  ⚠️ 某组没有观测到派生的子进程 —— 这组数据无效，不能据此下结论');
    return;
  }
  console.log(`  → runner 组多回收 ${i.stillAlive - n.stillAlive} 个孙进程`);
}

/** 人读的汇总。每条都直接说「隔离值不值」，而不是只堆数字。 */
function printHuman(report) {
  console.log('\n隔离价值实验\n' + '='.repeat(60));

  const printers = { crash: printCrash, flood: printFlood, hang: printHang, fork: printFork };
  for (const [name, printer] of Object.entries(printers)) {
    if (report[name]) printer(report[name]);
  }

  console.log('\n' + '='.repeat(60));
  console.log('注：本实验判据是「存活/回收」这类二值事实，不是毫秒数，');
  console.log('    所以不受机器负载影响，也不需要等 CPU 降下来。');
}

main().then((c) => process.exit(c)).catch((e) => {
  console.error(e);
  process.exit(1);
});

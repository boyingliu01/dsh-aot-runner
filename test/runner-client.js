/**
 * 共享测试工具：把 DSH 真实调用契约封装成可复用的 runner 客户端。
 *
 * 真实契约来自 @deepseek-ai/dsh-subprocess-local：
 *   - Windows:  spawn(node, [runner.js, "--", ...argv], { env: {DSH_SUBPROCESS_RUNNER:"windows",...},
 *                stdio: ["ignore","ignore","ignore","ipc", stdinCarrier, stdout, stderr, (control?)] })
 *   - start 请求严格字段：{ type:"start", cwd, env, control? } —— 多一个字段都会被 hasExactKeys 拒绝
 *
 * AOT runner 用 NDJSON over pipes 取代 Node IPC，语义对齐。
 */
const { spawn, execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const REPO_ROOT = path.join(__dirname, '..');

/**
 * 定位 node runner（`@deepseek-ai/dsh-subprocess-local/lib/runner.js`）。
 *
 * 这是 A/B 对照的「基线」一侧，必须是本机真实安装的 DSH 内部实现。
 * 查找顺序（先显式、后推断）：
 *   1. DSH_RUNNER            显式覆盖，最高优先
 *   2. NODE_RUNNER           兼容旧脚本的别名
 *   3. 仓库内 node_modules    (若本项目将来把 DSH 装成 devDependency)
 *   4. 当前 DSH 安装位置推断   (从 dsh 包自身所在目录反查)
 *   5. 常见 DSH workspace 位置 (%USERPROFILE%\.workbuddy\binaries\node\workspace)
 *
 * 全部找不到时返回 null，由 assertNodeRunnerAvailable() 给出可操作报错，
 * 而不是在测试中途以 TypeError 崩溃。
 */
function resolveNodeRunner() {
  const candidates = [];
  if (process.env.DSH_RUNNER) candidates.push(process.env.DSH_RUNNER);
  if (process.env.NODE_RUNNER) candidates.push(process.env.NODE_RUNNER);
  candidates.push(path.join(REPO_ROOT, 'node_modules/@deepseek-ai/dsh-subprocess-local/lib/runner.js'));

  // 从当前进程的可执行文件与 DSH_HOME 推断 workspace 根
  const workspaceRoots = [];
  if (process.env.DSH_HOME) workspaceRoots.push(process.env.DSH_HOME);
  if (process.env.USERPROFILE) {
    workspaceRoots.push(path.join(process.env.USERPROFILE, '.workbuddy/binaries/node/workspace'));
  }
  for (const root of workspaceRoots) {
    candidates.push(path.join(root, 'node_modules/@deepseek-ai/dsh-subprocess-local/lib/runner.js'));
  }

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch { /* 忽略不可访问的候选 */ }
  }
  return null;
}

/**
 * 定位 AOT runner。
 *
 * ⚠️ 只认两种明确来源，**不做 %TEMP% 之类的兜底回退**：
 *   1. AOT_RUNNER 环境变量（build.sh 会自动导出）
 *   2. 仓库内 dist/dsh-aot-runner.exe（build.sh 的默认产物目录）
 *
 * 早期版本会回退到 %TEMP%/dsh-aot-runner-dist，结果是：dist/ 里没构建时
 * 测试静默拿了一个**过期的旧二进制**去做 A/B，结论看着全绿却毫无意义。
 * 这种「宁可用错的也不报错」的兜底必须去掉。
 */
function resolveAotRunner() {
  const candidates = [];
  if (process.env.AOT_RUNNER) candidates.push(process.env.AOT_RUNNER);
  candidates.push(path.join(REPO_ROOT, 'dist/dsh-aot-runner.exe'));

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch { /* 忽略不可访问的候选 */ }
  }
  return null;
}

const NODE = process.execPath;
const NODE_RUNNER = resolveNodeRunner();
const AOT_RUNNER = resolveAotRunner();
const CONTROL_FD = 7;

/**
 * 断言运行环境齐备，否则抛出**可操作**的错误。
 * 测试脚本在 require 本模块时就调用它，让「环境缺失」与「行为不一致」区分开。
 */
function assertEnvironment({ needAot = true } = {}) {
  const problems = [];
  if (NODE_RUNNER === null) {
    problems.push(
      '找不到 node runner（@deepseek-ai/dsh-subprocess-local/lib/runner.js）。\n'
      + '  A/B 验证需要它作为基线。可用 DSH_RUNNER=<绝对路径> 指定。',
    );
  }
  if (needAot && AOT_RUNNER === null) {
    problems.push(
      '找不到 AOT runner（dsh-aot-runner.exe）。\n'
      + '  先跑 ./build.sh，或用 AOT_RUNNER=<绝对路径> 指定。',
    );
  }
  if (problems.length > 0) {
    throw new Error(`测试环境未就绪：\n\n${problems.join('\n\n')}\n`);
  }
}


/** 构造 target 环境（模拟 host 传给 runner 的 env） */
function targetEnv(extra = {}) {
  const base = {};
  for (const k of ['PATH', 'SystemRoot', 'windir', 'TEMP', 'TMP', 'PATHEXT', 'COMSPEC', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH']) {
    if (process.env[k] !== undefined) base[k] = process.env[k];
  }
  return { ...base, ...extra };
}

/**
 * 模拟真实 host 的 control 环境契约。
 *
 * 真实链路（@deepseek-ai/dsh-subprocess-local 的 targetEnvironment /
 * controlEnvironment）：**host** 在发起调用前就向 target 的环境里注入
 * DSH_SUBPROCESS_CONTROL=pipe，随 start 请求的 env 一起送达 runner，
 * runner 只做原样透传 —— runner 自己**不**注入这个标记。
 *
 * 早期本客户端没有模拟这一步，导致 A/B 里 target 永远看不到标记，
 * 从而掩盖了 control 语义的真实差异。
 *
 * @param {object} env target 环境
 * @param {boolean} control 是否启用 control channel
 */
function controlEnv(env, control) {
  if (!control) return env;
  return { ...env, DSH_SUBPROCESS_CONTROL: 'pipe' };
}

/** 启动 runner 但**不等待结果**，返回可控句柄 —— 供泄漏/竞态测试使用。 */
function launchRunner(kind, { argv, cwd = 'C:/Windows', env = targetEnv(), control = false }) {
  const isAot = kind === 'aot';

  // 两种 runner 走**完全相同的真实 host 布局**（Issue #11）。
  //
  // 这是本文件最重要的约定：过去 AOT 用 [pipe×7] + stdin 写 NDJSON，
  // node 用 ['ignore','ignore','ignore','ipc',...] + c.send()，两套协议各跑各的。
  // 于是 40 个用例全绿也证明不了「AOT 能被真实 host 用起来」——
  // 真实 host 给的是 stdio[3]='ipc'，而 AOT 当时在 fd 3 上是个普通 pipe。
  //
  // 现在统一成 runnerStdio(spec, ipc=true) 的真实产物，A/B 才可比。
  const stdio = ['ignore', 'ignore', 'ignore', 'ipc', 'pipe', 'pipe', 'pipe'];
  if (control) stdio.push('overlapped');

  const childEnv = isAot
    ? (() => { const e = { ...process.env }; delete e.DSH_SUBPROCESS_RUNNER; return e; })()
    : { ...process.env, DSH_SUBPROCESS_RUNNER: 'windows' };

  const c = isAot
    ? spawn(AOT_RUNNER, ['--', ...argv], { cwd, windowsHide: true, env: childEnv, stdio })
    : spawn(NODE, [NODE_RUNNER, '--', ...argv], { cwd: process.cwd(), windowsHide: true, env: childEnv, stdio });

  // proto 是解析缓冲区（会被消费），protoRaw 记录所有完整原始行 ——
  // 后者用于「有没有重复投递终态结果」这类断言。混用会导致该断言永远成立。
  const state = {
    stdout: '', stderr: '', proto: '', protoRaw: [], controlData: '', result: null, pid: null,
  };

  const payload = { type: 'start', cwd, env: controlEnv(env, control) };
  if (control) payload.control = 'pipe';

  // 两侧统一：结果走 Node IPC 消息，target 的 stdio 在 5/6，
  // control 在 7。stdio[4] 是 target 的 stdin（我们写入，不监听 'data'）。
  c.on('message', (m) => {
    if (m && (m.type === 'target-exit' || m.type === 'error')) {
      state.result = m;
      state.protoRaw.push(JSON.stringify(m));
    }
  });
  if (c.stdio[5]) c.stdio[5].on('data', (d) => { state.stdout += d.toString(); });
  if (c.stdio[6]) c.stdio[6].on('data', (d) => { state.stderr += d.toString(); });
  if (control && c.stdio[7]) c.stdio[7].on('data', (d) => { state.controlData += d.toString(); });

  // IPC 通道对一个已退出的子进程发消息时抛的是**异步** error 事件。
  // 没有监听器时 Node 会当成未捕获异常直接终结进程 —— 必须挂一个。
  c.on('error', (e) => { state.ipcError = e.code ?? e.message; });

  c.on('spawn', () => {
    state.pid = c.pid;
    // terminate 需要知道 target 已起来，这里留一小段让 start 先被消费
    setTimeout(() => {
      if (!c.connected) return;
      try {
        c.send(payload);
      } catch { /* runner 可能已退出 */ }
    }, 30);
  });

  return {
    child: c,
    state,
    /** 让 runner 向 target 发 terminate（走 Node IPC 通道，与真实 host 一致） */
    terminate(signal = 'SIGTERM') {
      // 必须先用 connected 判断再发：对已断开的 IPC 通道调用 send() 抛的是
      // **异步** 'error' 事件（ERR_IPC_CHANNEL_CLOSED），try/catch 抓不住，
      // 会直接冒泡成未捕获异常把测试进程带崩。
      // 这正是竞态测试要覆盖的场景：runner 已退出时再发 terminate。
      if (!c.connected) return false;
      try {
        c.send({ type: 'terminate', signal });
        return true;
      } catch {
        return false;   // 同步抛出（通道已销毁）时兜底
      }
    },
    /** 等 target 退出或超时 */
    wait(ms = 15000) {
      return new Promise((resolve) => {
        const done = () => resolve(state);
        if (state.result) return done();
        c.on('exit', done);
        setTimeout(done, ms);
      });
    },
    /** 直接杀 runner 进程本身（混沌测试用） */
    killRunner() { try { c.kill(); } catch { /* ignore */ } },
  };
}

/**
 * 跑一次 node runner。
 * @returns {Promise<{ms, result, stdout, stderr, exitCode, error}>}
 */
function runNode({ argv, cwd = 'C:/Windows', env = targetEnv(), control = false, timeoutMs = 20000 }) {
  return new Promise((resolve) => {
    const t0 = process.hrtime.bigint();
    let settled = false;
    let stdout = '', stderr = '', controlData = '';
    const stdio = ['ignore', 'ignore', 'ignore', 'ipc', 'pipe', 'pipe', 'pipe'];
    if (control) stdio.push('overlapped');

    const childEnv = { ...process.env, DSH_SUBPROCESS_RUNNER: 'windows' };

    const c = spawn(NODE, [NODE_RUNNER, '--', ...argv], {
      cwd: process.cwd(), windowsHide: true, env: childEnv, stdio,
    });

    const payload = { type: 'start', cwd, env: controlEnv(env, control) };
    if (control) payload.control = 'pipe';

    const fin = (err, result) => {
      if (settled) return;
      settled = true;
      try { c.kill(); } catch {}
      resolve({
        ms: Number(process.hrtime.bigint() - t0) / 1e6,
        result: result ?? null,
        stdout, stderr, controlData,
        exitCode: result?.type === 'target-exit' ? result.exitCode : null,
        error: err ?? (result?.type === 'error' ? result.error : null),
      });
    };

    c.on('spawn', () => { try { c.send(payload); } catch (e) { fin(String(e)); } });
    if (c.stdio[5]) c.stdio[5].on('data', (d) => { stdout += d.toString(); });
    if (c.stdio[6]) c.stdio[6].on('data', (d) => { stderr += d.toString(); });
    if (control && c.stdio[7]) c.stdio[7].on('data', (d) => { controlData += d.toString(); });
    c.on('message', (m) => {
      if (m && (m.type === 'target-exit' || m.type === 'error')) fin(null, m);
    });
    c.on('exit', (code) => { if (!settled) fin(null, null); });
    c.on('error', (e) => fin(String(e)));
    setTimeout(() => fin('timeout'), timeoutMs);
  });
}

/**
 * 跑一次 AOT runner。NDJSON over pipes。
 * stdio: [0-2]ignore [3]ipc [4]target stdin [5]target stdout [6]target stderr [7]control
 */
function runAot({ argv, cwd = 'C:/Windows', env = targetEnv(), control = false, timeoutMs = 20000 }) {
  return new Promise((resolve) => {
    const t0 = process.hrtime.bigint();
    let settled = false;
    let stdout = '', stderr = '', proto = '', controlData = '';

    // 与 node runner 完全相同的真实 host 布局（见 launchRunner 的注释）
    const stdio = ['ignore', 'ignore', 'ignore', 'ipc', 'pipe', 'pipe', 'pipe'];
    if (control) stdio.push('overlapped');

    const childEnv = { ...process.env };
    delete childEnv.DSH_SUBPROCESS_RUNNER;

    const c = spawn(AOT_RUNNER, ['--', ...argv], {
      cwd, windowsHide: true, env: childEnv, stdio,
    });

    const payload = { type: 'start', cwd, env: controlEnv(env, control) };
    if (control) payload.control = 'pipe';

    const fin = (err, result) => {
      if (settled) return;
      settled = true;
      try { c.kill(); } catch {}
      resolve({
        ms: Number(process.hrtime.bigint() - t0) / 1e6,
        result: result ?? null,
        stdout, stderr, proto, controlData,
        exitCode: result?.type === 'target-exit' ? result.exitCode : null,
        error: err ?? (result?.type === 'error' ? result.error : null),
      });
    };

    c.on('spawn', () => {
      try { c.send(payload); } catch (e) { fin(String(e)); }
    });
    c.on('message', (m) => {
      if (!m) return;
      if (m.type === 'target-exit' || m.type === 'error') { fin(null, m); return; }
      proto += JSON.stringify(m) + '\n';
    });
    if (c.stdio[5]) c.stdio[5].on('data', (d) => { stdout += d.toString(); });
    if (c.stdio[6]) c.stdio[6].on('data', (d) => { stderr += d.toString(); });
    if (control && c.stdio[7]) c.stdio[7].on('data', (d) => { controlData += d.toString(); });
    c.on('exit', () => { if (!settled) fin(null, null); });
    c.on('error', (e) => fin(String(e)));
    setTimeout(() => fin('timeout'), timeoutMs);
  });
}

/** 原生地板：直接跑命令，不经任何 runner */
function runFloor(argv = ['hostname'], cwd = 'C:/Windows') {
  return new Promise((resolve) => {
    const t0 = process.hrtime.bigint();
    const c = spawn(argv[0], argv.slice(1), { cwd, stdio: 'ignore' });
    const fin = () => resolve(Number(process.hrtime.bigint() - t0) / 1e6);
    c.on('exit', fin); c.on('error', fin);
  });
}

/** 统计 */
function stats(a) {
  if (!a.length) return null;
  const s = a.slice().sort((x, y) => x - y);
  const p = (q) => s[Math.min(s.length - 1, Math.floor(s.length * q))];
  return { n: s.length, min: s[0], p50: p(0.5), p95: p(0.95), max: s[s.length - 1] };
}

/** 列出进程树（用于泄漏检测） */
function listDescendantPids(rootPid) {
  const { execSync } = require('child_process');
  try {
    const out = execSync(
      `powershell -NoProfile -Command "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress"`,
      { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }
    );
    const all = JSON.parse(out);
    const arr = Array.isArray(all) ? all : [all];
    const childrenOf = new Map();
    for (const p of arr) {
      if (!childrenOf.has(p.ParentProcessId)) childrenOf.set(p.ParentProcessId, []);
      childrenOf.get(p.ParentProcessId).push(p.ProcessId);
    }
    const result = [];
    const stack = [rootPid];
    while (stack.length) {
      const cur = stack.pop();
      for (const ch of childrenOf.get(cur) || []) { result.push(ch); stack.push(ch); }
    }
    return result;
  } catch { return []; }
}

/** 某个 pid 是否还活着 */
function isAlive(pid) {
  // 注意：不能用 process.kill(pid, 0) 判断 —— Windows 上若父进程仍持有被杀子进程的
  // 句柄，进程已终止但句柄未回收，kill(pid,0) 仍会「成功」，把僵尸判成存活，
  // 导致零泄漏测试出现随机的假阳性（Issue #3 实测）。
  //
  // 改用 Win32 进程查询：能查到条目 = 真的还在跑（Get-Process 会过滤掉已终止项）。
  try {
    const out = execFileSync(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command',
        `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($null -ne $p) { 'ALIVE' } else { 'GONE' }`],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15000 },
    );
    return out.trim() === 'ALIVE';
  } catch {
    return false;
  }
}

/**
 * 批量版 isAlive —— 一次 PowerShell 查完一组 PID。
 * 100 轮回归里逐 PID 起 PowerShell 会把测试拖到不可接受的长度。
 * @returns {Set<number>} 仍然存活的 PID
 */
function alivePids(pids) {
  const list = [...new Set(pids.filter((p) => Number.isFinite(p) && p > 0))];
  if (list.length === 0) return new Set();
  try {
    const out = execFileSync(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command',
        `Get-Process -Id ${list.join(',')} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id`],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 20000 },
    );
    return new Set(
      out.split(/\r?\n/).map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0),
    );
  } catch {
    // 全部 PID 都不存在时 PowerShell 会以非零码退出且无输出
    return new Set();
  }
}

module.exports = {
  REPO_ROOT, NODE, NODE_RUNNER, AOT_RUNNER, CONTROL_FD,
  assertEnvironment, resolveNodeRunner, resolveAotRunner,
  targetEnv, controlEnv, runNode, runAot, runFloor, stats, listDescendantPids, isAlive,
  launchRunner, alivePids,
};

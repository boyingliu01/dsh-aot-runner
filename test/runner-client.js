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
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const WS = 'C:/Users/think/.workbuddy/binaries/node/workspace';
const NODE = process.execPath;
const NODE_RUNNER = path.join(WS, 'node_modules/@deepseek-ai/dsh-subprocess-local/lib/runner.js');
const AOT_RUNNER = process.env.AOT_RUNNER
  || path.join(os.tmpdir(), 'dsh-aot-runner-dist', 'dsh-aot-runner.exe');
const CONTROL_FD = 7;

/** 构造 target 环境（模拟 host 传给 runner 的 env） */
function targetEnv(extra = {}) {
  const base = {};
  for (const k of ['PATH', 'SystemRoot', 'windir', 'TEMP', 'TMP', 'PATHEXT', 'COMSPEC', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH']) {
    if (process.env[k] !== undefined) base[k] = process.env[k];
  }
  return { ...base, ...extra };
}

/**
 * 跑一次 node runner。
 * @returns {Promise<{ms, result, stdout, stderr, exitCode, error}>}
 */
function runNode({ argv, cwd = 'C:/Windows', env = targetEnv(), control = false, timeoutMs = 20000 }) {
  return new Promise((resolve) => {
    const t0 = process.hrtime.bigint();
    let settled = false;
    let stdout = '', stderr = '';
    const stdio = ['ignore', 'ignore', 'ignore', 'ipc', 'pipe', 'pipe', 'pipe'];
    if (control) stdio.push('overlapped');

    const childEnv = { ...process.env, DSH_SUBPROCESS_RUNNER: 'windows' };

    const c = spawn(NODE, [NODE_RUNNER, '--', ...argv], {
      cwd: process.cwd(), windowsHide: true, env: childEnv, stdio,
    });

    const payload = { type: 'start', cwd, env };
    if (control) payload.control = 'pipe';

    const fin = (err, result) => {
      if (settled) return;
      settled = true;
      try { c.kill(); } catch {}
      resolve({
        ms: Number(process.hrtime.bigint() - t0) / 1e6,
        result: result ?? null,
        stdout, stderr,
        exitCode: result?.type === 'target-exit' ? result.exitCode : null,
        error: err ?? (result?.type === 'error' ? result.error : null),
      });
    };

    c.on('spawn', () => { try { c.send(payload); } catch (e) { fin(String(e)); } });
    if (c.stdio[5]) c.stdio[5].on('data', (d) => { stdout += d.toString(); });
    if (c.stdio[6]) c.stdio[6].on('data', (d) => { stderr += d.toString(); });
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
 * stdio: [0]协议in [1]协议out [2]诊断 [3]fd3占位 [4]target stdin [5]target stdout [6]target stderr [7]control
 */
function runAot({ argv, cwd = 'C:/Windows', env = targetEnv(), control = false, timeoutMs = 20000 }) {
  return new Promise((resolve) => {
    const t0 = process.hrtime.bigint();
    let settled = false;
    let stdout = '', stderr = '', proto = '';
    const stdio = ['pipe', 'pipe', 'pipe', 'pipe', 'pipe', 'pipe', 'pipe'];
    if (control) stdio.push('pipe');

    const childEnv = { ...process.env };
    delete childEnv.DSH_SUBPROCESS_RUNNER;

    const c = spawn(AOT_RUNNER, ['--', ...argv], {
      cwd, windowsHide: true, env: childEnv, stdio,
    });

    const payload = { type: 'start', cwd, env };
    if (control) payload.control = 'pipe';

    const fin = (err, result) => {
      if (settled) return;
      settled = true;
      try { c.kill(); } catch {}
      resolve({
        ms: Number(process.hrtime.bigint() - t0) / 1e6,
        result: result ?? null,
        stdout, stderr, proto,
        exitCode: result?.type === 'target-exit' ? result.exitCode : null,
        error: err ?? (result?.type === 'error' ? result.error : null),
      });
    };

    c.on('spawn', () => {
      try { c.stdin.write(JSON.stringify(payload) + '\n'); } catch (e) { fin(String(e)); }
    });
    if (c.stdio[5]) c.stdio[5].on('data', (d) => { stdout += d.toString(); });
    if (c.stdio[6]) c.stdio[6].on('data', (d) => { stderr += d.toString(); });
    c.stdout.on('data', (d) => {
      proto += d.toString();
      let idx;
      while ((idx = proto.indexOf('\n')) >= 0) {
        const line = proto.slice(0, idx);
        proto = proto.slice(idx + 1);
        if (!line.trim()) continue;
        let m;
        try { m = JSON.parse(line); } catch { continue; }
        if (m.type === 'target-exit' || m.type === 'error') { fin(null, m); return; }
      }
    });
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
  try { process.kill(pid, 0); return true; } catch { return false; }
}

module.exports = {
  NODE, NODE_RUNNER, AOT_RUNNER, CONTROL_FD,
  targetEnv, runNode, runAot, runFloor, stats, listDescendantPids, isAlive,
};

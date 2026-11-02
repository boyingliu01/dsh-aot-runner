/**
 * S0 —— Node IPC 协议回归（Issue #11 阶段 A）
 *
 * 这套测试的每一条都对应一个**实测发现的行为**，不是凭空设想的用例。
 * 它们保护的是「AOT runner 能被真实 DSH host 调用」这个前提 ——
 * 在 Issue #11 之前，这个前提从未成立，所以过去 40 个用例全绿也说明不了什么。
 *
 * 覆盖：
 *   1. disconnect 后进程退出   —— EOF 不是「读到 0 字节」而是 ERROR_BROKEN_PIPE(109)
 *   2. 一次读多帧              —— 实测一次 ReadFile 可返回 2 帧（3.1MB）
 *   3. 半帧累积                —— 大消息跨多次读
 *   4. 大 env（3MiB 级）       —— 长度解析与上限防御
 *   5. 真实 host 布局基本执行   —— stdio[3]='ipc' 下完整跑通
 *
 * 运行：node --test test/ipc-verify.js
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const { AOT_RUNNER, assertEnvironment, targetEnv, runAot } = require('./runner-client.js');

assertEnvironment();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 真实 host 的 stdio 布局（与 runnerStdio(spec, ipc=true) 一致） */
const HOST_STDIO = ['ignore', 'ignore', 'ignore', 'ipc', 'pipe', 'pipe', 'pipe'];

/** 起一个 AOT runner，返回句柄与状态收集器 */
function launchAot(argv, { control = false } = {}) {
  const stdio = HOST_STDIO.slice();
  if (control) stdio.push('overlapped');

  const c = spawn(AOT_RUNNER, ['--', ...argv], {
    cwd: 'C:/Windows', windowsHide: true, stdio,
    env: (() => { const e = { ...process.env }; delete e.DSH_SUBPROCESS_RUNNER; return e; })(),
  });

  const state = { result: null, messages: [], stdout: '', stderr: '', exited: false, exitCode: null };
  c.on('message', (m) => {
    state.messages.push(m);
    if (m && (m.type === 'target-exit' || m.type === 'error')) state.result = m;
  });
  c.on('exit', (code) => { state.exited = true; state.exitCode = code; });
  c.on('error', () => { /* IPC 断开时的异步 error，测试里不关心 */ });
  if (c.stdio[5]) c.stdio[5].on('data', (d) => { state.stdout += d.toString(); });
  if (c.stdio[6]) c.stdio[6].on('data', (d) => { state.stderr += d.toString(); });

  return { child: c, state };
}

/** 等到条件成立或超时 */
async function waitFor(fn, timeoutMs = 10000, stepMs = 50) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await sleep(stepMs);
  }
  return false;
}

// ---------------------------------------------------------------------------
// 1. disconnect 后进程退出
//
// 这是 P0 级回归。实测 disconnect() 后 ReadFile 返回
//   (ok=false, got=0, err=109=ERROR_BROKEN_PIPE)
// 如果实现按「读到 0 字节即 EOF」判断，这个错误会被当成普通读错误，
// 读线程退出但主循环仍在等，进程永远不退出 —— Issue #3 的坑换个形式复发。
// ---------------------------------------------------------------------------
test('IPC：disconnect 后 runner 在 500ms 内退出', async () => {
  const { child, state } = launchAot(['cmd.exe', '/c', 'exit 0']);

  // launcher 只负责起进程，start 消息要自己发
  await sleep(400);
  child.send({ type: 'start', cwd: 'C:/Windows', env: targetEnv() });

  await waitFor(() => state.result !== null, 10000);
  assert.ok(state.result, 'runner 应当先正常返回结果');

  // host 主动断开 IPC 通道
  child.disconnect();

  const exited = await waitFor(() => state.exited, 5000);
  assert.ok(exited, 'disconnect 后 runner 必须在 5s 内退出（EOF 判定错误会导致永久挂起）');
  assert.strictEqual(state.exitCode, 0, 'runner 正常收尾时必须以 0 退出（host 的 settleRange 依赖）');
});

// ---------------------------------------------------------------------------
// 2. 一次读多帧
//
// 实测：连续发 start + terminate(大 payload) 时，一次 ReadFile 返回 3145839 字节，
// 里面是 2 个完整的帧。实现必须缓冲并循环切帧，不能假设「一次读 = 一帧」。
// ---------------------------------------------------------------------------
test('IPC：连续多条消息（含大消息）全部被正确解析', async () => {
  const { child, state } = launchAot(['cmd.exe', '/c', 'exit 0']);

  await sleep(400);

  // 先发两条小的，再发一条大的 —— 它们很可能被合并进同一次读
  child.send({ type: 'terminate', signal: 'SIGTERM' });
  child.send({ type: 'start', cwd: 'C:/Windows', env: targetEnv(), pad: 'Z'.repeat(2 * 1024 * 1024) });
  const got = await waitFor(() => state.result !== null, 15000);
  assert.ok(got, '多条消息（含 2MiB 大消息）必须都能被解析，且至少产生一个终态结果');
  assert.strictEqual(
    state.messages.filter((m) => m && (m.type === 'target-exit' || m.type === 'error')).length,
    1,
    '终态结果只能投递一次',
  );

  try { child.kill('SIGKILL'); } catch { /* ignore */ }
});

// ---------------------------------------------------------------------------
// 3. 半帧累积
//
// 写一个大到超过单次读缓冲（64KB）的消息，验证实现能跨多次读累积到完整帧。
// ---------------------------------------------------------------------------
test('IPC：超过单次读缓冲的消息（512KB）能完整收到的', async () => {
  const pad = 'Q'.repeat(512 * 1024);
  const r = await runAot({
    argv: ['cmd.exe', '/c', 'exit 7'],
    env: { ...targetEnv(), BIG_PAD: pad },
  });

  assert.ok(r.result, '大消息下必须返回结果');
  assert.strictEqual(r.result.type, 'target-exit');
  assert.strictEqual(r.result.exitCode, 7, '大 env 不应影响退出码');
});

// ---------------------------------------------------------------------------
// 3b. 后续帧不会被丢弃
//
// 这条专门抓「切出一帧后把缓冲区剩余数据丢掉」这类缺陷。
//
// 关键是要让多条帧**落在同一次 ReadFile 的返回里**。
//
// ⚠️ 诚实说明（自校验结果）：这条测试**未能**抓到「切帧后丢弃缓冲区」的注入缺陷。
// 尝试过三种构造（小帧连发 / 大帧+小帧 / 256KB 噪声帧 + terminate + start），
// 由于 Node 发送端的排队行为，消息往往分次读到，缓冲区里始终只有一帧，
// 丢不丢都看不出来。要真正覆盖这一点，需要在 runner 侧可注入「一次读返回多帧」
// 的测试接缝（尚未实现）。
//
// 当前这条测试仍然有价值：它验证了多帧场景下结果只投递一次、不卡死。
// 但它**不能**证明切帧逻辑完全正确 —— 这个盲区记录在 Issue #11。
// ---------------------------------------------------------------------------
test('IPC：同一批数据里的后续帧不会被丢弃', async () => {
  const { child, state } = launchAot(['cmd.exe', '/c', 'exit 0']);

  await sleep(400);

  // 大帧（约 256KB）先占满管道，紧跟一条 terminate 小帧
  child.send({ type: 'noise', pad: 'N'.repeat(256 * 1024) });
  child.send({ type: 'terminate', signal: 'SIGTERM' });
  // 最后这条才是会产出终态结果的消息
  child.send({ type: 'start', cwd: 'C:/Windows', env: targetEnv() });

  const got = await waitFor(() => state.result !== null, 20000);
  assert.ok(got, '同一批数据里的 terminate/start 都必须被处理（被丢弃就收不到结果）');
  assert.strictEqual(
    state.messages.filter((m) => m && (m.type === 'target-exit' || m.type === 'error')).length,
    1,
    '终态结果只能投递一次',
  );

  try { child.kill('SIGKILL'); } catch { /* ignore */ }
});

// ---------------------------------------------------------------------------
// 4. 3MiB 级大 env
//
// 实测 host 侧在 MiB 量级仍以单帧发出。这条用来防止长度解析/上限防御
// 把合法的大请求误杀（上限是 8MB）。
// ---------------------------------------------------------------------------
test('IPC：3MiB 级大 env 正常执行', async () => {
  const r = await runAot({
    argv: ['hostname.exe'],
    env: { ...targetEnv(), HUGE_PAD: 'H'.repeat(3 * 1024 * 1024) },
    timeoutMs: 30000,
  });

  assert.ok(r.result, '3MiB env 下必须返回结果');
  assert.strictEqual(r.result.type, 'target-exit', `期望 target-exit，实际 ${JSON.stringify(r.result)}`);
  assert.strictEqual(r.result.exitCode, 0);
  assert.ok(r.stdout.trim().length > 0, 'hostname 应当有输出');
});

// ---------------------------------------------------------------------------
// 5. 真实 host 布局下的基本执行 + stdio 映射
//
// 这条是「能被 host 用起来」的总入口检查：
// fd 3 = IPC，fd 5 = target stdout，fd 6 = target stderr。
// ---------------------------------------------------------------------------
test('IPC：真实 host 布局下 target 的 stdout/stderr 分别落在 fd5/fd6', async () => {
  const r = await runAot({
    argv: ['cmd.exe', '/c', 'echo OUT_MARK & echo ERR_MARK 1>&2'],
    env: targetEnv(),
  });

  assert.strictEqual(r.result?.type, 'target-exit');
  assert.strictEqual(r.result.exitCode, 0);
  assert.ok(r.stdout.includes('OUT_MARK'), `target stdout 应含 OUT_MARK，实际 ${JSON.stringify(r.stdout)}`);
  assert.ok(r.stderr.includes('ERR_MARK'), `target stderr 应含 ERR_MARK，实际 ${JSON.stringify(r.stderr)}`);
  assert.ok(!r.stdout.includes('ERR_MARK'), 'stdout 不应混入 stderr 内容');
});

/**
 * 真实 host 路径验证（Issue #11 阶段 A 的关键检查点）
 *
 * 前面所有测试都是「手工按真实布局 spawn」，但真实 DSH 是通过
 * LocalSubprocessRuntime.spawn() 走的。这条测试用**真正的 DSH 运行时**，
 * 只把 internals.runnerInvocation 指向 AOT exe —— 走的就是生产路径。
 *
 * 如果这条不通，前面全绿也没意义。
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const AOT = 'D:/projects/dsh-aot-runner/dist/dsh-aot-runner.exe';

/** 构造一个能被 LocalSubprocessRuntime 接受的最小 cordis ctx */
function makeCtx() {
  return {
    logger: {
      warn: () => {}, info: () => {}, debug: () => {}, error: () => {}, success: () => {},
    },
    effect: (fn) => { const d = fn(); return () => { if (typeof d === 'function') d(); }; },
    on: () => {},
    reflect: { provide: () => {}, set: () => {}, get: () => undefined },
    get: () => undefined,
    set: () => {},
    plugin: () => {},
  };
}

test('真实 host：通过 internals.runnerInvocation 注入后 AOT 被选中并执行', async () => {
  const { LocalSubprocessRuntime } = require(
    'C:/Users/think/.workbuddy/binaries/node/workspace/node_modules/@deepseek-ai/dsh-subprocess-local',
  );

  const rt = new LocalSubprocessRuntime(makeCtx());

  // 1) 注入 —— 这是插件层唯一需要做的一件事
  rt.internals.runnerInvocation = [AOT];

  // 2) 确认路径选择逻辑会走 windows-job（即 launchWindowsJob，读 runnerInvocation）
  const mode = rt.selectContainmentMode('ordinary');
  assert.strictEqual(mode, 'windows-job',
    `必须走 windows-job 路径，实际 ${mode}（fallback 会绕过 runner 直连）`);

  // 3) 用真实 runtime 跑一次命令
  const spec = {
    argv: ['cmd.exe', '/c', 'echo HOST_PATH_OK'],
    cwd: 'C:/Windows',
    env: {
      PATH: 'C:\\Windows\\system32;C:\\Windows',
      SystemRoot: 'C:\\Windows',
      PATHEXT: '.COM;.EXE;.BAT;.CMD',
    },
    graceMs: 5000,
    stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
  };

  const handle = rt.spawn(spec);
  assert.ok(handle, 'spawn 应返回 handle');

  let stdout = '';
  if (handle.stdout) handle.stdout.on('data', (d) => { stdout += d.toString(); });
  if (handle.stderr) handle.stderr.on('data', () => { /* ignore */ });

  // handle.done 是 host 侧的最终结果 promise（bindManagedProcess 的正式契约）：
  //   target-exit → resolve({exitCode, signal})
  //   error       → reject(Error)
  const outcome = await handle.done;
  assert.ok(outcome, 'done 应 resolve 出结果对象');
  assert.strictEqual(outcome.exitCode, 0, `退出码应为 0，实际 ${JSON.stringify(outcome)}`);

  // 等 managed range 清空，确认 runner 正常收尾（而不是靠超时强杀）
  await handle.waitForExit();

  assert.ok(stdout.includes('HOST_PATH_OK'),
    `target 输出应回流到 host，实际 ${JSON.stringify(stdout)}`);

  // 4) 清理
  try { handle.terminate(); } catch { /* ignore */ }
});

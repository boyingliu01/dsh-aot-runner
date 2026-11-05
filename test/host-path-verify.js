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
const { resolve, dirname } = require('node:path');
const { existsSync } = require('node:fs');
const { resolveNodeRunner } = require('./runner-client');

const AOT = resolve(__dirname, '..', 'dist', 'dsh-aot-runner.exe');

/**
 * 定位 @deepseek-ai/dsh-subprocess-local 包目录（不硬编码本机路径）。
 * @returns {string} 包目录绝对路径
 */
function resolveSubprocessLocalDir() {
  const runnerPath = resolveNodeRunner();
  if (runnerPath === null) {
    throw new Error('找不到 @deepseek-ai/dsh-subprocess-local；请确认已安装 DSH 或设置 DSH_HOME');
  }
  const pkgDir = resolve(dirname(runnerPath), '..');
  if (!existsSync(resolve(pkgDir, 'package.json'))) {
    throw new Error(`从 ${runnerPath} 回溯到的包目录无效：${pkgDir}`);
  }
  return pkgDir;
}

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
  const { LocalSubprocessRuntime } = require(resolveSubprocessLocalDir());
  const rt = new LocalSubprocessRuntime(makeCtx());

  // 0) 装观测点：记录 launcher 实际启动了什么
  const observed = installSpawnRecorder(rt);

  // 1) 注入 —— 这是插件层唯一需要做的一件事
  rt.internals.runnerInvocation = [AOT];

  // 2) 路径选择必须走 windows-job（fallback 会绕过 runner 直连）
  assertContainmentMode(rt);

  // 3) 用真实 runtime 跑一次命令
  const handle = rt.spawn(makeEchoSpec());
  assert.ok(handle, 'spawn 应返回 handle');

  try {
    await assertHandleOutput(handle);
  } finally {
    try { handle.terminate(); } catch { /* ignore */ }
  }

  // 5) 关键断言：launcher 真的用了注入的 AOT，而不是静默回退到 node runner
  assertInjectedRunnerUsed(observed);
});

/**
 * 装一个观测点，记录 launcher 实际启动的命令。
 *
 * 这一步是**必需的**，不是锦上添花。早先这条测试只断言
 * 「exitCode===0 且输出正确」—— 但 node runner 也能满足这两点，
 * 所以当 DSH 0.2.0-rc.2 丢掉 internals 参数、注入完全失效时，
 * 本测试依然全绿。加了观测才算真正验证了「AOT 被使用」。
 *
 * @returns {string[]} 被调用过的命令列表（原地追加）
 */
function installSpawnRecorder(rt) {
  const observed = [];
  const childProcess = require('node:child_process');
  rt.internals.spawn = (command, args, options) => {
    observed.push(String(command));
    return childProcess.spawn(command, args, options);
  };
  return observed;
}

/** 断言路径选择走 windows-job。 */
function assertContainmentMode(rt) {
  const mode = rt.selectContainmentMode('ordinary');
  assert.strictEqual(mode, 'windows-job',
    `必须走 windows-job 路径，实际 ${mode}（fallback 会绕过 runner 直连）`);
}

/** 测试用的 spawn 规格：跑一条能回显标记的命令。 */
function makeEchoSpec() {
  return {
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
}

/**
 * 等 handle 完成并校验退出码与输出回流。
 *
 * handle.done 是 host 侧的最终结果 promise（bindManagedProcess 的正式契约）：
 *   target-exit → resolve({exitCode, signal})
 *   error       → reject(Error)
 */
async function assertHandleOutput(handle) {
  let stdout = '';
  if (handle.stdout) handle.stdout.on('data', (d) => { stdout += d.toString(); });
  if (handle.stderr) handle.stderr.on('data', () => { /* ignore */ });

  const outcome = await handle.done;
  assert.ok(outcome, 'done 应 resolve 出结果对象');
  assert.strictEqual(outcome.exitCode, 0, `退出码应为 0，实际 ${JSON.stringify(outcome)}`);

  // 等 managed range 清空，确认 runner 正常收尾（而不是靠超时强杀）
  await handle.waitForExit();

  assert.ok(stdout.includes('HOST_PATH_OK'),
    `target 输出应回流到 host，实际 ${JSON.stringify(stdout)}`);
}

/**
 * 断言 launcher 用的是注入的 AOT。
 *
 * 如果 DSH 版本把 internals 参数丢了，observed 会是空数组 ——
 * 这条断言会明确失败并指出原因，而不是让测试假绿。
 */
function assertInjectedRunnerUsed(observed) {
  assert.ok(observed.length > 0,
    'launcher 未调用 internals.spawn：当前 DSH 版本可能丢弃了 internals 参数'
    + '（见 vendor/README.md 与上游 discussion #11893）');
  assert.strictEqual(observed[0], AOT,
    `launcher 应启动注入的 AOT runner，实际启动了 ${JSON.stringify(observed[0])}`);
}

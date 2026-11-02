/**
 * 端到端验证：插件 + 真实 LocalSubprocessRuntime（Issue #11 阶段 B-4）
 *
 * 前面两个套件分别验证了：
 *   - test/host-path-verify.js：AOT runner 能被真实 runtime 调用
 *   - plugin/test/index.test.js：插件逻辑对假 runtime 正确
 *
 * 这条把两者合起来：**用插件注入，再用真实 runtime 跑**。
 * 这是唯一能证明「装上插件后真的会用 AOT」的测试。
 *
 * 运行：node --test test/e2e-plugin-verify.js
 */
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { pathToFileURL } = require('node:url');
const { resolve } = require('node:path');

const AOT = 'D:/projects/dsh-aot-runner/dist/dsh-aot-runner.exe';
const PLUGIN_INDEX = resolve(__dirname, '..', 'plugin', 'lib', 'index.js');

/** 构造能被 LocalSubprocessRuntime 接受的最小 cordis ctx */
function makeCtx() {
  const logs = { info: [], warn: [] };
  const effects = [];
  return {
    ctx: {
      logger: {
        info: (m) => logs.info.push(m),
        warn: (m) => logs.warn.push(m),
        debug: () => {},
        error: () => {},
      },
      // 与真实 cordis 一致：effect 会**立即执行** fn，并记录它返回的清理函数。
      // 早先写成「只收集不执行」，导致 LocalSubprocessRuntime 构造函数里的
      // `ctx.effect(() => { process.prependListener('exit', ...) })` 没跑起来，
      // runtime 处于半初始化状态 —— 表现出来的诡异现象是
      // 「runner 启动失败却 resolve 成 exitCode 0」。
      effect: (fn) => { effects.push(fn()); },
      on: () => {},
      reflect: { provide: () => {}, set: () => {}, get: () => undefined },
      get: () => undefined,
      set: () => {},
      plugin: () => {},
    },
    logs,
    effects,
  };
}

const ENV = {
  PATH: 'C:\\Windows\\system32;C:\\Windows',
  SystemRoot: 'C:\\Windows',

};

test('端到端：插件注入后真实 runtime 走 AOT runner', async () => {
  const { LocalSubprocessRuntime } = require(
    'C:/Users/think/.workbuddy/binaries/node/workspace/node_modules/@deepseek-ai/dsh-subprocess-local',
  );

  const { ctx, logs } = makeCtx();
  const rt = new LocalSubprocessRuntime(ctx);

  // 关键：ctx 上挂 subprocess，插件才能找到 runtime
  ctx.subprocess = rt;

  // 用插件注入（而不是手工改 internals）
  const plugin = await import(pathToFileURL(PLUGIN_INDEX).href);
  plugin.apply(ctx, { runnerPath: AOT, failThreshold: 3 });

  // 1) 插件确实写入了 runnerInvocation
  assert.deepStrictEqual(rt.internals.runnerInvocation, [AOT],
    `插件应注入 AOT 路径，实际 ${JSON.stringify(rt.internals.runnerInvocation)}`);
  assert.ok(logs.info.some((m) => m.includes('已启用')),
    `应有启用日志，实际 ${JSON.stringify(logs.info)}`);

  // 2) 真实 runtime 用这个注入跑一次命令
  const handle = rt.spawn({
    argv: ['cmd.exe', '/c', 'echo E2E_PLUGIN_OK'],
    cwd: 'C:/Windows',
    env: ENV,
    graceMs: 5000,
    stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
  });

  let stdout = '';
  handle.stdout?.on('data', (d) => { stdout += d.toString(); });

  const outcome = await handle.done;
  assert.strictEqual(outcome.exitCode, 0, `退出码应为 0，实际 ${JSON.stringify(outcome)}`);
  assert.ok(stdout.includes('E2E_PLUGIN_OK'),
    `target 输出应回流，实际 ${JSON.stringify(stdout)}`);

  await handle.waitForExit();
  try { handle.terminate(); } catch { /* ignore */ }
});

test('端到端：runner 缺失时插件不生效，runtime 仍可用（node runner 兜底）', async () => {
  const { LocalSubprocessRuntime } = require(
    'C:/Users/think/.workbuddy/binaries/node/workspace/node_modules/@deepseek-ai/dsh-subprocess-local',
  );

  const { ctx, logs } = makeCtx();
  const rt = new LocalSubprocessRuntime(ctx);
  ctx.subprocess = rt;

  const plugin = await import(pathToFileURL(PLUGIN_INDEX).href);
  plugin.apply(ctx, { runnerPath: 'Z:/nope/dsh-aot-runner.exe' });

  // 插件没生效，runnerInvocation 保持未设置
  assert.strictEqual(rt.internals.runnerInvocation, undefined);
  assert.ok(logs.warn.length > 0, '应给出告警');

  // runtime 仍然可用（走默认的 node runner）
  const handle = rt.spawn({
    argv: ['cmd.exe', '/c', 'echo FALLBACK_OK'],
    cwd: 'C:/Windows',
    env: ENV,
    graceMs: 5000,
    stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
  });

  let stdout = '';
  handle.stdout?.on('data', (d) => { stdout += d.toString(); });

  const outcome = await handle.done;
  assert.strictEqual(outcome.exitCode, 0);
  assert.ok(stdout.includes('FALLBACK_OK'), 'node runner 兜底应正常工作');

  await handle.waitForExit();
  try { handle.terminate(); } catch { /* ignore */ }
});

// ---------------------------------------------------------------------------
// 关于「熔断降级」为何没有 e2e 用例
//
// 试过用「存在但内容不是 PE 的 exe」构造 runner 启动失败，在 node:test 里
// 得到的结果与普通 node 进程**不一致**：同样代码在 `node x.cjs` 下
// `handle.done` 正常 reject，在 `node --test` 下却 resolve 成
// `{exitCode: 0}`。原因未查明（怀疑与 node:test 的 worker 预加载有关），
// 三条独立的最小复现都指向环境差异而非被测代码。
//
// 测不出差异的测试比没有测试更糟 —— 它会给一个假的绿灯。
// 因此熔断降级改在**单元测试**层验证（plugin/test/index.test.js），
// 那里用假 runtime 直接触发 recordFailure，结果确定。
//
// e2e 层保留「降级后会话仍可用」的验证，见上一条用例。
// ---------------------------------------------------------------------------

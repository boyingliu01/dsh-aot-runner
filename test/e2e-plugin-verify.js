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
const { resolve, dirname } = require('node:path');
const { existsSync } = require('node:fs');
const { resolveNodeRunner } = require('./runner-client');

const AOT = resolve(__dirname, '..', 'dist', 'dsh-aot-runner.exe');
const PLUGIN_INDEX = resolve(__dirname, '..', 'plugin', 'lib', 'index.js');

/**
 * 定位 @deepseek-ai/dsh-subprocess-local 包目录。
 *
 * 不能硬编码本机路径 —— 那会让测试只能在作者机器上跑，
 * 别人克隆仓库后必然失败。复用 runner-client 已有的多候选解析
 * （DSH_HOME / USERPROFILE / 仓库 node_modules），再从 runner.js 回溯包根。
 *
 * @returns {string} 包目录的绝对路径
 * @throws {Error} 找不到时给出可操作的提示
 */
function resolveSubprocessLocalDir() {
  const runnerPath = resolveNodeRunner();
  if (runnerPath === null) {
    throw new Error(
      '找不到 @deepseek-ai/dsh-subprocess-local。'
      + '请确认已安装 DSH，或设置环境变量 DSH_HOME 指向 DSH 安装目录。',
    );
  }
  // runner.js 位于 <pkg>/lib/runner.js，回溯两级到 <pkg>
  const pkgDir = resolve(dirname(runnerPath), '..');
  if (!existsSync(resolve(pkgDir, 'package.json'))) {
    throw new Error(`从 ${runnerPath} 回溯到的包目录无效：${pkgDir}`);
  }
  return pkgDir;
}

/** 构造一个记录日志的 logger。 */
function makeLogger(logs) {
  return {
    info: (m) => logs.info.push(m),
    warn: (m) => logs.warn.push(m),
    debug: () => {},
    error: () => {},
  };
}

/**
 * 构造能被 LocalSubprocessRuntime 接受的最小 cordis ctx。
 *
 * 注意 effect 的语义：真实 cordis 会**立即执行** fn，并记录它返回的清理函数。
 * 早先写成「只收集不执行」，导致 LocalSubprocessRuntime 构造函数里的
 * `ctx.effect(() => { process.prependListener('exit', ...) })` 没跑起来，
 * runtime 处于半初始化状态 —— 表现出来的诡异现象是
 * 「runner 启动失败却 resolve 成 exitCode 0」。
 */
function makeCtx() {
  const logs = { info: [], warn: [] };
  const effects = [];
  const ctx = {
    logger: makeLogger(logs),
    effect: (fn) => { effects.push(fn()); },
    on: () => {},
    reflect: { provide: () => {}, set: () => {}, get: () => undefined },
    get: () => undefined,
    set: () => {},
    plugin: () => {},
  };
  return { ctx, logs, effects };
}

const ENV = {
  PATH: 'C:\\Windows\\system32;C:\\Windows',
  SystemRoot: 'C:\\Windows',

};

/**
 * 在 runtime 上装一个观测点，记录 launcher 实际启动了哪个可执行文件。
 *
 * 为什么必须有这个：直接断言 `internals.runnerInvocation` 的值只能证明
 * 「字段被赋了值」，证明不了「有人读它」。DSH 0.2.0-rc.2 正好在 spawn()
 * 里丢掉了 internals 参数，字段赋了没人用 —— 于是插件完全失效时，
 * 只看字段值的测试依然全绿。必须看真实启动的命令行。
 *
 * @returns {string[]} 按调用顺序记录的 command 列表
 */
function observeLaunches(rt) {
  const observed = [];
  const childProcess = require('node:child_process');
  const original = rt.internals.spawn;
  rt.internals.spawn = (command, args, options) => {
    observed.push(String(command));
    return original ? original(command, args, options) : childProcess.spawn(command, args, options);
  };
  return observed;
}

/** 建一个挂了 subprocess 的 runtime（插件靠 ctx.subprocess 找到它）。 */
function makeRuntime() {
  const { LocalSubprocessRuntime } = require(resolveSubprocessLocalDir());
  const { ctx, logs } = makeCtx();
  const rt = new LocalSubprocessRuntime(ctx);
  ctx.subprocess = rt;
  return { ctx, logs, rt };
}

test('端到端：插件注入后真实 runtime 走 AOT runner', async () => {
  const { ctx, logs, rt } = makeRuntime();

  // 装观测点：记录 launcher 实际启动了什么命令。
  const observed = observeLaunches(rt);

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

  // 3) 决定性断言：launcher 真的用了 AOT，而不是静默回退
  //
  // 早先本测试只断言「internals.runnerInvocation === [AOT]」，
  // 但那只证明「字段被赋了值」，不证明「有人读它」。
  // DSH 0.2.0-rc.2 正好在 spawn() 里丢掉了 internals 参数，
  // 于是字段赋了没人用，测试依然全绿 —— 装配到真实 DSH 才发现无效。
  //
  // 现在直接看 launcher 启动了哪个可执行文件：这才是「生效」的定义。
  assert.ok(observed.length > 0,
    'launcher 未调用 internals.spawn：当前 DSH 版本可能丢弃了 internals 参数'
    + '（见 vendor/README.md 与上游 discussion #11893）');
  assert.strictEqual(observed[0], AOT,
    `launcher 应启动 AOT runner，实际启动了 ${JSON.stringify(observed[0])}`);
});

test('端到端：runner 缺失时插件不生效，runtime 仍可用（node runner 兜底）', async () => {
  const { LocalSubprocessRuntime } = require(resolveSubprocessLocalDir());

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

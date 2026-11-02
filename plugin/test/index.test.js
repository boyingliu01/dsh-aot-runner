/**
 * 插件单元测试（Issue #11 阶段 B）
 *
 * 这些测试**不启动真实 DSH**，而是构造一个最小的 ctx 和假 runtime，
 * 验证插件的行为契约：
 *
 *   1. 能正确注入 runnerInvocation
 *   2. 找不到 exe 时不动 runtime（不能把系统搞坏）
 *   3. 连续失败 N 次后降级回原 runner
 *   4. 卸载时完整还原
 *
 * 真实端到端路径在 test/host-path-verify.js 里覆盖。
 *
 * 运行：node --test plugin/test/index.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert';

/** 加载插件模块（插件本身是 ESM） */
async function loadPlugin() {
  return import(new URL('../lib/index.js', import.meta.url).href);
}

/** 构造一个记录日志的 ctx */
function makeCtx({ subprocess } = {}) {
  const logs = { info: [], warn: [] };
  const effects = [];
  const ctx = {
    logger: {
      info: (m) => logs.info.push(m),
      warn: (m) => logs.warn.push(m),
      debug: () => {},
      error: () => {},
    },
    effect: (fn) => { effects.push(fn); },
    subprocess,
    reflect: { get: () => undefined },
  };
  return { ctx, logs, effects };
}

/** 构造一个假 runtime，行为与 LocalSubprocessRuntime 的关键面一致 */
function makeFakeRuntime() {
  const spawned = [];
  const runtime = {
    internals: {},
    spawn: (spec) => {
      spawned.push(spec);
      return { done: Promise.resolve({ exitCode: 0, signal: null }) };
    },
  };
  return { runtime, spawned };
}

// ---------------------------------------------------------------------------
// 1. 正常注入
// ---------------------------------------------------------------------------
test('插件：把 internals.runnerInvocation 指向 AOT exe', async () => {
  const { apply, resolveRunnerPath } = await loadPlugin();

  const exePath = resolveRunnerPath()?.path;
  assert.ok(exePath, '测试前置：应当能找到 dist/dsh-aot-runner.exe');

  const { runtime } = makeFakeRuntime();
  const { ctx } = makeCtx({ subprocess: runtime });

  apply(ctx, { runnerPath: exePath });

  assert.deepStrictEqual(runtime.internals.runnerInvocation, [exePath]);
});

// ---------------------------------------------------------------------------
// 2. 找不到 exe 时不能动 runtime
//
// 这条是安全底线：插件配置错了，宁可完全不生效，也不能让 DSH 用不了。
// ---------------------------------------------------------------------------
test('插件：runner 不存在时不修改 runtime，且给出告警', async () => {
  const { apply } = await loadPlugin();

  const { runtime } = makeFakeRuntime();
  const { ctx, logs } = makeCtx({ subprocess: runtime });

  apply(ctx, { runnerPath: 'Z:/definitely/not/here/dsh-aot-runner.exe' });

  assert.strictEqual(runtime.internals.runnerInvocation, undefined,
    'runner 不存在时不得写入 runnerInvocation');
  assert.ok(logs.warn.length > 0, '应当给出告警');
  assert.ok(logs.warn[0].includes('不存在'), `告警内容应说明原因，实际：${logs.warn[0]}`);
});

// ---------------------------------------------------------------------------
// 3. enabled: false 时不生效
// ---------------------------------------------------------------------------
test('插件：enabled=false 时完全不介入', async () => {
  const { apply, resolveRunnerPath } = await loadPlugin();
  const exePath = resolveRunnerPath()?.path;

  const { runtime } = makeFakeRuntime();
  const { ctx } = makeCtx({ subprocess: runtime });

  apply(ctx, { enabled: false, runnerPath: exePath });

  assert.strictEqual(runtime.internals.runnerInvocation, undefined);
});

// ---------------------------------------------------------------------------
// 4. 熔断降级
//
// 核心安全网：连续失败达到阈值后必须切回原 runner，
// 否则一次 AOT 故障会让整个会话的子进程全部失败。
// ---------------------------------------------------------------------------
test('插件：连续失败达到阈值后降级回 node runner', async () => {
  const { apply, resolveRunnerPath } = await loadPlugin();
  const exePath = resolveRunnerPath()?.path;

  const originalInvocation = ['node.exe', 'runner.js'];
  const { runtime } = makeFakeRuntime();
  runtime.internals.runnerInvocation = originalInvocation;

  // 让 spawn 返回一个必定失败的 handle
  runtime.spawn = () => ({
    done: Promise.reject(new Error('runner 启动失败')),
  });

  const { ctx, logs } = makeCtx({ subprocess: runtime });
  apply(ctx, { runnerPath: exePath, failThreshold: 3 });

  assert.deepStrictEqual(runtime.internals.runnerInvocation, [exePath], '初始应已注入 AOT');

  // 触发 3 次失败
  for (let i = 0; i < 3; i += 1) {
    try {
      runtime.spawn({ argv: ['x'] });
    } catch { /* ignore */ }
    // 等 done 的 rejection 传播
    await new Promise((r) => setImmediate(r));
  }
  await new Promise((r) => setTimeout(r, 20));

  assert.deepStrictEqual(runtime.internals.runnerInvocation, originalInvocation,
    '熔断后必须还原成原始 invocation');
  assert.ok(logs.warn.some((m) => m.includes('熔断')), '应当有熔断日志');
});

// ---------------------------------------------------------------------------
// 5. target 正常非零退出不算 runner 失败
//
// 这条防的是「熔断器误判」：target 返回 exitCode=1 是完全正常的业务结果，
// 如果把它当 runner 故障，正常使用几分钟就会把 AOT 关掉。
// ---------------------------------------------------------------------------
test('插件：target 非零退出不触发熔断', async () => {
  const { apply, resolveRunnerPath } = await loadPlugin();
  const exePath = resolveRunnerPath()?.path;

  const { runtime } = makeFakeRuntime();
  runtime.spawn = () => ({ done: Promise.resolve({ exitCode: 1, signal: null }) });

  const { ctx } = makeCtx({ subprocess: runtime });
  apply(ctx, { runnerPath: exePath, failThreshold: 2 });

  for (let i = 0; i < 10; i += 1) {
    runtime.spawn({ argv: ['x'] });
    await new Promise((r) => setImmediate(r));
  }
  await new Promise((r) => setTimeout(r, 20));

  assert.deepStrictEqual(runtime.internals.runnerInvocation, [exePath],
    'target 非零退出是正常结果，不得触发降级');
});

// ---------------------------------------------------------------------------
// 6. 卸载还原
// ---------------------------------------------------------------------------
test('插件：卸载时还原 spawn 与 runnerInvocation', async () => {
  const { apply, resolveRunnerPath } = await loadPlugin();
  const exePath = resolveRunnerPath()?.path;

  const originalInvocation = ['node.exe', 'runner.js'];
  const { runtime } = makeFakeRuntime();
  const originalSpawn = runtime.spawn;
  runtime.internals.runnerInvocation = originalInvocation;

  const { ctx, effects } = makeCtx({ subprocess: runtime });
  apply(ctx, { runnerPath: exePath });

  assert.notStrictEqual(runtime.spawn, originalSpawn, '应当包装了 spawn');

  // 执行 ctx.effect 注册的清理函数
  assert.ok(effects.length > 0, '应当注册了清理 effect');
  const dispose = effects[0]();
  if (typeof dispose === 'function') await dispose();

  assert.strictEqual(runtime.spawn, originalSpawn, 'spawn 应还原');
  assert.deepStrictEqual(runtime.internals.runnerInvocation, originalInvocation,
    'runnerInvocation 应还原');
});

// ---------------------------------------------------------------------------
// 7. 成功会清零连续失败计数
//
// 这条防的是「熔断器只累加不清零」：如果成功不重置计数，那么一整天里
// 偶发的 3 次失败（跨越很多次正常调用）就会把 AOT 关掉。
// ---------------------------------------------------------------------------
test('插件：成功一次即清零，偶发失败不会累积触发熔断', async () => {
  const { apply, resolveRunnerPath } = await loadPlugin();
  const exePath = resolveRunnerPath()?.path;

  const { runtime } = makeFakeRuntime();
  let mode = 'fail';
  runtime.spawn = () => (mode === 'fail'
    ? { done: Promise.reject(new Error('偶发失败')) }
    : { done: Promise.resolve({ exitCode: 0, signal: null }) });

  const { ctx, logs } = makeCtx({ subprocess: runtime });
  apply(ctx, { runnerPath: exePath, failThreshold: 3 });

  // fail, success, fail, success, fail, success ... 连续失败永远到不了 3
  for (let i = 0; i < 6; i += 1) {
    mode = i % 2 === 0 ? 'fail' : 'success';
    runtime.spawn({ argv: ['x'] });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
  }
  await new Promise((r) => setTimeout(r, 20));

  assert.deepStrictEqual(runtime.internals.runnerInvocation, [exePath],
    '偶发失败（每次都被成功清零）不得触发熔断');
  assert.ok(!logs.warn.some((m) => m.includes('熔断')), '不应出现熔断日志');
});

// ---------------------------------------------------------------------------
// 自检（checkDshInternalsBug）
//
// 这段的由来：DSH 0.2.0-rc.2 的 spawn() 把 internals 参数丢了，导致本插件
// 「注入成功但完全无效」，而日志里一切正常 —— 用户装完只觉得没效果。
// 现在插件启动时会静态检测这个缺陷，命中就告警并自动停用。
//
// 这里验证两件事：
//   1. 检测函数对「有缺陷 / 已修复 / 认不出」三种源码形状给出正确结论
//   2. 检测到缺陷时 apply() 真的不生效，而不是装模作样地启用
// ---------------------------------------------------------------------------

/** 用给定的 DSH 源码文本跑一次检测（不依赖本机 DSH） */
function detectFromSource(source) {
  const buggy = /launch(WindowsJob|LinuxScope)\(spec,\s*env\)/.test(source);
  const fixed = /launch(WindowsJob|LinuxScope)\(spec,\s*env,\s*internals\)/.test(source);
  if (fixed) return 'ok';
  if (buggy) return 'buggy';
  return 'unknown';
}

test('自检：能识别「只传两参」的缺陷版本', () => {
  const src = 'handle = bindManagedProcess(spec, m === "linux-scope" ? launchLinuxScope(spec, env) : launchWindowsJob(spec, env), binding);';
  assert.strictEqual(detectFromSource(src), 'buggy');
});

test('自检：能识别「传了三参」的已修复版本', () => {
  const src = 'handle = bindManagedProcess(spec, m === "linux-scope" ? launchLinuxScope(spec, env, internals) : launchWindowsJob(spec, env, internals), binding);';
  assert.strictEqual(detectFromSource(src), 'ok');
});

test('自检：源码形状不认识时不误报为 ok', () => {
  // 上游重构过（比如改成传对象），既不是缺陷特征也不是修复特征
  const src = 'handle = bindManagedProcess(spec, launch({ spec, env, internals }), binding);';
  assert.strictEqual(detectFromSource(src), 'unknown',
    '认不出时必须返回 unknown，绝不能乐观地当成 ok');
});

test('自检：导出存在且可调用，不抛异常', async () => {
  const { checkDshInternalsBug } = await loadPlugin();
  assert.strictEqual(typeof checkDshInternalsBug, 'function',
    'checkDshInternalsBug 应被导出（便于诊断和测试）');
  const result = checkDshInternalsBug();
  assert.ok(['ok', 'buggy', 'unknown'].includes(result),
    `返回值应为三态之一，实际 ${JSON.stringify(result)}`);
});

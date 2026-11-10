/**
 * 降级路径可观测性测试（issue #18 B 项）
 *
 * ## 为什么需要这一组测试
 *
 * 本插件是纯性能增益插件：runner 挂掉时功能一切正常，只是慢 2~3 倍。
 * 这种失效**没有任何用户可见的症状** —— 不报错、不崩溃、功能都在。
 * 用户会以为自己快着，实际慢着，而且永远不会去查。
 *
 * 用 issue 里的话：**「加速失效但没人知道」是最坏的产品状态。**
 *
 * 所以这里锁死的是「用户能不能知道」这件事本身，而不是性能数字：
 *   1. 降级日志必须无条件输出（不能被 verbose 吞掉）
 *   2. 状态必须可查询，且能区分「没启用」和「启用了但降级」
 *   3. 降级原因必须是能读懂的完整句子，不是错误码
 *
 * 运行：node --test plugin/test/degrade-observability.test.js
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

/**
 * 构造一个假 runtime。
 *
 * spawn 的行为由 `runtime.failMode` 控制，必须在 apply **之前**装好 ——
 * 见 tripBreaker 里的说明。
 */
function makeFakeRuntime() {
  const runtime = {
    internals: {},
    failMode: false,
    spawn: () => {
      if (!runtime.failMode) {
        return { done: Promise.resolve({ exitCode: 0, signal: null }) };
      }
      const done = Promise.reject(new Error('runner 启动失败'));
      done.catch(() => {});   // 标记为已处理，避免 unhandledRejection
      return { done };
    },
  };
  return { runtime };
}

/**
 * 让 runtime.spawn 连续失败，触发熔断。
 *
 * @param {object} runtime 假 runtime
 * @param {number} times  失败次数
 */
async function tripBreaker(runtime, times) {
  // 一次性把假 spawn 切到「必定失败」模式，然后拨动 times 次。
  //
  // 两个陷阱都在这里踩过：
  //
  // 1) 必须让 done 的 rejection 有接收方。插件靠 handle.done.then(onOk, onErr)
  //    感知失败，不会 await 它；裸 Promise.reject 会变成 unhandledRejection，
  //    在测试结束后才炸，报错内容与「降级」毫无关系，极难定位。
  //
  // 2) installBreakerHook 在 apply 时就把**当时的** runtime.spawn 绑定成了
  //    它要监控的原函数。所以假 spawn 必须在 apply **之前**装好，
  //    之后只能改变它的行为（闭包里翻标志位），不能再替换 runtime.spawn ——
  //    否则替换的是插件包装后的函数，熔断器永远看不到失败。
  runtime.failMode = true;
  for (let i = 0; i < times; i += 1) {
    try {
      runtime.spawn({ argv: ['x'] });
    } catch { /* ignore */ }
    await new Promise((r) => setImmediate(r));
  }
  await new Promise((r) => setTimeout(r, 30));
}

/**
 * 把「重置状态 → 建假 runtime → 建 ctx → apply」这段样板抽出来。
 *
 * 每个测试都要这四步，重复 5 次后连 jscpd 都报重复了。
 * 放进辅助函数还有个额外好处：apply 之前必须先装好假 spawn 这个约束
 * （见 tripBreaker 说明）现在只在一个地方体现，不容易再踩。
 *
 * @param {object} [config] 传给 apply 的配置
 * @returns {Promise<{ctx: object, logs: object, runtime: object, plugin: object}>}
 */
async function setupPlugin(config = {}) {
  const plugin = await loadPlugin();
  plugin.resetRunnerStatus();

  const exePath = plugin.resolveRunnerPath()?.path;
  const { runtime } = makeFakeRuntime();
  const { ctx, logs } = makeCtx({ subprocess: runtime });

  plugin.apply(ctx, { runnerPath: exePath, ...config });
  return { ctx, logs, runtime, plugin, exePath };
}

test('降级可观测：成功启用后状态是 aot', async () => {
  const { plugin } = await setupPlugin();
  const status = plugin.getRunnerStatus();
  assert.strictEqual(status.runner, 'aot', '启用成功后应报告 aot');
  assert.strictEqual(status.degradedAt, null, '未降级时不应有降级时间');
});

test('降级可观测：熔断后状态变成 node，并记录降级时间', async () => {
  const { plugin, runtime } = await setupPlugin({ failThreshold: 3 });
  await tripBreaker(runtime, 3);

  const status = plugin.getRunnerStatus();
  assert.strictEqual(status.runner, 'node', '熔断后应报告 node（已降级）');
  assert.ok(status.degradedAt, '降级必须记录时间，否则无法判断是什么时候变慢的');
  // 必须是可解析的 ISO 时间
  assert.ok(!Number.isNaN(Date.parse(status.degradedAt)), '降级时间应是可解析的时间戳');
});

test('降级可观测：降级日志不受 verbose=false 影响', async () => {
  // verbose=false 是**默认配置**。原来的 bug 就在这里：
  // 降级日志套了 if (verbose)，于是默认配置下用户完全看不到降级。
  const { runtime, logs } = await setupPlugin({ failThreshold: 3, verbose: false });
  await tripBreaker(runtime, 3);

  assert.ok(
    logs.warn.length > 0,
    'verbose=false 时降级仍必须告警 —— 这是本测试存在的全部理由',
  );
  assert.ok(
    logs.warn.some((m) => m.includes('降级') && m.includes('node')),
    `降级日志应明确说明降级到 node，实际：${JSON.stringify(logs.warn)}`,
  );
});

test('降级可观测：降级日志说明后果和恢复方式', async () => {
  const { runtime, logs } = await setupPlugin({ failThreshold: 3 });
  await tripBreaker(runtime, 3);

  const msg = logs.warn.find((m) => m.includes('降级'));
  assert.ok(msg, '应当有降级日志');
  // 只说「降级了」不够，用户要知道自己损失了什么、该怎么办
  assert.ok(msg.includes('失效'), `降级日志应说明增益已失效，实际：${msg}`);
  assert.ok(msg.includes('恢复'), `降级日志应说明如何恢复，实际：${msg}`);
});

test('降级可观测：区分「没启用」和「启用了但降级」', async () => {
  const { apply, getRunnerStatus, resetRunnerStatus } = await loadPlugin();

  // 场景 1：明确禁用
  resetRunnerStatus();
  {
    const { runtime } = makeFakeRuntime();
    const { ctx } = makeCtx({ subprocess: runtime });
    apply(ctx, { enabled: false });
    assert.strictEqual(getRunnerStatus().runner, 'unsupported', '禁用时应是 unsupported');
  }

  // 场景 2：exe 不存在
  resetRunnerStatus();
  {
    const { runtime } = makeFakeRuntime();
    const { ctx } = makeCtx({ subprocess: runtime });
    apply(ctx, { runnerPath: 'C:/definitely/not/here.exe' });
    const s = getRunnerStatus();
    assert.strictEqual(s.runner, 'unsupported', '缺 exe 时应是 unsupported');
    // 原因必须具体到「哪个路径」，否则用户无从排查
    assert.ok(s.reason.includes('not') || s.reason.includes('不存在'),
      `原因应包含具体信息，实际：${s.reason}`);
  }

  // 场景 3：找不到 subprocess 服务
  resetRunnerStatus();
  {
    const { ctx } = makeCtx({});
    apply(ctx, {});
    const s = getRunnerStatus();
    assert.strictEqual(s.runner, 'unsupported');
    assert.ok(s.reason.includes('subprocess'), `原因应指出缺什么，实际：${s.reason}`);
  }
});

test('降级可观测：getRunnerStatus 返回副本，外部改不到内部状态', async () => {
  const { apply, getRunnerStatus, resetRunnerStatus, resolveRunnerPath } = await loadPlugin();
  resetRunnerStatus();

  const exePath = resolveRunnerPath()?.path;
  const { runtime } = makeFakeRuntime();
  const { ctx } = makeCtx({ subprocess: runtime });
  apply(ctx, { runnerPath: exePath });

  const s = getRunnerStatus();
  s.runner = 'tampered';
  assert.strictEqual(getRunnerStatus().runner, 'aot', '外部修改副本不应影响内部状态');
});

test('降级可观测：状态在三种取值之间闭合，没有第四种', async () => {
  const { apply, getRunnerStatus, resetRunnerStatus, resolveRunnerPath } = await loadPlugin();

  const seen = new Set();
  // 未启用
  resetRunnerStatus();
  seen.add(getRunnerStatus().runner);
  // 启用成功
  {
    const { runtime } = makeFakeRuntime();
    const { ctx } = makeCtx({ subprocess: runtime });
    apply(ctx, { runnerPath: resolveRunnerPath()?.path });
    seen.add(getRunnerStatus().runner);
  }
  // 降级
  {
    resetRunnerStatus();
    const { runtime } = makeFakeRuntime();
    const { ctx } = makeCtx({ subprocess: runtime });
    apply(ctx, { runnerPath: resolveRunnerPath()?.path, failThreshold: 3 });
    await tripBreaker(runtime, 3);
    seen.add(getRunnerStatus().runner);
  }

  const allowed = new Set(['aot', 'node', 'unsupported']);
  for (const v of seen) {
    assert.ok(allowed.has(v), `状态值「${v}」不在允许集合内`);
  }
  assert.strictEqual(seen.size, 3, `三种状态都应能被走到，实际走了：${[...seen].join(',')}`);
});

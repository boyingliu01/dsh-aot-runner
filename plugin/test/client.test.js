/**
 * 客户端状态页单元测试
 *
 * 客户端 bundle 是给浏览器用的（走 `window.__ModuleLoader__`），
 * 但它的**注册契约**和**状态判断**都是纯逻辑，可以在 Node 里造一个
 * 最小 loader 环境真实加载并验证：
 *
 *   1. bundle 结构正确（能被 loader 认出来）
 *   2. 缺服务时不崩（DSH 版本差异时降级而不是白屏）
 *   3. 状态合成正确（loader / config / exe 三层组合）
 *
 * 不测渲染细节 —— 那需要真实 React 和浏览器，收益低于成本。
 * 渲染层的正确性靠「装进 DSH 后肉眼看一眼」来兜底。
 *
 * 运行：node --test plugin/test/client.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

/**
 * 加载客户端 bundle。
 *
 * bundle 的形态是 `window.__ModuleLoader__.load({ id, factory })`，
 * 其中 factory 接收一个 `require`。这里造一个最小环境：
 * 记录 load 调用，并用假的 react 满足 factory 的依赖。
 *
 * @returns {{exports: object, loadedId: string}} 模块导出与注册的 id
 */
function loadClientBundle() {
  const source = readFileSync(new URL('../client/index.js', import.meta.url), 'utf8');
  let loadedId = '';
  let captured = null;

  const fakeRequire = (name) => {
    if (name === 'react') return makeFakeReact();
    throw new Error(`未预期的依赖：${name}`);
  };
  const window = {
    __ModuleLoader__: {
      load(descriptor) {
        loadedId = descriptor.id;
        captured = descriptor.factory(fakeRequire);
      },
    },
  };

  // bundle 是给浏览器用的脚本，靠 window 全局接入；用 Function 隔离求值
  const run = new Function('window', source);
  run(window);

  return { exports: captured, loadedId };
}

/** 最小 React 替身：只满足模块加载期用到的 `createElement`。 */
function makeFakeReact() {
  return {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
    useEffect: () => {},
    useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
  };
}

/**
 * 造一个假的 slots 服务，记录注册。
 *
 * @returns {{slots: object, registrations: Array}} slots 与记录
 */
function makeSlots() {
  const registrations = [];
  const slots = {
    inject: (name, fn) => {
      if (typeof fn === 'function') fn();
      return { dispose() {} };
    },
    register: (options, component) => {
      registrations.push({ options, component });
      return { dispose() {} };
    },
  };
  return { slots, registrations };
}

/**
 * 造一个最小客户端 ctx。
 *
 * @param {object} overrides 覆盖项
 * @returns {{ctx: object, registrations: Array}} ctx 与注册记录
 */
function makeCtx(overrides = {}) {
  const { slots, registrations } = makeSlots();
  const scoped = [];
  const ctx = {
    slots,
    inject: (names, fn) => { scoped.push({ names, fn }); },
    remote: undefined,
    ...overrides,
  };
  return { ctx, registrations, scoped };
}

/** 造一个 settingsScope 服务，bind() 返回快照可控的绑定对象。 */
function makeSettingsScope(snapshot) {
  const bound = {
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
    set: async () => true,
  };
  return { bind: () => bound };
}

// ---------------------------------------------------------------------------
// 1. bundle 结构
// ---------------------------------------------------------------------------

test('客户端：bundle 以正确的 id 注册自己', () => {
  const { loadedId } = loadClientBundle();
  assert.strictEqual(loadedId, '@boyingliu01/dsh-aot-runner');
});

test('客户端：导出 apply 与 inject', () => {
  const { exports } = loadClientBundle();
  assert.strictEqual(typeof exports.apply, 'function');
  assert.ok(Array.isArray(exports.inject));
  assert.ok(exports.inject.includes('slots'));
});

// ---------------------------------------------------------------------------
// 2. 缺服务时不能崩
// ---------------------------------------------------------------------------

test('客户端：没有 slots 服务时 apply 直接返回，不抛异常', () => {
  const { exports } = loadClientBundle();
  assert.doesNotThrow(() => exports.apply({}));
  assert.doesNotThrow(() => exports.apply({ slots: null }));
  assert.doesNotThrow(() => exports.apply(undefined));
});

test('客户端：settingsScope 不可用时不再注册（降级而不是白屏）', () => {
  const { exports } = loadClientBundle();
  const { ctx, scoped } = makeCtx();
  exports.apply(ctx);

  // 第一个 inject 是等 settingsScope 的
  assert.strictEqual(scoped.length, 1);
  assert.deepStrictEqual(scoped[0].names, ['settingsScope']);

  // 用一个残缺的服务回调：bind 缺失，应当安静返回
  assert.doesNotThrow(() => scoped[0].fn({ settingsScope: {} }));
  assert.doesNotThrow(() => scoped[0].fn({}));
  assert.doesNotThrow(() => scoped[0].fn(undefined));
});

test('客户端：settingsScope.bind 抛异常时不冒泡', () => {
  const { exports } = loadClientBundle();
  const { ctx, scoped } = makeCtx();
  exports.apply(ctx);

  const throwing = { settingsScope: { bind: () => { throw new Error('boom'); } } };
  assert.doesNotThrow(() => scoped[0].fn(throwing));
});

// ---------------------------------------------------------------------------
// 3. 正常注册路径
// ---------------------------------------------------------------------------

test('客户端：settingsScope 就绪后注册 plugins.row.config', () => {
  const { exports } = loadClientBundle();
  const { ctx, scoped, registrations } = makeCtx();
  exports.apply(ctx);

  scoped[0].fn({ settingsScope: makeSettingsScope({ status: 'ready', value: { enabled: true }, user: { enabled: true } }) });

  assert.strictEqual(registrations.length, 1);
  const { options, component } = registrations[0];
  assert.strictEqual(options.name, 'plugins.row.config');
  assert.strictEqual(options.key, '@boyingliu01/dsh-aot-runner#aot-runner');
  assert.strictEqual(typeof component, 'function');
});

// ---------------------------------------------------------------------------
// 4. 状态合成（本轮改动的核心逻辑）
// ---------------------------------------------------------------------------

test('客户端状态：loader 关闭时结论为未启用，并给出原因', () => {
  const { exports } = loadClientBundle();
  const result = exports.summarize({
    loaderEnabled: false,
    configEnabled: true,
    runnerPath: 'C:/x/dsh-aot-runner.exe',
  });

  assert.strictEqual(result.tone !== undefined, true);
  assert.strictEqual(result.fixes.length > 0, true, '不生效时必须给出原因');
});

test('客户端状态：三层状态合成的优先级正确', () => {
  const { exports } = loadClientBundle();

  // loader 关闭优先级最高：代码都没加载，config 是什么都无意义
  const loaderOff = exports.summarize({ loaderEnabled: false, configEnabled: true, runnerPath: 'x.exe' });
  assert.strictEqual(loaderOff.fixes.length, 1);

  // loader 开、config 关：加载了但不注入
  const configOff = exports.summarize({ loaderEnabled: true, configEnabled: false, runnerPath: 'x.exe' });
  assert.ok(configOff.fixes.join(' ').includes('config.enabled'));

  // 都开、exe 缺失：最危险的一种 —— 用户以为在加速，其实没有
  const noExe = exports.summarize({ loaderEnabled: true, configEnabled: true, runnerPath: null });
  assert.ok(noExe.fixes.length > 0);
  assert.notStrictEqual(noExe.tone, configOff.tone, 'exe 缺失应当比 config 关闭更严重');

  // 全都正常
  const healthy = exports.summarize({ loaderEnabled: true, configEnabled: true, runnerPath: 'x.exe' });
  assert.strictEqual(healthy.fixes.length, 0);
});

test('客户端状态：config.enabled 为 false 时提示不会注入', () => {
  const { exports } = loadClientBundle();
  const { ctx, scoped, registrations } = makeCtx();
  const scope = makeSettingsScope({ status: 'ready', value: { enabled: false, failThreshold: 3 }, user: null });
  exports.apply(ctx);
  scoped[0].fn({ settingsScope: scope });

  const tree = registrations[0].component({
    settingsScope: scope.bind(),
    ctx: { remote: { pluginInventory: { list: async () => ({ ok: true, value: { entries: [{ moduleName: '@boyingliu01/dsh-aot-runner', enabled: true }] } }) } } },
  });

  const fixText = tree.props.summary.fixes.join(' ');
  assert.ok(fixText.includes('config.enabled'), `应指出 config 关闭，实际：${fixText}`);
});

test('客户端状态：配置正常且 exe 有路径时判为已启用', () => {
  const { exports } = loadClientBundle();
  const { ctx, scoped, registrations } = makeCtx();
  const scope = makeSettingsScope({ status: 'ready', value: { enabled: true, failThreshold: 3, verbose: true }, user: { enabled: true } });
  exports.apply(ctx);
  scoped[0].fn({ settingsScope: scope });

  const tree = registrations[0].component({
    settingsScope: scope.bind(),
    ctx: { remote: { pluginInventory: { list: async () => ({ ok: true, value: { entries: [{ moduleName: '@boyingliu01/dsh-aot-runner', enabled: true }] } }) } } },
  });

  assert.strictEqual(tree.props.summary.fixes.length, 0, '正常时不应有修复提示');
  const runnerRow = tree.props.rows.find((r) => r.label === 'AOT runner');
  assert.ok(runnerRow === undefined || runnerRow.value !== '未知');
});

test('客户端状态：pluginInventory 不可用时显示未知，不假装已启用', () => {
  const { exports } = loadClientBundle();
  const { ctx, scoped, registrations } = makeCtx();
  const scope = makeSettingsScope({ status: 'ready', value: { enabled: true }, user: { enabled: true } });
  exports.apply(ctx);
  scoped[0].fn({ settingsScope: scope });

  const tree = registrations[0].component({
    settingsScope: scope.bind(),
    ctx: { remote: undefined },
  });

  assert.strictEqual(tree.props.unavailable, true, '读不到 loader 状态时必须标明不可用');
});

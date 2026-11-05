/**
 * aot-runner 状态页（只读）
 *
 * ## 这个页面回答什么问题
 *
 * 「我到底装对了没有？」
 *
 * 排查 aot-runner 时最常遇到的三个问题：
 *   1. 插件启用了，但 exe 找不到 → 实际跑的还是 node runner
 *   2. 插件启用了，但 DSH 上游有 bug 会丢弃 internals → 注入静默失效
 *   3. 熔断过，降级到 node runner 了 → 用户以为在加速，其实没有
 *
 * 第 3 类属于运行时内存状态，浏览器读不到，仍看日志。
 * 第 1、2 类可以在这里说清楚。
 *
 * ## 为什么是只读
 *
 * 启用/停用请用侧栏「插件」页面的官方开关。再做一个开关会形成
 * 两个真相来源，用户不知道该信哪个。这里只显示状态。
 *
 * ## 数据来源
 *
 * - `remote.pluginInventory.list()` —— loader 层的 enabled / fiberPhase
 * - `settingsScope.bind({ namespace })` —— 本插件的 config（enabled 等）
 * 两者都是 DSH 官方接口，不自己造通道。
 */

window.__ModuleLoader__.load({
  id: '@boyingliu01/dsh-aot-runner',
  factory: (require) => {
    var module = { exports: {} };
    // module.exports 直接作为导出对象；不额外起别名，避免未使用变量

    /** 插件包名 —— 必须与 package.json 的 name 一致。 */
    var PKG = '@boyingliu01/dsh-aot-runner';
    /** Loader 行 id —— 与 cordis.patch.yml 里的 id 一致。 */
    var ROW_ID = 'aot-runner';
    /** 配置命名空间就是行 id：DSH 按 entry id 给 served form 建键。 */
    var NS = ROW_ID;

    var React = require('react');

    /** 内部状态色板，跟 DSH 的语义色对齐。 */
    var TONE = {
      ok: 'var(--dsw-alias-status-success, #2ea043)',
      warn: 'var(--dsw-alias-status-warning, #d29922)',
      bad: 'var(--dsw-alias-status-danger, #f85149)',
      idle: 'var(--dsw-alias-label-tertiary, #8b949e)',
    };

    /** 文案。页面上每个字符串都在这里，方便对照与翻译。 */
    var COPY = {
      title: 'AOT Runner 状态',
      intro:
        '把 DSH 的子进程 runner 从 Node.js 换成 NativeAOT 原生 exe，' +
        '每次子进程调用省约 130ms。下面是当前的生效情况。',
      rowRunner: 'AOT runner',
      rowLoader: '插件加载',
      rowConfig: '配置开关 enabled',
      rowExe: 'exe 路径',
      rowFailure: '熔断阈值',
      rowVerbose: '降级日志',
      on: '已启用',
      off: '未启用',
      yes: '是',
      no: '否',
      unknown: '未知',
      loading: '读取中…',
      unavailable: '无法读取（当前 DSH 未提供该接口）',
      hintUseToggle: '启用/停用请用左侧栏「插件」页面的开关。',
      hintRuntime:
        '熔断与降级状态属于运行时信息，不在本页显示 —— 出现降级时会打印日志：',
      hintRuntimeSample: '[aot-runner] 熔断，降级到 node runner：<原因>',
      fixTitle: '状态不一致：',
      fixExe: '配置已打开，但 exe 找不到 —— 实际仍在跑 node runner。',
      fixLoader: '插件行已关闭 —— 页面随之卸载，不应看到此处。',
      fixConfig: '插件已加载，但 config.enabled 为 false —— 不会注入 AOT runner。',
    };

    /**
     * 把 loader 与配置两层状态合成一个结论。
     *
     * 这两层都可能单独导致「没生效」，必须分开判断：
     * loader 关了 = 代码没加载；config.enabled 关了 = 加载了但不干活。
     *
     * @param {object} input
     * @param {boolean|undefined} input.loaderEnabled loader 行是否启用
     * @param {boolean|undefined} input.configEnabled config.enabled
     * @param {string|null} input.runnerPath 解析出的 exe 路径，null 表示找不到
     * @returns {{tone: string, text: string, fixes: string[]}} 结论
     */
    function summarize(input) {
      var fixes = [];
      var loaderEnabled = input.loaderEnabled;
      var configEnabled = input.configEnabled;
      var hasExe = input.runnerPath !== null && input.runnerPath !== undefined;

      if (loaderEnabled === false) {
        fixes.push(COPY.fixLoader);
        return { tone: TONE.idle, text: COPY.off, fixes: fixes };
      }
      if (configEnabled === false) {
        fixes.push(COPY.fixConfig);
        return { tone: TONE.warn, text: COPY.off + '（config.enabled = false）', fixes: fixes };
      }
      if (!hasExe) {
        fixes.push(COPY.fixExe);
        return { tone: TONE.bad, text: COPY.bad, fixes: fixes };
      }

      return { tone: TONE.ok, text: COPY.on, fixes: fixes };
    }

    /** 一行「标签 —— 值」，值是可选色块。 */
    function Row(props) {
      var label = props.label;
      var value = props.value;
      var tone = props.tone;
      return React.createElement(
        'div',
        {
          style: {
            display: 'flex',
            alignItems: 'baseline',
            gap: '12px',
            padding: '8px 0',
            borderBottom: '1px solid var(--dsw-alias-line-tertiary, rgba(128,128,128,0.18))',
          },
        },
        React.createElement(
          'span',
          { style: { flex: '0 0 150px', color: 'var(--dsw-alias-label-secondary, #8b949e)', fontSize: '13px' } },
          label,
        ),
        React.createElement(
          'span',
          {
            style: {
              fontSize: '13px',
              fontFamily: 'var(--dsw-alias-font-mono, ui-monospace, monospace)',
              color: tone || 'var(--dsw-alias-label-primary, #c9d1d9)',
              wordBreak: 'break-all',
            },
          },
          value,
        ),
      );
    }

    /**
     * 合并两个样式对象（后者覆盖前者）。
     *
     * React 的 style 不接受数组或展开时保留顺序以外的语义，
     * 这里显式浅合并，用于「基础样式 + 一个动态属性」这种最常见的组合。
     */
    function merge(base, extra) {
      var out = {};
      Object.keys(base).forEach(function (k) { out[k] = base[k]; });
      Object.keys(extra).forEach(function (k) { out[k] = extra[k]; });
      return out;
    }

    /**
     * 卡片内复用到的内联样式。
     *
     * 抽成常量而不是散落在各处：这些值在多处重复（尤其 var(--dsw-alias-*)
     * 的降级色），改主题时只需改一处；也让组件函数只剩结构，读起来是
     * 「卡片由哪几块组成」而不是一屏 CSS。
     */
    var STYLE = {
      card: { maxWidth: '760px', display: 'flex', flexDirection: 'column', gap: '4px' },
      title: { margin: '0 0 4px', fontSize: '16px', fontWeight: 600 },
      intro: { margin: '0 0 12px', fontSize: '13px', color: 'var(--dsw-alias-label-secondary, #8b949e)' },
      summaryBar: {
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        padding: '10px 12px',
        marginBottom: '8px',
        borderRadius: '8px',
        background: 'var(--dsw-alias-bg-secondary, rgba(128,128,128,0.08))',
        fontSize: '14px',
        fontWeight: 600,
      },
      dot: { width: '8px', height: '8px', borderRadius: '50%', flex: '0 0 8px' },
      unavailable: { fontSize: '12px', fontWeight: 400, color: 'var(--dsw-alias-label-tertiary, #8b949e)' },
      fixes: {
        marginTop: '12px',
        padding: '10px 12px',
        borderRadius: '8px',
        background: 'var(--dsw-alias-bg-warning, rgba(210,153,34,0.12))',
        fontSize: '13px',
        lineHeight: 1.6,
      },
      hints: {
        margin: '12px 0 0',
        fontSize: '12px',
        lineHeight: 1.7,
        color: 'var(--dsw-alias-label-tertiary, #8b949e)',
      },
      code: { fontSize: '11px' },
    };

    /** 状态条：色点 + 状态文本 + 可选的「不可用」标记。 */
    function SummaryBar(props) {
      var summary = props.summary;
      var unavailable = props.unavailable;
      return React.createElement(
        'div',
        { style: STYLE.summaryBar },
        React.createElement('span', { style: merge(STYLE.dot, { background: summary.tone }) }),
        React.createElement('span', { style: { color: summary.tone } }, summary.text),
        unavailable
          ? React.createElement('span', { style: STYLE.unavailable }, COPY.unavailable)
          : null,
      );
    }

    /** 修复建议块；没有建议时不渲染。 */
    function FixList(props) {
      var fixes = props.fixes;
      if (!fixes.length) return null;
      return React.createElement(
        'div',
        { style: STYLE.fixes },
        React.createElement('strong', null, COPY.fixTitle),
        fixes.map(function (fix) {
          return React.createElement('div', { key: fix }, fix);
        }),
      );
    }

    /** 底部使用提示。 */
    function Hints() {
      return React.createElement(
        'p',
        { style: STYLE.hints },
        COPY.hintUseToggle,
        React.createElement('br'),
        COPY.hintRuntime,
        React.createElement('br'),
        React.createElement('code', { style: STYLE.code }, COPY.hintRuntimeSample),
      );
    }

    /** 状态卡片。 */
    function StatusCard(props) {
      var summary = props.summary;
      var rows = props.rows;
      var unavailable = props.unavailable;

      return React.createElement(
        'section',
        { style: STYLE.card },
        React.createElement('h3', { style: STYLE.title }, COPY.title),
        React.createElement('p', { style: STYLE.intro }, COPY.intro),
        React.createElement(SummaryBar, { summary: summary, unavailable: unavailable }),
        rows.map(function (row) {
          return React.createElement(Row, { key: row.label, label: row.label, value: row.value, tone: row.tone });
        }),
        React.createElement(FixList, { fixes: summary.fixes }),
        React.createElement(Hints, null),
      );
    }

    /**
     * 读取 loader 层状态。
     *
     * `pluginInventory.list()` 是 DSH 官方接口，返回所有 loader 条目。
     * 拿不到时返回 undefined 而不是猜 —— 猜出来的「已启用」比不显示更误导。
     *
     * @param {object} ctx 客户端根上下文
     * @returns {Promise<{enabled: boolean}|null>} 找不到或不可用时返回 null
     */
    async function readLoaderState(ctx) {
      try {
        var entries = await fetchInventoryEntries(ctx);
        if (!entries) return null;
        var entry = entries.find(function (item) {
          return item && item.moduleName === PKG;
        });
        if (!entry) return null;
        return { enabled: entry.enabled === true };
      } catch {
        return null;
      }
    }

    /**
     * 调 pluginInventory.list() 并取出 entries 数组。
     *
     * 任何一步不可用都返回 null：这些是「环境没提供该能力」的正常情形，
     * 由调用方统一按「未知」处理，不必在读取逻辑里层层展开。
     */
    async function fetchInventoryEntries(ctx) {
      if (!isInventoryAvailable(ctx.remote)) return null;
      return extractEntries(await ctx.remote.pluginInventory.list());
    }

    /** 从 list() 的返回值里取出 entries 数组；结果不 OK 或形状不对时返回 null。 */
    function extractEntries(result) {
      if (!result || !result.ok) return null;
      var entries = result.value && result.value.entries;
      return Array.isArray(entries) ? entries : null;
    }

    /** 当前环境是否提供 pluginInventory.list。 */
    function isInventoryAvailable(remote) {
      return Boolean(remote)
        && Boolean(remote.pluginInventory)
        && typeof remote.pluginInventory.list === 'function';
    }

    /**
     * 解析 exe 路径。
     *
     * 浏览器读不到文件系统，所以「存在性」无法在这里判断。
     * 能确定的是配置里有没有写 runnerPath：没写就是走包内 bin/。
     * 这是本页能给出的最诚实的结论，不假装知道文件在不在。
     *
     * @param {object} snapshot settingsScope 快照
     * @returns {{path: string, known: boolean}} 路径与是否确知存在
     */
    function resolveExe(snapshot) {
      var configured = readPathField(snapshot, 'runnerPath');
      if (configured) return { path: configured, known: false };
      return { path: '包内 bin/dsh-aot-runner.exe（默认）', known: false };
    }

    /**
     * 从快照的 user/value 两层里读一个字符串字段（user 优先）。
     *
     * 两层都查是因为 DSH 的设置项可能来自用户覆盖或插件默认值，
     * 而展示层不关心来源，只关心「最终生效的是什么」。
     */
    function readPathField(snapshot, field) {
      return readTypedField(snapshot, field, 'string', '');
    }

    /**
     * 按指定类型从 user/value 两层读字段（user 优先），否则给默认值。
     *
     * 两层都查是因为 DSH 的设置项可能来自用户覆盖或插件默认值，
     * 而展示层只关心「最终生效的是什么」。空字符串视为未设置
     * （配置里留空等同于没配）。
     */
    function readTypedField(snapshot, field, type, fallback) {
      var found = findTypedField([snapshot && snapshot.user, snapshot && snapshot.value], field, type);
      return found === undefined ? fallback : found;
    }

    /**
     * 在若干候选对象里找第一个指定类型且非空的字段值；找不到返回 undefined。
     *
     * 与 fallback 分离是为了区分「没找到」和「找到的恰好是 falsy」——
     * 直接返回 fallback 会让调用方分不清这两种情况。
     */
    function findTypedField(candidates, field, type) {
      for (var i = 0; i < candidates.length; i += 1) {
        var src = candidates[i];
        if (!src || typeof src[field] !== type) continue;
        if (src[field]) return src[field];
      }
      return undefined;
    }

    /** 从配置快照读一个布尔字段，未设置时给默认值。 */
    function readBool(snapshot, field, fallback) {
      return readTypedField(snapshot, field, 'boolean', fallback);
    }

    /** 状态卡片的数据读取与渲染。 */
    function StatusEntry(props) {
      var settingsScope = props.settingsScope;

      var snapshot = React.useSyncExternalStore(
        function (listener) { return settingsScope.subscribe(listener); },
        function () { return settingsScope.getSnapshot(); },
      );

      var loaderState = React.useState(null);
      var loader = loaderState[0];
      var setLoader = loaderState[1];

      React.useEffect(function () {
        var alive = true;
        readLoaderState(props.ctx).then(function (state) {
          if (alive) setLoader(state);
        });
        return function () { alive = false; };
      }, []);

      if (!snapshot || snapshot.status === 'loading') {
        return React.createElement(Row, { label: COPY.rowRunner, value: COPY.loading });
      }

      // 'unavailable' 表示 DSH 没把该命名空间暴露给客户端（例如纯内存模式）。
      // 这时不能推断成「未启用」——那是把「看不到」说成「关着」，会误导排查。
      if (snapshot.status !== 'ready') {
        return React.createElement(StatusCard, {
          summary: { tone: TONE.idle, text: COPY.unknown, fixes: [] },
          rows: [{ label: COPY.rowConfig, value: COPY.unavailable, tone: TONE.idle }],
          unavailable: true,
        });
      }

      var view = buildStatusView(snapshot, loader);
      return React.createElement(StatusCard, {
        summary: view.summary,
        rows: view.rows,
        unavailable: loader === null,
      });
    }

    /**
     * 从快照与 loader 状态算出卡片需要的 summary 与 rows。
     *
     * 从 <see cref="StatusEntry"/> 分出来的理由：组件函数必须保持
     * 「读 hook → 渲染」的单一职责，而「读哪些字段、怎么映射成行」
     * 是一段纯计算，放在组件里既拉长函数，也让这段映射无法单独推理。
     */
    function buildStatusView(snapshot, loader) {
      var configEnabled = readBool(snapshot, 'enabled', false);
      var failThreshold = readFailThreshold(snapshot);
      var verbose = readBool(snapshot, 'verbose', true);
      var exe = resolveExe(snapshot);

      var summary = summarize({
        loaderEnabled: loader === null ? undefined : loader.enabled,
        configEnabled: configEnabled,
        runnerPath: exe.path,
      });

      return {
        summary: summary,
        rows: buildStatusRows(configEnabled, loader, exe, failThreshold, verbose),
      };
    }

    /** 失败阈值：优先取用户设置里的数值，缺失时回落到默认 3 次。 */
    function readFailThreshold(snapshot) {
      var value = snapshot.value;
      return (typeof value === 'object' && value && typeof value.failThreshold === 'number')
        ? value.failThreshold
        : 3;
    }

    /** 卡片明细行。 */
    function buildStatusRows(configEnabled, loader, exe, failThreshold, verbose) {
      return [
        { label: COPY.rowConfig, value: yesNo(configEnabled), tone: configEnabled ? TONE.ok : TONE.warn },
        loaderRow(loader),
        { label: COPY.rowExe, value: exe.path, tone: undefined },
        { label: COPY.rowFailure, value: String(failThreshold) + ' 次', tone: undefined },
        { label: COPY.rowVerbose, value: yesNo(verbose), tone: undefined },
      ];
    }

    /** boolean → 是/否 文案。 */
    function yesNo(flag) {
      return flag ? COPY.yes : COPY.no;
    }

    /**
     * loader 行：三态（未知 / 开 / 关）。
     *
     * 单独成函数是因为它是唯一有「未知」状态的行 ——
     * loader === null 表示读不到（不是「关着」），混进 yes/no 里会丢掉这个区别。
     */
    function loaderRow(loader) {
      if (loader === null) {
        return { label: COPY.rowLoader, value: COPY.unknown, tone: TONE.idle };
      }
      return {
        label: COPY.rowLoader,
        value: loader.enabled ? COPY.on : COPY.off,
        tone: loader.enabled ? TONE.ok : TONE.idle,
      };
    }

    /**
     * 挂载入口。
     *
     * 注册到 `plugins.row.config` —— 侧栏「插件」页面里，某个 loader 行的
     * 专属配置区。key 的格式是 `<包名>#<行 id>`（DSH 的 rowConfigKey 就是这么拼的）。
     *
     * **不要用 `settings.plugin.item`**：那个 slot 在 DSH 0.1.7-rc.2 之前
     * 就被废弃了，官方的 0.2.0-rc.2 安装里完全不存在它。
     * 只有少数第三方插件还留着对它的注册，且注释里明确写了它已退役
     * （见 @goodandready/dsh-context-lens 与 dsh-fonttune 的源码注释）。
     *
     * @param {object} ctx 客户端根上下文
     */
    module.exports.apply = function apply(ctx) {
      if (!isMountableCtx(ctx)) return;

      ctx.inject(['settingsScope'], function (scoped) {
        var bound = bindSettings(scoped);
        if (!bound) return;
        registerRowConfig(ctx, bound);
      });
    };

    /** ctx 是否具备挂载所需的最小能力。 */
    function isMountableCtx(ctx) {
      return Boolean(ctx) && Boolean(ctx.slots) && typeof ctx.slots.inject === 'function';
    }

    /**
     * 绑定 settingsScope 命名空间。
     *
     * 任何一步不满足都返回 null，由调用方静默跳过 —— 这些失败都是
     * 「运行环境不支持该面板」的预期形态（例如纯内存模式），
     * 不是本插件的错误，不该打扰用户。
     */
    function bindSettings(scoped) {
      var service = scoped && scoped.settingsScope;
      if (!service || typeof service.bind !== 'function') return null;

      var bound = tryBind(service);
      return isBoundShape(bound) ? bound : null;
    }

    /** 调 service.bind；抛异常时视为不可用。 */
    function tryBind(service) {
      try {
        return service.bind({ namespace: NS });
      } catch {
        return null;
      }
    }

    /** 绑定结果是否具备读取与订阅能力。 */
    function isBoundShape(bound) {
      return Boolean(bound)
        && typeof bound.getSnapshot === 'function'
        && typeof bound.subscribe === 'function';
    }

    /** 把状态行注册进 plugins.row.config 槽位。 */
    function registerRowConfig(ctx, bound) {
      ctx.slots.inject('plugins.row.config', function () {
        return ctx.slots.register(rowConfigEntry(ctx, bound), StatusEntry);
      });
    }

    /** 槽位注册项的描述符（key 由包名与行 id 拼成）。 */
    function rowConfigEntry(ctx, bound) {
      return {
        name: 'plugins.row.config',
        key: PKG + '#' + ROW_ID,
        inject: function () { return { settingsScope: bound, ctx: ctx }; },
      };
    }

    /** 本插件依赖的客户端服务。 */
    module.exports.inject = ['slots'];

    // 纯逻辑导出给单元测试用。浏览器侧不会读这些，但把判断逻辑暴露出来
    // 才能对「三层状态如何合成结论」做真正的断言，而不是靠肉眼看界面。
    module.exports.summarize = summarize;
    module.exports.resolveExe = resolveExe;
    module.exports.readBool = readBool;

    return module.exports;
  },
});

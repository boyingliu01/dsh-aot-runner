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

    /** 状态卡片。 */
    function StatusCard(props) {
      var summary = props.summary;
      var rows = props.rows;
      var unavailable = props.unavailable;

      return React.createElement(
        'section',
        { style: { maxWidth: '760px', display: 'flex', flexDirection: 'column', gap: '4px' } },
        React.createElement(
          'h3',
          { style: { margin: '0 0 4px', fontSize: '16px', fontWeight: 600 } },
          COPY.title,
        ),
        React.createElement(
          'p',
          { style: { margin: '0 0 12px', fontSize: '13px', color: 'var(--dsw-alias-label-secondary, #8b949e)' } },
          COPY.intro,
        ),
        React.createElement(
          'div',
          {
            style: {
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
          },
          React.createElement('span', {
            style: {
              width: '8px',
              height: '8px',
              borderRadius: '50%',
              background: summary.tone,
              flex: '0 0 8px',
            },
          }),
          React.createElement('span', { style: { color: summary.tone } }, summary.text),
          unavailable ? React.createElement('span', { style: { fontSize: '12px', fontWeight: 400, color: 'var(--dsw-alias-label-tertiary, #8b949e)' } }, COPY.unavailable) : null,
        ),
        rows.map(function (row) {
          return React.createElement(Row, { key: row.label, label: row.label, value: row.value, tone: row.tone });
        }),
        summary.fixes.length
          ? React.createElement(
              'div',
              {
                style: {
                  marginTop: '12px',
                  padding: '10px 12px',
                  borderRadius: '8px',
                  background: 'var(--dsw-alias-bg-warning, rgba(210,153,34,0.12))',
                  fontSize: '13px',
                  lineHeight: 1.6,
                },
              },
              React.createElement('strong', null, COPY.fixTitle),
              summary.fixes.map(function (fix) {
                return React.createElement('div', { key: fix }, fix);
              }),
            )
          : null,
        React.createElement(
          'p',
          {
            style: {
              margin: '12px 0 0',
              fontSize: '12px',
              lineHeight: 1.7,
              color: 'var(--dsw-alias-label-tertiary, #8b949e)',
            },
          },
          COPY.hintUseToggle,
          React.createElement('br'),
          COPY.hintRuntime,
          React.createElement('br'),
          React.createElement('code', { style: { fontSize: '11px' } }, COPY.hintRuntimeSample),
        ),
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
        var remote = ctx.remote;
        if (!remote || !remote.pluginInventory || typeof remote.pluginInventory.list !== 'function') return null;
        var result = await remote.pluginInventory.list();
        if (!result || !result.ok) return null;
        var entries = result.value && result.value.entries;
        if (!Array.isArray(entries)) return null;
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
      var user = snapshot && snapshot.user;
      var value = snapshot && snapshot.value;
      var configured =
        (user && typeof user.runnerPath === 'string' && user.runnerPath) ||
        (value && typeof value.runnerPath === 'string' && value.runnerPath) ||
        '';
      if (configured) return { path: configured, known: false };
      return { path: '包内 bin/dsh-aot-runner.exe（默认）', known: false };
    }

    /** 从配置快照读一个布尔字段，未设置时给默认值。 */
    function readBool(snapshot, field, fallback) {
      var user = snapshot && snapshot.user;
      var value = snapshot && snapshot.value;
      if (user && typeof user[field] === 'boolean') return user[field];
      if (value && typeof value[field] === 'boolean') return value[field];
      return fallback;
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

      var configEnabled = readBool(snapshot, 'enabled', false);
      var failThreshold = (typeof snapshot.value === 'object' && snapshot.value && typeof snapshot.value.failThreshold === 'number')
        ? snapshot.value.failThreshold
        : 3;
      var verbose = readBool(snapshot, 'verbose', true);
      var exe = resolveExe(snapshot);

      var summary = summarize({
        loaderEnabled: loader === null ? undefined : loader.enabled,
        configEnabled: configEnabled,
        runnerPath: exe.path,
      });

      var rows = [
        { label: COPY.rowConfig, value: configEnabled ? COPY.yes : COPY.no, tone: configEnabled ? TONE.ok : TONE.warn },
        {
          label: COPY.rowLoader,
          value: loader === null ? COPY.unknown : (loader.enabled ? COPY.on : COPY.off),
          tone: loader === null ? TONE.idle : (loader.enabled ? TONE.ok : TONE.idle),
        },
        { label: COPY.rowExe, value: exe.path, tone: undefined },
        { label: COPY.rowFailure, value: String(failThreshold) + ' 次', tone: undefined },
        { label: COPY.rowVerbose, value: verbose ? COPY.yes : COPY.no, tone: undefined },
      ];

      return React.createElement(StatusCard, {
        summary: summary,
        rows: rows,
        unavailable: loader === null,
      });
    }

    /**
     * 挂载入口。
     *
     * 注册到 `settings.plugin.item` —— 设置页里属于某个插件的卡片。
     * 不用 `plugins.row.config` 是因为它是「整页配置」，本页只读、
     * 内容也很少，卡片更合适。
     *
     * @param {object} ctx 客户端根上下文
     */
    module.exports.apply = function apply(ctx) {
      if (!ctx || !ctx.slots || typeof ctx.slots.inject !== 'function') return;

      ctx.inject(['settingsScope'], function (scoped) {
        var service = scoped && scoped.settingsScope;
        if (!service || typeof service.bind !== 'function') return;

        var bound;
        try {
          bound = service.bind({ namespace: NS });
        } catch {
          return;
        }
        if (!bound || typeof bound.getSnapshot !== 'function' || typeof bound.subscribe !== 'function') return;

        ctx.slots.inject('settings.plugin.item', function () {
          return ctx.slots.register(
            {
              name: 'settings.plugin.item',
              key: PKG + '#' + ROW_ID,
              inject: function () { return { settingsScope: bound, ctx: ctx }; },
            },
            StatusEntry,
          );
        });
      });
    };

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

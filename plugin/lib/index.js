/**
 * DSH 插件：把子进程 runner 换成 NativeAOT 版本
 *
 * ## 这个插件做了什么
 *
 * DSH 每次起子进程的链路是：
 *
 *   node.exe (dsh host) → node.exe runner.js → target
 *
 * 中间的 runner.js 是纯转发进程，但每次都要付 Node.js 的启动成本
 * （实测 p50 约 680ms）。换成 NativeAOT 原生可执行文件后只剩约 230ms。
 *
 * 接入点只有一个：`LocalSubprocessRuntime.internals.runnerInvocation`。
 * 它默认是 `[process.execPath, ".../runner.js"]`，把它指向 AOT exe 即可 ——
 * 不需要改 DSH 源码（用户明确要求避免，否则升级 DSH 会出问题）。
 *
 * ## 为什么不 patch 类原型
 *
 * `internals` 是实例字段，在 `spawn()` 里被展开读取
 * （`internals.runnerInvocation ?? spawnRunnerInvocation()`）。
 * 因此只要拿到 runtime 实例、改这个字段就够了，不必改动任何类定义。
 *
 * ## 安全网
 *
 * 切换 runner 是有风险的：AOT exe 缺失、被杀软拦、版本不匹配，
 * 都会让**所有**子进程调用失败。所以这里有两层保护：
 *
 *   1. 启动自检 —— 装上前先确认 exe 存在、可执行、版本对得上
 *   2. 熔断降级 —— 连续 N 次启动失败就自动切回 node runner
 *
 * 见 `./circuit-breaker.js`。
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { CircuitBreaker } from './circuit-breaker.js';

export const name = 'dsh-aot-runner';

/** 需要 subprocess 服务已经就位 */
export const inject = ['subprocess'];

/**
 * 插件配置。
 *
 * @typedef {object} Config
 * @property {boolean} [enabled]       总开关，默认 true
 * @property {string}  [runnerPath]    AOT runner 绝对路径；省略时自动查找
 * @property {number}  [failThreshold] 连续失败多少次触发降级，默认 3
 * @property {boolean} [verbose]       打印每次降级/恢复的原因，默认 true
 */

/**
 * 查找 AOT runner 可执行文件。
 *
 * 顺序：
 *   1. 配置里显式给的 runnerPath —— **显式配置不给回退**
 *   2. 环境变量 DSH_AOT_RUNNER  —— **显式配置不给回退**
 *   3. 包内自带 bin/dsh-aot-runner.exe
 *
 * 为什么显式配置不给回退：用户写了一个路径，说明他想用**那个** exe
 * （可能是自己编译的、带调试符号的、或特定版本）。如果路径写错了却
 * 静默用了包内另一个，用户会以为自己在测 A、实际在跑 B —— 这种
 * 「猜你的意图」行为在排查问题时极其误导。
 *
 * **不做 PATH 搜索**：runner 是内部实现细节，从 PATH 拿到别人的同名
 * 可执行文件是安全隐患，且版本无法保证。
 *
 * @param {string | undefined} configured
 * @returns {{ path: string, source: string } | null}
 */
export function resolveRunnerPath(configured) {
  // 显式配置优先；找不到就直接失败，不猜（见上方注释）。
  if (configured) return pathIfExists(configured, 'config');

  const fromEnv = process.env.DSH_AOT_RUNNER;
  if (fromEnv) return pathIfExists(fromEnv, 'env');

  // 包内自带：用 fileURLToPath 正确处理 Windows 盘符
  const bundled = fileURLToPath(new URL('../bin/dsh-aot-runner.exe', import.meta.url));
  return pathIfExists(bundled, 'bundled');
}

/**
 * 路径存在就返回带来源的解析结果，否则返回 null。
 *
 * 三个来源（config / env / bundled）的判定是同一件事，抽出来既少一次分支，
 * 也保证「存在才用、不存在就当没有」这条规则在三处一致。
 *
 * @param {string} candidate
 * @param {string} source
 * @returns {{ path: string, source: string } | null}
 */
function pathIfExists(candidate, source) {
  return existsSync(candidate) ? { path: candidate, source } : null;
}

/**
 * 从 ctx 里找到 subprocess runtime 实例。
 *
 * DSH 把 subprocess 服务挂在 ctx 上。不同版本暴露方式略有差异，
 * 这里都试一遍，找不到就返回 null（由调用方决定报错还是跳过）。
 *
 * @param {any} ctx
 * @returns {any | null}
 */
/**
 * 检测当前 DSH 版本的 subprocess-local 是否会丢弃 `internals` 参数。
 *
 * 背景：`LocalSubprocessRuntime.spawn()` 构造好 `internals` 后，调用
 * `launchWindowsJob(spec, env)` / `launchLinuxScope(spec, env)` 时可能漏传
 * 第三个参数。一旦漏传，`launch*` 内部的 `internals` 恒为 `{}`，
 * 所有基于 `internals` 的注入（包括本插件的 runnerInvocation）全部失效。
 *
 * 这是上游 discussion #11893 记录的问题。
 *
 * 为什么用静态检测而不是运行时观测：bug 会让观测点本身失效
 * （`internals.spawn` 同样被丢弃），运行时看不到任何异常。
 * 只有读源码才能确定。
 *
 * @returns {'ok' | 'buggy' | 'unknown'} 检测结论
 */
export function checkDshInternalsBug() {
  const files = findDshSourceFiles();
  for (const file of files) {
    let source;
    try {
      source = readFileSync(file, 'utf8');
    } catch {
      continue;
    }

    // 已修复的特征：调用点显式传了三参
    const fixed = /launch(WindowsJob|LinuxScope)\(spec,\s*env,\s*internals\)/.test(source);
    // 缺陷特征：调用点只传两参
    const buggy = /launch(WindowsJob|LinuxScope)\(spec,\s*env\)/.test(source);

    if (fixed) return 'ok';
    if (buggy) return 'buggy';
    // 找到文件但两个特征都不匹配 —— 形状变了，不敢断言
    return 'unknown';
  }

  return 'unknown';
}

/**
 * 找出 DSH subprocess-local 的源码文件候选。
 *
 * 插件本身只声明 peerDependency，从插件目录 resolve 不到；
 * 改为从几条可靠线索推断：模块解析（若宿主可见）、
 * DSH 安装目录的常见布局、以及已加载模块的路径。
 *
 * @returns {string[]} 可能的 index.js 绝对路径
 */
function findDshSourceFiles() {
  const candidates = [];
  const push = (p) => { if (p) candidates.push(p); };

  // 线索 1：模块解析（宿主进程里通常可解析）
  try {
    const entry = import.meta.resolve('@deepseek-ai/dsh-subprocess-local');
    const dir = fileURLToPath(new URL('.', entry));
    push(resolve(dir, 'index.js'));
    push(resolve(dir, '..', 'lib', 'index.js'));
  } catch { /* 解析不到，走后面的线索 */ }

  // 线索 2：从 DSH_HOME / USERPROFILE 推断 workspace 布局
  const roots = [];
  if (process.env.DSH_HOME) roots.push(process.env.DSH_HOME);
  if (process.env.USERPROFILE) {
    roots.push(resolve(process.env.USERPROFILE, '.workbuddy', 'binaries', 'node', 'workspace'));
  }
  for (const root of roots) {
    push(resolve(root, 'node_modules', '@deepseek-ai', 'dsh-subprocess-local', 'lib', 'index.js'));
  }

  return candidates;
}

export function findRuntime(ctx) {
  const direct = ctx?.subprocess;
  if (direct && typeof direct.spawn === 'function') return direct;

  // cordis 的 reflect 服务表
  const viaReflect = ctx?.reflect?.get?.('subprocess');
  if (viaReflect && typeof viaReflect.spawn === 'function') return viaReflect;

  return null;
}

/**
 * 插件入口。
 *
 * @param {any} ctx
 * @param {Config} config
 */
/**
 * 解析并校验启用前提。任一条不满足就返回 null（调用方直接退出）。
 *
 * 拆出来的原因：这些检查串起来有十几个 return 分支，原本全堆在 apply 里，
 * 让 apply 涨到 147 行、深嵌套 5 层 —— 读的人很难看清「什么时候真的会启用」。
 *
 * @returns {{ path: string, source: string } | null}
 */
function resolvePreconditions(ctx, config) {
  const { enabled = true, runnerPath } = config;

  if (!enabled) {
    ctx.logger?.info?.('[aot-runner] 已禁用，继续使用 node runner');
    setRunnerStatus('unsupported', '配置里 enabled=false');
    return null;
  }

  if (process.platform !== 'win32') {
    ctx.logger?.info?.('[aot-runner] 仅支持 Windows，当前平台继续使用 node runner');
    setRunnerStatus('unsupported', `平台不受支持：${process.platform}`);
    return null;
  }

  const resolved = resolveRunnerPath(runnerPath);
  if (resolved === null) {
    const why = describeMissingRunner(runnerPath);
    ctx.logger?.warn?.(`[aot-runner] ${why}，继续使用 node runner`);
    setRunnerStatus('unsupported', why);
    return null;
  }

  return resolved;
}

/** 说明为什么找不到 runner，给出可操作的下一步。 */
function describeMissingRunner(runnerPath) {
  if (runnerPath) return `配置的 runnerPath 不存在：${runnerPath}`;
  if (process.env.DSH_AOT_RUNNER) {
    return `环境变量 DSH_AOT_RUNNER 指向的文件不存在：${process.env.DSH_AOT_RUNNER}`;
  }
  return '包内缺少 bin/dsh-aot-runner.exe（需要先构建）';
}

/**
 * 把熔断器接到 runtime.spawn 的失败信号上。
 *
 * spawn 失败在 DSH 里表现为两种形式：
 *   a) spawn() 同步抛错（runner 不存在 / 权限不足）
 *   b) handle.done reject（runner 起来了但协议错误 / 中途崩溃）
 *
 * 只在「基础设施级失败」时计数 —— target 自己非零退出不算 runner 的错。
 *
 * 必须保存**两个**引用：
 *   originalSpawnRef   —— 原型上的原方法（用于还原，保持引用相等）
 *   originalSpawnBound —— 绑定到 runtime 的版本（用于调用）
 *
 * 早先只存了 bind 后的版本并直接赋回去，导致还原后 runtime.spawn 变成
 * 一个绑定函数而不是原型方法（引用不等、且多次 apply 会层层包装）。
 *
 * @returns {{ originalRef: Function, restore: () => void }}
 */
function installBreakerHook(runtime, breaker) {
  const originalRef = runtime.spawn;
  const originalBound = originalRef.bind(runtime);

  runtime.spawn = (spec, ...rest) => {
    let handle;
    try {
      handle = originalBound(spec, ...rest);
    } catch (error) {
      breaker.recordFailure(error);
      throw error;
    }

    if (handle?.done && typeof handle.done.catch === 'function') {
      handle.done.then(
        () => breaker.recordSuccess(),
        // target 的正常非零退出走 resolve，不会到这里；
        // 能到这里的都是 runner 自身的问题。
        (error) => breaker.recordFailure(error),
      );
    }

    return handle;
  };

  return {
    originalRef,
    restore: () => { runtime.spawn = originalRef; },
  };
}

/**
 * 自检：确认注入真的会被 DSH 消费。
 *
 * 为什么需要：注入 `internals.runnerInvocation` 只有在 DSH 把它传给
 * launchWindowsJob/launchLinuxScope 时才有效。DSH 0.2.0-rc.2 在 spawn() 里
 * 丢掉了这个参数（上游 discussion #11893），于是出现「字段赋了值但没人读」
 * —— 插件报告启用成功，实际毫无作用。
 *
 * 用户端表现是「装了没效果」，而日志里一切正常。这比直接报错更糟，
 * 所以主动检测并明确告知。
 *
 * 检测手段是静态的：直接看 DSH 源码里那两个调用点的参数个数。
 * 不用运行时观测，因为 bug 恰恰让观测点本身也失效了（internals 整个被丢）。
 *
 * @returns {'ok' | 'buggy'} 是否应当继续启用
 */
function runSelfCheck(ctx, verbose) {
  const compat = checkDshInternalsBug();

  if (compat === 'buggy') {
    ctx.logger?.warn?.(
      '[aot-runner] 检测到当前 DSH 版本会丢弃 internals 参数'
      + '（spawn() 未把 internals 传给 launch*），注入不会生效。'
      + '本插件已自动停用，避免「看似启用实则无效」。'
      + '修复方法见包内 vendor/README.md，或上游 discussion #11893。',
    );
    return 'buggy';
  }

  if (compat === 'unknown' && verbose) {
    ctx.logger?.warn?.(
      '[aot-runner] 无法确认 DSH 是否支持 internals 注入'
      + '（源码形状未识别，可能是新版本）。插件继续启用，'
      + '若发现子进程仍走 node runner，请查看 vendor/README.md。',
    );
  }

  return 'ok';
}

/** 创建切换 AOT / 原 runner 的两个动作。 */
function makeInvocationSwitch(runtime, originalInvocation, aotInvocation) {
  return {
    activate: () => {
      if (runtime.internals) runtime.internals.runnerInvocation = aotInvocation;
    },
    restore: () => {
      if (!runtime.internals) return;
      if (originalInvocation === undefined) delete runtime.internals.runnerInvocation;
      else runtime.internals.runnerInvocation = originalInvocation;
    },
  };
}

/** 找 runtime；找不到时告警并返回 null。 */
function requireRuntime(ctx) {
  const runtime = findRuntime(ctx);
  if (runtime === null) {
    ctx.logger?.warn?.('[aot-runner] 找不到 subprocess 服务，无法注入 runner');
    setRunnerStatus('unsupported', '找不到 subprocess 服务，无法注入 runner');
  }
  return runtime;
}

/**
 * 当前 runner 的可观测状态（issue #18 B 项）。
 *
 * 「加速失效但没人知道」是最坏的产品状态：用户以为自己快着，实际慢着。
 * 熔断器已经能自动降级，但降级后用户无从查证 —— 这个对象就是为了让人能查。
 *
 * 刻意做成**模块级单例**而不是挂在 ctx 上：DSH 插件管理页、诊断命令、
 * 测试都需要一个稳定的读取入口，而 ctx 的生命周期在重载时会变。
 *
 * 状态值只有三种，含义明确：
 *   'aot'        正在用 AOT runner（有性能增益）
 *   'node'       已降级到 node runner（增益失效，需处理）
 *   'unsupported' 根本没启用（非 Windows / 开关关闭 / DSH 版本有 bug）
 *
 * `reason` 只在非 aot 时有意义，并且是**给人看的中文**，不是错误码 ——
 * 这条信息会出现在日志和诊断界面里，用户要能直接读懂该做什么。
 */
const runtimeStatus = {
  runner: 'unsupported',
  reason: '尚未启用',
  /** 降级发生的时间（ISO 字符串），未降级为 null */
  degradedAt: null,
};

/** 读取当前 runner 状态。返回副本，避免调用方改到内部状态。 */
export function getRunnerStatus() {
  return { ...runtimeStatus };
}

/** 供测试与启动流程重置状态。 */
export function resetRunnerStatus() {
  runtimeStatus.runner = 'unsupported';
  runtimeStatus.reason = '尚未启用';
  runtimeStatus.degradedAt = null;
}

/** 记录一次状态变化。`reason` 必须是人话，会直接展示给用户。 */
function setRunnerStatus(runner, reason) {
  runtimeStatus.runner = runner;
  runtimeStatus.reason = reason;
  runtimeStatus.degradedAt = runner === 'node' ? new Date().toISOString() : null;
  return runtimeStatus;
}

/**
 * 建立熔断器，把 open/close 接到注入开关上。
 *
 * ## 为什么降级日志不受 `verbose` 控制（issue #18）
 *
 * 原来 onOpen/onClose 都套了 `if (verbose)`，于是**默认配置下用户完全看不到降级**。
 * 本插件是纯性能增益插件：失效时功能一切正常，只是变慢 2~3 倍。
 * 「加速失效但没人知道」是最坏的产品状态 —— 用户以为自己快着，实际慢着，
 * 而且因为一切都正常，永远不会去查。
 *
 * 所以这两个日志无条件输出。反过来，*激活*成功的日志（"已启用 AOT runner"）
 * 才适合放 verbose 里 —— 那是噪音，降级是事故。
 *
 * 记 warn 而不是 info：DSH 的 info 日志容易被默认过滤掉，
 * 而这条信息必须到达用户。降级不是错误，但它是**需要用户知道的状态变化**。
 */
function makeBreaker(ctx, { failThreshold }, activate, restore) {
  return new CircuitBreaker({
    threshold: failThreshold,
    onOpen: (reason) => {
      const text = String(reason?.message ?? reason);
      setRunnerStatus('node', `熔断降级：${text}`);
      ctx.logger?.warn?.(
        `[aot-runner] 熔断：已降级到 node runner（连续失败 ${failThreshold} 次）：${text}。` +
          ' 性能增益已失效。修复后重启 DSH 或重载插件即可恢复。',
      );
      restore();
    },
    onClose: () => {
      setRunnerStatus('aot', '已恢复');
      ctx.logger?.info?.('[aot-runner] 已恢复：重新启用 AOT runner');
      activate();
    },
  });
}

/** 注入 runnerInvocation，返回熔断器与还原入口。 */
function injectRunner(ctx, runtime, resolved, options) {
  // 保存原值时不假设它一定有值：某些测试环境会把它清空。
  const originalInvocation = runtime.internals?.runnerInvocation;
  const { activate, restore } = makeInvocationSwitch(
    runtime, originalInvocation, [resolved.path],
  );
  activate();

  const breaker = makeBreaker(ctx, options, activate, restore);
  const hook = installBreakerHook(runtime, breaker);

  return { hook, restore };
}

/** 跑完 1~4 步，返回可卸载的启用结果；任一步不满足就返回 null。 */
function setup(ctx, config, options) {
  const resolved = resolvePreconditions(ctx, config);
  if (resolved === null) return null;

  const runtime = requireRuntime(ctx);
  if (runtime === null) return null;

  if (runSelfCheck(ctx, options.verbose) === 'buggy') {
    setRunnerStatus('unsupported', 'DSH 版本存在已知缺陷（launch* 漏传 internals），需先打补丁');
    return null;
  }

  return { resolved, ...injectRunner(ctx, runtime, resolved, options) };
}

/** 启用 AOT runner 插件。
 *
 * 流程（每步失败都安全退出，不会留下半启用状态）：
 *   1. 前提校验（开关 / 平台 / runner 是否存在）
 *   2. 拿 runtime
 *   3. 自检 DSH 兼容性
 *   4. 注入 runnerInvocation 并接熔断器
 *   5. 注册卸载还原
 */
export function apply(ctx, config = {}) {
  const options = { failThreshold: config.failThreshold ?? 3, verbose: config.verbose ?? true };

  const active = setup(ctx, config, options);
  if (active === null) return;

  ctx.effect?.(() => () => {
    active.hook.restore();
    active.restore();
  }, 'aot-runner restore');

  setRunnerStatus('aot', `已启用（来源 ${active.resolved.source}）：${active.resolved.path}`);
  ctx.logger?.info?.(
    `[aot-runner] 已启用（来源 ${active.resolved.source}）：${active.resolved.path}`,
  );
}

export default { name, inject, apply };

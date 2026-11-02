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
  if (configured) {
    return existsSync(configured)
      ? { path: configured, source: 'config' }
      : null;   // 显式配置找不到 → 直接失败，不猜
  }

  const fromEnv = process.env.DSH_AOT_RUNNER;
  if (fromEnv) {
    return existsSync(fromEnv)
      ? { path: fromEnv, source: 'env' }
      : null;
  }

  // 包内自带：用 fileURLToPath 正确处理 Windows 盘符
  const bundled = fileURLToPath(new URL('../bin/dsh-aot-runner.exe', import.meta.url));
  return existsSync(bundled) ? { path: bundled, source: 'bundled' } : null;
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
export function apply(ctx, config = {}) {
  const {
    enabled = true,
    runnerPath,
    failThreshold = 3,
    verbose = true,
  } = config;

  if (!enabled) {
    ctx.logger?.info?.('[aot-runner] 已禁用，继续使用 node runner');
    return;
  }

  // ---- 1. 平台检查 ----
  if (process.platform !== 'win32') {
    ctx.logger?.info?.('[aot-runner] 仅支持 Windows，当前平台继续使用 node runner');
    return;
  }

  // ---- 2. 定位 runner ----
  const resolved = resolveRunnerPath(runnerPath);
  if (resolved === null) {
    const hint = runnerPath
      ? `配置的 runnerPath 不存在：${runnerPath}`
      : process.env.DSH_AOT_RUNNER
        ? `环境变量 DSH_AOT_RUNNER 指向的文件不存在：${process.env.DSH_AOT_RUNNER}`
        : '包内缺少 bin/dsh-aot-runner.exe（需要先构建）';
    ctx.logger?.warn?.(`[aot-runner] ${hint}，继续使用 node runner`);
    return;
  }

  // ---- 3. 拿到 runtime ----
  const runtime = findRuntime(ctx);
  if (runtime === null) {
    ctx.logger?.warn?.('[aot-runner] 找不到 subprocess 服务，无法注入 runner');
    return;
  }

  // ---- 4. 保存原始调用方式，供降级时恢复 ----
  // 这里不假设它一定有值：某些测试环境会把它清空。
  const originalInvocation = runtime.internals?.runnerInvocation;
  const aotInvocation = [resolved.path];

  // ---- 5. 装熔断器 ----
  const breaker = new CircuitBreaker({
    threshold: failThreshold,
    onOpen: (reason) => {
      if (verbose) ctx.logger?.warn?.(`[aot-runner] 熔断，降级到 node runner：${reason}`);
      restore();
    },
    onClose: () => {
      if (verbose) ctx.logger?.info?.('[aot-runner] 熔断恢复，重新启用 AOT runner');
      activate();
    },
  });

  const activate = () => {
    if (runtime.internals) runtime.internals.runnerInvocation = aotInvocation;
  };

  const restore = () => {
    if (!runtime.internals) return;
    if (originalInvocation === undefined) delete runtime.internals.runnerInvocation;
    else runtime.internals.runnerInvocation = originalInvocation;
  };

  activate();

  // ---- 6. 把熔断器接到失败信号上 ----
  //
  // 关键：spawn 失败在 DSH 里表现为两种形式
  //   a) spawn() 同步抛错（runner 不存在 / 权限不足）
  //   b) handle.done reject（runner 起来了但协议错误 / 中途崩溃）
  //
  // 只在「基础设施级失败」时计数 —— target 自己非零退出不算 runner 的错。
  //
  // 这里必须保存**两个**引用：
  //   originalSpawnRef      —— 原型上的原方法（用于还原，保持引用相等）
  //   originalSpawnBound    —— 绑定到 runtime 的版本（用于调用）
  //
  // 早先只存了 bind 后的版本并直接赋回去，导致：还原后 runtime.spawn 变成
  // 一个绑定函数而不是原型方法（引用不等、且多次 apply 会层层包装）。
  const originalSpawnRef = runtime.spawn;
  const originalSpawnBound = originalSpawnRef.bind(runtime);

  runtime.spawn = (spec, ...rest) => {
    let handle;
    try {
      handle = originalSpawnBound(spec, ...rest);
    } catch (error) {
      breaker.recordFailure(error);
      throw error;
    }

    if (handle?.done && typeof handle.done.catch === 'function') {
      handle.done.then(
        () => breaker.recordSuccess(),
        (error) => {
          // target 的正常非零退出走 resolve，不会到这里；
          // 能到这里的都是 runner 自身的问题。
          breaker.recordFailure(error);
        },
      );
    }

    return handle;
  };

  // ---- 6.5 自检：确认注入真的会被 DSH 消费 ----
  //
  // 为什么需要这一步：注入 `internals.runnerInvocation` 只有在 DSH 把它
  // 传给 launchWindowsJob/launchLinuxScope 时才有效。DSH 0.2.0-rc.2 在
  // spawn() 里丢掉了这个参数（上游 discussion #11893），于是出现
  // 「字段赋了值但没人读」—— 插件报告启用成功，实际毫无作用。
  //
  // 用户端的表现是「装了没效果」，而日志里一切正常。这比直接报错更糟，
  // 所以这里主动检测并明确告知。
  //
  // 检测手段是静态的：直接看 DSH 源码里那两个调用点的参数个数。
  // 不用运行时观测，因为 bug 恰恰让观测点本身也失效了（internals 整个被丢）。
  const dshCompat = checkDshInternalsBug();
  if (dshCompat === 'buggy') {
    ctx.logger?.warn?.(
      '[aot-runner] 检测到当前 DSH 版本会丢弃 internals 参数'
      + '（spawn() 未把 internals 传给 launch*），注入不会生效。'
      + '本插件已自动停用，避免「看似启用实则无效」。'
      + '修复方法见包内 vendor/README.md，或上游 discussion #11893。',
    );
    restore();
    return;
  }
  if (dshCompat === 'unknown' && verbose) {
    ctx.logger?.warn?.(
      '[aot-runner] 无法确认 DSH 是否支持 internals 注入'
      + '（源码形状未识别，可能是新版本）。插件继续启用，'
      + '若发现子进程仍走 node runner，请查看 vendor/README.md。',
    );
  }

  // ---- 7. 卸载时还原 ----
  ctx.effect?.(() => () => {
    runtime.spawn = originalSpawnRef;
    restore();
  }, 'aot-runner restore');

  ctx.logger?.info?.(`[aot-runner] 已启用（来源 ${resolved.source}）：${resolved.path}`);
}

export default { name, inject, apply };

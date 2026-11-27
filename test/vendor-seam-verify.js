#!/usr/bin/env node
/**
 * vendor 补丁的**端到端接缝**验证：补丁打了之后，DSH 是否真的改用 AOT runner。
 *
 * ## 要防的是什么
 *
 * `vendor/README.md` 里写着「打完这 1 行补丁，`internals.runnerInvocation` 注入链路就是通的」。
 * 这句话在 2026-11-26 之前**只被 0.2.0-rc.2 支持**，而 `0.2.3-alpha.2` 把这行代码改写过了
 * （`containmentMode` → `linuxScope === void 0`），谁都没验过补丁在新写法上是否仍然有效。
 *
 * 2026-11-26 实测确认有效，证据是「host 的直接子进程从 node.exe 变成 dsh-aot-runner.exe」。
 * 本文件把那次手工实验固化成回归测试 —— 不然它只是一条写在文档里的、会腐坏的结论。
 *
 * ## 为什么这条判据值得单独测
 *
 * 有三条更弱的判据都**不是**这里要测的：
 *
 * | 判据 | 为什么不够 |
 * |---|---|
 * | `apply` 返回 0 | 只证明字符串替换成功，不证明注入被采纳 |
 * | `launchWindowsJob` 收到了 internals | 太靠近实现，重构就会假红 |
 * | 子进程 stdout 正确 | node runner 也会给出正确的 stdout，区分不了「谁在跑」 |
 *
 * 只有「**host 的直接子进程是哪个 exe**」同时满足「可观测」和「区分得开」。
 *
 * ## 为什么用 PPID 而不是按名字 grep 全进程表
 *
 * 第一版就是 grep 全表的，结果**补丁前也报「AOT 进程存在」** —— 本机正在跑 DSH，
 * 它自己就是 `dsh-aot-runner.exe` 的父进程。按 `ParentProcessId == 本进程 pid` 过滤后
 * 才得到干净的、唯一的判据。同一个坑 `docs/TODO.md` 的「归因要多点采样」一节记过。
 *
 * ## 前置条件
 *
 * - 需要 Windows + 已构建的 `dist/dsh-aot-runner.exe`（没有就 SKIP，不算通过）
 * - 需要能解析到 `@deepseek-ai/dsh-subprocess-local`（没有就 SKIP）
 * - 不做任何写入：只在临时目录里放一份**改过的副本**，**不碰真实的 node_modules**
 *
 * ## 用法
 *
 *   node test/vendor-seam-verify.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { execSync } = require('node:child_process');
const {
  existsSync, mkdtempSync, mkdirSync, copyFileSync, readFileSync, readdirSync, writeFileSync, rmSync,
} = require('node:fs');
const { tmpdir } = require('node:os');
const { resolve, join } = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = resolve(__dirname, '..');
const AOT_EXE = resolve(ROOT, 'dist', 'dsh-aot-runner.exe');

/** 从 patch-dsh.mjs 里抽出形态表 —— 与 patch-shapes-verify.js 同一份提取逻辑。 */
function extractShapes() {
  const src = readFileSync(resolve(ROOT, 'vendor', 'patch-dsh.mjs'), 'utf8');
  const block = src.match(/const SHAPES = \[([\s\S]*?)\n\];/);
  if (!block) return [];
  const shapes = [];
  const re = /id:\s*'([^']+)'[\s\S]*?before:\s*\n?\s*'([^']+)'[\s\S]*?after:\s*\n?\s*'([^']+)'/g;
  let m;
  while ((m = re.exec(block[1])) !== null) shapes.push({ id: m[1], before: m[2], after: m[3] });
  return shapes;
}

/**
 * 解析已安装的 dsh-subprocess-local 的 `lib` 目录；找不到返回 null。
 *
 * 用仓库既有的 `locate-contract-package.mjs`，**不自己写一套查找逻辑**：
 * 那个模块的查找顺序（DSH_HOME 同级 workspace → USERPROFILE 下 workspace →
 * 仓库根 → 仓库内一层子目录）已经被 `contract-fingerprint` /
 * `contract-branch-coverage` / release.yml 三处验证过，而且它已经踩过
 * 「装到 baseline/ 下就找不到」的坑。
 *
 * 直接 `require.resolve` 在这里是**错的**：本仓库自己不是 DSH 的 workspace，
 * 实测从仓库根解析不到这个包，于是测试会永远 SKIP ——
 * 看起来「没问题」，实际什么都没验。
 *
 * 它不是 CJS 模块，只能同步读一遍源码再 `import()`；为了保持本文件顶层同步，
 * 这里用 `createRequire` + 子进程 **不可行**（会丢模块实例），
 * 所以改用下面这个同步版：直接按同一套候选顺序探测。
 */
function resolveLibDir() {
  // 与 scripts/lib/locate-contract-package.mjs 的 candidateWorkspaceRoots 同序。
  const roots = [];
  if (process.env.DSH_HOME) {
    roots.push(join(process.env.DSH_HOME, '..', '.workbuddy', 'binaries', 'node', 'workspace'));
  }
  if (process.env.USERPROFILE) {
    roots.push(join(process.env.USERPROFILE, '.workbuddy', 'binaries', 'node', 'workspace'));
  }
  roots.push(ROOT);

  const pkgDirs = roots.map((r) => join(r, 'node_modules', '@deepseek-ai', 'dsh-subprocess-local'));
  for (const d of pkgDirs) if (existsSync(join(d, 'lib'))) return join(d, 'lib');
  return null;
}

/** 列出某 pid 的直接子进程（只用 Name，够判断「谁在跑」）。 */
function directChildren(pid) {
  const script =
    `Get-CimInstance Win32_Process -Filter "ParentProcessId=${pid}" | ` +
    'Select-Object -ExpandProperty Name';
  try {
    const out = execSync(
      `powershell.exe -NoProfile -Command "${script.replace(/"/g, '\\"')}"`,
      { encoding: 'utf8', timeout: 20000, windowsHide: true },
    ).trim();
    return out ? out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean) : [];
  } catch {
    return [];
  }
}

/**
 * 在临时目录里造一份 dsh-subprocess-local 副本，`patched` 决定打不打补丁。
 * **迁移目标是副本，不是 node_modules** —— 这个测试永远不写用户的安装目录。
 */
function makeCopy(libDir, shape, patched, currentlyPatched) {
  const dir = mkdtempSync(join(tmpdir(), 'vendor-seam-'));
  const lib = join(dir, 'lib');
  mkdirSync(lib, { recursive: true });
  for (const f of ['output.js', 'runner.js']) {
    const src = join(libDir, f);
    if (existsSync(src)) copyFileSync(src, join(lib, f));
  }
  // 契约 bundle 的文件名带内容哈希，按前缀找而不是写死。
  for (const f of readdirSync(libDir)) {
    if (/^runner-launch-.*\.js$/.test(f)) copyFileSync(join(libDir, f), join(lib, f));
  }
  copyFileSync(join(libDir, '..', 'package.json'), join(dir, 'package.json'));

  let index = readFileSync(join(libDir, 'index.js'), 'utf8');
  // 本机安装的那份**可能已经是打过补丁的**（本项目自己的开发机就是）。
  // 先归一化到原始版本，再按 `patched` 决定要不要打 —— 否则
  // 「原始版本」那一组拿到的其实也是补丁后的文件，两组就退化成同一个实验。
  if (currentlyPatched) index = index.replace(shape.after, shape.before);
  if (patched) index = index.replace(shape.before, shape.after);
  writeFileSync(join(lib, 'index.js'), index);
  return dir;
}

/** 用指定副本起一个 LocalSubprocessRuntime，注入 AOT exe，返回它的直接子进程名。 */
async function childNamesFor(libDir, copyDir) {
  const mod = await import(pathToFileURL(join(copyDir, 'lib', 'index.js')).href + `?v=${Date.now()}`);
  const ctx = {
    reflect: { provide() {}, set() {}, get() {} },
    effect: (fn) => fn(),
    logger: { warn() {}, info() {}, error() {}, debug() {} },
  };
  const runtime = new mod.LocalSubprocessRuntime(ctx);
  runtime.internals = { runnerInvocation: [AOT_EXE] };

  const handle = runtime.spawn({
    argv: ['cmd.exe', '/c', 'ping -n 4 127.0.0.1 >nul'],
    cwd: process.cwd(),
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ComSpec: process.env.ComSpec, PATHEXT: process.env.PATHEXT },
    stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', control: undefined },
    graceMs: 5000,
  });

  // 给 runner 留出被 spawn 的时间，再抓快照。
  await new Promise((r) => setTimeout(r, 800));
  const names = directChildren(process.pid);

  try { handle.terminate(); } catch { /* 已被 kill 掉 */ }
  await handle.done.catch(() => {});
  await handle.waitForExit().catch(() => {});
  return names;
}

const libDir = process.platform === 'win32' ? resolveLibDir() : null;
const SHAPES = extractShapes();

const skipReason =
  process.platform !== 'win32'
    ? '仅 Windows 有意义（本项目 runner 是 Windows 原生实现）'
    : !existsSync(AOT_EXE)
      ? `缺少 ${AOT_EXE} —— 先跑 ./build.sh 构建`
      : !libDir
        ? '解析不到 @deepseek-ai/dsh-subprocess-local'
        : undefined;

// ⚠️ 传的是 `undefined` 而**不是 `null`**：实测（Node 26）
// `test(name, { skip: null }, fn)` 仍然会把用例标成 SKIP 并且不执行 fn。
// 这是很容易踩的：条件不成立时「顺手写 null」看起来天经地义，
// 结果测试永远绿——而且是以「跳过」的形式绿，比失败更难发现。
// （`{ skip: undefined }` 与不传 skip 等价。）
const skipOpts = skipReason === undefined ? {} : { skip: skipReason };

test('vendor 补丁：打完补丁后 host 的确改用了 AOT runner', skipOpts, async () => {
  // 找到当前安装版本能对上的形态；一个都对不上说明上游又改了写法，直接失败。
  const installedIndex = readFileSync(join(libDir, 'index.js'), 'utf8');
  const shape =
    SHAPES.find((s) => installedIndex.includes(s.before)) ??
    SHAPES.find((s) => installedIndex.includes(s.after));

  assert.ok(
    shape,
    '当前安装的 DSH 版本对不上形态表里任何一条 —— 上游又改了写法。' +
      `请核对 ${join(libDir, 'index.js')} 里 launchWindowsJob 的调用行，并往 ` +
      'vendor/patch-dsh.mjs 的 SHAPES 里补一条（否则用户装不上且只能靠人撞到）。',
  );

  const currentlyPatched = installedIndex.includes(shape.after);
  const pristineDir = makeCopy(libDir, shape, false, currentlyPatched);
  const patchedDir = makeCopy(libDir, shape, true, currentlyPatched);
  try {
    const pristineKids = await childNamesFor(libDir, pristineDir);
    const patchedKids = await childNamesFor(libDir, patchedDir);

    assert.ok(
      pristineKids.some((n) => /^node(\.exe)?$/i.test(n)),
      `未打补丁时 host 的直接子进程应是 node.exe，实际: ${JSON.stringify(pristineKids)}。` +
        '若这里失败，说明「不打补丁插件不生效」这个前提本身变了 —— 请复核上游是否已修复。',
    );
    assert.ok(
      patchedKids.some((n) => /dsh-aot-runner(\.exe)?$/i.test(n)),
      `打完补丁后 host 的直接子进程应是 dsh-aot-runner.exe，实际: ${JSON.stringify(patchedKids)}。` +
        `补丁形态 ${shape.id} 可能已失效。`,
    );
  } finally {
    // 临时目录用完即删 —— 不留下任何「看起来像 node_modules」的残留。
    for (const d of [pristineDir, patchedDir]) rmSync(d, { recursive: true, force: true });
  }
});

test('形态表里的每一条都覆盖到「补上 internals」这一语义', () => {
  assert.ok(SHAPES.length >= 2, `期望 >= 2 个形态，实际 ${SHAPES.length}`);
  for (const s of SHAPES) {
    assert.ok(
      /internals\)/.test(s.after),
      `形态 ${s.id} 的 after 没有把 internals 补进实参表`,
    );
  }
});

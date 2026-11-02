#!/usr/bin/env node
/**
 * DSH 上游补丁管理工具
 *
 * ## 为什么需要这个
 *
 * `LocalSubprocessRuntime.spawn()`（lib/index.js:1368）调用
 * `launchWindowsJob(spec, env)` / `launchLinuxScope(spec, env)` 时漏传第三个参数
 * `internals`，导致 launch* 内部 `internals` 恒为 `{}`，
 * `internals.runnerInvocation` 被完全忽略 —— AOT runner 插件因此不生效。
 *
 * 上游讨论：https://github.com/deepseek-ai/deepseek-harness/discussions/11893
 *
 * 本脚本负责三件事：检查当前状态、施加补丁、还原原始文件。
 * 补丁只有 1 行，语义等价于上游修好后的样子。
 *
 * ## 用法
 *
 *   node vendor/patch-dsh.mjs status     # 查看当前状态（默认）
 *   node vendor/patch-dsh.mjs apply      # 打补丁
 *   node vendor/patch-dsh.mjs revert     # 还原
 *   node vendor/patch-dsh.mjs --help
 *
 * ## 什么时候会失效
 *
 * DSH 升级、`pnpm install`、重装依赖 —— 任何重写 node_modules 的操作
 * 都会覆盖补丁。届时重跑 `apply` 即可；若上游已修复，脚本会明确告知。
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const VENDOR = HERE;
const ORIG_PATH = path.join(VENDOR, 'dsh-subprocess-local-0.2.0-rc.2', 'index.js.orig');

const ORIG_MD5 = '0b4485aae7cb41ea37c40e086926408c';

const BEFORE =
  'handle = bindManagedProcess(spec, containmentMode === "linux-scope" ? launchLinuxScope(spec, env) : launchWindowsJob(spec, env), binding);';
const AFTER =
  'handle = bindManagedProcess(spec, containmentMode === "linux-scope" ? launchLinuxScope(spec, env, internals) : launchWindowsJob(spec, env, internals), binding);';

const md5 = (buf) => createHash('md5').update(buf).digest('hex');

/** 找到 DSH 实际加载的那份 dsh-subprocess-local。 */
function findTarget() {
  // 候选 1：用 node 自己的模块解析（当前目录能解析到时最准）
  try {
    const resolved = execFileSync(
      process.execPath,
      ['-e', "try{console.log(require.resolve('@deepseek-ai/dsh-subprocess-local/package.json'))}catch{process.exit(9)}"],
      { encoding: 'utf8', timeout: 15000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
    if (resolved) {
      const p = path.join(path.dirname(resolved), 'lib', 'index.js');
      if (existsSync(p)) return p;
    }
  } catch {
    // 解析不到就走下面的候选
  }

  // 候选 2：从正在运行的 DSH 进程命令行里提取安装根
  try {
    const out = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-Command',
        "Get-CimInstance Win32_Process -Filter \"Name='node.exe' or Name='dsh.exe'\" | " +
        'Where-Object { $_.CommandLine -like "*dsh*bin.js*" -or $_.CommandLine -like "*dsh*runner.js*" } | ' +
        'Select-Object -First 1 -ExpandProperty CommandLine'],
      { encoding: 'utf8', timeout: 20000, windowsHide: true },
    ).trim();
    const m = out.match(/"?([A-Za-z]:[^"]*?[\\/]node_modules)[\\/]@deepseek-ai[\\/]dsh[\\/]/);
    if (m) {
      const p = path.join(m[1], '@deepseek-ai', 'dsh-subprocess-local', 'lib', 'index.js');
      if (existsSync(p)) return p;
    }
  } catch {
    // 继续下一个候选
  }

  // 候选 3：按 DSH 常见的 workspace 布局，从用户家目录推断
  const homes = [process.env.USERPROFILE, process.env.HOME].filter(Boolean);
  const guesses = homes.map((home) => path.join(
    home, '.workbuddy', 'binaries', 'node', 'workspace', 'node_modules',
    '@deepseek-ai', 'dsh-subprocess-local', 'lib', 'index.js',
  ));
  for (const g of guesses) if (g && existsSync(g)) return g;

  return null;
}

function readState(file) {
  if (!file || !existsSync(file)) return { kind: 'missing', file };
  const text = readFileSync(file, 'utf8');
  const hasBefore = text.includes(BEFORE);
  const hasAfter = text.includes(AFTER);
  const digest = md5(Buffer.from(text));

  if (hasAfter && !hasBefore) return { kind: 'patched', file, digest };
  if (hasBefore && !hasAfter) return { kind: 'pristine', file, digest };
  // 上游可能已经用别的方式修了：函数签名变了但调用点不再匹配
  if (!hasBefore && !hasAfter) return { kind: 'unknown-shape', file, digest };
  return { kind: 'ambiguous', file, digest, hasBefore, hasAfter };
}

function doStatus() {
  const file = findTarget();
  const state = readState(file);

  console.log('DSH subprocess-local 补丁状态');
  console.log('─'.repeat(60));

  if (state.kind === 'missing') {
    console.log('找不到 @deepseek-ai/dsh-subprocess-local');
    console.log('  （需要 DSH 已安装，且当前目录能被 node 解析到它）');
    return 1;
  }

  console.log(`目标文件: ${file}`);
  console.log(`md5:      ${state.digest}`);
  console.log('');

  switch (state.kind) {
    case 'patched':
      console.log('状态: ✅ 已打补丁');
      console.log('  AOT runner 插件可以生效。');
      return 0;
    case 'pristine':
      console.log('状态: ⚠️  原始版本（未打补丁）');
      console.log('  AOT runner 插件此刻不会生效 —— 请运行 apply。');
      return 1;
    case 'unknown-shape':
      console.log('状态: ❓ 未识别的代码形状');
      console.log('  可能是 DSH 已升级、或上游已用别的方式修复。');
      console.log('  建议：检查上游 discussion #11893 是否已解决；');
      console.log('        若已修复，本补丁应废弃（删掉 vendor/ 目录）。');
      return 2;
    default:
      console.log('状态: ❓ 目标行出现多次或状态混杂');
      return 2;
  }
}

function doApply() {
  const file = findTarget();
  const state = readState(file);

  if (state.kind === 'missing') {
    console.error('找不到 @deepseek-ai/dsh-subprocess-local');
    return 1;
  }

  if (state.kind === 'patched') {
    console.log('✅ 已经是打过补丁的状态，无需操作。');
    return 0;
  }

  if (state.kind !== 'pristine') {
    console.error(`❌ 无法安全打补丁：代码形状未识别（${state.kind}）`);
    console.error('   可能是 DSH 已升级。请复核 vendor/README.md 的说明。');
    return 2;
  }

  // 首次操作前把原始文件留档（若 vendor 里还没有）
  if (!existsSync(ORIG_PATH)) {
    console.log(`ℹ️  vendor 里缺少原始副本，先从当前文件生成: ${ORIG_PATH}`);
    writeFileSync(ORIG_PATH, readFileSync(file, 'utf8'));
  }

  // 备份当前文件（带时间戳，避免覆盖历史备份）
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = `${file}.bak-${stamp}`;
  writeFileSync(backup, readFileSync(file, 'utf8'));

  const text = readFileSync(file, 'utf8');
  writeFileSync(file, text.replace(BEFORE, AFTER));

  console.log('✅ 补丁已应用');
  console.log(`   文件: ${file}`);
  console.log(`   备份: ${backup}`);
  console.log('');
  console.log('   下一步：重启 DSH，然后用这个命令确认生效 ——');
  console.log('   子进程命令行里应该出现 dsh-aot-runner.exe，而不是 runner.js');
  return 0;
}

function doRevert() {
  const file = findTarget();
  const state = readState(file);

  if (state.kind === 'missing') {
    console.error('找不到 @deepseek-ai/dsh-subprocess-local');
    return 1;
  }
  if (state.kind === 'pristine') {
    console.log('✅ 已经是原始状态，无需还原。');
    return 0;
  }
  if (state.kind !== 'patched') {
    console.error(`❌ 无法安全还原：代码形状未识别（${state.kind}）`);
    return 2;
  }

  const text = readFileSync(file, 'utf8');
  writeFileSync(file, text.replace(AFTER, BEFORE));
  console.log('✅ 已还原为原始版本');
  console.log(`   文件: ${file}`);
  return 0;
}

function doVerify() {
  const origExists = existsSync(ORIG_PATH);
  console.log('vendor 内留档校验');
  console.log('─'.repeat(60));
  if (!origExists) {
    console.log('❌ 缺少 index.js.orig');
    return 1;
  }
  const digest = md5(readFileSync(ORIG_PATH));
  const ok = digest === ORIG_MD5;
  console.log(`index.js.orig md5: ${digest}`);
  console.log(`期望值:            ${ORIG_MD5}`);
  console.log(ok ? '✅ 留档文件与原始 0.2.0-rc.2 一致' : '❌ 留档文件已被修改！');
  return ok ? 0 : 1;
}

const arg = (process.argv[2] || 'status').toLowerCase();

// 用 if/else 链而非 switch：每个分支都以 process.exit() 收口，
// switch 里不带 break 会被静态分析判为 fallthrough（既有歧义也不利阅读），
// 而顶层又不能用 return。
if (arg === 'status') {
  process.exit(doStatus());
} else if (arg === 'apply') {
  process.exit(doApply());
} else if (arg === 'revert') {
  process.exit(doRevert());
} else if (arg === 'verify') {
  process.exit(doVerify());
} else if (arg === '-h' || arg === '--help' || arg === 'help') {
  console.log(`DSH subprocess-local 补丁工具

用法:
  node vendor/patch-dsh.mjs [命令]

命令:
  status   查看当前打补丁状态（默认）
  apply    打补丁（需要目标文件是原始版本）
  revert   还原为原始版本
  verify   校验 vendor 里的留档文件未被篡改

背景:
  DSH 0.2.0-rc.2 的 LocalSubprocessRuntime.spawn() 调用
  launchWindowsJob/launchLinuxScope 时漏传 internals 参数，
  导致 AOT runner 插件注入失效。

  上游讨论: https://github.com/deepseek-ai/deepseek-harness/discussions/11893`);
  process.exit(0);
} else {
  console.error(`未知命令: ${arg}`);
  console.error('运行 node vendor/patch-dsh.mjs --help 查看用法');
  process.exit(64);
}

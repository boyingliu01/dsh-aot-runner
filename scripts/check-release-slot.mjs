#!/usr/bin/env node
/**
 * 发布前预检：npm 上这个版本号还能不能用（issue #35 阻塞 B）
 *
 * ## 要防的是一个**不可恢复**的错误
 *
 * npm 不允许版本号重用：一旦 `0.2.8` 曾经发布过（哪怕之后被 unpublish），
 * 就**永远**不能再发 `0.2.8`。
 *
 * 于是「打 tag → 等 45 分钟 CI → npm publish 失败」这个顺序的代价特别高：
 * 二进制已经发出去了，npm 上那个版本号也已经被烧掉，
 * 唯一的出路是改版本号再走一遍，而那意味着 GitHub Release 上多一个废弃 tag。
 *
 * 所以在**打 tag 之前**先问一句「npm 上有没有这个版本」。这是一次本地几十秒的
 * 网络查询，换掉一次不可逆的失误。
 *
 * ## 三种结论，三个退出码（与 contract-branch-coverage 的取舍一致）
 *
 *   0  可以发布（npm 上没有这个版本）
 *   3  查不到（网络不通 / registry 拒绝）—— **不是「可以发布」**
 *   1  这个版本号已经被占用 —— 必须改版本号，不能靠重试
 *
 * 为什么「查不到」是 3 而不是 0：把网络故障当成「版本可用」，
 * 正是本仓库反复踩的坑 ——「命令跑起来了」不等于「命令测到了东西」。
 *
 * ## 用法
 *
 *   node scripts/check-release-slot.mjs                 # 查 VERSION 里的版本
 *   node scripts/check-release-slot.mjs --version 0.2.8 # 查指定版本
 *   node scripts/check-release-slot.mjs --json
 *
 * ## 退出码
 *
 *   0 可用 / 1 已被占用 / 3 查不到（含网络错误）
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PKG_NAME = '@boyingliu01/dsh-aot-runner';

const args = process.argv.slice(2);
const AS_JSON = args.includes('--json');
const versionArgIdx = args.indexOf('--version');

/** 网络类错误值得重试；「版本不存在」这种 404 不该重试。 */
const RETRY_DELAYS_MS = [2000, 5000, 10000];

function readVersion() {
  if (versionArgIdx !== -1) {
    const v = args[versionArgIdx + 1];
    if (!v) {
      console.error('❌ --version 后面要跟一个版本号，例如 --version 0.2.8');
      process.exit(2);
    }
    return v;
  }
  return readFileSync(path.join(REPO, 'VERSION'), 'utf8').trim();
}

/**
 * 问 registry：这个包已发布过哪些版本。
 *
 * `npm view <pkg> versions --json` 在包从未发布过时返回 E404；
 * 对「版本号是否可用」这个问题来说，E404 等于「一个版本都没有」→ 可用。
 * 但其它错误（网络、认证）绝不能当成「没有」。
 */
/**
 * 找到可执行的 npm。
 *
 * Windows 上 `execFileSync('npm', ...)` 直接 ENOENT —— npm 实际是 `npm.cmd`，
 * 而 execFile 不做 PATHEXT 解析。这个坑在 CI（Windows runner）上会稳定复现，
 * 所以这里显式处理，而不是假定「本机能跑就行」。
 */
function npmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

/** 包在 npm 上还不存在 —— 对「版本号可用吗」而言是好消息，但要说出来。 */
const NOT_FOUND_RE = /E404|404 Not Found|is not in this registry/i;

function rawView(pkg) {
  return execFileSync(npmCommand(), ['view', pkg, 'versions', '--json'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60_000,
    // npm.cmd 是批处理文件，必须经 shell 才能执行。
    shell: process.platform === 'win32',
  });
}

function errorTextOf(err) {
  const text = `${err.stdout ?? ''}${err.stderr ?? ''}${err.message ?? ''}`;
  return text.trim().split('\n').slice(0, 3).join(' | ');
}

function classifyViewError(err) {
  const text = `${err.stdout ?? ''}${err.stderr ?? ''}${err.message ?? ''}`;
  // E404 不等于「查不到」：它明确告诉我们「一个版本都没有」。
  // 其它错误（网络、认证）必须原样上报，绝不能当成「没有」。
  return NOT_FOUND_RE.test(text)
    ? { ok: true, versions: [], note: '该包在 npm 上还不存在（E404）' }
    : { ok: false, error: errorTextOf(err) };
}

function fetchPublishedVersions(pkg) {
  let out;
  try {
    out = rawView(pkg);
  } catch (err) {
    return classifyViewError(err);
  }
  const parsed = JSON.parse(out);
  return { ok: true, versions: Array.isArray(parsed) ? parsed : [parsed] };
}

/** 带退避重试地问，只对网络类失败重试。 */
function fetchWithRetry(pkg) {
  let last = null;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    const r = fetchPublishedVersions(pkg);
    if (r.ok) return r;
    last = r;
    if (attempt < RETRY_DELAYS_MS.length) {
      const wait = RETRY_DELAYS_MS[attempt];
      console.error(`  npm view 失败（第 ${attempt + 1} 次），${wait / 1000}s 后重试…`);
      execFileSync(process.execPath, ['-e', `setTimeout(()=>{},${wait})`]);
    }
  }
  return last;
}

const version = readVersion();
const found = fetchWithRetry(PKG_NAME);

if (!found.ok) {
  const msg = `查不到 npm 上 ${PKG_NAME} 的版本列表：${found.error}`;
  if (AS_JSON) console.log(JSON.stringify({ verdict: 'UNKNOWN', version, detail: msg }, null, 2));
  else {
    console.error(`⚠️  ${msg}`);
    console.error('   **这不是「可以发布」**。网络查不到就等于没查 —— 请先确认网络后再跑。');
    console.error('   若确认可以离线发布，把这个预检当作已知未执行，并在发布记录里写明。');
  }
  process.exit(3);
}

const occupied = found.versions.includes(version);

if (AS_JSON) {
  console.log(
    JSON.stringify(
      { verdict: occupied ? 'OCCUPIED' : 'AVAILABLE', version, published: found.versions },
      null,
      2,
    ),
  );
} else if (occupied) {
  console.error(`❌ npm 上已存在 ${PKG_NAME}@${version} —— 这个版本号**不能再用**。`);
  console.error('   npm 不允许版本号重用，即使之前 unpublish 过也一样。');
  console.error('');
  console.error('   修正方式：改 VERSION 与两处 package.json（node scripts/check-version.mjs --sync），');
  console.error('            再打新的 tag。**不要**重试发布，也不要删了 tag 重打同一个号。');
} else {
  console.log(`✅ npm 上还没有 ${PKG_NAME}@${version}，可以发布。`);
  if (found.note) console.log(`   ${found.note}`);
  console.log(`   已发布的版本: ${found.versions.length === 0 ? '（无）' : found.versions.join(', ')}`);
}

process.exit(occupied ? 1 : 0);

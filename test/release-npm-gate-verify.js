#!/usr/bin/env node
/**
 * tests for release.yml 的「校验 npm 发布结果」步骤（issue #35 阻塞 B）
 *
 * ## 要防的是什么
 *
 * release.yml 里 `permissions.id-token: write` 常开，于是
 * `if ($env:ACTIONS_ID_TOKEN_REQUEST_URL)` **恒为真**。
 * Trusted Publisher 没配时 `npm publish --provenance` 失败只打 ::warning::，
 * 然后落到「没有 NPM_TOKEN」分支 —— 老版本在那里 `exit 0`。
 *
 * 结果：job 全绿、GitHub Release 成功、npm 上什么都没有、**零失败信号**。
 * 这正是 issue #35 自己诊断的「90 分工程纪律、30 分交付覆盖」的同一种病：
 * 一个看起来通过了的检查。
 *
 * ## 为什么直接跑 PowerShell 而不是 grep workflow 文本
 *
 * 设计评审明确指出：「静态断言 workflow 文本」是脆的，真正的验证是
 * 把那段判定逻辑**跑起来**看它的分支行为。所以这里：
 *   1. 从 release.yml 里**抽出**那段 run 脚本（不是复制一份，避免两份漂移）
 *   2. 用 pwsh 跑它，断言退出码
 * 抽不出来就直接失败 —— 说明 workflow 结构变了，这个测试必须跟着改。
 *
 * 与 test/check-release-verify.js 同一套做法：在临时目录搭假输入，不碰真实文件。
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const WORKFLOW = path.join(REPO, '.github', 'workflows', 'release.yml');

/** pwsh 是否可用。不可用时**不能让测试假装通过** —— 见文件末尾的说明。 */
function hasPwsh() {
  const r = spawnSync('pwsh', ['-NoProfile', '-Command', 'exit 0'], { encoding: 'utf8' });
  return r.status === 0;
}

/**
 * 从 release.yml 抽出「校验 npm 发布结果」那一步的 run 脚本。
 *
 * 不用 YAML 解析器（本仓库没有 yaml 依赖，也不该为一个测试引入）：
 * 用行扫描定位步骤名，再按缩进取出 run: | 之后的内容。
 * 抽不出来就返回 null，让调用方显式失败。
 */
function extractVerifyRunScript() {
  const lines = readFileSync(WORKFLOW, 'utf8').split(/\r?\n/);
  const nameIdx = lines.findIndex((l) => l.includes('- name: 校验 npm 发布结果'));
  if (nameIdx === -1) return null;

  const runIdx = lines.findIndex((l, i) => i > nameIdx && /^\s+run: \|\s*$/.test(l));
  if (runIdx === -1) return null;
  const runIndent = lines[runIdx].search(/\S/);

  const body = [];
  for (let i = runIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() !== '' && line.search(/\S/) <= runIndent) break;
    // 去掉 run: | 的公共缩进
    body.push(line.replace(new RegExp(`^\\s{${runIndent + 2}}`), ''));
  }
  return body.join('\n');
}

/** 在临时目录跑那段校验脚本，返回退出码。 */
function runVerify({ gitRef, npmPublished, script }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'npm-gate-'));
  const ps = path.join(dir, 'verify.ps1');
  // 环境变量注入方式与 workflow 的 env: 一致（GIT_REF / NPM_PUBLISHED）。
  const prelude = [
    `$env:GIT_REF = '${gitRef}'`,
    `$env:NPM_PUBLISHED = '${npmPublished}'`,
    // GITHUB_STEP_SUMMARY 指到临时文件，避免在真实环境里追加内容。
    `$env:GITHUB_STEP_SUMMARY = '${path.join(dir, 'summary.md').replace(/\\/g, '\\\\')}'`,
  ].join('\n');
  writeFileSync(ps, `${prelude}\n${script}`);

  const r = spawnSync('pwsh', ['-NoProfile', '-NoLogo', '-File', ps], { encoding: 'utf8' });
  const out = (r.stdout ?? '') + (r.stderr ?? '');
  rmSync(dir, { recursive: true, force: true });
  return { code: r.status, out };
}

const script = extractVerifyRunScript();
const pwshOk = hasPwsh();

test('能从 release.yml 抽出「校验 npm 发布结果」脚本', () => {
  assert.ok(script, '抽不到校验脚本 —— release.yml 结构变了，这个测试必须跟着改，不要直接删');
  assert.match(script, /isReleaseTag/);
  assert.match(script, /NPM_PUBLISHED/);
});

// 没有 pwsh 时这些用例会全部 skip —— 那等于把「跳过」当「通过」，正是本仓库反复踩的坑。
// 所以这里改成显式失败并说明原因：要跑这个测试就得有 pwsh。
test('pwsh 可用（否则下面的分支验证都是空转）', () => {
  assert.ok(pwshOk, '找不到 pwsh。CI 的 release job 跑在 windows-latest 上必然有 pwsh；本机没有请装 PowerShell 7。');
});

test('发布 tag + npm 已发布 → exit 0', { skip: !pwshOk }, () => {
  const r = runVerify({ gitRef: 'refs/tags/v0.2.8', npmPublished: 'true', script });
  assert.equal(r.code, 0, r.out);
});

test('发布 tag + npm 未发布 → **exit 1**（这是本次要修的核心）', { skip: !pwshOk }, () => {
  // 老版本的此处是 exit 0：job 全绿、npm 无包、无任何失败信号。
  const r = runVerify({ gitRef: 'refs/tags/v0.2.8', npmPublished: 'false', script });
  assert.equal(r.code, 1, `发布 tag 下 npm 没发出去必须失败。实际 exit ${r.code}\n${r.out}`);
  assert.match(r.out, /::error/);
  assert.match(r.out, /Trusted Publisher/);
});

test('非 tag 触发 + npm 未发布 → exit 0（明确说明本次不要求发 npm）', { skip: !pwshOk }, () => {
  const r = runVerify({ gitRef: 'refs/heads/main', npmPublished: 'false', script });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /不要求/, '跳过必须显式说出来，不能静默');
});

test('误打 tag `vtest` 不被当成发布 → exit 0', { skip: !pwshOk }, () => {
  // 正则必须锚定到严格 semver，否则 `vtest` 会让「没发 npm」被判成失败，
  // 反倒是把门禁变成噪声源。
  const r = runVerify({ gitRef: 'refs/tags/vtest', npmPublished: 'false', script });
  assert.equal(r.code, 0, r.out);
});

test('预发布 tag `v0.2.8-rc.1` 不被当成发布 → exit 0', { skip: !pwshOk }, () => {
  const r = runVerify({ gitRef: 'refs/tags/v0.2.8-rc.1', npmPublished: 'false', script });
  assert.equal(r.code, 0, r.out);
});

// ---- 结构断言：这些是上面行为断言的前提 ----

test('「发布 npm 包」步骤不再在没有 token 时静默 exit 0 结束整件事', () => {
  const text = readFileSync(WORKFLOW, 'utf8');
  // 它仍然可以 exit 0（那一步本身不算失败），但必须先把状态写进 GITHUB_ENV，
  // 交给后面的校验步骤去判。
  assert.match(text, /NPM_PUBLISHED=false/, '发布步骤必须先写下「没发」这个事实');
  assert.match(text, /NPM_PUBLISHED=true/, '发布成功也要写下事实');
});

test('tarball 里的 exe 与本次构建一致（沿用既有的 SHA256 断言）', () => {
  const text = readFileSync(WORKFLOW, 'utf8');
  assert.match(text, /Get-FileHash bin\/dsh-aot-runner\.exe/);
  assert.match(text, /Get-FileHash \.\.\/dist\/dsh-aot-runner\.exe/);
});

// ---- 发布前预检：版本号占用（不可恢复错误）----
//
// 为什么单独测：npm 不允许版本号重用。若 0.2.8 曾发布过（哪怕之后 unpublish），
// 就永远不能再发 —— 而「打 tag → 等 45 分钟 CI → npm publish 失败」这个顺序
// 意味着二进制已发出、版本号已烧掉，只能改版本号重走一遍。
// 所以预检必须能**认出占用**，而且网络故障时**不能**说「可以发布」。

const SLOT = path.join(REPO, 'scripts', 'check-release-slot.mjs');

/** 用假 npm 替换真 npm，让 execFileSync 拿到可控输出。 */
function runSlot(fakeNpmOutput, { version = '0.2.8' } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'slot-'));
  // 在临时目录放一个假 npm.cmd / npm，并把它放到 PATH 最前面。
  const isWin = process.platform === 'win32';
  const name = isWin ? 'npm.cmd' : 'npm';
  const body = isWin ? `@echo off\r\necho ${fakeNpmOutput}\r\n` : `#!/bin/sh\necho '${fakeNpmOutput}'\n`;
  writeFileSync(path.join(dir, name), body);
  if (!isWin) require('node:fs').chmodSync(path.join(dir, name), 0o755);

  const r = spawnSync(process.execPath, [SLOT, '--version', version], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${dir}${path.delimiter}${process.env.PATH}`,
      // 本仓库环境里 npm_config_offline=true，会让假 npm 也受影响；
      // 这里显式清掉，保证测的是脚本逻辑而不是环境。
      npm_config_offline: 'false',
    },
    timeout: 120_000,
  });
  rmSync(dir, { recursive: true, force: true });
  return { code: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') };
}

test('预检：版本未被占用 → exit 0', { skip: !hasPwsh() }, () => {
  const r = runSlot('["0.2.0","0.2.1","0.2.2","0.2.3","0.2.4"]');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /可以发布/);
});

test('预检：版本已被占用 → exit 1，且提示不能重用版本号', () => {
  const r = runSlot('["0.2.0","0.2.4","0.2.8"]');
  assert.equal(r.code, 1, `期望 exit 1，实际 ${r.code}\n${r.out}`);
  assert.match(r.out, /不能再用|已存在/);
  assert.match(r.out, /不允许版本号重用/);
});

test('预检：包在 npm 上还不存在（E404）→ exit 0，但把情况说出来', () => {
  // 假 npm 输出错误文本 + 非零退出，模拟 E404。
  const dir = mkdtempSync(path.join(tmpdir(), 'slot404-'));
  const isWin = process.platform === 'win32';
  const name = isWin ? 'npm.cmd' : 'npm';
  const body = isWin
    ? '@echo off\r\necho npm error code E404 1>&2\r\nexit /b 1\r\n'
    : "#!/bin/sh\necho 'npm error code E404' >&2\nexit 1\n";
  writeFileSync(path.join(dir, name), body);
  if (!isWin) require('node:fs').chmodSync(path.join(dir, name), 0o755);
  const r = spawnSync(process.execPath, [SLOT, '--version', '0.2.8'], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH}`, npm_config_offline: 'false' },
    timeout: 120_000,
  });
  rmSync(dir, { recursive: true, force: true });
  assert.equal(r.status, 0, `E404 应视为「还没有任何版本」。实际 ${r.status}\n${r.stdout}${r.stderr}`);
});

test('预检：网络查不到 → exit 3，**不能**说「可以发布」', () => {
  // 这是最关键的一条：把网络故障当成「版本可用」是本仓库反复踩的坑。
  const dir = mkdtempSync(path.join(tmpdir(), 'slotnet-'));
  const isWin = process.platform === 'win32';
  const name = isWin ? 'npm.cmd' : 'npm';
  const body = isWin
    ? '@echo off\r\necho npm error network ECONNREFUSED 1>&2\r\nexit /b 1\r\n'
    : "#!/bin/sh\necho 'npm error network ECONNREFUSED' >&2\nexit 1\n";
  writeFileSync(path.join(dir, name), body);
  if (!isWin) require('node:fs').chmodSync(path.join(dir, name), 0o755);
  const r = spawnSync(process.execPath, [SLOT, '--version', '0.2.8'], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH}`, npm_config_offline: 'false' },
    timeout: 120_000,
  });
  rmSync(dir, { recursive: true, force: true });
  assert.equal(r.status, 3, `查不到必须是 exit 3，不是 0。实际 ${r.status}\n${r.stdout}${r.stderr}`);
  assert.ok(
    !/✅/.test(r.stdout ?? ''),
    '查不到时绝不能打印「可以发布」——把网络故障当成可用，正是不该踩的坑',
  );
});

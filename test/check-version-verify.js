#!/usr/bin/env node
/**
 * tests for scripts/check-version.mjs 的 --sync / --staged 两个模式
 *
 * 背景（都是 0.2.7 上真实踩到的）：
 *
 *   1. 提交源码时 Gate 0 拦下「VERSION 变了但 package 没跟上」，提示执行
 *      `node scripts/sync-version.cjs` —— 而本仓库根本没有这个文件。
 *      照提示跑只会得到 Cannot find module。
 *
 *   2. 补上 sync-version.cjs 之后，Gate 0 的自动扇出只暂存**仓库根 package.json**，
 *      漏掉 plugin/package.json 与 package-lock.json。Gate 0 报 PASSED，
 *      下一次提交才因为版本漂移被拦下。
 *
 * 所以这两个模式的价值全在「真的发现不一致」上，测试重点放在失败分支。
 * 做法同 check-release-verify.js：在临时目录搭假仓库，不碰真实文件。
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { execFileSync, spawnSync } = require('node:child_process');
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');

const REPO = resolve(__dirname, '..');

/** 搭一个最小仓库骨架，返回目录。 */
function makeRepo({ version = '1.0.0', pkg = '1.0.0', plugin = '1.0.0', lockTop = '1.0.0', lockRoot = '1.0.0' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'verchk-'));
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  mkdirSync(join(dir, 'plugin'), { recursive: true });

  copyFileSync(join(REPO, 'scripts', 'check-version.mjs'), join(dir, 'scripts', 'check-version.mjs'));

  writeFileSync(join(dir, 'VERSION'), `${version}\n`);
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify({ name: 'x', version: pkg }, null, 2)}\n`);
  writeFileSync(
    join(dir, 'plugin', 'package.json'),
    `${JSON.stringify({ name: 'y', version: plugin }, null, 2)}\n`,
  );
  writeFileSync(
    join(dir, 'package-lock.json'),
    `${JSON.stringify({ name: 'x', version: lockTop, lockfileVersion: 3, packages: { '': { name: 'x', version: lockRoot } } }, null, 2)}\n`,
  );

  // 关掉全局 hooksPath：xp-gate 的 pre-commit 会在这个临时仓库上跑一遍
  // 13 道门禁（耗时 20s 且必然失败）。这里只想要一个干净的 git 仓库。
  const G = (a) => execFileSync('git', ['-c', 'core.hooksPath=', '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: dir });
  G(['init', '-q']);
  G(['add', '-A']);
  G(['commit', '-qm', 'init']);
  return dir;
}

/** 在 dir 里跑 checker，返回 { status, out }。 */
function run(dir, args = []) {
  const r = spawnSync(process.execPath, [join(dir, 'scripts', 'check-version.mjs'), ...args], {
    cwd: dir,
    encoding: 'utf8',
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

function cleanup(dir) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* Windows 上偶尔因句柄未释放失败，不影响断言 */
  }
}

test('check-version: 五处一致时通过', () => {
  const dir = makeRepo();
  try {
    const { status, out } = run(dir);
    assert.equal(status, 0, out);
    assert.match(out, /全部一致/);
  } finally {
    cleanup(dir);
  }
});

test('check-version: 覆盖 package-lock 的两个 version 字段', () => {
  // 只改 packages[""] 而顶层不动 —— 这是最容易漏的一处：
  // 顶层是 npm 实际读的，packages[""] 是 v2/v3 的副本。
  const dir = makeRepo({ lockRoot: '0.9.0' });
  try {
    const { status, out } = run(dir);
    assert.equal(status, 1, 'packages[""].version 不一致必须被发现');
    assert.match(out, /packages\[""\]/);
  } finally {
    cleanup(dir);
  }
});

test('check-version --sync: 以 VERSION 为准写齐其余四处', () => {
  const dir = makeRepo({ version: '2.0.0', pkg: '1.0.0', plugin: '1.0.0', lockTop: '1.0.0', lockRoot: '1.0.0' });
  try {
    const { status: syncStatus, out: syncOut } = run(dir, ['--sync']);
    assert.equal(syncStatus, 0, syncOut);

    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
    const plugin = JSON.parse(readFileSync(join(dir, 'plugin', 'package.json'), 'utf8'));
    const lock = JSON.parse(readFileSync(join(dir, 'package-lock.json'), 'utf8'));

    assert.equal(pkg.version, '2.0.0');
    assert.equal(plugin.version, '2.0.0');
    assert.equal(lock.version, '2.0.0');
    assert.equal(lock.packages[''].version, '2.0.0', 'packages[""] 也必须跟上');

    // sync 之后检查必须通过（这是闭环：不要只验证写文件，要验证写对了）
    assert.equal(run(dir).status, 0);
  } finally {
    cleanup(dir);
  }
});

test('check-version --sync: 幂等，第二次不报改动', () => {
  const dir = makeRepo({ version: '2.0.0', pkg: '1.0.0' });
  try {
    run(dir, ['--sync']);
    const before = readFileSync(join(dir, 'package.json'), 'utf8');
    const { status, out } = run(dir, ['--sync']);
    assert.equal(status, 0, out);
    assert.match(out, /无需改动/);
    assert.equal(readFileSync(join(dir, 'package.json'), 'utf8'), before, '幂等：不应改写已一致的文件');
  } finally {
    cleanup(dir);
  }
});

test('check-version --sync: VERSION 缺失时拒绝同步', () => {
  // VERSION 是事实来源。它缺失时没有「正确答案」，静默挑一个来源当基准
  // 会让版本号在无人察觉时漂走。
  const dir = makeRepo();
  try {
    rmSync(join(dir, 'VERSION'));
    const { status, out } = run(dir, ['--sync']);
    assert.equal(status, 1);
    assert.match(out, /VERSION 缺失/);
  } finally {
    cleanup(dir);
  }
});

test('check-version --staged: 发现「已同步但没暂存」的文件', () => {
  // 复现 0.2.7 上的真实事故：Gate 0 只暂存根 package.json。
  const dir = makeRepo({ version: '2.0.0', pkg: '1.0.0', plugin: '1.0.0' });
  const git = (a) => execFileSync('git', ['-c', 'core.hooksPath=', '-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: dir });
  try {
    run(dir, ['--sync']);            // 三个文件都改好了
    git(['add', 'VERSION', 'package.json']);   // 但只暂存两个

    const { status, out } = run(dir, ['--staged']);
    assert.equal(status, 1, '未暂存的已同步文件必须被发现');
    assert.match(out, /plugin\/package\.json/);
    assert.match(out, /package-lock\.json/);
    assert.match(out, /git add plugin\/package\.json package-lock\.json/);

    // 补齐之后再检查应通过
    git(['add', 'plugin/package.json', 'package-lock.json']);
    assert.equal(run(dir, ['--staged']).status, 0);
  } finally {
    cleanup(dir);
  }
});

test('scripts/sync-version.cjs 存在且可执行', () => {
  // xp-gate Gate 0 只在 scripts/sync-version.cjs 存在时才自动扇出
  // （hooks/gate-entries/gate-0-entry.sh:166）。文件被删掉或改名，
  // 自动扇出会静默失效，而报错文案仍指向它 —— 这正是 0.2.7 撞到的情形。
  const syncPath = join(REPO, 'scripts', 'sync-version.cjs');
  assert.doesNotThrow(() => readFileSync(syncPath), 'scripts/sync-version.cjs 必须存在（Gate 0 靠它自动扇出）');

  const r = spawnSync(process.execPath, [syncPath], { cwd: REPO, encoding: 'utf8' });
  assert.equal(r.status, 0, `sync-version.cjs 应在当前仓库上以 0 退出: ${r.stdout}${r.stderr}`);
});

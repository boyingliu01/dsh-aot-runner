#!/usr/bin/env node
/**
 * tests for scripts/check-release.mjs（issue #23）
 *
 * 这个检查器的价值全在「不一致时真的会失败」上。一个永远说 OK 的
 * 发布检查比没有更糟 —— 它让人以为验过了。
 *
 * 所以这里不测「正常情况通过」，而是重点测三个失败分支：
 *   - dist 与 plugin/bin 大小不同
 *   - 大小相同但内容不同
 *   - plugin/bin 里有会被打包的残留文件
 *
 * 做法：在临时目录里搭一个假的仓库结构，把脚本复制进去跑。
 * 这样不碰真实产物（它们有 1.3MB，而且可能正被占用）。
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const SCRIPT = path.join(REPO, 'scripts', 'check-release.mjs');

/**
 * 搭一个最小仓库骨架并跑检查器。
 *
 * @param {{dist?: Buffer|null, plugin?: Buffer|null, strays?: string[]}} layout
 *   dist/plugin 为 null 表示不创建该文件；strays 是要额外塞进 plugin/bin 的文件名。
 */
function runFixture({ dist = Buffer.from('AAAA'), plugin = Buffer.from('AAAA'), strays = [] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-release-'));
  try {
    fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
    fs.copyFileSync(SCRIPT, path.join(dir, 'scripts', 'check-release.mjs'));

    const exeName = 'dsh-aot-runner.exe';
    fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
    if (dist !== null) fs.writeFileSync(path.join(dir, 'dist', exeName), dist);

    fs.mkdirSync(path.join(dir, 'plugin', 'bin'), { recursive: true });
    if (plugin !== null) fs.writeFileSync(path.join(dir, 'plugin', 'bin', exeName), plugin);
    for (const s of strays) fs.writeFileSync(path.join(dir, 'plugin', 'bin', s), 'x');

    const r = spawnSync(process.execPath, [path.join(dir, 'scripts', 'check-release.mjs'), '--json'], {
      encoding: 'utf8',
      timeout: 60000,
    });
    const parsed = r.status === 0 || r.status === 1 ? JSON.parse(r.stdout) : null;
    return { status: r.status, out: parsed, stdout: r.stdout, stderr: r.stderr };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('check-release：产物一致时通过', () => {
  const { status, out } = runFixture();
  assert.strictEqual(status, 0, '一致的产物应当通过');
  assert.strictEqual(out.ok, true);
  assert.deepStrictEqual(out.problems, []);
});

test('check-release：大小不同时失败，并报出字节差', () => {
  const { status, out } = runFixture({ dist: Buffer.from('AAAAAAAA'), plugin: Buffer.from('AA') });
  assert.strictEqual(status, 1, '大小不同必须失败');
  assert.strictEqual(out.ok, false);
  assert.strictEqual(out.problems.length, 1);
  const detail = out.problems[0].detail;
  assert.match(detail, /大小不同/);
  // 差多少字节是排查时最有用的信息，必须出现在报错里
  assert.match(detail, /差 6/);
});

test('check-release：大小相同但内容不同时也失败', () => {
  // 这条最容易漏：只比大小的实现会放过它
  const { status, out } = runFixture({ dist: Buffer.from('AAAA'), plugin: Buffer.from('AAAB') });
  assert.strictEqual(status, 1, '内容不同必须失败');
  assert.match(out.problems[0].detail, /内容不同/);
  // 给出首个差异偏移，便于排查
  assert.match(out.problems[0].detail, /偏移 3/);
});

test('check-release：dist 缺失时失败并指出该跑 build', () => {
  const { status, out } = runFixture({ dist: null });
  assert.strictEqual(status, 1);
  assert.match(out.problems[0].title, /dist/);
  assert.match(out.problems[0].fix, /build\.sh/);
});

test('check-release：plugin/bin 的 exe 缺失时失败', () => {
  const { status, out } = runFixture({ plugin: null });
  assert.strictEqual(status, 1);
  assert.match(out.problems[0].title, /plugin\/bin/);
  assert.match(out.problems[0].fix, /build\.sh/);
});

test('check-release：plugin/bin 里的残留文件会被报出来', () => {
  const { status, out } = runFixture({ strays: ['dsh-aot-runner.exe.old'] });
  assert.strictEqual(status, 1, '残留文件可能被打进包，必须失败');
  const titles = out.problems.map((p) => p.title).join(' ');
  assert.match(titles, /多余文件/);
});

test('check-release：每个问题都带修法，不能只说哪里错了', () => {
  const { out } = runFixture({ dist: Buffer.from('AAAA'), plugin: Buffer.from('AA') });
  for (const p of out.problems) {
    assert.ok(p.fix && p.fix.length > 10, `问题「${p.title}」缺少可操作的修法`);
  }
});

test('plugin/package.json 的 prepublishOnly 真的会跑这个检查', () => {
  // 检查器再好，没接进发布路径就等于没有。
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'plugin', 'package.json'), 'utf8'));
  assert.ok(pkg.scripts && pkg.scripts.prepublishOnly, 'plugin/package.json 缺 prepublishOnly');
  assert.match(pkg.scripts.prepublishOnly, /check-release\.mjs/);
});

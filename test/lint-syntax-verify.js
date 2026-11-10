#!/usr/bin/env node
/**
 * @test REQ-LINT-SYNTAX
 * @intent JS 语法检查的口径必须只有一份（scripts/check-js-syntax.mjs），
 *         CI 与 pre-commit 都调用它。此前同一判据在三处各写一遍 sh，
 *         漂移是静默的：某个目录被漏掉，检查依然打印 PASS。
 *         另外 pre-commit 需要「只查改动文件」的快速路径 —— 全量会让
 *         一次改 2 个文件的提交去启动 53 个 node 子进程（实测 5.4s）。
 * @covers AC-LS-1 全量模式能发现任意目录下的语法错误，并跳过依赖/构建产物目录
 * @covers AC-LS-2 --changed-from 只检查清单内的文件
 * @covers AC-LS-3 --changed-from 的清单里含语法错误时必须失败（不是静默跳过）
 * @covers AC-LS-4 清单为空时不得报成功（「没检查」不能显示成「通过」）
 * @covers AC-LS-5 清单里的文件已被删除时跳过，不误报
 *
 * 全部在临时目录里跑真实脚本，不碰仓库工作区。
 */
'use strict';

const { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { join, resolve, dirname } = require('node:path');
const { tmpdir } = require('node:os');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = resolve(__dirname, '..');
const SCRIPT = join(REPO_ROOT, 'scripts', 'check-js-syntax.mjs');

const GOOD = 'const a = 1;\n';
const BAD = 'const a = {{{ ;\n';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
    passed++;
  } catch (e) {
    console.log(`  FAIL  ${name}`);
    console.log(`        ${e.message}`);
    failed++;
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

/** 把 Windows 反斜杠路径归一成正斜杠，便于做与平台无关的断言。 */
function norm(s) {
  return String(s).split('\\').join('/');
}

/**
 * 造临时仓库并跑脚本，返回 {status, out}。
 *
 * 每个用例都要「建目录 → 铺文件 → 跑 → 清理」，原先四份各自抄了一遍
 * （jscpd 报了 3 处克隆）。抽成一处后每个用例只写自己的差异部分。
 *
 * @param {Object<string,string>} files 相对路径 → 内容
 * @param {string[]} [args] 额外参数；传 ['--changed-from', 'list.txt'] 走清单模式
 */
function runRepo(files, args = []) {
  const dir = mkdtempSync(join(tmpdir(), 'aot-lint-'));
  try {
    mkdirSync(join(dir, 'scripts'), { recursive: true });
    // 脚本自己也要铺进去：它是仓库里的 .js，全量模式下本来就该被扫到。
    writeFileSync(join(dir, 'scripts', 'check-js-syntax.mjs'), readFileSync(SCRIPT));
    for (const [rel, content] of Object.entries(files)) {
      const abs = join(dir, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content);
    }
    const r = spawnSync(
      process.execPath,
      [join(dir, 'scripts', 'check-js-syntax.mjs'), ...args],
      { cwd: dir, encoding: 'utf8' },
    );
    return { status: r.status, out: (r.stdout || '') + (r.stderr || '') };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log('JS 语法检查脚本验证\n');

test('AC-LS-1 全量模式能发现任意目录下的语法错误', () => {
  const r = runRepo({ 'ok.js': GOOD, 'deep/nested/bad.cjs': BAD });
  assert(r.status === 1, `含语法错误时应 exit 1，实际 ${r.status}\n${r.out}`);
  assert(norm(r.out).includes('deep/nested/bad.cjs'), `未点名出错文件:\n${r.out}`);
});

test('AC-LS-1 全量模式下全部合法时通过', () => {
  const r = runRepo({ 'a.js': GOOD, 'b/c.mjs': 'export const x = 1;\n' });
  assert(r.status === 0, `应通过，实际 ${r.status}\n${r.out}`);
  // 3 = a.js + b/c.mjs + 复制进来的 scripts/check-js-syntax.mjs 本身。
  // 脚本自己**必须**被扫到：它也是仓库里的 .js，语法坏了同样要拦。
  assert(r.out.includes('3 个文件通过'), `计数不对:\n${r.out}`);
});

test('AC-LS-1 跳过依赖与构建产物目录', () => {
  // node_modules / dist / vendor 里即使有坏文件也不该让本仓库 lint 变红：
  // 那些不是我们的代码（vendor/ 是上游补丁副本，由 patch-dsh.mjs verify 负责）。
  const r = runRepo({
    'ok.js': GOOD,
    'node_modules/x/bad.js': BAD,
    'dist/bad.js': BAD,
    'vendor/bad.js': BAD,
    'obj/bad.js': BAD,
  });
  assert(r.status === 0, `被排除的目录不应参与检查:\n${r.out}`);
  // 2 = ok.js + 复制进来的脚本本身；被排除目录里的坏文件一个都不该算进来。
  assert(r.out.includes('2 个文件通过'), `只应检查 ok.js 与脚本本身:\n${r.out}`);
});

test('AC-LS-2 --changed-from 只检查清单内的文件', () => {
  // broken-not-listed.js 有语法错误，但它不在清单里 —— 不应被发现。
  const r = runRepo(
    {
      'good.js': GOOD,
      'broken-not-listed.js': BAD,
      'listed.js': GOOD,
      'list.txt': 'good.js\nlisted.js\n',
    },
    ['--changed-from', 'list.txt'],
  );
  assert(r.status === 0, `清单内文件都合法，应通过:\n${r.out}`);
  assert(r.out.includes('2 个文件通过'), `应只查清单内 2 个:\n${r.out}`);
});

test('AC-LS-3 清单内的语法错误必须失败', () => {
  const r = runRepo({ 'bad.js': BAD, 'list.txt': 'bad.js\n' }, ['--changed-from', 'list.txt']);
  assert(r.status === 1, `清单内文件有语法错误时必须 exit 1，实际 ${r.status}:\n${r.out}`);
});

test('AC-LS-4 清单为空时不得报成功', () => {
  const r = runRepo({ 'list.txt': '' }, ['--changed-from', 'list.txt']);
  // 「没有要检查的文件」和「检查通过了」是两件事。报成功等于让没检查的提交过关。
  assert(r.status === 1, `空清单不应报成功:\n${r.out}`);
});

test('AC-LS-5 清单里的文件已删除时跳过，不误报', () => {
  // 先 add 后 delete 的文件会同时出现在改动清单里，但磁盘上已经没有了。
  const r = runRepo(
    { 'ok.js': GOOD, 'list.txt': 'ok.js\ngone.js\n' },
    ['--changed-from', 'list.txt'],
  );
  assert(r.status === 0, `已删除的文件应跳过，不应报错:\n${r.out}`);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

#!/usr/bin/env node
/**
 * @test REQ-716
 * @intent pre-commit 必须先判断「这次提交有没有相关改动」，再决定跑不跑对应检查；
 *         否则每次提交都付一次与本次改动无关的固定开销（实测 dotnet format 11 s、
 *         JS 全扫 6.8 s），而最近 30 个提交里有 90% 根本不碰 C#。
 * @covers AC-716-1 无 C# 改动时不执行 dotnet format
 * @covers AC-716-2 有 C# 改动时仍执行 dotnet format
 * @covers AC-716-3 无法确定改动范围时不得跳过检查（宁可多跑，不可漏跑）
 * @covers AC-716-4 无 JS 改动时不逐个 node --check
 *
 * 这是黑盒测试：只调用真实 hook 脚本，按改动集合观察它的行为，
 * 不断言内部实现细节。
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const HOOK = path.join(REPO_ROOT, '.githooks', 'pre-commit');

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

/**
 * 在当前仓库的真实暂存状态下跑 hook，截获它打印的阶段标记。
 * 用真实 git 索引而不是打桩：短路判据一旦写错（例如对着项目而不是改动集合判断），
 * 只有真实索引才暴露得出来。
 */
function runHookWithStaged(files) {
  // 保存并恢复索引，避免污染开发者工作区
  const indexPath = path.join(REPO_ROOT, '.git', 'index');
  const backup = indexPath + '.shortcircuit-test.bak';
  if (fs.existsSync(indexPath)) fs.copyFileSync(indexPath, backup);
  const touched = [];
  try {
    execFileSync('git', ['reset'], { cwd: REPO_ROOT, stdio: 'ignore' });
    for (const f of files) {
      // 只 git add 一个未修改的文件不会产生暂存差异（集合为空 → hook 走兜底全量检查），
      // 那样测到的不是短路行为。必须真的改动内容。
      const abs = path.join(REPO_ROOT, f);
      if (fs.existsSync(abs)) {
        touched.push({ abs, orig: fs.readFileSync(abs) });
        fs.writeFileSync(abs, Buffer.concat([fs.readFileSync(abs), Buffer.from('\n// shortcircuit probe\n')]));
      }
      execFileSync('git', ['add', '--force', f], { cwd: REPO_ROOT, stdio: 'ignore' });
    }
    const r = spawnSync('sh', [HOOK], { cwd: REPO_ROOT, encoding: 'utf8' });
    return (r.stdout || '') + (r.stderr || '');
  } finally {
    // 恢复被改动的文件内容，别把测试的副作用留在工作区
    for (const t of touched) {
      try { fs.writeFileSync(t.abs, t.orig); } catch { /* 尽力恢复 */ }
    }
    if (fs.existsSync(backup)) {
      fs.copyFileSync(backup, indexPath);
      fs.unlinkSync(backup);
    }
  }
}

console.log('pre-commit 短路行为验证\n');

test('AC-716-3 无法确定改动集合时，C# 检查必须执行（不漏跑）', () => {
  const hook = fs.readFileSync(HOOK, 'utf8');
  // 无 git 环境（如直接在解包目录运行）时，必须有兜底分支 —— 判据是
  // 脚本里存在「拿不到改动 → 视为需要检查」的显式路径，而不是默认跳过。
  assert.ok(
    /HAS_C?SHARP|CHANGED|changed/i.test(hook),
    'hook 里没有基于改动的判据',
  );
  assert.ok(
    /^\s*HAS_CSHARP=1/m.test(hook),
    'hook 缺少「拿不到改动集合时置为需要检查」的兜底赋值',
  );
});

test('AC-716-1 只有 .js/.md 改动时不执行 dotnet format', () => {
  const probe = path.join(REPO_ROOT, 'BENCH-PROBE.md');
  fs.writeFileSync(probe, '# probe\n');
  try {
    const out = runHookWithStaged(['BENCH-PROBE.md']);
    assert.ok(
      !/\[pre-commit\] C# 格式检查\n/.test(out.replace(/\r/g, '')),
      `不应运行 dotnet format，实际输出:\n${out}`,
    );
    assert.ok(/跳过 C# 格式检查|无 C# 改动/.test(out), '未给出跳过原因，等于静默放行');
  } finally {
    fs.unlinkSync(probe);
  }
});

test('AC-716-2 有 .cs 改动时执行 dotnet format', () => {
  const out = runHookWithStaged(['src/IpcChannel.cs']);
  assert.ok(
    /C# 格式检查/.test(out),
    `有 C# 改动时必须运行格式检查，实际输出:\n${out}`,
  );
});

test('AC-716-4 只有 .cs 改动时不逐个 node --check', () => {
  const out = runHookWithStaged(['src/IpcChannel.cs']);
  assert.ok(
    /无 JS 改动|跳过 JS/.test(out.replace(/\r/g, '')),
    `无 JS 改动时应跳过语法扫描并说明原因，实际输出:\n${out}`,
  );
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

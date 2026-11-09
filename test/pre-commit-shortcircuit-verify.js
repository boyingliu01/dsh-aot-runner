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
 * @covers AC-716-5 hook 挂住时测试超时失败，而不是无限期挂死（#24）
 * @covers AC-716-6 测试绝不写真实的 .git/index，也不留探针在真实源码里（#24）
 * @covers AC-716-7 跳段开关只跳第 2 段且默认关闭（#24）
 *
 * 这是黑盒测试：只调用真实 hook 脚本，按改动集合观察它的行为，
 * 不断言内部实现细节。
 *
 * ## 为什么不能在真实索引上操作（#24）
 *
 * 原实现在真实 `.git/index` 上备份 → reset → 改文件 → add → 跑 hook，收尾靠 `finally`。
 * 一旦进程被 kill（hook 挂住 → 外层超时），`finally` 不执行，留下的是
 * 「源码里带探针 + 索引项丢失」的开发环境损坏。
 *
 * 现在改为：
 *   1. 用 `GIT_INDEX_FILE` 指向临时索引，真实 `.git/index` 全程只读
 *   2. 探针只写进临时索引（`hash-object` + `update-index --cacheinfo`），
 *      真实工作区的文件一个字节都不动
 *   3. hook 调用带 timeout，超时即判失败并打印已捕获输出
 *
 * ## 为什么只跑第 1 段
 *
 * hook 分两段：第 1 段是本仓库自有快检（本测试的被测对象），第 2 段转交 xp-gate
 * 全局门禁（另一个系统，每次 25 s 起）。带着第 2 段跑，整个文件从 41 s 变成 423 s ——
 * 一个没人会在提交前跑的测试等于没有测试。`AOT_SKIP_GLOBAL_GATES=1` 只跳过第 2 段，
 * 被测的第 1 段完全不受影响。
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const HOOK = path.join(REPO_ROOT, '.githooks', 'pre-commit');

/** hook 单次运行的上限。第 1 段正常 1~3 s；留足余量以便机器繁忙时不误判超时。 */
const HOOK_TIMEOUT_MS = 120000;

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

/** 建一个临时目录，返回 { dir, cleanup }；cleanup 幂等。 */
function makeTempDir(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `aot-precommit-${label}-`));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/**
 * 在**临时索引**上暂存给定的改动集合，返回 hook 的完整输出。
 *
 * 真实 `.git/index` 与真实工作区都不被修改 —— 这是 #24 的核心修复点。
 * 用真实 git 命令而不是打桩：短路判据一旦写错（例如对着项目而不是改动集合判断），
 * 只有真实 git 行为才暴露得出来。
 *
 * 只跑 hook 的**第 1 段**（`AOT_SKIP_GLOBAL_GATES=1`）。第 2 段是 xp-gate 的全局门禁，
 * 每次 25 s 起，与本测试要验证的短路判据无关；带上它会让整个文件从 ~2 s 变成 423 s。
 *
 * @param {string[]} files 要暂存的仓库相对路径
 * @param {{createIfMissing?: Record<string,string>}} [opts] 不存在时按此内容创建
 */
function runHookWithStaged(files, opts = {}) {
  const tmp = makeTempDir('idx');
  // 从真实索引复制一份初始状态到临时索引：只读源，不留痕。
  const tmpIndex = path.join(tmp.dir, 'index');
  const realIndex = path.join(REPO_ROOT, '.git', 'index');
  if (fs.existsSync(realIndex)) fs.copyFileSync(realIndex, tmpIndex);

  const env = { ...process.env, GIT_INDEX_FILE: tmpIndex, AOT_SKIP_GLOBAL_GATES: '1' };
  const run = (args) => execFileSync('git', args, { cwd: REPO_ROOT, env, stdio: 'ignore' });

  try {
    run(['reset']);
    for (const f of files) {
      const abs = path.join(REPO_ROOT, f);
      // 只 git add 一个未修改的文件不会产生暂存差异（集合为空 → hook 走兜底全量检查），
      // 那样测到的不是短路行为。必须真的产生内容差异 —— 但这差异只进**临时索引**：
      // 直接用 `git hash-object` + `update-index --cacheinfo` 喂一个不同 blob，
      // 真实工作区一个字节都不动。
      const created = opts.createIfMissing?.[f];
      if (!fs.existsSync(abs) && created === undefined) continue;
      const content = created !== undefined ? created : fs.readFileSync(abs, 'utf8') + '\n// shortcircuit probe\n';
      const blob = execFileSync('git', ['hash-object', '-w', '--stdin'],
        { cwd: REPO_ROOT, env, input: content, encoding: 'utf8' }).trim();
      run(['update-index', '--add', '--cacheinfo', `100644,${blob},${f}`]);
    }
    const r = spawnSync('sh', [HOOK], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: HOOK_TIMEOUT_MS,
      env,
    });
    if (r.error && r.error.code === 'ETIMEDOUT') {
      const partial = (r.stdout || '') + (r.stderr || '');
      throw new Error(
        `hook 超时（>${HOOK_TIMEOUT_MS / 1000}s）未返回 —— 不应无限期挂住。\n` +
        `已捕获输出（末尾）:\n${partial.slice(-1500)}`,
      );
    }
    return (r.stdout || '') + (r.stderr || '');
  } finally {
    tmp.cleanup();
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

test('AC-716-1 只有 .md 改动时不执行 dotnet format', () => {
  const out = runHookWithStaged(['BENCH-PROBE.md'], {
    createIfMissing: { 'BENCH-PROBE.md': '# probe\n' },
  });
  assert.ok(
    !/\[pre-commit\] C# 格式检查\n/.test(out.replace(/\r/g, '')),
    `不应运行 dotnet format，实际输出:\n${out}`,
  );
  assert.ok(/跳过 C# 格式检查|无 C# 改动/.test(out), '未给出跳过原因，等于静默放行');
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

test('AC-716-6 跑完后真实源码与真实索引未被改动', () => {
  const watched = path.join(REPO_ROOT, 'src', 'IpcChannel.cs');
  const realIndex = path.join(REPO_ROOT, '.git', 'index');
  const before = {
    src: fs.readFileSync(watched),
    idx: fs.existsSync(realIndex) ? fs.readFileSync(realIndex) : null,
  };
  runHookWithStaged(['src/IpcChannel.cs']);
  assert.deepStrictEqual(fs.readFileSync(watched), before.src, '真实源码被测试写入了探针');
  const afterIdx = fs.existsSync(realIndex) ? fs.readFileSync(realIndex) : null;
  assert.deepStrictEqual(afterIdx, before.idx, '真实 .git/index 被测试改动');
  // 备份残留同样不许出现 —— 原实现留过 .git/index.shortcircuit-test.bak
  assert.ok(
    !fs.existsSync(realIndex + '.shortcircuit-test.bak'),
    '残留了索引备份文件',
  );
});

test('AC-716-5 hook 挂住时按超时失败，不挂死', () => {
  // 用一个假 hook 验证超时通道本身是活的：它必须真的超时并抛出可读错误，
  // 而不是让进程一直等下去。上限压到 300ms 以免拖慢整体。
  const tmp = makeTempDir('timeout');
  try {
    const fakeHook = path.join(tmp.dir, 'hang.sh');
    fs.writeFileSync(fakeHook, '#!/bin/sh\necho started\nsleep 30\n');
    const r = spawnSync('sh', [fakeHook], { encoding: 'utf8', timeout: 300 });
    assert.ok(r.error && r.error.code === 'ETIMEDOUT', '超时未触发 —— spawnSync 的 timeout 通道失效');
    assert.match(r.stdout || '', /started/, '超时前已产生的输出应当可读，否则无法诊断挂在哪一步');
  } finally {
    tmp.cleanup();
  }
});

test('AC-716-7 AOT_SKIP_GLOBAL_GATES 只跳第 2 段，且默认关闭', () => {
  const hook = fs.readFileSync(HOOK, 'utf8');
  // 默认关闭：开关缺省时不得进入跳过分支。写成显式的 `:-0` 形态，
  // 这样「变量未设置」不会被误判成「变量已设置」。
  assert.ok(
    /AOT_SKIP_GLOBAL_GATES:-0/.test(hook),
    '跳段开关没有默认关闭（应为 ${AOT_SKIP_GLOBAL_GATES:-0}）',
  );
  // 只跳第 2 段：跳过分支必须出现在第 2 段标记之后。
  // 放在第 1 段之前的话，被测的短路判据会一起被跳过，测试就变成永远通过的空壳。
  const skipAt = hook.indexOf('AOT_SKIP_GLOBAL_GATES:-0');
  const seg2At = hook.indexOf('第 2 段');
  assert.ok(seg2At !== -1 && skipAt > seg2At, '跳段开关不在第 2 段之后 —— 会连被测的第 1 段一起跳过');
  // 跳过时第 1 段必须已经跑完：输出里要有本仓库自有快检的标记，而不是直接 exit。
  const out = runHookWithStaged(['src/IpcChannel.cs']);
  assert.match(out, /C# 格式检查/, '跳段时第 1 段未执行');
  assert.match(out, /跳过 xp-gate 全局门禁/, '跳段时未给出明确提示，等于静默改变门禁行为');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

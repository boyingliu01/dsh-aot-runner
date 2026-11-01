/**
 * A1: S4 A/B 字节级验证
 *
 * 对每个用例，同时跑 node runner 和 AOT runner，逐字节比对：
 *   - stdout（target 标准输出）
 *   - stderr（target 标准错误）
 *   - exitCode（target 退出码）
 *   - error 对象（含 message 文本，不只比对 code）
 *
 * 覆盖 v3.2 方案要求的 6 类 target：python / pwsh / bash / cmd / npm / git
 */
const { test } = require('node:test');
const assert = require('node:assert');
const { runNode, runAot, targetEnv, assertEnvironment, NODE_RUNNER, AOT_RUNNER } = require('./runner-client.js');

// 环境缺失（找不到 node runner / 未构建 AOT 产物）必须报出可操作的错误，
// 而不是在第一个用例里以 TypeError 崩溃 —— 两者是完全不同的失败含义。
assertEnvironment();
console.log(`node runner: ${NODE_RUNNER}`);
console.log(`AOT runner : ${AOT_RUNNER}\n`);

/** 用例定义 */
const CASES = [
  // ---- cmd ----
  { name: 'cmd/echo',        argv: ['cmd.exe', '/c', 'echo HELLO'],                cwd: 'C:/Windows' },
  { name: 'cmd/stderr',      argv: ['cmd.exe', '/c', 'echo ERRTEXT 1>&2'],         cwd: 'C:/Windows' },
  { name: 'cmd/both',        argv: ['cmd.exe', '/c', 'echo OUT& echo ERR 1>&2'],   cwd: 'C:/Windows' },
  { name: 'cmd/exit-3',      argv: ['cmd.exe', '/c', 'exit 3'],                    cwd: 'C:/Windows' },
  { name: 'cmd/exit-0',      argv: ['cmd.exe', '/c', 'exit 0'],                    cwd: 'C:/Windows' },
  { name: 'cmd/no-newline',  argv: ['cmd.exe', '/c', '<nul set /p =NOEOL'],        cwd: 'C:/Windows' },
  { name: 'cmd/unicode',     argv: ['cmd.exe', '/c', 'echo 中文测试'],              cwd: 'C:/Windows' },
  { name: 'cmd/crlf',        argv: ['cmd.exe', '/c', 'echo A& echo B& echo C'],    cwd: 'C:/Windows' },
  { name: 'cmd/cwd',         argv: ['cmd.exe', '/c', 'cd'],                        cwd: 'C:/Windows' },

  // ---- python ----
  { name: 'python/stdout',   argv: ['python', '-c', 'print("PY_OK")'],            cwd: 'C:/Windows' },
  { name: 'python/stderr',   argv: ['python', '-c', 'import sys; sys.stderr.write("PYERR\\n")'], cwd: 'C:/Windows' },
  { name: 'python/exit-1',   argv: ['python', '-c', 'import sys; sys.exit(1)'],   cwd: 'C:/Windows' },
  { name: 'python/unicode',  argv: ['python', '-c', 'print("你好世界")'],          cwd: 'C:/Windows' },
  { name: 'python/long',     argv: ['python', '-c', 'print("X"*5000)'],           cwd: 'C:/Windows' },
  { name: 'python/env',      argv: ['python', '-c', 'import os; print(os.environ.get("MYTEST","MISSING"))'], cwd: 'C:/Windows', env: targetEnv({ MYTEST: 'VALUE123' }) },

  // ---- bash (git bash) ----
  { name: 'bash/echo',       argv: ['bash', '-c', 'echo BASH_OK'],                cwd: 'C:/Windows' },
  { name: 'bash/exit-2',     argv: ['bash', '-c', 'exit 2'],                      cwd: 'C:/Windows' },
  { name: 'bash/stderr',     argv: ['bash', '-c', 'echo BASHERR 1>&2'],           cwd: 'C:/Windows' },

  // ---- pwsh ----
  { name: 'pwsh/echo',       argv: ['pwsh', '-NoProfile', '-Command', 'Write-Output "PS_OK"'], cwd: 'C:/Windows' },
  { name: 'pwsh/exit-1',     argv: ['pwsh', '-NoProfile', '-Command', 'exit 1'],  cwd: 'C:/Windows' },

  // ---- npm / git ----
  { name: 'npm/version',     argv: ['npm', '--version'],                          cwd: 'C:/Windows' },
  { name: 'git/version',     argv: ['git', '--version'],                          cwd: 'C:/Windows' },

  // ---- 边界：不存在的命令 ----
  { name: 'error/enoent',    argv: ['definitely-not-a-real-command-xyz'],          cwd: 'C:/Windows' },

  // ---- 大输出 ----
  { name: 'cmd/bigout',      argv: ['cmd.exe', '/c', 'for /L %i in (1,1,500) do @echo LINE%i'], cwd: 'C:/Windows' },
];

async function pair(t, c) {
  const [n, a] = await Promise.all([
    runNode({ argv: c.argv, cwd: c.cwd, env: c.env }),
    runAot({ argv: c.argv, cwd: c.cwd, env: c.env }),
  ]);

  const report = {
    stdoutEq: n.stdout === a.stdout,
    stderrEq: n.stderr === a.stderr,
    codeEq: n.exitCode === a.exitCode,
    errorEq: JSON.stringify(n.error) === JSON.stringify(a.error),
  };
  const allEq = Object.values(report).every(Boolean);

  if (!allEq) {
    console.log(`\n❌ ${c.name}`);
    if (!report.stdoutEq) console.log(`   stdout node=${JSON.stringify(n.stdout.slice(0, 200))}\n          aot =${JSON.stringify(a.stdout.slice(0, 200))}`);
    if (!report.stderrEq) console.log(`   stderr node=${JSON.stringify(n.stderr.slice(0, 200))}\n          aot =${JSON.stringify(a.stderr.slice(0, 200))}`);
    if (!report.codeEq) console.log(`   exit   node=${n.exitCode} aot=${a.exitCode}`);
    if (!report.errorEq) console.log(`   error  node=${JSON.stringify(n.error)} aot=${JSON.stringify(a.error)}`);
  } else {
    console.log(`✅ ${c.name.padEnd(18)} stdout=${JSON.stringify(n.stdout.slice(0, 30)).padEnd(34)} code=${n.exitCode}`);
  }

  assert.ok(report.stdoutEq, `${c.name}: stdout 不一致`);
  assert.ok(report.stderrEq, `${c.name}: stderr 不一致`);
  assert.ok(report.codeEq, `${c.name}: exitCode 不一致`);
  assert.ok(report.errorEq, `${c.name}: error 对象不一致`);
}

for (const c of CASES) {
  test(`A/B ${c.name}`, { timeout: 45000 }, async (t) => { await pair(t, c); });
}

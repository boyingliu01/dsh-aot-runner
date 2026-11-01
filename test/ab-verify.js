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

/** target 侧探针：fd 7 能否成功 fstat（= CRT 描述符表是否正确下发） */
const CFG_FD7_PROBE = [
  'import os',
  'try:',
  '    os.fstat(7)',
  '    print("FD7_VALID")',
  'except OSError:',
  '    print("FD7_INVALID")',
].join('\n');

/** target 侧探针：host 注入的 control 标记是否透传到位 */
const CFG_MARKER_PROBE = [
  'import os',
  'print("MARKER=" + os.environ.get("DSH_SUBPROCESS_CONTROL", "MISSING"))',
].join('\n');

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

  // ---- control channel（Issue #2）----
  // 真实契约：host 在 start 请求里带 control:"pipe"，并在 target 环境里注入
  // DSH_SUBPROCESS_CONTROL=pipe；runner 必须把 fd 7 透传给 target。
  // 断言刻意落在「target 能否真的用到 fd 7」，而不是「有没有报错」——
  // 后者在 fd 7 无效时同样会通过。
  {
    name: 'control/fd7-open',
    argv: ['python', '-c', CFG_FD7_PROBE],
    cwd: 'C:/Windows',
    control: true,
    // fd 7 是否可被 target 打开（os.fstat 成功 = CRT 描述符表已正确下发）
    expectStdout: (out) => out.includes('FD7_VALID'),
  },
  {
    name: 'control/env-marker',
    argv: ['python', '-c', CFG_MARKER_PROBE],
    cwd: 'C:/Windows',
    control: true,
    // host 注入的标记必须原样透传给 target
    expectStdout: (out) => out.trim() === 'MARKER=pipe',
  },
  {
    name: 'control/no-control-no-fd7',
    argv: ['python', '-c', CFG_FD7_PROBE],
    cwd: 'C:/Windows',
    control: false,
    // 反向断言：不带 control 时 fd 7 必须是无效的（否则说明我们滥发了句柄）
    expectStdout: (out) => out.includes('FD7_INVALID'),
  },
];

async function pair(t, c) {
  const opts = { argv: c.argv, cwd: c.cwd, env: c.env, control: c.control === true };
  const [n, a] = await Promise.all([runNode(opts), runAot(opts)]);

  const report = {
    stdoutEq: n.stdout === a.stdout,
    stderrEq: n.stderr === a.stderr,
    codeEq: n.exitCode === a.exitCode,
    errorEq: JSON.stringify(n.error) === JSON.stringify(a.error),
    // control 用例额外比对 target 经 fd 7 回传的字节
    controlEq: (n.controlData ?? '') === (a.controlData ?? ''),
  };
  const allEq = Object.values(report).every(Boolean);

  if (!allEq) {
    console.log(`\n❌ ${c.name}`);
    if (!report.stdoutEq) console.log(`   stdout node=${JSON.stringify(n.stdout.slice(0, 200))}\n          aot =${JSON.stringify(a.stdout.slice(0, 200))}`);
    if (!report.stderrEq) console.log(`   stderr node=${JSON.stringify(n.stderr.slice(0, 200))}\n          aot =${JSON.stringify(a.stderr.slice(0, 200))}`);
    if (!report.codeEq) console.log(`   exit   node=${n.exitCode} aot=${a.exitCode}`);
    if (!report.errorEq) console.log(`   error  node=${JSON.stringify(n.error)} aot=${JSON.stringify(a.error)}`);
    if (!report.controlEq) console.log(`   control node=${JSON.stringify(n.controlData)} aot=${JSON.stringify(a.controlData)}`);
  } else {
    console.log(`✅ ${c.name.padEnd(18)} stdout=${JSON.stringify(n.stdout.slice(0, 30)).padEnd(34)} code=${n.exitCode}`);
  }

  assert.ok(report.stdoutEq, `${c.name}: stdout 不一致`);
  assert.ok(report.stderrEq, `${c.name}: stderr 不一致`);
  assert.ok(report.codeEq, `${c.name}: exitCode 不一致`);
  assert.ok(report.errorEq, `${c.name}: error 对象不一致`);
  assert.ok(report.controlEq, `${c.name}: control 通道数据不一致`);

  // 期望断言：不能只靠「两边一致」——两边同时错也会通过。
  // 这是防止 A/B 比对变成「一致性幻觉」的关键一层。
  if (c.expectStdout) {
    assert.ok(c.expectStdout(n.stdout), `${c.name}: node 侧 stdout 未满足期望，实际 ${JSON.stringify(n.stdout)}`);
    assert.ok(c.expectStdout(a.stdout), `${c.name}: AOT 侧 stdout 未满足期望，实际 ${JSON.stringify(a.stdout)}`);
  }
}

for (const c of CASES) {
  test(`A/B ${c.name}`, { timeout: 45000 }, async (t) => { await pair(t, c); });
}

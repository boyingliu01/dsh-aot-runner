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
  // expectErrorShape 做**结构化**断言，而不只是 JSON.stringify 比字符串 ——
  // 后者分不清「字段缺失」与「字段为 null」，这正是 Issue #9 记录的掩盖效应。
  {
    name: 'error/enoent',
    argv: ['definitely-not-a-real-command-xyz'],
    cwd: 'C:/Windows',
    expectErrorShape: {
      name: 'Error',
      messageIncludes: 'ENOENT',
      code: 'ENOENT',
      syscall: 'spawn definitely-not-a-real-command-xyz',
      path: 'definitely-not-a-real-command-xyz',
    },
  },
  {
    // npm 只有 npm.cmd，而按 DSH 的解析规则候选扩展名只有 .com/.exe，
    // 因此必须解析失败。这条同时验证「AOT 不得擅自补 .cmd 让它跑起来」。
    name: 'error/npm-not-resolvable',
    argv: ['npm', 'does-not-matter'],
    cwd: 'C:/Windows',
    expectErrorShape: {
      name: 'Error',
      messageIncludes: 'ENOENT',
      code: 'ENOENT',
      syscall: 'spawn npm',
      path: 'npm',
    },
  },

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

  if (c.expectErrorShape) {
    checkErrorShape(c.name, 'node', n.error, c.expectErrorShape);
    checkErrorShape(c.name, 'aot', a.error, c.expectErrorShape);
  }
}

/**
 * 对一个 error 对象做**结构化**校验。
 *
 * 为什么需要它：现有 A/B 用 JSON.stringify 比对两侧错误，只能证明「两边一样」，
 * 不能证明「形状正确」。`{"code":null}` 与 `{"code":"ENOENT"}` 在字符串层面
 * 一眼可分，但 `{"code":null}` 与**缺字段**在语义上天差地别 ——
 * host 的 isSerializedRunnerError 只接受 undefined 或 string，
 * null 会让整条错误被丢弃（见 CHANGELOG 里 bf645c6 修复的这一条）。
 *
 * @param {string} caseName 用例名，用于报错
 * @param {string} side 'node' | 'aot'
 * @param {object|null} err 实际错误对象
 * @param {object} shape 期望形状
 */
function checkErrorShape(caseName, side, err, shape) {
  assert.ok(err && typeof err === 'object', `${caseName}/${side}: 应返回 error 对象，实际 ${JSON.stringify(err)}`);

  for (const [key, expected] of Object.entries(shape)) {
    if (key === 'messageIncludes') {
      assert.ok(
        typeof err.message === 'string' && err.message.includes(expected),
        `${caseName}/${side}: message 应包含 ${JSON.stringify(expected)}，实际 ${JSON.stringify(err.message)}`,
      );
      continue;
    }
    assert.strictEqual(err[key], expected, `${caseName}/${side}: error.${key} 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(err[key])}`);
  }

  // 任何字段都不允许显式为 null —— null 会被 host 侧视为非法并丢弃整条结果
  for (const [key, value] of Object.entries(err)) {
    assert.notStrictEqual(value, null, `${caseName}/${side}: error.${key} 不得为 null（host 侧会判定整条错误非法）`);
  }

  // 字段集必须与期望集合一致。
  // 期望字段集 = shape 里的普通键（messageIncludes 是断言指令，不是字段名）
  //            + message（只要出现 messageIncludes 就必然有 message 字段）
  const expectedKeys = Object.keys(shape).filter((k) => k !== 'messageIncludes');
  if (shape.messageIncludes !== undefined) expectedKeys.push('message');
  expectedKeys.sort();
  const actualKeys = Object.keys(err).sort();
  assert.deepStrictEqual(
    actualKeys,
    expectedKeys,
    `${caseName}/${side}: 错误对象字段集不符，期望 ${JSON.stringify(expectedKeys)}，实际 ${JSON.stringify(actualKeys)}`,
  );

  // 显式存在性检查：deepStrictEqual 的字段集比对已经覆盖了这一点，
  // 但这里再独立断言一次「必需字段的值必须是有效字符串」，因为
  // 真正的缺陷形态是 ProtocolJson 省略 null 字段 → 字段直接消失。
  // 上面的字段集断言会同时抓到这两种表现（缺失 / null 被省略），
  // 这条则把意图写死，避免将来有人放宽字段集比对时把保护一起改没。
  for (const key of ['name', 'code']) {
    assert.ok(
      typeof err[key] === 'string' && err[key].length > 0,
      `${caseName}/${side}: error.${key} 必须是非空字符串，实际 ${JSON.stringify(err[key])}`,
    );
  }
}

for (const c of CASES) {
  test(`A/B ${c.name}`, { timeout: 45000 }, async (t) => { await pair(t, c); });
}

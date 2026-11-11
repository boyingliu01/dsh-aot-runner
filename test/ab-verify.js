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
const path = require('node:path');
const { runNode, runAot, targetEnv, assertEnvironment, NODE_RUNNER, AOT_RUNNER } = require('./runner-client.js');

// 环境缺失（找不到 node runner / 未构建 AOT 产物）必须报出可操作的错误，
// 而不是在第一个用例里以 TypeError 崩溃 —— 两者是完全不同的失败含义。
assertEnvironment();

// 退出码探针（见下方「退出码边界」用例的说明）。
// 用绝对路径，因为 cwd 在用例里是可变的，相对路径会解析到别处。
const EXITCODE_PROBE = path.join(__dirname, '..', 'exitcode-probe.py');
const EXITCODE_PROBE_CWD = path.join(__dirname, '..').replace(/\\/g, '/');
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

  // ---- C 项：长路径 / UNC / 设备路径（issue #15 C，第一优先级）----
  //
  // 为什么这个维度排第一：runner 的 cwd 会过 NormalizeWindowsPath()，
  // 而那条规则里有 `Length > 3` 这样的长度判断。只要某一版把 `\\?\` 前缀
  // 当成「多余的反斜杠」剥掉，路径就变成普通路径，超过 260 字符时
  // CreateProcessW 直接失败 —— 而错误信息会说「找不到目录」，指错方向。
  //
  // 断言放在「target 打出来的 cwd 字符串」上，不是「有没有报错」：
  // 后者在路径被悄悄改写成另一个合法目录时同样会通过。
  { name: 'path/unc-cwd',    argv: ['cmd.exe', '/c', 'cd'],
    cwd: '//localhost/C$/Windows' },
  { name: 'path/unc-cwd-backslash', argv: ['cmd.exe', '/c', 'cd'],
    cwd: '\\\\localhost\\C$\\Windows' },
  // 含 `..` 的路径：node 会解析成真实目录，AOT 侧必须一致。
  { name: 'path/dotdot',     argv: ['cmd.exe', '/c', 'cd'],
    cwd: 'C:/Windows/System32/../' },
  // 裸盘符：NormalizeWindowsPath 明确把它补成 "C:\"。
  // 若不补，语义是「盘符当前目录」而不是根目录 —— 两者可能不同。
  { name: 'path/bare-drive', argv: ['cmd.exe', '/c', 'cd'],                        cwd: 'C:' },
  // 正斜杠：node 与 Windows API 都能接受，验证两侧都归一化到同一结果。
  { name: 'path/forward-slash', argv: ['cmd.exe', '/c', 'cd'],                     cwd: 'C:/Windows/System32' },

  // ---- python ----
  { name: 'python/stdout',   argv: ['python', '-c', 'print("PY_OK")'],            cwd: 'C:/Windows' },
  { name: 'python/stderr',   argv: ['python', '-c', 'import sys; sys.stderr.write("PYERR\\n")'], cwd: 'C:/Windows' },
  { name: 'python/exit-1',   argv: ['python', '-c', 'import sys; sys.exit(1)'],   cwd: 'C:/Windows' },
  { name: 'python/unicode',  argv: ['python', '-c', 'print("你好世界")'],          cwd: 'C:/Windows' },
  { name: 'python/long',     argv: ['python', '-c', 'print("X"*5000)'],           cwd: 'C:/Windows' },
  { name: 'python/env',      argv: ['python', '-c', 'import os; print(os.environ.get("MYTEST","MISSING"))'], cwd: 'C:/Windows', env: targetEnv({ MYTEST: 'VALUE123' }) },

  // ---- C 项：argv 特殊字符（issue #15 C，第二优先级）----
  //
  // 这是 Windows 命令行最经典的一类缺陷：MSVCRT 的 argv 解析规则
  // （反斜杠只在与引号相邻时才是转义符）与直觉不同，自己拼命令行的实现
  // 很容易在这些组合上出错。Node 用 libuv 的 `quote_cmd_arg`，AOT 侧必须
  // 复现同一套规则，否则**同一个 argv 在两侧会变成不同的参数**。
  //
  // 探针用 python 打印 repr(argv)，因为它是唯一能精确回显「收到的原始参数」
  // 而不做二次解释的方式 —— 用 echo 会被 shell 自己再处理一遍，测了个寂寞。
  //
  // 每一条都对应一个真实的失败模式：
  //   quote-in-arg       参数里含双引号 —— 必须转义成 \" 而不是直接拼
  //   trailing-backslash 尾随反斜杠 + 需要被引号包裹 —— 反斜杠必须翻倍，
  //                      否则 "a\" 会把闭合引号吃掉，后续参数全被吞进上一个
  //   alternating        反斜杠与引号交替 —— MSVCRT 规则最容易算错的地方
  //   embedded-space     含空格的单个参数 —— 必须被引号包裹，但只包这一个
  //   empty-arg          空字符串参数 —— 常被优化掉，导致参数位置整体左移
  //   unicode-arg        含非 ASCII —— 验证 UTF-16 传递没有被降级
  {
    name: 'argv/quote-in-arg',
    argv: ['python', '-c', 'import sys;print(repr(sys.argv[1:]))', 'a"b'],
    cwd: 'C:/Windows',
  },
  {
    name: 'argv/trailing-backslash',
    argv: ['python', '-c', 'import sys;print(repr(sys.argv[1:]))', 'C:\\path with space\\'],
    cwd: 'C:/Windows',
  },
  {
    name: 'argv/alternating',
    argv: ['python', '-c', 'import sys;print(repr(sys.argv[1:]))', 'a\\"b\\\\"c'],
    cwd: 'C:/Windows',
  },
  {
    name: 'argv/embedded-space',
    argv: ['python', '-c', 'import sys;print(repr(sys.argv[1:]))', 'hello world'],
    cwd: 'C:/Windows',
  },
  {
    name: 'argv/empty-arg',
    argv: ['python', '-c', 'import sys;print(repr(sys.argv[1:]))', ''],
    cwd: 'C:/Windows',
  },
  {
    name: 'argv/unicode-arg',
    argv: ['python', '-c', 'import sys;print(repr(sys.argv[1:]))', '中文 " 混合'],
    cwd: 'C:/Windows',
  },

  // ---- bash (git bash) ----
  { name: 'bash/echo',       argv: ['bash', '-c', 'echo BASH_OK'],                cwd: 'C:/Windows' },
  { name: 'bash/exit-2',     argv: ['bash', '-c', 'exit 2'],                      cwd: 'C:/Windows' },
  { name: 'bash/stderr',     argv: ['bash', '-c', 'echo BASHERR 1>&2'],           cwd: 'C:/Windows' },

  // ---- pwsh ----
  { name: 'pwsh/echo',       argv: ['pwsh', '-NoProfile', '-Command', 'Write-Output "PS_OK"'], cwd: 'C:/Windows' },
  { name: 'pwsh/exit-1',     argv: ['pwsh', '-NoProfile', '-Command', 'exit 1'],  cwd: 'C:/Windows' },

  // ---- C 项：env 边界（issue #15 C，第四优先级）----
  //
  // 环境块是 Windows 进程创建里最容易被「自己拼」搞坏的一处：它要求
  // 「KEY=VALUE\0KEY=VALUE\0\0」的双空字节结尾、KEY 不能含 '='、整体大小
  // 有上限。自己拼环境块时最容易漏的正是**结尾的第二个空字节** ——
  // 漏了以后进程照样能启动，但会读到越界的环境数据，表现为随机的
  // 「环境变量莫名其妙少了几个」，非常难查。
  //
  // 这里的探针让 target 自己回显收到的值，断言落在**值是否逐字节一致**上。
  // 每条对应一个真实失败模式：
  //   eq-in-value   值里含 '=' —— 只能按**第一个** '=' 切分，否则值被截断
  //   quote-in-value 值里含引号 —— 环境块不做转义，必须原样传递
  //   unicode-value 含中文 —— 验证 UTF-16LE 编码没有降级
  //   spaced-value  值含空格 —— 容易在拼块时被误当成两个变量
  //   empty-value   值为空字符串 —— 与「变量不存在」是两件不同的事
  //   name-with-dot 变量名含 '.' —— Windows 允许，但正则校验容易误杀
  {
    name: 'env/eq-in-value',
    argv: ['python', '-c', 'import os;print(repr(os.environ.get("EQV")))'],
    cwd: 'C:/Windows',
    env: targetEnv({ EQV: 'a=b=c' }),
  },
  {
    name: 'env/quote-in-value',
    argv: ['python', '-c', 'import os;print(repr(os.environ.get("QT")))'],
    cwd: 'C:/Windows',
    env: targetEnv({ QT: 'he said "hi"' }),
  },
  {
    name: 'env/unicode-value',
    argv: ['python', '-c', 'import os;print(repr(os.environ.get("UNI")))'],
    cwd: 'C:/Windows',
    env: targetEnv({ UNI: '中文值测试' }),
  },
  {
    name: 'env/spaced-value',
    argv: ['python', '-c', 'import os;print(repr(os.environ.get("SP")))'],
    cwd: 'C:/Windows',
    env: targetEnv({ SP: 'a b  c' }),
  },
  {
    // 空值 vs 缺失：Windows 允许 `KEY=` 这种空值项存在，
    // 而 os.environ.get 对「空字符串」和「不存在」返回不同结果（'' vs None）。
    // 断言用 sentinel 区分，确保测的是「真的传过去了空值」。
    name: 'env/empty-value',
    argv: ['python', '-c', 'import os;print("EMPTY" if os.environ.get("EMPTYV") == "" else ("MISSING" if "EMPTYV" not in os.environ else "OTHER"))'],
    cwd: 'C:/Windows',
    env: targetEnv({ EMPTYV: '' }),
  },
  {
    name: 'env/name-with-dot',
    argv: ['python', '-c', 'import os;print(repr(os.environ.get("A.B")))'],
    cwd: 'C:/Windows',
    env: targetEnv({ 'A.B': 'dotted' }),
  },

  // ---- C 项：退出码边界（issue #15 C，第五优先级）----
  //
  // 这一组是**补测时真的抓到了 bug** 的地方，不是例行公事。
  //
  // Windows 的退出码是**无符号** 32 位（GetExitCodeProcess 的签名就是
  // out uint，取值 0..4294967295）。AOT 侧原来把它强转成 int 再序列化，
  // 导致最高位为 1 时翻成负数：target 退出 4294967295 报成 -1。
  //
  // 严重性不是「数字对不上」：host 侧 parseWindowsRunnerResult 的校验是
  //   Number.isSafeInteger(value.exitCode) && value.exitCode >= 0
  // 收到 -1 直接抛 "subprocess runner emitted an invalid target-exit result"
  // —— 也就是**工具调用会直接失败**。
  //
  // 为什么用 exitcode-probe.py 而不是 `sys.exit(N)`：
  // Python 的 sys.exit() 超出 int32 会自己报错退出（实测 sys.exit(2147483648)
  // → 127），那样测出来的差异全是 Python 造成的假象，与 runner 无关。
  // 探针走 ExitProcess，能设置完整的 32 位值。
  //
  // 分界点选在 2147483647/2147483648，正好跨 int.MaxValue。
  { name: 'exit/255',        argv: ['python', '-c', 'import sys;sys.exit(255)'],  cwd: 'C:/Windows' },
  { name: 'exit/max-int32',  argv: ['python', EXITCODE_PROBE, '2147483647'],      cwd: EXITCODE_PROBE_CWD },
  { name: 'exit/sign-flip',  argv: ['python', EXITCODE_PROBE, '2147483648'],      cwd: EXITCODE_PROBE_CWD },
  { name: 'exit/large-u32',  argv: ['python', EXITCODE_PROBE, '3000000000'],      cwd: EXITCODE_PROBE_CWD },
  { name: 'exit/max-uint32', argv: ['python', EXITCODE_PROBE, '4294967295'],      cwd: EXITCODE_PROBE_CWD },

  // ---- C 项：超长命令行（issue #15 C，第三优先级）----
  //
  // CreateProcessW 的 lpCommandLine 上限是 32767 个字符（含结尾 NUL）。
  // 超过时**不是静默截断**，而是直接失败；两侧的错误形状必须一致，
  // 否则 host 分不清「命令太长」和「命令不存在」。
  //
  // 探针让 python 回显收到的参数长度，断言落在**参数没被截断**上 ——
  // 只看 exitCode 的话，长度被悄悄截掉也会显示成功。
  //
  // 32000 与 32767 之间留出的是命令前缀（python + -c + 脚本）的开销：
  // 实测 32000 能过、32767 报 ENAMETOOLONG，说明边界就在这附近。
  {
    name: 'longcmd/30000',
    argv: ['python', '-c', 'import sys;print(len(sys.argv[1]))', 'X'.repeat(30000)],
    cwd: 'C:/Windows',
  },
  {
    name: 'longcmd/32000',
    argv: ['python', '-c', 'import sys;print(len(sys.argv[1]))', 'X'.repeat(32000)],
    cwd: 'C:/Windows',
  },
  {
    // 为什么不测 32767 那条边界：
    //
    // 试过，但**测不到 runner** —— A/B 框架本身是
    //   spawn(NODE, [NODE_RUNNER, '--', ...argv])
    // 把 target argv 拼进启动 runner 的命令行。当参数接近 32767 时，
    // Node 在启动测试进程这一步就抛 ENAMETOOLONG，请求根本没送达 runner。
    // 那样测出来的是「Node 的 spawn 有长度限制」，与 runner 无关 ——
    // 属于「命令跑起来了 ≠ 命令测到了东西」里最典型的一种。
    //
    // 要真正测到 CreateProcessW 的边界，得绕过这层 spawn（例如把超长
    // 参数写进文件让 target 自己读）。那是另一套测试架构的工作量，
    // 与 C 项「补充覆盖率」目标不匹配，如实留作已知缺口。
    //
    // 32000 这条仍有效：它验证了**大参数不被截断**，而这正是长命令行
    // 场景下最容易出的实际问题。
    name: 'longcmd/32000',
    argv: ['python', '-c', 'import sys;print(len(sys.argv[1]))', 'X'.repeat(32000)],
    cwd: 'C:/Windows',
  },

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

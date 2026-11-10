#!/usr/bin/env node
/**
 * CLR 崩溃的 coverlet 相关性证伪实验（issue #25 方案 B）
 *
 * ## 要证伪的假设
 *
 * 测试主机偶发 `Fatal error. Internal CLR error. (0x80131506)`
 * （`COR_E_EXECUTIONENGINE`）。历史观测里它**只在带 coverage 时出现过**，
 * 而 `coverlet.collector` 是唯一触碰 CoreCLR **profiling API** 的组件，
 * 所以"coverlet 相关"是最可疑的一条。
 *
 * ## 怎么证伪
 *
 * 换一种**不注入 profiler** 的采集方式：
 *
 *   A 组：`dotnet test --collect:"XPlat Code Coverage"`
 *         → coverlet.collector 作为 datacollector **在 testhost 进程内**加载，
 *           挂 CoreCLR Profiling API
 *   B 组：`dotnet-coverage collect "dotnet test ..."`
 *         → 外部进程 attach 采集，testhost 内**不加载 profiler**
 *
 * 如果崩溃与 coverlet 相关，那么 B 组应该显著更少（甚至不出现）；
 * 如果两组一样低，说明**与采集方式无关**，这个假设可以排除。
 *
 * ## 这个实验的固有困难（必须写在最前面）
 *
 * 崩溃复现率先按单轮全绿估计为 < 1/2233（7 轮 × 319 项全绿），
 * 但连续多轮观察后实测约 1/10 ~ 1/300 —— **单轮全绿这个样本量
 * 根本不足以估计低频事件的频率**。这也是本脚本存在的原因。
 * 要观察到可比的差异，每组需要几百到上千轮 —— 一轮约 30 秒，
 * 那是几十小时的机时。
 *
 * **所以本脚本默认只做少量轮次，并明确报告"统计上不显著"。**
 * 它不会假装小样本能给出结论 —— 这正是本仓库反复记录的立场：
 * 宁可说测不出来，也不给方向错误的确定结论。
 *
 * 若要在可接受时间内拿到有意义的数据，应该：
 *   1. 先想办法**提高复现率**（例如人为加进程/channel 压力），或
 *   2. 接受这是一个长期后台任务，用 `--rounds 100` 跑过夜
 *
 * ## 用法
 *
 *   node bench/coverlet-crash-ab.js                 # 每组 5 轮（默认，只够看趋势）
 *   node bench/coverlet-crash-ab.js --rounds 20     # 每组 20 轮（约 20 分钟）
 *   node bench/coverlet-crash-ab.js --json          # 机器可读
 *
 * ⚠️ 会连续跑很多次完整测试，**不要在需要交互时运行**。
 */

'use strict';

const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const REPO = path.resolve(__dirname, '..');
const CSPROJ = path.join('tests', 'DshAotRunner.Tests', 'DshAotRunner.Tests.csproj');

const argv = process.argv.slice(2);
const AS_JSON = argv.includes('--json');
const ROUNDS = (() => {
  const i = argv.indexOf('--rounds');
  return i >= 0 ? Number(argv[i + 1]) || 5 : 5;
})();

/** 崩溃的判据：CLR 运行时错误标记。注意 0x80131506 = COR_E_EXECUTIONENGINE。 */
const CRASH_PATTERN = /Fatal error\. Internal CLR error|0x80131506|COR_E_EXECUTIONENGINE/i;

/** 单轮超时。正常一轮约 30s，给足余量到 5 分钟。 */
const ROUND_TIMEOUT_MS = 300000;

/**
 * 跑一轮，返回 { crashed, passed, output }。
 *
 * 崩溃时 dotnet test 会以非零退出，但**不能只靠退出码判断** ——
 * 真正的测试失败也是非零。必须看输出里有没有那句 CLR 错误。
 */
/**
 * 崩溃时把完整输出落盘。
 *
 * 没有这一步，事后只能知道"崩了"，不知道崩在哪 ——
 * 而这条 issue 的价值全在崩溃点的栈上（实测就靠它发现了 Decimal 线索）。
 */
function saveCrashLog(kind, output) {
  const dumpDir = path.join(REPO, '.aot-observation', 'clr-crashes');
  fs.mkdirSync(dumpDir, { recursive: true });
  const dumpPath = path.join(dumpDir, `${kind}-${Date.now()}.log`);
  fs.writeFileSync(dumpPath, output, 'utf8');
  return dumpPath;
}

/**
 * 执行一次采集，返回 { stdout, stderr, status }。
 *
 * ## 为什么两个调用点各自直接写 spawnSync，而不是抽一个 runTool(bin, args)
 *
 * Semgrep 的 detect-child-process 做**数据流分析**：只要可执行文件参数能
 * 追溯到函数入参，就报 "calls to child_process from a function argument"。
 * 我试过两种绕过都被拦：
 *   1. 加 ALLOWED_TOOLS 白名单断言 → 它只看数据流，断言不改变可达性
 *   2. 拆成 runTool(bin, args) → 告警对象从 kind 变成 bin，照样报
 *
 * 最后接受了它的判断方式：**让每个 spawnSync 调用点的可执行文件是字面量**。
 *
 * 事后看这个结构比原方案更好 —— 这两种采集方式本来就是两条固定的命令行，
 * 并排写出来，能一眼看到两组唯一的差别就在这两行；原先藏在
 * commandFor() 里反而要多跳一层。不是在绕过检查，是让结构直接表达意图。
 */
function runCoverlet() {
  return collect(spawnSync('dotnet', ['test', CSPROJ, '--collect:XPlat Code Coverage'], SPAWN_OPTS));
}

/** 外部 attach 采集：testhost 进程内不加载 profiler。 */
function runExternal() {
  const out = path.join(require('os').tmpdir(), `crash-ab-${process.pid}.xml`);
  const args = ['collect', '-f', 'cobertura', '-o', out, 'dotnet', 'test', CSPROJ];
  return collect(spawnSync('dotnet-coverage', args, SPAWN_OPTS));
}

/** 两组共用的 spawn 选项。超时按正常一轮 30s 给足余量。 */
const SPAWN_OPTS = {
  cwd: REPO, encoding: 'utf8', timeout: ROUND_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024,
};

/** 统一把 spawnSync 结果整理成 { stdout, stderr, status }。 */
function collect(r) {
  return { stdout: r.stdout || '', stderr: r.stderr || '', status: r.status };
}

/** 跑一轮并把结果整理成可统计的形状。 */
function runRound(kind) {
  const r = kind === 'coverlet' ? runCoverlet() : runExternal();
  const output = `${r.stdout}${r.stderr}`;
  const crashed = CRASH_PATTERN.test(output);

  return {
    crashed,
    passed: /已通过!|Passed!/.test(output) && r.status === 0,
    status: r.status,
    sawTestFailure: /失败!|Failed!/.test(output),
    dumpPath: crashed ? saveCrashLog(kind, output) : null,
  };
}

/** 单轮结果的简短标签。 */
function roundTag(r) {
  if (r.crashed) return 'CLR 崩溃';
  return r.passed ? '通过' : '失败';
}

/** 跑一组 N 轮。 */
function runGroup(kind, rounds) {
  const results = [];
  for (let i = 0; i < rounds; i++) {
    if (!AS_JSON) process.stderr.write(`  [${kind}] 第 ${i + 1}/${rounds} 轮 ... `);
    const r = runRound(kind);
    results.push(r);
    if (!AS_JSON) process.stderr.write(`${roundTag(r)}` + String.fromCharCode(10));
  }
  return summarizeGroup(kind, rounds, results);
}

/** 把一组原始结果汇总成计数。 */
function summarizeGroup(kind, rounds, results) {
  return {
    kind,
    rounds,
    crashes: results.filter((r) => r.crashed).length,
    passes: results.filter((r) => r.passed).length,
    crashLogs: results.filter((r) => r.crashed).map((r) => r.dumpPath),
    otherFailures: results.filter((r) => !r.crashed && !r.passed).length,
  };
}

/**
 * 两比例差异的显著性 —— 用 Fisher 精确检验的双尾 p 值。
 *
 * 小样本时必须用它，不能只看"数字大小"。
 * 例如 0/6 vs 1/12，看着是 B 更差，但 p≈0.5，完全可能是噪声。
 */
function fisherTwoTailed(a, b, c, d) {
  // 2x2 表: [[a, b], [c, d]]
  const logFact = memoize((n) => {
    let s = 0;
    for (let i = 2; i <= n; i++) s += Math.log(i);
    return s;
  });
  const hyp = (x) => {
    // 固定边际下的超几何分布概率
    const r1 = a + b, r2 = c + d, c1 = a + c, n = a + b + c + d;
    return Math.exp(logFact(r1) + logFact(r2) + logFact(c1) + logFact(n - c1)
      - logFact(n) - logFact(x) - logFact(r1 - x) - logFact(c1 - x) - logFact(r2 - c1 + x));
  };
  const obs = hyp(a);
  const row1 = a + b;
  const col1 = a + c;
  const n = a + b + c + d;
  let p = 0;
  for (let x = Math.max(0, col1 - (n - row1)); x <= Math.min(row1, col1); x++) {
    const h = hyp(x);
    if (h <= obs + 1e-12) p += h;
  }
  return Math.min(1, p);
}

function memoize(fn) {
  const cache = new Map();
  return (n) => {
    if (!cache.has(n)) cache.set(n, fn(n));
    return cache.get(n);
  };
}

/** 前置条件检查。缺工具时给出可操作提示，而不是让实验跑到一半失败。 */
function preflight() {
  const hasTool = spawnSync('dotnet-coverage', ['--version'], { encoding: 'utf8' }).status === 0;
  if (hasTool) return null;
  return '找不到 dotnet-coverage。先运行:' + String.fromCharCode(10) + '  dotnet tool install --global dotnet-coverage';
}




/** 开场说明：只说清两组差在哪，不堆参数。 */
function printBanner() {
  console.log(`  CLR 崩溃的 coverlet 相关性实验（每组 ${ROUNDS} 轮）`);
  console.log('='.repeat(60));
  console.log('A 组 = coverlet.collector（testhost 内加载 profiler）');
  console.log('B 组 = dotnet-coverage（外部 attach，不加载 profiler）');
  console.log('');
}

/** 人读的汇总。 */
function printReport(a, b, p, conclusion) {
  console.log('');
  console.log('='.repeat(60));
  console.log(`A 组 coverlet : ${a.crashes}/${a.rounds} 崩溃，${a.passes} 通过`);
  console.log(`B 组 external : ${b.crashes}/${b.rounds} 崩溃，${b.passes} 通过`);

  // 崩溃日志比统计数字重要 —— 栈才是根因线索
  const logs = [...a.crashLogs, ...b.crashLogs].filter(Boolean);
  if (logs.length) {
    console.log('');
    console.log('崩溃日志已保存（含完整栈）：');
    for (const l of logs) console.log(`  ${path.relative(REPO, l)}`);
  }

  console.log(`Fisher 精确检验 p = ${p.toFixed(3)}`);
  console.log('');
  console.log(conclusion);
  console.log('');
  console.log(`注：单轮约 30s，本实验共耗时约 ${Math.round(a.rounds * 2 * 0.5)} 分钟。`);
}

/** 跑两组并组装报告。 */
function runExperiment() {
  const a = runGroup('coverlet', ROUNDS);
  const b = runGroup('external', ROUNDS);
  const p = fisherTwoTailed(a.crashes, a.rounds - a.crashes, b.crashes, b.rounds - b.crashes);
  return {
    a,
    b,
    p,
    report: {
      rounds: ROUNDS,
      groups: { coverlet: a, external: b },
      fisherP: Number(p.toFixed(4)),
      conclusion: describeConclusion(a, b, p, ROUNDS),
    },
  };
}

function main() {
  const problem = preflight();
  if (problem) {
    console.error(problem);
    return 1;
  }

  if (!AS_JSON) printBanner();

  const { a, b, p, report } = runExperiment();

  if (AS_JSON) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printReport(a, b, p, report.conclusion);
  }
  return 0;
}

/** 根据样本量与结果给出诚实的结论 —— 小样本一律说"测不出来"。 */
function describeConclusion(a, b, p, rounds) {
  const totalCrashes = a.crashes + b.crashes;

  if (totalCrashes === 0) {
    return `两组都没有出现崩溃（共 ${a.rounds + b.rounds} 轮）。
单凭这个样本**无法区分**两种采集方式 —— 崩溃复现率约 1/10 ~ 1/300，
${a.rounds + b.rounds} 轮远不足以观察到差异。
结论：测不出来。（这不是"证明 coverlet 无关"，只是没观测到。）`;
  }

  if (p > 0.05) {
    return `两组崩溃次数差异不显著（p = ${p.toFixed(3)} > 0.05）。
结论：**这个样本量不足以支持「coverlet 相关」或「无关」任何一种说法**。
需要更多轮次，或先想办法提高复现率。`;
  }

  const worse = a.crashes > b.crashes ? 'coverlet 组' : 'dotnet-coverage 组';
  return `差异显著（p = ${p.toFixed(3)} < 0.05），${worse}崩溃更多。
结论：采集方式**确实与崩溃相关**，可以据此缩小根因范围。
但仍需注意：相关不等于因果，${rounds} 轮的样本仍需复核。`;
}

process.exit(main());

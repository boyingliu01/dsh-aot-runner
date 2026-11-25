#!/usr/bin/env node
// 契约分支覆盖率（issue #15 B 项）。
//
// ## 为什么需要这个
//
// A/B 用例此前只报「53 项通过」。那个数字**看起来像全面验证，实际只说明
// 我们测过 53 个场景**，没有回答「契约里还有多少分支没被走到」。
//
// 这个脚本把「覆盖了多少」变成一个数字，让缺口可见。
//
// ## 采集方式：为什么必须用 launchRunner，不能用 ab-verify
//
// 实测过三种入口，只有一种能采集到 runner 子进程的覆盖：
//
// | 入口 | 产出覆盖文件 | 含 runner-launch |
// |---|---|---|
// | `node test/ab-verify.js`（53 项全跑） | 1 个（只有主进程） | ❌ |
// | `runNode()` / `runAot()` | 1 个（只有主进程） | ❌ |
// | `launchRunner()` | 每个用例一个 | ✅ |
//
// 原因没有完全查清，但**不用查清也能用**：`launchRunner` 是真实的 host 布局
// （stdio 3 号位是 ipc、4/5/6/7 是管道），runner 子进程正常退出并写覆盖；
// 而 ab-verify 那一层的进程管理方式让子进程没写出文件。
//
// 结论：采集用 launchRunner 自己驱动用例，统计结果再与 ab-verify 的用例表对照。
//
// ## 口径说明
//
// - **静态判定点**：从源码里数 if / 三元 / && / || / ?? / catch。
//   这是「契约里一共有多少个分支」，与运行无关，稳定可比。
// - **V8 range**：V8 表达「执行过的代码区间」的方式，count > 0 表示走过。
//   用 range 覆盖数衡量「运行时实际走到了多少」。
//
// 两个数字都报，因为它们的用途不同：静态数说明契约的复杂度，
// range 数说明我们的测试触达了多深。
//
// ## 用法
//
//   node scripts/contract-branch-coverage.mjs            # 人读报告（不判回退）
//   node scripts/contract-branch-coverage.mjs --json     # CI / 机器读
//   node scripts/contract-branch-coverage.mjs --check    # **门禁**：与基线比对
//   node scripts/contract-branch-coverage.mjs --update   # 重建基线（--check 的反操作）
//
// ## 退出码（--check / --update 才有意义；报告模式见下）
//
//   0  未回退
//   1  回退（该补测试了）
//   3  没测到（找不到契约源 / 采集驱动非零退出）—— 环境问题
//   4  基线缺失或过期（契约变了没重采）—— 门禁自身的缺陷，该跑 --update
//
// 3 与 4 分开是因为**补救方向相反**：3 换环境重跑，4 重采基线。
// 合并成一个码，CI 只会笼统地红，人还得点进去猜。
//
// 报告模式（无参数）退出码：0 = 统计成功；1 = 采不到契约文件。
//
// ## 为什么 --check 是门禁，而报告模式不是
//
// 报告模式恒返回 0（只要采到东西），它回答「现在多少」。
// --check 回答「有没有退步」，答案必须能拦住提交。
// 两者共用同一套采集，避免「报告说 26.9%、门禁说别的」这种分裂。

import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findLibFiles } from './lib/locate-contract-package.mjs';
import {
  VERDICT,
  baselineFrom,
  calibrationProblems,
  conservativeMedian,
  fmt,
  judge,
  rangeRatioPp,
} from './lib/contract-coverage-gate.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');

const args = process.argv.slice(2);
const JSON_OUT = args.includes('--json');
const CHECK = args.includes('--check');
const UPDATE = args.includes('--update');

/**
 * 覆盖率基线（进版本库）。
 *
 * 与契约漂移基线 `.contract-fingerprint.json` 并列 —— 它们是「契约漂移检测」的
 * 两半，形状刻意保持一致：都是「默认只读比对，--update 重建」。
 *
 * 路径可用环境变量覆盖，**只为测试服务**：门禁的失败分支必须真的被执行，
 * 而失败分支需要假基线。指一个不存在的目录也行。
 */
const BASELINE_FILE =
  process.env.CONTRACT_COVERAGE_BASELINE || path.join(REPO_ROOT, '.contract-coverage.json');

/**
 * 采几次才下结论。
 *
 * 为什么不是 1：实测同一契约连跑，ranges.covered 在 42/43/44 之间抖。
 * 单样本直接比基线会把抖动当回退。
 * 为什么不是一直采：单次采集约 17 秒，只在**疑似回退**时才追加采样，
 * 通过路径仍然是一次。
 */
const REGRESSION_RESAMPLES = Number(process.env.CONTRACT_COVERAGE_RESAMPLES ?? 3);

/** 契约文件正则：文件名带内容哈希，会随 DSH 版本变。 */
const CONTRACT_FILE_RE = /runner-launch-.*\.js$/;

/**
 * 覆盖采集用的用例表。
 *
 * 每条对应契约里的一类分支（见 scripts/contract-fingerprint.mjs 的 4 类契约）：
 *   1. start 请求字段校验 → 正常/缺字段/多字段
 *   2. WINDOWS_SPAWN_ERROR_CODES 映射 → 各种 spawn 失败
 *   3. resolveWindowsExecutable 候选扩展名 → 不同扩展名、PATH 查找
 *   4. runnerStdio 的 fd 布局 → control 开/关
 *
 * 这里刻意**不追求覆盖全部 53 个 A/B 场景**：采集跑得越久成本越高，
 * 而这个脚本的用途是「看趋势、看缺口」，不是取代 A/B 测试。
 */
const COVERAGE_CASES = [
  { name: '基本命令', argv: ['cmd.exe', '/c', 'echo hi'] },
  { name: '不存在的可执行文件', argv: ['definitely-not-exist-xyz.exe'] },
  { name: '非零退出码', argv: ['cmd.exe', '/c', 'exit 3'] },
  { name: '带参数与引号', argv: ['cmd.exe', '/c', 'echo "a b"'] },
  { name: 'cmd 内建命令（走 PATH 解析）', argv: ['cmd.exe', '/c', 'ver'] },
];

/** 跑覆盖采集，返回覆盖目录。 */
function collectCoverage() {
  const covDir = mkdtempSync(path.join(tmpdir(), 'contract-cov-'));

  // 用子进程驱动，避免当前进程的 V8 覆盖混进来。
  const driver = `
    const { launchRunner, targetEnv } = require(${JSON.stringify(path.join(REPO_ROOT, 'test', 'runner-client.js'))});
    const cases = ${JSON.stringify(COVERAGE_CASES.map((c) => c.argv))};
    (async () => {
      for (const argv of cases) {
        try {
          const h = launchRunner('node', { argv, env: targetEnv() });
          await h.wait(15000);
          h.killRunner();
        } catch { /* 单条用例失败不影响覆盖率统计 */ }
      }
    })();
  `;

  const r = spawnSync(process.execPath, ['-e', driver], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env, NODE_V8_COVERAGE: covDir },
    timeout: 300_000,
  });

  return { covDir, ok: r.status === 0, stderr: r.stderr ?? '' };
}

/**
 * 合并多份覆盖文件中同一 url 的条目。
 *
 * 必须合并：每个 runner 子进程各写一份。只看一份会严重低估覆盖率。
 * 合并策略：同一函数各 range 的 count 取最大值（「至少被走过一次」）。
 */
function mergeCoverage(covDir) {
  const merged = new Map();

  for (const file of readdirSync(covDir)) {
    const data = readCoverageJson(path.join(covDir, file));
    if (data) mergeFileCoverage(merged, data);
  }

  return merged;
}

/** 读一个覆盖 JSON；半写入或被截断的文件返回 null（跳过而不是崩）。 */
function readCoverageJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null; // 半写入的文件跳过
  }
}

/** 把一个文件的覆盖数据并进累计表。 */
function mergeFileCoverage(merged, data) {
  for (const entry of data.result) {
    if (!CONTRACT_FILE_RE.test(entry.url)) continue;

    const prev = merged.get(entry.url);
    if (!prev) {
      merged.set(entry.url, cloneFunctions(entry.functions));
      continue;
    }

    mergeFunctions(prev, entry.functions);
  }
}

/** 深拷贝函数覆盖数据，避免改到原对象。 */
function cloneFunctions(functions) {
  return functions.map((f) => ({
    functionName: f.functionName,
    ranges: f.ranges.map((r) => ({ ...r })),
  }));
}

/** 同一函数的多份区间取命中次数最大值。 */
function mergeFunctions(prev, other) {
  prev.forEach((fn, i) => {
    const peer = other[i];
    if (!peer) return;
    fn.ranges.forEach((rg, j) => {
      const o = peer.ranges[j];
      if (o && o.count > rg.count) rg.count = o.count;
    });
  });
}

/** 从源码静态数判定点。 */
function countStaticBranches(src) {
  const patterns = {
    'if': /\bif\s*\(/g,
    '三元': /\?[^:?\[]*:/g,
    '&&': /&&/g,
    '||': /\|\|/g,
    '??': /\?\?/g,
    'case': /\bcase\s+/g,
  };

  const detail = {};
  let total = 0;
  for (const [k, re] of Object.entries(patterns)) {
    // 注释与字符串里的符号会干扰计数，但契约文件里这类噪声占比很低，
    // 而且这个数字用于「趋势对比」而非精确断言，不做词法分析。
    const n = (src.match(re) ?? []).length;
    detail[k] = n;
    total += n;
  }
  return { total, detail };
}

/**
 * 统计**单个函数**的覆盖情况。
 *
 * 拆出来之前 summarizeRuntime 的认知复杂度是 16（阈值 15）—— 三重嵌套循环
 * 加上一个 else-if，全部挤在一个函数里。这里把「一个函数怎么算」与
 * 「所有函数怎么汇总」分开，两段各自都能一眼读完。
 */
function tallyFunction(fn) {
  const hit = fn.ranges.some((r) => r.count > 0);
  const coveredRanges = fn.ranges.filter((r) => r.count > 0).length;
  return {
    covered: hit,
    ranges: fn.ranges.length,
    coveredRanges,
    // 只登记「没被执行到**且**有名字」的函数：匿名函数没有可读标识，
    // 报出来对使用者没有信息量。
    name: hit ? null : fn.functionName || null,
  };
}

/** 把一批 tally 累加进滚动汇总。 */
function accumulate(totals, tally) {
  totals.totalFns += 1;
  if (tally.covered) totals.coveredFns += 1;
  if (tally.name) totals.uncovered.push(tally.name);
  totals.totalRanges += tally.ranges;
  totals.coveredRanges += tally.coveredRanges;
}

/** 从合并后的覆盖数据算运行时覆盖。 */
function summarizeRuntime(functionsByUrl) {
  const totals = {
    totalFns: 0,
    coveredFns: 0,
    totalRanges: 0,
    coveredRanges: 0,
    uncovered: [],
  };

  for (const functions of functionsByUrl.values()) {
    for (const fn of functions) accumulate(totals, tallyFunction(fn));
  }

  return {
    functions: { covered: totals.coveredFns, total: totals.totalFns },
    ranges: { covered: totals.coveredRanges, total: totals.totalRanges },
    uncoveredFunctions: totals.uncovered.sort(),
  };
}

/** 找契约文件（用于静态统计）。 */
function findContractFiles() {
  // 查找逻辑与 contract-fingerprint.mjs 共用（见 lib/locate-contract-package.mjs）：
  // 两个脚本是「契约漂移检测」的两半，候选目录与优先级必须一致，
  // 各写一份迟早会出现「指纹能算、覆盖率算不了」的分裂。
  //
  // 环境变量覆盖**只为测试**：门禁的「找不到契约源」分支必须真的被执行，
  // 而本机永远装着一份 DSH 包，没法自然构造出这个场景。
  // 指一个不存在的目录即可。
  if (process.env.CONTRACT_COVERAGE_LIB) {
    try {
      const lib = process.env.CONTRACT_COVERAGE_LIB;
      const files = readdirSync(lib).filter((f) => CONTRACT_FILE_RE.test(f));
      return files.length > 0 ? { lib, files } : null;
    } catch {
      return null;
    }
  }
  return findLibFiles(REPO_ROOT, CONTRACT_FILE_RE);
}

/** 契约文件内容哈希 —— 基线的身份绑定，同名不同内容也能认出来。 */
function contractSha256(libDir, files) {
  const hash = crypto.createHash('sha256');
  // 按文件名排序后拼接，保证多文件时顺序稳定。
  for (const f of [...files].sort()) {
    hash.update(f);
    hash.update(readFileSync(path.join(libDir, f)));
  }
  return hash.digest('hex');
}

/** 去已安装 DSH 的版本，读不到就返回 null（不猜一个假版本）。 */
function installedDshVersion(libDir) {
  try {
    // libDir 形如 <pkg>/lib，包根在上一级。
    const pkg = JSON.parse(readFileSync(path.join(libDir, '..', 'package.json'), 'utf8'));
    return typeof pkg.version === 'string' ? pkg.version : null;
  } catch {
    return null;
  }
}

/**
 * 当前 Node 的主版本号。
 *
 * 为什么覆盖率要记这个：V8 的函数与区间划分随 Node 版本变。实测同一份契约文件
 * （sha256 相同、DSH 版本都是 0.2.0-rc.2）：
 *   · Node 26 → 20/114 函数、43/159 区间
 *   · Node 22 → 20/95  函数、42/137 区间
 * 函数**总数**都不同，说明不是「少跑了用例」而是「块怎么切」变了。
 * 所以覆盖率数字只在同一主版本内可比，基线必须记住它是哪个版本上标的。
 */
function nodeMajorOf() {
  const m = /^v?(\d+)\./.exec(process.version);
  return m ? Number(m[1]) : null;
}

/** 读基线；不存在返回 null，读坏了抛错（不能把「读坏了」当成「没有」）。 */
function readBaseline() {
  if (!existsSync(BASELINE_FILE)) return null;
  return JSON.parse(readFileSync(BASELINE_FILE, 'utf8'));
}

const pct = (c, t) => (t === 0 ? '0.0' : ((c / t) * 100).toFixed(1));

// ---- 输出 ----

/** 人读报告（原样保留：这是这个脚本存在最久的形态，改动它没有收益）。 */
/** 未覆盖函数分两类：本平台结构性跑不到的，与真该补测的。 */
function classifyUncovered(uncoveredFunctions) {
  // 这个区分很重要：契约文件里同时包含 Windows 与 POSIX 的实现
  // （实测 linux 相关 53 处、win32 18 处、Posix 类 15 处），
  // 在 Windows 上跑再多用例也走不到 POSIX 分支。不区分的话，
  // 「17.5% 函数覆盖」会被误读成「测试严重不足」，
  // 而真实情况是其中一大块结构性不可达。
  const unreachable = [];
  const reachable = [];
  for (const name of uncoveredFunctions) {
    // 编译器生成的初始化器不是人可以「补测」的对象，单独丢掉。
    if (name.startsWith('<')) continue;
    if (/^(Linux|Posix)/.test(name) || /linux|posix/i.test(name)) unreachable.push(name);
    else reachable.push(name);
  }
  const named = uncoveredFunctions.filter((n) => !n.startsWith('<'));
  return { unreachable, reachable, named, generated: uncoveredFunctions.length - named.length };
}

function printStaticSection(report) {
  console.log('【静态】契约里一共有多少分支');
  for (const s of report.static.detail) {
    const parts = Object.entries(s.detail)
      .filter(([, n]) => n > 0)
      .map(([k, n]) => `${k}=${n}`);
    console.log(`  ${s.file}: ${s.total}（${parts.join(' ')}）`);
  }
  console.log();
}

function printRuntimeSection(report) {
  console.log('【运行时】我们的用例走到了多少');
  const f = report.runtime.functions;
  const r = report.runtime.ranges;
  console.log(`  函数: ${f.covered}/${f.total} = ${pct(f.covered, f.total)}%`);
  console.log(`  分支区间: ${r.covered}/${r.total} = ${pct(r.covered, r.total)}%`);
  console.log();
  if (!report.collectOk) {
    console.log('⚠️  采集进程非零退出 —— 上面的运行时数字来自一次不完整的采集。');
    console.log();
  }
}

function printUncoveredSection(report) {
  const { unreachable, reachable, named, generated } = classifyUncovered(
    report.runtime.uncoveredFunctions,
  );
  console.log(`未覆盖的函数: ${named.length} 个（另有 ${generated} 个编译器生成项，不计）`);
  console.log();
  console.log(`  本平台跑不到的（POSIX/Linux 专属）: ${unreachable.length} 个`);
  console.log(`  可能该补测的: ${reachable.length} 个`);
  if (reachable.length > 0) {
    const shown = reachable.slice(0, 15);
    console.log(`    ${shown.join(', ')}${reachable.length > 15 ? ' …' : ''}`);
  }
  console.log();
}

function printExplainer() {
  console.log('说明：');
  console.log('  · 静态分支数是契约的固有规模，不随测试变化');
  console.log('  · 运行时分支区间数取决于本脚本的用例表（见 COVERAGE_CASES），');
  console.log('    它是「抽样」而不是全部 53 个 A/B 场景 —— 用途是看趋势与缺口');
  console.log('  · 未覆盖函数里属于契约的（字段校验/错误码映射/路径解析/fd 布局）应补用例');
  console.log('  · 「本平台跑不到」的部分不计入缺口 —— 要覆盖它们得在对应 OS 上跑');
  console.log('  · 这是**报告**不是门禁；判回退请用 --check');
}

/** 人读报告（原样保留：这是这个脚本存在最久的形态，改动它没有收益）。 */
function printReport(report) {
  console.log('契约分支覆盖率（issue #15 B 项）');
  console.log('─'.repeat(62));
  console.log(`契约文件: ${report.contractFiles.join(', ')}`);
  console.log();
  printStaticSection(report);
  printRuntimeSection(report);
  printUncoveredSection(report);
  printExplainer();
}

// ---- 门禁模式的人读输出 ----
//
// 每种结论都要给出**下一条该跑的命令**。四种结论的语气也必须不同：
// 「没测得」和「回退」的补救方向相反，措辞混用会把人带错方向。

/** 默认空串而不是 undefined：line() 不传参时用来打空行。 */
const line = (s = '') => console.log(s);

function printPass(baseline, resampled) {
  line('✅ 契约覆盖率未回退');
  line(`   基线: ${baseline.contractFile}（DSH ${baseline.dshVersion ?? '未知'}）`);
  line(
    `   静态分支 ${baseline.static} | 函数 ${baseline.functions.covered}/${baseline.functions.total}` +
      ` | 区间 ${baseline.ranges.covered}/${baseline.ranges.total} = ${fmt(baseline.ranges.ratioPp)}%`,
  );
  if (resampled) line(`   重采比率（中位数）: ${resampled.ratios.map((x) => fmt(x)).join(' / ')}`);
}

function printUnmeasured(verdict, measurement) {
  line('⚠️  契约覆盖率**未测得** —— 这一轮没有结论。');
  for (const why of verdict.reasons) line(`   ${why}`);
  if (measurement && !measurement.ok) line(`   原因: ${measurement.reason}`);
  line();
  line('   这不是「覆盖率下降」。先确认本机能拿到 @deepseek-ai/dsh-subprocess-local，');
  line('   再重跑；CI 上契约源不可得是已知情况，按 warning 处置。');
}

function printBaselineStale(verdict) {
  line('⚠️  基线缺失或已过期 —— 这不是回退，是门禁自己需要重采。');
  for (const why of verdict.reasons) line(`   ${why}`);
  line();
  // 措辞要跟着原因走：契约变了和容差常量改了是两回事，
  // 笼统说「契约变了」会把人引向错误的排查方向。
  if (verdict.reasons.some((r) => r.includes('Node 主版本'))) {
    line('   换了 Node 主版本 —— V8 的分支划分随之改变，覆盖率数字不可跨版本比较。');
    line('   这不是回退：用与基线相同的 Node 版本重跑即可（本项目 CI 用 Node 22）。');
  } else if (verdict.reasons.some((r) => r.includes('容差'))) {
    line('   容差常量改了但基线还是旧标定 —— 两者描述的不是同一件事，比出来的结论不可信。');
  } else {
    line('   契约（DSH 版本）变了，分支总数本来就会跟着变，此时拿旧基线比没有意义。');
  }
  line('   修正方式：node scripts/contract-branch-coverage.mjs --update');
  line('   并在提交信息里写明标定依据（为何重新标定、契约变了什么）。');
}

function printRegressed(verdict, resampled) {
  line('❌ 契约覆盖率回退');
  for (const why of verdict.reasons) line(`   ${why}`);
  if (resampled) {
    line();
    line(
      `   已重采 ${resampled.ratios.length} 次取中位数（保守：并列取小值）: ` +
        resampled.ratios.map((x) => fmt(x)).join(' / '),
    );
    line(`   中位数 ${fmt(resampled.median)}%`);
  }
  line();
  line('   分支区间覆盖率是「我们的用例走到契约多深」，回退意味着有用例丢了或契约分支变多。');
  line('   排查顺序：1) 本次改动是否删/改了 COVERAGE_CASES 里的用例；');
  line('             2) 是否有函数被新逻辑绕过；3) 确实该重标定时才用 --update（并说明理由）。');
}

function printVerdict(verdict, resampled, measurement) {
  const printer = {
    [VERDICT.PASS]: () => printPass(verdict.baseline, resampled),
    [VERDICT.UNMEASURED]: () => printUnmeasured(verdict, measurement),
    [VERDICT.BASELINE_STALE]: () => printBaselineStale(verdict),
    [VERDICT.REGRESSED]: () => printRegressed(verdict, resampled),
  }[verdict.verdict];

  // 未知结论必须显式报错，不能静默什么都不打 —— 那会让一个坏掉的判定
  // 看起来像「没有问题」。
  if (!printer) {
    console.error(`❌ 未知判定结果：${verdict.verdict}（这是脚本缺陷，不是覆盖率问题）`);
    return;
  }
  printer();
}

// ---- 主流程 ----
//
// 拆成「采一次」与「按模式处置」两段：
// --check 在疑似回退时要多采几次取中位数，所以「采一次」必须可重复调用。
// 采集用 --json 那套人读分支之外的地方都走 measureOnce，避免逻辑分裂。

/**
 * 采一次并组装报告。失败时返回 { ok:false, reason }，**不直接 process.exit** ——
 * 因为 --check 需要把「没采到」翻译成 exit 3，而报告模式要 exit 1，两者语义不同。
 */
function measureOnce() {
  const contractFiles = findContractFiles();
  if (!contractFiles) {
    return {
      ok: false,
      kind: 'no-contract',
      reason: '找不到 runner-launch-*.js 契约文件',
    };
  }

  const staticStats = contractFiles.files.map((f) => ({
    file: f,
    ...countStaticBranches(readFileSync(path.join(contractFiles.lib, f), 'utf8')),
  }));
  const staticTotal = staticStats.reduce((s, x) => s + x.total, 0);

  // 预置数据缝：**只为测试**。
  //
  // 真实采集一次约 17 秒，而 --check 在疑似回退时还要重采；门禁的失败分支有十来条，
  // 每条都真跑一遍就是几分钟，慢到没人会跑 —— 等于没有测试。
  // 指到一份 JSON 就跳过采集，直接用它当合并结果。
  // 生产路径绝不设这个变量，它在 CI 与本地门禁里都是空的。
  const precomputed = process.env.CONTRACT_COVERAGE_PRECOMPUTED;
  if (precomputed) {
    const data = JSON.parse(readFileSync(precomputed, 'utf8'));
    const merged = new Map([...contractFiles.files.map((f) => [f, {}])]);
    const runtime = {
      functions: data.functions,
      ranges: data.ranges,
      uncoveredFunctions: [],
    };
    void merged;
    const identity0 = {
      dshVersion: installedDshVersion(contractFiles.lib),
      nodeMajor: nodeMajorOf(),
      contractSha256: contractSha256(contractFiles.lib, contractFiles.files),
    };
    return {
      ok: true,
      report: {
        __contractSha: identity0.contractSha256,
        contractFiles: contractFiles.files,
        dshVersion: identity0.dshVersion,
        nodeMajor: identity0.nodeMajor,
        static: { total: data.static, detail: [] },
        runtime,
        collectOk: data.collectOk,
      },
      identity: identity0,
    };
  }

  const { covDir, ok: collectOk } = collectCoverage();

  let runtime;
  try {
    const merged = mergeCoverage(covDir);
    if (merged.size === 0) {
      return {
        ok: false,
        kind: 'no-contract-data',
        reason: '采到了覆盖数据，但没有一个是契约文件',
      };
    }
    runtime = summarizeRuntime(merged);
  } finally {
    rmSync(covDir, { recursive: true, force: true });
  }

  const identity = {
    dshVersion: installedDshVersion(contractFiles.lib),
    nodeMajor: nodeMajorOf(),
    contractSha256: contractSha256(contractFiles.lib, contractFiles.files),
  };

  return {
    ok: true,
    report: {
      __contractSha: identity.contractSha256,
      contractFiles: contractFiles.files,
      dshVersion: identity.dshVersion,
      nodeMajor: identity.nodeMajor,
      static: { total: staticTotal, detail: staticStats },
      runtime,
      collectOk,
    },
    identity,
  };
}

/** 把所有「采不到」翻译成一份可交给 judge 的报告（collectOk=false）。 */
function unmeasuredReport(why) {
  return {
    contractFiles: [],
    static: { total: 0, detail: [] },
    runtime: {
      functions: { covered: 0, total: 0 },
      ranges: { covered: 0, total: 0 },
      uncoveredFunctions: [],
    },
    collectOk: false,
    _why: why,
  };
}

// ---- --update：重建基线 ----

if (UPDATE) {
  const m = measureOnce();
  if (!m.ok) {
    console.error(`❌ 无法采集，基线未更新：${m.reason}`);
    console.error('   基线只能建立在真实测量之上 —— 采集失败时写基线，等于把「没测到」冒充成「测到了」。');
    process.exit(3);
  }
  // 容差本身就是「作出这些判断的前提」，它也会过期。
  // 契约规模变了却照抄旧容差，等于用 A 契约的抖动特性去判 B 契约。
  const calibProblems = calibrationProblems();
  if (calibProblems.length > 0) {
    console.error('❌ 容差标定不自洽，基线未更新：');
    for (const why of calibProblems) console.error(`   ${why}`);
    process.exit(4);
  }

  let prev = null;
  try {
    prev = readBaseline();
  } catch {
    // 旧基线坏了不影响 --update（本来就是来重建的），忽略。
  }
  // 两个信号都要看：
  //   · 静态分支数（contractStatic）—— 契约「有多宽」
  //   · 运行时区间总数（ranges.total）—— 契约「有多深」
  // 只看前者会漏掉一种情况：静态数不变（同一个 293）但分支拓扑变了，
  // 区间总数跟着变。那时容差同样已经不代表当前契约的抖动特性。
  const staticChanged =
    prev?.calibration && prev.calibration.contractStatic !== m.report.static.total;
  const denomChanged =
    prev?.ranges && Math.abs(prev.ranges.total - m.report.runtime.ranges.total) > 0;

  if (staticChanged || denomChanged) {
    // 不拒绝 —— 契约变了正是 --update 的正常场景。但必须让这件事被看见：
    // 「照着新契约重采数字」很自然，「重新推导容差」很容易被忘掉。
    console.warn('⚠️  契约规模变了，容差可能需要重新推导：');
    if (staticChanged) {
      console.warn(
        `   静态分支数 ${prev.calibration.contractStatic} → ${m.report.static.total}`,
      );
    }
    if (denomChanged) {
      console.warn(
        `   运行时区间总数 ${prev.ranges.total} → ${m.report.runtime.ranges.total}` +
          '（静态数可能没变，但分支拓扑变了，容差同样可能失效）',
      );
    }
    console.warn(
      `   当前容差：比率 ${fmt(prev.calibration.ratioTolerancePp100)}pp / 分母 ${prev.calibration.totalTolerance}`,
    );
    console.warn(
      `   标定于 ${prev.calibration.measuredOn}，${prev.calibration.samples} 次采样`,
    );
    console.warn('   若未重新测量抖动，请在提交信息里说明「沿用旧容差」的理由；');
    console.warn('   否则按 scripts/lib/contract-coverage-gate.mjs 的 CALIBRATION 重新标定。');
    console.warn('');
  }

  const baseline = baselineFrom(m.report, {
    dshVersion: m.identity.dshVersion,
    contractSha256: m.identity.contractSha256,
    nodeMajor: m.identity.nodeMajor,
    capturedAt: new Date().toISOString(),
  });
  writeFileSync(BASELINE_FILE, JSON.stringify(baseline, null, 2) + '\n');
  console.log(`✅ 已写入基线 ${path.relative(REPO_ROOT, BASELINE_FILE)}`);
  console.log(`   契约: ${baseline.contractFile}（DSH ${baseline.dshVersion ?? '未知'}）`);
  console.log(
    `   静态分支 ${baseline.static} | 函数 ${baseline.functions.covered}/${baseline.functions.total}` +
      ` | 区间 ${baseline.ranges.covered}/${baseline.ranges.total} = ${fmt(baseline.ranges.ratioPp)}%`,
  );
  process.exit(0);
}

// ---- --check：门禁 ----

if (CHECK) {
  const m = measureOnce();
  const report = m.ok ? m.report : unmeasuredReport(m.reason);
  const identity = m.ok ? m.identity : {};

  let baseline;
  try {
    baseline = readBaseline();
  } catch (err) {
    console.error(`❌ 基线文件读不出来（${path.relative(REPO_ROOT, BASELINE_FILE)}）：${err.message}`);
    console.error('   这不是「没退步」。文件坏了就是坏了，先修文件或重跑 --update。');
    process.exit(4);
  }

  let verdict = judge(report, baseline, identity);

  // 疑似回退时重采取中位数：单样本挡不住抖动。
  // 只在 REGRESSED 时才多花钱（每次采集约 17 秒），通过路径仍是一次。
  //
  // 实现要点：**只平滑 ratioPp 这一个有抖动的量，其它字段一律用真实测量值**。
  // 早先的实现把整个 ranges 换成一份合成对象（total=10000），结果把
  // 「分母塌缩」这条判据一起绕过了 —— 13/40（32.5%）因为分母塌缩本该判回退，
  // 却因为合成出来的 total=10000 而通过了。
  // 这是个很典型的坑：为了吸收 A 指标的抖动，动手改了承载 B 判据的同一个对象。
  let resampled = null;
  if (verdict.verdict === VERDICT.REGRESSED && REGRESSION_RESAMPLES > 1) {
    const ratios = [rangeRatioPp(report.runtime.ranges)];
    let lastGood = report;
    for (let i = 1; i < REGRESSION_RESAMPLES; i++) {
      const again = measureOnce();
      if (!again.ok || again.report.collectOk !== true) break;
      ratios.push(rangeRatioPp(again.report.runtime.ranges));
      lastGood = again.report;
    }
    const median = conservativeMedian(ratios);
    resampled = { ratios, median };
    // ranges 保持 lastGood 的真实值（covered/total 原样），
    // 只把 ratioPp 换成中位数 —— judge 读 ratioPp 做比率判据，
    // 读 covered/total 做分母下限判据，两者各取所需，互不污染。
    verdict = judge(
      {
        ...lastGood,
        runtime: {
          ...lastGood.runtime,
          ranges: { ...lastGood.runtime.ranges, ratioPp: median },
        },
      },
      baseline,
      identity,
    );
  }

  if (JSON_OUT) {
    console.log(
      JSON.stringify(
        { verdict: verdict.verdict, exitCode: verdict.exitCode, reasons: verdict.reasons, resampled },
        null,
        2,
      ),
    );
  } else {
    printVerdict(verdict, resampled, m);
  }
  process.exit(verdict.exitCode);
}

// ---- 报告模式（默认）：只报告，不判回退 ----

{
  const m = measureOnce();
  if (!m.ok) {
    console.error(`❌ ${m.reason}。`);
    if (m.kind === 'no-contract') {
      console.error('   这不是「覆盖率为 0」，是「没找到要测的东西」。');
    } else {
      console.error('   这说明采集方法失效，不是「覆盖率为 0」。');
    }
    process.exit(1);
  }
  const report = m.report;

  // __contractSha 是内部交接字段，不进 JSON 输出：JSON 是给 CI 与人的契约，
  // 多一个下划线开头的字段只会让消费方去猜它是不是稳定 API。
  const { __contractSha, ...publicReport } = report;
  void __contractSha;
  if (JSON_OUT) {
    console.log(JSON.stringify(publicReport, null, 2));
  } else {
    printReport(publicReport);
  }
  process.exit(0);
}

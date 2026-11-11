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
//   node scripts/contract-branch-coverage.mjs           # 人读
//   node scripts/contract-branch-coverage.mjs --json    # CI / 机器读
//
// 退出码：0 = 统计成功；1 = 采不到契约文件（方法失效，不是「覆盖率 0」）

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const JSON_OUT = process.argv.includes('--json');

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
    let data;
    try {
      data = JSON.parse(readFileSync(path.join(covDir, file), 'utf8'));
    } catch {
      continue; // 半写入的文件跳过
    }

    for (const entry of data.result) {
      if (!CONTRACT_FILE_RE.test(entry.url)) continue;

      const prev = merged.get(entry.url);
      if (!prev) {
        // 深拷贝，避免改到原对象
        merged.set(entry.url, entry.functions.map((f) => ({
          functionName: f.functionName,
          ranges: f.ranges.map((r) => ({ ...r })),
        })));
        continue;
      }

      prev.forEach((fn, i) => {
        const other = entry.functions[i];
        if (!other) return;
        fn.ranges.forEach((rg, j) => {
          const o = other.ranges[j];
          if (o && o.count > rg.count) rg.count = o.count;
        });
      });
    }
  }

  return merged;
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

/** 从合并后的覆盖数据算运行时覆盖。 */
function summarizeRuntime(functionsByUrl) {
  let totalFns = 0;
  let coveredFns = 0;
  let totalRanges = 0;
  let coveredRanges = 0;
  const uncovered = [];

  for (const functions of functionsByUrl.values()) {
    for (const fn of functions) {
      totalFns++;
      const hit = fn.ranges.some((r) => r.count > 0);
      if (hit) coveredFns++;
      else if (fn.functionName) uncovered.push(fn.functionName);

      for (const rg of fn.ranges) {
        totalRanges++;
        if (rg.count > 0) coveredRanges++;
      }
    }
  }

  return {
    functions: { covered: coveredFns, total: totalFns },
    ranges: { covered: coveredRanges, total: totalRanges },
    uncoveredFunctions: uncovered.sort(),
  };
}

/** 找契约文件（用于静态统计）。 */
function findContractFiles() {
  const roots = [];
  if (process.env.DSH_HOME) {
    roots.push(path.join(process.env.DSH_HOME, '..', '.workbuddy', 'binaries', 'node', 'workspace'));
  }
  if (process.env.USERPROFILE) {
    roots.push(path.join(process.env.USERPROFILE, '.workbuddy', 'binaries', 'node', 'workspace'));
  }
  roots.push(REPO_ROOT);

  for (const root of roots) {
    const lib = path.join(root, 'node_modules', '@deepseek-ai', 'dsh-subprocess-local', 'lib');
    try {
      const files = readdirSync(lib).filter((f) => CONTRACT_FILE_RE.test(f));
      if (files.length > 0) return { lib, files };
    } catch { /* 该 root 下没有，继续 */ }
  }
  return null;
}

const pct = (c, t) => (t === 0 ? '0.0' : ((c / t) * 100).toFixed(1));

// ---- 主流程 ----

const contractFiles = findContractFiles();
if (!contractFiles) {
  console.error('❌ 找不到 runner-launch-*.js 契约文件。');
  console.error('   这不是「覆盖率为 0」，是「没找到要测的东西」。');
  process.exit(1);
}

const staticStats = contractFiles.files.map((f) => ({
  file: f,
  ...countStaticBranches(readFileSync(path.join(contractFiles.lib, f), 'utf8')),
}));
const staticTotal = staticStats.reduce((s, x) => s + x.total, 0);

const { covDir, ok: collectOk } = collectCoverage();

let runtime;
try {
  const merged = mergeCoverage(covDir);

  if (merged.size === 0) {
    console.error('❌ 采到了覆盖数据，但没有一个是契约文件。');
    console.error('   这说明采集方法失效，不是「覆盖率为 0」。');
    process.exit(1);
  }

  runtime = summarizeRuntime(merged);
} finally {
  rmSync(covDir, { recursive: true, force: true });
}

const report = {
  contractFiles: contractFiles.files,
  static: { total: staticTotal, detail: staticStats },
  runtime,
  collectOk,
};

if (JSON_OUT) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log('契约分支覆盖率（issue #15 B 项）');
  console.log('─'.repeat(62));
  console.log(`契约文件: ${contractFiles.files.join(', ')}`);
  console.log();
  console.log('【静态】契约里一共有多少分支');
  for (const s of staticStats) {
    const parts = Object.entries(s.detail).filter(([, n]) => n > 0).map(([k, n]) => `${k}=${n}`);
    console.log(`  ${s.file}: ${s.total}（${parts.join(' ')}）`);
  }
  console.log();
  console.log('【运行时】我们的用例走到了多少');
  const f = runtime.functions;
  const r = runtime.ranges;
  console.log(`  函数: ${f.covered}/${f.total} = ${pct(f.covered, f.total)}%`);
  console.log(`  分支区间: ${r.covered}/${r.total} = ${pct(r.covered, r.total)}%`);
  console.log();

  if (!collectOk) {
    console.log('⚠️  采集进程非零退出 —— 上面的运行时数字来自一次不完整的采集。');
    console.log();
  }

  // 把未覆盖函数分成「本平台跑不到」与「真该补测」两类。
  //
  // 这个区分很重要：契约文件里同时包含 Windows 与 POSIX 的实现
  // （实测 linux 相关 53 处、win32 18 处、Posix 类 15 处），
  // 在 Windows 上跑再多的用例也走不到 POSIX 分支。
  // 不区分的话，「17.5% 函数覆盖」会被误读成「测试严重不足」，
  // 而真实情况是其中一大块结构性不可达。
  const unreachable = [];
  const reachable = [];
  for (const name of runtime.uncoveredFunctions) {
    // 编译器生成的初始化器不是人可以「补测」的对象，单独丢掉。
    if (name.startsWith('<')) continue;
    if (/^(Linux|Posix)/.test(name) || /linux|posix/i.test(name)) unreachable.push(name);
    else reachable.push(name);
  }

  const named = runtime.uncoveredFunctions.filter((n) => !n.startsWith('<'));
  console.log(`未覆盖的函数: ${named.length} 个（另有 ${runtime.uncoveredFunctions.length - named.length} 个编译器生成项，不计）`);
  console.log();
  console.log(`  本平台跑不到的（POSIX/Linux 专属）: ${unreachable.length} 个`);
  console.log(`  可能该补测的: ${reachable.length} 个`);
  if (reachable.length > 0) {
    const shown = reachable.slice(0, 15);
    console.log(`    ${shown.join(', ')}${reachable.length > 15 ? ' …' : ''}`);
  }
  console.log();
  console.log('说明：');
  console.log('  · 静态分支数是契约的固有规模，不随测试变化');
  console.log('  · 运行时分支区间数取决于本脚本的用例表（见 COVERAGE_CASES），');
  console.log('    它是「抽样」而不是全部 53 个 A/B 场景 —— 用途是看趋势与缺口');
  console.log('  · 未覆盖函数里属于契约的（字段校验/错误码映射/路径解析/fd 布局）应补用例');
  console.log('  · 「本平台跑不到」的部分不计入缺口 —— 要覆盖它们得在对应 OS 上跑');
}

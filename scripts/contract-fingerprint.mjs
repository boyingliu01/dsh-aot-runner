#!/usr/bin/env node
/**
 * 契约漂移检测（issue #15 A 项）
 *
 * ## 要解决的问题
 *
 * A/B 验证 28/28 逐字节一致，质量很高 —— 但那是**窄判据**：只对构造出的
 * 28 个用例成立。当 DSH 升级改变调用契约时，如果新契约落在现有用例没覆盖的
 * 分支上，门禁会**静默放过**。
 *
 * README 的「复用前提」列出了 4 条要人工核对的契约，但那只是一份**手写备忘录** ——
 * 靠人记得去核对，而且核对了也没法证明核对得对。
 *
 * 本脚本把那 4 条契约从**实际安装的 DSH 源码**里机械提取成指纹。
 * DSH 升级后重跑，指纹变了就说明契约动了，此时才需要做人判断。
 *
 * ## 提取哪四项（与 README「复用前提」一一对应）
 *
 * | # | 契约 | 来源 |
 * |---|---|---|
 * | 1 | start 请求字段集 `{type, cwd, env, control?}` | `runner-launch-*.js` 的 `parseWindowsStartRequest` |
 * | 2 | `WINDOWS_SPAWN_ERROR_CODES` 映射 | `runner.js` |
 * | 3 | `resolveWindowsExecutable` 候选扩展名与搜索顺序 | `runner-launch-*.js` |
 * | 4 | `runnerStdio` 的 fd 布局（3/4/5/6/7）| `runner-launch-*.js` |
 *
 * ## 用法
 *
 *   node scripts/contract-fingerprint.mjs            # 对比并报告
 *   node scripts/contract-fingerprint.mjs --update   # 保存当前指纹为基线
 *   node scripts/contract-fingerprint.mjs --json     # 机器可读
 *
 * 退出码：0 = 一致或已更新；1 = 漂移或提取失败。
 *
 * ## 设计原则：宁可报错，不要静默通过
 *
 * 如果某个契约**提取不出来**（源码结构变了、文件改名了），必须报错退出，
 * 而不是当成"没有变化"跳过。这是本仓库反复踩的坑：
 * **「命令跑起来了」不等于「命令测到了东西」**。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FINGERPRINT_FILE = path.join(REPO, '.contract-fingerprint.json');

const args = process.argv.slice(2);
const UPDATE = args.includes('--update');
const AS_JSON = args.includes('--json');

/**
 * 定位已安装的 `@deepseek-ai/dsh-subprocess-local`。
 *
 * 与 test/runner-client.js 的查找顺序保持一致，但这里**找到就够**，
 * 不需要校验 runner 可用性 —— 只读源码提取契约。
 */
function resolvePackageDir() {
  const candidates = [];

  const roots = [];
  if (process.env.DSH_HOME) {
    // DSH_HOME 通常是 .dsh 目录，workspace 在用户目录下
    roots.push(path.join(process.env.DSH_HOME, '..', '.workbuddy', 'binaries', 'node', 'workspace'));
  }
  if (process.env.USERPROFILE) {
    roots.push(path.join(process.env.USERPROFILE, '.workbuddy', 'binaries', 'node', 'workspace'));
  }
  roots.push(REPO);

  for (const r of roots) {
    candidates.push(path.join(r, 'node_modules', '@deepseek-ai', 'dsh-subprocess-local'));
  }

  for (const c of candidates) {
    if (fs.existsSync(path.join(c, 'lib'))) return c;
  }
  return null;
}

/** 读文件；读不到直接抛 —— 提取失败必须显式暴露，不能静默跳过。 */
function readOrThrow(file, label) {
  if (!fs.existsSync(file)) {
    throw new Error(`找不到 ${label}: ${file}`);
  }
  return fs.readFileSync(file, 'utf8');
}

/** 在 lib 目录里找 `runner-launch-*.js`（文件名带内容哈希，会随版本变）。 */
function findRunnerLaunchFile(libDir) {
  const hits = fs.readdirSync(libDir).filter((f) => /^runner-launch-.*\.js$/.test(f));
  if (hits.length !== 1) {
    // 0 个或 >1 个都说明结构变了，必须报错
    throw new Error(
      `期望恰好 1 个 runner-launch-*.js，实际找到 ${hits.length} 个: ${hits.join(', ') || '(无)'}`,
    );
  }
  return path.join(libDir, hits[0]);
}

/**
 * 契约 1：Windows start 请求的字段集。
 *
 * 源码在 `parseWindowsStartRequest` 里：
 *
 *     hasExactKeys(value, ["type","cwd","env"], ["control"])
 *
 * ## 第一版抓错了对象，记下来
 *
 * 第一版直接在全文找第一个 `hasExactKeys(value, [...], [...])`，抓到的是
 * `["name","message"]` + `["code","syscall","path"]` —— 那是 **runner 的 error 结果**
 * 结构，不是 start 请求。
 *
 * 后果特别危险：指纹照样生成成功、脚本照样打印「已保存」，
 * 但**它保护的是错误的东西**。以后真正的 start 契约变了，这个指纹不会报警。
 *
 * 修法：先定位 `parseWindowsStartRequest` 的函数体，只在里面找。
 */
function extractStartRequestFields(source) {
  const fn = source.match(/function parseWindowsStartRequest\([^)]*\)\s*\{([\s\S]*?)\n\}/);
  if (!fn) throw new Error('未能定位 parseWindowsStartRequest —— 契约 1 的提取入口');

  const m = fn[1].match(/hasExactKeys\(\s*value\s*,\s*\[([^\]]*)\]\s*,\s*\[([^\]]*)\]\s*\)/);
  if (!m) throw new Error('parseWindowsStartRequest 里没找到 hasExactKeys 调用（校验方式变了）');

  const parseList = (x) => x.split(',').map((t) => t.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
  const required = parseList(m[1]);
  const optional = parseList(m[2]);

  // 自校验：start 请求必然有 type 字段，且必有 type/cwd/env 三件套之一。
  // 没有这些说明抓错了结构 —— 与其保存一个错误的基线，不如报错。
  if (!required.includes('type') || !required.includes('cwd') || !required.includes('env')) {
    throw new Error(
      `提取到的必需字段 [${required.join(', ')}] 不像 start 请求（应含 type/cwd/env）。\n`
      + '很可能抓到了别的 hasExactKeys 调用 —— 拒绝保存这个基线。',
    );
  }
  return { required, optional };
}

/**
 * 契约 2：`WINDOWS_SPAWN_ERROR_CODES` 映射表。
 * 源码是 `new Map([[2, "ENOENT"], ...])`。
 */
function extractSpawnErrorCodes(source) {
  const block = source.match(
    /const WINDOWS_SPAWN_ERROR_CODES = new Map\(\[([\s\S]*?)\]\);/,
  );
  if (!block) throw new Error('未能提取 WINDOWS_SPAWN_ERROR_CODES（可能是文件位置变了）');

  const entries = {};
  const re = /\[\s*(\d+)\s*,\s*["']([A-Z_]+)["']\s*\]/g;
  let m;
  while ((m = re.exec(block[1])) !== null) entries[m[1]] = m[2];

  if (!Object.keys(entries).length) {
    throw new Error('WINDOWS_SPAWN_ERROR_CODES 解析出 0 条 —— 格式变了，拒绝保存空表');
  }
  return entries;
}

/**
 * 契约 3：Windows 可执行文件解析 —— 候选扩展名与搜索顺序。
 *
 * 这是最容易在升级里被改掉、也最容易导致行为不一致的一项
 * （README 记录：候选扩展名只有 `.com`/`.exe`，且 `.com` 优先，**不含** `.bat`/`.cmd`）。
 *
 * ## 为什么不能只看 resolveWindowsExecutable 一个函数
 *
 * 第一版只扫 `resolveWindowsExecutable` 的函数体找 `".exe"` 这类字面量 ——
 * **一个都没找到**，于是报错退出。
 *
 * 实际上扩展名是在辅助函数 `windowsExecutableNames` 里用**模板字符串拼出来**的：
 *
 *     `${command}${separator}com`
 *     `${command}${separator}exe`
 *
 * 不是字面量 `".com"`。所以必须把两个函数一起看：主函数决定搜索顺序，
 * 辅助函数决定候选名。
 *
 * （这个错误本身正好演示了「提取失败必须报错」的价值：
 *   如果当初静默跳过，就会得到一个「契约没变」的假结论。）
 */
function extractExecutableResolution(source) {
  const namesFn = source.match(/function windowsExecutableNames\([^)]*\)\s*\{([\s\S]*?)\n\}/);
  if (!namesFn) throw new Error('未能定位 windowsExecutableNames 函数体（候选扩展名的真正来源）');

  const resolveFn = source.match(/function resolveWindowsExecutable\([^)]*\)\s*\{([\s\S]*?)\n\}/);
  if (!resolveFn) throw new Error('未能定位 resolveWindowsExecutable 函数体');

  // 扩展名是 `${command}${separator}com` 形式 → 取最后那个裸词
  const fromTemplates = [...namesFn[1].matchAll(/\}\s*([a-z]{2,5})`/g)].map((x) => x[1]);
  // 也兼容直接写字面量的实现
  const fromLiterals = [...namesFn[1].matchAll(/["']\.([a-z]{2,5})["']/gi)].map((x) => x[1].toLowerCase());
  const extensions = [...new Set([...fromTemplates, ...fromLiterals])];

  if (!extensions.length) {
    throw new Error(
      'windowsExecutableNames 里没有提取到任何候选扩展名。\n'
      + '实现可能被重写了 —— 这本身就是需要人工核对的信号。',
    );
  }

  // 搜索顺序：主函数里 roots 的构造方式决定先查什么
  const body = resolveFn[1];
  const searchOrder = [];
  if (/NODEFAULTCURRENTDIRECTORYINEXEPATH/.test(body)) searchOrder.push('cwd-unless-disabled');
  if (/windowsPathDirectories/.test(body)) searchOrder.push('PATH');
  if (/hasPath/.test(body)) searchOrder.unshift('explicit-directory');

  if (!searchOrder.length) {
    throw new Error('未能从 resolveWindowsExecutable 提取搜索顺序');
  }

  return {
    // .com 在 .exe 之前 —— 顺序有语义，不能排序
    candidateExtensions: extensions,
    searchOrder,
    respectsNoDefaultCurrentDir: /NODEFAULTCURRENTDIRECTORYINEXEPATH/.test(body),
  };
}

/**
 * 契约 4：`runnerStdio` 的 fd 布局。
 *
 * 数组字面量的前若干项就是 fd 0..N 的分配。这是 AOT runner 最核心的契约 ——
 * 它决定了 AOT 在 fd 3/4/5/6/7 上各自期望什么。
 */
function extractRunnerStdioLayout(source) {
  const fn = source.match(/function runnerStdio\([^)]*\)\s*\{([\s\S]*?)\n\}/);
  if (!fn) throw new Error('未能定位 runnerStdio 函数体');

  const body = fn[1];
  // runner 数组：fd 0..3 是固定四项，后面按条件补
  const runnerArr = body.match(/const runner = \[([\s\S]*?)\];/);
  if (!runnerArr) throw new Error('未能提取 runnerStdio 里的 runner 数组');

  const literals = [...runnerArr[1].matchAll(/["']([a-z]+)["']/g)].map((x) => x[1]);
  if (literals.length < 4) {
    throw new Error(`runnerStdio 的 runner 数组只有 ${literals.length} 个固定项，少于预期的 4 个`);
  }

  // fd 7 的 control 通道：找 overlapped
  const hasOverlapped = /overlapped/.test(body);
  // control fd 常量
  const ctlMatch = body.match(/SUBPROCESS_CONTROL_FD/);

  return {
    fixed: literals,
    hasOverlappedControl: hasOverlapped,
    referencesControlFdConstant: Boolean(ctlMatch),
  };
}

/** 收集四项契约。任何一项失败都抛 —— 不返回部分结果。 */
function extractContracts() {
  const pkgDir = resolvePackageDir();
  if (!pkgDir) {
    throw new Error(
      '找不到已安装的 @deepseek-ai/dsh-subprocess-local。\n'
      + '这是契约指纹的来源，缺失时无法核对。请确认 DSH 已安装。',
    );
  }
  const libDir = path.join(pkgDir, 'lib');
  const launchFile = findRunnerLaunchFile(libDir);
  const launchSrc = readOrThrow(launchFile, 'runner-launch 源码');
  const runnerSrc = readOrThrow(path.join(libDir, 'runner.js'), 'runner.js 源码');

  const version = (() => {
    try {
      return JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8')).version ?? 'unknown';
    } catch {
      return 'unknown';
    }
  })();

  return {
    dshVersion: version,
    contracts: {
      startRequestFields: extractStartRequestFields(launchSrc),
      spawnErrorCodes: extractSpawnErrorCodes(runnerSrc),
      executableResolution: extractExecutableResolution(launchSrc),
      runnerStdioLayout: extractRunnerStdioLayout(launchSrc),
    },
  };
}

/**
 * 稳定指纹：键排序后序列化再哈希。
 *
 * 排序是为了让「源码里字段顺序变了」不算漂移 —— 顺序不影响语义，
 * 只比语义。这样报警的都是真正需要人看的变化。
 */
function fingerprintOf(contracts) {
  const canonical = JSON.stringify(contracts, (k, v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return Object.keys(v).sort().reduce((acc, key) => { acc[key] = v[key]; return acc; }, {});
    }
    return v;
  });
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

/** 逐项比较，返回人类可读的差异列表。 */
function diffContracts(before, after) {
  const diffs = [];
  const keys = Object.keys(after);

  for (const key of keys) {
    const a = before?.[key];
    const b = after[key];
    if (a === undefined) {
      diffs.push({ item: key, before: '(基线中不存在)', after: JSON.stringify(b) });
      continue;
    }
    const sa = JSON.stringify(a);
    const sb = JSON.stringify(b);
    if (sa !== sb) {
      diffs.push({ item: key, before: sa, after: sb });
    }
  }

  // 基线有、现在没有的项也算漂移（契约项消失是重大变化）
  for (const key of Object.keys(before || {})) {
    if (!(key in after)) diffs.push({ item: key, before: JSON.stringify(before[key]), after: '(已消失)' });
  }
  return diffs;
}

function main() {
  let current;
  try {
    current = extractContracts();
  } catch (e) {
    // 提取失败 ≠ 契约没变。必须报错，不能当成通过。
    console.error(`❌ 契约提取失败: ${e.message}`);
    console.error('\n提取失败与「契约没变」是两件不同的事。');
    console.error('这里选择报错而不是跳过 —— 静默跳过会让漂移检测形同虚设。');
    return 1;
  }

  const currentFp = fingerprintOf(current.contracts);

  if (UPDATE) {
    const record = {
      dshVersion: current.dshVersion,
      capturedAt: new Date().toISOString(),
      fingerprint: currentFp,
      contracts: current.contracts,
    };
    fs.writeFileSync(FINGERPRINT_FILE, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    console.log(`已保存契约指纹: ${path.relative(REPO, FINGERPRINT_FILE)}`);
    console.log(`  DSH 版本: ${current.dshVersion}`);
    console.log(`  指纹: ${currentFp.slice(0, 16)}…`);
    return 0;
  }

  if (!fs.existsSync(FINGERPRINT_FILE)) {
    console.error(`❌ 没有基线指纹: ${path.relative(REPO, FINGERPRINT_FILE)}`);
    console.error('先运行: node scripts/contract-fingerprint.mjs --update');
    return 1;
  }

  const baseline = JSON.parse(fs.readFileSync(FINGERPRINT_FILE, 'utf8'));
  const diffs = diffContracts(baseline.contracts, current.contracts);

  const report = {
    verdict: diffs.length ? 'DRIFT' : 'STABLE',
    baselineDshVersion: baseline.dshVersion,
    currentDshVersion: current.dshVersion,
    baselineFingerprint: baseline.fingerprint,
    currentFingerprint: currentFp,
    diffs,
  };

  if (AS_JSON) {
    console.log(JSON.stringify(report, null, 2));
    return diffs.length ? 1 : 0;
  }

  if (!diffs.length) {
    console.log(`✅ 契约未漂移（DSH ${current.dshVersion}，基线抓取于 ${baseline.capturedAt?.slice(0, 10) ?? '未知'}）`);
    return 0;
  }

  console.log(`⚠️  契约漂移：DSH ${baseline.dshVersion} → ${current.dshVersion}`);
  console.log('');
  for (const d of diffs) {
    console.log(`  项: ${d.item}`);
    console.log(`    之前: ${d.before}`);
    console.log(`    现在: ${d.after}`);
  }
  console.log('');
  console.log('下一步：');
  console.log('  1. 人工确认这些变化是否影响本项目的兼容层');
  console.log('  2. 补充对应的 A/B 用例（现有 28 项可能覆盖不到新分支）');
  console.log('  3. 确认无误后执行 --update 更新基线，并在 ROADMAP 兼容矩阵里记一笔');
  return 1;
}

process.exit(main());

// 契约覆盖率门禁（--check / --update）的失败分支测试。
//
// ## 为什么这个文件必须存在
//
// 上游的 test/contract-coverage-selftest.mjs 有两处结构缺陷，不能照抄：
//   1. 它把「跳过」当「通过」：环境里能拿到契约包时，失败分支打印
//      「无法构造失败场景，跳过」然后 pass++。也就是说**在开发机上，
//      失败分支从来没被执行过**，测试却显示全绿。
//   2. 它自己写 check() 累加，不是 node --test 用例，于是既不被
//      npm test 收集，也没有任何 npm script 引用它。
//
// 这里反过来做：
//   · 用 node --test，失败就是失败，没有「跳过」这个出口。
//   · 跑的是**真的脚本子进程**（不是 import 进来调函数），退出码是真实退出码。
//   · 采集、契约源、基线全部用环境变量指到临时目录，使得
//     「找不到契约源」「基线过期」这些场景**一定能构造出来**。
//
// ## 覆盖的判定分支对照 lib/contract-coverage-gate.mjs
//
//   0 PASS / 1 REGRESSED / 3 UNMEASURED / 4 BASELINE_STALE
//   外加：比率容差的**双向**边界、分母塌缩、重采中位数。

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { pathToFileURL } = require('node:url');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const SCRIPT = path.join(REPO, 'scripts', 'contract-branch-coverage.mjs');

/**
 * 在临时目录里搭一套「假契约源 + 假基线」，然后跑真实脚本。
 *
 * 关键点：CONTRACT_COVERAGE_LIB 指向一个**我们自己造的 lib 目录**，
 * 里面放一个假 runner-launch-<hash>.js。这样脚本不会去碰真实的 DSH 包，
 * 契约版本、内容、覆盖数字全部可我们说了算。
 *
 * 覆盖数据取自 CONTRACT_COVERAGE_PRECOMPUTED：脚本看到它就跳过真实采集，
 * 直接合并这份预置数据。这一条缝是必要的 —— 否则这个测试每次要跑
 * 5 条用例 × N 次重采 × 17 秒，慢到没人会跑，等于没有。
 */
function runScenario({ baseline, precomputed, contractName = 'runner-launch-TEST123.js', contractBody = 'function a(x){return x?1:2}\n', extraEnv = {}, argv = ['--check'] } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'cov-gate-'));
  const lib = path.join(root, 'node_modules', '@deepseek-ai', 'dsh-subprocess-local', 'lib');
  mkdirSync(lib, { recursive: true });
  writeFileSync(path.join(lib, contractName), contractBody);
  writeFileSync(
    path.join(lib, '..', 'package.json'),
    JSON.stringify({ name: '@deepseek-ai/dsh-subprocess-local', version: '0.2.0-rc.2' }),
  );

  const baselinePath = path.join(root, 'baseline.json');
  if (baseline !== undefined && baseline !== null) {
    writeFileSync(baselinePath, JSON.stringify(baseline, null, 2));
  }

  const covDataPath = path.join(root, 'precomputed.json');
  if (precomputed) writeFileSync(covDataPath, JSON.stringify(precomputed));

  const r = spawnSync(process.execPath, [SCRIPT, ...argv], {
    cwd: REPO,
    encoding: 'utf8',
    env: {
      ...process.env,
      CONTRACT_COVERAGE_LIB: lib,
      CONTRACT_COVERAGE_BASELINE: baselinePath,
      CONTRACT_COVERAGE_PRECOMPUTED: precomputed ? covDataPath : '',
      CONTRACT_COVERAGE_RESAMPLES: '3',
      ...extraEnv,
    },
    timeout: 120_000,
  });

  rmSync(root, { recursive: true, force: true });
  return { code: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') };
}

/** 造一份「覆盖率不错」的基线。 */
function baselineOf({ staticTotal = 293, fnCovered = 20, fnTotal = 114, covered = 2710, total = 10000 } = {}) {
  return {
    dshVersion: '0.2.0-rc.2',
    contractFile: 'runner-launch-TEST123.js',
    contractSha256: null, // 由脚本自己算；测试里不强制比对时置空
    capturedAt: '2026-11-25T00:00:00.000Z',
    static: staticTotal,
    functions: { covered: fnCovered, total: fnTotal },
    ranges: { covered, total, ratioPp: Math.round((covered / total) * 10000) },
    uncoveredFunctions: [],
  };
}

// ---- 3 UNMEASURED ----

test('找不到契约源 → exit 3，且措辞是「未测得」不是「覆盖率下降」', () => {
  const r = runScenario({ baseline: baselineOf(), extraEnv: { CONTRACT_COVERAGE_LIB: path.join(tmpdir(), 'definitely-not-here') } });
  assert.equal(r.code, 3, `期望 exit 3，实际 ${r.code}\n${r.out}`);
  assert.match(r.out, /未测得/);
  // 关键断言：不能把人往「补测试」的方向带。
  assert.ok(!/覆盖率下降|回退/.test(r.out.replace(/这不是「覆盖率下降」/g, '')), '未测得时不应出现「回退/覆盖率下降」的结论');
});

test('采集驱动非零退出（collectOk=false）→ exit 3（此前是 exit 0）', () => {
  // 这是本次要修的核心缺陷：老版本把「采集崩了」也当成功退出。
  const r = runScenario({
    baseline: baselineOf(),
    precomputed: { collectOk: false, static: 293, functions: { covered: 20, total: 114 }, ranges: { covered: 40, total: 159 } },
  });
  assert.equal(r.code, 3, `期望 exit 3，实际 ${r.code}\n${r.out}`);
});

// ---- 4 BASELINE_STALE ----

test('基线文件不存在 → exit 4，并提示跑 --update', () => {
  const r = runScenario({
    baseline: null,
    precomputed: { collectOk: true, static: 293, functions: { covered: 20, total: 114 }, ranges: { covered: 43, total: 159 } },
  });
  assert.equal(r.code, 4, `期望 exit 4，实际 ${r.code}\n${r.out}`);
  assert.match(r.out, /--update/);
});

test('契约内容变了（sha256 不匹配）→ exit 4，不算回退', () => {
  const baseline = baselineOf();
  baseline.contractSha256 = 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';
  const r = runScenario({
    baseline,
    precomputed: { collectOk: true, static: 293, functions: { covered: 20, total: 114 }, ranges: { covered: 43, total: 159 } },
  });
  assert.equal(r.code, 4, `期望 exit 4，实际 ${r.code}\n${r.out}`);
  assert.match(r.out, /内容变了|sha256/);
});

test('DSH 版本变了 → exit 4', () => {
  const baseline = baselineOf();
  baseline.dshVersion = '0.1.0-old';
  const r = runScenario({
    baseline,
    precomputed: { collectOk: true, static: 293, functions: { covered: 20, total: 114 }, ranges: { covered: 43, total: 159 } },
  });
  assert.equal(r.code, 4, `期望 exit 4，实际 ${r.code}\n${r.out}`);
  assert.match(r.out, /DSH 版本变了/);
});

test('基线里的标定记录与当前常量不一致 → exit 4（改了容差却没重采）', () => {
  // 专家评审建议：calibrationProblems() 只看常量自身自洽，
  // 看不见基线里那份旧记录。改了常量却没 --update 时，
  // 常量自洽、基线也自洽，但两者描述的不是同一件事。
  const baseline = baselineOf({ covered: 42, total: 156 });
  baseline.calibration = {
    ratioTolerancePp100: 150, // 当前常量是 200
    totalTolerance: 3,
    observedJitterSpanPp100: 129,
  };
  const r = runScenario({
    baseline,
    precomputed: {
      collectOk: true,
      static: 293,
      functions: { covered: 20, total: 114 },
      ranges: { covered: 42, total: 156 },
    },
  });
  assert.equal(r.code, 4, `期望 exit 4（基线过期），实际 ${r.code}
${r.out}`);
  assert.match(r.out, /容差/, '必须点明是容差脱节，不能笼统说「契约变了」');
});

// ---- 0 PASS ----

test('基线一致 → exit 0', () => {
  const baseline = baselineOf({ covered: 2700, total: 10000 });
  const r = runScenario({
    baseline,
    precomputed: { collectOk: true, static: 293, functions: { covered: 20, total: 114 }, ranges: { covered: 2700, total: 10000 } },
  });
  assert.equal(r.code, 0, `期望 exit 0，实际 ${r.code}\n${r.out}`);
});

// ---- 1 REGRESSED ----

test('静态分支数下降 → exit 1', () => {
  const r = runScenario({
    baseline: baselineOf({ staticTotal: 300 }),
    precomputed: { collectOk: true, static: 290, functions: { covered: 20, total: 114 }, ranges: { covered: 2700, total: 10000 } },
  });
  assert.equal(r.code, 1, `期望 exit 1，实际 ${r.code}\n${r.out}`);
  assert.match(r.out, /静态分支数下降/);
});

test('已覆盖函数数下降 → exit 1', () => {
  const r = runScenario({
    baseline: baselineOf({ fnCovered: 25 }),
    precomputed: { collectOk: true, static: 293, functions: { covered: 20, total: 114 }, ranges: { covered: 2700, total: 10000 } },
  });
  assert.equal(r.code, 1, `期望 exit 1，实际 ${r.code}\n${r.out}`);
  assert.match(r.out, /已覆盖函数数下降/);
});

// ---- 比率容差的**双向**边界 ----
//
// 评审明确指出：容差是门禁唯一能静默腐烂的地方，只测「大幅下降」不够，
// 必须测「刚好在容差内」与「刚好超出容差」两侧。

test('比率下降刚好在 2.00pp 容差内 → exit 0', () => {
  // 基线 28.00%，当前 26.00%：差 2.00pp，正好等于容差边界，**不应**判回退。
  const r = runScenario({
    baseline: baselineOf({ covered: 2800, total: 10000 }),
    precomputed: { collectOk: true, static: 293, functions: { covered: 20, total: 114 }, ranges: { covered: 2600, total: 10000 } },
  });
  assert.equal(r.code, 0, `边界内应通过，实际 ${r.code}\n${r.out}`);
});

test('比率下降超出 2.00pp 容差 → exit 1', () => {
  // 基线 28.00%，当前 25.99%：差 2.01pp，刚过边界，**必须**判回退。
  const r = runScenario({
    baseline: baselineOf({ covered: 2800, total: 10000 }),
    precomputed: { collectOk: true, static: 293, functions: { covered: 20, total: 114 }, ranges: { covered: 2599, total: 10000 } },
  });
  assert.equal(r.code, 1, `超出边界应回退，实际 ${r.code}\n${r.out}`);
  assert.match(r.out, /分支区间覆盖率下降/);
});

test('分母塌缩（区间总数降超 3）→ exit 1，即使比率看起来更高', () => {
  // 13/40 = 32.5% 比基线 28.00% "高"，但分母从 10000 掉到 40 —— 这是伪造。
  const r = runScenario({
    baseline: baselineOf({ covered: 2800, total: 10000 }),
    precomputed: { collectOk: true, static: 293, functions: { covered: 20, total: 114 }, ranges: { covered: 13, total: 40 } },
  });
  assert.equal(r.code, 1, `分母塌缩应回退，实际 ${r.code}\n${r.out}`);
  assert.match(r.out, /塌缩/);
});

// ---- 接入路径 ----

test('package.json 已把 --check 与 --update 接进 scripts，且 --check 在 test:all 里', () => {
  const pkg = JSON.parse(readFileSync(path.join(REPO, 'package.json'), 'utf8'));
  const scripts = pkg.scripts ?? {};
  assert.match(scripts['contract:coverage'] ?? '', /--check/, 'contract:coverage 必须跑 --check');
  assert.match(scripts['contract:coverage:update'] ?? '', /--update/, 'contract:coverage:update 必须跑 --update');
  assert.ok(
    (scripts['test:all'] ?? '').includes('contract:coverage'),
    '门禁没接进 test:all 就等于没有',
  );
});

test('self-test 自己也在 test:all 里 —— 否则失败分支依旧没人跑', () => {
  const pkg = JSON.parse(readFileSync(path.join(REPO, 'package.json'), 'utf8'));
  assert.ok(
    (pkg.scripts?.['test:all'] ?? '').includes('test:contract-coverage'),
    'test:contract-coverage 必须在 test:all 里；不接进去就是重犯 selftest 的老毛病',
  );
});

// ---- 容差标定自洽（专家评审 A 的第 2 条阻塞项）----
//
// 容差是这套门禁里唯一会**静默过期**的东西：`contractSha256` 只保证
// 「契约变了就重采基线」，但重采时如果只是抄了新的覆盖率数字，
// 两个容差会原封不动留在常量里 —— 它们描述的却已是另一份契约的抖动特性。
// 所以基线里记下标定输入，并在这里守住「改了容差就得改记录」。

test('容差标定自洽：容差 = 实测极差 + 余量，且余量不小于极差的 50%', () => {
  const lib = path.join(REPO, 'scripts', 'lib', 'contract-coverage-gate.mjs');
  const r = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      [
        `const m = await import(${JSON.stringify(pathToFileURL(lib).href)});`,
        'const p = m.calibrationProblems();',
        'console.log(JSON.stringify({ problems: p, tol: m.RANGE_RATIO_TOLERANCE_PP100, c: m.CALIBRATION, tot: m.RANGE_TOTAL_TOLERANCE }));',
      ].join('\n'),
    ],
    { encoding: 'utf8' },
  );
  assert.ok(r.status === 0, `标定自检脚本跑不起来：${r.stderr}`);
  const v = JSON.parse(r.stdout.trim().split('\n').pop());
  assert.deepEqual(v.problems, [], `容差标定不自洽：${v.problems.join('; ')}`);
  assert.equal(
    v.c.observedJitterSpanPp100 + v.c.marginPp100,
    v.tol,
    '容差必须等于「实测极差 + 余量」，否则 CALIBRATION 记录与实际不符',
  );
  assert.ok(
    v.c.observedTotalSpan <= v.tot,
    `分母下限(${v.tot}) 必须不小于实测 total 极差(${v.c.observedTotalSpan})，否则正常抖动会被判塌缩`,
  );
});

test('基线记录标定输入 —— 否则半年后没人知道 2.00pp 是怎么来的', () => {
  const baseline = JSON.parse(readFileSync(path.join(REPO, '.contract-coverage.json'), 'utf8'));
  assert.ok(baseline.calibration, '基线必须带 calibration 段');
  assert.ok(
    Number.isFinite(baseline.calibration.contractStatic),
    '必须记下「容差是对着哪个契约规模标定的」',
  );
  assert.ok(Number.isFinite(baseline.calibration.ratioTolerancePp100));
  assert.ok(Number.isFinite(baseline.calibration.totalTolerance));
  assert.ok(Number.isFinite(baseline.calibration.samples) && baseline.calibration.samples > 1,
    '容差必须来自多次采样，单次采样的「极差」没有意义');
});

test('release.yml 上契约覆盖率是**阻塞**门禁（tag 构建例外）', () => {
  const text = readFileSync(path.join(REPO, '.github', 'workflows', 'release.yml'), 'utf8');
  // 这是设计文档 §风险表那一条的落地：CI 上可以 warning，tag 构建必须阻塞。
  // 少了它，门禁在最需要它的地方（发布）永不执行。
  assert.match(text, /契约覆盖率棘轮/, 'release.yml 必须有契约覆盖率步骤');
  const step = text.slice(text.indexOf('契约覆盖率棘轮'));
  assert.match(step.slice(0, 4000), /exit 1/, 'tag 构建上覆盖率异常必须令 job 失败');
  assert.match(step.slice(0, 4000), /^\s*3\)/m, '必须显式处理 exit 3（未测得）');
});

test('release.yml 的覆盖率步骤在 DSH 包安装之后 —— 否则必然 exit 3', () => {
  const text = readFileSync(path.join(REPO, '.github', 'workflows', 'release.yml'), 'utf8');
  const installIdx = text.indexOf('安装 DSH subprocess-local');
  const gateIdx = text.indexOf('契约覆盖率棘轮');
  assert.ok(installIdx > 0 && gateIdx > 0, '两步都必须存在');
  assert.ok(
    gateIdx > installIdx,
    '覆盖率步骤必须排在「安装 DSH subprocess-local」之后：' +
      '装包之前跑必然拿不到契约源 → exit 3 → 发布被拦，那是假拦截',
  );
});

test('覆盖率步骤在 A/B 回归**之前** —— 它是发布前最后一道闸，要尽早失败', () => {
  // 专家评审建议补的：只锁「在装包之后」不够。挪到 A/B 之后仍能跑，
  // 但白白浪费一次 45 分钟的构建才发现覆盖率回退。
  const text = readFileSync(path.join(REPO, '.github', 'workflows', 'release.yml'), 'utf8');
  const gateIdx = text.indexOf('契约覆盖率棘轮');
  const abIdx = text.indexOf('A/B 一致性 + IPC 回归');
  assert.ok(gateIdx > 0 && abIdx > 0, '两步都必须存在');
  assert.ok(gateIdx < abIdx, '覆盖率门禁应排在 A/B 回归之前（快速失败）');
});

test('覆盖率步骤没有 continue-on-error —— 那会让阻塞门禁形同虚设', () => {
  // 专家评审建议：结构断言能被 `continue-on-error: true` 轻易绕过。
  // 一行属性就把「阻塞」变成「装饰」，而且 review 时极容易漏看。
  const lines = readFileSync(path.join(REPO, '.github', 'workflows', 'release.yml'), 'utf8').split(/\r?\n/);
  const start = lines.findIndex((l) => l.includes('契约覆盖率棘轮'));
  assert.ok(start > 0, '找不到覆盖率步骤');
  // 取该步骤到下一个顶层 `- name:` 之间的所有行
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s{6}- name:/.test(lines[i])) {
      end = i;
      break;
    }
  }
  const block = lines.slice(start, end).join('\n');
  assert.ok(
    !/continue-on-error:\s*true/.test(block),
    '覆盖率门禁步骤不得设 continue-on-error: true —— 那等于把阻塞改回警告，且不写在注释里',
  );
});

test('npm 发布校验步骤也没有 continue-on-error', () => {
  const lines = readFileSync(path.join(REPO, '.github', 'workflows', 'release.yml'), 'utf8').split(/\r?\n/);
  const start = lines.findIndex((l) => l.includes('校验 npm 发布结果'));
  assert.ok(start > 0, '找不到发布校验步骤');
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s{6}- name:/.test(lines[i])) {
      end = i;
      break;
    }
  }
  assert.ok(
    !/continue-on-error:\s*true/.test(lines.slice(start, end).join('\n')),
    '发布校验是 fail-closed 的最后一环，不得 continue-on-error',
  );
});

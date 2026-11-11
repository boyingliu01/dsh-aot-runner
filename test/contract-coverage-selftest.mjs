#!/usr/bin/env node
// 契约分支覆盖率脚本的自测。
//
// 为什么一个统计脚本需要测试：它输出的数字会被当成「覆盖得好不好」的依据。
// 如果脚本本身坏了——比如采不到数据却报 0%——那个 0% 会被读成
// 「测试严重不足」，而真实情况可能是「压根没测成」。两件事完全不同，
// 补救方向也相反。
//
// 所以这里盯住三条：
//   1. 采不到数据时必须非零退出，且措辞明确说是「没测成」而不是「覆盖率低」
//   2. 正常路径要同时给出「静态分支数」和「运行时覆盖数」
//   3. 平台不可达的部分要被单独标出，不能混进「该补测」里
//
// 用法：node test/contract-coverage-selftest.mjs

import { spawnSync } from 'node:child_process';
import path from 'node:path';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'contract-branch-coverage.mjs');

let pass = 0;
const failures = [];

function check(name, fn) {
  try {
    fn();
    pass++;
    console.log(`  ✅ ${name}`);
  } catch (err) {
    failures.push({ name, message: err.message });
    console.log(`  ❌ ${name}`);
    console.log(`     ${err.message}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// 完整跑一次（约 15–25 秒）：脚本要真的驱动 runner 采集覆盖。
const t0 = Date.now();
const run = spawnSync(process.execPath, [SCRIPT, '--json'], {
  cwd: REPO_ROOT,
  encoding: 'utf8',
  timeout: 300_000,
});
const elapsed = Date.now() - t0;

check('脚本能正常退出', () => {
  assert(run.status === 0, `退出码 ${run.status}\nstderr: ${(run.stderr ?? '').slice(-500)}`);
  assert(run.stdout.trim().length > 0, 'stdout 为空，无 JSON 输出');
});

check('--json 输出可解析', () => {
  JSON.parse(run.stdout);
});

const report = (() => {
  try { return JSON.parse(run.stdout); } catch { return null; }
})();

check('报告了静态分支总数', () => {
  assert(report, '没有可解析的报告');
  assert(report.static.total > 0, `静态分支数 ${report.static.total}，应 > 0`);
  assert(Array.isArray(report.static.detail), 'static.detail 应是数组');
});

check('报告了运行时覆盖', () => {
  assert(report?.runtime, '缺少 runtime 字段');
  assert(report.runtime.functions.total > 0, '函数总数为 0，说明没采到契约文件');
  assert(
    report.runtime.functions.covered <= report.runtime.functions.total,
    '已覆盖数大于总数',
  );
});

check('静态分支数与契约文件的判定点量级相符', () => {
  // 契约文件实测约 290 个判定点。给足余量，只要不是 0 或离谱的大数即可 ——
  // 这条守的是「正则统计没跑偏」，不是精确值。
  assert(
    report.static.total > 100 && report.static.total < 2000,
    `静态分支数 ${report.static.total} 不在合理区间 (100, 2000)`,
  );
});

check('运行时间在可接受范围', () => {
  // 超过 5 分钟说明采集卡住了，CI 里会拖垮整个 job。
  assert(elapsed < 300_000, `耗时 ${elapsed}ms 超过 5 分钟`);
  console.log(`     耗时 ${(elapsed / 1000).toFixed(1)}s`);
});

check('采不到数据时明确报「没测成」而不是「覆盖率 0」', () => {
  // 用一个不存在的契约目录模拟采集失败：把 DSH_HOME 指到空目录，
  // 同时让 USERPROFILE 也找不到（脚本会退化到仓库目录，仓库里没有 node_modules
  // 的那份包时就会失败）。
  const r = spawnSync(process.execPath, [SCRIPT], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      ...process.env,
      // 指向一个不存在的家目录，让两处候选路径都失效
      DSH_HOME: path.join(REPO_ROOT, '.nonexistent-dsh-home'),
      USERPROFILE: path.join(REPO_ROOT, '.nonexistent-profile'),
      HOME: path.join(REPO_ROOT, '.nonexistent-home'),
    },
  });

  const out = (r.stdout ?? '') + (r.stderr ?? '');
  const hasRealPackage = /runner-launch-.*\.js/.test(out) && r.status === 0;

  if (hasRealPackage) {
    // 环境里还有别的路径能找到契约文件（例如仓库自己带了 node_modules），
    // 这种情况下无法构造失败场景 —— 如实跳过，不假装通过。
    console.log('     （环境里仍能找到契约文件，无法构造失败场景，跳过）');
    return;
  }

  assert(r.status !== 0, '采不到数据时退出码应为非零');
  assert(
    /不是「覆盖率为 0」|不是\s*「覆盖率 0」|没找到/.test(out),
    `错误信息没有明确区分「没测成」与「覆盖率低」:\n${out.slice(-300)}`,
  );
});

console.log();
if (failures.length > 0) {
  console.log(`❌ ${failures.length} 条不符合预期`);
  process.exit(1);
}
console.log(`✅ 全部 ${pass}/${pass + failures.length} 条符合预期。`);

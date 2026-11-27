import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const REPO = path.resolve(import.meta.dirname, '..');
const SCRIPT = path.join(REPO, 'scripts', 'coverage-summary.py');

// 这组测试锁住 coverage-summary.py 的两个**静默失效模式**。
// 它们共同的特征是：数字照样打印、格式照样正确、结论却已经错了 ——
// 人工看输出发现不了，只有把缺陷重新注入才知道门禁是否还活着。
//
// 背景（两个都是真实发生过的）：
//   1. 同一类名在 cobertura 里出现多次（编译器状态机），字典按类名作键 → 覆盖
//      → 生产源码行数被低估成 890（真实 1109），而覆盖率仍显示 100%。
//   2. 门槛只判行覆盖 → coverlet 升大版本改变分支分母时（95.88% → 94.87%）
//      完全看不见变化。

function makeCobertura(classes) {
  // classes: [{ filename, name, lines: [{number, hits, cond?}] }]
  const cls = classes
    .map((c) => {
      const lineXml = c.lines
        .map((l) => {
          const attrs =
            l.cond === undefined
              ? ''
              : ` branch="True" condition-coverage="${l.cond}"`;
          return `<line number="${l.number}" hits="${l.hits}"${attrs}/>`;
        })
        .join('');
      return (
        `<class name="${c.name}" filename="${c.filename}">` +
        `<lines>${lineXml}</lines></class>`
      );
    })
    .join('');
  // 根节点属性只是给 is_empty_report 用的，不影响本脚本的统计
  return (
    '<?xml version="1.0" encoding="utf-8"?>' +
    `<coverage line-rate="1" branch-rate="1" lines-valid="1" lines-covered="1">` +
    `<packages><package><classes>${cls}</classes></package></packages>` +
    '</coverage>'
  );
}

function runSummary(xmlContent) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'covsum-'));
  try {
    // 脚本在仓库根下 glob("tests/**/coverage.cobertura.xml")，所以在临时目录
    // 里造出同样的结构，再把脚本复制进去跑 —— 这样不碰真实测试产物。
    const testsDir = path.join(dir, 'tests', 'proj', 'TestResults', 'r1');
    fs.mkdirSync(testsDir, { recursive: true });
    fs.writeFileSync(path.join(testsDir, 'coverage.cobertura.xml'), xmlContent);
    fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
    fs.copyFileSync(SCRIPT, path.join(dir, 'scripts', 'coverage-summary.py'));
    let out;
    try {
      out = execFileSync('python', ['scripts/coverage-summary.py'], {
        cwd: dir,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      // 门禁失败时脚本以 1 退出，stdout 仍要拿来做断言
      out = err.stdout ?? '';
    }
    return out;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('同名类出现多次时不互相覆盖 —— 行数必须累加', () => {
  // 一个类名出现 3 次，各 10 行；正确实现应统计 30 行
  const cls = [1, 2, 3].map(() => ({
    filename: 'src/JobRunner.cs',
    name: 'DshAotRunner.JobRunner',
    lines: Array.from({ length: 10 }, (_, i) => ({ number: i + 1, hits: 1 })),
  }));
  const out = runSummary(makeCobertura(cls));
  const m = out.match(/生产源码:\s+[\d.]+%\s+\((\d+)\/(\d+) 行\)/);
  assert.ok(m, `输出里应有生产源码行数，实际输出：\n${out}`);
  assert.equal(
    m[2],
    '30',
    '三个同名 class 合计 30 行。若报 10 行，说明又退回「按类名作键、后覆盖前」的旧缺陷 —— ' +
      '它会静默低估行数，而覆盖率仍显示 100%，门禁完全察觉不到',
  );
  assert.equal(m[1], '30', '全部命中时命中数也应等于总行数');
});

test('分支覆盖单独判定 —— 行 100% 但分支不达标时必须 FAIL', () => {
  // 行全部命中（100%），但分支只有 1/2 覆盖 → 分支覆盖 50%，应低于门槛
  const cls = [
    {
      filename: 'src/Foo.cs',
      name: 'DshAotRunner.Foo',
      lines: [
        { number: 1, hits: 5 },
        { number: 2, hits: 5, cond: '50% (1/2)' },
      ],
    },
  ];
  const out = runSummary(makeCobertura(cls));
  assert.match(out, /行覆盖\s+实际 100\.00%/u, `行覆盖应为 100%，实际输出：\n${out}`);
  assert.match(
    out,
    /分支覆盖\s+实际 50\.00%.*FAIL/u,
    '分支覆盖必须被单独判定并 FAIL。只判行覆盖时，coverlet 升大版本改变分支分母' +
      '（95.88% → 94.87%）这种情况会被完全放过',
  );
});

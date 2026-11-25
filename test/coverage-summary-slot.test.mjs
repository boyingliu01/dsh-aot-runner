import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const REPO = path.resolve(import.meta.dirname, '..');
const read = (p) => fs.readFileSync(path.join(REPO, p), 'utf8');

// `coverage/coverage-summary.json` 的定位是一个真实的规则冲突：
//   · Gate 5（xp-gate pre-commit）要它**在版本库里**，否则直接 BLOCKED；
//   · CI 的「检查是否误提交构建产物」曾把 coverage/ 整目录判红。
// 这组测试锁住「两边同时满足」这个状态。删掉任何一边都会让提交或 CI 断掉，
// 而断掉的方式都不会给出「是这条规则变了」的提示 —— 所以用测试替人说。

test('coverage-summary.json 在版本库里 —— Gate 5 需要它', () => {
  const p = path.join(REPO, 'coverage', 'coverage-summary.json');
  assert.ok(fs.existsSync(p), '文件必须存在：Gate 5 找不到它会 BLOCKED，提交被拦死');
  const j = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.ok(Number.isFinite(j.total?.lines?.pct), '必须含 total.lines.pct，Gate 5 读这个字段');
});

test('.gitignore 只忽略 coverage/tmp/，不忽略摘要文件', () => {
  const gi = read('.gitignore');
  assert.match(gi, /^coverage\/tmp\/$/m, '中间产物要忽略');
  assert.doesNotMatch(
    gi,
    /^coverage\/$/m,
    '不能整目录忽略 coverage/ —— 那会让摘要文件进不了版本库，Gate 5 随即 BLOCKED',
  );
});

test('CI 把摘要文件列为允许项，其余 coverage/ 产物仍然拦', () => {
  const ci = read('.github/workflows/ci.yml');
  assert.match(
    ci,
    /grep -vx 'coverage\/coverage-summary\.json'/,
    'CI 必须显式豁免这个文件，否则与 Gate 5 冲突',
  );
  // 豁免必须发生在目录规则之后，否则等于没豁免
  const dirRule = ci.indexOf("grep -E '^(bin|obj|dist|coverage|node_modules)/'");
  const exempt = ci.indexOf("grep -vx 'coverage/coverage-summary.json'");
  assert.ok(dirRule > 0 && exempt > 0, '两条 grep 都必须存在');
  assert.ok(exempt > dirRule, '豁免必须排在目录规则之后才生效');
});

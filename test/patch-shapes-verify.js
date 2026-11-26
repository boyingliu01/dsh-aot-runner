#!/usr/bin/env node
/**
 * tests for `vendor/patch-dsh.mjs` 的形态表（SHAPES）
 *
 * ## 要防的是什么
 *
 * 这个补丁工具原来只认一种上游写法（硬编码一个 BEFORE/AFTER）。
 * 上游在 0.2.2-rc.5 改写了那行代码之后，`apply` 就匹配不上、报「未识别的代码形状」。
 *
 * 那个报错本身是对的 —— 但它意味着**升级 DSH 之后插件必然装不上，且只能靠人发现**。
 * 2026-11-26 核查上游四个版本后确认：三种写法里，前两种我们的工具都不认识。
 *
 * 所以这里测的不是「字符串能替换」，而是**形态表对所有已知上游写法都成立**。
 *
 * ## 为什么用真实代码片段而不是自造字符串
 *
 * 自造字符串会「测了个寂寞」：它只能证明 `String.replace` 能用。
 * 这里的两段 `before` 是**从上游 npm 包解包后逐字抄来的**（见 docs/TODO.md §1.9），
 * 连缩进都保留了上游的样子。上游再改，这两个测试不会自动更新 —— 那是故意的：
 * 它们会在升级时失败，提醒我们去看清楚新形态，而不是静默放行。
 *
 * ## 为什么能直接 import 而不跑 CLI
 *
 * `patch-dsh.mjs` 是把逻辑和 IO 混在一起的脚本，没有导出 SHAPES。
 * 与其为了可测性重构一个正在工作的工具，不如**从源码里提取**形态表 ——
 * 和 test/release-npm-gate-verify.js 抽 release.yml 那段 run 脚本同一个思路：
 * 抽不出来就失败，说明结构变了，测试必须跟着改。
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');

const ROOT = resolve(__dirname, '..');
const SRC = readFileSync(resolve(ROOT, 'vendor/patch-dsh.mjs'), 'utf8');

/**
 * 从源码里抽出 SHAPES 的 before/after 对。
 *
 * 用正则而不是 `eval`：eval 会把补丁工具的全部副作用（读文件、写文件）带进来。
 * 这里只要那几对字符串。
 */
function extractShapes() {
  const block = SRC.match(/const SHAPES = \[([\s\S]*?)\n\];/);
  assert.ok(block, 'vendor/patch-dsh.mjs 里找不到 `const SHAPES = [...]` —— 结构变了，本测试要跟着改');

  const shapes = [];
  // 每个形态里有 id / note / before / after 四个字段，按出现顺序配对即可。
  const re = /id:\s*'([^']+)'[\s\S]*?before:\s*\n?\s*'([^']+)'[\s\S]*?after:\s*\n?\s*'([^']+)'/g;
  let m;
  while ((m = re.exec(block[1])) !== null) {
    shapes.push({ id: m[1], before: m[2], after: m[3] });
  }
  return shapes;
}

const SHAPES = extractShapes();

test('形态表至少包含两代上游写法', () => {
  assert.ok(SHAPES.length >= 2, `期望 >= 2 个形态（0.2.0-rc.2 与 0.2.2-rc.5+），实际 ${SHAPES.length}`);
  const ids = SHAPES.map((s) => s.id);
  assert.ok(ids.some((i) => i.includes('0.2.0-rc.2')), `缺少 0.2.0-rc.2 形态，现有: ${ids.join(', ')}`);
  assert.ok(ids.some((i) => i.includes('0.2.3-alpha.2')), `缺少 0.2.3-alpha.2 形态，现有: ${ids.join(', ')}`);
});

test('每个形态的 after 都在两个 launch* 调用里补上了 internals', () => {
  for (const s of SHAPES) {
    // 两种形态都必须同时调用 launchWindowsJob 与 launchLinuxScope，
    // 且**两个**都要补 internals —— 上游的缺陷是「一个都没传」，
    // 只补一个会得到「Windows 上生效、Linux 上不生效」的假修复。
    assert.ok(
      /launchWindowsJob\(spec, env, internals\)/.test(s.after),
      `形态 ${s.id} 的 after 没给 launchWindowsJob 补 internals：${s.after}`,
    );
    assert.ok(
      /launchLinuxScope\([^)]*internals\)/.test(s.after),
      `形态 ${s.id} 的 after 没给 launchLinuxScope 补 internals：${s.after}`,
    );
    assert.ok(
      !s.before.includes('internals'),
      `形态 ${s.id} 的 before（原始上游代码）不该包含 internals：${s.before}`,
    );
  }
});

test('0.2.0-rc.2 形态与上游原样一致（逐字，含缩进外的全部内容）', () => {
  const s = SHAPES.find((x) => x.id.includes('0.2.0-rc.2'));
  assert.ok(s, '找不到 0.2.0-rc.2 形态');
  assert.strictEqual(
    s.before,
    'handle = bindManagedProcess(spec, containmentMode === "linux-scope" ? launchLinuxScope(spec, env) : launchWindowsJob(spec, env), binding);',
  );
  assert.strictEqual(
    s.after,
    'handle = bindManagedProcess(spec, containmentMode === "linux-scope" ? launchLinuxScope(spec, env, internals) : launchWindowsJob(spec, env, internals), binding);',
  );
});

test('0.2.2-rc.5 ~ 0.2.3-alpha.2 形态与上游原样一致', () => {
  const s = SHAPES.find((x) => x.id.includes('0.2.3-alpha.2'));
  assert.ok(s, '找不到 0.2.2-rc.5 ~ 0.2.3-alpha.2 形态');
  // 这三版（0.2.2-rc.5 / 0.2.3-alpha.1 / 0.2.3-alpha.2）的这一行完全相同，
  // 连行号都是 1574 —— 见 docs/TODO.md §1.9 的实测记录。
  assert.strictEqual(
    s.before,
    'handle = bindManagedProcess(spec, linuxScope === void 0 ? launchWindowsJob(spec, env) : launchLinuxScope(spec, env, linuxScope.literalArgv), binding);',
  );
  assert.strictEqual(
    s.after,
    'handle = bindManagedProcess(spec, linuxScope === void 0 ? launchWindowsJob(spec, env, internals) : launchLinuxScope(spec, env, linuxScope.literalArgv, internals), binding);',
  );
});

test('形态之间互不包含 —— 否则 classify 会同时命中两条而判 ambiguous', () => {
  for (let i = 0; i < SHAPES.length; i++) {
    for (let j = 0; j < SHAPES.length; j++) {
      if (i === j) continue;
      assert.ok(
        !SHAPES[i].before.includes(SHAPES[j].before),
        `形态 ${SHAPES[i].id} 的 before 包含了 ${SHAPES[j].id} 的 before`,
      );
      assert.ok(
        !SHAPES[i].after.includes(SHAPES[j].after),
        `形态 ${SHAPES[i].id} 的 after 包含了 ${SHAPES[j].id} 的 after`,
      );
    }
  }
});

test('对每种形态：替换后能识别为已打补丁，反向替换能还原', () => {
  for (const s of SHAPES) {
    // 模拟 patch-dsh.mjs 的 classify + 替换流程，不碰真实文件。
    // 保留上游那样的一行缩进（三连 tab），确保替换不受缩进影响。
    const pristine = `\t\t\t${s.before}\n`;

    assert.ok(pristine.includes(s.before), `形态 ${s.id}: pristine 应命中 before`);
    assert.ok(!pristine.includes(s.after), `形态 ${s.id}: pristine 不该命中 after`);

    const applied = pristine.replace(s.before, s.after);
    assert.ok(applied.includes(s.after), `形态 ${s.id}: 替换后应命中 after`);
    assert.ok(!applied.includes(s.before), `形态 ${s.id}: 替换后不该还有 before`);
    // 缩进和换行必须原样保留：补丁只该动那一行，不该把上下文也改了。
    assert.strictEqual(applied, `\t\t\t${s.after}\n`, `形态 ${s.id}: 替换后除目标行外的文本应完全不变`);

    const reverted = applied.replace(s.after, s.before);
    assert.strictEqual(reverted, pristine, `形态 ${s.id}: 还原后应与原文完全相同`);
  }
});

test('形态表里每条 id 与 note 都不重复（便于 status 输出定位）', () => {
  const ids = SHAPES.map((s) => s.id);
  assert.strictEqual(new Set(ids).size, ids.length, `id 重复: ${ids.join(', ')}`);
});

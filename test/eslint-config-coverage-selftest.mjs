#!/usr/bin/env node
// ESLint 配置的**覆盖面**自测。
//
// 为什么需要它：ESLint 的 flat config 是按 `files` 模式选择性生效的。
// 一个文件"没有被任何 block 匹配到"时，ESLint **不报错也不警告** ——
// 它会退到兜底 block（只有 ecmaVersion，没有 globals、没有 sourceType），
// 于是那个文件带着一套无关的假设被解析：`console` 报 no-undef，
// `import` 报解析错误。
//
// 这个坑真实发生过（issue #29）：0.2.4 发布前新增了两个 `.mjs` 自测文件，
// 配置块只写了 `test/**/*.js`，于是**已发布的版本通不过自己的 `npm run lint`**。
// 更糟的是它在 `test:all` 链条的第一位，等于项目的全量自查入口整个是坏的。
//
// 单纯"修好这一处"不够 —— 下次换个扩展名（.cjs / .ts）或换个目录
// （tools/ / bench/）还会重演。所以这里把判据反过来：不问"配置对不对"，
// 而问"仓库里的每个 JS 文件，是不是都被某个 block 声明过"。
//
// 用法：node test/eslint-config-coverage-selftest.mjs
// 退出码：0 = 全部符合预期；1 = 有偏差。

import { existsSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');

/**
 * 与 ESLint 解析同一份配置，问它「这个文件最终拿到的是什么规则集」。
 *
 * 为什么不用 `eslint --print-config`：那会为每个文件启动一次进程（几十个文件
 * 就是几十次），而这里只需要 Node API。ESLint 是**全局安装**的，项目目录
 * 解析不到，所以从全局 node_modules 根 require。
 */
async function loadEslint() {
  const candidates = [];
  const globalRoot = process.env.npm_config_prefix
    ? path.join(process.env.npm_config_prefix, 'node_modules')
    : null;
  if (globalRoot) candidates.push(globalRoot);
  // npm 全局前缀的默认位置（Windows / POSIX 各一份）
  if (process.env.APPDATA) {
    candidates.push(path.join(process.env.APPDATA, 'npm', 'node_modules'));
  }
  candidates.push('/usr/local/lib/node_modules', '/usr/lib/node_modules');

  for (const root of candidates) {
    const entry = path.join(root, 'eslint', 'package.json');
    if (!existsSync(entry)) continue;
    const require = createRequire(path.join(root, 'x'));
    const mod = require('eslint');
    return { ESLint: mod.ESLint, root };
  }
  throw new Error(
    `没找到全局安装的 eslint（找过：${candidates.join(', ')}）。\n` +
    '这是运行本自测的前置条件，与 `npm run lint` 的前置条件相同。',
  );
}

/**
 * 收集仓库里所有需要 ESLint 覆盖的 JS 文件（相对路径）。
 *
 * 口径必须与 eslint.config.mjs 的 ignores 一致 —— 但**不复制那份列表**：
 * 这里列出的是"我们认为该被覆盖的"，被 ignores 掉的文件由 ESLint 自己
 * 返回 undefined，于是它们不进分母。两边各自只描述自己的事。
 */
const SKIP_DIRS = new Set([
  'node_modules', 'bin', 'obj', 'dist', 'dist-opt', 'dist-final',
  'coverage', 'vendor', '.git', '.xp-gate', '.sprint-state', '.qoder',
  '.stryker-tmp', 'TestResults',
]);
const JS_EXT = new Set(['.js', '.cjs', '.mjs']);

function collect(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out; // 目录不可读：跳过而不是崩掉
  }
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) collect(abs, out);
    } else if (JS_EXT.has(path.extname(entry.name))) {
      out.push(path.relative(REPO_ROOT, abs).split(path.sep).join('/'));
    }
  }
  return out;
}

let passed = 0;
let failed = 0;

/** 用例体一律 async（都要问 ESLint），失败只记一条而不是中断整轮。 */
async function test(name, fn) {
  try {
    await fn();
    console.log(`  PASS  ${name}`);
    passed++;
  } catch (e) {
    console.log(`  FAIL  ${name}`);
    console.log(`        ${e.message}`);
    failed++;
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

/**
 * ESLint 实际下了什么判定 —— 不看配置的"形状"，看它有没有真的开火。
 *
 * 为什么不直接看 `calculateConfigForFile` 的 languageOptions.globals：
 * 对**没有任何 block 匹配**的文件，它同样返回一份 config（sourceType 按扩展名
 * 猜、globals 是空对象）—— 只看形状分不清「没配 block」和「配了但没写 globals」，
 * 而后者在本项目里是**合法的**（`bench/load-matrix.cjs` 就没有自己的 block，
 * 它靠通用规则被检查，本来也不需要额外全局变量）。
 *
 * 所以改用行为判据：喂一段只含一个**永远不会定义**的标识符的源码，
 *   - 被某个带 BASE_RULES 的 block 匹配 → `no-undef` 必然报它 → 配置生效了
 *   - 落到兜底（只有 ecmaVersion、零规则）→ 一条都不报 → 没被覆盖
 *
 * 顺带用同一段探测解析模式：ESM/CJS 猜错会直接是解析错误（issue #29 的另一半症状）。
 */
const PROBE_SOURCE = 'probe_identifier_that_is_never_defined;\n';

async function probe(relPath) {
  const [result] = await eslint.lintText(PROBE_SOURCE, {
    filePath: path.join(REPO_ROOT, relPath),
  });
  const ruleIds = (result?.messages ?? []).map((m) => m.ruleId ?? 'PARSE_ERROR');
  return {
    rulesApply: ruleIds.includes('no-undef'),
    parses: !ruleIds.includes('PARSE_ERROR'),
  };
}

const { ESLint, root: eslintRoot } = await loadEslint();
// 显式关掉结果缓存 —— 每一轮的配置都必须重新算。
//
// 为什么：ESLint 的 Node API 会跨实例缓存已算好的配置（包括负缓存 —— 某个
// 路径被判定为"未匹配任何 block"后，改完配置再问同一个问题仍返回旧答案）。
// 这个测试的全部意义就是"改配置后能立刻发现覆盖变化"，缓存会把被测对象
// 冻在第一次问的瞬间，让刚修好的问题继续报红、或让刚引入的问题漏过去。
const eslint = new ESLint({ cwd: REPO_ROOT, cache: false, cacheStrategy: 'content' });

console.log('ESLint 配置覆盖面自测\n');
console.log(`  eslint: ${eslintRoot}\n`);

// ---- 用例 1：已发生过的那次回归 ----
//
// 这两条锁住 issue #29 的具体表现，与"全仓扫描"是互补而非重复：
// 全仓扫描依赖当前文件布局，而这里锚定的是「换个路径也必须成立」。
await test('AC-EC-1 仓库测试里的 .mjs 必须被某个 block 覆盖', async () => {
  const p = await probe('test/cast-audit-selftest.mjs');
  assert(p.rulesApply, 'test/**/*.mjs 未被任何带规则的 block 匹配（会退到兜底 block）');
  assert(p.parses, 'test/**/*.mjs 解析失败 —— sourceType 可能被猜成了 CJS');
});

await test('AC-EC-2 ESM 不应拿到 CJS 专有全局变量', async () => {
  // require/module/exports 在 ESM 里不存在。把它们声明成全局等于把真正的误用
  // 掩盖掉（`.mjs` 里写 require(x) 本来就是运行期才炸的错误）。
  //
  // 同样用行为判据而不是读配置形状：读 globals 的话，一旦文件没被任何 block
  // 匹配，语言选项是 undefined，这个用例会以 TypeError 的形式"碰巧失败"，
  // 报出来的却是一句看不懂的类型错误。
  const [result] = await eslint.lintText('require("x");', {
    filePath: path.join(REPO_ROOT, 'test/cast-audit-selftest.mjs'),
  });
  const undef = result.messages.filter((m) => m.ruleId === 'no-undef');
  assert(
    undef.some((m) => m.message.includes('require')),
    'ESM 文件里 require 未被报 no-undef —— 说明它被当成了 CJS 全局',
  );
});

// ---- 用例 1b：ESM 文件必须拿到 Node 全局变量 ----
//
// **这条是补上的漏洞，值得单独说明成因 —— 它和直觉相反。**
//
// 原判据只问「有没有规则生效」。实测发现不够：删掉 eslint.config.mjs 里那个
// `test/**/*.mjs` 的 ESM block 之后，判据**依然全绿**，而 `npx eslint .`
// 同时红着 20 条 `console is not defined`。原因是：
//
//   - ESLint 对 `.mjs` 扩展名**默认就按 module 解析**，所以删掉 block 后
//     `sourceType` 仍是 `module`、`import/export` 照样能解析 —— 
//     "解析模式"根本不会因为少一个 block 而变红；
//   - 但那个 block 同时也是**唯一**给 `.mjs` 注入 `NODE_GLOBALS`（console/process…）
//     的地方。少了它，文件仍然被扫描、仍然报规则，只是**每个 Node 全局变量都成了
//     no-undef**。
//
// 所以正确的判据不是"解析模式"，而是"Node 全局变量在不在"。这里同时锚定
// `console` 与 `process`：前者是 issue #29 的实际报错，后者防止有人只补一个。
await test('AC-EC-1b .mjs 必须拿到 Node 全局变量（console/process）', async () => {
  for (const name of ['console', 'process']) {
    const [result] = await eslint.lintText(`${name};
`, {
      filePath: path.join(REPO_ROOT, 'test/cast-audit-selftest.mjs'),
    });
    assert(
      result.messages.length === 0,
      `.mjs 里 \`${name}\` 被报 no-undef —— 它没拿到 NODE_GLOBALS。` +
      `
        检查 eslint.config.mjs 里匹配 test/**/*.mjs 的 block 是否还在、` +
      `是否被后面的 block 覆盖掉了 globals。`,
    );
  }
});

// ---- 用例 2：兜底 block 本身必须是"不合格"的 ----
//
// 这条是上面 probe 判据的**证伪实验**：如果 calculateConfigForFile 对
// 任何文件都返回带 globals 的配置，那用例 1 就永远通过，等于什么都没测。
// 这里要求：真正没被任何 block 覆盖的文件，判据必须返回 false。
await test('AC-EC-3 未被任何 block 覆盖的文件，判据必须识别得出来', async () => {
  // .ts 没有对应的配置块（本项目不写 TS），所以它是天然的"未覆盖"样本。
  const p = await probe('nonexistent-sample.ts');
  assert(!p.rulesApply, '未覆盖的 .ts 被判成了已覆盖 —— 判据失效，用例 1 是假绿');
});

// ---- 用例 3：全仓扫描 ----
//
// 这才是真正防复发的：新增一个目录或扩展名时，只要忘记配 block，这里就会红。
await test('AC-EC-4 仓库里每个 JS 文件都被某个 block 覆盖', async () => {
  const files = collect(REPO_ROOT);
  assert(files.length > 50, `只扫到 ${files.length} 个 JS 文件，扫描口径可能不对`);

  const uncovered = [];
  for (const rel of files) {
    const p = await probe(rel);
    if (!p.rulesApply || !p.parses) uncovered.push(rel);
  }
  assert(
    uncovered.length === 0,
    `以下 ${uncovered.length} 个文件不在任何 ESLint block 的覆盖内：\n` +
    uncovered.map((f) => `          ${f}`).join('\n') +
    '\n        在 eslint.config.mjs 里补一个匹配它们的 block。',
  );
});


console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);

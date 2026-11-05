/**
 * ESLint flat config（对应 xp-gate Gate 1: Code Quality）
 *
 * ## 为什么有这个文件
 *
 * 项目此前没有任何 eslint 配置。Gate 1 在检测到 JavaScript 语言后
 * 会调用 eslint，但 eslint 9+ 要求 flat config，找不到就直接报错退出 ——
 * 结果是「门禁显示通过，其实根本没检查」。
 *
 * 这个配置只依赖全局安装的 eslint 自带能力，不引入额外规则包，
 * 目的是让 Gate 1 真的能跑起来并给出有意义的结论。
 *
 * ## 关于 C#
 *
 * 本项目核心是 C#（src/*.cs），但 eslint 管不到它。
 * C# 的质量由 `build.sh --check` 里的 `dotnet format` 与
 * `-warnaserror` 静态检查覆盖（当前 0 警告）。
 * C# 侧面由 xp-gate 的 csharp adapter 接管（Gate 1 formatter + Gate 3 CCN）。
 *
 * ## 结构约定
 *
 * 四类文件（ESM 源码 / 插件测试 / 浏览器 bundle / 仓库测试）共享同一套
 * 基础规则与全局变量声明。这些**只写一次**、在下面按需组合 ——
 * 早先每个 block 各自复制一遍 globals 与 rules，改一条规则要动四处，
 * 实际也漂移过（`no-empty` 在有的 block 有、有的没有），
 * 同时也被 jscpd 判成 2 处重复（Gate 2）。
 */

// 不 import '@eslint/js'：全局安装的 eslint 把它放在自己的 node_modules 里，
// 项目目录解析不到。改为直接声明需要的规则（等价于 recommended 的核心子集，
// 且剔除了与项目风格冲突的几条）。

/** 推荐的正确性子集：都是「一定是 bug」级别的规则。 */
const BASE_RULES = {
  'no-undef': 'error',
  'no-redeclare': 'error',
  'no-unreachable': 'error',
  'no-dupe-keys': 'error',
  'no-dupe-args': 'error',
  'no-duplicate-case': 'error',
  'no-constant-condition': ['error', { checkLoops: false }],
  'no-self-assign': 'error',
  'no-unsafe-negation': 'error',
  'no-fallthrough': 'error',
  'use-isnan': 'error',
  'valid-typeof': 'error',
  'no-async-promise-executor': 'error',
  'no-await-in-loop': 'off',
  'require-atomic-updates': 'off',
};

/** 所有 block 共用的 Node 全局变量。 */
const NODE_GLOBALS = {
  process: 'readonly',
  console: 'readonly',
  Buffer: 'readonly',
  URL: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  setImmediate: 'readonly',
  __dirname: 'readonly',
  __filename: 'readonly',
};

/** CJS 额外需要的全局变量。 */
const COMMONJS_GLOBALS = {
  require: 'readonly',
  module: 'writable',
  exports: 'writable',
};

/** 项目风格规则（各 block 一致的部分）。 */
const STYLE_RULES = {
  // 未使用变量：允许以 _ 开头的占位参数（例如 (_, idx) => ...）
  'no-unused-vars': ['error', {
    argsIgnorePattern: '^_',
    varsIgnorePattern: '^_',
    caughtErrorsIgnorePattern: '^_',
  }],
  // 要求 === 而非 ==（本项目此前有过隐式转换隐患）
  eqeqeq: ['error', 'smart'],
  // 禁止 var（浏览器 bundle 除外，见下方单独 block）
  'no-var': 'error',
  // 优先 const
  'prefer-const': ['error', { destructuring: 'all' }],
};

/** 测试与基准代码额外放宽：允许空 catch（清理代码常见）。 */
const TEST_RULES = {
  ...STYLE_RULES,
  'no-empty': ['error', { allowEmptyCatch: true }],
};

export default [
  // 全局忽略：构建产物、依赖、上游补丁留档（不是我们的代码）
  {
    ignores: [
      'dist/**',
      'dist-opt/**',
      'dist-final/**',
      'bin/**',
      'obj/**',
      'node_modules/**',
      // 上游文件留档 —— 是别人的代码，不按我们的规范要求
      'vendor/dsh-subprocess-local-0.2.0-rc.2/**',
      // bench 基准生成的样本数据（几百个几百 KB 的合成文件）。
      // 它们在 .gitignore 里，但 ESLint 不读 .gitignore —— 只要跑过
      // bench/node-tuning/README.md 里的生成命令，目录一存在就会
      // 冒出 200 个「Identifier 'x' has already been declared」解析错误，
      // 让 `eslint .`（也就是 build.sh --check 与 Gate 1）整体失败。
      // 这不是代码问题，是检查范围没有排除数据目录。
      'bench/node-tuning/files/',
      'bench/node-tuning/files2/',
      'bench/node-tuning/tiny/',
    ],
  },

  // 基础推荐规则（所有 JS/MJS 都适用）
  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: { ecmaVersion: 'latest' },
    rules: BASE_RULES,
  },

  // 项目源码（ESM）
  {
    files: ['plugin/lib/**/*.js', 'scripts/**/*.mjs', 'vendor/*.mjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: NODE_GLOBALS,
    },
    rules: {
      ...STYLE_RULES,
      // 本项目允许 console（诊断输出是 runner 的主要可观测手段）
      'no-console': 'off',
    },
  },

  // 插件自己的测试是 ESM（plugin/package.json 里 type: module）
  {
    files: ['plugin/test/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: NODE_GLOBALS,
    },
    rules: TEST_RULES,
  },

  // 客户端 bundle（浏览器）
  //
  // 这个文件是给 DSH 的浏览器端模块加载器用的，不是 Node 模块：
  //   - 走 `window.__ModuleLoader__.load(...)` 注册，所以需要 window
  //   - 刻意用 var 和 function 而不是 const/箭头函数 —— 它要在
  //     未知版本的浏览器里跑，且 `var` 的函数作用域在 bundle 里更安全
  //   - 不能有 import/export，只能靠 loader 注入的 require()
  {
    files: ['plugin/client/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'script',
      globals: {
        window: 'readonly',
        console: 'readonly',
        Promise: 'readonly',
        Object: 'readonly',
        Array: 'readonly',
        String: 'readonly',
        Error: 'readonly',
      },
    },
    rules: {
      ...TEST_RULES,
      // 浏览器 bundle 刻意使用 var（见上方注释）
      'no-var': 'off',
      'prefer-const': 'off',
    },
  },

  // 仓库测试与基准（CJS，且允许更多自由度）
  {
    files: ['test/**/*.js', 'bench/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'commonjs',
      globals: { ...NODE_GLOBALS, ...COMMONJS_GLOBALS },
    },
    rules: TEST_RULES,
  },

  // .githooks 等无扩展名脚本按 CJS 处理
  {
    files: ['.githooks/**'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'commonjs',
      globals: { require: 'readonly', process: 'readonly', console: 'readonly' },
    },
  },
];

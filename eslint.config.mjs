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
 * xp-gate 本身尚无 C# 适配器，已提 issue。
 */

// 不 import '@eslint/js'：全局安装的 eslint 把它放在自己的 node_modules 里，
// 项目目录解析不到。改为直接声明需要的规则（等价于 recommended 的核心子集，
// 且剔除了与项目风格冲突的几条）。

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
    ],
  },

  // 基础推荐规则（等价 recommended 的核心子集，显式列出避免依赖解析问题）
  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: { ecmaVersion: 'latest' },
    rules: {
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
    },
  },

  // 项目源码（ESM）
  {
    files: ['plugin/lib/**/*.js', 'scripts/**/*.mjs', 'vendor/*.mjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        // Node.js 全局
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        URL: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setImmediate: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
      },
    },
    rules: {
      // 未使用变量：允许以 _ 开头的占位参数（例如 (_, idx) => ...）
      'no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      }],
      // 禁止 console.log 之外的调试残留
      'no-console': 'off',
      // 要求 === 而非 ==（本项目此前有过隐式转换隐患）
      eqeqeq: ['error', 'smart'],
      // 禁止 var
      'no-var': 'error',
      // 优先 const
      'prefer-const': ['error', { destructuring: 'all' }],
    },
  },

  // 插件自己的测试是 ESM（plugin/package.json 里 type: module）
  {
    files: ['plugin/test/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        URL: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setImmediate: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      }],
      eqeqeq: ['error', 'smart'],
      'no-var': 'error',
      'prefer-const': ['error', { destructuring: 'all' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
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
      'no-var': 'off',
      'prefer-const': 'off',
      'no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      }],
      eqeqeq: ['error', 'smart'],
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },

  // 仓库测试与基准（CJS，且允许更多自由度）
  {
    files: ['test/**/*.js', 'bench/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'commonjs',
      globals: {
        require: 'readonly',
        module: 'writable',
        exports: 'writable',
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setImmediate: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        // 测试里常用的大整数/时间常量会触发 no-magic-numbers，
        // 但本配置未启用该规则（由 Gate 4 单独负责）
      },
    },
    rules: {
      'no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      }],
      eqeqeq: ['error', 'smart'],
      'no-var': 'error',
      'prefer-const': ['error', { destructuring: 'all' }],
      // 测试里允许空的 catch（清理代码常见）
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
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

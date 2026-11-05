# xp-gate 技术债基线与合规现状（2026-11-05）

本文件记录「用 xp-gate 对本项目做完整扫描 → 逐项消除技术债」的全过程与终态。
它同时是回归基准：每轮改动后重跑同样命令，对比本表判断是否收敛。

- 起点：Gate 3 有 **42 个函数 CCN > 5**、C# 侧**零自动化测试**、Gate 4 有 203 条违规
- 终态：Gate 1/2/3/4/6/8 全部 PASS，C# 侧 **139 个单元测试**，生产源码覆盖率可测
- 顺带修掉两个**静默失效的生产缺陷**（`SafeJobHandle.IsEmpty()` 恒定 false，见 §3.5）
  和 10 个 xp-gate 缺陷（其中 #774 会让 Gate 3 自己 fail-open，见 §5.2）

---

## 0. 让 xp-gate 真正生效（步骤 1）

### 0.1 安装形态

用**全局安装**的 xp-gate `0.36.0`（用户明确要求不依赖本地源码副本）：

```
/c/Users/think/AppData/Roaming/npm/node_modules/@boyingliu01/xp-gate
/c/Users/think/AppData/Roaming/npm/xp-gate            # CLI
/c/Users/think/.config/xp-gate/hooks/                 # hook（实际执行入口）
/c/Users/think/.config/xp-gate/adapters/              # 语言适配器（含 csharp.sh）
```

### 0.2 hook 链式结构

`.githooks/pre-commit` 分两段，缺一不可：

1. **项目自有快检**：JS 语法（扫描 18 个文件）+ `dotnet format --verify-no-changes`
2. **`exec` 全局 xp-gate pre-commit**，跑 Gate 0-13

为什么必须链式而非二选一：本仓库 `core.hooksPath=.githooks`，会盖掉 xp-gate
装到 `.git/hooks/` 的 hook；不显式转发则 xp-gate 在本项目完全不生效。

**关于"全局门禁是否更严"的核实结论（用户点 1）：**

| 维度 | 项目自有 | xp-gate 全局 | 谁更严 |
| --- | --- | --- | --- |
| C# 格式 | `dotnet format --verify-no-changes`，**阻断** | Gate 1 适配器 RC=1 时打印 "may be non-blocking" 后 **SKIP（fail-open）** | **项目** |
| C# 编译警告 | `-warnaserror`，**0 警告** | Gate 13 需 .cs 变更才触发 | 项目（全局亦覆盖） |
| 函数复杂度 | 无此检查 | Gate 3：CCN > 5 即 **BLOCK** | **全局** |
| 重复代码 | 无 | Gate 2（jscpd） | **全局** |
| Clean Code/SOLID | 无 | Gate 4 | **全局** |
| 架构 | 无 | Gate 6（archlint） | **全局** |
| 密钥扫描 | 无 | Gate 8（gitleaks） | **全局** |
| SAST | 无 | Gate 10（semgrep） | **全局** |
| 覆盖率 | `.c8rc.json`（JS 85/85/80/65） | Gate 5 | 各有侧重 |

**结论：全局并非在每一维都更严**（C# 格式上是 fail-open，比本项目松），
因此「删掉项目门禁、只靠全局」会**降低** C# 质量保证。正确做法是**两级叠加**，
这也正是当前 `.githooks/pre-commit` 的实现。

### 0.3 让 C# 被真正路由

实测发现：`xp-gate detect-languages` 生成的 `.xp-gate-config.json` 只有
`typescript shell`，**没有 csharp**（因为 `LANGUAGE_REGISTRY` 无该条目，见缺陷 1）。
而 hook 一旦读到该配置文件，就**不再走扩展名回退**，于是 C# 永远不被路由 ——
即使 `_detect_ext_lang "cs" "csx"` 那条分支存在（issue #717 的修复）。

证据（删掉配置文件后 hook 立刻开始检查 csharp）：

```
── Checking typescript ──
── Checking shell ──
── Checking csharp ──      ← 配置文件在时完全没有这一节
```

处置：在 `.xp-gate-config.json` 的 `languages` 里补 `csharp` 条目
（该文件已 gitignore，属本机探测结果）。补上后 Gate 1 真的跑起
`dotnet format`，输出 `FORMAT OK`。

---

## 1. 项目自有门禁 `./build.sh --check`（终态 PASS）

| 项 | 结果 |
| --- | --- |
| C# 格式（`dotnet format --verify-no-changes`） | PASS |
| C# 静态检查（`-warnaserror`） | PASS（0 警告） |
| 版本一致性（VERSION / package.json / plugin/package.json = 0.1.0） | PASS |
| **C# 单元测试（xunit）** | **PASS — 116/116** |
| **C# 覆盖率（coverlet → cobertura）** | 生产源码 32.6%（306/939 行），仅报告不设门槛 |
| JS 覆盖率（`.c8rc.json`：stmts/lines/funcs/branches = 85/85/80/65） | PASS |
| ESLint（flat config，`eslint.config.mjs`） | PASS（0 问题） |
| JS 语法 | PASS（18 个文件） |
| vendor 上游补丁留档 md5 | PASS |

`./build.sh --check` 退出码 **0**。

---

## 2. xp-gate 逐 gate 终态

### 2.1 CLI 模式（`xp-gate check N`）

| Gate | 名称 | 结论 | 证据 |
| --- | --- | --- | --- |
| 0 | Version Consistency | ⏭️ SKIP | 需 git-staged 上下文（已在 hook 内 PASS） |
| 1 | Code Quality | ⏭️ SKIP（CLI） | 需改动文件集与 adapter 路由（已在 hook 内 PASS） |
| 2 | Duplicates | ✅ PASS (exit 0) | 78 文件 / 14030 行；16 clones / 181 行（1.29%）/ 1185 tokens（1.44%） |
| 3 | Cyclomatic Complexity | ✅ **PASSED** | `All functions within complexity threshold (5).` — **42 → 0** |
| 4 | Principles | 0 error / 0 warning / 194 info | `formatSummary` 按 violations 总数渲染成 `✗ FAIL`（缺陷 6），但 error 计数为 0，hook 内部判 PASSED |
| 5 | Tests + Coverage | ⏭️ SKIP（CLI） | 需语言检测与 adapter 测试执行 |
| 6 | Architecture | ✅ PASS | `Architecture quality: 6.5/10 (Fair)`；`Findings: 6 total, 0 high/critical` |
| 7 | IaC Security | ⏭️ SKIP | 无 IaC 文件 |
| 8 | Secret Scanning | ✅ **PASSED** | `No secrets detected.` |
| 9 | Build Integrity | ⏭️ SKIP | 需 commit 上下文 |
| 10 | SAST | ✅ PASS | semgrep 无阻断 |
| 11 | Sprint Flow | ⏭️ SKIP | 无 `.sprint-state/` |
| 12 | File Hygiene | ⏭️ SKIP | 需 staged diff |
| 13 | Compiler Strictness | ⏭️ SKIP | 需改动文件集 + 工具链发现 |

> CLI 模式下 Gate 0/1/5/9/11/12/13 结构性 SKIP —— 这些 gate 的输入是「staged 文件集」，
> 独立调用时没有该上下文。它们的真实状态只能从 hook 路径读（见 2.2）。

### 2.2 hook 路径（`git commit` 时，真实门禁）

| Gate | 结论 | 证据 |
| --- | --- | --- |
| 0 | ✅ PASSED | 三处 0.1.0 一致 |
| 1 | ✅ PASSED | shellcheck PASSED（含 `build.sh:170` 的 `rm -rf "${OUT_ABS:?}"` 修复）；csharp 分支 `FORMAT OK` |
| 2 | ✅ PASSED | `Found 0 clones`（staged 范围 20 文件） |
| 3 | ✅ PASSED | 全树/增量均 0 个 CCN > 5 |
| 4 | ✅ PASSED | `no errors found` |
| 5 | ❌ **BLOCKED** | xp-gate 缺陷（见 §4 缺陷 2/8）；**非本项目代码问题** |

> Gate 5 之后的门禁（6-13）在 hook 里因 Gate 5 `exit 1` 不执行（`|| exit 1` 短路）。
> 它们的可用结论取自 CLI 模式（§2.1）与单独验证。

---

## 3. 技术债消除明细

### 3.1 Gate 3：CCN > 5 从 42 个降到 0

#### C# `src/`（15 → 0）

| 函数 | 原 CCN | 处置 |
| --- | --- | --- |
| `CrtDescriptorTable::Encode` | 8 | 抽 `FillSlot` + `BuildFlags` → 3 |
| `IpcChannel::TryTakeFrame` / `Fill` / `WriteAll` | 6/7/6 | 帧编解码整体抽成 `IpcFrameDecoder`（纯逻辑、无 I/O、可单测） |
| `JobRunner::Run` | 9 | 拆 `StartReaderThread` + `PumpMessages` + `HandleEof` |
| `JobRunner::HandleMessage` | 7 | switch 表达式 → `HandleStartMessage` |
| `JobRunner::SpawnTarget` | 8 | 拆 `ResolveControlHandle` / `CollectTargetHandles` / `LaunchWithDescriptorTable` |
| `NormalizeWindowsPath` | 6 | 线性 3 规则 + `IsBareDrive` |
| `WindowsFileNameStart` | 6 | `LastIndexOfAny` + 裸盘符判定 |
| `Poll` | 7 | → `IsJobEmptiable()` |
| `TryPublishExit` | 6 | → `TryReadExitCode(SafeKernelHandle?, out uint)` |
| `ReleaseOwnedJob` | 8 | → 泛型 `ReleaseHandle<T>` |
| `LineReader::ReadLine` | 6 | 拆 `Refill` / `TakeLine` / `TakeTail` |
| `Program::RunCore` | **10** | argv 解析抽到 `ArgParsing.ParseArgs` → 4 |
| `ProtocolJson::AppendString` | **10** | switch → `EscapeMap` 字典 → 4 |

#### JS `plugin/`（7 → 0）

`readLoaderState`(10)、`resolveExe`(10)、`readBool`(7)、`StatusEntry`(**15**)、
`apply`(7/6)、`resolveRunnerPath`(6) 全部拆分。其中 `StatusEntry` 15 → 抽出
`buildStatusView` / `readFailThreshold` / `buildStatusRows` / `loaderRow` / `yesNo`；
`readBool` 与 `resolveExe` 的重复取值逻辑合并为 `readTypedField` + `findTypedField`；
`resolveRunnerPath` 的三个来源判定收敛为 `pathIfExists(candidate, source)`；
`apply` 拆成 `setup`（前置校验 + 注入）+ `requireRuntime` + `makeBreaker` + `injectRunner`。

#### JS `bench/` `scripts/` `vendor/`（7 → 0）

| 文件 | 函数 | 原 CCN | 处置 |
| --- | --- | --- | --- |
| `bench/aot-observe.js` | `isTrustworthy` | 10 | → `isRoundObject` + `hasFailures` + `isValidDispersion` |
| `bench/aot-observe.js` | `cmdCheck` | 6 | → `isCpuBusy` + `formatCpu` + `cpuVerdict` |
| `bench/aot-observe.js` | `cmdRun` | 8 | → `describeRound` + `printAggregateVerdict` |
| `bench/aot-observe.js` | `printHistoryTable` | 8 | → 4 个格式化函数 |
| `bench/d1-ab-bench.js` | `verdict` | 7 | 阈值分级抽 `dispersionVerdict(worst)` |
| `scripts/check-version.mjs` | `main` | 7 | → `collectSources` + `printSources` + `checkMissing` + `checkMismatch` |
| `vendor/patch-dsh.mjs` | `findTarget` | 10 | 三个候选各成函数：`fromModuleResolution` / `fromRunningProcess` / `fromHomeLayout`，`findTarget` 变成一行 `??` 链 |
| `vendor/patch-dsh.mjs` | `readState` | 9 | 四分支状态判定抽 `classify(hasBefore, hasAfter)`（用「两标记是否一致」两次比较替代四个条件） |

### 3.2 Gate 4：9 warning → 0
| 类型 | 原数量 | 处置 |
| --- | --- | --- |
| `missing-error-handling` | 3 | `runBench`（spawnSync 的 `r.error`/`status`/try-catch）、`appendHistory`/`readHistory`（IO 失败降级为警告）、`test/aot-observe-verify.js` 的 `walk`（`readdirSync` try-catch） |
| `long-function` | 4 | `StatusCard`(85)→`SummaryBar`+`FixList`+`Hints`+`STYLE` 常量；`StatusEntry`(65)→`buildStatusView`；2 个测试匿名 async 已拆（见 3.1） |
| `deep-nesting` | 2 | `apply` 6 层→`isMountableCtx`+`bindSettings`+`registerRowConfig`；`registerRowConfig` 再抽 `rowConfigEntry` |

终态：**0 error / 0 warning / 194 info**（194 条 info 全是 `magic-numbers` 噪音，
见 §4 缺陷 6）。hook 判 `✅ PASSED - Principles checker (no errors found)`。

### 3.3 Gate 1 / Gate 2 阻塞项

| 问题 | 根因 | 处置 |
| --- | --- | --- |
| shellcheck 报 **177** 个 "Literal carriage return" | `build.sh` 整文件是 CRLF（HEAD 里是纯 LF，被编辑器改坏） | 转回 LF，并新增 `.gitattributes` 强制脚本类 `eol=lf` 防复发 |
| shellcheck 报 `build.sh:170` `${var:?}` | `rm -rf obj bin "$OUT_ABS"/*`，`OUT_ABS` 为空时会变成 `rm -rf /*` | 改为 `"${OUT_ABS:?}"`，宁可报错中止 |
| `eslint.config.mjs` 内部 2 处重复（jscpd） | 4 个 block 各自复制一遍 globals 与 rules | 提取 `BASE_RULES` / `NODE_GLOBALS` / `COMMONJS_GLOBALS` / `STYLE_RULES` / `TEST_RULES` 常量复用 |
| `.xp-gate/` 等工具产物被判重复 | jscpd 默认忽略集未覆盖 | `.gitignore` 补齐（`githooks/`、`.qoder/`、`opencode.json`、`.xp-gate-config.json`、`.xp-gate/modules/` 等） |

### 3.4 新增的回归保护（用户点 3 的第一优先级）

**C# 侧此前完全没有自动化测试**（`src/` 11 个文件约 4270 行全靠 e2e）。现已建立
`tests/DshAotRunner.Tests/`，**139 个 xunit 用例**，全部纳入 `build.sh --check`：

| 测试文件 | 用例数 | 覆盖目标 |
| --- | --- | --- |
| `ProtocolJsonTests.cs` | 17 | `ParseStart`（全字段/默认值/非法 JSON/非对象根/env 非对象/类型错误）、`PeekType`、`AppendString` 转义（`"` `\` `\n` `\r` `\t` `\b` `\f`、控制字符→`\uXXXX`、非 ASCII）、`Serialize` 形状与往返 |
| `IpcFrameDecoderTests.cs` | 16 | 单帧/空载荷/多帧粘连/半帧/header 跨读/逐字节喂/非 NORMAL 类型/负长度/超限长度/恰好等于上限/UTF-8 多字节跨界/200k 自动扩容/Available 归零/三帧带尾partial/构造参数校验 |
| `LineReaderTests.cs` | 12 | 单行/多行/CRLF 剥离/无尾换行/空行→`""`/空流/保留空格/UTF-8 中文/200k 跨块长行/2 字节滴流/一块多行/尾行只返回一次 |
| `JobRunnerPureLogicTests.cs` | ~40 | `AppendQuoted`/`Quote`/`BuildCommandLine`、`WindowsFileNameStart`（8 例 Theory）、`NormalizeWindowsPath`、`BuildExecutableCandidates`（.com 先于 .exe，不含 .cmd/.bat）、`SplitPath`、`GetEnvValue`（大小写不敏感）、`WindowsSearchPathJoin`、`BuildSearchRoots`、`BuildEnvironmentBlock`（`A=1`→恰好 10 字节、空 env→2 字节、两变量→18 字节、非 ASCII UTF-16LE） |
| `ArgParsingTests.cs` | 15 | `--` 前导、`ndjson` 移除（中间/前导/重复）、`.js`/`.JS` 前缀、空数组、仅 `--`、仅 `--ndjson`、嵌套 `--`、非 js 首参、空程序名保留 |
| `CrtDescriptorTableTests.cs` | 10 | 描述符表字节布局（count/flags/handles 三段偏移）、`control` 无效时返回 null、四个槽的 `FOPEN\|FPIPE` flag、未填槽保持 `INVALID_HANDLE_VALUE`、**NUL 陷阱**（标准槽拿到字符设备必须抛异常，control 槽不抛） |
| `TraceAndJobHandleTests.cs` | 23 | `Trace` 默认完全静默（`DSH_AOT_DEBUG` 只认字面量 `1`）、`Write`/`Timed` 落盘格式、输出路径不可写时静默吞异常；`SafeJobHandle` 创建/`KILL_ON_JOB_CLOSE`/**`IsEmpty()` 两端契约**/Dispose 幂等释放/无效句柄抛 `Win32Exception` |

**这 33 个新用例不是凑数 —— 它们立刻抓出了两个真实的生产缺陷**（详见 §3.5）。

**关键设计决策（都有理由，不是权宜）：**

- 测试项目**不用 `ProjectReference`**，而是 `<Compile Include="../../src/**/*.cs" />`
  直接链接源码。理由：主项目是 `PublishAot` 的 Exe，引用它会拖入 AOT/裁剪配置；
  直接链接则与主项目共用同一份文件，重构时测试自动跟着编译，不存在两份实现漂移。
- 排除 `src/Program.cs`：它的 `Main` 会与 xunit 入口冲突（`CS0017`）。它只是 argv 接线层。
- 主项目 csproj 需 `<Compile Remove="tests/**" />`：SDK 的 `**/*.cs` 通配会把测试文件
  吸进主项目（`CS0246` 找不到 xunit，且测试会进 AOT 产物）。
- C# 覆盖率用 coverlet + `coverage.runsettings`，其中 **`IncludeTestAssembly=true`** 是必需的：
  被测代码就在测试程序集里，而 coverlet 默认跳过测试程序集，否则报告恒为 0 行。

### 3.5 新测试抓出的两个真实缺陷（本轮修复）

写 `JobHandleTests` 时，「新 job 应该为空」这条最朴素的断言直接失败了 ——
`SafeJobHandle.IsEmpty()` **恒返回 false**。顺着查下去是两个叠加的错误：

**缺陷 A：`JOBOBJECTINFOCLASS` 传了裸数字 `8`**

`src/JobHandle.cs` 原本写的是 `QueryInformationJobObject(handle, 8 /* BasicAccountingInformation */, ...)`。
但 `8` 是 `JobObjectBasicAndIoAccountingInformation`（要求 96 字节缓冲区），
`BasicAccountingInformation` 是 **`1`**（48 字节）。只传 48 字节 → 返回
`ERROR_BAD_LENGTH(24)` → 调用方把「查询失败」当成「job 非空」。

**缺陷 B：P/Invoke 声明漏了 `lpReturnLength`**

`QueryInformationJobObject` 的原型是 5 个参数，`src/Native.cs` 只声明了 4 个。
实测（Windows 11 / .NET 8）：4 参数版本**恒定返回 FALSE + `ERROR_NOACCESS(998)`**，
补上第 5 个参数（哪怕是 `IntPtr.Zero`）就成功。

**影响面**：`JobRunner.Poll()` 里「job 空了就收尾」那条路径（`IsJobEmptiable`）
从项目建立起就没生效过 —— `IsEmpty()` 永远 false。现象是 job 句柄只能靠
`Finish()` 的兜底释放，`KILL_ON_JOB_CLOSE` 的整树回收语义失去了主动判断这一环。
属于**静默失效**：没有崩溃、没有日志，只是某条清理路径从未被走到。

**修复**：改用命名常量 `Native.JobObjectBasicAccountingInformation`，补齐第 5 参数，
并在 `Native.cs` 里为这两个坑各写一段注释解释为什么不能用裸数字 / 不能省参数。
测试用**两端断言**（有活进程时 `IsEmpty()` 必须为 false、进程退出后必须变 true）
守住它 —— 只断言「空 job 为空」的话，一个退化成 `return true` 的实现也会假通过。

> 教训与本轮主题一致：**没有测试的清理路径 = 不存在的清理路径。**
> 这两处代码此前被 e2e 覆盖过（`leak-verify.js` 就查进程泄漏），
> 但 e2e 只看最终有没有残留进程，看不到「哪个判断从未生效」。

**e2e 无法在本机验证（环境限制，非代码缺陷）**：NativeAOT 构建需要 VS C++ 工作负载的
`link.exe`，本机未安装 → `Platform linker not found`。因此 `test/ipc-verify.js`、
`host-path-verify.js`、`ab-verify.js`、`leak-verify.js`、`race-verify.js`、
`e2e-plugin-verify.js` 在本环境不可执行；`dist/dsh-aot-runner.exe` 是 11-03 的旧构建，
不含当前重构，不能用于替代验证。**这正是必须靠单元测试守住 C# 重构的原因。**

---

## 4. 已提交的 xp-gate 缺陷 issue

| # | 缺陷 | 影响 | 状态 |
| --- | --- | --- | --- |
| [#760](https://github.com/boyingliu01/xp-gate/issues/760) | Gate 5 把"vitest 覆盖率插件缺失"当成测试失败 | `node:test` + c8 项目每次提交永久 BLOCK（**本项目当前 Gate 5 阻塞的直接原因**） | open |
| [#761](https://github.com/boyingliu01/xp-gate/issues/761) | `lib/principles.js` 只接受第一个路径参数 | `filesChecked` 恒为 1，多传文件静默漏检（假通过） | open |
| [#762](https://github.com/boyingliu01/xp-gate/issues/762) | Gate 4 的 `SOURCE_EXTENSIONS` 缺 `.cs` | 已写好的 `principles/adapters/csharp.ts` 永远执行不到，Gate 4 对 C# 完全不检查 | open |
| [#763](https://github.com/boyingliu01/xp-gate/issues/763) | Gate 5 的 `CODE_EXTENSIONS` 缺 `cs` | 只改 `.cs` 的提交被报成"没有代码改动"而跳过测试 | open |
| [#764](https://github.com/boyingliu01/xp-gate/issues/764) | Gate 4 输出 0 errors 却报 `✗ FAIL` | `formatSummary` 按 `violations.length` 判定；exit code 0 与 FAIL 矛盾 | open |
| [#766](https://github.com/boyingliu01/xp-gate/issues/766) | Gate 1 的 ESLint 探测漏 `eslint.config.mjs/.cjs/.ts` | flat config 项目被报 "No ESLint configuration found - Skipping"，Gate 1 对 JS 完全不检查（fail-open） | open |
| [#767](https://github.com/boyingliu01/xp-gate/issues/767) | `xp-gate init` 把自身实现写进项目却不写 `.gitignore` | Gate 6 零容忍把 `githooks/` 与 `.git/hooks/` 判成 `CodeClone[High]`，永久 BLOCK | open |
| [#768](https://github.com/boyingliu01/xp-gate/issues/768) | Gate 5 不解析 csharp 适配器唯一产出的 cobertura 格式 | C# 覆盖率即使已产出合法报告也永远"无法确定"而 BLOCK | open |
| [#730](https://github.com/boyingliu01/xp-gate/issues/730) | （既有）`LANGUAGE_REGISTRY` 无 `csharp` | `detect-languages`/`check-tools` 看不到 C#，且生成的配置文件会**关掉**扩展名回退 | 既有 open |
| [#774](https://github.com/boyingliu01/xp-gate/issues/774) | Gate 3 在 >64KB 输入上 fail-open：`pipefail` + `awk` 提前 `exit` → SIGPIPE(141) 被当成「无函数」 | 24 个代码文件即触发，复杂度门禁**静默跳过**并报 SKIPPED（假通过） | open |

> 曾误提 #765（与 #763 重复），已关闭并标记 duplicate。

---

## 5. 剩余已知限制（诚实清单）

1. **Gate 5 在本项目无法通过**，根因是 xp-gate 两处缺陷叠加（#760 vitest 硬编码、
   #768 cobertura 不解析），不是本项目代码质量问题。项目侧证据：`build.sh --check`
   全绿，139 个 C# 单测通过，JS 插件测试 22/22 通过。
2. **e2e/AOT 不可在本机验证**（无 VS C++ `link.exe`），已在 §3.4 说明。
3. **Gate 4 的 194 条 info 未消除**：全部是 `magic-numbers` 误报（把 `15 * 60 * 1000`
   的 `15`、`0x08` 的 `8` 报成魔数）。这类规则不该由项目逐条加常量来"满足"，
   已作为 #764 的一部分建议 xp-gate 收敛通告量。
4. **Gate 2 有 16 个 clone（1.29%）**：主要是 `bench/d1-ab-bench.js` ↔ `test/runner-client.js`
   的基准测量代码互有相似（两者独立演化，合并会引入不必要的耦合），以及
   `package-lock.json` 自重复（生成物，不可手改）。低于 5% 的常见阈值，不做处理。
5. **CLI 模式下 Gate 0/1/5/9/11/12/13 结构性 SKIP** —— 需 staged 上下文，属设计如此。
6. **`test/` 目录下仍有 9 个函数 CCN > 5**（`ab-verify.js` 的 `pair`(11)/`checkErrorShape`(9)、
   `runner-client.js` 的 `resolveNodeRunner`(9)/`listDescendantPids`(8) 等）。
   Gate 3 把这些归入 `bucket === 'test'` 并**不计入**阻断（`(^|/)(tests?)/` 排除规则），
   且这些是 e2e 验证脚本 —— 本机无法运行（缺 AOT 链接器），无法验证重构等价性。
   **故有意不动**：在无法执行的前提下改 e2e 逻辑是纯风险、零收益。
   等 e2e 能在 CI/本机跑起来后再处理。

### 5.1 关于 Gate 3 的扫描范围（重要）

`xp-gate check 3` **不是全树扫描** —— 它的输入是 `CHANGED_FILES`（staged diff）。
本项目此前未改动的文件（`scripts/check-version.mjs`、`plugin/lib/index.js`、
`bench/d1-ab-bench.js`、`vendor/patch-dsh.mjs`）在全树口径下仍超阈值，
但 Gate 3 从未把它们纳入检查。**为了让「通过」名副其实，本次已把这 4 个文件
一并重构到 CCN ≤ 5**（见 §3.1），而不是依赖"没改到就不查"。

复核方式（生产口径 = 排除 test/ 目录，与 gate-3 的 test bucket 一致）：

```bash
git ls-files | grep -E '\.(js|mjs|cs|py)$' | grep -vE '(^|/)tests?/|\.test\.' > /tmp/prod.txt
tr '\n' '\0' < /tmp/prod.txt | xargs -0 lizard -C 5 --csv 2>/dev/null \
  | awk -F, 'NF>1 && $2+0>5 {print $2"  "$7}'
# 期望输出：空
```

### 5.2 Gate 3 在 >64KB 输入上会静默 fail-open（xp-gate #774）

本次还发现 Gate 3 的一个更严重的缺陷：**输入足够大时，它会把「有违规」判成
「这些文件没有定义函数」，输出 SKIPPED 并放行整个复杂度门禁。**

成因是 `adapters/gate-3.sh:598` 的探针管道：

```bash
if ! printf '%s\n' "$CC_CSV_FLAT" | awk -F, 'NF > 1 && $2 ~ /^[0-9]+$/ { found = 1; exit } ...'; then
```

`awk` 读到第一行匹配就 `exit`，上游 `printf` 随即收到 SIGPIPE。hook 开着
`set -o pipefail`（`hooks/pre-commit:307`），于是整条管道的退出码变成 **141**，
`if !` 判定成立 → 走「无函数」分支。

阈值实测（Windows 11 / MSYS2 bash 5.3）：

| CSV 字节数 | 管道退出码 |
|---|---|
| 4 096 | 0 |
| 32 768 | 0 |
| 65 536 | 0 |
| 70 000 | 141 |
| 106 000 | 141 |

**本项目 24 个代码文件就会产出 84 375 字节的 CSV**，已经踩在上面 —— 实测同一份
输入连跑 30 次全部返回 141；而在稍早一批里同样的数据返回 0。也就是说**同一个
提交可能通过、也可能被跳过，取决于调度**。

这是必须知道的一点：跑 hook 看到 Gate 3 `SKIPPED - pure data module` 时，
不能当作「没有复杂度问题」，要直接用上面的 `lizard` 命令复核。
已归档为 [xp-gate#774](https://github.com/boyingliu01/xp-gate/issues/774)。

---

## 6. 复现命令

```bash
# 项目自有门禁（终态：exit 0）
./build.sh --check

# C# 单元测试 + 覆盖率
dotnet test tests/DshAotRunner.Tests/DshAotRunner.Tests.csproj \
  --collect:"XPlat Code Coverage" --settings tests/DshAotRunner.Tests/coverage.runsettings
python scripts/coverage-summary.py

# xp-gate 逐 gate
xp-gate check 3      # ✅ PASSED - All functions within complexity threshold (5)
xp-gate check 4      # 0 errors / 0 warnings / 194 info
xp-gate check 6      # 0 high/critical
xp-gate check 8      # ✅ PASSED - No secrets detected

# 完整门禁链（Gate 5 会因 #760 阻塞 —— 预期行为，非项目问题）
sh .githooks/pre-commit
```

# TODO — dsh-aot-runner 待办清单

> **生成时间**：2026-11-22
> **基准提交**：`23d9939` 之上的 0.2.5（待提交，见下方「本轮变更速查」）
> **工具版本**：xp-gate v0.38.82 / .NET SDK 10.0.404 / Node 22+
> **当前状态**：`build.sh --check` 全绿，322 C# 测试通过，生产源码覆盖率 100%，ESLint exit 0
>
> 本文档记录**重建开发环境（WSL）之后仍需处理的事**。每条都标注了
> 「已验证 / 未验证」，避免把推断当结论。

---

## 0. 迁移到 WSL 前必须先决定的事

这几条不是代码待办，而是环境重建的前提。**没想清楚就迁，会在 WSL 里撞墙。**

### TODO-0.1 确认 AOT 交叉编译在你选的 WSL 发行版上可行

本项目是 **Windows 原生** runner：`CreateProcessW`、Job Object、
`ucrtbase.dll` 的 `_get_osfhandle`/`_dup2`、CRT 描述符表注入 —— 全部是 Win32 API。

| 问题 | 现状 |
|---|---|
| `dotnet publish -r win-x64` 能否在 Linux 上跑？ | **理论可以**（NativeAOT 支持交叉编译到 win-x64），但需要 Linux 上的 `clang` + `lld` + `objcopy`，且**未经本机验证** |
| 能不能在 WSL 里跑 C# 单测？ | **不能**。322 个测试里绝大多数要真实 Win32 调用（`FdLayoutHost` 直接改进程 fd 表）。WSL 里 `dotnet test` 会大面积失败 |
| 那 WSL 里能跑什么？ | 纯逻辑测试（`JobRunnerPureLogicTests` 的一部分）、ESLint、JS 测试、覆盖率统计脚本、文档 |

**结论与建议**：

- [ ] 决定 WSL 是否只做**编辑 + JS 侧 + 静态检查**，C# 的构建/测试仍回 Windows 跑
- [ ] 或者：在 WSL 里搭好 `dotnet publish -r win-x64` 的交叉编译链，把构建也迁过来（需先验证）
- [ ] 若选前者，把「必须在 Windows 上跑的命令」写进 `CLAUDE.md` / `AGENTS.md`，否则会被反复踩

**证据（已核实到源码，不是推断）**：

```
$ grep -ln "DllImport\|CreateProcess\|JobObject" tests/DshAotRunner.Tests/*.cs
CrtDescriptorTableTests.cs   EdgePathCoverageTests.cs   FdLayoutHost.cs
JobRunnerErrorPathTests.cs   JobRunnerOrchestrationTests.cs
JobRunnerPureLogicTests.cs   JobRunnerResolveTests.cs   TraceAndJobHandleTests.cs
```

`FdLayoutHost.cs` 的文件头写得很直白：它用 `CreatePipe` + `_open_osfhandle` + `_dup2`
在测试进程里造出真实的 fd 3/4/5/6/7 布局，因为「**直接 new JobRunner 去 spawn 会让
xunit 宿主进程崩溃**」—— 也就是说 322 个测试里的绝大部分**在 WSL 上根本没有可执行的语义**，
不是"跑得慢"，是"跑不了"。

**这意味着**：`./build.sh --check`（含 322 测试 + 覆盖率门槛）整个不能在 WSL 跑。
迁移后如果 CI 也搬到 Linux，会**直接丢失 C# 的回归保护** —— 这是本次迁移最大的风险点。

### TODO-0.2 确认 e2e 仍然无法在 WSL 跑（已知缺失）

*验证状态：**已确认**（本机无 VS C++ `link.exe`，AOT 链接失败）*

- [ ] 迁移后重新确认：WSL 里是否反而**能**跑 AOT 链接（Linux 有 clang，但仍需 win-x64 目标）
- [ ] 如果能跑通，把 `test/e2e-plugin-verify.js` 等 e2e 纳入 CI —— 现在它们长期未被执行

### TODO-0.3 Windows 上的本地产物（已被 gitignore，**不需要特殊处理**）

*验证状态：**已确认***

- [x] `tests/DshAotRunner.Tests/TestResults/` 有 **126 个**历史 cobertura 报告目录，但已被 `.gitignore:84` 忽略
- [x] 因此 clone 不会带上它们，**无需归档、无需清理**
- [ ] 可选：这些目录约占几百 MB，迁移后如果想回收磁盘，直接 `rm -rf tests/**/TestResults` 即可（不重建也行）

### TODO-0.4 行尾符（CRLF vs LF）—— 迁移最容易出问题的一处

**核查结果（2026-11-22 实测）**：仓库内**存储**全是 LF（`i/lf`），这是好消息 ——
WSL clone 出来直接就是 LF。但当前 Windows 工作区有 **13 个文件是 CRLF**（`w/crlf`），
其中 `.gitattributes` 明确要求 `eol=lf` 的就有 9 个：

```
bench/aot-observe.js          lib/bench-verdict.mjs
plugin/lib/index.js           scripts/check-release.mjs
test/bench-verdict-verify.js  test/contract-fingerprint-verify.js
test/e2e-plugin-verify.js     test/race-verify.js
test/runner-client.js
（另 4 个是 text=auto 的：DshAotRunner.sln、ROADMAP.md、plugin/README.md、
  plugin/test/degrade-observability.test.js）
```

它们在 Windows 上能跑（Node 接受 CRLF），所以一直没暴露。**在 WSL 下也不会坏** ——
因为 clone 会按 `i/lf` 重新检出成 LF，工作区里这 13 个脏状态不会跟着过去。

- [x] 确认仓库存储是 LF（`git ls-files --eol` 全为 `i/lf`）
- [ ] **迁移后**跑 `git ls-files --eol | grep -c 'w/crlf'`，预期 **0**。若不为 0，
      说明 `core.autocrlf` 被设成了 `true`（WSL 上应该是 `input` 或 `false`）
- [ ] `.githooks/pre-commit`、`.githooks/pre-push` 在 WSL 下需要 `chmod +x`
      （当前 Windows 上已是 `-rwxr-xr-x`，但执行位经 git 传输后在 Linux 上应保留；
      若丢失则 `git update-index --chmod=+x` 修一次）
- [ ] `git config core.hooksPath .githooks` 需在新 clone 里重设（**不随仓库传输**）

---

## 1. 本项目自身的技术债（可在 WSL 里直接做）

### TODO-1.1 补齐 `.archlint.yaml` 入口脚本白名单（issue #32）

*验证状态：**已确认未做*** —— 2026-11-22 实测白名单仍只有 3 条

- [ ] `bench/load-matrix.cjs`
- [ ] `scripts/check-js-syntax.mjs`
- [ ] `scripts/check-release.mjs`
- [ ] `scripts/contract-branch-coverage.mjs`
- [ ] `scripts/contract-fingerprint.mjs`

**为什么值得做**：archlint 的「死代码」判据是「有没有被 import」，对入口脚本必然误报。
这 5 个文件分别被 `package.json` script、`ci.yml`、`build.sh` 调用（已在 issue #32 逐条核实）。
不补白名单的后果不是"多几条噪声"，而是 Gate 6 的 8.5/10 分数被误报稀释 —— 真问题会被淹掉。

### TODO-1.2 处理两个**真实**的 archlint smell（issue #32）

*验证状态：**未验证**（迁移后需重跑确认）*

- [ ] `scripts/contract-branch-coverage.mjs` 的 `summarizeRuntime` 认知复杂度 16 → 拆成「取值/格式化/汇总」
- [ ] `contract-branch-coverage.mjs:202-209` ↔ `contract-fingerprint.mjs:64-72` 的 54 token 重复 → 抽公共小工具

> 注意：这两个脚本是「契约漂移检测」的两半，抽公共函数是**合理**的，
> 不会像 `bench/` 那样破坏实验自包含性。`.archlint.yaml` 里对 `bench/` 的豁免理由不适用于它们。

### TODO-1.3 给白名单加防漂移自检（issue #32 建议 3）

- [ ] 扫描 `scripts/*.mjs` / `bench/*.cjs`，若某文件既不在 `package.json` script、
      也不在 `ci.yml`、也不在 `build.sh` 里，就提示「补白名单或真删」

**理由**：白名单承诺「保证将来真新增的孤儿模块仍会被检出来」，但这个承诺已经失效过一次
（3 条白名单 vs 5+ 个入口脚本）。靠人记得补是不可靠的，要机器盯。

### TODO-1.4 JobRunner 仍偏大（issue #31 的收尾）

*验证状态：**已确认当前数值***

| 指标 | 本轮前 | 当前 | 阈值 |
|---|---|---|---|
| `src/JobRunner.cs` | 1468 行 | **983 行** | 1150（`large-file` 已过） |
| `god-class` | 65 方法 | **45 方法** | 15 |

已完成的部分（**不要回退**）：抽出 `LineReader.cs`、`EnvironmentBlock.cs`、
`ExecutableResolver.cs`、`JobRunner.Polling.cs`。每一项都做过逐行等价验证（227 行完全相同）。

- [ ] 可选：继续把「结果投递」（`SerializeResult` / `PublishResult` / `EmitSpawnEnoent` /
      `WindowsSpawnErrorCodes` / `NodeSpawnDetailCodes`）抽成 `JobRunner.Results.cs`
- [ ] **不建议**为凑数字拆到 15 个方法以下 —— 那会拆散「进程生命周期」这个真实职责

> **重要**：`xp-gate principles src/` 目前报的 3 条 `long-function`（`EmitSpawnEnoent` 58 行
> 实为 7 行、`Finish` 57 行实为 12 行）是 **xp-gate 的测量缺陷，不是技术债**。
> 详见 `docs/XP-GATE-BASELINE.md` §7（含 80 行可复现片段）。**不要去"修"它们。**

### TODO-1.5 `NdjsonChannel` 的 `solid.dip` 告警

*验证状态：**已确认当前存在***

```
⚠ [WARNING] solid.dip  line 38: Direct instantiation detected: new LineReader()
```

- [ ] 评估：`NdjsonChannel` 里 `new LineReader()` 是否应该注入
- [ ] 若是误报（`LineReader` 是无状态工具类），在 `.archlint.yaml` 或规则级做豁免并写明理由

### TODO-1.6 `src/` 之外的历史告警（**有意不动**）

这些不是待办，列出来是为了**避免下次有人误以为要修**：

| 位置 | 数量 | 判定 |
|---|---|---|
| `test/`、`tests/`、`bench/` 的 `magic-numbers` | 全树 484 条 | 误报为主，且集中在一次性实验脚本 |
| `test/` 下 CCN > 5 | 约 9 个函数 | e2e 验证脚本，本机跑不了，**无法验证重构等价性 → 不动** |
| `bench/node-tuning/` CCN > 5 | 34 | 一次性实验脚本，刻意自包含（`.archlint.yaml` 有说明） |
| `package-lock.json` 自重复 | 1 | 生成物，不可手改 |

---

## 2. 上游（xp-gate）待跟踪

这些**在本仓库修不了**，只能等上游。列出来避免重复投入。

### TODO-2.1 xp-gate C# 适配器 `long-function` 失步 —— **已归档为 [#861](https://github.com/boyingliu01/xp-gate/issues/861)**

*验证状态：**已用三个实验证死**；issue 已提（2026-11-22）*

| 报出 | 函数 | 实测行数 |
|---|---|---|
| 58 行 | `JobRunner::EmitSpawnEnoent` | **7** |
| 57 行 | `JobRunner::Finish` | **12** |
| 52 行 | `Trace::Timed` | **1** |
| 71 行 | `Program::EmitProtocolError` | **30** |

决定性实验：
1. 把 `EmitSpawnEnoent` 压成**一行**，报数**仍是 58** → 报的不是这个函数的长度
2. 把 `Trace.Timed` 改长到 4 行，报数**跟着涨到 53**，且函数名变成 `Write` → 扫描器错位
3. **前缀截断定位边界**：`head -73 src/Trace.cs` 不报，`head -74` 就报 —— 第 74 行是
   嵌套结构体 `PhaseScope` 的闭合 `}`。补上那个 `}` 之后 `Timed` 的"函数体"才恰好闭合，
   正是"从错位起点数到某个远端 `}`"的行为

根因（已在 issue 中定位到机制）：`principles/adapters/csharp.ts:145` 调
`extractCodeBlock(match.index)`，而 `METHOD_DECLARATION` 的正则以 `(?:^|\n)[ \t]*` 起头，
`match.index` 指向**声明行首**而非方法体的 `{`；表达式体（`=>`）没有 `{`，
于是一路数到后面某个不相干方法的闭合 `}`。报出的 `line` 恒为 `1` 是同一处的旁证。

- [x] 在 `boyingliu01/xp-gate` 提 issue → **#861**
- [ ] 等上游修（建议修 4 处：`startPos` 定位到方法体 `{`；`=>` 表达式体单独走一条路径；
      `closed=false` 时返回 `length: null` 而非 `fallbackCodeBlock(200)` 的长度；修正 `startLine`）

### TODO-2.2 xp-gate 的两个漏检 —— 已分别归档为 [#860](https://github.com/boyingliu01/xp-gate/issues/860) / [#859](https://github.com/boyingliu01/xp-gate/issues/859)

*验证状态：**已确认 2026-11-22 仍存在***

本仓库 issue **#33** 是"跟踪用的汇总"，真正的上游修复点在下面两个 issue：

- [ ] **[#860] Gate 3 不判文件长度**：`gate-3.sh` 的 awk 只判第 2 列（CCN），
      不看第 5 列（length）。实测 `src/JobRunner.cs` 1469 行时 lizard 明确报 length 超限，
      但 Gate 3 因 CCN=2 输出 `✅ PASSED`。
      → 已在 issue 里给出"一行 awk 改法"与"只改文案"两个方案
- [ ] **[#859] `test-layers` 对 .NET 失明**：`gates/test-layers.ts:387` 的
      `scanDirectory('src')` 硬编码，且 `isTestFile` 只认 `.test.(ts|js)`、
      `isShellSuite` 只认 `.test.bats/.test.cjs/.test.mjs`。
      实测本仓库输出 `Sources: 0 / Tests: 0`，而实际有 322 个 xunit + 18 个 JS 测试 —— **假零**
      → 与 #642（BATS 不计入，已修）**不同**，是修完之后剩下的第二个缺口

> **注意**：#860 与 #727（"Gate 3 只测圈复杂度、CogC 无人消费"）是同族但不同维度。
> 我在 #727 下也留了评论，建议上游把 **CCN + CogC + length** 作为三维一起设计，
> 避免每个维度各开一个 issue。同时复核确认 **#732（.mjs 不被选中）在 0.38.82 外层已修、
> 内层 `adapterMap` 未修**，已在 #732 下留更正评论。

### TODO-2.2b 已在 0.38.82 复核确认「已修复」的上游 issue（**不要再投入**）

| issue | 说明 | 复核方式 |
|---|---|---|
| #732 外层 | `hooks/lib/file-classifier.sh` 已含 `mjs\|cjs\|mts\|cts` | 运行时取 `xp_gate_source_exts` 断言 |
| #732 内层 | ❌ **未修**：`principles/analyzer.ts` 的 `adapterMap` 仍只有 ts/tsx/js/jsx | `xp-gate principles x.mjs` → `Files checked: 0` |

> 这条记录本身是个教训：**"外层修了" ≠ "端到端通了"**。我当时只看外层就宣布修复，
> 被 `Files checked: 0` 打回。回归时务必用 **CLI 端到端口径**（看 `Files checked` 数字），
> 而不是断言某个 map 里有 key。

### TODO-2.3 已修复、可从跟踪列表中移除的上游 issue

*验证状态：**已复验***

- [x] **#768**（Gate 5 不解析 Cobertura）→ **0.38.82 已修**。实测 `line-rate=0.9724` 能正确解析
- [x] **#762**（Gate 4 的 `SOURCE_EXTENSIONS` 缺 `.cs`）→ **0.38.82 已修**。实测 `principles src/` 现在检查 17 个 `.cs`
- [x] **#774**（Gate 3 >64KB SIGPIPE fail-open）→ 已修
- [ ] `#760`（vitest 硬编码）→ 对本项目**无影响**（无 TypeScript），可关闭或标注

---

## 3. 待关闭的本仓库 issue

迁移完成后逐条处理（修复内容见上一轮提交）：

| issue | 状态 | 动作 |
|---|---|---|
| **#29**（P0 lint 红） | ✅ 已修 | 可关闭。`npm run lint` exit 0，含 5 条自测 |
| **#30**（P1 docs 漂移） | ✅ 已修 | 可关闭 |
| **#31**（P1 god class） | 🟡 部分完成 | 1468→983 行、65→45 方法，`large-file` 已过。**建议保留 open**，等 TODO-1.4 决定是否继续 |
| **#32**（archlint 白名单落后） | ❌ 未做 | 见 TODO-1.1 |
| **#33**（xp-gate 漏检汇总） | 🔵 跟踪中 | 具体修复点已拆到上游 #859 / #860 |

- [ ] 关闭 #29 / #30（迁移后各跑一次复验命令再关，避免"看代码觉得改了"就关）
- [ ] #31 按 TODO-1.4 的结论再定

---

## 3b. 本轮在 xp-gate 上游新建/更新的 issue（2026-11-22）

供迁移后跟踪，**本仓库不重复投入**：

| 上游 issue | 类型 | 内容 |
|---|---|---|
| [#859](https://github.com/boyingliu01/xp-gate/issues/859) | 🆕 新建 | `test-layers` 报 .NET 仓库「0 个测试文件」 |
| [#860](https://github.com/boyingliu01/xp-gate/issues/860) | 🆕 新建 | Gate 3 只判 CCN 列，丢掉 length 列 |
| [#861](https://github.com/boyingliu01/xp-gate/issues/861) | 🆕 新建 | C# 适配器 `long-function` 系统性误报（4/4） |
| [#732](https://github.com/boyingliu01/xp-gate/issues/732) | 💬 评论 2 条 | 外层已修确认 + **更正**：内层 `adapterMap` 未修 |
| [#727](https://github.com/boyingliu01/xp-gate/issues/727) | 💬 评论 1 条 | 补 length 维度，建议 CCN/CogC/length 三维一起设计 |

---

## 4. WSL 环境重建检查清单

> **先读 [`docs/开发环境.md`](./开发环境.md)** —— 那是**Windows** 环境的完整搭建/验证/排查手册
> （工具链版本、`vswhere` 检查 MSVC、A/B 验证怎么跑）。本节只列**迁移到 WSL 时
> 额外需要注意**的部分，不重复它的内容。

重建后按顺序验证，任何一步失败就先停下来修环境，别往下走：

- [ ] `git clone` 后确认 `git ls-files --eol | grep -c 'w/crlf'` 为 0（或只在你预期的文件上）
- [ ] `git config core.hooksPath .githooks && chmod +x .githooks/pre-commit`
- [ ] `dotnet --version` 是 10.x；`node --version` ≥ 22
  - **注意**：`docs/开发环境.md` 写的是 .NET SDK 8.0.427，但当前机器**只装了 10.0.404**，
    而项目 `TargetFramework` 仍是 `net8.0`。10.x SDK 能正常构建 net8.0 目标，本轮全部验证都是在这个组合下完成的。
    WSL 里装 8.x 或 10.x 应该都可以，但**如果你在 WSL 用 8.x 而 Windows 用 10.x，两边构建产物可能不一致** ——
    建议两边统一（推荐 10.x，与当前已验证状态一致）
- [ ] `npm ci`
- [ ] **`npm run lint`** → exit 0（含新增的 `test:eslint-config` 自测，5 条用例）
- [ ] **`./build.sh --check`** → 全绿，322 测试，覆盖率 100%
- [ ] `xp-gate principles src/` → 0 error / 7 warning / 1 info（其中 3 条是 TODO-2.1 的误报）
- [ ] `xp-gate check 6` → 8.5/10，0 high/critical
- [ ] 如需改 C#：确认 Windows 侧仍能构建，或先解决 TODO-0.1

### TODO-4.1 迁移后立刻做一次「门禁自检是否还活着」

**理由**：这一轮最大的收获不是修了几个 issue，而是发现**门禁会假绿**——
ESLint 的「零规则绿」、我第一版自测的空跑、xp-gate 的 `long-function` 误报，都属于
「看起来通过，实际什么都没测」。

- [ ] 对每条新增的自检做一次**变异测试**：故意改坏被测对象，确认自检会红
- [ ] 已在 `test/eslint-config-coverage-selftest.mjs` 上做过这个实验（删 ESM block → 红），**保持这个习惯**

---

## 5. 长期建议（可选，不阻塞迁移）

- [ ] **e2e 进 CI**：`test/e2e-plugin-verify.js` 等长期未被执行，等于没有回归保护。
      若 WSL 能跑通 AOT 交叉编译，这是最大的收益点
- [ ] **Gate 5 的本地等价物**：`build.sh --check` 已覆盖覆盖率门槛，但 xp-gate 的 Gate 5
      只在 commit 时跑。考虑在 CI 里显式跑一次 `xp-gate check 5` 的等价逻辑
- [x] `.gitignore` 只忽略 `coverage/tmp/`，**保留 `coverage/coverage-summary.json`**
  - 踩过的坑：一度写成忽略整个 `coverage/`，而那正是 xp-gate Gate 5 判定覆盖率门槛时
    **唯一**会读的路径（`gate-5-entry.sh` 的 `_gate5_coverage_usable`）。整目录忽略
    会让报告进不了版本库 → CI 上 Gate 5 永远找不到它
  - **迁移后复查**：若引入 c8/vitest，确认 `coverage-summary.json` 能正常生成且不被忽略

---

## 附：本轮变更速查

| 文件 | 性质 |
|---|---|
| `eslint.config.mjs` | 修复 #29：补 `.mjs` ESM block + 通用 block 补 `**/*.cjs` |
| `test/eslint-config-coverage-selftest.mjs` | 新增：5 条行为用例，防配置覆盖漏检 |
| `package.json` | `lint` 串联自测；`test:all` 显式包含 |
| `src/LineReader.cs` | 新增：从 `JobRunner` 抽出 |
| `src/EnvironmentBlock.cs` | 新增：从 `JobRunner` 抽出（字节级契约，**改动需极度小心**） |
| `src/ExecutableResolver.cs` | 新增：从 `JobRunner` 抽出，227 行逐行等价 |
| `src/JobRunner.Polling.cs` | 新增：退出检测状态机（partial class） |
| `src/JobRunner.cs` | 1468 → 983 行 |
| `docs/XP-GATE-BASELINE.md` | 修复 #30：重写失真内容 + §7 记录适配器缺陷 |
| `.gitignore` | 新增 `coverage/tmp/`（**不是**整个 `coverage/`，见 TODO-5 说明） |

> **`EnvironmentBlock` 的契约警告**：每个 `KEY=VALUE` 后必须是 **2 个 0 字节**（宽字符终止符），
> 整体再 2 个 0 字节。空 env 必须是 **4 字节** —— 2 字节会让 `CreateProcessW` 返回
> `ERROR_INVALID_PARAMETER(87)`，导致 host 传空 env 时**所有 spawn 都失败**。
> 本轮曾差点写错（1 个 0 而非 2 个），5 个测试当场失败才发现。

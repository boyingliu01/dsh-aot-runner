# TODO — dsh-aot-runner 待办清单

> **最后核实**：2026-11-23（xp-gate **v0.38.125**）
> **基准提交**：`52c33f6`（0.2.5，已推送到 `origin/main`）
> **工具版本**：xp-gate v0.38.125 / .NET SDK 10.0.404 / Node 22+
> **当前状态**：`build.sh --check` 全绿，335 C# 测试通过，生产源码覆盖率 100%（813/813），
> `npm run lint` exit 0，`principles src/` 0 error。Gate 3 零 CCN 警告，
> Gate 6 archlint 10.0/10（0 smells）。
>
> ## 环境决策（2026-11-23 已定）
>
> **本项目不迁移到 WSL，保留 Windows 开发环境。**
>
> 理由：本项目是 Windows **原生** runner —— `CreateProcessW`、Job Object、
> `ucrtbase.dll` 的 `_get_osfhandle`/`_dup2`、CRT 描述符表注入，全部是 Win32 API；
> 322 个测试里绝大多数要真实 Win32 调用。搬到 Linux 不是"兼容性调整"，
> 而是**换一个项目**。
>
> 连带结论：**Windows 开发环境必须持续保留**，其他项目的 Windows 兼容性
> 也仍然需要它来验证。WSL 只能作为补充，不能替代。
>
> 因此本文件已**删除**原先的「WSL 迁移」章节 —— 那些事项不再适用。
> 若将来真的要评估跨平台，单开一份文档，不要复用这份。

---

## 0. 当前剩余任务总览

2026-11-23 用 xp-gate **v0.38.125** 全量复核后的真实剩余量。

| 类别 | 剩余 | 性质 |
|---|---|---|
| 项目自身技术债 | **3 项** | 可做，全部是低风险清理 |
| 上游 xp-gate 缺陷 | **3 项** | 已归档 #859/#860/#861，**本项目修不了** |
| 待关闭的 issue | **2 项** | #29/#30 已修复待关闭 |
| 有意不动 | 1 类 | 见 §1.6，**不要去改** |
| 可选长期项 | 2 项 | 不阻塞任何事 |

**一句话结论**：没有任何「必须立刻做」的事。剩下的都是「做了更好，不做也不影响」。

### 已确认修复（本轮复核，不需再投入）

- [x] **#29** lint 红 → `npm run lint` exit 0（含 5 条自测）
- [x] **#30** 文档失真 → 已重写，实测数字全部对齐
- [x] **#31** 上帝类 → 1468 → 983 行、65 → 45 方法、`large-file` 已消除（**部分完成**，见 §1.4）
- [x] `.gitignore` 的 `coverage/` 误伤 → 已收窄为 `coverage/tmp/`
- [x] `package-lock.json` 版本漂移 → 已同步到 0.2.5

### 上游已归档、等对方修（**不要在本项目里绕**）

| 上游 issue | 内容 | 本项目实测 |
|---|---|---|
| [#861](https://github.com/boyingliu01/xp-gate/issues/861) | C# 适配器 `long-function` 失步 | 0.38.125 上 **4/4 完整复现** |
| [#860](https://github.com/boyingliu01/xp-gate/issues/860) | Gate 3 只判 CCN 列，丢掉 length 列 | 已复现：1103 行函数被判 `✅ PASSED` |
| [#859](https://github.com/boyingliu01/xp-gate/issues/859) | `test-layers` 对 .NET 报假零 | 已复现：32 个测试文件报 `Tests: 0` |

---

## 1. 本项目自身的技术债

### TODO-1.1 补齐 `.archlint.yaml` 入口脚本白名单（issue #32）

*验证状态：**已确认未做*** —— 2026-11-23 用 0.38.125 复核，白名单仍只有 3 条，
archlint 仍报这 5 个文件为 `Dead Code MEDIUM`。**已逐个确认它们都被真实引用**
（分别被 8 / 8 / 6 / 7 / 10 处引用），确属误报。

- [ ] `bench/load-matrix.cjs`
- [ ] `scripts/check-js-syntax.mjs`
- [ ] `scripts/check-release.mjs`
- [ ] `scripts/contract-branch-coverage.mjs`
- [ ] `scripts/contract-fingerprint.mjs`

**为什么值得做**：archlint 的「死代码」判据是「有没有被 import」，对入口脚本必然误报。
这 5 个文件分别被 `package.json` script、`ci.yml`、`build.sh` 调用（已在 issue #32 逐条核实）。
不补白名单的后果不是"多几条噪声"，而是 Gate 6 的 8.5/10 分数被误报稀释 —— 真问题会被淹掉。

### TODO-1.2 处理两个**真实**的 archlint smell（issue #32）

*验证状态：**已确认未做*** —— 2026-11-23 复核：`summarizeRuntime` 仍在
`contract-branch-coverage.mjs:172`，认知复杂度 16；54 token 重复仍在 `202-209` ↔ `64-72`。

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

### TODO-1.7 `test:coverage` 不产出 Gate 5 需要的 `coverage-summary.json`（**已修**）

**症状**：任何改动都会被 pre-commit 的 Gate 5 拦住：

```
❌ BLOCKED - coverage/coverage-summary.json not found.
   No coverage could be measured, so the 80% floor could not be checked.
```

**根因**：`npm run test:coverage` 原来是 `c8 node --test ...`，而 c8 的**默认 reporter
只有 `text`** —— 它打印到终端，不写文件。Gate 5 要的是 istanbul 格式的
`coverage/coverage-summary.json`，本项目从来没产出过它。

`.gitignore` 第 101 行的注释早就预见到「不能整目录忽略 coverage/」，
但没人注意到那个被保护的文件其实**根本不存在**。

**修复**：`test:coverage` 加上 `--reporter=json-summary`：

```json
"test:coverage": "c8 --reporter=text --reporter=json-summary node --test plugin/test/index.test.js"
```

实测产出：lines 89.48%（门槛 80%）。

**注意**：Gate 5 还有 freshness 检查（mtime 必须晚于本次 hook 启动），
所以**每次提交前都要重跑** `npm run test:coverage`。这是 Gate 5 的设计，
不是本项目的额外要求。

### TODO-1.8 Gate 12 的 `no-eof-newline` 在多语言仓库上报假阳性（**上游缺陷，待归档**）

**症状**：pre-commit 的 Gate 12 报告一批文件缺 EOF 换行，但逐字节验证
全部以 LF（0x0a）结尾：

```
⚠️  Missing EOF newline in:
   - .archlint.yaml  - VERSION  - package.json  ...
```

**已做的验证**：

| 验证 | 结果 |
|---|---|
| `git cat-file blob :<f> \| tail -c 1 \| xxd`，20 个 staged 文件 | 全部 `0a` |
| 在干净仓库里造一个**真**缺换行的文件 | scanner **正确**报出 `c.txt` |
| 用与 hook 完全相同的 `paths` 手工喂 scanner | 输出**空**（无 NOEOF） |
| 在 hook 里插桩，抓真实的 `paths` 与 `_out` | `paths` 与我手工的一致；`_out` 却有 `NOEOF:` |

即：**同一份 scanner、同一份输入，手工跑是空，在 hook 里跑却报错。**
差异只可能来自 hook 的运行环境（`GATE_DIR` 解析、`awk` 版本/locale、
或 `adapters/` 与 `hooks/` 两份实现的交互）—— 已在
`~/.config/xp-gate/` 下确认存在 `adapters/gate-12-file-hygiene.sh`
和 `hooks/gate-entries/gate-12-entry.sh` 两个入口，前者被后者 source。

**影响**：Gate 12 是 **WARN 级、非阻断**，不影响提交。**不要去"修"文件** ——
文件是对的，加/删换行只会让下一次报告换一批文件名。

**下一步**：**已归档为 [#863](https://github.com/boyingliu01/xp-gate/issues/863)**
（2026-11-23）。附了逐字节对照表、干净仓库里"真缺失能被正确报出"的证明、
hook 插桩抓到真实 `paths` 的记录，以及多字节 UTF-8 让 `length($0)+1` 失真的线索。

### TODO-1.9 Gate 6 的架构规则**完全不覆盖 C#**（已知盲区，暂不投入）

**症状**：Gate 6 在 pre-commit 里对 C# 是 SKIP：

```
ℹ️  No arch-csharp.yaml found - skipping C# architecture
⏭️  SKIPPED - C# architecture validation (no config)
```

**澄清一个容易误读的地方**：`archlint .` 单独跑确实报
`🕸️ Nodes: 71` / `10.0/10，0 smells`，但那 **71 个文件全是 JS/TS**。
`src/` 下的 7 个 C# 文件**从来没有被任何架构规则检查过** ——
`@archlinter/cli` 本身不支持 C#，它要的 `arch-csharp.yaml` 本项目也装不出来。

所以「archlint 10.0/10」这个数字对本项目的核心代码**没有意义**，
它描述的是 `scripts/`、`test/`、`plugin/` 那些 JS 部分。

**三个可选方向**：

| 方案 | 成本 | 收益 |
|---|---|---|
| A. 写个空的 `arch-csharp.yaml` 占位 | 低 | **无效且有害** —— archlint 不解析 C#，只会把 SKIP 变成假 PASS |
| B. Roslyn 分析器 + `dotnet format analyzers` 做架构规则 | 中 | 真实有效，能机器化检查组件依赖方向 |
| C. 维持现状，靠领域拆分 + 人工 review | 零 | 当前 `JobRunner` 21 方法、边界清晰，风险可控 |

**当前决策：选 C。**

理由：本轮刚把 `JobRunner` 从 46 个方法降到 21 个，把
`ProcessLauncher`（纯函数、可单测）、`TargetSpawner`（启动编排）、
`RunnerErrors`（错误工厂）拆了出去，**依赖方向目前是人能一遍看清的**。
这时候上 Roslyn 分析器是在给一个已经理顺的结构加机器约束，投入产出不划算。

**触发条件**：如果 `JobRunner` 再长回去（比如回到 30+ 方法），
或者出现新的跨组件耦合，就该上方案 B。**永远不要选 A。**

---

## 2. 上游（xp-gate）待跟踪

这些**在本仓库修不了**，只能等上游。列出来避免重复投入 ——
**尤其避免下一个人再去「修」由误报产生的告警。**

### TODO-2.1 xp-gate C# 适配器 `long-function` 失步 —— **已归档为 [#861](https://github.com/boyingliu01/xp-gate/issues/861)**

*验证状态：**已用三个实验证死**；issue 已提（2026-11-22）*

> **2026-11-23 复测（v0.38.125）：4/4 完整复现，数字一字不差。**
> 已在 [#861 评论](https://github.com/boyingliu01/xp-gate/issues/861#issuecomment-7092628851)
> 补充了复测结果 + 三个触发必要条件的精确刻画。
> **这意味着：这 4 条告警在可预见的将来都会一直在 `principles src/` 里。不要试图消除它们。**

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

*验证状态：**2026-11-23 用 v0.38.125 实测，两个缺陷都还在***

> **本轮亲手复现了 #860**：造一个 1103 行的 C# 函数，`lizard` 明确报
> `!!!! Warnings (cyclomatic_complexity > 15 or length > 1000 ...) !!!!` 且退出码 1，
> 但同一个文件被 Gate 3 判 `✅ PASSED - All functions within complexity threshold (5).`
> —— 因为它只读 CCN 列（该函数 CCN=1）。
>
> **也复现了 #859**：本仓库实际有 32 个测试文件（`test/*.js` 15 个、
> `plugin/test/*.js` 3 个、`tests/*.cs` 14 个）、322 个 xunit 用例，
> 而 `xp-gate test-layers` 输出 `Sources: 0 files / Tests: 0 total`。

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

## 4. Windows 环境的健康检查（每周或大改后跑一次）

> **完整搭建/排查手册见 [`docs/开发环境.md`](./开发环境.md)**（工具链版本、`vswhere` 检查 MSVC、
> A/B 验证怎么跑）。本节只列**日常确认环境没坏**的最小集合。

按顺序跑，任何一步失败先停下来修环境：

```bash
# 1. 工具链在位
dotnet --version            # 需 8.x 或 10.x（当前 10.0.404，构建 net8.0）
node --version              # ≥ 22

# 2. 项目门禁（约 40s）
./build.sh --check          # 期望：全部通过，322 测试，生产源码 100%

# 3. Lint 链（约 10s）
npm run lint                # 期望：exit 0，含 5 条 eslint-config 自测

# 4. xp-gate 门禁
xp-gate principles src/     # 期望：0 error / 7 warning / 1 info
xp-gate check 6             # 期望：8.5/10，0 high/critical

# 5. MSVC 在不在（AOT 链接必需）
"/c/Program Files (x86)/Microsoft Visual Studio/Installer/vswhere.exe"   -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
```

### TODO-4.1 保持「变异测试」的习惯

**理由**：这一轮最大的收获不是修了几个 issue，而是发现**门禁会假绿**：

- ESLint 的「零规则绿」（文件被扫到，但一条规则都没挂）
- 我第一版 eslint 自测**空跑**（删掉配置块它仍全绿，而 `eslint .` 红着 20 条）
- xp-gate 的 `long-function` 误报（报 58 行，实际 7 行）

三者都是「看起来通过，实际什么都没测」。

- [ ] 新增任何自检后，**故意改坏被测对象，确认它会红**
- [x] `test/eslint-config-coverage-selftest.mjs` 已做过（删 ESM block → `AC-EC-1b` 红）

### TODO-4.2 临时探针文件必须清理

**踩过的坑（本轮）**：为验证 Gate 3 缺陷，我造了一个 1100 行的 `.tmp-BigProbe.cs`。
`.tmp-*` 被 `.gitignore` 挡住 → `git status` 里看不见 → 我以为删干净了，
但它**留在磁盘上**，被 `dotnet format` 扫到，`build.sh --check` 直接 FAIL。

- [ ] 造探针文件时优先放**仓库外**（或 `%TEMP%`）
- [ ] 必须放仓库内时，用完立刻 `rm`，并跑一次 `build.sh --check` 确认恢复

---

## 5. 可选长期项（不做也不影响任何事）

- [ ] **e2e 进 CI**：`test/e2e-plugin-verify.js` 等长期未被执行，等于没有回归保护。
      本机缺 VS C++ `link.exe` 跑不了 AOT，但 **GitHub Actions 的 `windows-latest` 有**
      —— CI 里的「Windows 构建 + A/B」job 已经在跑 AOT，可以考虑把 e2e 也挂上去
- [ ] **`docs/开发环境.md` 的 SDK 版本过期**：写的是 8.0.427，实际是 10.0.404。
      不是错误（10.x 能构建 net8.0），但读者会困惑，值得补一句说明

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

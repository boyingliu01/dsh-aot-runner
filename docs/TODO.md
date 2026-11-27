# TODO — dsh-aot-runner 待办清单

> **最后核实**：2026-11-26（xp-gate **v0.38.126**）
> **基准提交**：`a50f774`（0.2.8，已发布到 npm + GitHub Release）
> **工具版本**：xp-gate v0.38.126 / .NET SDK 10.0.404 / **Node 22（CI 与基线口径）**
> **最新发布**：**`v0.2.8` 已发布**（npm `latest` = 0.2.8，GitHub Release 含 4 个资产）。
> 0.2.5/0.2.6/0.2.7 从未发版，内容合并进 `docs/RELEASE-NOTES-0.2.8.md`（DR-003：
> 不补造假的历史 tag）。
>
> **当前状态**：`build.sh --check` 全绿，**340** C# 测试通过（连续 5 次全量、0 崩溃），
> 生产源码覆盖率 100%（878/878），`npm run lint` exit 0，`principles src/` 0 error。
> Gate 3 零 CCN 警告，Gate 6 archlint 10.0/10（0 smells）。
> main CI 与 Release workflow 均绿（CI 最新 run 在 `1ab1024` 上通过）。
>
> **2026-11-26 质量自查结论**：内部与外部质量均已达标，遗留项见 §1。
> 自查中发现并修掉三处**本轮引入**的回归（`build.sh`/`test:all` 在 Node 26 开发机上
> 恒红、`measureOnce` 89 行），另修正 README 三处失真（测试数、A/B 用例数、性能表口径）。
>
> **0.2.8 变更（2026-11-25）**：
> - 契约分支覆盖率**已从「报告」升级为「门禁」**（issue #35 §三C）——
>   `--check` 四态退出码 0/1/3/4，基线 `.contract-coverage.json` 绑定契约 sha256。
>   所以下面 TODO-1.1/TODO-1.2 里「它只是入口脚本/只是复杂度问题」这类描述
>   已不完整：它现在**有判据**，改动它会同时影响门禁行为。
> - `IpcReaderTests` 的 CLR fail-fast（`0x80131506`）已修：根因是断言
>   `thread.IsBackground` 时线程已结束，.NET 8 会为此启动 Thread 类的静态 GC
>   辅助线程并抛 `ThreadStateException`。修后连续 10 次单跑 + 5 次全量 0 崩溃。
> - `test:all` 里的 `./build.sh` 改为 `bash ./build.sh`：在 Windows 上经 `npm run`
>   （走 cmd.exe）无法执行 `./build.sh`，整个 `test:all` 因此从来没在本机跑通过。
> - `test/archlint-whitelist-selftest.mjs` 的候选集正则补上 `.cjs`：
>   否则 `scripts/sync-version.cjs` 稳定误报「白名单指向不存在的脚本」。
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
| 项目自身技术债 | **0 项** | 2026-11-26 复核：原 3 项 → 2 项前提消失、1 项实测已完成 |
| 上游 xp-gate 缺陷 | **4 项** | 已归档上游；**本项目修不了**（第 4 项为 2026-11-26 新发现，见 §2.4） |
| 待关闭的 issue | **2 项** | #29/#30 已修复待关闭 |
| 有意不动 | 1 类 | 见 §1.6，**不要去改** |
| 可选长期项 | 2 项 | 不阻塞任何事 |

**一句话结论**：项目内部已无待办技术债，剩余全部是「上游缺陷（修不了）」或「有意不动」。

> **2026-11-26 本轮实际推进的内容**（详见 §1.9 与 CHANGELOG）：
> 1. 复核 3 项技术债前提 → 全部不成立（见下）
> 2. **发现并修复**：补丁工具只认一代上游写法，升级 DSH 后会静默失效
>    → 改为形态表 + 新增 7 项测试（已接入 `test:all`），在真实 `0.2.3-alpha.2` 上端到端验证
> 3. **补强记录**：xp-gate #861 恶化（4→9 条）、新发现 JS 侧同类误报（TODO-2.2c）
>
> **2026-11-26 复核结论**：原先记的 3 项「项目自身技术债」逐项实测后全部不成立 ——
> TODO-1.1、TODO-1.2 的 archlint 判据在工具当前版本下不再触发（`summary.dead_code = 0`、
> `high_cognitive_complexity_functions = 0`、`code_clones` 不再产出），TODO-1.3 早已实现
> 且在本次改动中**真实拦住了一个漏登记的新入口脚本**。
>
> 教训：**过期待办比没有待办更误导人。** 每次开工前应先复核待办的前提是否还成立，
> 而不是照着清单直接做 —— 否则会为一条已经检不出来的告警去重构门禁脚本，风险大于收益。

### 已确认修复（本轮复核，不需再投入）

- [x] **#29** lint 红 → `npm run lint` exit 0（含 5 条自测）
- [x] **#30** 文档失真 → 已重写，实测数字全部对齐
- [x] **#31** 上帝类 → 1468 → 983 行、65 → 45 方法、`large-file` 已消除（**部分完成**，见 §1.4）
- [x] `.gitignore` 的 `coverage/` 误伤 → 收窄为 `coverage/tmp/`
  （**2026-11-26 修正**：这条两年来反复被改错两个方向，现在的结论是
  「`coverage/coverage-summary.json` 必须**在版本库**、其余 `coverage/` 内容忽略」。
  依据：xp-gate Gate 5 读它判 80% 地板，文件不存在直接 BLOCKED；
  而 CI 的「误提交构建产物」曾把它整目录判红。两侧诉求互斥，最终让 CI 让步。
  详见 `.gitignore` 的注释与 `test/coverage-summary-slot.test.mjs`。）
- [x] `package-lock.json` 版本漂移 → 已同步到 0.2.5

### 上游已归档、等对方修（**不要在本项目里绕**）

| 上游 issue | 内容 | 本项目实测 |
|---|---|---|
| [#861](https://github.com/boyingliu01/xp-gate/issues/861) | C# 适配器 `long-function` 失步 | 0.38.125 上 **4/4 完整复现** |
| [#860](https://github.com/boyingliu01/xp-gate/issues/860) | Gate 3 只判 CCN 列，丢掉 length 列 | 已复现：1103 行函数被判 `✅ PASSED` |
| [#859](https://github.com/boyingliu01/xp-gate/issues/859) | `test-layers` 对 .NET 报假零 | 已复现：32 个测试文件报 `Tests: 0` |

---

## 1. 本项目自身的技术债

### TODO-1.1 补齐 `.archlint.yaml` 入口脚本白名单（issue #32）—— **前提已消失，2026-11-26 复核**

*验证状态：**不需要做了*** —— archlint 现在**不再**把这 5 个文件报为 Dead Code。

2026-11-26 实测（archlint 当前版本）：
- 对被列出的 5 个文件名逐个 grep 完整输出：**各 0 次提及**
- `--format json` 的 `summary.dead_code = 0`、`dead_symbols = 0`、`smells = []`
- 分数 **10.0/10**

> 注意别被规则扫描行骗了：console 里那行 `↳ Dead Code found: 48` 是**扫描计数**
> （尝试匹配了多少处），不是告警数。判据看 `summary.dead_code`。
>
> 保留这一段而不是直接删掉，是因为它记着一条仍然成立的经验：
> **「白名单里没登记」≠「会被报错」**，工具行为会变，过期待办比没有待办更误导人。

下面这份 2026-11-23 的原始记录留作对照（当时确实成立）：

- [x] ~~`bench/load-matrix.cjs`~~（2026-11-26 复核：不再被报）
- [x] ~~`scripts/check-js-syntax.mjs`~~（2026-11-26 复核：不再被报）
- [x] ~~`scripts/check-release.mjs`~~（2026-11-26 复核：不再被报）
- [x] ~~`scripts/contract-branch-coverage.mjs`~~（2026-11-26 复核：不再被报）
- [x] ~~`scripts/contract-fingerprint.mjs`~~（2026-11-26 复核：不再被报）

**为什么值得做**：archlint 的「死代码」判据是「有没有被 import」，对入口脚本必然误报。
这 5 个文件分别被 `package.json` script、`ci.yml`、`build.sh` 调用（已在 issue #32 逐条核实）。
不补白名单的后果不是"多几条噪声"，而是 Gate 6 的 8.5/10 分数被误报稀释 —— 真问题会被淹掉。

### TODO-1.2 处理两个**真实**的 archlint smell（issue #32）—— **前提已消失，2026-11-26 复核**

*验证状态：**不需要做了*** —— 两个 smell 在 archlint 当前版本下都不再报告。

2026-11-26 实测（`npx archlint --format json`，`files_analyzed: 80`）：
- `high_cognitive_complexity_functions = 0`
- `code_clones` / `long_parameter_lists` 在 summary 里**均为 None**（规则不再产出）
- 全 summary 只有 `architecture_grade`（10.0）和 `files_analyzed` 两个非零项

另手工复核 `summarizeRuntime`：函数体内分支点（`if`/`?`/`&&`/`||`/`for`/`while`）
**共 5 处**，与「认知复杂度 16」的记录已经对不上 —— 说明这段代码在此期间被改写过，
或原记录的口径与现在的实现不同。

- [x] ~~`summarizeRuntime` 认知复杂度 16 → 拆分~~（2026-11-26 复核：实测 5 个分支点，不触发）
- [x] ~~54 token 重复 → 抽公共小工具~~（2026-11-26 复核：`code_clones` 不再产出）

> **没做的理由不是「不值得」，而是「判据不成立了」。** 为一条已经检不出来的告警去
> 重构两个门禁脚本，风险大于收益 —— 这两个文件的任何改动都会影响门禁行为（见本文件顶部警告）。

> 注意：这两个脚本是「契约漂移检测」的两半，抽公共函数是**合理**的，
> 不会像 `bench/` 那样破坏实验自包含性。`.archlint.yaml` 里对 `bench/` 的豁免理由不适用于它们。

### TODO-1.3 给白名单加防漂移自检（issue #32 建议 3）—— **已完成**

*验证状态：**已实现并于 2026-11-26 实测生效*** —— `test/archlint-whitelist-selftest.mjs`，
挂在 `npm run test:archlint-whitelist`（`test:all` 里会跑）。

**它不是「写了就算完成」，而是真的拦住过我：** 本轮新增
`scripts/contract-coverage-local.mjs` 后，`test:all` 报

```
FAIL  1 个被引用的入口脚本不在白名单里：
        scripts/contract-coverage-local.mjs
```

补进 `.archlint.yaml` 后转 PASS（候选 12 个 / 白名单 11 条，且无僵尸条目）。
这条自检的判据是「有没有被 import」，覆盖 `package.json`、`build.sh`、`ci.yml`、
`README.md`、`.githooks/*` 与所有源码目录 —— 比原始设想（只扫 3 处）更宽。

- [x] 扫描脚本，若既不在 `package.json` / `ci.yml` / `build.sh` 里则提示 —— 已实现，见上

**理由**：白名单承诺「保证将来真新增的孤儿模块仍会被检出来」，但这个承诺已经失效过一次
（3 条白名单 vs 5+ 个入口脚本）。靠人记得补是不可靠的，要机器盯。

### TODO-1.4 JobRunner 拆分（issue #31）—— **已完成（0.2.7）**

*验证状态：**已完成，`xp-gate principles src/JobRunner.cs` 零违规***

| 指标 | 起点 | 0.2.6 | **0.2.7** | 阈值 |
|---|---|---|---|---|
| `src/JobRunner.cs` | 1468 行 | 493 行 | **约 460 行** | 1150 |
| `god-class` 方法数 | 65 | 21 | **15** | 15 ✅ |
| `large-file` | 超 | 过 | 过 | 1150 |
| `long-function` | 4 条 | 0 条 | **0 条** | 50 |
| `too-many-params` | 1 条 | 0 条 | **0 条** | 7 |

**0.2.7 抽出的 5 个类**（每个对应一条真实职责边界，不是为凑数字）：

| 新类 | 职责 | 独立理由 |
|---|---|---|
| `IpcReader` | 读通道 → inbox 后台线程 | 并发边界。不变量：无论 EOF 还是读异常，inbox 恰好收到一个 `null` |
| `MessageType` | 一行 JSON 的 `type` 解析 | 纯函数；返回 error 而非回调，避免与传输层绑死 |
| `StartRequestParser` | start 请求解析 | 前置条件写进注释，不留永不进入的分支 |
| `ResourceReleaser` | §8/§9 释放顺序 | 顺序是协议契约，独立后只有一处可读 |
| `PollerLauncher` | §7 轮询线程启动 | — |

**合并的重复**：`Finish` 与 `OnDisconnect` 原是两份逐字相同的骨架（加锁 → 判重 →
置 finished → 释放资源），只差一个 `ExitCode`。合并为 `Finish(int? exitCode = null)`。

> ⚠️ **踩过的坑**：内联 `HandleEof` 会让 `PumpMessages` 的 CCN 从 5 升到 6。
> **方法数门禁和复杂度门禁会互相拉扯** —— 只看其中一个会把另一个推红。
> 每次改完都要同时跑 `xp-gate principles` 和 `lizard -C 5`。

> **重要**：`xp-gate principles src/` 仍报的 8 条 `long-function`（`EmitProtocolError`
> 实际 29 行报 71 行、`Trace.Timed` 根本不存在却报 52 行、`TargetSpawner` 最长函数
> 实际 27 行报 59~373 行）是 **xp-gate #861 的测量失步，不是技术债**。
> 详见 `docs/XP-GATE-BASELINE.md` §7。**不要去"修"它们。**

### TODO-1.5 `NdjsonChannel` 的 `solid.dip` 告警 —— **已失效，且失效方式值得记录**

*验证状态：**2026-11-27 复核：该告警已不再出现，但它是"规则不再报"，不是"问题已解决"***

原记录（xp-gate v0.38.82 时期）：

```
⚠ [WARNING] solid.dip  line 38: Direct instantiation detected: new LineReader()
```

**本轮复核结论（xp-gate v0.38.126）：**

1. 跑 `xp-gate principles src/`，21 条规则里**没有** `solid.dip` 的任何输出。
2. 为确认是「规则不再报」还是「代码变好了」，我造了一个**必然触发**的探针
   （`src/DipProbe.cs`，含 `_r = new LineReader(...)`），单独跑该文件 ——
   结果仍是 `✓ No violations found`。**探针已删除，`git status` 确认干净。**
3. 所以：`solid.dip` 这条规则对 **C# 已经不生效**，而它的输出形态是
   **`✓ No violations found`** —— 与「真的没问题」在视觉上无法区分。

> **这与 `archlint` 的「Found 0 files to analyze」是同一类假绿**：
> 工具对 C# 失明，却用「通过」的措辞汇报。`.archlint.yaml` 顶部第 12 行
> 其实已经诚实写了「只分析 JS/TS，不解析 C#」，但 `xp-gate` 这一侧没有。

**因此原待办的两条都不需要做了**：
- ~~评估是否应该注入 `LineReader`~~ —— 它的注入路径**早就存在**：
  `NdjsonChannel(Stream input, Stream output)` 是测试专用构造，
  且 `SmallFileCoverageTests` 已用它覆盖了读一行/多行/EOF/Send-flush 四种情形。
  原待办的前提（"没有注入路径"）本身就不成立。
- ~~若是误报则豁免~~ —— 无需豁免，规则已不报。

**真正该记的是**：C# 项目里依赖 `xp-gate`/`archlint` 的架构类告警时要当心 ——
它们可能压根没在分析 C#。判据：造一个必然违规的探针，看它是否报。
不报就是工具盲区，不是代码干净。（已记入 `docs/XP-GATE-BASELINE.md` 的限制清单。）

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

### TODO-1.10 Gate 0 的版本扇出只暂存仓库根 `package.json`（**已修，0.2.7**）

*验证状态：**已修复并端到端验证***

**症状**（0.2.7 提交时真实踩到两次）：

1. 改生产源码提交，Gate 0 拦下并提示：

   ```
   ERROR: Committing production source to a protected branch without a VERSION/CHANGELOG update.
   Run the fan-out to repair them:
     node scripts/sync-version.cjs
   ```

   照着执行 → `Cannot find module 'D:\...\scripts\sync-version.cjs'`。

2. 补上该文件后，Gate 0 的自动扇出**报 PASSED**，但实际只暂存了仓库根的
   `package.json` —— `plugin/package.json` 与 `package-lock.json` 被改了却没进暂存区。
   下一次提交才因为版本漂移被拦下。

**根因**：`gate-0-entry.sh:166` 只在 `scripts/sync-version.cjs` 存在时才自动扇出，
**但 :362-363 的报错文案是无条件打印的**；而它的暂存清单是写死的路径
（`package.json`、`src/npm-package/**`），不认识本仓库的 `plugin/package.json`。

**修法**（全部在项目侧，不改上游钩子）：

| 文件 | 作用 |
|---|---|
| `scripts/check-version.mjs --sync` | 以 `VERSION` 为准写齐 4 处（含 `package-lock.json` 的**两个** version 字段），幂等 |
| `scripts/check-version.mjs --staged` | 抓「已同步到磁盘但没暂存」的文件，直接给出 `git add ...` 命令 |
| `scripts/sync-version.cjs` | 适配层，把名字对齐到 xp-gate 期望的，逻辑仍只有一份 |
| `test/check-version-verify.js` | 7 个测试，在临时仓库里跑，重点覆盖失败分支 |
| `npm run sync:version` / `check:version` | 手工入口 |

**端到端验证**（真实提交，非模拟）：

```
🔄 Gate 0: VERSION staged — running sync-version to fan out...
✅ PASSED - Gate 0: Version Consistency Check
```

**踩过的坑**：临时仓库里跑 `git commit` 会触发全局 pre-commit 钩子，
13 道门禁在空仓库上必然失败、耗时 20s。测试里必须传 `-c core.hooksPath=`。

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

## 1.9 【重要】上游 subprocess 层重构：补丁锚点已失效（2026-11-26 核查）

**这条不是「待办」，是「决策输入」** —— 下次升级 DSH 前必须知道。

### 实测结论

拿上游三个版本解包对比（`npm pack @deepseek-ai/dsh-subprocess-local@<ver>`）：

| 版本 | 契约文件 | `launch*` 是否漏传 `internals` | 我们的补丁锚点是否匹配 |
|---|---|---|---|
| `0.2.0-rc.2`（**本机在跑**） | `runner-launch-B2zsQ1Dz.js` | ❌ 漏传 | ✅ 匹配（已打） |
| `0.2.2-rc.5` | — | ❌ 漏传（`index.js:1574`，写法同下） | ❌ 不匹配 |
| `0.2.3-alpha.1`（#34 记录） | — | ❌ 漏传（`index.js:1574`，写法同下） | ❌ 不匹配 |
| `0.2.3-alpha.2`（**上游最新**） | `runner-launch-2f_K_dxk.js` | ❌ **仍漏传** | ❌ **不匹配** |

**三个版本（0.2.2-rc.5 / 0.2.3-alpha.1 / 0.2.3-alpha.2）的这一行完全相同**，
连行号都是 1574 —— 说明这段代码从 0.2.2-rc.5 起就没动过。

`0.2.3-alpha.2` 的实际代码（`lib/index.js:1574`）：

```js
handle = bindManagedProcess(spec, linuxScope === void 0
  ? launchWindowsJob(spec, env)
  : launchLinuxScope(spec, env, linuxScope.literalArgv), binding);
```

两个 `launch*` 的签名**都接受** `internals`（`launchWindowsJob(spec, targetEnv, internals = {})`、
`launchLinuxScope(spec, targetEnv, literalArgv, internals = {})`），而**调用处一个都没传**。
`internals.runnerInvocation ?? spawnRunnerInvocation()` 在这种情况下永远走后者 ——
即永远选内置 Node runner，插件不生效。**缺陷性质与 0.2.0-rc.2 完全相同，只是换了写法。**

### 对补丁的影响

`vendor/patch-dsh.mjs` 的锚点是这段（原文）：

```js
containmentMode === "linux-scope" ? launchLinuxScope(spec, env) : launchWindowsJob(spec, env)
```

上游现在写成了 `linuxScope === void 0 ? launchWindowsJob(spec, env) : launchLinuxScope(spec, env, linuxScope.literalArgv)`。
变量名（`containmentMode` → `linuxScope`）、分支方向、`launchLinuxScope` 的参数个数全变了，
**锚点匹配不上，`apply` 会失败**。

### 结论

1. **不要急着升级 DSH 到 0.2.3-alpha.x** —— 升了插件就要重做补丁，而且 alpha 通道本就未稳定。
2. 若将来要升级，需要同步改 `vendor/patch-dsh.mjs` 的锚点，并**重新验证 53 项 A/B 一致性**。
3. **阻塞 A（上游 discussion #11893）依然成立**：上游三个版本都没修这个缺陷。
   但可以补一条新证据 —— 上游在重构时**保留了 `internals` 参数、却依然没传**，
   说明这不是「忘了加参数」，而是**那条代码路径没被测试覆盖到**。
   建议在 #11893 下补这个观察（比单纯说「还是坏的」更有说服力）。

- [x] ~~网络恢复后，把上表与 `index.js:1574` 的实际代码补到 discussion #11893~~
      —— **已完成（2026-11-27 07:47 已在 #11893 发出证据回复）**：
      含生产路径 A/B 实测（59.1%~59.6%，p99 改善 73~124ms）、
      对 `aturzone@ab42e3b983` 的背书、以及最小 patch 形态。

      > **行号口径澄清（本轮核实）**：`1574` 是**打包产物**（`lib/index.js`）的行号，
      > 在 `@0.2.3-alpha.2` 上实测准确（`launchWindowsJob(spec, env)` 恰在该行）；
      > 而已发评论引的是**源码**行号（`src/index.ts:215/217`）。两者是同一缺陷的
      > 两个视角，引用时务必说明是哪个文件 —— 混淆会让人找不到代码。
- [ ] 若决定升级 DSH，改补丁锚点 + 重跑 A/B（**不要只改锚点就宣布可用**）

## 2. 上游（xp-gate）待跟踪

这些**在本仓库修不了**，只能等上游。列出来避免重复投入 ——
**尤其避免下一个人再去「修」由误报产生的告警。**

### TODO-2.1 xp-gate C# 适配器 `long-function` 失步 —— **已归档为 [#861](https://github.com/boyingliu01/xp-gate/issues/861)**

*验证状态：**已用三个实验证死**；issue 已提（2026-11-22）*

> **2026-11-23 复测（v0.38.125）：4/4 完整复现，数字一字不差。**
> 已在 [#861 评论](https://github.com/boyingliu01/xp-gate/issues/861#issuecomment-7092628851)
> 补充了复测结果 + 三个触发必要条件的精确刻画。
> **这意味着：这 4 条告警在可预见的将来都会一直在 `principles src/` 里。不要试图消除它们。**
>
> **2026-11-26 复测（v0.38.126）：仍在，且显著恶化 —— 4 条变 9 条，报数涨了约 6 倍。**
>
> | 函数 | 2026-11-23 报数 | **2026-11-26 报数** | 实测行数 |
> |---|---|---|---|
> | `EmitSpawnEnoent` | 58 | **373** | 7 |
> | `EmitProtocolError` | 71 | 71 | 30 |
> | `Finish` | 57 | **364** | 10 |
> | 新增：`EmitCreateProcessError` | — | **370** | 17 |
> | 新增：`PublishControlMissingError` | — | **367** | 50（边界值） |
> | 新增：`TargetSpawner` / `ResolveControlHandle` / `DefaultResolveControl` | — | 59 / 60 / 55 | — |
>
> **新证据推翻了一个自然假设**：报数**不是**「到文件末尾的剩余行数」。
> `EmitSpawnEnoent` 所在的 `src/JobRunner.Results.cs` **全文只有 129 行**，
> 从该函数（第 54 行）到文件末尾只有 **75 行**，而工具报 **373 行** ——
> **报数跨越了文件边界**，比原先估计的更严重。
>
> 为什么涨这么多：2026-11-23 之后项目做过 JobRunner 拆分（0.2.7），
> 文件行数变了，而这个 bug 报的是「从错位起点数到某个远端 `}`」——
> 起点越靠前、远端越远，数字就越大。**文件越小反而报得越大。**
>
> 结论不变：**不要试图消除这 9 条告警**，它们是上游 bug 的直接产物。

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
| #732 内层 | ✅ **已修（2026-11-26 复核）**：`principles scripts/` → `12 files checked` | 看 `Files checked` 是否 > 0 |

> 这条记录本身是个教训：**"外层修了" ≠ "端到端通了"**。我当时只看外层就宣布修复，
> 被 `Files checked: 0` 打回。回归时务必用 **CLI 端到端口径**（看 `Files checked` 数字），
> 而不是断言某个 map 里有 key。

### TODO-2.2c TS 适配器把「多行对象字面量」误报成长函数（2026-11-27 **已提上游 #890**）

*验证状态：**已实测复现；已提上游 → [#890](https://github.com/boyingliu01/xp-gate/issues/890)**，
并在 #861 下留了交叉引用（用「结构微调后长度不变」做回归断言，不需最小复现）*

**症状**：`npx xp-gate principles scripts/` 报

```
line 709: Function "s" is too long: 84 lines (maximum: 50)
```

> 行号随时间漂移（原记录是 667，文件增长后现为 709）。**不要按行号找代码，按函数名找。**


而 `unmeasuredReport` 实际只有 **13 行**。被报的是它 `return { ... }` 里的对象字面量，
`"s"` 在源码中**不存在**（该文件里没有名为 `s` 的函数 —— 已逐个函数名核对过）。

**与 [#861](https://github.com/boyingliu01/xp-gate/issues/861) 不是同一个 bug**：
#861 是 **C# 适配器**（`csharp.ts:145` 的 `extractCodeBlock` 错位）；
这条是 **JS/TS 适配器**对对象字面量的范围判定错误。两者共同点是
「`line` 恒为 1」和「报数远大于实际长度」。

**当前认知边界（不要当成定论）**：
- ✅ 已确认：报的行号跟着对象位置走（在 `return {` 前插一行 → 709 变 710，长度不变）
- ⚠️ **2026-11-27 更正**：原文写「抽成 `const` 不能规避 —— 误报跟着走」，
  **只说对了一半**。取决于 `const` 放在哪一层（三种写法，其余一字不改，均已实测）：

  | 写法 | 结果 |
  |---|---|
  | ① `return { ... }` 内联 | `"s" 84 lines` ❌ |
  | ② **函数内** `const shape = {...}; return shape;` | `"s" **85** lines` ❌（精确跟着走一行） |
  | ③ **模块顶层** `const SHAPE = {...}` + `return { ...SHAPE }` | **不报** ✅ |

  ② 是最有价值的证据：误报精确地跟着声明行走了一行（84→85），
  这排除了「只是长度算错」的解释。
  ③ 能规避，但**不要这么做** —— 那是为哄工具而改变代码结构。
- ❌ **未能**做出最小复现：单独写 `function f(){ return { ...20 个字段 }; }`、
  再加 `try/catch` 前置函数、或把对象键名全部改名，**都不触发**（键名一改告警直接消失）。
  说明触发对内容高度敏感，尚未定位到可独立提交的样例。
- ❌ 所以**不要**据此去重构代码：改了也没用，且会破坏可读性

**本轮的处理方式**：把那次为规避误报而做的「抽成常量」改动**回退了**，
并在代码里写明这是上游缺陷。**不为了哄工具而扭曲代码结构。**

- [x] ~~待网络恢复后向 `boyingliu01/xp-gate` 提交 issue~~ ——
      **已完成（2026-11-27）：[xp-gate#890](https://github.com/boyingliu01/xp-gate/issues/890)**，
      并在 [#861](https://github.com/boyingliu01/xp-gate/issues/861) 下留了交叉引用。

      正文如实包含：三种写法的 A/B 表、**「未能最小复现」的限制说明**、
      以及建议的回归断言形态（「结构微调后长度不变」——它不需要最小复现就能测）。

      > 原计划是「在 #861 下补一条评论」，实际改为**新开 #890**。
      > 理由是：它和 #754 / #861 / #873 是**四处不同代码路径**，
      > 挂在 #861（C# 适配器）下面会让人误以为是同一条的子问题。
      > 独立 issue 才能带完整的复现/实验/限制说明。
      >
      > 写 issue 时还发现原记录有误：「抽成常量不能规避」只在
      > **`const` 放在函数内**时成立；放到模块顶层就不报了（三种写法均已实测）。
      > 已在上面「当前认知边界」里更正。

> **这条记录里最重要的不是 bug 本身，而是那个「抽常量规避 → 实测 → 回退」的过程。**
> 遇到工具误报时，先验证「改法是否真的能让告警消失」，再决定改不改代码。
> 我当时假设抽成常量能规避，实测发现误报跟着走（84→85）—— 如果没验证就提交，
> 会留下一处「为工具而改、且毫无效果」的痕迹。
>
> **2026-11-27 补充一层**：后来发现「函数内 const 不规避」不等于「任何抽提都不规避」——
> 抽到**模块顶层**确实能让告警消失（对象已不在函数体内）。
> 但那仍然**不该做**：让告警消失的原因是「把代码挪出了被误判的范围」，
> 而不是「代码变好了」。**判据应该是「这个问题还存不存在」，不是「告警还在不在」。**

### TODO-2.3 已修复、可从跟踪列表中移除的上游 issue

*验证状态：**已复验***

- [x] **#768**（Gate 5 不解析 Cobertura）→ **0.38.82 已修**。实测 `line-rate=0.9724` 能正确解析
- [x] **#762**（Gate 4 的 `SOURCE_EXTENSIONS` 缺 `.cs`）→ **0.38.82 已修**。实测 `principles src/` 现在检查 17 个 `.cs`
- [x] **#774**（Gate 3 >64KB SIGPIPE fail-open）→ 已修
- [x] `#760`（vitest 硬编码）→ **已关闭（2026-11-27 核实：xp-gate#760 为 CLOSED）**；对本项目本无影响

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

- [x] ~~关闭 #29 / #30~~ —— **已完成（2026-11-27 核实：两者均为 CLOSED）**
- [x] ~~#31 按 TODO-1.4 的结论再定~~ —— **已完成（2026-11-27 核实：CLOSED，JobRunner 已拆分）**

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

> **这是常驻准则，不是待办项**（复选框会让人误以为「做完就不用再管了」）：
> 每次新增自检，都要故意改坏被测对象确认它会红。

- 已执行：`test/eslint-config-coverage-selftest.mjs`（删 ESM block → `AC-EC-1b` 红）
- 已执行：`test/contract-coverage-check-verify.js`（两处变异均擒获，2026-11-27）
- 已执行：`test/coverage-summary-ratchet.test.mjs`（退回旧缺陷 → 立即变红，2026-11-27）

### TODO-4.2 临时探针文件必须清理

**踩过的坑（本轮）**：为验证 Gate 3 缺陷，我造了一个 1100 行的 `.tmp-BigProbe.cs`。
`.tmp-*` 被 `.gitignore` 挡住 → `git status` 里看不见 → 我以为删干净了，
但它**留在磁盘上**，被 `dotnet format` 扫到，`build.sh --check` 直接 FAIL。

> **同样是常驻准则，不是待办项。**

- 造探针文件时优先放**仓库外**（或 `%TEMP%`）
- 必须放仓库内时，用完立刻 `rm`，并跑一次 `build.sh --check` 确认恢复

---

## 5. 可选长期项（不做也不影响任何事）

- [x] ~~**e2e 进 CI**~~ —— **已完成（2026-11-27）**：在 `ci.yml` 的
      「Windows 构建 + A/B」job 里，A/B 之后新增「端到端验证（插件注入 + 真实 runtime）」。
      实测该项本地 2/2 通过后才接入；接入时额外加了两道断言防「跑了但没测到东西」：
      **有 SKIP 即失败**（行内 `# SKIP` 与汇总 `# skipped N` 两个口子都堵）、
      **通过数 < 2 即失败**。断言本身已用变异测试确认会红。
      > 更正一处旧描述：`test:e2e` 其实**一直在 `npm run test:all` 里**，
      > 缺的只是 CI —— 所以本地有保护、CI 没有，正是「本机能过、推送后无人守」的典型缝。
      >
      > **落地过程中又踩了两个坑，都已修（这才是这条真正的价值）**：
      > 1. 步骤里用了 `set -euo pipefail` + `node ... | tee`。pipefail 下只要测试失败，
      >    脚本在 tee 那行就退出，**后面所有断言一行都没执行**。CI 日志里看不到
      >    「通过 N 项」的 echo —— 失败时断言没跑到，成功时它照常打印，
      >    光看绿的日志完全看不出它是摆设。改为手工接 `NODE_RC`。
      > 2. SKIP 一开始被判成失败（导致 CI 因上游未修而长期红），后又改成「通过 + warning」
      >    （补丁失效时会变成假绿）。最终方案是**先在 CI 里给 baseline 打 vendor 补丁**，
      >    再把 SKIP 判红 —— 此时 SKIP 只可能意味着补丁没生效。
      >    **判据取决于前置步骤做了什么，不能脱离上下文照抄。**
      >
      > **2026-11-27 已在 CI 验证**（run on `643e744`，两个 job 均 success）：
      > `winForwarded: true`、`通过 2 项（其中 SKIP 0）；失败 0 项` ——
      > e2e 是**真跑**的，不是跳过。
- [x] ~~**`docs/开发环境.md` 的 SDK 版本过期**~~ —— **已完成（2026-11-27）**。
      实际比「版本号写错」更麻烦：原文写「需要 .NET SDK 8.0」，而本机只装了
      **10.0.404** 且全绿 —— 说明**根本没有 8.0 SDK 也行**。真正固定的是
      csproj 里的**目标框架 `net8.0`**（产物属性），不是 SDK 版本。
      已改为「能构建 net8.0 即可」并补一段说明，避免下一个人照文档去装错 SDK。
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

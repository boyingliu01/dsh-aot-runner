# CHANGELOG

本文件格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.2.8] - 2026-11-25

> **部署确认与本机实测（2026-11-26）**
>
> v0.2.8 已部署到本机 DSH（`plugin/bin/dsh-aot-runner.exe` 重新构建并同步，
> 运行中进程已切换到新二进制）。A/B 一致性 **53/53** 通过。
>
> 性能确认（本机，ABBA 各一轮共四轮，每轮 N=25）：
>
> | 轮次 | CPU | node p50 | AOT p50 | 收益 |
> |---|---|---|---|---|
> | R1 default | 8% | 208ms | 104ms | 57.6% |
> | R1 aot-first | 6% | 208ms | 100ms | 59.7% |
> | R2 default | 14% | 206ms | 101ms | 58.7% |
> | R2 aot-first | 23% | 200ms | 97ms | 59.3% |
>
> 收益 **57.6%~59.7%**（中位 59.0%），正反向差 2.1pp、无系统性偏移。
> 轮内配对差 103~108ms（波动 4.8%），与负载不相关（斜率 −0.21ms/CPU%，
> 负载 +17pp 仅预测 −3.5ms）—— 绝对延迟受负载影响，**配对差几乎不受影响**，
> 所以这四轮虽然跨了 6%~23% 的负载，对比仍然有效。
> 地板（`hostname.exe`）稳定在 27~28ms，进一步确认测法可靠。
>
> 同时给 `bench/d1-ab-bench.js` 加了 `ORDER=aot-first` 开关（ABBA 对照用）。
>

> **发布过程中的三个阻塞（本版自身修掉）**
>
> 这次 v0.2.8 的发布链路本身也踩了三次坑，都属于同一个主题：**检查跑起来了但没检查到东西**。
> 记在这里，因为它们是「门禁可信度」这条主线最直接的证据。
>
> 1. **覆盖率门禁在发布 job 上找不到契约包**（run 45644902561）。
>    包装到了 `baseline/`，而查找逻辑只认 `<仓库根>/node_modules`。
>    ci.yml 早就踩过同一个坑并用 `DSH_RUNNER` 绕开，覆盖率脚本没有这种扩展点。
>    → 查找逻辑增加「仓库内一层子目录」候选。
> 2. **装了包 ≠ 脚本能找到 runner**（run 45721544418）。
>    静态侧修好后，运行时采集仍失败，报「采到了覆盖数据，但没有一个是契约文件」——
>    真实原因是 `launchRunner` 找不到 runner，异常被 `try/catch` 吞掉。
>    → 覆盖率步骤显式传 `DSH_RUNNER`，与相邻的 A/B 步骤用同一个 runner。
> 3. **`coverage/coverage-summary.json` 被两条规则要求相反的状态**。
>    Gate 5 要它**在版本库里**（否则直接 BLOCKED，提交被拦死），
>    CI 的「误提交构建产物」要它**不在**（`git ls-files | grep '^coverage/'`）。
>    两者互斥，导致 main 的 CI 连续两次同一个原因变红。
>    → 让 CI 让步（Gate 5 无替代方案，CI 有）：该文件列为唯一允许进版本库的生成物，
>    其余 `coverage/` 内容仍然拦。
>
> 三个修复各配了测试锁住失效方式（`test/locate-contract-package.test.mjs`、
> `test/coverage-summary-slot.test.mjs`、以及 release.yml 的 `DSH_RUNNER` 断言）。
> 教训统一是：**「配好了」不等于「跑到了」；只验证配置存在、不验证路径通到，等于没验证。**
> 4. **基线没绑 Node 主版本，跨版本比较把发布误判成「覆盖率回退」**（run 45723172229）。
>    矛盾点很刺眼：CI 采到 31.4%，基线是 26.9%，**更高**却被判「分母塌缩」。
>    实测同一份契约文件（sha256 相同、DSH 版本相同）在 Node 26 上是 20/114 函数、
>    43/159 区间，在 Node 22 上是 20/95 函数、42/137 区间 —— **函数总数都不同**，
>    说明不是用例丢了，而是 V8 切块方式变了。本机 Node 26，CI 用 Node 22。
>    → 基线记录 `nodeMajor` 并当身份条件：跨版本判 exit 4（基线过期，重采即可），
>    而不是 exit 1（回退，该补用例）—— 两者补救方向相反。
>    顺带重新标定容差：原极差 129 pp100 是在**混用两个 Node 版本**的采样上算的，
>    把口径差异当成了抖动；Node 22 上重测极差 5 pp100，容差从 2.00pp 收紧到 1.00pp。
>
> **前三个之外最后一个也值得单说**：这三条加上第 4 条，全部是「配置里写了、
> 但路径/口径没通到」。它们的共同盲区是**只验证了中间状态存在**（包装了、步骤在、
> 文件有），没验证**端到端真的到达**。这也是为什么每条修完都配了一个断言
> 锁住那个具体失效方式，而不是只改代码。
>

**主题：让「检查过了」真的等于「检查过了」—— 修好版本号扇出，并把契约覆盖率变成门禁。**

本版两件事：一是修版本号扇出（下面「问题/修法」两节），二是 issue #35 的三项
（见后文「issue #35」）。两项的共同点不是领域，而是**失效模式**：
都是「检查跑起来了、日志很绿、但什么也没检查到」。

### 问题

0.2.7 提交时连续撞了两次：

1. 改生产源码提交，Gate 0 拦下并提示执行 `node scripts/sync-version.cjs`。
   照做 → `Cannot find module`。**这个脚本在本仓库从来不存在。**

2. 把脚本补上之后，Gate 0 的自动扇出报 **PASSED**，但只暂存了仓库根的
   `package.json` —— `plugin/package.json` 和 `package-lock.json` 改了却没进暂存区。
   下一次提交才因为版本漂移被拦。

根因在 `gate-0-entry.sh`：**报错文案无条件打印** `scripts/sync-version.cjs`，
而自动扇出只在文件存在时才跑；且它的暂存清单是写死的路径，不认识本仓库布局。

### 修法（全部在项目侧，不改上游钩子）

| 文件 | 作用 |
|---|---|
| `scripts/check-version.mjs --sync` | 以 `VERSION` 为准写齐 4 处，含 `package-lock.json` 的**两个** version 字段；幂等 |
| `scripts/check-version.mjs --staged` | 抓「已同步到磁盘但没暂存」的文件，直接给 `git add ...` 命令 |
| `scripts/sync-version.cjs` | 适配层，名字对齐 xp-gate 期望，逻辑仍只有一份 |
| `test/check-version-verify.js` | 7 个测试，临时仓库里跑，重点覆盖失败分支 |
| `npm run sync:version` / `check:version` | 手工入口 |

另外修了 ESLint 的一个**配置缺口**：`scripts/**/*.cjs` 原先落到兜底 block，
没有 node 全局变量，`sync-version.cjs` 因此被报 5 条 `no-undef`——那是配置问题不是代码问题。

### 验证

真实提交（非模拟）：

```
🔄 Gate 0: VERSION staged — running sync-version to fan out...
✅ PASSED - Gate 0: Version Consistency Check
```

`--sync` 往返测试：改 `VERSION` → sync → 五处一致 → 再 sync 报「无需改动」（幂等）。
`--staged` 反向测试：只暂存 `package.json` 时，精确报出漏掉的另外两个文件。

### 踩坑

临时仓库里跑 `git commit` 会触发全局 pre-commit 钩子，13 道门禁在空仓库上
必然失败且耗时 20s。测试里必须传 `-c core.hooksPath=`。

### issue #35：契约覆盖率变成门禁

**主题：把一个「报告」变成「门禁」，同时修掉三条让门禁形同虚设的缺陷。**

#### 契约分支覆盖率（§三C：深度短板）

原先 `build.sh` 与 `ci.yml` 都明确写着它「不作为阻塞门禁」，理由是
「版本不同分支数就不同，设死阈值会在 DSH 升级时无端变红」。**那条理由成立**，
所以这次不是设固定阈值，而是换成与内容绑定的基线：

| 文件 | 作用 |
|---|---|
| `.contract-coverage.json` | 基线，记着契约文件 `sha256` + 三个指标 |
| `scripts/lib/contract-coverage-gate.mjs` | 纯判定逻辑，无 I/O，可单测 |
| `scripts/contract-branch-coverage.mjs --check/--update` | 采集 + 判定 |
| `test/contract-coverage-check-verify.js` | 13 个用例，覆盖全部失败分支 |

**四态退出码**：`0` 未回退 / `1` 回退 / `3` 未测得 / `4` 基线缺失或过期。
`3` 与 `4` 必须分开，因为补救方向相反（换环境重跑 vs 重采基线）。

判据用比率而非绝对计数：实测同一契约连跑，区间覆盖数在 42/43/44、
总数在 156/159 之间抖。容差 2.00pp（实测抖动跨度 1.29pp），另设分母下限防「塌缩做高」。

**比门禁本身更值得记的三个缺陷**：

1. **采集崩了也算通过。** `collectOk=false` 时旧版退出码仍是 `0`，
   任何读 JSON 判成败的门禁都会把「没测成」当成「通过」。现在 `3`。
2. **重采中位数把分母塌缩判据绕过了。** 早先为吸收抖动，把 `ranges`
   整个换成合成对象（`total=10000`）—— 结果 `13/40 = 32.5%` 因为「分母塌缩」
   本该判回退，却因为合成出的 `total` 而通过了。
   典型坑：**为了吸收 A 指标的抖动，动手改了承载 B 判据的同一个对象**。
   现在只覆盖 `ratioPp`，`covered`/`total` 保持真实值。
3. **上游 `contract-coverage-selftest.mjs` 把「跳过」当「通过」**，
   而且不是 `node --test` 文件、不被任何 npm script 引用。
   等于**在开发机上失败分支从来没被执行过**，测试却全绿。
   新测试反过来做：用 `node --test`，跑真的脚本子进程，退出码是真实退出码。

#### 发布链路不再静默跳过 npm（阻塞 B）

`release.yml` 的 `permissions.id-token: write` 常开，于是
`if ($env:ACTIONS_ID_TOKEN_REQUEST_URL)` **恒为真**。Trusted Publisher 没配时
`npm publish --provenance` 失败只打 `::warning::`，然后落到「没有 NPM_TOKEN」分支
并 `exit 0` ——**job 全绿、GitHub Release 成功、npm 上什么都没有、零失败信号。**

修法：发布期望由 `github.ref` 自动推导（`refs/tags/vX.Y.Z` 就必须发 npm），
末尾新增「校验 npm 发布结果」步骤，没发出去就失败。**不引入任何人工开关** ——
那只是把「靠人记得」这个缺陷搬个位置（早期设计用过 `NPM_PUBLISH_EXPECTED`，
被评审否掉了）。

新增 `npm run release:precheck`：npm 不允许版本号重用，一旦某版本发过
（哪怕之后 unpublish）就永远不能再用。打 tag 前先查一句，换掉一次不可逆的失误。
网络查不到时是 `exit 3` 而不是 `0` —— 同样的规矩。

#### 两处让 `test:all` 永远跑不起来的缺陷

- **`test:all` 第一个命令是 `./build.sh`**，在 Windows 上经 `npm run`（走 cmd.exe）
  报 `'.' is not recognized`。也就是说这个「两者都过才算绿」的入口
  **在本机从来没跑通过**。改为 `bash ./build.sh`。
- **`archlint-whitelist-selftest.mjs` 的候选集正则不匹配 `.cjs`**，
  导致 `scripts/sync-version.cjs` 稳定误报「白名单指向不存在的脚本」。
  这个文件是 0.2.8 自己加进白名单的 —— 加了反而让自检红着。

#### `IpcReaderTests` 的 CLR fail-fast

测试在断言 `thread.IsBackground` 时线程可能已经结束；.NET 8 上读已死线程的
该属性会启动 Thread 类的静态 GC 辅助线程并抛 `ThreadStateException`，
严重时直接进程退出（`0x80131506`）。

实测：单独跑 6 次有 4 次失败、全量跑 5 次崩过一次 —— **它拦住 pre-commit，
等于拦住每一次提交**。改用「阻塞到测试主动放行」的通道，
并新增负向用例证明线程确实被按住（不是靠无限等待换来的）。
修后 AC-1 10/10、AC-2 5/5、全量 340 测试 5/5 全绿。

#### 本次为什么只打 `v0.2.8`

远端 tag 停在 `v0.2.4`，而 0.2.5/0.2.6/0.2.7 从未发过 Release。
`generate_release_notes` 会把这四个版本混成一锅，且表达不了最要紧的一句：
**0.2.4 上有一个会导致工具调用失败的退出码 bug，请直接升到 0.2.8。**
所以 Release 正文手写（`docs/RELEASE-NOTES-0.2.8.md`），自动列表不再使用。
同时**不补 0.2.5~0.2.7 的历史 tag** —— 那是伪造发布记录（DR-003）。

## [0.2.7] - 2026-11-24

**主题：把 `JobRunner` 的 god-class 告警清零 —— xp-gate principles 对 `src/` 的可修项全部消除。**

### 目标

xp-gate 对 `src/JobRunner.cs` 的两条告警是本次唯一**可修**的项：

```
clean-code.god-class  Class "JobRunner" has too many methods: 21 (maximum: 15)
solid.srp             同上
```

其余 10 条逐条证伪后确认不可修（见下）。

### 抽出的 5 个类，每个对应一条真实的职责边界

| 新类 | 职责 | 为什么值得独立 |
|---|---|---|
| `IpcReader` | 读通道 → 投递 inbox 的后台线程 | 并发边界，不认识 runner 状态。关键不变量：无论 EOF 还是读异常，inbox 都恰好收到一个 `null` |
| `MessageType` | 一行 JSON 的 `type` 解析 | 纯函数。返回 error 而非回调投递，避免与传输层绑死 |
| `StartRequestParser` | start 请求解析 | 前置条件写进注释，不保留永远进不去的分支 |
| `ResourceReleaser` | §8/§9 释放顺序 | 顺序（TerminateJob → CloseJob → CloseProcess）是协议契约，独立后只有一处可读 |
| `PollerLauncher` | §7 轮询线程启动 | — |

### 合并的重复

`Finish` 与 `OnDisconnect` 原本是两份**逐字相同**的骨架（加锁 → 判重 → 置 finished →
释放资源），只差一个 `ExitCode`。合并为 `Finish(int? exitCode = null)`，
「一次终态只清理一次」这个不变量从两条实现变成一条。

### 过程中自己引入、又修掉的两个问题

1. **覆盖率从 100% 掉到 99.4%（873/878）。** `IpcReader` 的异常分支与
   `SpawnTargetHook` 成功分支无人覆盖。后者是**原有缺口**——该 hook 只被
   「抛异常」的用例用过，成功路径从未执行过。
   补 4 个测试后回到 **100%（878/878）**。

2. **内联 `HandleEof` 让 `PumpMessages` 的 CCN 从 5 升到 6**，超出门禁阈值。
   改回独立方法后 CCN 0 警告、方法数同时达标（15）。
   这暴露了一个陷阱：方法数门禁和复杂度门禁会互相拉扯，**只看其中一个会把另一个推红**。

### 结果

| 指标 | 修前 | 修后 |
|---|---|---|
| `src/JobRunner.cs` 违规 | 2 条 | **0 条** |
| `JobRunner` 方法数 | 21 | **15** |
| lizard `-C 5` 警告 | 0 | **0**（167 函数） |
| 测试 | 335 | **339 全过** |
| 生产源码覆盖率 | 100% | **100%（878/878）** |
| archlint | 0 smells / 10.0 | 0 smells / 10.0 |

### 仍然存在、但确认不可修的 10 条

- **8 条 `long-function` 是 xp-gate #861 的失步 bug**：`EmitProtocolError` 实际 29 行被报 71 行；
  `Trace.Timed` 根本不存在却报 52 行；`TargetSpawner` 各函数实际最长 27 行，被报 59~373 行。
  实测 `lizard` 对整个 `src/` 的判定是 **0 条超长函数**。
- **1 条 `too-many-params`（INFO）** 在 `Native.CreateProcessW` —— Win32 ABI 签名，不可改。
- **Gate 6 不覆盖 C#**（`archlint` 不支持 C#，见 `docs/TODO.md` §1.9）。

## [0.2.6] - 2026-11-23

**技术债清零，无对外行为变更。** 335 个测试通过（+12），生产源码覆盖率保持 100%。

本版是对 xp-gate v0.38.125 全量复核后的一次集中清理：凡是「工具报出来的真实问题」
全部修掉，凡是「工具自己报错的」全部归档到上游并写明为什么不要在本仓库绕。

### 变更

- **拆分 `JobRunner` 的启动职责，取出 3 个类。** 46 → 21 个方法：
  - `ProcessLauncher` —— CreateProcessW 的原语（句柄继承开关、STARTUPINFO 构造、
    ResumeThread 判定）。全部 static 纯函数，**首次可以被单独测试**。
  - `TargetSpawner` —— 完整的启动编排（解析 → 构造 → 继承控制 → 起进程 → 入 Job → 放行），
    通过窄接口 `ISpawnHost` 取依赖，不直接摸 runner 字段。
  - `RunnerErrors` —— 协议错误结果工厂。
- **进程句柄改为返回值。** 原先 `LaunchSuspended` 直接写 `_process`/`_thread`/`_targetPid`，
  现在一次性返回 `SpawnedProcess`：「启动成功」有了单一表达点，中间状态不再可见。
- **`ResumeThread` 的判定逻辑统一到 `ProcessLauncher.ResumeSuspendedThread`。**
  此前 `JobRunner` 与 `TargetSpawner` 各有一份实现，只有一份被测试覆盖 ——
  这是覆盖率骗局的经典来源。现在两边共用，变异测试确认两层测试都能抓到。
- **`scripts/` 抽出 `lib/locate-contract-package.mjs`。** `contract-branch-coverage.mjs`
  与 `contract-fingerprint.mjs` 各有一份 54 token 的包查找逻辑。删除重复的同时
  消除了「指纹能算、覆盖率算不了」这种分裂的隐患。
- **`summarizeRuntime` 认知复杂度 16 → 5。** 拆成 `tallyFunction`（一个函数怎么算）
  与 `accumulate`（所有函数怎么汇总）。
- **Gate 3 突破：所有函数 CCN ≤ 5。** 提交时 Gate 3 拦下 6 个高复杂度函数
  （`ResolveStdioHandles` 8、`extractExecutableResolution` 8、`main` 10、
  `diffContracts` 7、`mergeCoverage` 6、`extractStartRequestFields` 6），
  逐个按职责拆分。最终 `lizard -C 5` 的 warning 计数为 **0**。

### 修复

- **`.archlint.yaml` 入口脚本白名单补齐 5 条**（issue #32）。此前白名单停在 3 条，
  而实际入口脚本已有 8 个，导致 5 个文件被报成 Dead Code。archlint 从
  **8.5/10 / 7 smells → 10.0/10 / 0 smells**。
- **新增白名单防漂移自检**（`test/archlint-whitelist-selftest.mjs`，接进 `npm run lint`）。
  双向都能报警：漏登记（被引用但不在白名单）与僵尸条目（白名单里有但指向不存在的文件）。
  已对两个方向各做一次变异测试。
- **新增 `.principlesrc`。** 用规则**自身**的 `solid.dip.exclude` 机制豁免 3 个值对象
  （`LineReader`、`Thread`、`TargetSpawner`），每条都写清了理由。没有放宽任何阈值。
- **补齐 12 个测试**：`ProcessLauncher` 的 `cbReserved2` WORD 上限、句柄有效性、
  ResumeThread 三条支路；`TargetSpawner` 的失败上报路径。

### 发布验证（2026-11-24）

重构后重新构建并本机升级，**85 项验证全过、0 失败**：

| 阶段 | 结果 |
|---|---|
| C# 单元测试 | 335 通过 |
| S0 Node IPC 协议回归 | 全过 |
| S0 真实 host 路径验证 | 全过 |
| 插件单元测试 + 端到端 | 全过 |
| **S4 A/B 验证** | **53/53 通过**（用例从 28 增到 53） |
| S5 零泄漏 / 混沌回归 | 7/7 |
| S3 terminate 竞态回归 | 全过，含 60 轮交替无残留 |

产物：`dist/dsh-aot-runner.exe` 1,402,880 字节，无 VC++ 运行时依赖、无 .NET 运行时依赖。
已同步到 `plugin/bin/`（因原文件被占用，走「改名换位」，issue #23 的机制）。

**这一步为什么重要**：11-11 之后有 636 行从 `JobRunner.cs` 移出，
但生产运行的 exe 一直是 11-11 那份。A/B 53/53 证明重构后的二进制与 node runner
**字节级等价**，闭环了「验证对象 ≠ 交付对象」这个盲区。

### 文档

- `docs/TODO.md` 重写为「剩余任务清单」，删除已不适用的 WSL 迁移章节，
  并按 2026-11-23 的实测结果更新每一条的验证状态。

### 已知但**不做**（工具误报，已在文档中逐条证伪）

- `clean-code.long-function` 报出 8 条，实际最长函数 48 行（阈值 50），
  且被点名的多数是接口声明行 —— xp-gate [#861](https://github.com/boyingliu01/xp-gate/issues/861)。
- Gate 12 `no-eof-newline` 误报：22/22 暂存文件末字节均为 `0a`，仍报告 9 个缺失，
  且清单每次提交都不一样。**已归档为 [#863](https://github.com/boyingliu01/xp-gate/issues/863)**，
  附逐字节对照表与 hook 插桩记录。WARN 级、非阻断。
- **Gate 6 的架构规则不覆盖 C#。** `archlint 10.0/10` 只描述 JS/TS 的 71 个文件，
  `src/` 的 7 个 C# 文件从未被架构规则检查过（`@archlinter/cli` 不支持 C#）。
  已知盲区，当前靠领域拆分 + 人工 review 守住，**不要**用空 `arch-csharp.yaml` 造出假 PASS。
  见 `docs/TODO.md` §1.9。
- `clean-code.god-class` / `solid.srp`：`JobRunner` 21 个方法（阈值 15）。
  剩余方法全部围绕同一份 runner 状态（`_gate`/`_finished`/`_process`），
  再拆需要把这些字段的所有权切碎，收益为负。`JobRunner.Polling.cs` 的作者
  已在文件头论证过为什么 partial 而不是独立类，本版维持该判断。
- `clean-code.too-many-params`（info 级）：`Native.CreateProcessW` 是 P/Invoke 签名，
  参数由 Win32 ABI 决定，不可能改。

## [0.2.5] - 2026-11-22

**内部重构与工具链修复，无对外行为变更。建议升级，但不是必须。**

### 变更

- **拆分 `JobRunner` 的三个独立职责。** 原 `src/JobRunner.cs` 1468 行、65 个方法，
  同时承担「子进程启动」「退出检测」「环境块组装」「可执行文件解析」「行缓冲读取」
  五件事。本次把后三件抽成独立文件（`LineReader` / `EnvironmentBlock` /
  `ExecutableResolver`），退出检测改成 `partial class` 单独成文件
  （`JobRunner.Polling.cs`）。主文件降到 983 行、45 个方法。

  全部为逐行等价搬迁，不改逻辑：`ExecutableResolver` 的搬迁做过脚本化比对
  （227 行完全一致），322 个单元测试全通过。

  另外把 `LaunchProcess` 的 8 个位置参数收敛成 `LaunchPlan` 结构体 ——
  其中 4 个是同源数据（一次启动的完整输入），拆开后调用点看得更清楚。

### 修复

- **`npm run lint` 在 0.2.4 上是红的（issue #29）。** 两个 `.mjs` 自测文件
  不在任何 ESLint 配置块覆盖范围内，导致 `npm run lint` 报 20 条
  `'console' is not defined`。由于 `.githooks/pre-commit` 与 `test:all`
  都以 ESLint 为入口，这等于**项目的全量自查入口是坏的**。

  同时修掉一个更隐蔽的同类问题：`bench/load-matrix.cjs` 落到通用配置块之外，
  **一条正确性规则都没拿到** —— 它仍会被 `eslint .` 扫到，所以不报错、
  不出现在输出里，看起来是绿的，实际什么都没查。

- **新增 `test/eslint-config-coverage-selftest.mjs`。** 5 条行为断言锁住上述两类
  失效模式，已接入 `npm run lint` 与 `test:all`。

  值得记录的是它的判据演进：最初版本只断言「文件有没有被某个带规则的块覆盖」，
  但实测发现**删掉 ESM 配置块后它依然全绿**，而 `eslint .` 同时红着 20 条。
  根因是 `.mjs` 扩展名本身就让 ESLint 按 module 解析，所以「解析模式」不会因
  少一个块而变红 —— 真正丢的是 `NODE_GLOBALS`。判据改为直接断言
  `console`/`process` 是合法全局变量后，变异测试（删块 → 红）才真正生效。

### 文档

- `docs/XP-GATE-BASELINE.md` 重写失真内容（issue #30）：修正了「期望输出：空」
  但实测 39 条的命令、`139 → 322` 单测数、`194 info` 的口径混淆
  （`src/` 实际 8 条，全树 613 条，原文把两个口径混为一谈）、
  覆盖率 `32.6% → 100%`，以及多处「xp-gate 看不见 C#」的过期表述。

- 新增 §7 记录一个**尚未归档到上游**的 xp-gate 缺陷：C# 适配器的
  `long-function` 会报出与真实长度无关的数字（`EmitSpawnEnoent` 实测 7 行报 58 行）。
  附 80 行已验证可复现的最小片段。这解释了 `src/` 剩余 3 条 `long-function`
  告警 —— **它们是误报，不是技术债，不要去"修"**。

- 新增 `docs/TODO.md`：全部待办的整理（含 WSL 迁移前必须决策的事项）。

### 其他

- `.gitignore` 增加 `coverage/`。

---

## [0.2.4] - 2026-11-11

**修复发布：0.2.3 在目标进程退出码 ≥ 2^31 时会报协议错误、导致工具调用失败。建议升级。**

### 修复

- **退出码符号位翻转导致工具调用失败。**
  Windows 的退出码是**无符号** 32 位（`GetExitCodeProcess` 的签名就是 `out uint`，
  取值 0..4294967295），但协议字段声明成 `int`，序列化前又做了一次 `(int)` 强转。
  最高位为 1 时翻成负数：

  | 实际退出码 | 0.2.3 报出的值 |
  |---|---|
  | 2147483648 | **-2147483648** |
  | 3000000000 | **-1294967296** |
  | 4294967295 | **-1** |

  危害不是「数字对不上」。host 侧校验是
  `Number.isSafeInteger(v) && v >= 0`，收到 -1 直接抛
  `subprocess runner emitted an invalid target-exit result` —— **工具调用当场失败**。

  改为 `uint` 全链路。这也顺带说明了为什么 C# 编译器帮不上忙：
  显式数值强转在 `AnalysisLevel=latest-all` 下**一条告警都没有**
  （`(int)uint`、`(byte)int`、`(long)double` 实测均 0 条）。

  这个 bug 曾被一条单测**固化成了契约** ——
  `Serialize_TargetExitResult负数退出码` 构造 `-1` 并断言输出 `"-1"`，
  测试全绿而行为是错的。已替换。

- **Win32 结构体的有符号/无符号错配**（与上一条同源）。
  `STARTUPINFO.wShowWindow` / `cbReserved2` 是 WORD（无符号 16 位），
  却声明成 `short`；`PROCESS_INFORMATION.dwProcessId` / `dwThreadId`、
  `GetFileType` 返回值是 DWORD，却声明成 `int`。
  P/Invoke 的结构体布局虽未因此改变，但符号语义错误会被同一个模式反复踩到。

### 新增

- **强转审计工具**（`tools/cast-audit/`）—— 补上 C# 编译器完全不告警的那一类风险。
  三条规则：无符号→有符号且装不下、窄化截断、有符号可为负→无符号。
  Roslyn 语义分析，能区分 `(int)x`（强转）与 `(int x)`（参数声明）。
  自动放行 `checked(...)`、位掩码、常量表达式、放宽方向。
  豁免注释要求**写明理由**，只写 ignore 不写理由的照常报出。
  已接进 `build.sh --check` 与 CI（含 11 条自测）。

- **契约分支覆盖率**（`scripts/contract-branch-coverage.mjs`）。
  给「53 项 A/B 用例通过」补上分母：实测契约有 293 个静态判定点，
  用例运行时覆盖 27.0% 的分支区间。
  输出区分「本平台跑不到」（POSIX 专属实现）与「可能该补测」，
  避免把结构性不可达误读成测试不足。

### 改进

- **P/Invoke 只从 System32 加载**，消除 21 处 DLL 劫持面（#27）。
- **pre-push 补上 C# 编译检查** —— 在此之前推送路径完全没有编译校验。
- **pre-commit 区分「测试跑不起来」与「测试跑出来是坏的」**：
  CLR 崩溃（单次 2.7%）会重试一次，仍崩才失败，且错误信息明说不是代码问题；
  **测试失败不重试** —— 那是结论，重跑等于筛掉不喜欢的答案。
- **CI 里拿不到契约源时如实报「未检测」**，不再让「没查」看起来像「没问题」。

## [0.2.3] - 2026-11-10

**修复发布：解决插件安装后 `plugin/bin/*.exe` 被占用导致替换失败，以及降级静默失效无感知。建议升级。**

### 新增

- **降级路径可观测**（#18 B）。runner 是纯性能增益：进程挂掉时功能一切正常，
  只是慢 2~3 倍——**不报错、不崩溃、没有任何用户可见症状**。此前这类失效
  只在 `verbose` 日志里，等于没人知道。现在降级会明确告知，并说明「已降级到内联模式」。

- **发布前置校验**（`scripts/check-release.mjs`，已接进 `plugin/package.json`
  的 `prepublishOnly`）：校验 `plugin/bin/*.exe` 与 `dist/*.exe` 逐字节一致，
  且 `plugin/bin/` 没有被 `files` 通配带进去的残留文件。
  此前这类不一致只在用户装完后才暴露。

- **上游契约漂移自动检测**（#15 A 项）。机械提取 DSH runner 的 4 类契约
  （start 请求字段集、Windows spawn 错误码表、可执行文件解析顺序、stdio fd 布局），
  生成 SHA256 指纹存入 `.contract-fingerprint.json`。DSH 升级改动契约时，
  pre-commit 会直接失败并指出哪一类变了，不再依赖人工核对备忘录。

- **`npm run lint`**：JS 语法检查 + ESLint，扫描口径收敛到
  `scripts/check-js-syntax.mjs` 一处定义，CI 与本机共用同一份。

- **`npm run isolation`**：故障注入量化「独立 runner 进程」的隔离价值（#16）。

### 修复

- **`plugin/bin/*.exe` 被占用导致替换失败**（#23）。插件从自身目录启动的短命
  `dsh-aot-runner.exe` 子进程会短暂持有 exe 句柄，直接覆盖会失败。
  改为**改名换位**：先 `mv` 旧文件让出句柄，再写入新文件。

- **`build.sh --check` 永远无法通过**。收敛 JS 扫描口径时删掉了
  `JS_SYNTAX_COUNT` 变量，但第 213 行仍在引用它——`set -u` 下直接
  `unbound variable` 退出。构建门禁因此在到达「全部通过」之前就中止。
  **这个 bug 让 `--check` 从一次重构起就是坏的，而没人发现，因为它总是「失败」，
  看起来像是代码有问题。** 现在删除该行，计数由脚本自己打印。

- **pre-commit 显式指定 `.sln`**（#6cb7753）。仓库同时存在 `.sln` 和 `.csproj` 时
  `dotnet format` 无法自行选择 workspace，会抛 `FileNotFoundException`
  直接崩掉——那道检查从「检查格式」变成了「一律失败」，与代码是否合规无关。

- **pre-commit 短路测试会破坏 git 索引**（`d20741b`）。测试在真实仓库里
  模拟提交，失败时会留下半提交状态并挂死。

- **覆盖率采集绕开 `KillTree` 崩溃路径**（#25 部分修复）。见「已知问题」。

- **CI 四处修复**：适配器下载改用相对路径、Windows job 补装 A/B 基线、
  `DSH_RUNNER` 指向基线并转成原生路径。此前 Windows CI 的红灯是环境问题，
  不是代码问题——**「测试环境未就绪」和「测试失败」在 CI 上长得一样**。

### 文档

- 新增 `docs/质量门禁现状审计-2026-11-10.md`：实测 pre-commit/pre-push 两个
  hook 的真实覆盖情况。结论是 **pre-push 在本仓库从未执行过**（`core.hooksPath`
  与 `xp-gate init` 安装位置冲突），而 pre-commit 的 Gate 1 对 C# 项目静默跳过
  （扩展名正则漏了 `.cs`，输出却是 `✅ PASSED`）。
- 补 `docs/测量方法论-当工具比被测对象更容易出错.md` 案例 10，
  以及 `ROADMAP.md` 的两条已知盲区。

### 已知问题（未在本版修复）

- **偶发 CLR 崩溃**（#25）。`dotnet test` 覆盖率那一遍偶尔会以
  `Fatal error. Internal CLR error. (0x80131506)` 中止，栈指向 xunit 的
  `TestInvoker<T>` 泛型实例化路径。发生概率约 1/10~1/300 次连续运行，
  **不是确定性缺陷**。目前靠 xp-gate 侧的「崩溃后单次重试」缓解：
  第一次崩、第二次过则放行；两次都崩则不放行（防止重试变成掩盖手段）。
  根因仍在追。

- **契约分支覆盖率与未覆盖维度补测**（#15 B/C 项）尚未完成。

## [0.2.2] - 2026-11-08

**这是一次修复发布：0.2.1 中的两个缺陷会让 runner 在特定条件下不可用。建议升级。**

### 修复（重要）

- **空环境变量导致所有 spawn 失败。**
  `BuildEnvironmentBlock` 在 env 为空时只产出 2 字节，而 `CreateProcessW` 对
  这块内存要求至少 4 字节（双 NUL 终止），实测返回 `ERROR_INVALID_PARAMETER(87)`。
  也就是说：**host 一旦传空 env，runner 完全无法启动 target**。

  更值得记下的是它为什么没被发现 —— 当时那条单测写的是「断言 2 字节」，
  而它的注释写着「2 字节会让 CreateProcessW 返回 87」。注释与断言互相矛盾，
  **测试反而把这个 bug 锁死了**。这是「测试通过 ≠ 行为正确」的典型样本。

- **IPC 通道关闭时误判为协议错误。**
  `IpcChannel.IsEndOfStream` 只认 `ERROR_BROKEN_PIPE(109)` 和 `ERROR_NO_DATA(232)`，
  漏掉了 `ERROR_PIPE_NOT_CONNECTED(233)`，同时还丢弃了 `ReadFile` 的 `ok` 标志。
  对端以 233 关闭通道时，runner 会抛 `IpcProtocolException` 而不是正常结束。

### 测试

- **生产源码覆盖率 89.2% → 100.0%**（1020/1020 行），单元测试 254 → 319。
- 新增 `FdLayoutHost`：在测试进程里**真实分配** fd 3/4/5/6/7，
  让 `JobRunner` 的编排代码可以被真正覆盖，而不是靠 mock 自证 ——
  mock 只能证明「mock 返回了我告诉它的值」。
- 难测的失败路径（Job 创建失败、spawn 异常、fd 缺失、轮询异常）统一走
  「**默认真实实现、测试可替换**」的注入接缝。接缝默认值必须指向真实实现，
  写成空操作会让生产路径静默失效。
- 修正 `TraceTests` 的集合名：`[Collection("TraceEnvironment")]` 从未定义
  （实际定义叫 `TraceEnv`），导致修改进程环境变量的测试**完全没有隔离**，
  是全量跑时的偶发失败源。
- `ProtocolJson` 的十六进制转义补上 `InvariantCulture`。

### 质量门禁

- **编译严格度收敛到单一来源。** 此前严格度被抄在两个 csproj、`build.sh`
  以及 CI/release 的 `dotnet` 命令里，靠「改了记得同步」的注释维系。
  现在只有 XP-Gate Gate 13 适配器中的 `gate13_csharp_flags()` 一处定义，
  构建脚本与 CI 都向它索取，找不到即报错退出（不退回默认值）。

- **修掉两个实际漏检：**
  - Gate 13 只构建第一个 `*.??proj`，**测试项目从未被严格检查过**。
    新增 `DshAotRunner.sln` 把两个项目都纳入后，浮出 508 个此前隐藏的分析器告警。
    测试代码的写法惯例（如 xUnit 方法名含下划线的 CA1707）已通过
    `tests/DshAotRunner.Tests/.editorconfig` 定点豁免，`src/` 严格度不受影响。
  - CI 的 `dotnet publish` 没有任何严格度参数，实测放入未使用字段时
    **只有 warning、发布照常成功** —— 等于 CI 不拦任何代码质量问题。

- 覆盖率门槛从 88% 提到 99%（实际已达 100%），`build.sh` 未达标即中断。

### 致谢

两个缺陷都是在为项目补建测试安全网的过程中暴露的，详见
`docs/测量方法论-当工具比被测对象更容易出错.md` 案例 9 与案例 10。

## [0.2.1] - 2026-11-06

**runner 行为无任何变化** —— 本次只动发布与门禁基建。二进制与 0.2.0 逐字节相同
（同一份源码、同一套工具链），升级不会改变运行时行为。

### 发布

- **npm 发布改用 OIDC Trusted Publishing**（优先），保留 granular token 回退。
  零密钥、无泄露风险、无需定期轮换。
  之所以要回退路径：npm 的硬限制是**全新包的首个版本无法用 OIDC 发布**，
  0.2.0 必须先走 token，OIDC 从本版开始才生效。

- 修掉 Release 工作流的一个真实风险（被 Gate 7 / checkov `CKV_GHA_7` 拦下）：
  原设计用 `workflow_dispatch` 的 `tag` 输入决定发布名，而这个自由填写的字符串
  会进入 zip 文件名、Release 标题和**版本一致性断言** —— 后者是唯一的版本闸门。
  等于说谁能手动触发 workflow，谁就能用自造的 tag 名绕过它。
  改为不接受任何输入，只认 `github.ref_name`，权限收敛到「只能重发已存在的 tag」。

- README 增加 npm / license / platform 徽章。

### 质量门禁

- **补上 `.archlint.yaml`，让 Gate 6（架构验证）真正生效。** 之前一直缺这份配置，
  Gate 6 每次 BLOCK。写配置前先跑了原始分析：53 个 smell、2.9/10，
  其中 47 个来自 `bench/node-tuning/`（一次性实验脚本，重复是刻意的）、
  3 个来自 `.git/`、3 个是入口脚本被误判为死代码，
  **`src/` 与 `plugin/` 是 0 个**。忽略项基于「这些代码本就不该用架构规则衡量」，
  不是为了让门禁变绿而放水。配置后 53 → 0，10.0/10。

  已知限制：archlint 0.16.0 不解析 C#，所以 `src/*.cs` 仍是盲区（非本次引入）。

- `.gitignore` 补 `*.exe.old`、`.xp-gate/reports/`、`.xp-gate/quality-status/`、
  `.quality-history.jsonl`。

### 其他

- `bench/node-tuning/` 的 5 个脚本不再硬编码作者本机路径，改为 `path.resolve(__dirname, ...)`。
- 清理 npm 包里混入的 `bin/dsh-aot-runner.exe.old` 残留（多 1.4MB 无意义体积）。

## [0.2.0] - 2026-11-06

本次为**公开发布版本**：在 0.1.0 基础上完成了大规模重构、建立了 C# 回归测试基线，
并修掉了一批由发布前评估发现的工程缺陷。

### 发布

- **新增 Release 工作流**（`.github/workflows/release.yml`）：打 `v*` tag 后自动构建、
  验证并发布 **GitHub Release（含编译好的二进制）** 与 npm 包。
  产出 `dsh-aot-runner-<tag>-win-x64.zip`、裸 `dsh-aot-runner.exe`、
  `SHA256SUMS` 与 `LICENSE`。

  为什么二进制必须进 Release 而不只是塞在 npm 包里：
  1. **从 git clone 的人拿不到 exe** —— 构建产物不入库，而自建需要约 8GB 的
     C++ 工具链（NativeAOT 强制要求 MSVC 链接器）。为了"用一个快 60% 的 runner"
     而装整套 Visual Studio 是不合理的门槛。
  2. **可校验** —— Release 资产有独立 SHA256，且由 CI 从 tag 对应 commit 构建，
     比本机产物更可审计、更可复现。
  3. **只想要二进制、不装插件的场景**（自定义部署、丢进 PATH）此前无处获取。

  发布前跑完整门禁（版本一致性 → C# 单测 → 构建 → 体积哨兵 → 依赖检查 → A/B + IPC），
  任一失败即中止 —— 宁可不发，不发错的。

- **README 新增「下载」章节**：说明三种获取方式（Release / npm / 源码构建）及适用场景。

- 修掉 npm 包里混入的 `bin/dsh-aot-runner.exe.old` 残留（多出 1.4MB 无意义体积）。

### 测试

- **C# 回归测试基线 0 → 139 用例**，配套可测的覆盖率收集。
  此前 `src/*.cs` 完全没有单测保护，重构只能靠 e2e 兜底。
- **修复零泄漏测试的环境依赖缺陷**，观测器补第二层判据（防"测试永远为真"）。
- **全部套件 216 项通过**（JS 77 + C# 139）。

### 重构

- 拆分 `IpcChannel` 帧解码与 `ArgParsing`，把"字节→消息"的判断从 I/O 里剥出来，
  使它能被穷举测试（`IpcFrameDecoder` 覆盖 95.8%）。
- 消除 xp-gate 报告的复杂度与重复代码违规（CCN > 5 → 0）。

### 新增

- **DSH 设置页状态卡片**（`plugin/client/`）：只读展示生效情况、exe 路径、熔断阈值。
- **长期观测器 `bench/aot-observe.js`**：多轮采样 + 可信度判定。
  README 的"收益比例才是稳定指标"这一结论就来自它。
- **`docs/测量方法论-当工具比被测对象更容易出错.md`**：复盘 5 次测量假象，6 条可复用规则。
- **GitHub Actions 工作流**（省额度设计）。
- **`docs/发布前评估报告-2026-11-06.md`**：公开发布前的完整评估记录。

### 修复（发布前评估，2026-11-06）

- **文档口径统一**：性能收益此前在 README（59%）、plugin README（65.0%）、
  实测（63.5%）三处互相矛盾，且 plugin README 内部同时出现两个比例。
  现统一为「**约 63~67%**」，并在两处都写明**绝对毫秒数随负载波动、比例才是稳定指标**。
  依据：独立测量 64.1%（5 轮可信观测）/ 66.6%（3 轮跨轮一致）/ 63.5%（单次 30 样本）。

- **License 自相矛盾**：README 末尾写「Private / internal use」，而 `LICENSE` 是 MIT。
  已改为 MIT，并补一句通俗的权利说明。公开仓库后这会立刻成为法律疑问。

- **`plugin/README.md` 缺失关键前提**：全篇未提「需要一行上游补丁」，
  而补丁是插件能否生效的**必要条件**。用户装完会看到「不生效」并误以为插件有 bug。
  已在顶部加入醒目警告，并把安装流程重写为三步（确认 exe → 打补丁 → 安装插件），
  同时新增「装上但没生效？」排查清单。

- **安装指引含作者本机路径**：`link:D:/projects/dsh-aot-runner/plugin` 对任何人都不适用。
  已改为占位路径 + npm 版本号两种写法。

- **`scripts/coverage-summary.py` 读错文件，覆盖率门禁形同虚设**（本次评估最实质的缺陷）：
  原实现 `collect(files[0])` 依赖 `glob` 的顺序，而 `TestResults/` 会累积历史报告
  （实测 14 份，其中 4 份是 `lines-valid="0"` 的空报告）。`files[0]` 恰好命中空报告，
  脚本恒输出 `0.0% (0/0 行)`，而真实生产覆盖率是 **41.3%**。
  现改为「先过滤空报告，再按 mtime 取最新」，并打印所用报告路径便于核对。

- **`scripts/check-deps.sh` 在无 VC++ 工具链时永远失败**：
  硬依赖 `dumpbin.exe`，找不到就 `exit 2`，导致 `build.sh` 中止。
  已增加 `llvm-readobj --coff-imports` 后备路径（实测可用），并打印当前使用的工具。

- **`build.sh --clean` 会毁掉唯一可用产物**：构建可能因缺链接器/网络失败而中止，
  但 `--clean` 已先把 `dist/*.exe` 删掉，而它不在版本库里（`*.exe` 被 `.gitignore` 排除）——
  「清理重建」直接把项目变成不可运行状态。现改为**构建前备份、失败则还原**。

- **`npm run test:all` 未覆盖全部门禁**：遗漏了 `lint` 与 `test:coverage`。
  已补上，使「一条命令跑完全部门禁」真的成立。

- **测试项数文档过时**：README 多处写「60 项」，实际是 **216 项**
  （JS 77 + C# 139，后者是重构期间新增的）。已按套件逐项列出。

- **`plugin/README.md` 文档错报默认值**：写 `enabled` 默认 `true`，
  而插件包自带 `cordis.patch.yml` 实际是 `false`。
  `false` 是有意的安全设计（装上不自动接管子进程），改文档而不是改代码。

- **DSH 状态卡片挂载点**：初版误用 `settings.plugin.item`，该 slot 在
  DSH 0.1.7-rc.2 之前已废弃、在 0.2.0-rc.2 里完全不存在，卡片不会显示。
  已改用 `plugins.row.config`（侧栏「插件」页里该行的详情区）。

### 说明

- 状态卡片**只读**而非可写是有意的：客户端跑在浏览器里，读不到服务端内存中的
  熔断状态，硬做一套 remote 通道来显示它，收益抵不上复杂度。运行时降级仍看日志。
  启用/停用仍走侧栏「插件」页面的官方开关，本卡片不重复做开关 —— 避免两个真相来源。

- 明确「两个开关」的区别：侧栏开关卸载 loader 行（代码不加载），
  `config.enabled` 只跳过注入。切换开关不会丢配置。

## [0.1.0] - 2026-11-02

首个公开发布。NativeAOT runner 可替代 DSH 的 Node.js runner，并通过插件接入。

> **重要前提**：在 DSH 0.2.0-rc.2 上必须配合一行上游补丁才能生效，
> 详见 [vendor/README.md](vendor/README.md) 与
> [上游 discussion #11893](https://github.com/deepseek-ai/deepseek-harness/discussions/11893)。
> 插件会自检并在这个前提不满足时告警、自动停用。

### 性能（生产路径实测，DSH 真实 launchWindowsJob）

| 指标 | node runner | AOT runner |
|---|---|---|
| p50 | 156~158ms | **63~64ms** |
| p99 | 249~279ms | **142~206ms** |
| 离散度 | 11.7%~20.5% | **1.9%~4.1%** |

- 每次净省 **92~94ms（约 59%）**，三轮收敛
- p99 长尾改善 73~124ms
- 300 次连续调用 0 失败，无内存累积增长

### 新增

- **插件接入**（`plugin/`）：配置开关、熔断降级（连续 3 次失败自动退回 node runner）、
  启动自检（检测 DSH 缺陷并主动停用，而不是假装工作）
- **`vendor/` 上游补丁留档**：原始文件 + 补丁工具，支持 status/apply/revert/verify
- **完整测试套件 60 项**：IPC 协议、真实 host 路径、插件单元、端到端、
  A/B 对比、泄漏、竞态
- **性能对比报告**（`docs/性能对比测试报告.md`）三层数据与完整方法论

### 修复

- **测试假阳性**：端到端与 host 路径测试原先只断言「注入字段被赋值」，
  而 node runner 同样能让调用成功 —— 于是插件完全失效时测试照样全绿。
  现改为观测实际启动的命令行，断言必须是 AOT exe。
- **测试依赖本机路径**：硬编码的家目录路径改为运行时多候选解析（DSH_HOME / USERPROFILE / 仓库 node_modules）

### 已知限制

- 仅 Windows（Job Object 进程树回收依赖 Win32 API）
- 依赖 DSH 的 `internals` 接缝，而 DSH 0.2.0-rc.2 的上游缺陷会切断该接缝
  —— 需要打补丁（`vendor/README.md`），插件已内置自检，检测到未打补丁会自动停用
  并明确告警，不会出现「看似启用实则无效」
- 无设置面板 UI（状态通过日志暴露；需要完整 UI 得写 React 客户端插件）
- **代码尚未达到项目自定的质量标准**：xp-gate 目前不支持 C#，
  主体代码（`src/*.cs`）的门禁检查是盲区。
  已在 xp-gate 提 issue（<https://github.com/boyingliu01/xp-gate/issues/717>），
  待其支持 C# 后另起任务重构。**在此之前仓库保持 private。**

## [Unreleased]

正式开发环境基建。不改变对外行为 —— 24 项 A/B 验证保持 24/24 通过，
产物体积从 1,212,928 降到 1,207,296 字节。

### 新增

- **本地质量门禁**（`./build.sh --check`）：C# 格式 + 0 警告静态检查 + JS 语法，
  三道检查任一失败即非零退出。已做正反例自校验（注入违规能拦下，恢复后通过）。
- **`.editorconfig` / `.csharp-formatting.json`**：C# 格式规则，`dotnet format` 可一键修复。
- **`scripts/check-integrity.sh`**：Low IL 目录自检，`build.sh` 在构建前自动调用，
  命中 Low Integrity 直接中止而不是产出一个跑不起来的 exe。
- **`src/Trace.cs`**：唯一的诊断日志写入口。此前 `Program.cs` 与 `JobRunner.cs`
  各有一套 `Dbg`，一处硬编码文件名且不认 `DSH_AOT_DEBUG_FILE`。
- **`docs/开发环境.md`**：工具链版本、验证步骤、runner 路径解析规则、故障排查表。

### 变更

- **产物目录** 从 `%TEMP%/dsh-aot-runner-dist` 改为仓库内 `dist/`，可追溯。
  新增 `./build.sh --out` 指定目录。
- **测试不再硬编码机器路径**：`test/runner-client.js` 与 `bench/d1-ab-bench.js`
  改为多级查找（`AOT_RUNNER` / `DSH_RUNNER` → 仓库 `node_modules` → `DSH_HOME` /
  `%USERPROFILE%/.workbuddy/...`），找不到时给出可操作报错。
- **静态检查升级为硬约束**：`TreatWarningsAsErrors=true`，`AnalysisLevel=latest-recommended`。
- `JobRunner` 实现 `IDisposable`，句柄清理挂到语言级释放约定上。

### 修复

引入严格 analyzer 后一次性暴露并修复的真实缺陷：

- **`ResumeThread` 返回值被忽略**（CA1806）：失败时线程永远挂起，target 静默不执行，
  而 runner 在等一个永远不会出现的退出码，外部表现为「调用卡住」。
- **`resolveAotRunner` 静默回退到过期产物**：当 `dist/` 未构建时，测试会拿
  `%TEMP%` 里的**旧二进制**做 A/B，结论全绿却毫无意义。
- **`EmitProtocolError` 输出 `"code":null`**：与 `ProtocolJson` 承诺的「null 字段不输出」
  不一致；host 侧 `isSerializedRunnerError` 会判定为非法并丢弃整条错误结果。
- **`DSH_AOT_NOJOB=1` 实验开关能让 Job 隔离失效**：实测 terminate 后 target 进程树泄漏
  （`PING.EXE` 残留）且不回报结果。已删除，`AssignProcessToJobObject` 改为无条件执行。
- **`SafeJobHandle` 私有构造函数**（CA1419）：SafeHandle 派生类型的无参构造函数
  必须与类型同可见，否则运行时无法通过反射创建实例。

### 移除

- 实验开关 `DSH_AOT_NOJOB`、`DSH_AOT_SUPPRESS` 及其残留分支。
- `Program.cs` 中重复的 `Dbg` 实现与死代码 `AppendJsonString`。

### 文档

- README / ROADMAP 与线上 Issue 对齐：修正 Issue 编号错位（熔断器是 #6 不是 #1）、
  待办按 P0/P1/P2 重排。
- 记录 **CI 决策**：暂不搭建 GitHub Actions，用本地质量门禁替代，
  该项从 v2.0.0 阻塞条件中划掉。
- 修正 **`resolveWindowsExecutable` 搜索根缺口的误判**：复核 DSH 源码
  （`runner-launch-*.js:1485`）确认其搜索根只有 cwd + PATH，AOT 实现本就一致；
  早先观察到的差异是探测脚本传了 glob 模式的 cwd 导致的测量伪迹。

### Issue #11 阶段 A：Node IPC 协议对齐（破坏性变更）

**这是项目迄今最重要的修复**：AOT runner 此前**从未能被真实 DSH host 调用**。

#### 问题

AOT 实现的是 NDJSON over stdin，而 DSH host 用 Node IPC（fd 3），
`stdio[0..2]` 全是 `'ignore'`。实测旧版在真实布局下会立刻因 stdin EOF 退出，
host 侧 `send()` 抛 `ERR_IPC_CHANNEL_CLOSED`。

过去 40 个用例全绿是**测试假象**：测试客户端自己为 AOT 和 node 实现了两套协议，
两边各跑各的，从未验证过「同一套 host 布局能否驱动 AOT」。

#### 新增

- **`src/IpcChannel.cs`**：fd 3 上的帧读写。
  - 帧格式 `[8B type][8B len][JSON]`；`type` 是类型不是序号（Windows 无 seq）
  - 内部缓冲 + 循环切帧：一次 `ReadFile` 可能返回多帧或半帧
  - EOF 判定含 `ERROR_BROKEN_PIPE(109)` / `ERROR_NO_DATA(232)`
  - `type != 1` 报 `EPROTOCOL`；单帧上限 8MB
- **`src/IMessageChannel.cs`**：消息通道抽象。
- **`src/NdjsonChannel.cs`**：`--ndjson` 调试模式（手工驱动用，非生产）。
- **`test/ipc-verify.js`**（6 条）：disconnect 退出、多帧、半帧、后续帧、
  3MiB env、stdio 映射。
- **`test/host-path-verify.js`**（1 条）：**真实 `LocalSubprocessRuntime` 路径** ——
  注入 `internals.runnerInvocation` 后确认 AOT 被选中、执行、结果回流。

#### 变更

- **主循环协议**：`LineReader`(stdin) → `IMessageChannel`(IPC)。
  保留 Issue #3 的「读线程 + 有界等待」结构，只换底层读取源，
  因此没有重新引入挂起风险。
- **`Program.cs` 去掉 stdout 依赖**：`Console.OpenStandardOutput()` → `IpcChannel`；
  `EmitProtocolError` 也改走 IPC（否则参数错误会静默消失）。
- **测试客户端统一协议**：`test/runner-client.js` 对 AOT 与 node 使用**相同的真实
  host 布局**，两侧都走 `c.send()` / `c.on('message')`。这是让 A/B 真正可比的前提。
- **`CrtDescriptorTable.Encode` 拒绝字符设备**：真实布局下 runner 自己的
  fd 0/1/2 是 `\\?\NUL`，把它填进 target 标准槽会让输出静默丢失。
  现在直接抛异常，让问题在启动期暴露。

#### 修复

- `test/race-verify.js` 加**文件级** timeout（900s）：五条用例串行累计 >120s，
  会被 `node:test` 的文件级默认超时误杀。单条 timeout 不解决这个问题
  （文件级超时先触发）。
- 测试客户端对已断开的 IPC 通道调用 `send()` 会抛**异步** error（
  `ERR_IPC_CHANNEL_CLOSED`），`try/catch` 抓不住、会带崩测试进程；
  改为先用 `c.connected` 判断。

#### 已知盲区（诚实记录）

「切帧后丢弃缓冲区剩余数据」这类缺陷，现有测试**抓不到**。
三种构造（小帧连发 / 大帧+小帧 / 256KB 噪声帧+terminate+start）都试过，
由于 Node 发送端的排队行为，多条帧很少落在同一次 `ReadFile` 里。
需要 runner 侧可注入「一次读返回多帧」的测试接缝，尚未实现。

#### 验证

| 套件 | 结果 |
|---|---|
| IPC 协议回归 | 6/6 |
| 真实 host 路径 | 1/1（`selectContainmentMode` = `windows-job`）|
| A/B 一致性 | 28/28（两侧现走同一协议）|
| 零泄漏 / 混沌 | 7/7 |
| terminate 竞态 | 5/5 |
| 质量门禁 | 全绿 |

### Issue #11 阶段 B：插件接入 + 熔断器

不修改 DSH 源码，通过 `LocalSubprocessRuntime.internals.runnerInvocation`
这个既有接缝把 runner 换成 AOT exe。

#### 新增 `plugin/`（`@boyingliu01/dsh-aot-runner@0.1.0`）

- **`lib/index.js`** — cordis 插件主体
  - `resolveRunnerPath()`：config → env → 包内 `bin/`。
    **显式配置不静默回退** —— 写了路径就是想用那个 exe，
    静默换成另一个会在排查时严重误导
  - `findRuntime()`：兼容 `ctx.subprocess` 与 `ctx.reflect.get('subprocess')`
  - 包装 `runtime.spawn`，把 `handle.done` 的 reject 接到熔断器
  - `ctx.effect` 注册卸载还原
- **`lib/circuit-breaker.js`** — 只数连续失败，成功一次即清零。
  刻意不做滑动窗口/半开计时：熔断逻辑本身出 bug 比没有熔断更危险。
  熔断后不自动恢复（若原因是 exe 被隔离，反复试探只会让每次调用慢一拍）
- **`cordis.patch.yml`** / `package.json` / `README.md`
- `build.sh` 构建后自动同步产物到 `plugin/bin/`（该目录被 `.gitignore` 排除）

#### 测试

- `plugin/test/index.test.js`（7 条）：注入 / 缺 exe 不动 runtime /
  `enabled=false` / 熔断降级 / target 非零退出不误判 / 卸载还原 /
  成功清零（偶发失败不累积）
- `test/e2e-plugin-verify.js`（2 条）：插件 + **真实 `LocalSubprocessRuntime`**
  跑通；runner 缺失时插件不生效且会话仍可用

#### 修复

`runtime.spawn` 还原时曾把 `bind` 后的函数赋回去，导致还原后
`runtime.spawn` 不再是原型方法（引用不等、多次 apply 会层层包装）。
改为分别保存原方法引用与绑定版本。

#### 自校验

- 注入「成功不清零」→ 新增的交替失败用例抓到 ✔
- 注入「永不熔断」→ 熔断用例抓到 ✔

#### 诚实记录的测试缺口

熔断的 **e2e** 验证被移除。用「存在但非 PE 的 exe」构造 runner 失败时，
`node x.cjs` 下 `handle.done` 正常 reject，`node --test` 下却 resolve 成
`{exitCode: 0}` —— 三条独立最小复现都指向 node:test 环境差异，原因未查明。
**测不出差异的测试比没有测试更糟**（假绿灯），因此熔断改在单元层用假
runtime 验证（结果确定），e2e 层只保留「降级后会话仍可用」。

#### 全套件结果

| 套件 | 结果 |
|---|---|
| IPC 协议回归 | 6/6 |
| 真实 host 路径 | 1/1 |
| 插件单元 | 7/7 |
| 插件端到端 | 2/2 |
| A/B 一致性 | 28/28 |
| 零泄漏 / 混沌 | 7/7 |
| terminate 竞态 | 5/5 |
| **合计** | **56/56** |

### 性能对比验证（第一层 + 第二层）

#### 改进基准本身

同一台机器连跑三次同一基准，收益比例得到 40.5% / 64.0% / 65.6%。
**单次测量完全不可信**，且原先没有判据说明哪一轮可不可信。

> 修正一处误判：起初怀疑「基准是先跑完 A 再跑 B，负载漂移污染结果」，
> 核对代码后发现**早就是交错采样**（每轮地板→node→AOT）。
> 真正原因是系统负载波动，不是设计缺陷。

改动：

- 每轮记录 CPU 负载与可用内存（取不到时显示 `n/a`，不编造 0）
- 输出增加 **p99 与 max** —— 卡顿感来自长尾，只看 p50 会漏掉
- 离散度用 **IQR / 中位数**，不用标准差：启动耗时有长尾，
  标准差会被几个异常样本拉爆，反而看不出主体数据稳不稳
- **自动可信度判定**：失败>0 或离散度>10% 判 `UNRELIABLE`，
  5~10% 判 `FAIR`，<5% 判 `GOOD`
- 输出 `SUMMARY` JSON 行，便于多轮汇总

> 加自动判定的理由：只给数字不给判据，读者（包括未来的自己）会下意识
> 挑一个好看的数字。把判据写死在代码里，事后就没法自我美化。

#### 第一层：隔离基准（5 轮 × 30 次）

| 轮次 | node p50 | AOT p50 | 收益 | 离散度 | 判定 |
|---|---|---|---|---|---|
| 1 | 250ms | 109ms | 64.8% | 6.4%/1.1% | FAIR |
| 2 | 279ms | 125ms | 63.4% | 16.4%/15.1% | UNRELIABLE |
| 3 | 260ms | 124ms | 60.0% | 9.8%/12.9% | UNRELIABLE |
| 4 | 238ms | 187ms | 24.8% | 3.3%/49.8% | UNRELIABLE |
| 5 | 238ms | 109ms | 65.0% | 2.9%/1.5% | GOOD |

**5 轮里 3 轮被判不可信** —— 判定机制立刻证明了价值。
**只报可信轮次：64.8% / 65.0%，runner 开销 217ms → 76ms，每次省 130~141ms。**

第 4 轮的 24.8% 是真实测到的：单独抓分布呈明显双峰（≈110ms / ≈190ms 两簇），
是外部干扰，无法从基准侧消除，只能靠记录 + 多轮取可信值处理。

#### 第二层：真实负载对照（3 轮 × 40 次）

| 轮次 | node p50 | AOT p50 | 收益 | node p99 | AOT p99 | p99 改善 | 失败 |
|---|---|---|---|---|---|---|---|
| 1 | 249ms | 109ms | 64.6% | 379ms | 173ms | 206ms | 0 |
| 2 | 253ms | 109ms | 66.0% | 393ms | 220ms | 173ms | 0 |
| 3 | 243ms | 109ms | 63.4% | 331ms | 200ms | 131ms | 0 |

**关键发现：p99 / max 全部改善，且幅度比 p50 更显著。**
交互式使用时，偶发一次 400ms 比平均快 130ms 更影响体感。

#### 稳定性

120 次连续调用：**0 失败**，RSS 52.6 → 54.7MB 无累积增长，
p50 109ms / p99 205ms / max 219ms。

#### 全程对现有 DSH 的影响

独立 node 进程跑基准，**未安装插件、未改动任何 profile、未重启 DSH**，
测试期间 web 会话全程正常运行。

完整数据见 [`docs/性能对比测试报告.md`](docs/性能对比测试报告.md)。

## [1.0.0] - 2026-10-31

首个可用版本。DSH 子进程 runner 的 NativeAOT 实现，S4 A/B 验证 24/24 通过。

### 新增

- **核心运行时**（`src/`）
  - `JobRunner.cs` — `CreateProcessW` + Job Object 启动/监控/终止 target；
    严格对齐 `@deepseek-ai/dsh-subprocess-local` 的调用契约
    （stdio fd 4/5/6 布局、`hasExactKeys` 严格字段校验、NDJSON 协议通道）
  - `JobHandle.cs` — Job Object 封装，`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`
    保证 runner 退出时整棵进程树回收
  - `Native.cs` — P/Invoke 声明（含 `_get_osfhandle` 取 CRT fd 句柄的正确方式）
  - `Protocol.cs` / `ProtocolJson.cs` — 协议 POCO 与零反射手写序列化

- **测试**（`test/`）
  - `runner-client.js` — 共享测试工具，封装真实 DSH 调用契约
  - `ab-verify.js` — 24 项字节级 A/B（stdout/stderr/exitCode/error 对象

- **基准**（`bench/`）
  - `d1-ab-bench.js` — 交错采样，避免系统负载漂移影响对比结论

- **构建**（`build.sh`）— 一键构建 / 测试 / 基准

- **文档**（`docs/`）
  - JSON 序列化选型调研与极致启动优化（含 12 用例迁移矩阵）
  - S2b 性能实测报告
  - S2 进展与阻塞记录

### 修复

- **bash/ls 崩溃**（`0xC0000022`）：根因是工作区目录被 DSH Windows 沙箱标记为
  `Mandatory Label\Low Mandatory Level`，从该目录启动的 exe 继承 Low IL 后无法创建
  `BaseNamedObjects` 对象。构建产物改落 `%TEMP%` 规避，并在 `DshAotRunner.csproj`
  与 README 中留存完整诊断路径。
- **`ResolveExecutable` 与 node 行为分歧**：逐项对齐 `resolveWindowsExecutable` —
  候选扩展名只有 `.com`/`.exe`（`.com` 优先），不含 `.bat`/`.cmd`；
  全部候选不存在时返回 ENOENT 而非把裸名交给 `CreateProcessW`。
  修正了「`npm` 在 node 下报 ENOENT、在 AOT 下却能跑」的分歧。
- **ENOENT 错误对象文本不一致**：逐项复制 `WINDOWS_SPAWN_ERROR_CODES` 映射表与
  `NODE_SPAWN_DETAIL_CODES` 规则，使错误对象与 node 完全一致。

### 性能

同一时间窗交错采样（n=30）：

| | min | p50 | p95 |
|---|---|---|---|
| 原生地板 `hostname.exe` | 36ms | 54ms | 189ms |
| node runner（改前） | 280ms | 413ms | 673ms |
| **AOT runner（改后）** | 138ms | **199ms** | 342ms |

每次调用净省 **214ms**，消除 **59.6%** 的 runner 固定开销。

### 已知限制

- `control pipe` 语义未实现（`Control` 字段已解析但未使用）
- S5 进程树泄漏/混沌测试未做
- `dumpbin /DEPENDENTS` 依赖检查未做
- 尚未接入 `ctx.subprocess`（S6）
- JSON 层仍在用 `JsonDocument`，`Utf8JsonReader` 迁移未完成
- 复用 DSH 内部契约，DSH 升级时需重新核对（`test/ab-verify.js` 是回归闸门）

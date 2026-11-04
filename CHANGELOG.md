# CHANGELOG

本文件格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

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

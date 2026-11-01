# CHANGELOG

本文件格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

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

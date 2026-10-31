# CHANGELOG

本文件格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

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

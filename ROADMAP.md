# 路线图

> 本文件与 GitHub Issues 保持同步。**Issue 是唯一事实来源**，
> 这里只是给不看 Issue 的人一份概览。
>
> 仓库：https://github.com/boyingliu01/dsh-aot-runner

## 已达成（v1.0.0）

| 指标 | node runner | AOT runner | 改善 |
|---|---|---|---|
| p50 | 413ms | **199ms** | 净省 214ms |
| p95 | 673ms | **342ms** | |
| 开销消除比例 | — | **59.6%** | |

**S4 A/B 验证：24/24 通过**（stdout/stderr/exitCode/错误对象字节级一致）

## 阶段状态

| 阶段 | 状态 | Issue |
|---|---|---|
| S0 可行性验证 | ✅ 完成 | — |
| S1 NativeAOT 最小实现 | ✅ 完成 | — |
| S1b 依赖检查 | ❌ 待做 | [#5](../../issues/5) |
| S1c 签名分发 | ❌ 待做 | [#8](../../issues/8) |
| S2 功能对齐 | ✅ 完成 | — |
| S2b 性能实测 | ✅ 完成 | — |
| S3 语义完备 | ⚠️ ~50% | [#2](../../issues/2) [#4](../../issues/4) |
| S4 A/B 验证 | ✅ 完成 | — |
| S5 泄漏/混沌 | ❌ 待做 | [#3](../../issues/3) |
| S6 接入 `ctx.subprocess` | ❌ 待做 | [#6](../../issues/6) [#7](../../issues/7) |

## 建议执行顺序

按依赖关系排的推荐路径：

| 顺序 | Issue | 优先级 | 为什么这个顺序 |
|---|---|---|---|
| 1 | [#3](../../issues/3) 零泄漏回归 | P0 | 最基础的可信度验证，先证明「不会漏进程」 |
| 2 | [#2](../../issues/2) control pipe | P0 | 补齐唯一的功能缺口（fd 7 完全没接） |
| 3 | [#6](../../issues/6) 熔断器 | P0 | 接入前的安全网，与 #2 无强依赖 |
| 4 | [#4](../../issues/4) terminate 竞态 | P1 | 在 control 落地后覆盖时序边界 |
| 5 | [#5](../../issues/5) 依赖检查 | P1 | 半小时的快速验证，确认分发可行性 |
| 6 | [#7](../../issues/7) 接入 ctx.subprocess | P1 | 真正产生价值的一步 |
| 7 | [#8](../../issues/8) 签名分发 | P2 | 视是否要分发给团队决定 |

## 依赖关系

> 线上 Issue #7 把依赖写成了「#1 熔断器」，这是笔误 —— #1 是 Tracker，
> 熔断器是 **#6**。下图按实际内容绘制。

```
#1 Tracker（本路线图的 Issue 版本）
│
├── #3 零泄漏回归 ────────────────┐
├── #2 control pipe ──┬── #4 竞态 │
│                     └── #6 熔断器
├── #5 依赖检查 ──────────────────┤
│                                 ↓
└── #8 签名分发              #7 接入 ctx.subprocess
```

- **#4** 依赖 **#2**（竞态用例要覆盖 control 终止路径）
- **#6** 依赖 **#2**（熔断器要判断协议错误，需要协议语义完整）
- **#7** 依赖 **#6** + #2/#3/#4/#5 全部关闭

## v2.0.0 验收标准

- [ ] 所有 P0/P1 issue 关闭
- [ ] `npm test` 全绿且用例数 ≥ 24
- [ ] S5 零泄漏回归 100 次连续通过
- [ ] 已接入 `ctx.subprocess`，可通过配置开关回退到 node runner
- [ ] 熔断器覆盖「AOT 启动失败自动降级」路径
- [ ] ~~CI 在 GitHub Actions 上跑通构建 + 测试~~ —— **已明确不做**

> **CI 决策（2026-11-01）**：暂不搭建 CI，先把**本地**开发环境做扎实。
> 理由：NativeAOT 依赖重量级 MSVC 工具链（GitHub runner 上要现装 VS Build Tools + LLVM），
> 且 A/B 套件需要真实可用的 python/pwsh/bash/git，在托管 runner 上逐个确认成本高。
>
> 已用**本地质量门禁**替代（`./build.sh --check`）：C# 格式 + 0 警告静态检查 + JS 语法。
> 这条验收项在 CI 立项前保持划掉状态，不作为 v2.0.0 阻塞条件。

## 风险与已知限制

1. **复用 DSH 内部契约**
   `runner.js` 的协议字段、`resolveWindowsExecutable` 语义、
   `WINDOWS_SPAWN_ERROR_CODES` 映射表都会随 DSH 升级变化。
   `test/ab-verify.js` 是回归闸门，**DSH 升级后必须重跑**。

2. **`resolveWindowsExecutable` 搜索根缺口（已实测）**
   DSH 会把「解析出的 applicationName 所在目录」作为额外搜索根，AOT 版缺这一条。
   当 cwd 不在 PATH 中且命令以裸名给出时，DSH 能跑、AOT 报 ENOENT，错误文本也不同。
   现有 A/B 用例全部以 `C:/Windows` 为 cwd（在 PATH 中），因此测不出来。
   修复作为 [#7](../../issues/7) 的前置工作。

3. **Low Integrity 目录陷阱**
   构建产物必须放在 Medium IL 目录，否则 MSYS 程序会崩溃
   （`NtCreateDirectoryObject(\BaseNamedObjects\...)` → `0xC0000022`）。
   `build.sh` 已内置自检（`scripts/check-integrity.sh`），命中即中止。
   详见 README「重要陷阱」章节。

4. **`IlcDisableReflection` + `JsonSerializer` 不兼容**
   会在运行时崩溃 `MT140696497762168: Reflection_Disabled`。
   必须保持手写序列化。

## 技术债（未开 issue，记录备查）

- JSON 层用 `JsonDocument`，`Utf8JsonReader` 迁移可再省 ~15ms（体积 +160KB）
- 双分支语义（受限令牌路径）有意推迟到二期
- 缺少多硬件/多 Windows 版本的性能基线
- `LineReader` 逐字节 `ReadByte()` 读 stdin，大 `env` 的 start 请求会有额外系统调用开销

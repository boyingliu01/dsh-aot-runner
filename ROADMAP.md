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

| 顺序 | Issue | 为什么这个顺序 |
|---|---|---|
| 1 | [#3](../../issues/3) 零泄漏回归 | 最基础的可信度验证，先证明「不会漏进程」 |
| 2 | [#2](../../issues/2) control pipe | 补齐唯一的语义缺口 |
| 3 | [#4](../../issues/4) terminate 竞态 | 在 control 落地后覆盖时序边界 |
| 4 | [#5](../../issues/5) 依赖检查 | 半小时的快速验证，确认分发可行性 |
| 5 | [#6](../../issues/6) 熔断器 | 接入前的安全网 |
| 6 | [#7](../../issues/7) 接入 ctx.subprocess | 真正产生价值的一步 |
| 7 | [#8](../../issues/8) 签名分发 | 视是否要分发给团队决定 |

## 依赖关系

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
- **#6** 依赖 **#2**（熔断器要判断协议错误，需要 control 语义完整）
- **#7** 依赖 **#6** + #2/#3/#4/#5 全部关闭

## v2.0.0 验收标准

- [ ] 所有 P0/P1 issue 关闭
- [ ] `npm test` 全绿且用例数 ≥ 24
- [ ] S5 零泄漏回归 100 次连续通过
- [ ] 已接入 `ctx.subprocess`，可通过配置开关回退到 node runner
- [ ] 熔断器覆盖「AOT 启动失败自动降级」路径
- [ ] CI 在 GitHub Actions 上跑通构建 + 测试

## 风险与已知限制

1. **复用 DSH 内部契约**
   `runner.js` 的协议字段、`resolveWindowsExecutable` 语义、
   `WINDOWS_SPAWN_ERROR_CODES` 映射表都会随 DSH 升级变化。
   `test/ab-verify.js` 是回归闸门，**DSH 升级后必须重跑**。

2. **Low Integrity 目录陷阱**
   构建产物必须放在 Medium IL 目录，否则 MSYS 程序会崩溃
   （`NtCreateDirectoryObject(\BaseNamedObjects\...)` → `0xC0000022`）。
   详见 README「重要陷阱」章节。

3. **`IlcDisableReflection` + `JsonSerializer` 不兼容**
   会在运行时崩溃 `MT140696497762168: Reflection_Disabled`。
   必须保持手写序列化。

## 技术债（未开 issue，记录备查）

- JSON 层用 `JsonDocument`，`Utf8JsonReader` 迁移可再省 ~15ms（体积 +160KB）
- 双分支语义（受限令牌路径）有意推迟到二期
- 缺少多硬件/多 Windows 版本的性能基线

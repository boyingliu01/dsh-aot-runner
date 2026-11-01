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

按「**先修缺陷，再增功能**」重排（2026-11-01）。判据：能否让现有行为出错 >
能否让错误被掩盖 > 还缺什么能力。详见 [Issue #1 的重排评论](../../issues/1)。

| 顺序 | Issue | 分类 | 为什么这个顺序 |
|---|---|---|---|
| 1 | [#2](../../issues/2) control pipe | 缺陷 | 已实测 target 拿不到 fd 7，功能直接不可用 |
| 2 | [#3](../../issues/3) 零泄漏回归 | 可信度 | Job 回收从未被验证，其余结论都建立在假设上 |
| 3 | [#9](../../issues/9) 收紧测试基线 | 缺陷 | 错误对象缺结构化断言，会持续掩盖其他回归 |
| 4 | [#4](../../issues/4) terminate 竞态 | 缺陷 | 高频交替无覆盖，泄漏与误杀风险未量化 |
| 5 | [#5](../../issues/5) 依赖检查 | 验证 | 半小时级，确认分发可行性 |
| 6 | [#6](../../issues/6) 熔断器 | 新功能 | 接入前的安全网 |
| 7 | [#7](../../issues/7) 接入 ctx.subprocess | 新功能 | 真正产生价值的一步 |
| 8 | [#8](../../issues/8) 签名分发 | 新功能 | P2，视是否团队分发 |

## 依赖关系

```
#2 control pipe ──┬── #4 竞态
                  │
#3 零泄漏 ────────┤
#9 测试基线 ──────┤
#5 依赖检查 ──────┤
                  ↓
            #6 熔断器 ──→ #7 接入 ──→ #8 签名分发
```

- **#4** 依赖 **#2**（竞态用例要覆盖 control 终止路径）
- **#6** 不依赖 **#2**：它判断的是「启动失败 / 协议错误」，与 control channel 无关
- **#7** 依赖 #6 + #2/#3/#4/#5/#9 全部关闭

> 线上 #7 原写「依赖 #1 熔断器」是笔误 —— #1 是 Tracker，熔断器是 **#6**。

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

2. **`resolveWindowsExecutable` 已逐项核对一致（2026-11-01 复核）**
   曾一度怀疑 AOT 缺「applicationName 目录作为额外搜索根」的回退。复核
   `runner-launch-*.js:1485` 源码后确认：**DSH 本身就没有这条回退**，
   搜索根只有 `[""]`（cwd）+ PATH。实测裸名在两种 runner 下的
   ENOENT 行为与错误文本完全一致，无缺口。
   早先观察到的差异是探测脚本把 cwd 传成 glob 模式导致的 runner 启动失败，
   属测量伪迹。

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

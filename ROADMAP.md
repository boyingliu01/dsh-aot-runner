# 路线图

> 本文件与 GitHub Issues 保持同步。**Issue 是唯一事实来源**，
> 这里只是给不看 Issue 的人一份概览。
>
> 仓库：https://github.com/boyingliu01/dsh-aot-runner

## 当前性能（真实 IPC 协议，2026-11-02 实测）

| 实现 | p50 | p95 |
|---|---|---|
| 原生地板（`hostname`） | 116ms | 394ms |
| node runner（现状） | 796ms | 1175ms |
| **AOT runner** | **346ms** | **664ms** |

**每次调用净省 450ms，消除 66.2% 的 runner 开销。**

> 早先记录的 59.6% 是在旧测试布局下测得的（AOT 走 stdin NDJSON）。
> Issue #11 对齐协议后重测，数字更有说服力 —— 现在测的是 host 真正会走的路径。

**A/B 验证：28/28 通过**（stdout/stderr/exitCode/错误对象字节级一致）。
两侧现在使用**相同的真实 host 布局**，这是 A/B 可比的前提。

## 阶段状态

| 阶段 | 状态 | Issue |
|---|---|---|
| S0 可行性验证 | ✅ 完成 | — |
| S0b Node IPC 协议对齐 | ✅ 完成 | [#11](../../issues/11) 阶段 A |
| S1 NativeAOT 最小实现 | ✅ 完成 | — |
| S1b 依赖检查 | ✅ 完成 | [#5](../../issues/5) |
| S1c 签名分发 | ⏸ 推迟（自用无证书） | [#8](../../issues/8) |
| S2 功能对齐 | ✅ 完成 | — |
| S2b 性能实测 | ✅ 完成 | — |
| S3 语义完备 | ✅ 完成 | [#2](../../issues/2) [#4](../../issues/4) |
| S4 A/B 验证 | ✅ 完成 | — |
| S5 泄漏/混沌 | ✅ 完成 | [#3](../../issues/3) |
| S6 接入 `ctx.subprocess` | ✅ 完成 | [#11](../../issues/11) 阶段 B |

## 已完成（本轮先后顺序）

按「先修缺陷，再增功能」执行，全部已关闭：

| Issue | 内容 | 关键产出 |
|---|---|---|
| [#2](../../issues/2) | control pipe | target 能拿到 fd 7；3 条 A/B 用例 |
| [#3](../../issues/3) | 零泄漏回归 | 100 次连续调用 + 混沌，7/7 |
| [#9](../../issues/9) | 收紧测试基线 | 错误对象结构化断言（`code`/`syscall`/`path`）|
| [#4](../../issues/4) | terminate 竞态 | 5/5，含 60 轮交替 |
| [#5](../../issues/5) | 依赖检查 | 无 VC++/.NET 运行时依赖 |
| [#10](../../issues/10) | 正式开发环境 | `build.sh --check/--test`、Trace、文档 |
| **#11 阶段 A** | **Node IPC 协议对齐** | **runner 首次可被真实 host 调用** |
| **#11 阶段 B** | **插件 + 熔断器** | **可通过配置启用，失败自动降级** |

## Issue #11 阶段 B（已完成）

| 任务 | 状态 | 说明 |
|---|---|---|
| B-1 插件骨架 | ✅ | `plugin/` 包，`internals.runnerInvocation` 指向 AOT exe |
| B-2 配置开关 | ✅ | `enabled` / `runnerPath` / `failThreshold` / `verbose` |
| B-3 熔断器 | ✅ | 连续失败达阈值自动降级；成功清零；target 非零退出不误判 |
| B-4 端到端验证 | ✅ | 插件 + 真实 `LocalSubprocessRuntime` 跑通（2 条 e2e） |

用法见 [`plugin/README.md`](plugin/README.md)。

安装方式（profile 的 `package.json`）：

```json
{
  "dependencies": {
    "@boyingliu01/dsh-aot-runner": "link:D:/projects/dsh-aot-runner/plugin"
  },
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "@boyingliu01/dsh-aot-runner"]
    }
  }
}
```

插件默认 `enabled: false`，需在 profile 里显式打开。

## 已知盲区

**切帧丢数据类缺陷测不出来。** 见
[`test/ipc-verify.js`](test/ipc-verify.js) 的注释与 Issue #11：

- 现象：把「切出一帧后丢弃缓冲区剩余数据」注入 `IpcChannel.TryTakeFrame`，
  IPC 用例仍然全绿。
- 原因：Node 发送端的排队行为使多条帧很少落在同一次 `ReadFile` 里。
  试过小帧连发 / 大帧+小帧 / 256KB 噪声帧+terminate+start，都构造不出来。
- 解法（未实施）：runner 侧加一个测试接缝，可注入「一次读返回多帧」。

## 依赖关系

```
#11 阶段 A（Node IPC 对齐）✅
        ↓
#11 阶段 B-1 插件骨架
        ↓
#11 阶段 B-2 配置开关 ──→ B-3 熔断器 ──→ B-4 端到端验证
                                              ↓
                                    #8 签名分发（推迟，自用无证书）
```

## v2.0.0 验收标准

- [x] 所有 P0/P1 issue 关闭（#8 因无证书主动推迟，不计入）
- [x] `npm test` 全绿且用例数 ≥ 24（现 28；全套件合计 56）
- [x] S5 零泄漏回归 100 次连续通过
- [x] AOT runner 实现与 host 相同的 Node IPC 协议
- [x] 已接入 `ctx.subprocess`，可通过配置开关回退到 node runner
- [x] 熔断器覆盖「AOT 启动失败自动降级」路径（单元层验证）
- [ ] 在真实 DSH 会话里验证并量化收益（插件已能在真实 runtime 下跑通，
      但尚未在日常使用中长时间观察）
- [ ] ~~CI 在 GitHub Actions 上跑通构建 + 测试~~ —— **已明确不做**

> **CI 决策（2026-11-01）**：暂不搭建 CI，先把**本地**开发环境做扎实。
> 理由：NativeAOT 依赖重量级 MSVC 工具链（GitHub runner 上要现装 VS Build Tools + LLVM），
> 且 A/B 套件需要真实可用的 python/pwsh/bash/git，在托管 runner 上逐个确认成本高。
>
> 已用**本地质量门禁**替代（`./build.sh --check`）：C# 格式 + 0 警告静态检查 + JS 语法。
>
> **补充（2026-11-02）**：现在有 `test/host-path-verify.js`
> 直接驱动真实 `LocalSubprocessRuntime`，这比 CI 更能说明「能被 host 用起来」。

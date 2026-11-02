# 路线图

> 本文件与 GitHub Issues 保持同步。**Issue 是唯一事实来源**，
> 这里只是给不看 Issue 的人一份概览。
>
> 仓库：https://github.com/boyingliu01/dsh-aot-runner

## 当前性能（真实 IPC 协议，2026-11-02 分两层实测）

### 可信轮次（离散度 < 10%）

| 实现 | p50 | p99 | runner 开销 |
|---|---|---|---|
| 原生地板（`hostname`） | 32~36ms | — | — |
| node runner（现状） | 238~250ms | 331~393ms | 198~217ms |
| **AOT runner** | **109ms** | **173~220ms** | **69~76ms** |

**消除 65.0% 的 runner 开销（可信两轮 64.8% / 65.0%），每次净省 130~141ms。**

### p99 长尾（比 p50 更影响体感）

| | node | AOT | 改善 |
|---|---|---|---|
| p99 | 331~393ms | 173~220ms | **131~206ms** |

交互式使用时，偶发一次 400ms 比平均快 130ms 更影响体验 —— AOT 的长尾明显更短。

### 稳定性

120 次连续调用：**0 失败**，RSS 52.6 → 54.7MB，无累积增长。

> **关于数字口径**：早先记录的「796ms → 346ms，省 450ms，66.2%」是空闲环境下
> 单轮测得；本次在有真实负载下分层测、并做离散度判定。
> 绝对值受机器状态影响较大，**收益比例才是稳定指标**：手工驱动测得 64.8%~66.0%，
> 生产路径（走 DSH 真实 launchWindowsJob）测得 **59.1%~59.6%**，两者差的是 DSH 自身固定开销。
> 详见 [`docs/性能对比测试报告.md`](docs/性能对比测试报告.md)。

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
| S7 性能对比验证 | ✅ 第一层+第二层完成，第三层进行中 | — |

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

### 当前安装状态（2026-11-02）

已装到本机 `web` profile 并启用：

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml
- id: aot-runner
  config:
    enabled: true
    failThreshold: 3
    verbose: true
```

> **注意**：覆盖已有条目只需写 `id` + 要改的字段。
> 用 `insert:` 会让同一个 id 出现两条 —— **DSH 不报错但配置不生效**（静默失败）。
> 改完用 `dsh --profile web --dump-config | grep -A5 aot-runner` 验证，
> 期望看到 `patched by` 字样。

回退：把 `enabled` 改回 `false`，新会话即走 node runner。
熔断器会在连续 `failThreshold` 次 runner 失败时自动降级。

### ⚠️ 当前依赖一个上游补丁（2026-11-02）

**插件在 DSH 0.2.0-rc.2 原版下不生效** —— 原因在 DSH 自身，不在插件：

`LocalSubprocessRuntime.spawn()`（`lib/index.js:1368`）调用
`launchWindowsJob(spec, env)` / `launchLinuxScope(spec, env)` 时**漏传第三个参数
`internals`**，导致 `launch*` 内部 `internals` 恒为 `{}`，
`internals.runnerInvocation` 被完全忽略。

已提交上游：
[deepseek-ai/deepseek-harness#11893](https://github.com/deepseek-ai/deepseek-harness/discussions/11893)

**本地临时补丁**（1 行，语义等价于上游修好后的样子）：

```diff
-  ... ? launchLinuxScope(spec, env) : launchWindowsJob(spec, env), binding);
+  ... ? launchLinuxScope(spec, env, internals) : launchWindowsJob(spec, env, internals), binding);
```

文件：`C:\Users\think\.workbuddy\binaries\node\workspace\node_modules\@deepseek-ai\dsh-subprocess-local\lib\index.js`

**工具的原始备份与补丁工具都在 [`vendor/`](vendor/README.md)**（不依赖 `/tmp`，`/tmp` 被清理也不怕）：

```bash
node vendor/patch-dsh.mjs status   # 查看状态（已打补丁 / 原始 / 未识别）
node vendor/patch-dsh.mjs apply    # 打补丁
node vendor/patch-dsh.mjs revert   # 还原（md5 精确回到原始）
node vendor/patch-dsh.mjs verify   # 校验留档未被篡改
```

- **DSH 升级或重装依赖会被覆盖**，届时跑 `status` 重新判断
- 若 `status` 显示「未识别的代码形状」，先看上游是否已修复，**别急着 apply**
- 检查是否仍生效：看子进程命令行里是 `runner.js` 还是 `dsh-aot-runner.exe`
- 上游修复后：**删掉整个 `vendor/` 目录**

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
- [x] 性能对比验证第一层（隔离基准，可信轮次 65.0%）+ 第二层（真实负载，p99 改善 131~206ms）
- [ ] 性能对比验证第三层（headless profile 里装插件实跑）
- [ ] 在真实 DSH 会话里长跑观察（插件已能在真实 runtime 下跑通，
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

---

## 质量门禁对齐（xp-gate v0.35.23）

对照 xp-gate 全量扫描结果做了一轮系统性整改。

### 已完成

| 项 | 之前 | 现在 |
|---|---|---|
| Gate 0 版本一致性 | VERSION 1.0.0 / tag v0.1.0 不一致 | 四处统一 0.1.0，`scripts/check-version.mjs` 接入构建 |
| Gate 1 代码质量 | 无 eslint 配置，工具报错即退出 | `eslint.config.mjs`（flat config），抓到并修掉 3 个真实缺陷 |
| C# 圈复杂度 | 4 个函数 CCN > 10（最高 22），**无人发现** | 全部 ≤ 10 |
| Gate 4 长函数 | 5 处（最长 147 行） | 全部 ≤ 50 行 |
| Gate 4 深嵌套 | 5 处（最多 7 层） | 全部 ≤ 4 层 |
| Gate 5 覆盖率 | 无覆盖率工具 | c8，实测 语句 88.8% / 分支 69.4% / 函数 83.3%，门槛接入构建 |
| Gate 2 重复代码 | 16 处克隆 | 1.93%（9 处，均在测试夹具内） |
| Gate 6 架构 | Long Parameter List 1 处 | 清零，7.5/10 |

### 关键发现：xp-gate 看不见 C#

`lib/language-tools.js` 没有 C# 适配器（`arch.js` 里有 `.cs → csharp`，两者不一致），
所以 Gate 1/3/5/9/13 对 C# 一律**静默跳过**，输出「无源文件」——

**看起来是通过，实际是没检查。**

本项目主体恰恰是 C#（2031 行）。拿 lizard 手工扫才发现有 4 个函数 CCN 严重超标。

已提 issue 说明根因与修复建议：<https://github.com/boyingliu01/xp-gate/issues/717>

> 结论：**在 xp-gate 支持 C# 之前，`build.sh --check` 里的 `dotnet format` +
> `-warnaserror` 才是 C# 质量的实际保障**，不能依赖 xp-gate 的绿灯。

### 仍未处理

- **Gate 11 Sprint Flow**：项目未走 sprint-flow 流程，无 `.sprint-state/`。
  当前是单人维护的小规模迭代，引入 sprint 状态的收益不抵成本。
- **魔法数字 108 处（info 级）**：多在测试/基准里作为超时、退出码、采样次数，
  提出成常量反而降低可读性（`timeout: 300000` 比 `LONG_TIMEOUT` 更直观）。
  该项不在 `gate-rules` 的阻断清单内，保持现状。
- **archlint 的 3 处 Dead Code 误报**：`scripts/check-version.mjs` 等由 `build.sh`
  以子进程方式调用，没有 import 关系，被静态分析判为死代码。

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
    "@boyingliu01/dsh-aot-runner": "link:C:/path/to/dsh-aot-runner/plugin"
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

#### 版本兼容矩阵（每次 DSH 升级后复核并回填）

复核方法（不靠猜，直接拆 npm 包）：

```bash
npm pack @deepseek-ai/dsh-subprocess-local@<版本>
tar -xzf *.tgz
grep -nE "launch(WindowsJob|LinuxScope)\(" package/lib/index.js
# 唯一调用点若形如 launchWindowsJob(spec, env) 且函数签名有 internals 形参 → 仍需补丁
```

| DSH 版本 | subprocess-local | 需要补丁 | 复核日期 | 证据 |
|---|---|---|---|---|
| 0.2.0-rc.2 | 0.2.0-rc.2 | **是** | 2026-11-02 | 原始发现，见上 |
| 0.2.2-rc.1 | 0.2.2-rc.1 | **是** | 2026-11-10 | 拆包复核：第 1560 行两处调用均不传 `internals`；函数签名第 563/769 行都有该形参 |

> ⚠️ **别用 `npm view` 的 `latest` 标签判断版本。**
> `@deepseek-ai/dsh-subprocess-local` 的 `latest` 指向 `0.0.1-rc.1`
> （比 `next` 的 `0.2.2-rc.1` 更旧），而 DSH 的各个子包是**固定版本**依赖，
> 不是范围依赖。看 `dist-tags` 会得出「版本回退」的错误结论。

> ⚠️ **上游已关闭 issues/PR 功能**（`has_issues=false`，2026-11-04 起），
> 提交 PR 会 404。反馈只能走
> [discussion #11893](https://github.com/deepseek-ai/deepseek-harness/discussions/11893)，
> 讨论区仍在活跃维护。**不要再尝试开 PR 催修。**

#### 契约漂移自动检测（issue #15）

上面的矩阵靠人记得去复核。`scripts/contract-fingerprint.mjs` 把这件事自动化的部分接管了。

它从**实际安装的 DSH 源码**机械提取 4 条契约，生成 SHA256 指纹存入
`.contract-fingerprint.json`。DSH 升级后指纹变了就报警，此时才需要人判断。

| # | 契约 | 来源 |
|---|---|---|
| 1 | start 请求字段集 `{type, cwd, env}` + 可选 `control` | `parseWindowsStartRequest` |
| 2 | `WINDOWS_SPAWN_ERROR_CODES` 映射 | `runner.js` |
| 3 | 候选扩展名 `.com`/`.exe`（**顺序有语义**）+ 搜索顺序 | `windowsExecutableNames` |
| 4 | `runnerStdio` 的 fd 布局（fd 3 = ipc） | `runnerStdio` |

```bash
npm run contract          # 对比，漂移则退出码 1
npm run contract:update   # 确认影响后更新基线
```

已接入 `.githooks/pre-commit` 第 1.5 段：改动涉及 `src/`、`tests/`、`plugin/lib/`
或指纹文件时自动跑。

**设计要点：提取失败必须报错，不能当成"没漂移"。**

这个选择不是洁癖 —— 提取失败恰好发生在**上游改了源码结构**时，
也就是最需要它工作的时刻。如果那时它说"契约未漂移"，检测就完全失效了。

写这个脚本时踩了两次坑，都是同一类错误：

- 第一版在全文找第一个 `hasExactKeys(...)`，抓到的是 runner 的 **error 结果**
  结构 `["name","message"]`，不是 start 请求。指纹照常生成、照常打印"已保存"，
  但**它保护的是错误的东西**。
- 第一版找 `resolveWindowsExecutable` 里的 `".exe"` 字面量，一个都没找到 ——
  实际扩展名是在辅助函数里用模板字符串拼的（`` `${command}${separator}exe` ``）。

两次都是"命令跑起来了但没测到东西"。现在每个提取器都带自校验
（例如 start 字段必须含 `type`/`cwd`/`env`），不满足就拒绝保存基线。

## 已知盲区

**切帧丢数据类缺陷测不出来。** 见
[`test/ipc-verify.js`](test/ipc-verify.js) 的注释与 Issue #11：

- 现象：把「切出一帧后丢弃缓冲区剩余数据」注入 `IpcChannel.TryTakeFrame`，
  IPC 用例仍然全绿。
- 原因：Node 发送端的排队行为使多条帧很少落在同一次 `ReadFile` 里。
  试过小帧连发 / 大帧+小帧 / 256KB 噪声帧+terminate+start，都构造不出来。
- 解法（未实施）：runner 侧加一个测试接缝，可注入「一次读返回多帧」。

**测试主机偶发 CLR 运行时崩溃（`0x80131506`）。** 见 Issue #25：

- 现象：`dotnet test` 偶发以 `Fatal error. Internal CLR error. (0x80131506)` 结束
  （`COR_E_EXECUTIONENGINE`），VSTest 报成非零退出，门禁显示为「测试失败」。
- 复现率：约 1/10～1/300（连续多轮观察）；单轮 319 项全绿说明不了问题。
- **已排除**：AOT/裁剪（`PublishAot=false`，全仓零 `decimal`）、
  `KillTree` 路径（`39e246d` 已改掉）、测试并行（`a2233d5` 已关闭）、
  xunit 版本冲突（nuspec 无交叉依赖）。
- **采集方式无关**：A/B 实验（`bench/coverlet-crash-ab.js`）对比
  coverlet 进程内 profiler 与 `dotnet-coverage` 外挂采集，
  A 组 0/18、B 组 3/14，p = 0.47～1.00 —— **方向与"coverlet 相关"相反且不显著**。
- **已缩小到的范围**：崩溃栈集中在 xunit 的 `TestInvoker<T>` 泛型实例化路径
  （`CreateTestClass` → `UniqueIDGenerator` → `AsyncTaskMethodBuilder<Decimal>`），
  发生在第 214/319 个测试附近。`System.Decimal` 在栈里出现 5 次，
  而项目零 Decimal 使用 —— 那是 xunit 内部泛型类型参数。
  三条历史崩溃栈看似无关，实际都经过这条路径。
- **已缓解**：xp-gate 的 `adapters/csharp.sh` 已加入崩溃识别 + 单次重试
  （两次都崩仍然失败，不会掩盖问题）。见 xp-gate #794。
- 剩余方向：`--blame-crash` 配合连续多轮抓 dump，用 `dotnet-dump analyze`
  确认是否为类型加载/泛型实例化耗尽。

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

### 曾经的坑：xp-gate 看不见 C#（已修，2026-11-10 复核）

> **这条结论已经过期，保留是为了记录它当初为什么不便宜。**
> 下面原「结论」段里「不能依赖 xp-gate 的绿灯」现在不成立，别照做。

当时的现象：`lib/language-tools.js` 没有 C# 适配器（`arch.js` 里有 `.cs → csharp`，两者不一致），
所以 Gate 1/3/5/9/13 对 C# 一律**静默跳过**，输出「无源文件」——

**看起来是通过，实际是没检查。**

本项目主体恰恰是 C#。拿 lizard 手工扫才发现有 4 个函数 CCN 严重超标。

已提 issue 说明根因与修复建议：<https://github.com/boyingliu01/xp-gate/issues/717>

**现在（2026-11-10 复核）**：#717 已 closed，`adapters/csharp.sh` 已落地并安装到
`~/.config/xp-gate/adapters/csharp.sh`（360 行）。实测同一笔提交的门禁输出：

```
→ Gate 1: Code Quality
   ── Checking csharp ──
   FORMAT OK - dotnet format reports no changes required
   ✅ PASSED - Language-specific code quality checks.
→ Gate 5: Tests & coverage
   dotnet test → 已通过! 失败: 0，通过: 319，总计: 319
   csharp coverage: 97% ✅ (≥ 80%)
→ Gate 13: Compiler Strictness   PASS
```

C# 现在确实被检查了。**`build.sh --check` 与 xp-gate 是双保险，不是唯一保障** ——
两者都保留：`--check` 不依赖全局安装状态，CI 里也跑，是最小可复现的那一层。

> 教训：这条记录的价值在于「绿灯不等于检查过」这个判断方法。方法没过期，
> 只是这次的答案是「确实检查了」。所以改的是结论，不是方法。

### 仍未处理

- **Gate 11 Sprint Flow**：项目未走 sprint-flow 流程，无 `.sprint-state/`。
  当前是单人维护的小规模迭代，引入 sprint 状态的收益不抵成本。
- **魔法数字 108 处（info 级）**：多在测试/基准里作为超时、退出码、采样次数，
  提出成常量反而降低可读性（`timeout: 300000` 比 `LONG_TIMEOUT` 更直观）。
  该项不在 `gate-rules` 的阻断清单内，保持现状。
- **archlint 的 3 处 Dead Code 误报**：`scripts/check-version.mjs` 等由 `build.sh`
  以子进程方式调用，没有 import 关系，被静态分析判为死代码。

---

## 待确认

**✅ 已于 2026-11-04 重启 DSH 后验证通过。**

用户确认：侧栏「插件」菜单能列出 `@boyingliu01/dsh-aot-runner`，
点开后下方有对应的状态说明 —— 客户端 bundle 加载成功，
`plugins.row.config` 挂载点正确。

同时复核了运行态：AOT runner 子进程的父进程是新的 DSH 主进程（PID 5336），
说明插件在新会话里正常接管了子进程调用。

下面保留排查记录，供将来 DSH 升级后若出现回归时对照。

### 1. 插件管理页里的状态卡片能否显示

**验证方式**：重启 DSH → 侧栏「插件」→ 点开 `@boyingliu01/dsh-aot-runner` → 看详情页里有没有状态区。

**预期**：显示配置开关、loader 状态、exe 路径、熔断阈值，
配置正常时顶部是绿色「已启用」。

#### 已修正的一个错误（重要）

初版把卡片挂在 `settings.plugin.item` 上，**那个 slot 在 DSH 0.1.7-rc.2 之前就废弃了**，
官方 0.2.0-rc.2 安装里根本不存在它。证据来自两个第三方插件的源码注释：

- `@goodandready/dsh-context-lens/lib/client.js:612`
  > "settings.plugin.item was retired before DSH 0.1.7-rc.2 — one occurrence
  > in the whole 0.1.7-rc.2 tree against 54 of plugins.item"
- `dsh-fonttune/lib/client.js:13835`
  > "settings.plugin.item — up to 0.1.5-rc.x"

改用官方当前在用的 **`plugins.row.config`**（`dsh-client-ui-plugin-manager`
自己就在渲染它），key 格式 `<包名>#<行 id>`，与 DSH 的 `rowConfigKey()` 一致。

> 教训：找 DSH 的 slot 名不能只看「某个第三方插件在用」，
> 要看**官方当前版本有没有在渲染它**。第三方插件里可能残留历史注册。

**如果卡片仍不出现**，按这个顺序排查：
1. 浏览器控制台有没有 `client-modules:` 开头的报错
2. `plugins.row.config` 的 key 格式是否为 `@boyingliu01/dsh-aot-runner#aot-runner`
3. 备选挂载点：`plugins.bundle.config`（按包名，key = 包名）

**影响范围**：**只影响卡片显示，不影响 AOT runner 本身**。
插件加速功能早就验证过（AOT 子进程父进程确认为 DSH 主进程），
最坏情况是卡片看不到，加速照常工作。

### 2. 客户端 bundle 的加载路径

`plugin/package.json` 新增了：

```json
"exports": { "./client": { "default": "./client/index.js" } },
"dsh": { "client": { "inject": ["@deepseek-ai/dsh-client-ui-settings"], "platform": "web" } }
```

已静态核对符合 DSH 的 `client-modules` 契约（`exports["./client"]` 需为字符串
或带 `default` 的对象）。

**✅ 实测确认**：重启后插件管理页出现状态说明，说明 DSH 确实加载了该 bundle，
`exports["./client"]` 与 `dsh.client` 声明都被正确识别。

---

## 归档状态（2026-11-04）

本任务已归档。交付内容：

- NativeAOT runner 替换 DSH 子进程 runner，实测每次省 92~94ms（约 59%）
- 插件形态接入，带熔断降级与启动自检
- 71/71 测试通过，本地质量门禁全绿
- 已发版 `v0.1.0`，仓库 **private**

**归档时的 open issue 只剩 #12**（累积长期观测数据），属于持续性工作，
不影响使用，择机跑即可。

**遗留的前置依赖**：xp-gate 尚不支持 C#（[issue #717](https://github.com/boyingliu01/xp-gate/issues/717)），
主体代码缺少自动化的复杂度/测试/构建门禁覆盖。等上游支持后另起任务重构。

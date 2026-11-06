# @boyingliu01/dsh-aot-runner

把 DSH 的 Node.js 子进程 runner 换成 **NativeAOT 原生可执行文件**，
消除约 **63~67%** 的 runner 开销。

> ## ⚠️ 安装前必读：需要一行上游补丁
>
> 在 DSH **0.2.0-rc.2** 上，本插件**必须配合一个 1 行的上游补丁**才能生效。
>
> 原因是 DSH 的传参缺陷：`LocalSubprocessRuntime.spawn()` 调用
> `launchWindowsJob()` / `launchLinuxScope()` 时漏传 `internals` 参数，
> 导致所有基于 `internals` 的注入被静默忽略 —— **包括本插件**。
>
> **不打补丁的后果**：插件会自检到该缺陷，明确告警并**主动停用自己**（不会假装在工作）。
> 此时子进程仍走 node runner，功能正常，只是没有加速。
>
> **怎么做**：见仓库 [`vendor/README.md`](../vendor/README.md)，
> 核心命令是 `node vendor/patch-dsh.mjs apply`。
> 上游修复（[discussion #11893](https://github.com/deepseek-ai/deepseek-harness/discussions/11893)）后，删除整个 `vendor/` 目录即可。

## 效果

分两层实测，只报**离散度 < 10% 的可信轮次**：

| 实现 | p50 | p99 | runner 开销 |
|---|---|---|---|
| 原生地板（`hostname`） | 32~36ms | — | — |
| node runner（默认） | 238~250ms | 331~393ms | 198~217ms |
| **AOT runner（本插件）** | **109ms** | **173~220ms** | **69~76ms** |

消除约 **63~67%** 的 runner 开销，**p99 长尾改善 131~206ms**，
行为与 node 版一致（28 项 A/B 用例逐字节对齐）。

稳定性：120 次连续调用 0 失败，RSS 52.6 → 54.7MB 无累积增长。

> **关于口径**：绝对值随系统负载波动很大（同一台机器不同时段实测得到过
> 92ms / 116ms / 168ms / 197ms 的净差值）。**收益比例才是稳定指标** ——
> 独立测量结果为 64.1%、66.6%、63.5%，因此统一表述为「约 63~67%」。
> 完整数据见仓库 [`docs/性能对比测试报告.md`](../docs/性能对比测试报告.md)。

## 安装

### 第 1 步：确认已有 AOT 可执行文件

本包按 npm 发布时**自带** `bin/dsh-aot-runner.exe`（Windows x64），安装后即可用。

如果你是**从 git 仓库 clone 的**，`bin/` 不在版本库里（构建产物不入库），
需要先构建，或从 CI 的 artifact 下载：

```bash
./build.sh                     # 需要 .NET SDK + MSVC C++ 工具链
```

> 构建依赖：`.NET 8+ SDK` + **Visual Studio Build Tools 的 C++ 工作负载**
> （NativeAOT 在 Windows 上强制要求 MSVC 链接器 `link.exe`）。
> 只装 .NET SDK 是不够的 —— 这是最容易踩的坑。

### 第 2 步：打上游补丁（必读，见顶部说明）

```bash
node vendor/patch-dsh.mjs status   # 先看当前状态
node vendor/patch-dsh.mjs apply    # 需要时打补丁
```

### 第 3 步：安装插件

```bash
dsh plugin add <插件所在目录>
```

或在 profile 的 `package.json` 里用 **link 指向你本机的绝对路径**
（把下面的路径换成你实际 clone 的位置）：

```json
{
  "dependencies": {
    "@boyingliu01/dsh-aot-runner": "link:C:/path/to/dsh-aot-runner/plugin"
  }
}
```

> 从 npm 安装时直接写版本号即可：`"@boyingliu01/dsh-aot-runner": "^0.2.0"`

然后在 profile 的 `cordis.patch.yml` 里启用：

```yaml
# ~/.dsh/profiles/<name>/cordis.patch.yml
- id: aot-runner
  config:
    enabled: true
```

**注意不要用 `insert:`** —— 插件的 `cordis.patch.yml` 已经注册了这条，
再用 `insert` 会让同一个 id 出现两次（DSH 不报错，但配置不生效）。
覆盖已有条目只需写 `id` + 要改的字段，DSH 会显示 `patched by` 表示合并成功。

验证配置是否生效：

```bash
dsh --profile <name> --dump-config | grep -A 5 aot-runner
# 期望看到：== @boyingliu01/dsh-aot-runner, patched by .../cordis.patch.yml
#           config:
#             enabled: true
```

## 配置

**通常不需要改任何配置。** 启用/停用请用 DSH 侧栏的「插件」页面，
那里有官方开关，切换后即时生效并持久化。

下面的字段是给你排查问题、或做特殊部署时用的。

| 字段 | 类型 | 包内默认 | 说明 |
|---|---|---|---|
| `enabled` | boolean | **`false`** | 插件内部开关。**包内默认 false = 装上不生效**，避免装上就接管子进程 |
| `runnerPath` | string | 自动 | AOT exe 路径；省略时用包内 `bin/` |
| `failThreshold` | number | `3` | 连续失败多少次触发降级 |
| `verbose` | boolean | `true` | 是否打印降级/恢复日志 |

### 两个开关，作用不同层

| 开关 | 在哪 | 作用 |
|---|---|---|
| **loader 开关** | DSH 侧栏「插件」页面 | 整行插件卸载，代码根本不加载 |
| **`config.enabled`** | `cordis.patch.yml` | 插件加载了，但跳过注入，直接用 node runner |

日常用侧栏开关就够了。`config.enabled` 存在的意义是：**装完插件不自动接管**。
新装时包内默认 `enabled: false`，你确认要用了才在配置里打开。

> 开关切换不会丢配置：DSH 只改 loader 行的 `disabled`，`config` 原样保留。

**`runnerPath` 不静默回退**：写了路径但文件不存在，插件直接不生效并告警 ——
不会偷偷换成包内另一个 exe。理由是「猜你的意图」在排查问题时极其误导。

## 状态查看

DSH 设置页有 aot-runner 的状态卡片，显示：

- 当前是否生效，以及生效的 exe 路径
- 是否已熔断降级（连续失败次数）
- DSH 上游补丁是否已打（没打则插件会自动停用）

这些都是**只读**的。开关请用侧栏「插件」页面，两者不重复。

## 安全网

切换 runner 多了几类失败模式（杀软隔离、依赖 DLL 缺失、版本不匹配），
一旦发生会让**所有**子进程调用失败。所以有熔断器：

- 连续失败达到 `failThreshold` → 自动切回 node runner
- target 自己非零退出**不算**失败（那是正常业务结果）
- 熔断后**不自动恢复**：如果原因是 exe 被隔离，反复试探只会让每次调用慢一拍

## 原理

DSH 的调用链路是 `node.exe host → node.exe runner.js → target`。
中间的 runner.js 是纯转发进程，每次都要付 Node.js 的启动成本。

接入点是 `LocalSubprocessRuntime.internals.runnerInvocation`，
默认值 `[process.execPath, ".../runner.js"]` 换成 `[aotExe]` 即可 ——
**不需要改 DSH 源码**，因此升级 DSH 不会冲突。

AOT runner 实现了与 node runner **相同的 Node IPC 协议**（fd 3），
所以 host 侧无需任何改动。

## 已知限制

- 仅 Windows（x64）
- 需要 DSH ≥ 0.2.0（依赖 `internals.runnerInvocation` 这个测试接缝）
- **在 DSH 0.2.0-rc.2 上必须打上游补丁**（见顶部说明与 `vendor/README.md`），
  否则插件会自检到缺陷并主动停用
- 熔断降级的端到端验证尚未覆盖（见仓库 `test/e2e-plugin-verify.js` 的说明）

## 排查：装上但没生效？

按顺序检查：

1. **`config.enabled` 是否为 `true`** —— 包内默认是 `false`（装上不自动接管）
2. **上游补丁是否已打**：
   ```bash
   node vendor/patch-dsh.mjs status
   # 期望：状态: ✅ 已打补丁
   ```
3. **DSH 是否加载了插件**：`dsh --profile <name> --dump-config | grep -A5 aot-runner`
4. **exe 是否存在**：`runnerPath` 显式配置了错误路径时，插件会告警并不生效（不静默回退）

## 许可

MIT

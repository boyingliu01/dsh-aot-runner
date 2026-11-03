# dsh-aot-runner

DSH 子进程 runner 的 **NativeAOT 高性能实现**。用原生可执行文件替换 Node.js 版 runner，
每次子进程调用**省 92~94ms（约 59%）**，且行为与 Node 版在 28 个用例上字节级一致。

> ## ⚠️ 当前需要上游补丁才能生效
>
> 在 DSH **0.2.0-rc.2** 上，本插件**必须配合一个 1 行的上游补丁**才能工作。
>
> 原因是 DSH 的一个传参缺陷：`LocalSubprocessRuntime.spawn()` 调用
> `launchWindowsJob()` / `launchLinuxScope()` 时漏传 `internals` 参数，
> 导致所有基于 `internals` 的注入被静默忽略。
>
> - 缺陷报告：[deepseek-ai/deepseek-harness#11893](https://github.com/deepseek-ai/deepseek-harness/discussions/11893)
> - 补丁与说明：**[`vendor/README.md`](vendor/README.md)**
> - 插件会**自动检测**这个缺陷：命中时明确告警并停用自己，而不是假装在工作
>
> 上游修复后，删掉整个 `vendor/` 目录即可。

**协议状态**：AOT 版实现的是与 Node 版**相同的 Node IPC 协议**（fd 3），
可被真实 DSH host 直接调用。

> 📋 计划看 [ROADMAP.md](ROADMAP.md) ｜ 性能数据见 [docs/性能对比测试报告.md](docs/性能对比测试报告.md)
>
> 当前状态：**已可通过插件接入**（[`plugin/`](plugin/README.md)），
> 支持配置开关、熔断降级与启动自检。生产路径实测见下方「实测收益」。

---

## 为什么做这个

DSH 每启动一个子进程，链路是：

```
node.exe (dsh host) → node.exe runner.js -- <target> → target
```

中间那个 `runner.js` 每次都要重新加载 Node 运行时、解析模块、走一遍 IPC 握手。
profile 显示它单独贡献 **200–220ms** 的固定延迟 —— 比真正要跑的命令还慢。

把它换成 NativeAOT 编译的原生 exe 后，这部分降到 **69–76ms**。

### 实测收益

在**真实 DSH 的 `launchWindowsJob` 路径**上交替采样（3 轮 × 100 次）：

| 实现 | p50 | p99 | 离散度 |
|---|---|---|---|
| node runner（现状） | 156~158ms | 249~279ms | 11.7%~20.5% |
| **AOT runner** | **63~64ms** | **142~206ms** | **1.9%~4.1%** |

- **每次净省 92~94ms，比例稳定在 59.1%~59.6%**（三轮收敛，0 失败、0 输出不一致）
- **p99 长尾改善 73~124ms**
- 真实命令（`hostname` / `whoami` / `cmd /c echo`）每次省 **77~155ms**
- 稳定性：300 次连续调用 **0 失败**，RSS 53~61MB 有涨有落、非单调增长
- 熔断兜底：注入损坏 runner 时，连续 3 次失败后自动降级，第 4 次恢复正常

> **波动收窄也是收益**：node runner 的 IQR/中位数离散度是 11.7%~20.5%，
> AOT 是 1.9%~4.1%。对交互式场景来说，减少抖动比降低均值更重要。
> 更早的手工驱动测试（不经过 DSH 的 launch 路径）测得 64.8%~66.0%，
> 生产路径略低是因为多了 `bindManagedProcess`、Job Object、IPC 解析等
> 两侧都要付的固定开销 —— **绝对差值 92ms 比比例更有说服力**。

> **关于口径**：绝对值随系统负载波动很大（同一台机器连跑三次可得到
> 40.5% / 64.0% / 65.6%）。基准已内置**自动可信度判定**（离散度 > 10%
> 直接标 UNRELIABLE），**收益比例是稳定指标，绝对值不是**。
> 完整数据与方法见 [`docs/性能对比测试报告.md`](docs/性能对比测试报告.md)。

---

## 设计要点

### 调用契约严格对齐 `@deepseek-ai/dsh-subprocess-local`

Windows 下真实的 runner 调用是：

```js
spawn(command, [...prefix, "--", ...spec.argv], {
  cwd: process.cwd(),
  windowsHide: true,
  env: runnerEnvironment("windows", invocation),
  stdio: ["ignore", "ignore", "ignore", "ipc", stdinCarrier, stdout, stderr, control],
})
```

关键点：`stdio[3]=ipc`、`stdio[4]`=target stdin、`stdio[5]`=target stdout、
`stdio[6]`=target stderr、`stdio[7]`=control。

**AOT 版实现的是同一个 Node IPC 协议**（`stdio[3]`），不是自定义协议。
帧格式（实测确认）：

```
[8 字节 type (LE，恒为 1)][8 字节 payload 长度 (LE)][JSON payload + '\n']
```

`type` 不是序号 —— Windows 上 Node 走 uv_pipe + 阻塞 I/O，没有 sequence number；
`1 = NODE_HANDLE_NORMAL`，负值是内部帧（载荷不是 JSON，必须拒绝）。

start 请求字段被 `hasExactKeys` 严格校验为 `{type, cwd, env, control?}` ——
**多一个字段都会被拒绝**，这一点必须照抄。

> 历史注记：Issue #11 之前 AOT 用的是 NDJSON over stdin，与 host 完全不兼容。
> 现在 `--ndjson` 仅作为手工调试模式保留，生产路径只走 IPC。

### 进程创建（`CreateProcessW`）

| 项目 | 值 | 说明 |
|---|---|---|
| `lpApplicationName` | 解析后的绝对路径 | 裸名会让 CreateProcessW 用可疑的搜索顺序 |
| `lpCommandLine` | `msvcrt` 兼容加引号 | 见 `AppendQuoted` |
| `lpEnvironment` | 手工构造 UTF-16LE 块 | `CREATE_UNICODE_ENVIRONMENT` 要求双 `\0` 终止 |
| `lpCurrentDirectory` | 反斜杠规范化的路径 | 传 `"C:/"` 会得到 `ERROR_INVALID_PARAMETER(87)` |
| `dwCreationFlags` | `CREATE_SUSPENDED \| CREATE_UNICODE_ENVIRONMENT` | 先挂起，入 Job 后再 resume |

句柄必须用 `_get_osfhandle(4/5/6)` 取 —— `GetStdHandle(4)` 只会返回
`INVALID_HANDLE_VALUE`，因为它查的是标准句柄表（-10/-11/-12），不是 CRT fd 表。

### Job Object

用 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE (0x2000)`，`JobObjectExtendedLimitInformation`，
结构体 **144 字节**。runner 退出时整棵进程树一并回收。

### 可执行文件解析必须与 node 逐项对齐

node 的 `resolveWindowsExecutable` 规则（`runner-launch-*.js`）：

1. 候选扩展名**只有 `.com` 和 `.exe`**，且 **`.com` 优先** —— 不含 `.bat`/`.cmd`
2. 自带扩展名（点号后至少 1 字符）时，只检查原样文件名一次
3. 不含路径分隔符时先搜 cwd（受 `NODEFAULTCURRENTDIRECTORYINEXEPATH` 控制），再按 PATH
4. 全部候选不存在 → **ENOENT**，而不是把裸名丢给 CreateProcessW

> 第 1 条很反直觉但必须照做：`npm` 只有 `npm.cmd`，如果 AOT 版自作主张补
> `.cmd`，就会出现「node 报 ENOENT、AOT 能跑」的分歧。**行为一致优先于看起来更聪明。**

错误对象同样逐项对齐：

```js
// WINDOWS_SPAWN_ERROR_CODES
2 → ENOENT, 3 → ENOENT, 267 → ENOENT, 5 → EPERM, 193 → EFTYPE, 740 → EACCES
// NODE_SPAWN_DETAIL_CODES: 只有 EACCES/ENOENT 把程序名写进 syscall 和 path
```

---

## 快速开始

### 前置

- .NET 8 SDK（含 NativeAOT 工具链，即 MSVC 链接器）
- Node.js 22+
- 本机安装 DSH（A/B 验证需要 `@deepseek-ai/dsh-subprocess-local` 作为基线）

详细的工具链版本、验证命令与故障排查见 **[docs/开发环境.md](docs/开发环境.md)**。

### 构建

```bash
./build.sh                 # 增量构建
./build.sh --check         # 只跑质量门禁（格式 + 静态检查 + JS 语法）
./build.sh --clean         # 清理后重建
./build.sh --test          # 构建 + 跑完整回归（60 项）
./build.sh --all           # 质量门禁 + 清理重建 + 测试 + 基准
./build.sh --out <目录>    # 指定产物目录
```

### 装到 DSH（插件方式）

**前提**：先按 [`vendor/README.md`](vendor/README.md) 打上游补丁 ——
不打补丁的话，插件启动自检会发现并自动停用（这是刻意设计，避免「装了却没效果」）。

```bash
# 1. 构建产物（会自动同步到 plugin/bin/）
./build.sh

# 2. 检查补丁状态
node vendor/patch-dsh.mjs status

# 3. 在 DSH profile 里注册插件（示例：web profile）
#    ~/.dsh/profiles/web/package.json 的 dependencies 加：
#      "@boyingliu01/dsh-aot-runner": "link:<仓库绝对路径>/plugin"

# 4. 在 profile 的 cordis.patch.yml 里启用
#    - id: aot-runner
#      config:
#        enabled: true
```

> **注意**：覆盖已有条目只需写 `id` + 要改的字段。
> 用 `insert:` 会让同一个 id 出现两条 —— **DSH 不报错但配置不生效**（静默失败）。

详细配置项见 [`plugin/README.md`](plugin/README.md)。

产物默认落在仓库内 `dist/dsh-aot-runner.exe`。构建前会自动做
**Low Integrity 目录自检**（见下文「重要陷阱」），命中 Low IL 会直接中止而不是产出一个跑不起来的 exe。

### 手动构建

```bash
dotnet publish -c Release -r win-x64 -o dist
```

### 测试与基准

```bash
./build.sh --test          # 构建 + A/B（推荐）
npm test                   # 只跑 A/B，需先构建
node bench/d1-ab-bench.js  # 性能对比（单次测量）
```

#### 长期观测：判断优化值不值得继续投入

单次基准会被机器负载带偏——同一台机器连跑三次，收益比例 58.9% / 65.1% / 67.1%，
但离散度 48.9% / 22.5% / 25.4%，**三次全部不可信**。
`bench/aot-observe.js` 跑多轮、只采信可信轮次、把结果落盘成历史趋势：

```bash
npm run observe:check                    # 先看环境能不能测（CPU 高就别测）
npm run observe -- --rounds 5 --n 50     # 跑 5 轮 × 50 次，落盘
npm run observe:report                   # 看历史趋势与汇总
```

它**拒绝把不可信的数字平均一下当结论**：全部轮次离散度超限时，
输出 `UNRELIABLE` 且收益字段为 `null`，不会给出一个漂亮但虚假的比例。

**判据分两层**（2026-11-04 补充）：

| 判定 | 条件 | 给出什么 |
|---|---|---|
| `MEASURED` | 至少一轮单轮离散度 ≤ 10% | 绝对值 + 比例 |
| `GAIN_CONSISTENT` | 单轮全超限，但 ≥3 轮收益跨度 ≤ 5pp | **只有比例，绝对值为 `null`** |
| `UNRELIABLE` | 上述都不满足 | 什么都不给 |

第二层存在的理由：本机常态负载 50~75%（火绒 `HipsDaemon` + 常驻办公软件），
单轮离散度基本压不到 10% 以下。但**收益比例对负载不敏感**——
负载同时抬高 node 和 AOT 的绝对延迟，比值却保持稳定。
实测 6 轮为 60.7 / 63.2 / 62.9 / 64.1 / 61.7 / 65.0%（跨度 4.3pp）。

> 这一层刻意**不输出 `netMs` / `nodeP50`** —— 那些绝对值确实被污染了。
> 阈值也没有放水：实测有一轮跨度 8pp，被正确判为 `UNRELIABLE`。

> 观测时的一个反直觉现象：系统负载升高时，**node runner 的 p50 会明显漂移
> （221→249→263ms），而 AOT 的 p50 几乎不动（107→108→108ms）**。
> 也就是说 AOT 的价值不只是均值更快，更是**尾延迟和稳定性**——
> 这也解释了为什么收益比例比绝对值更适合作为判断指标。

一次真实的 `MEASURED` 记录（2026-11-04 11:12，CPU 36%）：

```
第 1 轮: node 209ms → aot 93ms  净省 116ms (64.1%)  离散度 7.2/1.3  可信
可信轮次: 1/5
净收益中位数: 116ms/次  (64.1%)
node p50 209ms → AOT p50 93ms，地板 28ms
```

A/B 需要两个 runner：AOT 产物与 node runner。两者路径自动解析：

| runner | 查找顺序 |
|---|---|
| AOT | `AOT_RUNNER` → 仓库内 `dist/dsh-aot-runner.exe` |
| node | `DSH_RUNNER` → `NODE_RUNNER` → 仓库 `node_modules` → `DSH_HOME` / `%USERPROFILE%/.workbuddy/binaries/node/workspace` |

找不到时测试会**明确报错并给出修复建议**，而不是静默跑空或拿一个过期二进制去比对。

---

## 质量门禁

`./build.sh --check` 跑三道检查，任何一道失败即非零退出：

| 门禁 | 实现 | 说明 |
|---|---|---|
| C# 代码格式 | `dotnet format --verify-no-changes` | 规则来自 `.editorconfig` + `.csharp-formatting.json` |
| C# 静态检查 | 编译期 analyzer | csproj 里 `TreatWarningsAsErrors=true`，**0 警告是硬约束** |
| JS 语法 | `node --check` | 测试与基准脚本 |

一键修复格式：`dotnet format`。


---

## ⚠️ 重要陷阱：Low Integrity 目录

**如果构建产物放在被标记为 `Mandatory Label\Low Mandatory Level` 的目录下，
产出的 exe 会跑不起来。**

症状：

```
bash: fatal error - NtCreateDirectoryObject(\BaseNamedObjects\msys-2.0S5-...): 0xC0000022
exit code = -1073741502
```

同时伴随：写 TEMP 被拒绝（`Access is denied`），但 cmd/python/pwsh 正常。

**原因**：DSH 的 Windows 沙箱（`@deepseek-ai/dsh-sandbox-windows-acl`）在
`workspace-write` 模式下会给工作目录打 Low IL 标签，且**退出时有意保留**
（源码注释：*"workspace ACEs stay standing as the reuse cache"*）。
从该目录启动的进程继承 Low IL 后：

- 无法创建 `BaseNamedObjects` 下的对象 → MSYS/Cygwin 程序（bash/ls/sh）崩溃
- 无法写 C 盘 TEMP（跨完整性级别写入被拒）

**诊断**：

```bash
icacls "D:\your\workspace" | grep -i "mandatory\|label"
# 出现 "Mandatory Label\Low Mandatory Level:(OI)(CI)(NW)" 就是它

# 或者直接用项目自带的自检脚本
./scripts/check-integrity.sh dist
```

**确认是路径问题而非代码问题的判据**：把**同一个 exe**（md5 不变）复制到
`%TEMP%` 下再跑，若恢复正常则确认。

**规避**：构建输出放到 Medium IL 目录。`build.sh` 在构建前会调用
`scripts/check-integrity.sh` 自检产物目录，命中 Low IL 直接中止并提示改用
`--out` 换目录，而不是产出一个跑不起来的 exe。

> 想彻底清除标签需要 `WRITE_DAC` 权限，而沙箱留下的 ACL 里
> `Authenticated Users` 只有 `(M)`，通常不够 —— 所以**规避比清除更实际**。

---

## 项目结构

```
.
├── DshAotRunner.csproj        # NativeAOT 配置 + 严格静态检查
├── build.sh                   # 构建 / 质量门禁 / 测试 / 基准 一键脚本
├── .editorconfig              # C# 格式规则
├── .csharp-formatting.json    # dotnet format 规则
├── src/
│   ├── Program.cs             # 入口 + 顶层异常兜底
│   ├── JobRunner.cs           # 核心：启动/监控/终止 target
│   ├── JobHandle.cs           # Job Object 封装
│   ├── Native.cs              # P/Invoke 声明
│   ├── Protocol.cs            # 协议 POCO
│   ├── ProtocolJson.cs        # 手写序列化（零反射）
│   └── Trace.cs               # 诊断日志（唯一写入口）
├── scripts/
│   └── check-integrity.sh     # Low IL 目录自检
├── test/
│   ├── runner-client.js       # 共享测试工具（真实 DSH 调用契约）
│   ├── ab-verify.js           # 28 项 A/B 字节级一致性验证
│   ├── ipc-verify.js          # Node IPC 协议回归
│   ├── host-path-verify.js    # 真实 host 调用路径
│   ├── e2e-plugin-verify.js   # 插件端到端
│   ├── leak-verify.js         # 零泄漏 / 混沌 / 探针自校验
│   ├── race-verify.js         # terminate 竞态
│   └── aot-observe-verify.js  # 观测器单元测试
├── plugin/
│   ├── lib/index.js           # 覆盖 internals.runnerInvocation
│   ├── lib/circuit-breaker.js # 熔断器（失败自动降级）
│   ├── bin/                   # 构建产物同步到这里
│   └── cordis.patch.yml       # 插件自注册
├── bench/
│   ├── d1-ab-bench.js         # 交错采样性能基准
│   └── aot-observe.js         # 多轮观测 + 双层可信度判据
└── docs/
    ├── 开发环境.md             # 搭环境、跑验证、故障排查
    ├── 测量方法论-当工具比被测对象更容易出错.md  # ⭐ 踩坑总结
    ├── 依赖清单.md
    ├── 方案-AOT接入DSH.md
    ├── 性能对比测试计划.md
    ├── 性能对比测试报告.md
    ├── 调研报告-JSON序列化与启动优化.md
    ├── S2b-性能实测报告.md
    └── S2-进展与阻塞.md
```

---

## ⭐ 先读这篇：测量方法论

[`docs/测量方法论-当工具比被测对象更容易出错.md`](docs/测量方法论-当工具比被测对象更容易出错.md)

这个项目最贵的两次误判，**都不是代码写错了，而是测量工具的隐含假设错了**：

| # | 假象 | 真实情况 | 发现方式 |
|---|---|---|---|
| 1 | JsonSerializer 慢 34× | 慢 2.4× | 严格同源 A/B，只改测量方式 |
| 2 | 零泄漏测试偶发失败 = runner 泄漏 | 基线竞态误报 | 单跑 vs 串行对比 |
| 3 | 6 轮全不可信 = 优化无效 | 比例稳定 64%，判据太窄 | 换指标维度 |
| 4 | bash 崩溃 = runner 缺陷 | 目录 Low Integrity 标签 | 同 md5 exe 换盘符测试 |
| 5 | npm 解析差异 = AOT 更聪明 | 与 node 行为不一致 | 逐行对照源码 |

> **5 条里有 4 条，第一直觉都指向了错误的方向。**

元规则：**当测量结果反复"不合理"时，把怀疑顺序倒过来 ——
先怀疑测量工具，再怀疑环境，最后才怀疑被测代码。**

这篇文档还给出了 6 条可复用规则（自校验、拒绝平均不可信的数、
差值比绝对值更稳、警惕未初始化基线等）和一份反模式清单。

---

## 技术决策记录

### 为什么手写 JSON 而不用 `JsonSerializer`

| 方案 | 体积 | 启动 |
|---|---|---|
| `JsonSerializer` + `JsonSerializerContext` | 1.74MB | 251ms |
| **手写 `JsonDocument`**（当前） | **1.20MB** | **105ms** |
| `Utf8JsonReader`（官方底层 API） | 1.36MB | ~90ms |

同为严格同源 A/B，差值 146ms（2.38×）。

**补充修正**：早期版本曾记录「JsonSerializer 导致 3609ms」，那是
`stdio:'ignore'` 造成 `Console.OpenStandardOutput()` 阻塞的测量假象，
真实值是 251ms。详见 `docs/调研报告-JSON序列化与启动优化.md` §2.3。

**硬约束**：`IlcDisableReflection=true` + `JsonSerializer` 会在运行时崩溃
`MT140696497762168: Reflection_Disabled`。既然要极致体积就必须手写序列化。

### 为什么不用现成的 JSON 库

- `Utf8Json` —— 最后发布 2018-01-30，已无维护
- `MessagePack-CSharp` / `MemoryPack` —— 二进制格式，与 NDJSON 协议不兼容
- `SpanJson` —— 无维护信号

`Utf8JsonReader`（官方底层 API）是唯一可用且更快的选项，**尚未迁移到生产路径**，
在 `docs/调研报告` §5 有 12 个用例的逐字节迁移矩阵。

---

## 当前状态

| 阶段 | 状态 | 说明 |
|---|---|---|
| S0 可行性 | ✅ | CreateProcessW + Job Object 跑通 |
| S0b 协议对齐 | ✅ | Node IPC（fd 3），首次可被真实 host 调用（[#11](https://github.com/boyingliu01/dsh-aot-runner/issues/11)）|
| S1 NativeAOT 最小实现 | ✅ | 零反射，1.2MB |
| S1b 依赖检查 | ✅ | 无 VC++ / .NET 运行时依赖（[#5](https://github.com/boyingliu01/dsh-aot-runner/issues/5)）|
| S1c 签名分发 | ⏸ 推迟 | 自用无证书（[#8](https://github.com/boyingliu01/dsh-aot-runner/issues/8)）|
| S2 功能对齐 | ✅ | 协议/stdio/exit code |
| S2b 性能实测 | ✅ | 见上表 |
| S3 语义完备 | ✅ | terminate 竞态（[#4](https://github.com/boyingliu01/dsh-aot-runner/issues/4)）、control pipe（[#2](https://github.com/boyingliu01/dsh-aot-runner/issues/2)）|
| S4 A/B 验证 | ✅ | **28/28 通过** |
| S5 泄漏/混沌 | ✅ | 100 次零泄漏 + 混沌（[#3](https://github.com/boyingliu01/dsh-aot-runner/issues/3)）|
| S6 插件接入 | ✅ | 插件 + 熔断器（[#11](https://github.com/boyingliu01/dsh-aot-runner/issues/11) 阶段 B）|
| S7 性能对比验证 | 🔄 | 第一层 + 第二层 ✅，第三层进行中 |

**全套件 60/60 通过**：`npm run test:all`。

### 已知待办

按线上 Issue 排列（**Issue 是唯一事实来源**）：

| Issue | 状态 | 内容 |
|---|---|---|
| [#8](https://github.com/boyingliu01/dsh-aot-runner/issues/8) | ⏸ 推迟 | S1c 签名与分发布置（自用无证书）|
| [#1](https://github.com/boyingliu01/dsh-aot-runner/issues/1) | 🔄 跟踪 | 路线图与验收标准 |

非 Issue 记录的技术债：

- **JSON 迁移** `JsonDocument` → `Utf8JsonReader`（可再省 ~15ms）
- **runner 开销仍有压缩空间**：当前 69~76ms，地板 32~36ms，理论上还能再省 40ms+
- **两个测试缺口**（详见 [性能对比测试报告](docs/性能对比测试报告.md)）：
  熔断器的 e2e 验证（node:test 环境下行为不确定）、
  切帧丢数据类缺陷（需要 runner 侧测试接缝）

### 关于 `resolveWindowsExecutable`：已核对一致

曾一度怀疑 AOT 缺「applicationName 所在目录作为额外搜索根」的回退。2026-11-01
复核 `runner-launch-*.js:1485` 源码确认：**DSH 本身就没有这条回退**，搜索根只有
`[""]`（cwd）+ PATH 两处。

实测裸名命令在两种 runner 下（含 cwd 不在 PATH、找不到可执行文件等场景）
ENOENT 行为与错误文本**完全一致**：

```
node → {"message":"spawn definitely-not-real-xyz ENOENT","code":"ENOENT",
        "syscall":"spawn definitely-not-real-xyz","path":"definitely-not-real-xyz"}
aot  → 同上，逐字节相同
```

早先观察到的差异是探测脚本把 cwd 传成 glob 模式、导致 runner 自身启动失败造成的
测量伪迹，**不是真实缺口**。这条记录保留在此，避免后来者重复走一遍弯路。

---

## 复用前提

本 runner 直接复用 DSH 内部契约（`@deepseek-ai/dsh-subprocess-local` 的
runner 协议与 `resolveWindowsExecutable` 语义）。**DSH 升级时需要重新核对**：

- `runner.js` 的 start 请求字段集
- `WINDOWS_SPAWN_ERROR_CODES` 映射表
- `resolveWindowsExecutable` 的候选扩展名与搜索顺序
- `runnerStdio` 的 fd 布局

`test/ab-verify.js` 会捕获这些偏差 —— 它是回归闸门，不要删。

---

## License

Private / internal use.

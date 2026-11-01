# dsh-aot-runner

DSH 子进程 runner 的 **NativeAOT 高性能实现**。用原生可执行文件替换 Node.js 版 runner，
把每次子进程调用的固定开销从约 360ms 降到约 150ms（**消除约 60%**），且行为与 Node 版
在 24 个用例上字节级一致。

> 📋 **下一步计划看 [ROADMAP.md](ROADMAP.md)**，任务细节在
> [Issues](https://github.com/boyingliu01/dsh-aot-runner/issues)（Issue 是唯一事实来源）。
>
> 当前状态下最该先做的三件事：
> [#3 零泄漏回归](https://github.com/boyingliu01/dsh-aot-runner/issues/3) ·
> [#2 control pipe](https://github.com/boyingliu01/dsh-aot-runner/issues/2) ·
> [#5 依赖检查](https://github.com/boyingliu01/dsh-aot-runner/issues/5)

---

## 为什么做这个

DSH 每启动一个子进程，链路是：

```
node.exe (dsh host) → node.exe runner.js -- <target> → target
```

中间那个 `runner.js` 每次都要重新加载 Node 运行时、解析模块、走一遍 IPC 握手。
profile 显示它单独贡献 **300–360ms** 的固定延迟 —— 比真正要跑的命令还慢。

把它换成 NativeAOT 编译的原生 exe 后，这部分降到 **150ms 左右**。

### 实测收益

同一时间窗内交错采样（避免负载漂移干扰），n=30：

| | min | p50 | p95 |
|---|---|---|---|
| 原生地板 `hostname.exe` | 36ms | 54ms | 189ms |
| **node runner（现状）** | 280ms | **413ms** | 673ms |
| **AOT runner** | 138ms | **199ms** | 342ms |

- **每次调用净省 214ms**
- **消除 59.6% 的 runner 开销**

> 绝对值随系统负载波动，但**收益比例稳定在 60% 左右**，这是可靠结论。

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

AOT 版用 **NDJSON over pipes** 取代 Node IPC，其余语义完全一致。
start 请求字段被 `hasExactKeys` 严格校验为 `{type, cwd, env, control?}` ——
**多一个字段都会被拒绝**，这一点必须照抄。

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
./build.sh --test          # 构建 + 跑 24 项 A/B 验证
./build.sh --all           # 质量门禁 + 清理重建 + 测试 + 基准
./build.sh --out <目录>    # 指定产物目录
```

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
node bench/d1-ab-bench.js  # 性能对比
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
│   └── ab-verify.js           # 24 项 A/B 验证
├── bench/
│   └── d1-ab-bench.js         # 交错采样性能基准
└── docs/
    ├── 开发环境.md             # 本文件：搭环境、跑验证、故障排查
    ├── 调研报告-JSON序列化与启动优化.md
    ├── S2b-性能实测报告.md
    └── S2-进展与阻塞.md
```

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
| S1 NativeAOT 最小实现 | ✅ | 零反射，1.2MB |
| S1b 依赖检查 | ❌ | 待 `dumpbin /DEPENDENTS` |
| S1c 签名分发 | ❌ | 待办 |
| S2 功能对齐 | ✅ | 协议/stdio/exit code |
| S2b 性能实测 | ✅ | 见上表 |
| S3 语义完备 | ⚠️ ~50% | terminate ✅ / SafeHandle ✅ / control pipe ❌ |
| **S4 A/B 验证** | ✅ | **24/24 通过** |
| S5 泄漏/混沌 | ❌ | 待办 |
| S6 接入 `ctx.subprocess` | ❌ | 待办 |

### 已知待办

按线上 Issue 的优先级排列（**Issue 是唯一事实来源**，编号以 GitHub 为准）：

| Issue | 优先级 | 内容 |
|---|---|---|
| [#3](https://github.com/boyingliu01/dsh-aot-runner/issues/3) | P0 | S5 进程树零泄漏回归（100 连续调用）+ 混沌测试 |
| [#2](https://github.com/boyingliu01/dsh-aot-runner/issues/2) | P0 | S3 control pipe —— fd 7 透传 + 环境标记 + 关闭副本 |
| [#6](https://github.com/boyingliu01/dsh-aot-runner/issues/6) | P0 | S6 熔断器 NORMAL→SUSPECT→FALLBACK→DISABLED + 运行时探针 |
| [#4](https://github.com/boyingliu01/dsh-aot-runner/issues/4) | P1 | S3 terminate 竞态，高频 start/terminate 交替 |
| [#5](https://github.com/boyingliu01/dsh-aot-runner/issues/5) | P1 | S1b `dumpbin /DEPENDENTS` 确认无 VC++ 运行时依赖 |
| [#7](https://github.com/boyingliu01/dsh-aot-runner/issues/7) | P1 | S6 接入 `ctx.subprocess` seam |
| [#8](https://github.com/boyingliu01/dsh-aot-runner/issues/8) | P2 | S1c 签名与分发布置 |

非 Issue 记录的技术债：

- **JSON 迁移** `JsonDocument` → `Utf8JsonReader`（可再省 ~15ms）
- **`resolveWindowsExecutable` 搜索根缺口** —— 见下节

### 已知的契约漂移

`resolveWindowsExecutable` 除了 PATH 与 cwd，还会把**解析出的 applicationName 的目录**
作为额外搜索根。AOT 版目前缺这一条，导致：

```
cwd 不在 PATH 中，命令以裸名给出（如 hostname）
  → DSH 下能跑（回退到 node.exe 所在目录）
  → AOT 下报 spawn ENOENT，且错误文本里的程序名不同
```

这条在 A/B 用例里**测不出来**，因为所有用例的 cwd 都是 `C:/Windows`（在 PATH 中）。
修复会归入 [#7 接入](https://github.com/boyingliu01/dsh-aot-runner/issues/7) 的前置工作。

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

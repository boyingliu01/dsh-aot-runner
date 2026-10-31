# dsh-aot-runner

DSH 子进程 runner 的 **NativeAOT 高性能实现**。用原生可执行文件替换 Node.js 版 runner，
把每次子进程调用的固定开销从约 360ms 降到约 150ms（**消除约 60%**），且行为与 Node 版
在 24 个用例上字节级一致。

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

### 构建

```bash
./build.sh                 # 增量构建
./build.sh --clean         # 清理后重建
./build.sh --test          # 构建 + 跑 24 项 A/B 验证
./build.sh --all           # 清理重建 + 测试 + 基准
```

产物默认落在 `%TEMP%/dsh-aot-runner-dist/dsh-aot-runner.exe`，可用
`-p:RunnerOutDir=...` 覆盖。

### 手动构建

```bash
dotnet publish -c Release -r win-x64 -o "%TEMP%/dsh-aot-runner-dist"
```

### 测试与基准

```bash
export AOT_RUNNER="$TEMP/dsh-aot-runner-dist/dsh-aot-runner.exe"
node --test test/ab-verify.js   # 24 项字节级 A/B
node bench/d1-ab-bench.js               # 性能对比
```

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
```

**确认是路径问题而非代码问题的判据**：把**同一个 exe**（md5 不变）复制到
`%TEMP%` 下再跑，若恢复正常则确认。

**规避**：构建输出放到 Medium IL 目录（`%TEMP%` 即可），本项目默认已这么做。

> 想彻底清除标签需要 `WRITE_DAC` 权限，而沙箱留下的 ACL 里
> `Authenticated Users` 只有 `(M)`，通常不够 —— 所以**规避比清除更实际**。

---

## 项目结构

```
.
├── DshAotRunner.csproj        # NativeAOT 配置（13 个优化开关）
├── build.sh                   # 构建/测试/基准一键脚本
├── src/
│   ├── Program.cs             # 入口 + 顶层异常兜底
│   ├── JobRunner.cs           # 核心：启动/监控/终止 target
│   ├── JobHandle.cs           # Job Object 封装
│   ├── Native.cs              # P/Invoke 声明
│   ├── Protocol.cs            # 协议 POCO
│   └── ProtocolJson.cs        # 手写序列化（零反射）
├── test/
│   ├── runner-client.js       # 共享测试工具（真实 DSH 调用契约）
│   └── ab-verify.js   # 24 项 A/B 验证
├── bench/
│   └── d1-ab-bench.js         # 交错采样性能基准
└── docs/
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

1. **S5** 进程树零泄漏回归（100 连续调用）+ 混沌测试
2. **control pipe** —— `Control` 字段已解析但未使用
3. **terminate 竞态** 高频 start/terminate 交替
4. **`dumpbin /DEPENDENTS`** 确认无 VC++ 运行时依赖
5. **S6 接入** —— 子类化 `LocalSubprocessRuntime` 覆盖 `ctx.subprocess`
6. **熔断器** NORMAL→SUSPECT→FALLBACK→DISABLED + 运行时探针
7. **JSON 迁移** `JsonDocument` → `Utf8JsonReader`

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

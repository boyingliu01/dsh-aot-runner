# S2b 性能实测报告 —— NativeAOT Runner

> 日期：2026-10-30
> 测量条件：8 逻辑核 / 32GB / NVMe，CPU 负载 20%（可信区间）

> ## ⚠️ 本报告第二章的结论已被更正（2026-10-31）
>
> 第二章曾声称"JsonSerializer 有 1.2 秒启动陷阱，原因是 AOT 运行时在 Main 之前水合序列化器元数据"。
>
> **这个归因和里面的数字都是错的。**
>
> - **归因错误**：ModuleInitializer 双打点实测，Main 之前窗口只有 **1.6ms**，延迟全部发生在 Main 之后。
> - **数字错误**：当时测到的 1830ms / 1266ms 是**测量伪迹**（进程在 `Console.OpenStandardOutput()` 处等待，被计入了"启动耗时"）。
>
> **真实数据**（严格同源对照，各 12 次，p50）：
> - 手写 ProtocolJson：**105ms**
> - JsonSerializer 源生成：**251ms**
> - 差距 **146ms（2.38 倍）**，不是 1.2 秒
>
> 详见 `调研报告-JSON序列化选型与极致启动优化-20261031.md` §2.3。
>
> 第二章原文保留作历史记录，但**不应再被引用**。

---

## 一、核心结论

**NativeAOT runner 相对 node runner 的 runner 一跳开销从 126ms 降到 32ms，消除 74%。**

| 指标 | p50 | p95 | p99 |
|---|---|---|---|
| 原生地板（纯 `hostname.exe` 启动） | 35.8ms | 43.5ms | — |
| **NativeAOT runner（本次产出）** | **68.1ms** | 137.5ms | 139.8ms |
| node runner（现状基线） | 162.1ms | 205.0ms | 218.7ms |

**净收益：94.0ms / 次调用**（交错采样 30 轮，n=30 有效样本）

拆解：

```
node runner 相对地板的开销 = 162.1 - 35.8 = 126.3ms   ← 这是 node 启动的代价
AOT runner 相对地板的开销 =  68.1 - 35.8 =  32.3ms   ← 这是 AOT 启动 + 协议开销
                                            ─────────
                                          消除 94.0ms (74%)
```

与 v3.2 方案预估（141ms → 40ms）相比，实测结果**略优于预估**（实际 126ms → 32ms）。

---

## 二、关键发现：JsonSerializer 在 AOT 下的 1.2 秒陷阱

> **⚠️ 更正（2026-10-31）：本章结论错误，保留仅作历史记录，不应再被引用。**
>
> 1. **归因错**：说"完全发生在 Main 之前"是错的。ModuleInitializer 双打点实测 Main 之前只有 1.6ms。
> 2. **数字错**：这里的 1830ms / 1266ms 是测量伪迹（进程卡在 `Console.OpenStandardOutput()`，被计入启动耗时）。
> 3. **正确数字**：手写版 105ms vs JsonSerializer 版 251ms，差 146ms（2.38 倍）。见 `调研报告-JSON序列化选型与极致启动优化-20261031.md` §2.3、§4.1。
>
> 下面的原文完整保留，作为"测量脚本本身未经校验就下结论"的反面教材。

### 这是本次最大的技术发现，已写入代码注释防回归

排查过程中发现 AOT runner 存在 **1.5-2.2 秒无法解释的启动延迟**。通过 ModuleInitializer 打点定位到
「spawn → 运行时初始化完成」区间占 1689ms / 1693ms，即**完全发生在 Main 之前**。

最终通过 A/B 对照锁定根因：

| JSON 处理方式 | exe 体积 | 进程总耗时 | p50 |
|---|---|---|---|
| `JsonDocument.Parse`（手写遍历） | 2.71 MB | **33ms** | **33ms** |
| `JsonSerializer.Deserialize` + `JsonSerializerContext`（源生成） | 2.88 MB | 1266ms | **1266ms** |

**34 倍差距。**

### 根因机制

源生成的 `JsonSerializerContext` 在 NativeAOT 下会让运行时在**进程启动阶段**（Main 执行之前）
"水合"（hydrate）整套序列化器元数据：类型映射表、属性访问器、转换器注册表、反射回退路径等。
这部分工作无法通过环境变量关闭，也无法延迟到首次使用——它在模块加载期就完成了。

证据：
- `.managed` 节：509KB → 1.32MB（2.6×）
- `hydrated` 节：223KB → 581KB（2.6×）
- 打点显示延迟 100% 落在 Main 之前

### 解决方案

**禁用 `JsonSerializer`，改用手写编解码：**
- 解析：`JsonDocument.Parse` + `TryGetProperty` 遍历（启动开销 33ms）
- 序列化：`StringBuilder` 手工拼装 + 最小转义

新增 `src/ProtocolJson.cs`，`src/Protocol.cs` 顶部加入强制警告注释。

修复后：**1830ms → 42ms，体积 2.88MB → 1.55MB。**

### 适用边界（重要）

这个陷阱**不限于**本项目：

> 任何追求启动速度的 NativeAOT CLI 工具，只要用了 `System.Text.Json` 的序列化器，
> 都会承受约 1.2 秒的启动惩罚。这对命令行工具是致命的。

建议向 dotnet/runtime 反馈（见第四节）。

---

## 三、p95 抖动的说明

AOT runner 的 p95（137ms）显著高于 p50（68ms）。排查结果：

| 条件 | p50 | p95 | max |
|---|---|---|---|
| 冷启动（首次运行） | 63ms | 127ms | 173ms |
| 预热 10 次后 | 63ms | 96ms | 126ms |

- **p50 完全稳定在 63ms**（含 target 执行，地板 36ms）
- p95 抖动来自 Windows 进程创建的页调度与系统调度抖动，**预热可显著缓解**
- 对照：node runner 的 p95 也高（205ms vs p50 162ms），比例相当

这不是代码缺陷，而是 Windows 进程创建的固有特性。实际使用中 host 是长驻进程，
runner 会被频繁创建，预热效应天然存在。

---

## 四、建议向 dotnet/runtime 反馈

已确认可复现的最小案例：

```csharp
// 33ms 启动
using var doc = JsonDocument.Parse(line);
var cwd = doc.RootElement.GetProperty("cwd").GetString();

// 1266ms 启动（仅此一处差别）
var req = JsonSerializer.Deserialize(line, MyJsonContext.Default.Req);
```

两者 exe 体积仅差 170KB，启动时间差 1.2 秒。这不符合"体积差异"直觉，
说明是运行时初始化路径的问题，值得官方确认是否可作为已知限制记录或优化。

---

## 五、关键缺陷修复：Windows fd 表 vs 标准句柄表

### 现象

回归测试发现 target 的输出**走到了协议通道（FD 1）**，而不是 FD 5：

```
FD5(target stdout): ""
FD1(protocol)     : "TARGET_SPECIFIC_MARKER\r\n{\"type\":\"target-exit\",...}"
```

这会让 target 的任意输出污染 NDJSON 协议流，**直接破坏 S4 的字节级一致性要求**。

### 根因

原实现用 `GetStdHandle(4/5/6)` 取 host 传入的通道句柄。实测：

| API | 结果 |
|---|---|
| `GetStdHandle(4)` / `(5)` / `(6)` | **全部 `0xFFFFFFFFFFFFFFFF`（INVALID_HANDLE_VALUE）** |
| `_get_osfhandle(4)` / `(5)` / `(6)` | `0x33C` / `0x344` / `0x34C`（有效） |

Windows 有**两套句柄编号体系**：

- `GetStdHandle(n)` 查的是**标准句柄表**，只认 `n ∈ {-10, -11, -12}`（STD_INPUT/OUTPUT/ERROR）
- Node 的 `spawn(stdio: [...])` 传的是 **CRT 文件描述符表**的编号

用 `GetStdHandle(4)` 去取 fd 4 的句柄，在语义上就是错的。

### 修复

改用 CRT 的 `_get_osfhandle`：

```csharp
[DllImport("ucrtbase.dll")]
private static extern IntPtr _get_osfhandle(int fd);

var hIn  = Native.CrtGetOsFHandle(4);
var hOut = Native.CrtGetOsFHandle(5);
var hErr = Native.CrtGetOsFHandle(6);
```

### 验证结果（6/6 通过）

| 用例 | FD5 (stdout) | FD6 (stderr) | 退出码 | 协议纯净 |
|---|---|---|---|---|
| hostname | `伯英的X1C` | — | 0 | ✓ |
| cmd echo | `HELLO` | — | 0 | ✓ |
| cmd stderr | — | `ERRTEXT` | 0 | ✓ |
| node --version | `v24.22.1` | — | 0 | ✓ |
| exit code 3 | — | — | **3** | ✓ |
| python | `PY_OK` | — | 0 | ✓ |

**这个缺陷如果没在 S2 阶段发现，会在 S4 才暴露，且排查成本极高。**

---

## 六、下一步

S2 已完成且性能达标，可以进入 S3：
- terminate 语义
- control pipe
- Dual-branch（受限令牌）语义
- SafeHandle 加固

S4 A/B 字节级验证需要覆盖 python / pwsh / bash / cmd / npm / git 六类 target，
重点验证 stdout/stderr/exit code/error 对象完全一致（含 `ex.Message` 文本）。

# 调研报告：NativeAOT Runner 的 JSON 序列化选型与极致启动优化（v2 修订版）

> 日期：2026-10-31
> 状态：**v2 已修订**（针对 Delphi Round 1-5 三席意见）
> 关联：`S2b-性能实测报告.md`、`最终方案-NativeAOT-Runner-v3已评审-20261030.md`

---

## 修订说明（v1 → v2）

v1 被三位专家判定 REQUEST_CHANGES（Round 1 仅 1/3 批准，Round 2-5 全 0/3）。核心批评与处理：

| 专家意见 | 处理 |
|---|---|
| **A-CI-01**：未论证为何不采用官方 `JsonSerializerContext`，仅以"首次调用开销"为由放弃，缺少实际性能数据 | **已补做严格同源对照实验**（§4.1），确认手写版快 2.38 倍 |
| **A-MC-01**：未应用所有 NativeAOT 优化，未做 C/C++ 基线对比，"物理下限"过于绝对 | 已补完整开关清单（§3.1）+ 不适用理由（§3.2）；**删除"物理下限"绝对表述**（§3.4） |
| **A-MC-02 / B-MC-01**：`Utf8JsonReader` 迁移缺验证计划，字节级一致性无保障 | 新增 §5 完整迁移验证矩阵（12 类边界用例） |
| **B-MC-02**：禁用 `StackTraceSupport`/`UseSystemResourceKeys` 后异常出口未全量核查 | 新增 §6.2 异常出口审计，**发现并记录一个真实缺口** |
| **B-MC-03 / C-FC-04**：结论只基于 Windows + 单硬件 | 所有数字标注平台与负载条件 |
| **B-MC-04**：用 min 作为主要决策依据不妥 | **改为 p50 主指标 + p95 尾部**，min 仅参考 |
| **B-MC-05**：零裁剪警告缺证据 | 附构建日志摘录（§7） |
| **B-MC-07**：`hostname.exe` 不是公平基线 | 明确标注其局限，C 静态基线列入待办 |
| **C-FC-01**：`Utf8JsonReader` 性能属理论 | **明确标注为未验证预期，不计入收益** |

**最重要的一条更正**：v1 中"JsonSerializer 导致 3609ms"这个数字**是错误的测量结果**，正确值是 251ms。详见 §2.3。

---

## 摘要

本报告回答三个问题：

1. 业界是否已有可直接使用的高性能序列化库？
2. 上一轮的性能归因是否正确？
3. 启动耗时还能否进一步优化？

**核心结论：**

- **没有可直接复用的库。** 主流库要么停维护（Utf8Json，2018 年后无更新），要么是二进制格式（MessagePack/MemoryPack）与 NDJSON 协议不兼容。`Utf8JsonReader` 是唯一适用的官方底层 API。
- **上一轮的归因与数字都有误，已更正。** 延迟不在"Main 之前的元数据水合"；v1 报的 3609ms 是测量伪迹，真实值 251ms。
- **手写 JSON 仍是最优选择**，比 `JsonSerializer` 快 146ms（2.38 倍，p50）。
- **"物理下限"这个说法不成立**，已删除。正确表述见 §3.4。

---

## 一、库调研

### 1.1 候选清单

| 库 | 最新版本 | 最后更新 | 格式 | NativeAOT | 结论 |
|---|---|---|---|---|---|
| **Utf8Json**（neuecc） | v1.3.7 | **2018-01-30** | JSON | 未验证 | ✗ 8 年无维护 |
| **MessagePack-CSharp** | v3.1.12 | 2026-10-12 | MessagePack 二进制 | ✓ 官方支持 | ✗ 格式不兼容 |
| **MemoryPack**（Cysharp） | 活跃 | — | 二进制 | ✓ | ✗ 格式不兼容 |
| **System.Text.Json** 源生成 | .NET 8 | 随 SDK | JSON | ✓ | 可用但慢 2.38 倍 |
| **System.Text.Json** `Utf8JsonReader` | .NET 8 | 随 SDK | JSON | ✓ | ✓ **推荐迁移目标** |
| **SpanJson** | — | 无活跃维护证据 | JSON | 未验证 | ✗ 无维护信号 |

**调研方法与局限**：通过 GitHub API 检索仓库（stars 排序）+ 查询最新 release 时间 + web search 交叉验证。**未做**：逐个库的源码审计；未在真实 DSH 场景下跑第三方库基准。因此"没有轮子可用"应理解为「在本次检索范围内未发现适用轮子」，而非穷尽性结论。

### 1.2 为什么通用库在本场景是负收益

| 约束 | 具体值 |
|---|---|
| 消息类型数 | 4 种 |
| 单条消息最大字段数 | 5 个 |
| 单条消息大小 | ~3KB（95% 是 `env` 的 PATH） |
| 输出模板数 | 2 个（固定结构） |
| 硬约束 | 输入输出必须与 Node runner 字节级一致 |

通用库为了支持任意类型，必然引入类型元数据、转换器注册表、反射回退路径。本场景这些能力全部用不到，但成本要付。

---

## 二、上一轮结论的更正

### 2.1 v1 说错了什么

v1 称："1.5 秒里有 1689ms 发生在 Main 执行之前……AOT 运行时在启动阶段水合序列化器元数据，无法通过环境变量关闭。"

**两处错误**：

1. **归因错误** —— 延迟不在 Main 之前
2. **数字错误** —— v1 报的 3609ms 是测量伪迹，真实值 251ms

### 2.2 正确的测量：Main 之前窗口仅 1.6ms

用 `[ModuleInitializer]` + `ENTER-MAIN` 双打点，计算 Main 之前窗口：

| 版本 | Main 之前窗口 |
|---|---|
| JsonSerializer 版 | **1.6ms**（6 次采样：1.4, 1.5, 1.6, 1.6, 1.9, 2.2） |
| 手写版 | 参照（打点未落盘，因 stdout 重定向问题） |

**Main 之前没有开销。** 延迟发生在 Main 之后。

### 2.3 3609ms 是测量伪迹 —— 本报告最重要的更正

v1 报"JsonSerializer 版 3609ms"。**这个数字是错的。**

原因：当时的测量脚本有缺陷，进程在 `Console.OpenStandardOutput()` 处等待，导致计时把"等待"计入了"启动耗时"。用严格同源对照重测（§4.1），**真实值是 251ms**。

**教训**：测量脚本本身的正确性必须先用已知基线验证。本次修正后的做法是每轮夹一个原生 `hostname.exe` 地板测量，用于校验环境漂移。

### 2.4 延迟的真实机制

`JsonSerializer` 首次使用时需构建类型元数据、转换器缓存、属性访问器。AOT 下这些无法通过 JIT 预热，成本一次性落在首次调用。

对 runner 这种「启动即用、用完即退」的进程，**首次调用成本 ≈ 启动成本**。问题真实存在，但量级是 ~146ms，不是 ~3.5 秒。

**可推广性表述（已修正）**：不能说"AOT + JsonSerializer 有秒级启动惩罚"。正确表述是：

> 在短生命周期进程中，`JsonSerializer` 的首次调用成本会显著放大（本例 146ms / 2.38 倍），建议改用 `Utf8JsonReader` 或手写解析。

---

## 三、极致启动优化

### 3.1 已应用的完整开关清单

v1 的 csproj **一个优化开关都没开**。补齐：

```xml
<UseSystemResourceKeys>true</UseSystemResourceKeys>
<EventSourceSupport>false</EventSourceSupport>
<MetadataUpdaterSupport>false</MetadataUpdaterSupport>
<StackTraceSupport>false</StackTraceSupport>
<DebuggerSupport>false</DebuggerSupport>
<HttpActivityPropagationSupport>false</HttpActivityPropagationSupport>
<NativeDebugSymbols>false</NativeDebugSymbols>
<AutoreleasePoolSupport>false</AutoreleasePoolSupport>
<IsTrimmable>true</IsTrimmable>
<TrimmerSingleWarn>false</TrimmerSingleWarn>
<EnableTrimAnalyzer>true</EnableTrimAnalyzer>
<EnableAotAnalyzer>true</EnableAotAnalyzer>
<IlcDisableReflection>true</IlcDisableReflection>
```

**体积：1,547,776 → 1,202,688 字节（-22.3%）**

### 3.2 关于未应用的优化（回应 A-MC-01）

| 手段 | 适用 | 理由 |
|---|---|---|
| PGO（Profile-Guided Optimization） | ✗ | NativeAOT 已做静态全程序优化，无 JIT 分层；`OptimizationPreference=Speed` 已开 |
| TieredCompilation | ✗ | AOT 无分层编译概念 |
| ServerGC | ✗ 有害 | 增加启动开销与常驻内存，runner 是短进程 |
| `IlcOptimizationPreference=Size` | 可选 | 与 Speed 互斥。当前选 Speed，因启动时间是首要指标；若后续发现体积主导启动时间可改 Size 复测 |
| ReadyToRun | ✗ | 属 JIT 路径优化，AOT 已有原生代码 |

**未做**：C/C++ 静态链接基线。这是合理的批评（B-MC-07），已列入待办。当前 `hostname.exe` 基线只能说明"我们和系统自带小程序同速"，不能排除"纯 C 静态程序更快"。

### 3.3 **重要风险：`IlcDisableReflection=true` 与 `JsonSerializer` 不兼容**

实测：开启 `IlcDisableReflection` 后，任何使用 `JsonSerializer` 的代码在运行时**直接崩溃**：

```
Unhandled Exception: MT140696497762168: Reflection_Disabled
```

**当前生产代码安全**（已迁移到手写 JSON，零反射），但这是一条硬约束：

> 若将来有人把 JSON 层改回 `JsonSerializer`，必须同时移除 `IlcDisableReflection`。

已写入 csproj 注释与 §6.1 风险表。

### 3.4 "物理下限"表述已删除（回应 A-MC-01 / B-MC-03 / B-MC-07 / C-FC-04）

v1 称"40ms 是物理下限"，**结论不成立**，理由：

1. 只在 Windows 单平台验证
2. 未做 C/C++ 静态链接基线对比
3. 测量期间系统负载波动大（49-100%）
4. `hostname.exe` 是极简 C++ 程序，与 .NET AOT 运行时初始化复杂度不可等同

**v2 正确表述**：

> 在当前技术栈（.NET 8 NativeAOT / Windows x64）与实测负载条件下，优化后生产版 p50 已接近零依赖最小 AOT 程序（915KB 空程序）的水平。这不构成"物理下限"的证明。

---

## 四、实测数据

### 4.1 严格同源对照（本节是全部结论的依据）

**方法**：同一份完整 runner 源码，只替换 JSON 层（`src/Protocol.cs` + `JobRunner.HandleMessage`），其余完全一致。交错采样，各 12 次，每轮夹一次原生地板校验。

**环境**：Windows x64，8 逻辑核 / 32GB / NVMe，测量时 CPU 负载 49%（非隔离环境）。

| 版本 | 体积 | min | **p50** | p95 |
|---|---|---|---|---|
| 原生地板 `hostname.exe` | — | 33ms | **39ms** | 76ms |
| **A. 手写 ProtocolJson** | 1.20MB | 87ms | **105ms** | 163ms |
| **B. JsonSerializer 源生成** | 1.74MB | 214ms | **251ms** | 320ms |

**A 比 B 快 146ms（p50），即 2.38 倍。**

原始数据：

- A: 95, 101, 88, 107, 117, 163, 132, 113, 93, 105, 87, 104
- B: 320, 255, 250, 244, 251, 266, 271, 231, 233, 214, 286, 237

### 4.2 测量方法学说明（回应 B-MC-04）

v1 以 `min` 为主指标，不妥。v2 改为：

- **p50 为主指标** —— 反映典型体验
- **p95 为尾部指标** —— 反映最差情况
- `min` 仅作参考

**未做**：方差分析（ANOVA）、GC 暂停分解、跨硬件复测、跨平台复测。已列入待办。

**环境局限**：测量时系统负载 49%，非隔离环境。所有数字应视为**该负载条件下的观测值**。

### 4.3 与 node runner 的对比（含环境差异声明）

| 实现 | p50 | 采集时段负载 |
|---|---|---|
| node runner（现状） | 155ms | 更早测量，系统较空闲 |
| AOT runner（手写 JSON） | 105ms | 本次，负载 49% |

**重要声明**：这两组数据**不是同一时段采集**，环境差异可能达数十毫秒。严格对比需在同时段重测，已列入待办。

按此数据估算，单会话（约 245 次调用）约省 12 秒。**此估算受上述环境差异影响，仅供参考，不作为承诺。**

---

## 五、`Utf8JsonReader` 迁移验证计划（回应 A-CI-01 / A-MC-02 / B-MC-01）

### 5.1 迁移动机与状态

`Utf8JsonReader` 比 `JsonDocument` 更底层：不构建 DOM 树，直接流式读取 UTF-8 字节。

> **当前未迁移。其性能收益属未验证预期，不计入任何承诺。**

### 5.2 字节级一致性验证矩阵（12 类边界）

| 类别 | 用例 | 期望 |
|---|---|---|
| 浮点数精度 | `{"n":1.0}` vs `{"n":1}` | 按原始文本透传，不重新格式化 |
| Unicode 转义 | `{"s":"\u4f60\u597d"}` vs `{"s":"你好"}` | 解码后字符串相同 |
| 代理对 | `{"s":"\ud83d\ude00"}` | 正确组合为单个码点 |
| 孤立代理 | `{"s":"\ud83d"}` | 与 Node 行为一致（需实测确认） |
| 键值顺序 | `{"b":1,"a":2}` | 顺序不影响结果 |
| 重复键 | `{"a":1,"a":2}` | 与 `JSON.parse` 一致（取最后值） |
| 大数 | `{"n":9007199254740993}` | 与 Node Number 精度行为一致 |
| 深度嵌套 | 100 层 | `Utf8JsonReader` 默认限 64 层，需显式配置或拒绝 |
| 空对象/数组 | `{}` `[]` | 正确识别 |
| BOM | 带 UTF-8 BOM | 与 Node 行为一致 |
| 控制字符 | `{"s":"\u0000"}` | 正确解码 |
| 转义斜杠 | `{"s":"\/"}` vs `{"s":"/"}` | 解码后相同 |

### 5.3 验证步骤

1. 实现 `Utf8JsonReader` 版本，保留 `JsonDocument` 版本作为对照
2. 对上述矩阵逐条跑双版本，**比对输出字节序列**（不是比对对象）
3. 跑 S4 全量 A/B（6 类 target：python / pwsh / bash / cmd / npm / git）
4. 对比 `EmitProtocolError` 的错误消息文本是否逐字节一致
5. 性能测量（≥30 样本，p50/p95）
6. 任一项不一致 → 回滚到 `JsonDocument`

### 5.4 对错误处理路径的影响

`Utf8JsonReader` 抛出的也是 `JsonException`，`HandleMessage` 的 catch 结构不变。但**异常消息文本可能不同**（含 byte position 信息），需在 §5.3 步骤 4 专门验证。

**与 `UseSystemResourceKeys=true` 的交互**：若异常消息走资源 ID 路径，文本会变化。需确认错误路径不受影响。

---

## 六、风险与遗留

### 6.1 风险表

| 风险 | 影响 | 缓解 | 状态 |
|---|---|---|---|
| `UseSystemResourceKeys=true` | 框架内部异常消息变为资源 ID | 对外错误对象由 `EmitProtocolError` 自行拼装 | 已测 5 用例通过 |
| `StackTraceSupport=false` | 异常无堆栈，难调试 | 生产不需要；调试构建可关闭该开关 | 见 §6.2 |
| `IlcDisableReflection=true` | **与 JsonSerializer 冲突会崩溃** | csproj 已加注释警示 | 已记录 §3.3 |
| `Utf8JsonReader` 迁移 | 可能引入字节级差异 | 见 §5 完整验证计划 | **未开始** |
| 测量环境非隔离 | 数字可能偏移 | 夹地板校验；标注负载条件 | 已标注 §4.2 |

### 6.2 异常出口审计（回应 B-MC-02）—— 发现一个真实缺口

`StackTraceSupport=false` 后，未捕获异常会导致进程崩溃且无堆栈。必须确认所有异常出口都被捕获：

| 出口 | 是否捕获 | 说明 |
|---|---|---|
| `HandleMessage` 的 JSON 解析 | ✓ `try/catch (JsonException)` | 转 `FailProtocol` |
| `SpawnTarget` 的 `CreateProcessW` | ✓ 检查返回值 → `Win32Exception` | 转 `ErrorResult` |
| `Poll` 循环 | ✓ 外层 `try/catch` | 转 `ErrorResult` |
| `WriteLine` | ✓ `try/catch` 全吞 | host 断开时静默 |
| `Program.Main` | ✗ **未捕获** | **待补：顶层 try/catch 转协议错误** |

**这是本次评审发现的真实问题**：`Program.Main` 没有顶层兜底。若 `JobRunner` 构造函数或 `Console.OpenStandardOutput()` 抛异常（例如 stdout 被关闭），进程会静默崩溃并返回非零退出码，host 侧只能看到"runner 异常退出"而无法定位。

已列入待办第 1 项。

### 6.3 待办

1. [ ] **为 `Program.Main` 加顶层 `try/catch`**（§6.2 发现的缺口）
2. [ ] 实现 `Utf8JsonReader` 版本并按 §5 验证
3. [ ] 在同时段重测 node runner 基线（§4.3 环境差异）
4. [ ] 补 C 静态链接 Hello World 基线（回应 B-MC-07）
5. [ ] 方差分析 / 多硬件复测（回应 B-MC-04 / C-FC-04）
6. [ ] 更新 `S2b-性能实测报告.md` 中"启动水合"与 3609ms 的错误表述
7. [ ] 提 dotnet/runtime issue，表述为"短生命周期进程中 JsonSerializer 首次调用成本"

---

## 七、附：构建日志摘录（回应 B-MC-05）

```
$ dotnet publish -c Release -r win-x64 -o ./dist-opt 2>&1 | grep -cE "warning IL"
0
```

**依赖树**：本项目**零 NuGet 包依赖**，仅引用 .NET 8 基础类库（`System.Runtime`、`System.Console`、`System.Text.Json` 的 `JsonDocument`/`Utf8JsonReader` 部分、`System.Runtime.InteropServices`）。因此不存在第三方包反射/动态加载导致的裁剪失败风险。

`EnableTrimAnalyzer` / `EnableAotAnalyzer` 均为 `true`，若有 AOT 不兼容代码会在构建期报 IL 警告。当前为零，说明构建期静态检查未发现 AOT 兼容性问题。**注意**：这不覆盖运行期才暴露的问题（如 §3.3 的 `Reflection_Disabled` 崩溃）。

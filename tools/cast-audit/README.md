# 强转审计工具（cast-audit）

> 检查 C# 里**有符号/无符号错配**和**窄化截断** —— 这两类错误编译器完全不提示，
> 却会在边界值上静默出错。

## 为什么需要它

### C# 没有 C++ 那样的 `static_cast` 区分

C++ 用 4 个具名转换运算符把「意图」写进代码，编译器也更容易对窄化报警。
C# 只有一种 `(T)x` 语法，**且对显式数值强转零告警**。

实测（`AnalysisLevel=latest-all` + `AnalysisMode=AllEnabledByDefault`）：

```csharp
public static int  Bad(uint u)     => (int)u;    // 0 条告警
public static byte Bad2(int i)     => (byte)i;   // 0 条告警
public static long Bad3(double d)  => (long)d;   // 0 条告警
```

显式强转被视为「开发者已表明意图」，编译器、内置分析器、SonarAnalyzer
都不会说话。查找过现成方案：社区只有分析**隐式**转换的工具，
没有分析显式强转范围风险的。

### 这个坑本项目真实踩过

Windows 退出码是**无符号** 32 位（`GetExitCodeProcess` 签名就是 `out uint`），
而 `TargetExitResult.ExitCode` 曾声明成 `int`，赋值处又做了 `(int)code`：

| ExitProcess 设置 | 错误行为 |
|---|---|
| 2147483648 | 报成 **-2147483648** |
| 4294967295 | 报成 **-1** |

host 侧校验 `Number.isSafeInteger(exitCode) && exitCode >= 0`，
收到 -1 直接抛 `invalid target-exit result` —— **工具调用当场失败**。

更糟的是：当时有一条单元测试 `Serialize_TargetExitResult负数退出码`
**把这个 bug 固化成了契约**（构造 `-1` 并断言输出 `"-1"`）。测试是绿的，行为是错的。

### C# 里对应的正确写法

```csharp
(int)u            // 静默回绕 —— 危险
checked((int)u)   // 溢出抛 OverflowException —— 这就是 C# 的 static_cast 等价物
```

`checked(...)` 是我们想要的行为：**出错要响，不要回绕**。工具对 `checked(...)`
内的转换不报。

## 三条规则

| 规则 | 判据 | 例子 |
|---|---|---|
| `CASTR001` | 无符号 → 有符号，且目标装不下源的最大值 | `(int)someUint` |
| `CASTR003` | 窄化截断：源最大值 > 目标最大值 | `(byte)someInt` |
| `CASTR002` | 有符号可为负 → 无符号 | `(uint)someInt` |

**为什么不是「报所有强转」**：本项目光数值强转就有十几处，
其中大多数安全（`(byte)'='`、`(uint)Marshal.SizeOf(...)`）。
全报出来会把真正的风险淹没，规则很快被人无视。
所以只报「确定会丢数据」和「依赖外部约束才安全」的转换。

## 两种让告警消失的方式

### 1. 用 `checked(...)`（首选）

让代码**真的安全**，而不是让工具闭嘴。

```csharp
si.cbReserved2 = (ushort)descriptorTable.Length;          // 报
si.cbReserved2 = checked((ushort)descriptorTable.Length); // 不报，且溢出会抛
```

### 2. 写豁免注释（确认安全但不想付 `checked` 开销时）

```csharp
// cast-audit:ignore buffer.Length 是数组长度，CLR 保证非负且不超过 int.MaxValue
var ok = Native.ReadFile(_handle, buffer, (uint)buffer.Length, out var got, IntPtr.Zero);
```

**理由必填。** 只写 `// cast-audit:ignore` 不跟理由的，视为无效豁免，照常报出来。

理由不是形式主义：它把「我知道这里为什么安全」从开发者脑子里
**固化进代码**。半年后再看，或者换人接手，都能直接读到结论。
只写 ignore 的豁免会退化成「让工具闭嘴」。

## 自动识别的安全模式

以下情况工具不报（避免永久误报）：

- **`checked(...)` 包裹** —— 溢出会抛异常
- **位掩码** —— `(byte)(x & 0xFF)`、`(byte)(x % 256)`，高位在转换前已清掉
- **常量表达式** —— 编译器自己会管（CS0221）
- **放宽方向** —— `(int)someByte`、`(long)someInt`，目标完全覆盖源
- **同类型** —— `(int)someInt`

## 用法

```bash
# 查整个 src/
dotnet run --project tools/cast-audit -- src

# 查单文件
dotnet run --project tools/cast-audit -- src/JobRunner.cs
```

退出码：`0` = 无风险；`1` = 有风险或分析失败；`2` = 参数错误。

**分析失败会被单独报出来并计入退出码 1** —— 查不成 != 没问题。

## 接入位置

- `build.sh --check` 的第 3 项门禁（0 风险才继续）
- 自测：`node test/cast-audit-selftest.mjs`（11 条，锁住该报和不该报两侧）

## 实现说明

- **Roslyn 语义分析**，不是正则。正则分不清 `(int)x`（强转）和 `(int x)`（参数声明）、
  `byte[]`（数组类型）—— 误报率高到规则会被无视。
- **独立 csproj**，不进 `DshAotRunner.sln`，不参与 AOT 构建。
  主项目的 `.csproj` 里显式 `Compile Remove="tools/**"`。
- **不需要还原被分析项目的依赖**：只引用本进程的 `TRUSTED_PLATFORM_ASSEMBLIES`，
  `int`/`uint` 这些基础类型都在 `System.Private.CoreLib` 里。所以秒级完成，不用等 restore。

## 已知局限（诚实记录）

- **看不到值域约束**。`(byte)(ch >> 8)` 报出来是对的判据、错的结论——
  `char` 右移 8 位必然 ≤ 255，但工具不知道。这类用豁免注释处理
  （`src/JobRunner.cs` 里有一例）。
- **不跨方法做数据流分析**。如果安全性的保证来自上游函数的返回值，
  工具看不出来，需要豁免。
- **只覆盖整数类型**。浮点、decimal 的窄化也丢精度，但本项目的 Win32 边界上
  没有这种转换，先不做。

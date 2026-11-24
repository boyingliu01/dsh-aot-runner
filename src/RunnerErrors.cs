// runner 的协议错误结果工厂。
//
// ## 为什么单独成类
//
// 这几个方法的共同点是「把一种失败翻译成 RUNNER-SPEC 约定的错误对象」：
// 确定的 `code`、确定的 `message`、以及哪些字段该带哪些不该带。它们不读
// runner 的运行状态（唯一的外部输入是 argv[0]，作为 path 用），因此不需要
// 挂在 JobRunner 上。原先它们是 JobRunner 33 个方法里的一部分，让那个类的
// 方法数看起来远超实际职责。
//
// ## 为什么 code 是硬编码字符串而不是 enum
//
// 这些字符串是**对外协议**的一部分 —— host 侧按 `code === 'ENOENT'` 分支处理。
// 协议里出现的字面量必须一眼可读、可搜索，且改动时能在 diff 里看到。
// 抽成 enum 反而会让「协议里到底写了什么」变得间接。
//
// ## 文案为什么必须逐字对齐
//
// A/B 要求 runner 与 node 侧的 libuv 实现字节级一致。`spawn ENOENT` 这类文本
// 是 host 直接展示给用户的，自创措辞会让同一个失败在 AOT 版和 node 版下
// 呈现成两个不同的错误。所以这里每个 message 都对应上游某处的固定文本。
using System.ComponentModel;
using DshAotRunner;

namespace DshAotRunner;

/// <summary>协议错误结果的构造。全部无实例状态。</summary>
internal static class RunnerErrors
{
    /// <summary>「control 通道未继承」的错误结果（host 侧契约违约）。</summary>
    /// <remarks>
    /// 这条错误必须存在且文案明确：host 声明了 control 却没传 fd 7 时，
    /// 若静默降级成「无 control」，target 会永远等一条不存在的通道 ——
    /// 表现为随机挂起，比明确报错难查得多。
    /// </remarks>
    internal static ErrorResult ControlMissing() => new()
    {
        Error = new SerializedError
        {
            Name = "Error",
            Message = "subprocess control channel was not inherited",
            Code = "EPROTOCOL",
        },
    };

    /// <summary>协议层错误（EPROTOCOL）：非法帧、未知 type、重复 start 等。</summary>
    /// <remarks>
    /// 这一类全部是 host 侧违约，不是 Win32 失败 —— 所以不带 syscall/path。
    /// 归到工厂里而不是留在 JobRunner 上：错误形状只该有一处定义，
    /// 否则 node 与 AOT 两条路径的字节迟早会漂。
    /// </remarks>
    internal static ErrorResult ProtocolViolation(string message) => new()
    {
        Error = new SerializedError { Name = "Error", Message = message, Code = "EPROTOCOL" },
    };

    /// <summary>Job Object 创建失败的错误结果。</summary>
    internal static ErrorResult JobCreateFailed(Win32Exception ex) => new()
    {
        Error = new SerializedError { Name = "Error", Message = ex.Message, Code = "EJOBCREATE" },
    };

    /// <summary>CreateProcessW 抛异常时的错误结果（带 path）。</summary>
    internal static ErrorResult SpawnFailed(Win32Exception ex, string? program) => new()
    {
        Error = new SerializedError
        {
            Name = "Error",
            Message = ex.Message,
            Code = "ENOENT",
            Syscall = "spawn",
            Path = program,
        },
    };
}

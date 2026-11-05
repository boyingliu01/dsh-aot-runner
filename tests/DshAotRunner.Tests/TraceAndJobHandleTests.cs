// Trace 与 JobHandle 单元测试 —— 诊断日志的开关语义 + SafeHandle 生命周期
//
// 为什么这些测试值得存在：
//   Trace 是「唯一写入口」，它的契约是**默认完全静默**。一旦误开，
//   诊断日志会污染 fd 1 的 NDJSON 协议流，或写进 target 的 stderr 破坏 A/B
//   比对。这条契约没有类型系统保护，只能靠测试守住。
//
//   SafeJobHandle 派生自 SafeHandle，价值在于「不会被 GC 提前回收」——
//   而这一点恰恰无法用普通断言验证。这里能验证的是可观测部分：
//   构造成功、非法参数校验、Dispose 后报告已关闭（幂等释放不崩），
//   以及 IsEmpty() 真的读到了 job 的 ActiveProcesses。
//
//   —— 最后这一条不是形式主义：正是它抓出了 IsEmpty() 恒为 false 的真实缺陷
//   （JOBOBJECTINFOCLASS 传了 8 而不是 1），已修复并被本文件永久守住。
using System;
using System.Diagnostics;
using System.IO;
using System.Threading;
using DshAotRunner;
using Xunit;

namespace DshAotRunner.Tests;

[Collection("TraceEnvironment")]
public sealed class TraceTests : IDisposable
{
    private readonly string _logPath;
    private readonly string? _originalEnabled;
    private readonly string? _originalFile;

    public TraceTests()
    {
        _originalEnabled = Environment.GetEnvironmentVariable("DSH_AOT_DEBUG");
        _originalFile = Environment.GetEnvironmentVariable("DSH_AOT_DEBUG_FILE");
        _logPath = Path.Combine(Path.GetTempPath(), $"aot-trace-test-{Guid.NewGuid():N}.log");
        Environment.SetEnvironmentVariable("DSH_AOT_DEBUG_FILE", _logPath);
    }

    public void Dispose()
    {
        Environment.SetEnvironmentVariable("DSH_AOT_DEBUG", _originalEnabled);
        Environment.SetEnvironmentVariable("DSH_AOT_DEBUG_FILE", _originalFile);
        TryDelete();
    }

    private void TryDelete()
    {
        try { if (File.Exists(_logPath)) File.Delete(_logPath); }
        catch { /* 测试清理失败不影响断言 */ }
    }

    [Fact]
    public void Write_未启用时不产生任何文件()
    {
        Environment.SetEnvironmentVariable("DSH_AOT_DEBUG", null);

        Trace.Write("这条不应该出现");

        Assert.False(File.Exists(_logPath));
    }

    [Fact]
    public void Write_启用后写入带dbg前缀的行()
    {
        Environment.SetEnvironmentVariable("DSH_AOT_DEBUG", "1");

        Trace.Write("hello-trace");

        Assert.True(File.Exists(_logPath));
        Assert.Contains("[dbg] hello-trace", File.ReadAllText(_logPath));
    }

    [Fact]
    public void Timed_启用后写入带毫秒时间戳的行()
    {
        Environment.SetEnvironmentVariable("DSH_AOT_DEBUG", "1");

        Trace.Timed("timed-line");

        var text = File.ReadAllText(_logPath);
        Assert.Contains("[dbg] [", text);
        Assert.Contains("ms] timed-line", text);
    }

    [Fact]
    public void Write_开关不是精确的1时不启用()
    {
        // "true" / "yes" / "0" 都不算开启 —— 只有字面量 1。
        Environment.SetEnvironmentVariable("DSH_AOT_DEBUG", "true");

        Trace.Write("不应该出现");

        Assert.False(File.Exists(_logPath));
    }

    [Fact]
    public void Write_输出路径不可写时静默吞掉异常()
    {
        // 诊断失败绝不能影响 runner 主流程 —— 这里指向一个必然失败的路径。
        Environment.SetEnvironmentVariable("DSH_AOT_DEBUG", "1");
        Environment.SetEnvironmentVariable(
            "DSH_AOT_DEBUG_FILE",
            Path.Combine(Path.GetTempPath(), $"no-such-dir-{Guid.NewGuid():N}", "x", "t.log"));

        var thrown = Record.Exception(() => Trace.Write("不会抛"));

        Assert.Null(thrown);
    }
}

public sealed class JobHandleTests
{
    [Fact]
    public void SafeJobHandle_Create返回有效句柄()
    {
        using var job = SafeJobHandle.Create();

        Assert.False(job.IsInvalid);
    }

    [Fact]
    public void SafeJobHandle_EnableKillOnClose不抛异常()
    {
        using var job = SafeJobHandle.Create();

        var thrown = Record.Exception(job.EnableKillOnClose);

        Assert.Null(thrown);
    }

    [Fact]
    public void SafeJobHandle_新创建的空job报告为空()
    {
        using var job = SafeJobHandle.Create();

        Assert.True(job.IsEmpty());
    }

    [Fact]
    public void SafeJobHandle_放入活进程后不空退出后变空()
    {
        // 这条是 IsEmpty() 的真正契约：ActiveProcesses 必须真的被读到。
        // 曾经这里传错了 JOBOBJECTINFOCLASS 编号（8 而不是 1），查询恒定失败、
        // IsEmpty() 恒为 false —— 只断言「空 job 为空」时若实现退化成
        // `return true` 也会假通过，所以必须同时验证「有进程时不为空」。
        using var job = SafeJobHandle.Create();

        using var child = System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(
            "cmd.exe", "/c ping -n 5 127.0.0.1 > nul")
        {
            UseShellExecute = false,
            CreateNoWindow = true,
        });

        Assert.NotNull(child);
        job.AssignProcess(child!.Handle);

        Assert.False(job.IsEmpty());

        child.WaitForExit();
        // 进程退出到 job 记账更新之间有极短窗口，轮询等待而不是固定 sleep。
        Assert.True(WaitUntil(() => job.IsEmpty(), milliseconds: 5000));
    }

    private static bool WaitUntil(Func<bool> condition, int milliseconds)
    {
        var deadline = Environment.TickCount64 + milliseconds;
        while (Environment.TickCount64 < deadline)
        {
            if (condition()) return true;
            Thread.Sleep(20);
        }
        return condition();
    }

    [Fact]
    public void SafeJobHandle_Dispose后报告已关闭且重复释放不崩()
    {
        var job = SafeJobHandle.Create();

        job.Dispose();

        // 契约是「已关闭」：SafeHandle 关闭后 IsClosed 为真，
        // 后续任何使用都会抛 ObjectDisposedException 而不是静默用野句柄。
        Assert.True(job.IsClosed);
        // 幂等释放：第二次 Dispose 不应抛异常。
        Assert.Null(Record.Exception(job.Dispose));
    }

    [Fact]
    public void SafeJobHandle_AssignProcess拿到空句柄时抛Win32Exception()
    {
        using var job = SafeJobHandle.Create();

        // HANDLE 为 0 → AssignProcessToJobObject 返回 FALSE(ERROR_INVALID_HANDLE=6)。
        // 用 0 而不是 INVALID_HANDLE_VALUE(-1)：后者在 Windows 上竟然返回成功
        // （实测 ok=True / err=203），拿它当「必然失败」的输入会让测试假通过。
        var thrown = Assert.Throws<Win32Exception>(() => job.AssignProcess(IntPtr.Zero));

        Assert.NotEqual(0, thrown.ErrorCode);
        Assert.Contains("AssignProcessToJobObject failed", thrown.Message);
    }

    [Fact]
    public void Win32Exception_消息包含错误码且保留原值()
    {
        var ex = new Win32Exception(5, "拒绝访问");

        Assert.Equal(5, ex.ErrorCode);
        Assert.Contains("拒绝访问", ex.Message);
        Assert.Contains("GetLastError=5", ex.Message);
    }

    [Fact]
    public void SafeKernelHandle_包装既有句柄后有效()
    {
        using var handle = new SafeKernelHandle(Native.GetStdHandle(-11) /* STD_OUTPUT_HANDLE */);

        Assert.False(handle.IsInvalid);
    }
}

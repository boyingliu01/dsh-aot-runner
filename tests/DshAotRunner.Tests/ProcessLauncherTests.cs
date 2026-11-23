// ProcessLauncher 的启动原语测试 —— 重点是那些「看起来不可能发生」的防御分支。
//
// 为什么值得单独测：
//   ProcessLauncher 抽出来之前，这几条分支都埋在 JobRunner 里，只能靠
//   「构造整个 runner 再触发」来覆盖，实际上从未被测到。抽成 static 类之后
//   可以直接调用，于是这些边界第一次变得可钉。
//
// 这里守的是两类东西：
//   1. cbReserved2 是 WORD（16 位无符号）—— 描述符表长度超过 65535 时
//      必须**显式报错**，而不是静默回绕成负数。静默回绕会让
//      CreateProcessW 读到负数字节数，行为未定义。
//   2. 句柄有效性判定 —— NULL(0) 与 INVALID_HANDLE_VALUE(-1) 都必须算无效。
//      只判 0 是常见错误：-1 是个"看起来有效"的假句柄。
using System;
using System.Runtime.InteropServices;
using DshAotRunner;
using Xunit;

namespace DshAotRunner.Tests;

public sealed class ProcessLauncherTests
{
    // ---- IsValid：句柄有效性 ----

    [Fact]
    public void IsValid_RejectsNullHandle()
    {
        Assert.False(ProcessLauncher.IsValid(IntPtr.Zero));
    }

    [Fact]
    public void IsValid_RejectsInvalidHandleValue()
    {
        // INVALID_HANDLE_VALUE 是 -1，不是 0。只判 0 会把它当有效句柄。
        Assert.False(ProcessLauncher.IsValid(new IntPtr(-1)));
    }

    [Fact]
    public void IsValid_AcceptsOrdinaryHandle()
    {
        Assert.True(ProcessLauncher.IsValid(new IntPtr(1)));
        Assert.True(ProcessLauncher.IsValid(new IntPtr(0x1234)));
    }

    // ---- CollectTargetHandles：需要放行继承的句柄集合 ----

    [Fact]
    public void CollectTargetHandles_WithoutControl_ReturnsThreeStdioHandles()
    {
        var stdio = new StdioHandles(new IntPtr(1), new IntPtr(2), new IntPtr(3));

        var handles = ProcessLauncher.CollectTargetHandles(stdio, controlRequested: false, IntPtr.Zero);

        Assert.Equal(new[] { new IntPtr(1), new IntPtr(2), new IntPtr(3) }, handles);
    }

    [Fact]
    public void CollectTargetHandles_WithControl_AppendsControlHandle()
    {
        var stdio = new StdioHandles(new IntPtr(1), new IntPtr(2), new IntPtr(3));

        var handles = ProcessLauncher.CollectTargetHandles(stdio, controlRequested: true, new IntPtr(7));

        Assert.Equal(4, handles.Length);
        Assert.Equal(new IntPtr(7), handles[3]);
    }

    // ---- BuildStartupInfo：cbReserved2 的 WORD 上限 ----

    [Fact]
    public void BuildStartupInfo_WithoutDescriptorTable_LeavesReserved2Unset()
    {
        var stdio = new StdioHandles(new IntPtr(1), new IntPtr(2), new IntPtr(3));

        var si = ProcessLauncher.BuildStartupInfo(stdio, descriptorTable: null, descriptorPtr: IntPtr.Zero);

        Assert.Equal(0, si.cbReserved2);
        Assert.Equal(IntPtr.Zero, si.lpReserved2);
        // 三个句柄必须原样带到 STARTUPINFO 上
        Assert.Equal(new IntPtr(1), si.hStdInput);
        Assert.Equal(new IntPtr(2), si.hStdOutput);
        Assert.Equal(new IntPtr(3), si.hStdError);
    }

    [Fact]
    public void BuildStartupInfo_RejectsDescriptorTableLargerThanWord()
    {
        // 65536 字节 = ushort.MaxValue + 1：一个字节都不能多。
        // 这里不是测试"极端输入"，而是守住「不许静默回绕」这条契约：
        // 校验存在时抛 InvalidOperationException，校验一旦被删掉，
        // cbReserved2 会被截断成 0，CreateProcessW 拿到一个长度错误的表，
        // 子进程的 fd 表因此错乱 —— 且没有任何报错。
        var stdio = new StdioHandles(new IntPtr(1), new IntPtr(2), new IntPtr(3));
        var oversize = new byte[ushort.MaxValue + 1];

        var ex = Assert.Throws<InvalidOperationException>(
            () => ProcessLauncher.BuildStartupInfo(stdio, oversize, new IntPtr(1)));

        Assert.Contains("cbReserved2", ex.Message);
    }

    [Fact]
    public void BuildStartupInfo_AcceptsDescriptorTableAtExactWordLimit()
    {
        // 边界本身必须放行：65535 是 WORD 的上限，不是超限。
        var stdio = new StdioHandles(new IntPtr(1), new IntPtr(2), new IntPtr(3));
        var atLimit = new byte[ushort.MaxValue];

        var si = ProcessLauncher.BuildStartupInfo(stdio, atLimit, new IntPtr(0x1000));

        Assert.Equal(ushort.MaxValue, si.cbReserved2);
        Assert.Equal(new IntPtr(0x1000), si.lpReserved2);
    }

    // ---- ResumeSuspendedThread：三条支路 ----

    [Fact]
    public void ResumeSuspendedThread_SuccessReportsNoError()
    {
        var ok = ProcessLauncher.ResumeSuspendedThread(
            IntPtr.Zero, out var errorCode, _ => 0, () => 0);

        Assert.True(ok);
        Assert.Equal(0, errorCode);
    }

    [Fact]
    public void ResumeSuspendedThread_AlreadyRunningCountsAsSuccess()
    {
        // ResumeThread 返回 0xFFFFFFFF 且 ERROR_NOT_SUSPENDED 时，线程其实已在运行。
        // 判成失败会把一个正常启动的 target 终止掉。
        var ok = ProcessLauncher.ResumeSuspendedThread(
            IntPtr.Zero, out var errorCode,
            _ => Native.RESUME_THREAD_FAILED, () => Native.ERROR_NOT_SUSPENDED);

        Assert.True(ok);
        Assert.Equal(Native.ERROR_NOT_SUSPENDED, errorCode);
    }

    [Fact]
    public void ResumeSuspendedThread_RealFailureReportsErrorCode()
    {
        var ok = ProcessLauncher.ResumeSuspendedThread(
            IntPtr.Zero, out var errorCode,
            _ => Native.RESUME_THREAD_FAILED, () => 5);

        Assert.False(ok);
        Assert.Equal(5, errorCode);
    }

    // ---- TargetSpawner 的失败处理 ----

    /// <summary>只记录「被要求做什么」的假 Host。</summary>
    private sealed class FakeSpawnHost : ISpawnHost
    {
        public List<string> Calls { get; } = new();
        public string? ProgramName => @"C:\x\target.exe";
        public IReadOnlyList<string> Argv => new[] { @"C:\x\target.exe" };
        public Func<int, IntPtr>? StdioResolveHook => null;
        public Func<int, IntPtr>? ResolveControlHook => null;
        public void EmitSpawnEnoent(string program) => Calls.Add("enoent:" + program);
        public void EmitCreateProcessError(int win32Code, string program) => Calls.Add("spawn-error:" + win32Code);
        public void PublishControlMissingError() => Calls.Add("control-missing");
        public void Finish() => Calls.Add("finish");
    }

    [Fact]
    public void TargetSpawner_ResumeFailure_ReportsErrorAndFinishes()
    {
        // 真失败必须显式报错并结束 runner：否则线程永远挂起，
        // target 静默不执行，调用方等一个永不出现的退出码（表现为卡死）。
        var host = new FakeSpawnHost();
        var spawner = new TargetSpawner(host);

        var ok = spawner.ResumeThreadCore(
            IntPtr.Zero, _ => Native.RESUME_THREAD_FAILED, () => 31);

        Assert.False(ok);
        Assert.Contains("spawn-error:31", host.Calls);
        Assert.Contains("finish", host.Calls);
    }

    [Fact]
    public void TargetSpawner_ResumeSuccess_DoesNotTouchHost()
    {
        var host = new FakeSpawnHost();
        var spawner = new TargetSpawner(host);

        var ok = spawner.ResumeThreadCore(IntPtr.Zero, _ => 0, () => 0);

        Assert.True(ok);
        Assert.Empty(host.Calls);
    }
}

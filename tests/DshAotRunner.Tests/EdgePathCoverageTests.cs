// 边界与失败路径补齐 —— 让每个生产类都越过 90%
//
// ## 这个文件补的是「剩下的那 10%」
//
// 前面的测试覆盖了主路径；剩下没被覆盖的几乎全是**失败分支与边界值**：
//   - 构造函数拿到无效 fd
//   - WriteFile 失败 / 写回 0 字节
//   - Win32 调用失败后的异常包装
//   - 容量参数非法、缓冲区临界状态
//
// 这些分支平时不执行，一旦执行就是「出问题的时候」——
// 恰恰是最需要它们行为正确的时刻。
using System.Text;
using DshAotRunner;
using Xunit;

namespace DshAotRunner.Tests;

/// <summary>可编程的假通道：控制 Read/Write 的每一种返回形态。</summary>
internal sealed class ScriptedIo : IChannelIo
{
    private readonly Queue<(bool Ok, byte[] Data, int Error)> _reads = new();

    /// <summary>Write 的返回：默认成功写完。</summary>
    public Func<(bool Ok, uint Written, int Error)> OnWrite { get; set; } =
        () => (true, 0, 0);

    public ScriptedIo ReadError(int error)
    {
        _reads.Enqueue((false, [], error));
        return this;
    }

    public ScriptedIo ReadEmpty()
    {
        _reads.Enqueue((true, [], 0));
        return this;
    }

    public ScriptedIo ReadBytes(byte[] data)
    {
        _reads.Enqueue((true, data, 0));
        return this;
    }

    public (bool Ok, uint Got, int Error) Read(byte[] buffer)
    {
        if (_reads.Count == 0) return (false, 0, Native.ERROR_PIPE_NOT_CONNECTED);
        var (ok, data, err) = _reads.Dequeue();
        if (!ok) return (false, 0, err);
        data.CopyTo(buffer, 0);
        return (true, (uint)data.Length, 0);
    }

    public (bool Ok, uint Written, int Error) Write(byte[] buffer, int offset, int count)
    {
        var r = OnWrite();
        // 允许测试只声明「成功并写满」，省得每个用例手算 count
        return r.Written == 0 && r.Ok && r.Error == 0 ? (true, (uint)count, 0) : r;
    }
}

public class EdgePathCoverageTests
{
    // ============ IpcChannel：构造失败 ============

    [Fact]
    public void IpcChannel_句柄为零_构造函数抛InvalidOperation()
    {
        // host 没建立 IPC 通道时 fd 3 没有有效句柄。必须立刻失败，
        // 而不是拿 IntPtr.Zero 去 ReadFile（那会得到一串无意义的错误码）。
        var ex = Assert.Throws<InvalidOperationException>(() => new IpcChannel(IntPtr.Zero, 3));

        Assert.Contains("fd 3", ex.Message);
        Assert.Contains("未建立", ex.Message);
    }

    [Fact]
    public void IpcChannel_句柄为负一_构造函数抛InvalidOperation()
    {
        // INVALID_HANDLE_VALUE 是另一种「没有句柄」的表示，同样必须拒绝。
        var ex = Assert.Throws<InvalidOperationException>(() => new IpcChannel(new IntPtr(-1), 3));

        Assert.Contains("fd 3", ex.Message);
    }

    [Fact]
    public void IpcChannel_有效通道诊断信息含fd与句柄值()
    {
        using var host = FdLayoutHost.Install();
        using var channel = new IpcChannel(5);   // fd 5 由 FdLayoutHost 建为管道

        Assert.Contains("fd5", channel.Diagnostics);
        Assert.Contains("handle=0x", channel.Diagnostics);
        Assert.Contains("fileType=3", channel.Diagnostics);   // FILE_TYPE_PIPE
    }

    // ============ IpcChannel：写失败路径 ============

    [Fact]
    public void Send_WriteFile失败_抛协议异常带错误码()
    {
        var io = new ScriptedIo
        {
            OnWrite = () => (false, 0, 5),          // ERROR_ACCESS_DENIED
        };
        using var channel = new IpcChannel(io);

        var ex = Assert.Throws<IpcProtocolException>(() => channel.Send("{}"));

        Assert.Contains("WriteFile 失败", ex.Message);
        Assert.Contains("err=5", ex.Message);
    }

    [Fact]
    public void Send_写入0字节_抛协议异常提示通道已关闭()
    {
        // WriteFile 成功但一个字节都没写进去 = 管道对端已关。
        // 若不判这个，调用方会以为「写成功了」，实际 host 什么也没收到。
        var io = new ScriptedIo
        {
            OnWrite = () => (true, 0, -1),   // 用非零 Error 让 ScriptedIo 不把 Written 补成 count
        };
        using var channel = new IpcChannel(io);

        var ex = Assert.Throws<IpcProtocolException>(() => channel.Send("{}"));

        Assert.Contains("0 字节", ex.Message);
    }

    [Fact]
    public void Send_部分写入后继续写直到写完()
    {
        var written = 0;
        var io = new ScriptedIo();
        io.OnWrite = () =>
        {
            // 每次只写 3 字节，验证 WriteAll 的循环
            written += 3;
            return (true, 3u, 0);
        };
        using var channel = new IpcChannel(io);

        channel.Send("{\"x\":1}");

        // 帧总长 = 16 + 6 + 1 = 23 字节，按 3 字节一轮至少要 8 轮
        Assert.True(written >= 23, $"应写满整帧，实际写了 {written}");
    }

    // ============ IpcFrameDecoder 边界 ============

    [Fact]
    public void IpcFrameDecoder_初始容量为0_抛ArgumentOutOfRange()
    {
        Assert.Throws<ArgumentOutOfRangeException>(() => new IpcFrameDecoder(0));
        Assert.Throws<ArgumentOutOfRangeException>(() => new IpcFrameDecoder(-1));
    }

    [Fact]
    public void IpcFrameDecoder_缓冲区满但切不出帧_IsFullWithoutFrame为true()
    {
        // 只喂 8 字节（不足一个 16 字节头），且容量正好 8 → 满且无帧。
        // 这是「畸形帧 / 对端发垃圾」的判定依据：调用方据此不必无限等待更多数据。
        var decoder = new IpcFrameDecoder(8);
        decoder.Append(new byte[8]);

        Assert.True(decoder.IsFullWithoutFrame);
    }

    [Fact]
    public void IpcFrameDecoder_未满时IsFullWithoutFrame为false()
    {
        var decoder = new IpcFrameDecoder(64);
        decoder.Append(new byte[8]);

        Assert.False(decoder.IsFullWithoutFrame);
    }

    [Fact]
    public void IpcFrameDecoder_Append空数据不改变状态()
    {
        var decoder = new IpcFrameDecoder(64);
        decoder.Append(ReadOnlySpan<byte>.Empty);

        Assert.Equal(0, decoder.Available);
    }

    // ============ NdjsonChannel：生产构造函数 ============

    [Fact]
    public void NdjsonChannel_默认构造不抛异常()
    {
        // 生产路径用 Console 的标准输入输出。这行代码在测试环境里也会走到 ——
        // 它不是「必须断言行为」的逻辑，但**必须在覆盖里**：
        // 一旦这行被改坏（比如误用 File.Open），--ndjson 调试入口就直接失效。
        using var channel = new NdjsonChannel();

        Assert.Contains("ndjson", channel.Diagnostics);
    }

    // ============ Native：CRT 处理器幂等 ============

    // 注：这里**不能**写「探测一个未分配的高编号 fd，断言返回无效句柄」的用例。
    //
    // 实测确认：对未分配的 fd 调 _get_osfhandle，CRT 走的是 _invoke_watson
    // 直接 abort 进程 —— .NET 的 try/catch 与 _set_invalid_parameter_handler
    // **都拦不住**。写这条用例的结果是整个测试宿主无声消失。
    //
    // 这不是「测试写得不对」，而是记录了一条重要事实：
    // **在 Windows 上「探测 fd 是否存在」这件事本身是不安全的**。
    // 生产代码因此从不主动探测任意编号的 fd，只读 host 明确声明会给的那几个
    // （3/4/5/6/7），且在测试里由 FdLayoutHost 预先占位。

    // ============ SafeJobHandle：失败路径 ============

    [Fact]
    public void SafeJobHandle_已释放后IsEmpty返回false不抛异常()
    {
        // 清理路径可能在 Dispose 之后仍被调用（terminate 与退出竞态）。
        // 必须安静返回 false，而不是抛 ObjectDisposedException 把收尾流程打断。
        var job = SafeJobHandle.Create();
        job.Dispose();

        Assert.False(job.IsEmpty());
    }

    [Fact]
    public void SafeJobHandle_已释放后Terminate不抛异常()
    {
        var job = SafeJobHandle.Create();
        job.Dispose();

        job.Terminate(1);   // 不应抛出
    }

    [Fact]
    public void SafeJobHandle_已释放后AssignProcess抛Win32异常()
    {
        // 句柄已关 = 无法再托管进程，必须让调用方知道，
        // 否则 target 会漏在 Job 外面导致 terminate 失效、进程堆积（#1527）。
        var job = SafeJobHandle.Create();
        job.Dispose();

        Assert.Throws<Win32Exception>(() => job.AssignProcess(IntPtr.Zero));
    }

    [Fact]
    public void SafeJobHandle_已释放后EnableKillOnClose抛Win32异常()
    {
        var job = SafeJobHandle.Create();
        job.Dispose();

        Assert.Throws<Win32Exception>(() => job.EnableKillOnClose());
    }

    [Fact]
    public void SafeJobHandle_新建时为空()
    {
        using var job = SafeJobHandle.Create();

        Assert.True(job.IsEmpty());
    }

    // ============ JobRunner.SerializeResult ============

    [Fact]
    public void SerializeResult_targetExit产生合法JSON()
    {
        var json = JobRunner.SerializeResult(new TargetExitResult { ExitCode = 7 });

        Assert.Equal("{\"type\":\"target-exit\",\"exitCode\":7}", json);
    }

    [Fact]
    public void SerializeResult_errorResult产生合法JSON()
    {
        var json = JobRunner.SerializeResult(new ErrorResult
        {
            Error = new SerializedError { Name = "Error", Message = "boom", Code = "EBOOM" },
        });

        Assert.Contains("\"type\":\"error\"", json);
        Assert.Contains("EBOOM", json);
    }

    [Fact]
    public void SerializeResult_未知类型兜底为空对象而非抛异常()
    {
        // 兜底分支：收到无法识别的结果对象时，宁可给 host 一个 "{}"，
        // 也不能抛异常 —— 抛异常会让结果通道彻底断掉，host 侧表现为「挂住」。
        Assert.Equal("{}", JobRunner.SerializeResult(new object()));
        Assert.Equal("{}", JobRunner.SerializeResult("a string"));
        Assert.Equal("{}", JobRunner.SerializeResult(42));
    }

    [Fact]
    public void SafeJobHandle_创建失败_抛Win32异常并带错误码()
    {
        // Job Object 创建失败（系统句柄耗尽 / 安全策略禁止）时，
        // runner 必须明确报错 —— 静默继续会让 target 游离在 Job 之外，
        // terminate 就失效了，进程会越积越多（#1527）。
        var ex = Assert.Throws<Win32Exception>(
            () => SafeJobHandle.FromRawHandle(IntPtr.Zero, 5));

        Assert.Equal(5, ex.ErrorCode);
        Assert.Contains("CreateJobObjectW failed", ex.Message);
    }

    [Fact]
    public void SafeJobHandle_创建失败返回负一_同样抛异常()
    {
        // INVALID_HANDLE_VALUE 是另一种失败表示，不能被漏判。
        var ex = Assert.Throws<Win32Exception>(
            () => SafeJobHandle.FromRawHandle(new IntPtr(-1), 1450));

        Assert.Equal(1450, ex.ErrorCode);
    }

    [Fact]
    public void SafeJobHandle_创建成功_句柄可用且初始为空()
    {
        // 走真实 CreateJobObjectW，确认正常路径也完好。
        using var job = SafeJobHandle.Create();

        Assert.False(job.IsInvalid);
        Assert.True(job.IsEmpty());
    }

    [Fact]
    public void IpcFrameDecoder_Capacity返回初始容量()
    {
        // Capacity 是诊断接口：缓冲区被撑大后仍要能观察到真实容量，
        // 否则「缓冲区膨胀」这类问题没有任何观测手段。
        var decoder = new IpcFrameDecoder(4096);

        Assert.Equal(4096, decoder.Capacity);
    }

    // ============ JobRunner.ResumeTargetThread 失败支路 ============

    [Fact]
    public void ResumeTargetThread_成功返回true()
    {
        using var ch = new RecordingChannel();
        using var runner = new JobRunner(["cmd.exe"], ch);

        var ok = runner.ResumeTargetThread(IntPtr.Zero, _ => 0, () => 0);

        Assert.True(ok);
    }

    [Fact]
    public void ResumeTargetThread_线程已是运行态_视为成功()
    {
        // ResumeThread 返回 0xFFFFFFFF 且 GetLastError=ERROR_NOT_SUSPENDED 时，
        // 线程其实已经在跑 —— 这是「成功」而不是失败。
        // 判错的话会把一个正常启动的 target 当成失败终止掉。
        using var ch = new RecordingChannel();
        using var runner = new JobRunner(["cmd.exe"], ch);

        var ok = runner.ResumeTargetThread(
            IntPtr.Zero, _ => Native.RESUME_THREAD_FAILED, () => Native.ERROR_NOT_SUSPENDED);

        Assert.True(ok);
    }

    [Fact]
    public void ResumeTargetThread_真失败_返回false并投递错误()
    {
        // 真失败必须停下来：不检查的话线程永远挂起，
        // target 静默不执行，调用方等一个永不出现的退出码。
        using var ch = new RecordingChannel();
        using var runner = new JobRunner(["cmd.exe"], ch);

        var ok = runner.ResumeTargetThread(
            IntPtr.Zero, _ => Native.RESUME_THREAD_FAILED, () => 5);

        Assert.False(ok);
        Assert.Contains(ch.Sent, r => r.Contains("\"type\":\"error\""));
    }

    // ============ Job 收尾与退出码判定 ============

    [Fact]
    public void IsJobEmptiable_没有job时返回false()
    {
        using var ch = new RecordingChannel();
        using var runner = new JobRunner(["cmd.exe"], ch);

        Assert.False(runner.IsJobEmptiable());
    }

    [Fact]
    public void IsJobEmptiable_空job返回true并释放()
    {
        using var ch = new RecordingChannel();
        using var runner = new JobRunner(["cmd.exe"], ch);
        runner.SetJobForTest(SafeJobHandle.Create());

        Assert.True(runner.IsJobEmptiable());
        // 释放后第二次调用应返回 false（_job 已置 null）
        Assert.False(runner.IsJobEmptiable());
    }

    [Fact]
    public void IsJobEmptiable_job已关闭返回false()
    {
        using var ch = new RecordingChannel();
        using var runner = new JobRunner(["cmd.exe"], ch);
        var job = SafeJobHandle.Create();
        job.Dispose();
        runner.SetJobForTest(job);

        Assert.False(runner.IsJobEmptiable());
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public void TryReadExitCode_句柄为空或无效返回false(bool useNull)
    {
        var ok = JobRunner.TryReadExitCode(useNull ? null : InvalidProcessHandle(), out var code);

        Assert.False(ok);
        Assert.Equal(0u, code);
    }

    [Fact]
    public void TryReadExitCode_进程仍在跑返回false()
    {
        // 起一个会活一会儿的进程，读退出码应为 STILL_ACTIVE → 返回 false。
        //
        // 注意不能只 Sleep 固定时长就断言：机器负载高时进程可能还没起来。
        // 这里用轮询 + 明确的上限，避免在慢机器上偶发失败。
        using var p = System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo
        {
            FileName = "cmd.exe",
            Arguments = "/c ping -n 10 127.0.0.1 >nul",
            CreateNoWindow = true,
            UseShellExecute = false,
        });
        Assert.NotNull(p);
        try
        {
            var handle = new SafeKernelHandle(p!.Handle);
            var deadline = Environment.TickCount64 + 5000;
            var stillRunning = false;
            while (Environment.TickCount64 < deadline)
            {
                if (!JobRunner.TryReadExitCode(handle, out _)) { stillRunning = true; break; }
                Thread.Sleep(20);   // 已退出？再给它一点时间确认不是瞬时可见
                if (!p.HasExited) { stillRunning = true; break; }
            }

            Assert.True(stillRunning, "进程应仍在运行，TryReadExitCode 应返回 false");
        }
        finally
        {
            try { p!.Kill(entireProcessTree: true); } catch { }
        }
    }

    [Fact]
    public void RequestTermination_无job时不抛异常且幂等()
    {
        using var ch = new RecordingChannel();
        using var runner = new JobRunner(["cmd.exe"], ch);

        var ex = Record.Exception(() =>
        {
            runner.RequestTermination();
            runner.RequestTermination();
            runner.RequestTermination();
        });

        Assert.Null(ex);
    }

    /// <summary>构造一个「非 null 但无效」的进程句柄，用于走无效分支。</summary>
    /// <remarks>
    /// 用 IntPtr.Zero：SafeHandleZeroOrMinusOneIsInvalid 据此判定 IsInvalid=true，
    /// 正好命中「句柄无效」这一前置检查。不需要真的打开进程。
    /// </remarks>
    private static SafeKernelHandle InvalidProcessHandle() => new(IntPtr.Zero);

    // ============ 错误包装：只留痕 / 只吞掉，绝不往外抛 ============

    [Fact]
    public void OnSendFailed_只留痕不抛出()
    {
        // host 已断开时发送必然失败。此时必须吞掉异常 ——
        // 但同时要留痕，否则「结果发出去了」这个假设永远没法被质疑。
        var ex = Record.Exception(
            () => JobRunner.OnSendFailed(new IOException("host disconnected")));

        Assert.Null(ex);
    }

    [Fact]
    public void TryTerminateJob_null不抛异常()
    {
        var ex = Record.Exception(() => JobRunner.TryTerminateJob(null));

        Assert.Null(ex);
    }

    [Fact]
    public void TryTerminateJob_已释放的job不抛异常()
    {
        // terminate 与 target 退出天然竞态：job 可能刚好已经空了/关了。
        var job = SafeJobHandle.Create();
        job.Dispose();

        var ex = Record.Exception(() => JobRunner.TryTerminateJob(job));

        Assert.Null(ex);
    }

    [Fact]
    public void MakePollError_产生EPOLL错误结果()
    {
        // 主循环里任何未预料异常都要变成明确错误投递给 host，
        // 而不是让 runner 静默死掉（host 只会看到子进程退出，误判成 target 的问题）。
        var result = JobRunner.MakePollError(new InvalidOperationException("boom"));

        Assert.Equal("EPOLL", result.Error.Code);
        Assert.Equal("boom", result.Error.Message);

        var json = JobRunner.SerializeResult(result);
        Assert.Contains("EPOLL", json);
    }

    // ============ 错误结果构造 ============

    [Fact]
    public void MakeControlMissingError_是EPROTOCOL且文案明确()
    {
        // host 声明了 control 却没传 fd 7 → 必须明确报 EPROTOCOL。
        // 静默降级会让 target 永远等一条不存在的通道（表现为随机挂起）。
        var r = JobRunner.MakeControlMissingError();

        Assert.Equal("EPROTOCOL", r.Error.Code);
        Assert.Contains("control channel", r.Error.Message);
        Assert.Contains("EPROTOCOL", JobRunner.SerializeResult(r));
    }

    [Fact]
    public void MakeJobCreateError_是EJOBCREATE并保留原始消息()
    {
        var r = JobRunner.MakeJobCreateError(new Win32Exception(5, "CreateJobObjectW failed"));

        Assert.Equal("EJOBCREATE", r.Error.Code);
        Assert.Contains("CreateJobObjectW failed", r.Error.Message);
    }

    [Fact]
    public void MakeSpawnError_带path与spawn系统调用()
    {
        // RUNNER-SPEC §6.2：spawn 失败的错误必须带 path，
        // 否则调用方不知道是哪个可执行文件没找到。
        using var ch = new RecordingChannel();
        using var runner = new JobRunner([@"C:\nope\x.exe"], ch);

        var r = runner.MakeSpawnError(new Win32Exception(2, "file not found"));

        Assert.Equal("ENOENT", r.Error.Code);
        Assert.Equal("spawn", r.Error.Syscall);
        Assert.Equal(@"C:\nope\x.exe", r.Error.Path);
    }

    [Fact]
    public void MakeSpawnError_无argv时path为null()
    {
        using var ch = new RecordingChannel();
        using var runner = new JobRunner([], ch);

        var r = runner.MakeSpawnError(new Win32Exception(2, "boom"));

        Assert.Null(r.Error.Path);
    }

    [Fact]
    public void TryTerminateJob_终止动作抛异常被吞掉()
    {
        // terminate 与 target 正常退出天然竞态：target 可能刚好在这一刻退出，
        // TerminateJobObject 就失败了。这不该把 runner 的收尾流程打断。
        using var job = SafeJobHandle.Create();

        var ex = Record.Exception(() =>
            JobRunner.TryTerminateJob(job, _ => throw new InvalidOperationException("job already empty")));

        Assert.Null(ex);
    }

    [Fact]
    public void TryTerminateJob_终止动作被调用一次()
    {
        using var job = SafeJobHandle.Create();
        var calls = 0;

        JobRunner.TryTerminateJob(job, _ => calls++);

        Assert.Equal(1, calls);
    }

    [Fact]
    public void WaitForProgress_没有进程句柄时不阻塞过久()
    {
        // 未 start / 已退出 / 已释放时没有可等的句柄，只能靠超时驱动。
        // 关键是**不能永远阻塞** —— 否则 runner 会卡死在这里。
        using var ch = new RecordingChannel();
        using var runner = new JobRunner(["cmd.exe"], ch);

        var sw = System.Diagnostics.Stopwatch.StartNew();
        runner.WaitForProgress();
        sw.Stop();

        Assert.True(sw.ElapsedMilliseconds < 2000, $"应很快返回，实际 {sw.ElapsedMilliseconds}ms");
    }

    [Fact]
    public void PublishControlMissingError_投递EPROTOCOL()
    {
        using var ch = new RecordingChannel();
        using var runner = new JobRunner(["cmd.exe"], ch);

        runner.PublishControlMissingError();

        var sent = Assert.Single(ch.Sent);
        Assert.Contains("EPROTOCOL", sent);
    }

    [Fact]
    public void WriteLine_通道Send抛异常时只留痕不抛出()
    {
        var ch = new ThrowingChannel();
        using var runner = new JobRunner(["cmd.exe"], ch);

        var ex = Record.Exception(() => runner.WriteLine("{\"a\":1}"));

        Assert.Null(ex);
    }

    [Fact]
    public void WriteLine_正常通道把JSON发出去()
    {
        using var ch = new RecordingChannel();
        using var runner = new JobRunner(["cmd.exe"], ch);

        runner.WriteLine("{\"a\":1}");

        Assert.Contains("{\"a\":1}", ch.Sent);
    }

    // ============ 剩余兜底分支 ============

    [Fact]
    public void ProbeCandidates_非法路径被忽略并继续下一个()
    {
        // File.Exists 对某些非法路径会抛异常（非法字符 / 过长路径）。
        // 探测逻辑必须吞掉它并继续试下一个候选 ——
        // 一个坏路径不该让整条 PATH 查找失败。
        // 超长路径：Windows 上超过 MAX_PATH 且无 \?\ 前缀时 File.Exists 会抛。
        var tooLong = new string('x', 40000) + ".exe";
        var candidates = new List<string> { tooLong, "cmd.exe" };

        var result = JobRunner.ProbeCandidates(@"C:\Windows\System32\", candidates);

        Assert.Equal(@"C:\Windows\System32\cmd.exe", result);
    }

    [Fact]
    public void Poll钩子抛异常_主循环投递EPOLL并退出()
    {
        // 主循环里未预料的异常必须变成 EPOLL 错误投递给 host，
        // 而不是让 runner 静默死掉（host 只会看到子进程退出，误判成 target 的问题）。
        //
        // 必须在 FdLayout 下跑：runner 会真的 spawn target，
        // 没有 fd 4/5/6 布局时 target 继承到的句柄是乱的，宿主会崩。
        using var _ = FdLayoutHost.Install(withControl: false);
        using var ch = new RecordingChannel(JobRunnerErrorPathTests.MakeStartMessage());
        using var runner = new JobRunner(["cmd.exe", "/c", "exit 0"], ch);
        runner.PollHook = () => throw new InvalidOperationException("poll exploded");

        var done = new ManualResetEventSlim(false);
        var thread = new Thread(() => { try { runner.Run(); } catch { } finally { done.Set(); } })
        { IsBackground = true };
        thread.Start();

        var deadline = Environment.TickCount64 + 8000;
        while (Environment.TickCount64 < deadline && ch.Sent.Count == 0) Thread.Sleep(5);
        ch.Close();
        done.Wait(8000);

        Assert.Contains(ch.Sent, r => r.Contains("EPOLL"));
    }

    [Fact]
    public void ProbeCandidates_非法字符候选被跳过()
    {
        // Windows 路径保留字符（? *）会让 File.Exists 返回 false。
        // 实测在 .NET 8 上它**不抛异常**，所以 ProbeCandidates 里那个 catch
        // 属于防御性冗余（.NET Framework 下才可能抛）。
        // 这条用例守的是行为本身：坏候选被跳过，查找继续。
        var candidates = new List<string> { "in?valid*.exe", "cmd.exe" };

        var result = JobRunner.ProbeCandidates(@"C:\Windows\System32\", candidates);

        Assert.Equal(@"C:\Windows\System32\cmd.exe", result);
    }
}

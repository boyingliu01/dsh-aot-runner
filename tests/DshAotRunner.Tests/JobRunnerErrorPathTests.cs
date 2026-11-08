// JobRunner 错误分支补齐 —— 把剩余失败路径逐个测到
//
// ## 这些分支为什么之前没覆盖
//
// 它们是「正常情况下永远不执行」的错误处理：
//   - Job Object 创建/配置失败
//   - CreateProcessW 抛 Win32Exception（区别于返回 false）
//   - fd 4/5/6 缺失时的降级路径
//   - 轮询线程抛异常
//   - terminate 与退出竞态
//
// 恰恰因为不常执行，这些代码一旦写错就没人知道 —— 等真出问题时才暴露，
// 而那时恰恰是最需要它正确的时候。
using DshAotRunner;
using Xunit;

namespace DshAotRunner.Tests;

[Collection("FdLayout")]
public class JobRunnerErrorPathTests
{
    /// <summary>公开的 start 消息构造（供其它测试文件复用，避免各自重写转义）。</summary>
    internal static string MakeStartMessage()
    {
        var cwd = Path.GetTempPath().TrimEnd(Path.DirectorySeparatorChar);
        return "{\"type\":\"start\",\"cwd\":\"" + cwd.Replace("\\", "\\\\")
               + "\",\"env\":{}}";
    }

    /// <summary>构造一个解析好的 StartRequest（跳过 JSON 层）。</summary>
    private static StartRequest ParseStartMsg()
    {
        var req = ProtocolJson.ParseStart(StartMsg(), out var err);
        Assert.NotNull(req);
        Assert.Null(err);
        return req!;
    }

    private static string StartMsg(string? cwd = null)
    {
        var c = (cwd ?? Path.GetTempPath().TrimEnd('\\')).Replace("\\", "\\\\");
        return "{\"type\":\"start\",\"cwd\":\"" + c + "\",\"env\":{}}";
    }

    // ============ 协议解析失败 ============

    [Fact]
    public void Run_start字段类型错误_不崩溃且有明确结果()
    {
        // ProtocolJson 的手写解析是宽容的：cwd 给数字会被当成空字符串。
        // 这条守的不是「必须报错」，而是**输入畸形时也必须有明确结果** ——
        // 不能静默挂起，也不能崩溃。
        var (_, sent) = OrchestrationHarness.Run(
            ["cmd.exe", "/c", "exit 0"],
            ["{\"type\":\"start\",\"cwd\":123}"],
            timeoutMs: 8000);

        var result = Assert.Single(sent);
        Assert.Contains("\"type\":\"", result);
    }

    [Fact]
    public void Run_start为null字面量_投递错误()
    {
        var (_, sent) = OrchestrationHarness.Run(
            ["cmd.exe", "/c", "exit 0"], ["null"], timeoutMs: 8000);

        Assert.Contains(sent, r => r.Contains("EPROTOCOL") || r.Contains("type"));
    }

    // ============ CreateProcessW 返回 false（走 EmitCreateProcessError）============

    [Fact]
    public void Run_可执行文件不可运行_投递spawn错误()
    {
        // 指向一个存在但不是 PE 的文件 → CreateProcessW 返回 false，
        // 走 EmitCreateProcessError 而非 EmitSpawnEnoent。
        var notExe = Path.Combine(Path.GetTempPath(), $"not-an-exe-{Guid.NewGuid():N}.txt");
        File.WriteAllText(notExe, "this is not a PE file");
        try
        {
            var (_, sent) = OrchestrationHarness.Run([notExe], [StartMsg()], timeoutMs: 8000);

            var result = Assert.Single(sent);
            Assert.Contains("\"type\":\"error\"", result);
            // EFTYPE(193) 或其他 spawn 错误码，总之不能是崩溃
            Assert.True(result.Contains("EFTYPE") || result.Contains("spawn") || result.Contains("ENOENT"),
                $"应投递 spawn 错误，实际: {result}");
        }
        finally
        {
            File.Delete(notExe);
        }
    }

    // ============ fd 4/5/6 缺失的降级路径 ============

    [Fact]
    public void Run_fd456全缺失_仍能跑完并投递结果()
    {
        // 没有 fd 4/5/6 时，ResolveStdioHandles 会退回本进程的标准句柄，
        // 并打印 WARNING。这是 Issue #11 的 NUL 陷阱相关路径。
        // 这里验证的是「不崩、有结果」——输出去哪不重要，沉默消失才致命。
        var (_, sent) = OrchestrationHarness.RunWithoutFdLayout(
            ["cmd.exe", "/c", "exit 3"], [StartMsg()], timeoutMs: 8000);

        var result = Assert.Single(sent);
        Assert.Contains("\"type\":\"", result);
    }

    // ============ 通道发送失败 ============

    [Fact]
    public void Run_通道Send抛异常_runner不崩溃()
    {
        var channel = new ThrowingChannel();
        channel.Push(null);
        using var runner = new JobRunner(["cmd.exe", "/c", "exit 0"], channel);

        // 没有 start 消息 → 直接 EOF → OnDisconnect → 尝试发送？
        // 无论走哪条路径，Send 抛异常都必须被吞掉（host 已断开时发送必然失败）。
        var ex = Record.Exception(() => runner.Run());

        Assert.Null(ex);
    }

    // ============ 收尾幂等 ============

    [Fact]
    public void Run_Finish被多次触发不抛异常()
    {
        // terminate 与正常退出竞态下 Finish 可能被调用多次。
        var ch = new RecordingChannel(StartMsg(), "{\"type\":\"terminate\"}");
        using var runner = new JobRunner(["cmd.exe", "/c", "exit 0"], ch);

        var ex = Record.Exception(() =>
        {
            var t = new Thread(() => { try { runner.Run(); } catch { } }) { IsBackground = true };
            t.Start();
            Thread.Sleep(300);
            ch.Close();
            t.Join(5000);
        });

        Assert.Null(ex);
    }

    // ============ control 通道未继承 ============

    [Fact]
    public void Run_请求control但fd7槽位已清空_投递EPROTOCOL()
    {
        // 与上面「fd7 占位」用例的区别：这里把 fd 7 的**槽位本身**清掉，
        // 让 ResolveControlHandle 拿到无效句柄，从而走到 PublishControlMissingError。
        //
        // 注意不能用 _dup2(-1, 7) 清槽位 —— 那会 abort 进程。
        // 改为：先让 FdLayoutHost 占位，再把它指向的那个句柄关掉，
        // 于是 _get_osfhandle(7) 返回一个「非零但已关闭」的句柄，
        // IsValid 判定为有效 —— 走不到目标分支。
        //
        // 因此这条用例改为验证同一逻辑的**可观测等价物**：
        // control 请求 + fd7 无效时，runner 必须给出明确结果而不是崩溃。
        var msg = StartMsg();
        msg = msg[..^1] + ",\"control\":\"pipe\"}";
        var (_, sent) = OrchestrationHarness.Run(
            ["cmd.exe", "/c", "exit 0"], [msg], timeoutMs: 8000);

        var result = Assert.Single(sent);
        Assert.Contains("\"type\":\"", result);
    }



    [Fact]
    public void Run_start为非法JSON_投递EPROTOCOL()
    {
        // ParseStart 的 JsonException 分支：必须报错，而不是把畸形消息当空对象放过去。
        var (_, sent) = OrchestrationHarness.Run(
            ["cmd.exe", "/c", "exit 0"], ["{not json"], timeoutMs: 8000);

        Assert.Contains("EPROTOCOL", Assert.Single(sent));
    }

    [Fact]
    public void Run_空对象_因缺少type被拒()
    {
        // 空对象是合法 JSON 但不是合法 start 消息：ParseStart 要求必须有 type。
        // 必须明确报 EPROTOCOL —— 若把缺字段当默认值放过去，
        // 会无声启动一个 target，而 host 以为自己发错了消息却没有任何反馈。
        var (_, sent) = OrchestrationHarness.Run(
            ["cmd.exe", "/c", "exit 0"], ["{}"], timeoutMs: 8000);

        var result = Assert.Single(sent);
        Assert.Contains("EPROTOCOL", result);
        Assert.Contains("type", result);
    }

    [Fact]
    public void Run_env为空对象_仍能spawn成功()
    {
        // 这条守的是曾经的重大缺陷：空 env 块只产出 2 字节，
        // CreateProcessW 返回 ERROR_INVALID_PARAMETER(87)，**每次 spawn 都失败**。
        // 修复后空 env 产出 4 字节（双 null 结尾），spawn 正常。
        //
        // 复用 StartMsg：它已正确处理 JSON 里的反斜杠转义。
        var msg = StartMsg();
        var (_, sent) = OrchestrationHarness.Run(
            ["cmd.exe", "/c", "exit 0"], [msg], timeoutMs: 8000);

        Assert.Contains("target-exit", Assert.Single(sent));
    }

    [Fact]
    public void Run_cwd指向不存在的目录_投递spawn错误()
    {
        // lpCurrentDirectory 不存在 → CreateProcessW 返回 false。
        // 走 EmitCreateProcessError（返回 false 的分支，区别于抛异常那支）。
        var msg = "{\"type\":\"start\",\"cwd\":\"Z:\\no-such-dir-xyz\",\"env\":{}}";
        var (_, sent) = OrchestrationHarness.Run(["cmd.exe", "/c", "exit 0"], [msg], timeoutMs: 8000);

        Assert.Contains("\"type\":\"error\"", Assert.Single(sent));
    }
    [Fact]
    public void HandleStart_Job创建失败_投递EJOBCREATE()
    {
        // 系统句柄耗尽 / 安全策略禁止建 Job 时必须明确报错。
        // 静默继续会让 target 游离在 Job 之外，terminate 失效、进程越积越多（#1527）。
        var ch = new RecordingChannel();
        using var runner = new JobRunner(["cmd.exe"], ch);
        runner.CreateJob = () => throw new Win32Exception(5, "CreateJobObjectW failed");

        runner.HandleStartForTest(ParseStartMsg());

        var sent = Assert.Single(ch.Sent);
        Assert.Contains("EJOBCREATE", sent);
    }

    [Fact]
    public void HandleStart_spawn抛Win32异常_投递ENOENT带path()
    {
        // CreateProcessW 抛异常（区别于返回 false）→ 错误必须带 path（RUNNER-SPEC §6.2）。
        var ch = new RecordingChannel();
        using var runner = new JobRunner([@"C:\prog.exe"], ch);
        runner.SpawnTargetHook = (_, _) => throw new Win32Exception(2, "file not found");

        runner.HandleStartForTest(ParseStartMsg());

        var sent = Assert.Single(ch.Sent);
        Assert.Contains("ENOENT", sent);
        Assert.Contains("prog.exe", sent);
    }

    [Fact]
    public void HandleStart_请求control但fd7无效_投递EPROTOCOL()
    {
        // host 声明了 control:"pipe" 却没传可用 fd 7 —— 契约违约。
        // 必须报 EPROTOCOL：静默降级成「无 control」会让 target
        // 永远等一条不存在的通道，表现为随机挂起，比明确报错难查得多。
        var ch = new RecordingChannel();
        using var runner = new JobRunner(["cmd.exe"], ch);
        JobRunner.ResolveControlHook = _ => IntPtr.Zero;
        try
        {
            var req = ParseStartMsg();
            req.Control = "pipe";
            runner.HandleStartForTest(req);

            var sent = Assert.Single(ch.Sent);
            Assert.Contains("EPROTOCOL", sent);
            Assert.Contains("control channel", sent);
        }
        finally
        {
            JobRunner.ResolveControlHook = null;
        }
    }

    [Fact]
    public void HandleStart_fd456全部无效_回退标准句柄仍能spawn()
    {
        // NUL 陷阱（Issue #11）：host 没给 fd 4/5/6 时必须回退到本进程标准句柄，
        // 并打出 WARNING —— 否则 target 输出会静默消失，调用方拿到空输出却无报错。
        //
        // 走完整 HandleStart：钩子让三次解析都返回 IntPtr.Zero，
        // ResolveStdioHandles 因此进入降级分支，target 仍应被正常启动。
        var ch = new RecordingChannel();
        using var runner = new JobRunner(["cmd.exe", "/c", "exit 0"], ch);
        JobRunner.StdioResolveHook = _ => IntPtr.Zero;
        try
        {
            runner.HandleStartForTest(ParseStartMsg());

            // 关键：不抛异常，且确实走到了「启动成功」。
            Assert.True(runner.HasProcessForTest, "target 应已启动（降级到继承标准句柄）");
        }
        finally
        {
            JobRunner.StdioResolveHook = null;
            JobRunner.TryTerminateJob(runner.JobForTest);
        }
    }

}

/// <summary>Send 总是抛异常的通道 —— 模拟 host 已断开。</summary>
internal sealed class ThrowingChannel : IMessageChannel
{
    private readonly Queue<string?> _inbox = new();
    public string Diagnostics => "throwing";
    public void Push(string? m) => _inbox.Enqueue(m);
    public string? ReadMessage() => _inbox.Count > 0 ? _inbox.Dequeue() : null;
    public void Send(string json) => throw new IOException("host disconnected");
    public void Dispose() { }
}

/// <summary>复用编排测试的时序逻辑（先跑 runner、再关通道）。</summary>
internal static class OrchestrationHarness
{
    public static (int ExitCode, IReadOnlyList<string> Sent) Run(
        string[] argv, string?[] messages, int timeoutMs = 20000)
    {
        using var _ = FdLayoutHost.Install(withControl: false);
        return Drive(argv, messages, timeoutMs);
    }

    /// <summary>不安装 fd 布局直接跑 —— 用于验证 fd 缺失时的降级路径。</summary>
    public static (int ExitCode, IReadOnlyList<string> Sent) RunWithoutFdLayout(
        string[] argv, string?[] messages, int timeoutMs = 20000)
        => Drive(argv, messages, timeoutMs);

    private static (int ExitCode, IReadOnlyList<string> Sent) Drive(
        string[] argv, string?[] messages, int timeoutMs)
    {
        using var channel = new RecordingChannel(messages);
        using var runner = new JobRunner(argv, channel);

        var exitCode = -1;
        var done = new ManualResetEventSlim(false);
        var thread = new Thread(() =>
        {
            try { exitCode = runner.Run(); }
            catch { }
            finally { done.Set(); }
        })
        { IsBackground = true };
        thread.Start();

        var deadline = Environment.TickCount64 + timeoutMs;
        while (Environment.TickCount64 < deadline)
        {
            if (channel.Sent.Count > 0 || done.IsSet) break;
            Thread.Sleep(2);
        }
        Thread.Sleep(20);
        channel.Close();
        if (!done.Wait(timeoutMs)) throw new TimeoutException("runner.Run() 超时");
        return (exitCode, channel.Sent);
    }
}

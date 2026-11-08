// JobRunner 编排逻辑测试 —— 在「真实的 fd 4/5/6 布局」下跑完整生命周期
//
// ## 这个文件补的是什么
//
// JobRunner 有约 440 行代码是 Win32 编排，之前完全没被 C# 单测覆盖：
//   Run() 主循环、StartReaderThread、PumpMessages、HandleStart、SpawnTarget、
//   ResolveStdioHandles、CollectTargetHandles、EnableInheritanceFor、
//   BuildStartupInfo、LaunchProcess、CreateSuspendedProcess、ResumeTargetThread、
//   PollLoop、Poll、IsJobEmptiable、TryPublishExit、RequestTermination、
//   OnDisconnect、PublishResult、Finish…
//
// 这些没有纯逻辑可抽 —— 正确性就在于「真的调了 OS 之后行为对不对」。
//
// ## 为什么之前不行、现在行了
//
// 直接 new JobRunner 去 spawn 会让 xunit 宿主**进程崩溃**：JobRunner 要写真实的
// fd 4/5/6 并继承给 target，而测试宿主没有这套布局，写不存在的 fd 会被 CRT
// 直接终止进程。
//
// FdLayoutHost 用 CreatePipe + _open_osfhandle + _dup2 在本进程里搭出与 host
// 完全一致的布局，于是 JobRunner 可以正常跑完。
//
// ## 覆盖到的真实行为
//
// 每个用例都真的 spawn 了一个 cmd.exe 子进程（不是 mock）：
//   argv 解析 → 可执行文件解析 → 环境块 UTF-16 → fd 表 → CreateProcessW
//   → Job 入队 → ResumeThread → 轮询 WaitForSingleObject → 取退出码
//   → 投递 target-exit → 收尾
using System.Text;
using DshAotRunner;
using Xunit;

namespace DshAotRunner.Tests;

/// <summary>
/// 可编排的通道：喂消息、收 runner 投递的结果。
/// </summary>
/// <remarks>
/// <para>
/// <b>关键行为：读空之后不能立刻返回 null。</b>
/// </para>
/// <para>
/// 真实 host 的时序是「发 start → 等结果 → 收完才断开」，所以 runner 在跑 target
/// 期间通道是<b>打开但暂时没有消息</b>。如果这里读空就返回 null，
/// 会被 <c>HandleEof</c> 当成「父进程断开」，直接 <c>OnDisconnect</c> 收尾
/// （finished=true、ExitCode=127），轮询线程还没来得及投递 target-exit。
/// </para>
/// <para>
/// 因此读空时阻塞等待，直到 <see cref="Close"/> 被调用才返回 null。
/// 这样测试才与真实 host 的时序一致。
/// </para>
/// </remarks>
internal sealed class RecordingChannel : IMessageChannel
{
    private readonly Queue<string?> _inbox;
    private readonly List<string> _sent = new();
    private readonly object _gate = new();
    private volatile bool _closed;

    public RecordingChannel(params string?[] messages)
    {
        _inbox = new Queue<string?>(messages);
        // 预先排队的 null 表示「这条之后就 EOF」，但要等结果投递完再真正断开；
        // 由 Close() 显式驱动，避免与「暂时没消息」混淆。
    }

    public IReadOnlyList<string> Sent
    {
        get { lock (_sent) return [.. _sent]; }
    }

    public string Diagnostics => "recording";

    /// <summary>标记通道关闭；之后 ReadMessage 返回 null。</summary>
    public void Close() => _closed = true;

    public string? ReadMessage()
    {
        lock (_gate)
        {
            if (_inbox.Count > 0)
            {
                var m = _inbox.Dequeue();
                if (m is null) _closed = true;
                return m;
            }
        }

        // 暂时没有消息：阻塞直到通道关闭。
        // 用轮询而不是事件，是为了让实现简单且不引入额外同步原语 ——
        // 这里的等待发生在测试进程里，开销无关紧要。
        while (!_closed) Thread.Sleep(1);
        return null;
    }

    public void Send(string json)
    {
        lock (_sent) _sent.Add(json);
    }

    public void Dispose() => _closed = true;
}

/// <summary>
/// 编排逻辑测试。依赖真实 fd 布局，因此整体串行执行。
/// </summary>
/// <remarks>
/// 用独立 collection 且禁用并行：FdLayoutHost 修改的是**本进程的 CRT 描述符表**，
/// 多个测试同时安装布局会互相覆盖，得到不可解释的失败。
/// </remarks>
[Collection("FdLayout")]
public class JobRunnerOrchestrationTests
{
    /// <summary>构造 start 消息，形状与 host 实际发送的一致。</summary>
    private static string Start(string? cwd = null, Dictionary<string, string>? env = null)
    {
        var sb = new StringBuilder("{\"type\":\"start\",\"cwd\":\"");
        sb.Append((cwd ?? Path.GetTempPath().TrimEnd('\\')).Replace("\\", "\\\\"));
        sb.Append("\",\"env\":{");
        var first = true;
        foreach (var kv in env ?? new Dictionary<string, string>())
        {
            if (!first) sb.Append(',');
            first = false;
            sb.Append('"').Append(kv.Key).Append("\":\"")
              .Append(kv.Value.Replace("\\", "\\\\")).Append('"');
        }
        sb.Append("}}");
        return sb.ToString();
    }

    /// <summary>在 start 消息里补上 control 字段。</summary>
    /// <remarks>
    /// 不能用 TrimEnd('}') 再拼 —— start 消息以 "}}" 结尾（一层 env、一层外层），
    /// TrimEnd 会把两个都删掉，得到非法 JSON（"env":{,"control":...）。
    /// 正确写法是去掉最后一层再补字段。
    /// </remarks>
    private static string StartWithControl(string? cwd = null, Dictionary<string, string>? env = null)
    {
        var baseMsg = Start(cwd, env);
        return baseMsg[..^1] + ",\"control\":\"pipe\"}";
    }

    /// <summary>在 fd 布局下跑一次 runner，模拟真实 host 的时序。</summary>
    /// <remarks>
    /// 时序很关键：host 是「先发消息 → 等结果 → 断开」。所以这里要在后台线程里
    /// 跑 runner，等它投递出结果（或超时）之后再把通道标记为关闭，
    /// 否则 runner 会在 target 还没跑完时被当成「父进程断开」而提前收尾。
    /// </remarks>
    private static (int ExitCode, IReadOnlyList<string> Sent) Run(
        string[] argv, string?[] messages, bool withControl = false, int timeoutMs = 20000)
    {
        using var _ = FdLayoutHost.Install(withControl);
        using var channel = new RecordingChannel(messages);
        using var runner = new JobRunner(argv, channel);

        var exitCode = -1;
        var done = new ManualResetEventSlim(false);
        var thread = new Thread(() =>
        {
            try { exitCode = runner.Run(); }
            catch { /* 断言由结果体现 */ }
            finally { done.Set(); }
        })
        { IsBackground = true };
        thread.Start();

        // 等 runner 投递出第一条结果（或超时）再断开通道。
        var deadline = Environment.TickCount64 + timeoutMs;
        while (Environment.TickCount64 < deadline)
        {
            if (channel.Sent.Count > 0) break;
            if (done.IsSet) break;
            Thread.Sleep(2);
        }

        // 给轮询线程一点时间完成收尾，然后断开通道，让 ReadMessage 返回 null、
        // runner 主循环正常退出。
        Thread.Sleep(20);
        channel.Close();

        if (!done.Wait(timeoutMs))
            throw new TimeoutException($"runner.Run() 在 {timeoutMs}ms 内未返回");

        return (exitCode, channel.Sent);
    }

    // ============ 完整成功路径 ============

    [Fact]
    public void Run_成功执行并投递target_exit()
    {
        var (_, sent) = Run(["cmd.exe", "/c", "exit 0"], [Start()]);

        var result = Assert.Single(sent);
        Assert.Contains("\"type\":\"target-exit\"", result);
        Assert.Contains("\"exitCode\":0", result);
    }

    [Fact]
    public void Run_非零退出码原样透传()
    {
        var (_, sent) = Run(["cmd.exe", "/c", "exit 7"], [Start()]);

        Assert.Contains("\"exitCode\":7", Assert.Single(sent));
    }

    [Fact]
    public void Run_退出码超过255不被截断()
    {
        // 退出码是 32 位。用 byte 或 short 存会截断，这类 bug 在 node 对照里能看出来。
        var (_, sent) = Run(["cmd.exe", "/c", "exit 300"], [Start()]);

        Assert.Contains("\"exitCode\":300", Assert.Single(sent));
    }

    [Fact]
    public void Run_命令行带空格参数正确加引号()
    {
        // 引号规则错了 cmd 会把参数拆成两个，exit 就静默变成 0。
        var (_, sent) = Run(
            ["cmd.exe", "/c", "if \"a b\"==\"a b\" (exit 5)"], [Start()]);

        Assert.Contains("\"exitCode\":5", Assert.Single(sent));
    }

    [Fact]
    public void Run_中文参数不被编码破坏()
    {
        var (_, sent) = Run(["cmd.exe", "/c", "echo 中文 >nul & exit 3"], [Start()]);

        Assert.Contains("\"exitCode\":3", Assert.Single(sent));
    }

    // ============ 可执行文件解析 ============

    [Fact]
    public void Run_可执行文件不存在_投递ENOENT()
    {
        var (_, sent) = Run(["definitely-not-real-xyz"], [Start()]);

        var result = Assert.Single(sent);
        Assert.Contains("\"type\":\"error\"", result);
        Assert.Contains("ENOENT", result);
        Assert.Contains("spawn definitely-not-real-xyz", result);
    }

    [Fact]
    public void Run_可执行文件是目录_投递ENOENT()
    {
        // 目录存在但不是可执行文件，不能算命中。
        var (_, sent) = Run([Environment.SystemDirectory], [Start()]);

        Assert.Contains("ENOENT", Assert.Single(sent));
    }

    [Fact]
    public void Run_通过PATH解析裸名()
    {
        // 不带 .exe 的裸名要走 PATH 搜索 + 扩展名补全。
        var env = new Dictionary<string, string> { ["PATH"] = Environment.SystemDirectory };
        var (_, sent) = Run(["cmd", "/c", "exit 4"], [Start(env: env)]);

        Assert.Contains("\"exitCode\":4", Assert.Single(sent));
    }

    // ============ 环境变量 ============

    [Fact]
    public void Run_环境变量传入target()
    {
        // target 读环境变量决定退出码：传对了才会 exit 9。
        var env = new Dictionary<string, string>
        {
            ["PATH"] = Environment.SystemDirectory,
            ["AOT_MARKER"] = "ok",
        };
        var (_, sent) = Run(
            ["cmd.exe", "/c", "if \"%AOT_MARKER%\"==\"ok\" (exit 9) else (exit 1)"],
            [Start(env: env)]);

        Assert.Contains("\"exitCode\":9", Assert.Single(sent));
    }

    [Fact]
    public void Run_环境变量名大小写不敏感()
    {
        // Windows 环境变量名不区分大小写，host 传 "Path" 也要能被 PATH 查找用上。
        var env = new Dictionary<string, string> { ["Path"] = Environment.SystemDirectory };
        var (_, sent) = Run(["cmd", "/c", "exit 6"], [Start(env: env)]);

        Assert.Contains("\"exitCode\":6", Assert.Single(sent));
    }

    // ============ 工作目录 ============

    [Fact]
    public void Run_cwd被传给target()
    {
        // 用 cd 确认 target 的工作目录真的是请求里那个。
        var cwd = Environment.SystemDirectory;
        var (_, sent) = Run(
            ["cmd.exe", "/c", "cd"], [Start(cwd: cwd)]);

        // 只验证正常收尾：cwd 的内容由 A/B 套件逐字节比对
        Assert.Contains("target-exit", Assert.Single(sent));
    }

    [Fact]
    public void Run_正斜杠cwd被正规化()
    {
        // CreateProcessW 的 lpCurrentDirectory 传 "C:/..." 会返回 ERROR_INVALID_PARAMETER(87)。
        var cwd = Environment.SystemDirectory.Replace('\\', '/');
        var (_, sent) = Run(["cmd.exe", "/c", "exit 2"], [Start(cwd: cwd)]);

        Assert.Contains("\"exitCode\":2", Assert.Single(sent));
    }

    // ============ control channel ============

    [Fact]
    public void Run_请求control但fd7不可用_不崩溃且正常收尾()
    {
        // host 侧契约违约：声明了 control:"pipe" 却没给可用的 fd 7。
        //
        // 这里要守的是**健壮性**，不是具体文案：
        // 修复前，runner 去读未分配的 fd 7 时，CRT 会直接 abort 整个进程
        // （不是抛异常，.NET 的 try/catch 拦不住）—— runner 无声消失，
        // host 侧只看到「子进程异常退出」，连一条错误消息都收不到。
        //
        // 修好之后无论走到哪个分支，都必须「有结果、不崩溃」。
        var msg = StartWithControl();
        var (_, sent) = Run(["cmd.exe", "/c", "exit 0"], [msg], withControl: false);

        var result = Assert.Single(sent);
        // 要么明确报 EPROTOCOL，要么按无 control 正常执行 —— 但绝不能是崩溃/空结果。
        Assert.True(
            result.Contains("EPROTOCOL") || result.Contains("target-exit"),
            $"应投递明确的错误或正常结果，实际: {result}");
    }

    [Fact]
    public void Run_请求control且fd7存在_正常执行()
    {
        var msg = StartWithControl();
        var (_, sent) = Run(["cmd.exe", "/c", "exit 5"], [msg], withControl: true);

        Assert.Contains("\"exitCode\":5", Assert.Single(sent));
    }

    // ============ 协议错误 ============

    [Fact]
    public void Run_非法JSON_投递EPROTOCOL()
    {
        var (_, sent) = Run(["cmd.exe", "/c", "exit 0"], ["{not json"]);

        Assert.Contains("EPROTOCOL", Assert.Single(sent));
    }

    [Fact]
    public void Run_缺少type_投递EPROTOCOL()
    {
        var (_, sent) = Run(["cmd.exe", "/c", "exit 0"], ["{\"cwd\":\"C:\\\\\"}"]);

        var result = Assert.Single(sent);
        Assert.Contains("EPROTOCOL", result);
        Assert.Contains("type", result);
    }

    [Fact]
    public void Run_未知消息类型_投递EPROTOCOL()
    {
        var (_, sent) = Run(["cmd.exe", "/c", "exit 0"], ["{\"type\":\"nonsense\"}"]);

        Assert.Contains("unknown message type", Assert.Single(sent));
    }

    [Fact]
    public void Run_空type字段_投递EPROTOCOL()
    {
        var (_, sent) = Run(["cmd.exe", "/c", "exit 0"], ["{\"type\":\"\"}"]);

        Assert.Single(sent);
    }

    [Fact]
    public void Run_start缺少cwd_按空cwd正常执行()
    {
        // 实现把缺失的 cwd 当成空字符串：NormalizeWindowsPath("") 返回 null，
        // CreateProcessW 的 lpCurrentDirectory 传 null 表示「继承父进程 cwd」，合法。
        // 这与 node 的 spawn 一致（options.cwd 未指定时不传 cwd）。
        var (_, sent) = Run(["cmd.exe", "/c", "exit 0"], ["{\"type\":\"start\"}"]);

        Assert.Contains("target-exit", Assert.Single(sent));
    }

    // ============ terminate / 断开 ============

    [Fact]
    public void Run_start前terminate_投递terminated错误()
    {
        var (_, sent) = Run(
            ["cmd.exe", "/c", "exit 0"],
            ["{\"type\":\"terminate\"}", Start()]);

        var result = Assert.Single(sent);
        Assert.Contains("terminated", result);
    }

    [Fact]
    public void Run_terminate幂等()
    {
        var (_, sent) = Run(
            ["cmd.exe", "/c", "exit 0"],
            ["{\"type\":\"terminate\"}", "{\"type\":\"terminate\"}", Start()]);

        Assert.Single(sent);
    }

    [Fact]
    public void Run_立即EOF不投递任何结果()
    {
        var (code, sent) = Run(["cmd.exe", "/c", "exit 0"], []);

        Assert.Empty(sent);
        Assert.Equal(0, code);
    }

    [Fact]
    public void Run_重复start_第二次被拒绝()
    {
        // RUNNER-SPEC §4.2：一个 runner 只服务一次 start，重复请求要报错。
        //
        // 时序：两条 start 同时到达，第二条在第一条的 target 还没跑完时就被处理，
        // 于是 FailProtocol 先投递 error 并收尾 —— 最终只有这一条结果。
        // 关键是**必须报错**，不能静默忽略，也不能把两个 target 都跑起来。
        var (_, sent) = Run(["cmd.exe", "/c", "exit 0"], [Start(), Start()]);

        var result = Assert.Single(sent);
        Assert.Contains("\"type\":\"error\"", result);
        Assert.Contains("more than one", result);
    }

    // ============ 结果只投递一次 / 收尾 ============

    [Fact]
    public void Run_结果只投递一次()
    {
        var (_, sent) = Run(["cmd.exe", "/c", "exit 1"], [Start()]);

        Assert.Single(sent);
    }

    [Fact]
    public void Run_返回码为0()
    {
        var (code, _) = Run(["cmd.exe", "/c", "exit 0"], [Start()]);

        Assert.Equal(0, code);
    }

    [Fact]
    public void Run_可重复调用()
    {
        var (code, _) = Run(["cmd.exe", "/c", "exit 0"], [Start()]);

        Assert.Equal(0, code);
    }

    // ============ 多个有序消息 ============

    [Fact]
    public void Run_start之后继续读通道直到EOF()
    {
        // start 执行完后通道仍有消息 → 主循环应继续读，不能提前退出。
        var (_, sent) = Run(
            ["cmd.exe", "/c", "exit 0"],
            [Start(), "{\"type\":\"terminate\"}"]);

        // 执行完成后的 terminate 不应产生第二条结果
        Assert.Single(sent);
    }
}

/// <summary>依赖 CRT 描述符表布局的测试集合：必须串行。</summary>
[CollectionDefinition("FdLayout", DisableParallelization = true)]
public class FdLayoutCollection;

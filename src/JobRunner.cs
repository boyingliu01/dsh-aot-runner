// 核心进程管理 —— 严格对齐 RUNNER-SPEC.md
using System.Collections.Concurrent;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;   // 仅 JsonDocument（PeekType/ParseStart 内部用），禁用 JsonSerializer

namespace DshAotRunner;

/// <summary>
/// Windows Job runner：把一个目标命令放进 Job Object，使其可整树回收。
/// 语义基线见 RUNNER-SPEC.md。
/// </summary>
internal sealed partial class JobRunner : IDisposable, ISpawnHost
{
    /// <summary>
    /// 等待超时上界（毫秒）。
    /// </summary>
    /// <remarks>
    /// 名字沿用历史，语义已变：它不再是一个「定时睡这么久」的轮询间隔，
    /// 而是 <see cref="WaitForProgress"/> 里「有可等句柄时」的等待超时，
    /// 以及「没有可等句柄时」的兜底睡眠时长。
    /// <para>
    /// 为什么必须保留 10ms：<see cref="Poll"/> 除了等 target 退出，还要周期性检查
    /// job 是否已空（整棵进程树回收完）。后者没有可等待句柄，只能靠它驱动。
    /// target 退出这条主路径已经由 <c>WaitForSingleObject</c> 事件化了，
    /// 不再受这个数字影响。
    /// </para>
    /// <para>
    /// 10 这个值来自 node 版 <c>setInterval(..., 10)</c>，属于协议对齐的遗留，
    /// 不要因为「看起来还能调小」而随手改 —— 它现在只影响 job 收尾的复查频率。
    /// </para>
    /// </remarks>
    private const int PollIntervalMs = 10;

    private readonly string[] _argv;
    private readonly IMessageChannel _channel;
    private readonly object _gate = new();
    private bool _disposed;

    // 状态字段 —— 对齐 RUNNER-SPEC §4.1
    private bool _startSeen;
    private bool _terminateRequested;
    private bool _resultDelivered;
    private bool _finished;

    private SafeJobHandle? _job;
    private SafeKernelHandle? _process;
    private SafeKernelHandle? _thread;
    /// <summary>target 的进程 id；进程 ID 在 Win32 里是无符号 DWORD。</summary>
    private uint _targetPid;

    public JobRunner(string[] argv, IMessageChannel channel)
    {
        _argv = argv;
        _channel = channel;
    }

    /// <summary>
    /// target 启动器。延迟到首次使用时创建。
    /// </summary>
    /// <remarks>
    /// 不在构造函数里 new：TargetSpawner 需要持有对 JobRunner 的引用（作为 ISpawnHost），
    /// 在构造函数中把 this 交出去等于让外部对象看到一个只初始化了一半的 runner。
    /// 延迟创建既避开这一点，也避免为「一个从不 start 的 runner」付构造成本
    /// （错误路径上的 runner 只需要投递错误，根本不会启动 target）。
    /// </remarks>
    private TargetSpawner? _spawner;

    /// <summary>主循环：读 Node IPC 通道的消息，直到 finished。</summary>
    /// <summary>要执行的程序路径（argv[0]）；argv 为空时是 null。</summary>
    internal string? ProgramName => _argv.Length > 0 ? _argv[0] : null;

    IReadOnlyList<string> ISpawnHost.Argv => _argv;
    string? ISpawnHost.ProgramName => ProgramName;
    Func<int, IntPtr>? ISpawnHost.StdioResolveHook => StdioResolveHook;
    Func<int, IntPtr>? ISpawnHost.ResolveControlHook => ResolveControlHook;
    void ISpawnHost.EmitSpawnEnoent(string program) => EmitSpawnEnoent(program);
    void ISpawnHost.EmitCreateProcessError(int win32Code, string program) =>
        EmitCreateProcessError(win32Code, program);
    void ISpawnHost.PublishControlMissingError() => PublishControlMissingError();
    void ISpawnHost.Finish() => Finish();

    /// <summary>emit 「control 通道未继承」的 EPROTOCOL 错误（host 侧契约违约）。</summary>
    internal void PublishControlMissingError() =>
        PublishResult(RunnerErrors.ControlMissing());

    /// control 句柄解析钩子；默认读 fd 7。
    /// </summary>
    /// <remarks>
    /// host 声明了 control 却没传 fd 7 属于契约违约，必须投递 EPROTOCOL。
    /// 但测试进程里 fd 7 总是被 FdLayoutHost 占着，无法自然产生「无效」状态；
    /// 用钩子返回 IntPtr.Zero 即可稳定验证这条分支。
    /// </remarks>
    internal static Func<int, IntPtr>? ResolveControlHook { get; set; }

    /// <summary>
    /// fd → 句柄的解析钩子；默认就是 CRT 的 _get_osfhandle。
    /// </summary>
    /// <remarks>
    /// fd 4/5/6 缺失时的降级告警（NUL 陷阱，Issue #11）很难在测试进程里自然触发：
    /// FdLayoutHost 总会把它们占住。用钩子返回无效句柄即可验证
    /// 这条路径确实会走「回退到本进程标准句柄 + 打 WARNING」，而不是静默丢输出。
    /// </remarks>
    internal static Func<int, IntPtr>? StdioResolveHook { get; set; }

    public int Run()
    {
        // 主循环必须能被 Finish() 唤醒。
        // 阻塞在同步 I/O 上时，没有任何办法从外部打断另一个线程的读，
        // 而真实 host 在 terminate 后并不会立即关闭通道 —— 结果就是协议结果已发出、
        // 进程却永远挂着（Issue #3 实测：每次 terminate 泄漏一个 runner）。
        //
        // 做法：读线程 + 有界等待。主线程只做「取一条消息 / 检查是否该退出」，
        // 等待设了超时，于是 _finished 一旦置位就能在 ≤50ms 内退出。
        //
        // 这套结构对 IPC 同样必要：Windows 管道上的 ReadFile 会真阻塞，
        // 且 disconnect 后返回的是 ERROR_BROKEN_PIPE 而非 0 字节。
        var inbox = new BlockingCollection<string?>(new ConcurrentQueue<string?>());
        var readerThread = IpcReader.Start(_channel, inbox);

        try
        {
            PumpMessages(inbox);
        }
        finally
        {
            ReleaseOwnedJob();
            // 读线程是后台线程，进程退出不会被它拖住；这里不 Join，
            // 因为它可能正阻塞在一个永不到来的 ReadFile 上。
            _ = readerThread;
        }
        return 0;
    }


    /// <summary>
    /// 主循环：从 <paramref name="inbox"/> 取消息并处理，直到 finished。
    /// </summary>
    /// <remarks>
    /// 等待设了 50ms 超时，于是 <c>_finished</c> 一旦置位就能及时退出 ——
    /// 这是 Issue #3（terminate 后 runner 泄漏）的修复要点，不要改成无限等待。
    /// </remarks>
    private void PumpMessages(BlockingCollection<string?> inbox)
    {
        while (!_finished)
        {
            if (!inbox.TryTake(out var message, 50))
                continue;                            // 超时 → 回头看 _finished

            if (message is null)
            {
                HandleEof();
                return;
            }

            if (message.Length == 0) continue;
            Trace.Timed($"got message: {message}");
            HandleMessage(message);
        }
    }

    /// <summary>
    /// 通道 EOF 时的收尾：已 Finish 过属正常结束，否则是 host 中途断开。
    /// </summary>
    /// <remarks>
    /// Finish 之后到来的 EOF 是预期内收尾（host 收完结果才断开），
    /// 此时不能再走断开路径 —— 那会重复投递一次错误结果。
    ///
    /// 单独成方法（而非内联进 <see cref="PumpMessages"/>）有两个原因：
    /// 一是「判 EOF → 判是否已结束 → 断开清理」三步叠加会把主循环推到 CCN 6；
    /// 二是它和 <see cref="Finish"/> 语义不同 —— 前者特指「host 先走了」，
    /// 后者是 runner 自己收尾。混在一起读代码的人会以为两者可以互换。
    /// </remarks>
    private void HandleEof()
    {
        // RUNNER-SPEC §4.2：父进程断开 → releaseOwnedJob + finish(127)
        if (!_finished) Finish(127);
    }

    private void HandleMessage(string line)
    {
        if (!MessageType.TryPeek(line, out var type, out var typeError))
        {
            PublishResult(RunnerErrors.ProtocolViolation(typeError));
            return;
        }

        switch (type)
        {
            case "terminate":
                RequestTermination();
                return;
            case "start":
                DispatchStart(line);
                return;
            default:
                PublishResult(RunnerErrors.ProtocolViolation($"unknown message type: {type}"));
                return;
        }
    }

    /// <summary>重复 start 校验 + 解析 + 交给 <see cref="HandleStart"/>。</summary>
    private void DispatchStart(string line)
    {
        if (_startSeen)
        {
            // RUNNER-SPEC §4.2：重复 start 报错
            PublishResult(RunnerErrors.ProtocolViolation("received more than one Windows start request"));
            return;
        }

        _startSeen = true;
        HandleStart(StartRequestParser.Parse(line));
    }

    // ---------------- start ----------------

    /// <summary>测试入口：直接走 HandleStart，跳过消息分派与 JSON 解析。</summary>
    /// <remarks>
    /// HandleStart 的错误分支（EJOBCREATE / ENOENT / EPROTOCOL-control）
    /// 都需要 Win32 层失败才能到达，正常环境里几乎不可复现。
    /// 配合 <see cref="CreateJob"/> 与 <see cref="SpawnTargetHook"/> 注入，
    /// 就能在没有真实故障的情况下验证这些分支投递的错误是否正确。
    /// </remarks>
    internal void HandleStartForTest(StartRequest req) => HandleStart(req);

    private void HandleStart(StartRequest req)
    {
        if (_terminateRequested)
        {
            // terminate 已到达但尚未有 job：按规范视为已终止，仍走 Error 形状
            PublishResult(new ErrorResult
            {
                Error = new SerializedError { Name = "Error", Message = "runner has been terminated" },
            });
            return;
        }

        var job = TryCreateOwnedJob();
        if (job is null) return;                      // 错误已投递

        try
        {
            if (SpawnTargetHook is not null)
            {
                SpawnTargetHook(req, job);
            }
            else
            {
                ApplySpawn(req, job);
            }
        }
        catch (Win32Exception ex)
        {
            // CreateProcessW 失败 → 错误带 path（RUNNER-SPEC §6.2）
            PublishResult(RunnerErrors.SpawnFailed(ex, ProgramName));
            return;
        }

        PollerLauncher.Start(PollLoop);
    }

    /// <summary>
    /// 走真实的 TargetSpawner 启动 target，并把产出的句柄接收到 runner 上。
    /// </summary>
    /// <remarks>
    /// 延迟建 spawner 而不是在构造函数里 new：TargetSpawner 需要把 JobRunner
    /// 当作 <see cref="ISpawnHost"/> 持有，在构造函数中交出 this 会让外部对象
    /// 看到一个只初始化了一半的 runner。同时「从不 start 的 runner」也不必付构造成本。
    /// </remarks>
    private void ApplySpawn(StartRequest req, SafeJobHandle job)
    {
        (_spawner ??= new TargetSpawner(this)).Spawn(req, job, out var spawned);
        if (spawned is null) return;          // 错误已投递，runner 已 Finish

        _process = spawned.Process;
        _thread = spawned.Thread;
        _targetPid = spawned.Pid;
    }

    /// <summary>
    /// 建 Job Object 并打开 kill-on-close；失败时投递错误并返回 null。
    /// </summary>
    /// <remarks>
    /// kill-on-close 是本 runner 的核心契约（RUNNER-SPEC §5.3 步骤 1-2）：
    /// 少了它，runner 崩溃时 target 的整棵进程树会留在系统里。
    /// </remarks>
    private SafeJobHandle? TryCreateOwnedJob()
    {
        SafeJobHandle job;
        try
        {
            job = CreateJob();
            job.EnableKillOnClose();
        }
        catch (Win32Exception ex)
        {
            PublishResult(RunnerErrors.JobCreateFailed(ex));
            return null;
        }
        _job = job;
        return job;
    }



    /// <summary>
    /// 放行之前 CREATE_SUSPENDED 挂起的 target 线程。
    ///
    /// ResumeThread 失败时返回 0xFFFFFFFF，必须检查 —— 不检查的话线程
    /// 永远挂起，target 静默不执行，而我们却在等一个永远不会出现的退出码，
    /// 外部表现为「调用卡住」。
    /// </summary>
    /// <summary>
    /// ResumeThread 的判定逻辑，接缝版本。
    /// </summary>
    /// <remarks>
    /// 单独拆出来是因为「ResumeThread 失败」在实际环境里几乎无法复现
    /// （需要线程句柄被外部破坏），但这段逻辑一旦写错后果很严重：
    /// 线程永远挂起 → target 静默不执行 → 调用方卡在一个永不出现的退出码上。
    /// 通过传入 <paramref name="resumeThread"/> 与 <paramref name="lastError"/>
    /// 就能把两条失败支路都测到，而不必真的去制造 Win32 失败。
    /// </remarks>
    internal bool ResumeTargetThread(
        IntPtr hThread,
        Func<IntPtr, uint>? resumeThread = null,
        Func<int>? lastError = null)
    {
        if (ProcessLauncher.ResumeSuspendedThread(hThread, out var resumeError, resumeThread, lastError))
            return true;

        EmitCreateProcessError(resumeError, _argv[0]);
        Finish();
        return false;
    }

    /// <summary>
    /// 进入终态：置 <c>_finished</c> 并释放全部内核句柄。幂等。
    /// </summary>
    /// <param name="exitCode">
    /// 需要设置的进程退出码；省略表示不改（正常收尾）。
    /// </param>
    /// <remarks>
    /// Finish 与 OnDisconnect 原本是两份逐字相同的骨架，只差一个 ExitCode：
    /// 「加锁 → 判重 → 置 finished → 释放资源」。合并成一处之后，
    /// 「一次终态只清理一次」这个不变量只有一条实现，不会有第二处走样。
    ///
    /// 置位 _finished 之后主循环在 TryTake(50ms) 上自行退出 ——
    /// 不要改成主动断流，见 Run() 的说明。
    /// </remarks>
    private void Finish(int? exitCode = null)
    {
        lock (_gate)
        {
            if (_finished) return;
            _finished = true;
        }
        ReleaseOwnedJob();
        if (exitCode.HasValue) Environment.ExitCode = exitCode.Value;
    }


    /// <summary>
    /// 在 runner 的锁内释放全部内核句柄。
    /// </summary>
    /// <remarks>
    /// lock 留在这里而不是搬进 <see cref="ResourceReleaser"/>：
    /// 锁保护的是 JobRunner 的字段状态，释放器只是被它调用的纯操作。
    /// 让释放器去拿别人的锁会把并发边界藏起来，反而更容易出错。
    /// </remarks>
    private void ReleaseOwnedJob()
    {
        lock (_gate)
        {
            ResourceReleaser.ReleaseAll(ref _job, ref _process, ref _thread);
        }
    }

    /// <summary>
    /// 释放 runner 拥有的全部内核句柄（Job / process / thread）。
    /// 正常路径由 <see cref="Run"/> 在结束时调用；<see cref="Dispose"/> 只是把
    /// 同一套清理挂到语言级释放约定上，保证任何退出路径都不会漏句柄。
    /// </summary>
    public void Dispose()
    {
        lock (_gate)
        {
            if (_disposed) return;
            _disposed = true;
        }
        ReleaseOwnedJob();
    }
}

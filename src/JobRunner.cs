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
        var readerThread = StartReaderThread(inbox);

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
    /// 启动后台读线程，把通道消息（含 EOF 的 null）投进 <paramref name="inbox"/>。
    /// </summary>
    /// <remarks>
    /// 单独抽出的理由：线程体里既有正常读取循环，又有异常转换（读失败等同 EOF），
    /// 这两件事和主循环的「等待-分发」逻辑互不相干，混在一个方法里
    /// 会让 <see cref="Run"/> 同时负责线程管理与协议推进。
    /// </remarks>
    private Thread StartReaderThread(BlockingCollection<string?> inbox)
    {
        var readerThread = new Thread(() =>
        {
            try
            {
                while (true)
                {
                    var message = _channel.ReadMessage();
                    inbox.Add(message);
                    if (message is null) break;      // EOF 之后不再产出
                }
            }
            catch (Exception ex)
            {
                // 读失败（帧非法或 I/O 错误）等同于通道结束，但要留下痕迹
                Trace.Write($"ipc reader stopped: {ex.GetType().Name}: {ex.Message}");
                inbox.Add(null);
            }
        })
        { IsBackground = true, Name = "ipc-reader" };
        readerThread.Start();
        return readerThread;
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
    /// 通道 EOF 时的收尾：已 Finish 过属正常结束，否则是 host 断开。
    /// </summary>
    private void HandleEof()
    {
        // Finish 之后到来的 EOF 是预期内收尾（host 收完结果才断开），
        // 此时不能再走 OnDisconnect —— 那会重复投递一次错误结果。
        if (!_finished) OnDisconnect();
    }

    /// <summary>取消息的 type 字段；非法或缺失时投递协议错误并返回 null。</summary>
    /// <remarks>
    /// 从 <see cref="HandleMessage"/> 抽出来，让后者只剩「按 type 分发」一个意图。
    ///
    /// 解析方式的选择很重要：只用 JsonDocument（启动开销 ~33ms），
    /// 绝不能用 JsonSerializer.Deserialize —— AOT 下会多付 ~1.2s 启动代价。
    /// </remarks>
    private string? PeekMessageType(string line)
    {
        string? type;
        string? jsonError;
        using (Trace.Measure("json-peek-type"))
        {
            type = ProtocolJson.PeekType(line, out jsonError);
        }
        if (jsonError is not null)
        {
            FailProtocol($"invalid JSON: {jsonError}");
            return null;
        }
        if (type is null) FailProtocol("message missing 'type'");
        return type;
    }

    private void HandleMessage(string line)
    {
        var type = PeekMessageType(line);
        if (type is null) return;      // 已投递协议错误，调用方无需再处理

        switch (type)
        {
            case "terminate":
                RequestTermination();
                return;
            case "start":
                HandleStartMessage(line);
                return;
            default:
                FailProtocol($"unknown message type: {type}");
                return;
        }
    }

    /// <summary>
    /// 处理 start 消息：校验重复、解析请求、交给 <see cref="HandleStart"/>。
    /// </summary>
    /// <remarks>
    /// 从 <see cref="HandleMessage"/> 分出来，让后者只做「type → 分派」的扁平判断，
    /// 而 start 自己的三条前置校验（重复 start / 解析失败 / 正常）独立成段。
    /// </remarks>
    private void HandleStartMessage(string line)
    {
        if (_startSeen)
        {
            // RUNNER-SPEC §4.2：重复 start 报错
            FailProtocol("received more than one Windows start request");
            return;
        }

        _startSeen = true;
        StartRequest? req;
        string? parseError;
        using (Trace.Measure("json-parse-start"))
        {
            req = ProtocolJson.ParseStart(line, out parseError);
        }
        // 这里不需要再判 req is null：
        // HandleMessage 已经用 PeekType 校验过「JSON 合法 + root 是对象 + type 是字符串」，
        // 而 ParseStart 只在「JSON 非法」或「root 非对象」时返回 null —— 两者都被前置拦下了。
        // 保留一个永远进不去的分支比删掉更糟：它会让读者以为还有一条错误路径要维护。
        HandleStart(req!);
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
            // terminate 已到达但尚未有 job：按规范视为已终止
            PublishTerminatedBeforeStart();
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
                SpawnViaSpawner(req, job);
            }
        }
        catch (Win32Exception ex)
        {
            // CreateProcessW 失败 → 错误带 path（RUNNER-SPEC §6.2）
            PublishResult(RunnerErrors.SpawnFailed(ex, ProgramName));
            return;
        }

        StartPoller();
    }

    /// <summary>
    /// terminate 先于 start 到达时的终态结果。
    /// </summary>
    /// <remarks>
    /// 规范把这种情况定义为「已终止」而不是「错误」：host 侧的 terminate 是
    /// 正常操作，只是恰好早了一步。这里仍然走 Error 形状，因为 host 侧协议只认
    /// 这一种退出通知 —— 换形状会让 node 与 AOT 两条路径给出不同的字节。
    /// </remarks>
    private void PublishTerminatedBeforeStart() =>
        PublishResult(new ErrorResult
        {
            Error = new SerializedError { Name = "Error", Message = "runner has been terminated" },
        });

    /// <summary>
    /// 走真实的 TargetSpawner 启动 target，并把产出的句柄接收到 runner 上。
    /// </summary>
    private void SpawnViaSpawner(StartRequest req, SafeJobHandle job)
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
    /// 起轮询线程（RUNNER-SPEC §7）。后台线程，进程退出不会等它。
    /// </summary>
    private void StartPoller() =>
        new Thread(PollLoop) { IsBackground = true, Name = "poll" }.Start();


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

    private void OnDisconnect()
    {
        // RUNNER-SPEC §4.2：父进程断开 → releaseOwnedJob + finish(127)
        lock (_gate)
        {
            if (_finished) return;
            _finished = true;
        }
        ReleaseOwnedJob();
        Environment.ExitCode = 127;
    }


    private void FailProtocol(string message)
    {
        PublishResult(new ErrorResult
        {
            Error = new SerializedError { Name = "Error", Message = message, Code = "EPROTOCOL" }
        });
    }

    private void Finish()
    {
        lock (_gate)
        {
            if (_finished) return;
            _finished = true;
        }
        ReleaseOwnedJob();

        // 主循环在 lines.TryTake(50ms) 上等读线程，_finished 置位后 ≤50ms 内自行退出。
        // 不再需要在这里主动断流 —— 见 Run() 中的说明。
    }

    /// <summary>
    /// RUNNER-SPEC §8 / §9 清理顺序：TerminateJob → CloseJob → CloseProcess
    /// 顺序不可调换（架构专家指出：Job 先关会导致子进程逃逸）
    /// </summary>
    /// <remarks>
    /// 三个句柄的释放形状完全一致（终止/关闭 + 置 null + 吞掉异常），
    /// 所以收敛成 <see cref="ReleaseHandle{T}"/> 一处实现。
    /// 这样改的是「每个句柄只声明自己的释放动作」，而不是重复三遍
    /// 同样的 try/catch 骨架 —— 少掉的重复也正好是原先的复杂度来源。
    /// </remarks>
    private void ReleaseOwnedJob()
    {
        lock (_gate)
        {
            _job = ReleaseHandle(_job, static j => j.Terminate(1));
            _process = ReleaseHandle(_process, static _ => { });
            _thread = ReleaseHandle(_thread, static _ => { });
        }
    }

    /// <summary>
    /// 释放一个可选句柄：先执行 <paramref name="beforeDispose"/>，再 Dispose，
    /// 任何异常都吞掉（清理路径不该因为单个句柄失败而中断），最后返回 null。
    /// </summary>
    /// <remarks>
    /// 泛型 + 约束到 IDisposable：Job/Process/Thread 三种句柄走同一条清理路径，
    /// 调用方只描述「额外要先做什么」，不必再写一遍 try/catch/置 null。
    /// </remarks>
    private static T? ReleaseHandle<T>(T? handle, Action<T> beforeDispose) where T : class, IDisposable
    {
        if (handle is null) return null;
        try { beforeDispose(handle); } catch { }
        try { handle.Dispose(); } catch { }
        return null;
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

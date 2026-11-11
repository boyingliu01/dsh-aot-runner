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
internal sealed class JobRunner : IDisposable
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
    private int _targetPid;

    public JobRunner(string[] argv, IMessageChannel channel)
    {
        _argv = argv;
        _channel = channel;
    }

    /// <summary>主循环：读 Node IPC 通道的消息，直到 finished。</summary>
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
            PublishResult(new ErrorResult { Error = new SerializedError { Name = "Error", Message = "runner has been terminated" } });
            return;
        }

        SafeJobHandle job;
        try
        {
            job = CreateJob();
            job.EnableKillOnClose();                  // RUNNER-SPEC §5.3 步骤 1-2
        }
        catch (Win32Exception ex)
        {
            PublishResult(MakeJobCreateError(ex));
            return;
        }
        _job = job;

        try
        {
            (SpawnTargetHook ?? SpawnTarget)(req, job);
        }
        catch (Win32Exception ex)
        {
            // CreateProcessW 失败 → 错误带 path（RUNNER-SPEC §6.2）
            PublishResult(MakeSpawnError(ex));
            return;
        }

        // 起轮询（RUNNER-SPEC §7：10ms）
        var poller = new Thread(PollLoop) { IsBackground = true, Name = "poll" };
        poller.Start();
    }

    private void SpawnTarget(StartRequest req, SafeJobHandle job)
    {
        // ---- 1. 构建命令行 ----
        // CreateProcessW 的第一个参数为 NULL 时，用命令行首 token 查找可执行文件。
        // 若该 token 不含路径分隔符且不在 PATH 中，会返回 ERROR_FILE_NOT_FOUND(2)。
        // 这里先用 .NET 的查找逻辑解析成绝对路径，避免依赖 CreateProcessW 的搜索策略。
        string cmdline;
        using (Trace.Measure("build-cmdline"))
        {
            cmdline = BuildCommandLine(_argv);
        }
        string? appName;
        using (Trace.Measure("resolve-exe"))
        {
            appName = ResolveExecutable(_argv[0], req.Cwd, req.Env);
        }
        if (appName is null)
        {
            // 与 node 一致：候选全部不存在 → ENOENT，文本对齐 libuv/Node 的 spawn 错误
            EmitSpawnEnoent(_argv[0]);
            Finish();
            return;
        }

        // ---- 2. 构建环境块（CREATE_UNICODE_ENVIRONMENT → UTF-16）----
        // 注意：DSH_SUBPROCESS_CONTROL=pipe 由 **host** 注入（runner-launch 的
        // targetEnvironment / controlEnvironment），随 start 请求的 env 一起送达，
        // runner 只负责原样透传。runner 自己再注入一次会造成与 node 的分歧 ——
        // 那时 target 会看到一个 host 并没有设置的标记。
        byte[] envBlock;
        using (Trace.Measure("env-block"))
        {
            envBlock = BuildEnvironmentBlock(req.Env);
        }

        // ---- 3. 把 target 的 stdio 接到 host 传入的通道 ----
        StdioHandles stdio;
        using (Trace.Measure("resolve-stdio"))
        {
            stdio = ResolveStdioHandles();
        }

        // ---- 3a. control channel（Issue #2）----
        var controlRequested = req.Control == "pipe";
        var hControl = ResolveControlHandle(controlRequested);
        if (controlRequested && !IsValid(hControl))
        {
            // host 声明了 control 却没传可用的 fd 7：这是 host 侧契约违约，
            // 不能静默降级成「无 control」，否则 target 会永远等一条不存在的通道。
            PublishControlMissingError();
            return;
        }

        // ---- 3b. 精确控制继承：只放行 target 需要的句柄 ----
        var inheritToggled = EnableInheritanceFor(CollectTargetHandles(stdio, controlRequested, hControl));
        LaunchWithDescriptorTable(req, job, appName, cmdline, envBlock, stdio, hControl, inheritToggled);

        // 说明：早期版本曾在这里用 DSH_AOT_SUPPRESS=1 开关去清 fd 0/1/2 的继承标志。
        // 那是实验残留 —— runner 是 console 程序，fd 0/1/2 由 host 映射到 target 的
        // stdout/stderr，动它们会连带关掉输出通道，而抑制继承本来就不依赖这一步。
        // 真正保证 target 拿不到协议句柄的是：fd 4/5/6 之外不额外打开可继承句柄，
        // 且 CreateProcessW 返回后立刻在 finally 里恢复所有被改过的标志。

    }

    /// <summary>
    /// 解析 control channel 句柄；未请求 control 时返回无效值。
    /// </summary>
    private static IntPtr ResolveControlHandle(bool controlRequested) =>
        controlRequested
            ? (ResolveControlHook ?? DefaultResolveControl)(CrtDescriptorTable.ControlFileDescriptor)
            : IntPtr.Zero;

    private static IntPtr DefaultResolveControl(int fd) => Native.CrtGetOsFHandle(fd);

    /// <summary>
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

    /// <summary>收集需要放行继承的句柄集合（control 可选）。</summary>
    private static IntPtr[] CollectTargetHandles(StdioHandles stdio, bool controlRequested, IntPtr hControl) =>
        controlRequested
            ? new[] { stdio.In, stdio.Out, stdio.Err, hControl }
            : new[] { stdio.In, stdio.Out, stdio.Err };

    /// <summary>
    /// 编码 CRT 描述符表并完成进程启动，finally 里释放非托管内存。
    /// </summary>
    /// <remarks>
    /// 单独成方法是为了让 <see cref="SpawnTarget"/> 只表达「准备阶段」，
    /// 而「分配-启动-释放」这段必须成对出现的生命周期收在一个方法里，
    /// 减少有人在中间插入 early return 而漏掉 FreeHGlobal 的机会。
    /// </remarks>
    private void LaunchWithDescriptorTable(
        StartRequest req, SafeJobHandle job, string appName, string cmdline,
        byte[] envBlock, StdioHandles stdio, IntPtr hControl,
        List<(IntPtr Handle, bool WasInheritable)> inheritToggled)
    {
        // CRT 描述符表：只有 control 请求时才需要（其余情况走默认标准句柄表）
        var descriptorTable = CrtDescriptorTable.Encode(stdio.In, stdio.Out, stdio.Err, hControl);
        var descriptorPtr = IntPtr.Zero;
        if (descriptorTable is not null)
        {
            descriptorPtr = Marshal.AllocHGlobal(descriptorTable.Length);
            Marshal.Copy(descriptorTable, 0, descriptorPtr, descriptorTable.Length);
        }

        var si = BuildStartupInfo(stdio, descriptorTable, descriptorPtr);
        try
        {
            LaunchProcess(req, job, appName, cmdline, envBlock, si, inheritToggled);
        }
        finally
        {
            if (descriptorPtr != IntPtr.Zero) Marshal.FreeHGlobal(descriptorPtr);
        }
    }

    /// <summary>target 的三个 stdio 句柄。</summary>
    private readonly record struct StdioHandles(IntPtr In, IntPtr Out, IntPtr Err);

    /// <summary>
    /// 解析 target 的 stdin/stdout/stderr 句柄。
    ///
    /// host 用 Node 的 spawn stdio 数组按「文件描述符」编号传递通道：
    ///   stdio[4] → fd 4 (target stdin)
    ///   stdio[5] → fd 5 (target stdout)
    ///   stdio[6] → fd 6 (target stderr)
    ///
    /// Windows 上必须用 CRT 的 _get_osfhandle 取句柄 —— GetStdHandle(4/5/6)
    /// 只会返回 INVALID_HANDLE_VALUE（实测 0xFFFFFFFF），因为它查的是标准
    /// 句柄表的固定索引（-10/-11/-12），不是 CRT 的 fd 表。
    /// </summary>
    private static StdioHandles ResolveStdioHandles()
    {
        var resolve = StdioResolveHook ?? Native.CrtGetOsFHandle;
        var hIn = resolve(4);
        var hOut = resolve(5);
        var hErr = resolve(6);

        // 各句柄独立判断：位号不可用时退回本进程对应标准句柄
        var hStdIn = IsValid(hIn) ? hIn : Native.GetStdHandle(Native.STD_INPUT_HANDLE);
        var hStdOut = IsValid(hOut) ? hOut : Native.GetStdHandle(Native.STD_OUTPUT_HANDLE);
        var hStdErr = IsValid(hErr) ? hErr : Native.GetStdHandle(Native.STD_ERROR_HANDLE);

        // NUL 陷阱（Issue #11 实测发现）：
        // 真实 host 布局下本进程的 fd 0/1/2 是 \\?\NUL 字符设备 —— 句柄有效，
        // 写入永远"成功"但内容丢弃。如果把它们当默认值传给 target，
        // target 的输出会**静默消失**，调用方拿到空输出却没有任何报错。
        //
        // 因此：fd 4/5/6 缺失时只回退到「本进程的标准句柄」，但要记录；
        // 一旦目标句柄是 NUL（FILE_TYPE_CHAR 且不是控制台），显式告警。
        Trace.Write($"stdio: fd4=0x{hIn.ToInt64():X} fd5=0x{hOut.ToInt64():X} fd6=0x{hErr.ToInt64():X}"
                    + $" type4={Native.GetFileType(hIn)} type5={Native.GetFileType(hOut)} type6={Native.GetFileType(hErr)}"
                    + $" -> in=0x{hStdIn.ToInt64():X} out=0x{hStdOut.ToInt64():X} err=0x{hStdErr.ToInt64():X}");

        if (!IsValid(hIn) || !IsValid(hOut) || !IsValid(hErr))
        {
            Trace.Write("stdio: WARNING fd4/5/6 缺失，target 将继承本进程标准句柄（输出可能进入 NUL）");
        }

        return new StdioHandles(hStdIn, hStdOut, hStdErr);
    }

    /// <summary>emit 「control 通道未继承」的 EPROTOCOL 错误（host 侧契约违约）。</summary>
    internal void PublishControlMissingError() =>
        PublishResult(MakeControlMissingError());

    /// <summary>「control 通道未继承」的错误结果（host 侧契约违约）。</summary>
    /// <remarks>
    /// 这条错误必须存在且文案明确：host 声明了 control 却没传 fd 7 时，
    /// 若静默降级成「无 control」，target 会永远等一条不存在的通道 ——
    /// 表现为随机挂起，比明确报错难查得多。
    /// </remarks>
    internal static ErrorResult MakeControlMissingError() => new()
    {
        Error = new SerializedError
        {
            Name = "Error",
            Message = "subprocess control channel was not inherited",
            Code = "EPROTOCOL",
        },
    };

    /// <summary>Job Object 创建失败的错误结果。</summary>
    internal static ErrorResult MakeJobCreateError(Win32Exception ex) => new()
    {
        Error = new SerializedError { Name = "Error", Message = ex.Message, Code = "EJOBCREATE" },
    };

    /// <summary>CreateProcessW 抛异常时的错误结果（带 path）。</summary>
    internal ErrorResult MakeSpawnError(Win32Exception ex) => new()
    {
        Error = new SerializedError
        {
            Name = "Error",
            Message = ex.Message,
            Code = "ENOENT",
            Syscall = "spawn",
            Path = _argv.Length > 0 ? _argv[0] : null,
        },
    };

    /// <summary>
    /// 精确控制继承：只放行 target 需要的句柄。
    ///
    /// CreateProcessW 的 bInheritHandles=true 会继承本进程所有「可继承」句柄。
    /// runner 自己从 host 继承来的协议管道（fd0/fd1/fd2）默认就是可继承的，
    /// 若不处理，target 会连 runner 的协议通道一起继承走。
    ///
    /// 这不只是洁癖问题：MSYS2/Cygwin 程序（git-bash）对句柄表极其敏感，
    /// 多拿到 inherited 句柄会在初始化时崩在
    ///   NtCreateDirectoryObject(\BaseNamedObjects\msys-2.0S5-...): 0xC0000022
    /// 实测 bash 因此 100% 启动失败（exit=-1073741502）。
    ///
    /// 做法：把 target 要用的句柄显式置为 HANDLE_FLAG_INHERIT，
    /// CreateProcessW 返回后在 finally 里原样恢复。
    /// </summary>
    /// <returns>被改动过的句柄及其原始状态，供调用方恢复。</returns>
    private static List<(IntPtr Handle, bool WasInheritable)> EnableInheritanceFor(IntPtr[] targetHandles)
    {
        var inheritToggled = new List<(IntPtr Handle, bool WasInheritable)>(targetHandles.Length);
        foreach (var h in targetHandles)
        {
            if (!IsValid(h)) continue;
            if (Native.GetHandleInformation(h, out var flags))
            {
                var wasInheritable = (flags & Native.HANDLE_FLAG_INHERIT) != 0;
                inheritToggled.Add((h, wasInheritable));
                if (!wasInheritable)
                    Native.SetHandleInformation(h, Native.HANDLE_FLAG_INHERIT, Native.HANDLE_FLAG_INHERIT);
            }
        }
        return inheritToggled;
    }

    /// <summary>
    /// 构造 STARTUPINFO，并在 control 请求时挂上 CRT 描述符表。
    ///
    /// control:"pipe" 时 host 在 stdio[7] 传一个管道，target 会用
    /// openInheritedControlChannel() 以 fd 7 打开它。必须做两件事，缺一不可：
    ///   1. 在 target 环境块里注入 DSH_SUBPROCESS_CONTROL=pipe
    ///      （target 靠这个标记才知道「我继承了控制通道」）
    ///   2. 通过 STARTUPINFO.lpReserved2 下发 CRT 描述符表，
    ///      把 fd 7 映射到该句柄（只置继承标志不够，见 CrtDescriptorTable 注释）
    /// </summary>
    private static Native.STARTUPINFO BuildStartupInfo(
        StdioHandles stdio, byte[]? descriptorTable, IntPtr descriptorPtr)
    {
        var si = new Native.STARTUPINFO
        {
            cb = Marshal.SizeOf<Native.STARTUPINFO>(),
            dwFlags = Native.STARTF_USESTDHANDLES | Native.STARTF_USESHOWWINDOW,
            wShowWindow = Native.SW_HIDE,
            hStdInput = stdio.In,
            hStdOutput = stdio.Out,
            hStdError = stdio.Err,
        };

        // control 请求：把 CRT 描述符表挂到 STARTUPINFO 上。
        // cbReserved2 是字节数，lpReserved2 指向那块内存；
        // CreateProcessW 会在子进程启动期据此重建 fd 表。
        if (descriptorPtr != IntPtr.Zero)
        {
            si.cbReserved2 = (short)descriptorTable!.Length;
            si.lpReserved2 = descriptorPtr;
        }

        return si;
    }

    /// <summary>
    /// 调用 CreateProcessW 并完成 Job 入队、线程放行、句柄继承恢复。
    ///
    /// RUNNER-SPEC §5.3 步骤 3~5。任何一步失败都会 emit 错误并 Finish()。
    /// </summary>
    private void LaunchProcess(
        StartRequest req,
        SafeJobHandle job,
        string appName,
        string cmdline,
        byte[] envBlock,
        Native.STARTUPINFO si,
        List<(IntPtr Handle, bool WasInheritable)> inheritToggled)
    {
        var envPtr = Marshal.AllocHGlobal(envBlock.Length);
        try
        {
            Marshal.Copy(envBlock, 0, envPtr, envBlock.Length);
            var flags = Native.CREATE_SUSPENDED | Native.CREATE_UNICODE_ENVIRONMENT;
            // CreateProcessW 的 lpCurrentDirectory 必须是 Windows 路径格式（反斜杠），
            // 传入 "C:/" 这类正斜杠路径会返回 ERROR_INVALID_PARAMETER(87)。
            var cwd = NormalizeWindowsPath(req.Cwd);

            // RUNNER-SPEC §5.3 步骤 3
            Trace.Timed($"about to CreateProcessW: {appName}");
            try
            {
                if (!CreateSuspendedProcess(appName, cmdline, envPtr, cwd, flags, si, out var pi))
                {
                    Finish();
                    return;
                }

                _process = new SafeKernelHandle(pi.hProcess);
                _thread = new SafeKernelHandle(pi.hThread);
                _targetPid = pi.dwProcessId;

                Trace.Timed($"CreateProcessW ok, pid={pi.dwProcessId}");
                // RUNNER-SPEC §5.3 步骤 4：先入 Job。
                // 无条件执行 —— 曾经有一个 DSH_AOT_NOJOB=1 实验开关用来诊断，
                // 但实测它会让 terminate 失效、target 进程树泄漏，属于生产路径上的
                // 定时炸弹，已移除。Job 隔离是本 runner 的核心契约，不可绕过。
                job.AssignProcess(pi.hProcess);
                Trace.Timed("AssignProcessToJobObject ok");

                // RUNNER-SPEC §5.3 步骤 5：再放行。
                if (!ResumeTargetThread(pi)) return;

                Trace.Timed("ResumeThread ok");
                // 注：DSH 的 runner.js 会在 spawn 后 closeSync(4/5/6/7) 关闭自己的副本。
                // AOT 版暂不照做 —— 现有 24 项 A/B 在不关的情况下已与 node 行为一致，
                // 贸然改动会影响已稳定的输出通道语义。见 Issue #2 的后续评估。
            }
            finally
            {
                // 恢复句柄继承标志：CreateProcessW 一返回就没用了，
                // 留着会污染 runner 后续创建的其他 target。
                foreach (var (h, wasInheritable) in inheritToggled)
                {
                    if (!wasInheritable)
                        Native.SetHandleInformation(h, Native.HANDLE_FLAG_INHERIT, 0);
                }
            }
        }
        finally
        {
            Marshal.FreeHGlobal(envPtr);
        }
    }

    /// <summary>CreateProcessW 封装；失败时按 node 的 errno 文本 emit 错误。</summary>
    private bool CreateSuspendedProcess(
        string appName, string cmdline, IntPtr envPtr, string? cwd,
        uint flags, Native.STARTUPINFO si, out Native.PROCESS_INFORMATION pi)
    {
        var ok = Native.CreateProcessW(appName, cmdline, IntPtr.Zero, IntPtr.Zero,
            bInheritHandles: true, dwCreationFlags: flags,
            lpEnvironment: envPtr, lpCurrentDirectory: cwd,
            ref si, out pi);
        if (ok) return true;

        // 对齐 node 的 asSpawnError：把 Win32 码翻成 Node errno 文本，
        // 而不是自创 "CreateProcessW failed for ..." 这类消息。
        EmitCreateProcessError(Marshal.GetLastWin32Error(), _argv[0]);
        return false;
    }

    /// <summary>
    /// 放行之前 CREATE_SUSPENDED 挂起的 target 线程。
    ///
    /// ResumeThread 失败时返回 0xFFFFFFFF，必须检查 —— 不检查的话线程
    /// 永远挂起，target 静默不执行，而我们却在等一个永远不会出现的退出码，
    /// 外部表现为「调用卡住」。
    /// </summary>
    private bool ResumeTargetThread(Native.PROCESS_INFORMATION pi) =>
        ResumeTargetThread(pi.hThread);

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
        var suspendCount = (resumeThread ?? Native.ResumeThread)(hThread);
        if (suspendCount != Native.RESUME_THREAD_FAILED) return true;

        var resumeError = (lastError ?? Marshal.GetLastWin32Error)();
        // ERROR_NOT_SUSPENDED 说明线程已经是运行态，不是失败
        if (resumeError == Native.ERROR_NOT_SUSPENDED) return true;

        EmitCreateProcessError(resumeError, _argv[0]);
        Finish();
        return false;
    }

    /// <summary>把路径规范化为 Windows 反斜杠格式；空值返回 null（表示继承当前目录）。</summary>
    /// <remarks>
    /// 三条独立规则依次应用：统一分隔符 → 去掉末尾多余反斜杠 → 裸盘符补根斜杠。
    /// 每条规则都写成单独一行并在注释里点明「为什么」，比串成一串条件判断更容易核对。
    /// </remarks>
    internal static string? NormalizeWindowsPath(string? path)
    {
        if (string.IsNullOrWhiteSpace(path)) return null;

        // 1) 统一分隔符：Windows API 与 node 侧都用反斜杠
        var normalized = path.Replace('/', '\\');

        // 2) 去掉末尾多余的反斜杠（但保留根路径如 "C:\"）
        if (normalized.Length > 3 && normalized.EndsWith('\\'))
            normalized = normalized.TrimEnd('\\');

        // 3) 裸盘符（"C:"）补成 "C:\"，否则它表示「盘符当前目录」而非根目录
        if (IsBareDrive(normalized)) normalized += '\\';

        return normalized;
    }

    /// <summary>是否是没有任何路径部分的裸盘符（形如 <c>C:</c>）。</summary>
    private static bool IsBareDrive(string path) => path.Length == 2 && path[1] == ':';

    private static bool IsValid(IntPtr h) => h != IntPtr.Zero && h != new IntPtr(-1);

    /// <summary>
    /// 把 argv[0] 解析成绝对路径，语义与 @deepseek-ai/dsh-subprocess-local 的
    /// <c>resolveWindowsExecutable</c> 逐项对齐（见 runner-launch-*.js）。
    ///
    /// 对齐要点（A/B 字节级一致性要求，任何偏离都会让 node 与 AOT 两条路径
    /// 对同一个 argv 得出不同结论）：
    ///   1. 候选扩展名只有 .com 和 .exe，**且 .com 优先** —— 不含 .bat/.cmd。
    ///      例：npm 只有 npm.cmd，因此 node 与 AOT 都必须解析失败（ENOENT），
    ///      而不能由 AOT 单方面补 .cmd 让它跑起来。
    ///   2. 自带扩展名（点号后至少 1 字符）时，只检查原样文件名一次。
    ///   3. 不含路径分隔符时，先搜 cwd（受 NODEFAULTCURRENTDIRECTORYINEXEPATH 控制），
    ///      再按 PATH 顺序搜。
    ///   4. 全部候选都不存在 → 返回 null，由调用方产出 ENOENT 错误，
    ///      而不是把裸名交给 CreateProcessW（那会产生不同的错误文本）。
    /// </summary>
    internal static string? ResolveExecutable(string program, string? cwd, Dictionary<string, string>? env)
    {
        if (string.IsNullOrEmpty(program)) return null;

        // windowsFileNameStart：定位文件名起始处（跳过盘符和目录部分）
        var nameStart = WindowsFileNameStart(program);
        var directory = program.Substring(0, nameStart);
        var name = program.Substring(nameStart);

        var candidates = BuildExecutableCandidates(name);
        var roots = BuildSearchRoots(nameStart != 0, directory, env);

        foreach (var root in roots)
        {
            var basePath = WindowsSearchPathJoin(root, name, cwd ?? "");
            var found = ProbeCandidates(basePath, candidates);
            if (found is not null) return found;
        }
        return null;
    }

    /// <summary>
    /// 候选名顺序：自带扩展名的原样名 → .com → .exe（与 libuv 一致）。
    /// </summary>
    internal static List<string> BuildExecutableCandidates(string name)
    {
        // 扩展名判定：点号存在且不是最后一个字符
        var dot = name.IndexOf('.');
        var hasExtension = dot >= 0 && dot < name.Length - 1;
        var separator = name.EndsWith('.') ? "" : ".";

        var candidates = new List<string>(3);
        if (hasExtension) candidates.Add(name);
        candidates.Add(name + separator + "com");
        candidates.Add(name + separator + "exe");
        return candidates;
    }

    /// <summary>
    /// 搜索根：带路径 → 只有该目录；不带路径 → cwd（可禁用）+ 各 PATH 目录。
    /// </summary>
    internal static List<string> BuildSearchRoots(bool hasPath, string directory, Dictionary<string, string>? env)
    {
        var roots = new List<string>(8);
        if (hasPath)
        {
            roots.Add(directory);
            return roots;
        }

        // 本进程环境决定是否搜索 cwd（与 node 的 currentEnv 视角一致）
        var noDefaultCwd = Environment.GetEnvironmentVariable("NODEFAULTCURRENTDIRECTORYINEXEPATH");
        if (noDefaultCwd is null) roots.Add("");

        roots.AddRange(SplitPath(GetEnvValue(env, "PATH")
            ?? Environment.GetEnvironmentVariable("PATH") ?? ""));
        return roots;
    }

    /// <summary>在某个基准路径下依次探测候选名，返回第一个存在的。</summary>
    internal static string? ProbeCandidates(string basePath, List<string> candidates)
    {
        foreach (var candidate in candidates)
        {
            var full = basePath.Length == 0 ? candidate : basePath + candidate;
            // executableCandidateExists：存在且不是目录
            //
            // 不需要 try/catch：实测 .NET 8 的 File.Exists 对非法字符、
            // 超长路径、无权限路径都只返回 false，不抛异常。
            // （.NET Framework 时代它会抛，所以老代码里常见这个兜底。）
            if (File.Exists(full)) return full;
        }
        return null;
    }

    /// <summary>定位文件名在整条路径中的起始索引（跳过 "C:\dir\" 这类前缀）。</summary>
    /// <remarks>
    /// 从尾部向前扫到第一个分隔符或盘符冒号即可 —— 用 LastIndexOfAny 表达同一意图，
    /// 比手写递减循环少一层「i 越界 / 提前 return」的状态。
    /// 盘符特例（"C:name" 这种无目录写法）单独一次判断，语义更直白。
    /// </remarks>
    internal static int WindowsFileNameStart(string command)
    {
        var sep = command.LastIndexOfAny(['\\', '/']);
        if (sep >= 0) return sep + 1;

        // 无分隔符但形如 "C:name"：文件名从盘符后开始
        // （"C:" 本身也返回 2，与原实现一致：此时 name 为空串）
        if (command.Length >= 2 && command[1] == ':') return 2;

        return 0;
    }

    /// <summary>把 PATH 拆成目录列表（分号分隔，去引号与空项）。</summary>
    internal static IEnumerable<string> SplitPath(string pathVar)
    {
        foreach (var raw in pathVar.Split(';', StringSplitOptions.RemoveEmptyEntries))
        {
            var trimmed = raw.Trim().Trim('"');
            if (trimmed.Length > 0) yield return trimmed;
        }
    }

    /// <summary>按大小写不敏感取环境变量值。</summary>
    internal static string? GetEnvValue(Dictionary<string, string>? env, string key)
    {
        if (env is null) return null;
        foreach (var kv in env)
        {
            if (string.Equals(kv.Key, key, StringComparison.OrdinalIgnoreCase)) return kv.Value;
        }
        return null;
    }

    /// <summary>把搜索根与文件名拼成基路径；根为空时用 cwd（对齐 windowsSearchPathJoin）。</summary>
    internal static string WindowsSearchPathJoin(string root, string name, string cwd)
    {
        if (root.Length == 0)
            return cwd.Length == 0 ? "" : cwd.TrimEnd('\\', '/') + "\\";
        return root.TrimEnd('\\', '/') + "\\";
    }

    internal static string BuildCommandLine(string[] argv)
    {
        var sb = new StringBuilder();
        for (var i = 0; i < argv.Length; i++)
        {
            if (i > 0) sb.Append(' ');
            AppendQuoted(sb, argv[i]);
        }
        return sb.ToString();
    }

    /// <summary>命令行里需要加引号的字符。静态复用，避免每次构串都分配数组。</summary>
    private static readonly char[] QuoteRequiredChars = { ' ', '\t', '"' };

    /// <summary>按 Windows 命令行解析规则加引号（CommandLineToArgvW 兼容）。</summary>
    internal static void AppendQuoted(StringBuilder sb, string arg)
    {
        if (arg.Length > 0 && arg.IndexOfAny(QuoteRequiredChars) < 0)
        {
            sb.Append(arg);
            return;
        }
        sb.Append('"');
        var backslashes = 0;
        foreach (var c in arg)
        {
            if (c == '\\') { backslashes++; continue; }
            if (c == '"')
            {
                sb.Append('\\', backslashes * 2 + 1);
                sb.Append('"');
            }
            else
            {
                sb.Append('\\', backslashes);
                sb.Append(c);
            }
            backslashes = 0;
        }
        sb.Append('\\', backslashes * 2);
        sb.Append('"');
    }

    internal static byte[] BuildEnvironmentBlock(Dictionary<string, string> env)
    {
        // CREATE_UNICODE_ENVIRONMENT 要求：
        //   每个 "KEY=VALUE" 以 \0 结尾，整块再以一个**额外的** \0 结尾（双 null 终止）。
        // 注意：不能用 StringBuilder + Encoding.Unicode.GetBytes —— 空 env 时
        // 实测只得到 2 字节，导致 CreateProcessW 返回 ERROR_INVALID_PARAMETER(87)。
        // 必须直接构造字节数组。
        var bytes = new List<byte>(256);

        void AppendWide(string s)
        {
            foreach (var ch in s)
            {
                bytes.Add((byte)(ch & 0xFF));
                bytes.Add((byte)(ch >> 8));
            }
        }

        foreach (var kv in env)
        {
            AppendWide(kv.Key);
            bytes.Add((byte)'=');
            bytes.Add(0);
            AppendWide(kv.Value);
            bytes.Add(0);
            bytes.Add(0);
            // 注意：每个变量的    是「宽字符终止符」，不是块终止符。
        }

        // 块终止符：额外再补一个宽  （双 NUL 收尾）。
        //
        // 空 env 时整个块就是这 2 字节 —— 但 CreateProcessW 会返回
        // ERROR_INVALID_PARAMETER(87)。实测确认：
        //   2 字节 → err=87，4 字节 → 成功。
        // 所以空 env 必须补两次宽  （4 字节）。
        //
        // 这个分支此前产出 2 字节，意味着 **host 一旦传空 env，所有 spawn 都失败**。
        // 现有单测当时写的是「断言 2 字节」，注释却写着「2 字节会返回 87」——
        // 注释与断言互相矛盾，测试反而把 bug 锁住了。
        bytes.Add(0);
        bytes.Add(0);
        if (bytes.Count == 2)
        {
            // 只有块终止符、没有任何变量 → 再补一对，凑成 4 字节。
            bytes.Add(0);
            bytes.Add(0);
        }
        return bytes.ToArray();
    }

    // ---------------- poll ----------------

    /// <summary>轮询线程主体：等进展 → 处理，直到 finished。</summary>
    private void PollLoop()
    {
        while (!ShouldStopPolling())
        {
            WaitForProgress();

            try
            {
                (PollHook ?? Poll)();
            }
            catch (Exception ex)
            {
                PublishResult(MakePollError(ex));
                return;
            }
        }
    }

    /// <summary>轮询是否该停下：已收尾或结果已投递。</summary>
    /// <remarks>
    /// 从 <see cref="PollLoop"/> 里抽出来，让循环条件本身读得懂「什么情况下该停」。
    /// 顺带把这几个分支从 PollLoop 的圈复杂度里移走 —— lizard 会把
    /// lock 块和每个 return 都算进 CCN，原来的写法在工具眼里是 21，
    /// 而真实逻辑只有两个判断。
    /// </remarks>
    private bool ShouldStopPolling()
    {
        lock (_gate)
        {
            return _finished || _resultDelivered;
        }
    }

    /// <summary>
    /// 等一个「可能有进展」的时刻：target 退出、job 变空、或超时。
    /// </summary>
    /// <remarks>
    /// <para>
    /// 原实现是无条件 <c>Thread.Sleep(10)</c>，每轮固定睡满 10ms。这个 10ms 的来历是
    /// node 版 <c>lib/runner.js</c> 的 <c>setInterval(..., 10)</c>：Node 的定时器分辨率
    /// 决定了它做不到更细，于是把轮询间隔当成了「协议的一部分」抄了过来。
    /// <b>但 C# 没有这个限制。</b>
    /// <para>
    /// <b>关于收益的诚实记录</b>：改成事件等待后，端到端耗时<b>测不出可测量的改善</b>。
    /// trace 显示 target 从 ResumeThread 到退出本身就要几十毫秒（<c>cmd.exe</c> 的启动成本），
    /// 原来那 10ms 的睡眠被这段时间完全掩盖了。收益只在「target 在 poll 线程就绪之前
    /// 就已退出」时才会显现，属少数场景。保留此实现是因为它<b>语义更正确</b>
    /// （不无条件睡满一个周期），而不是因为测到了提速 —— 不要据此宣称性能提升。
    /// </para>
    /// </para>
    /// <para>
    /// target 的 process 句柄是可等待对象，<c>WaitForSingleObject</c> 会在它退出的瞬间返回，
    /// 不必等满一个轮询周期。这就是本方法存在的原因：
    /// <b>有句柄可等就等句柄，没句柄可等才睡</b>。
    /// </para>
    /// <para>
    /// 保留 <see cref="PollIntervalMs"/> 作为超时上界，是因为 <see cref="Poll"/>
    /// 还有第二个职责 —— 检查 job 是否已空（整棵进程树回收完）。「job 变空」没有对应的
    /// 可等待句柄，只能靠周期性复查。所以超时不是遗留物，是 job 收尾路径的唯一驱动。
    /// </para>
    /// </remarks>
    internal void WaitForProgress()
    {
        var process = _process;
        if (!HasWaitableProcess(process))
        {
            // 没有可等的进程句柄（未 start / 已退出 / 已释放）时，
            // 只能靠超时驱动 job 收尾检查。
            Thread.Sleep(PollIntervalMs);
            return;
        }

        // 返回值无需判别：WAIT_OBJECT_0（已退出）与 WAIT_TIMEOUT（仍在跑）
        // 之后都走同一个 Poll()，它自己会用 GetExitCodeProcess 判定。
        // WAIT_FAILED 同理 —— 等错了句柄不值得让 runner 崩溃，
        // 退化成「睡满一个周期再查」即可。
        _ = Native.WaitForSingleObject(process!.DangerousGetHandle(), (uint)PollIntervalMs);
    }

    /// <summary>
    /// 该句柄是否值得用于等待。不可用时退化成定时轮询。
    /// </summary>
    /// <remarks>
    /// 单独成静态方法的理由：这是「能否用事件驱动」的判断，与「怎么等」无关，
    /// 因此可以在没有真实进程句柄的单元测试里直接覆盖三个边界
    /// （null / 无效 / 已关闭），而不必构造真实进程。
    /// </remarks>
    internal static bool HasWaitableProcess(SafeKernelHandle? process) =>
        process is not null && !process.IsInvalid && !process.IsClosed;

    private void Poll()
    {
        // 先看 target 是否已退出；退出了就不必再管 job
        if (TryPublishExit(_process)) return;

        // target 还在跑（或已无 process 句柄）时，检查 job 是否已空。
        // job 空 = 里面没有活着的进程 = 整棵进程树都已回收。
        if (IsJobEmptiable() && _resultDelivered) Finish();
    }

    /// <summary>
    /// job 存在且为空时释放它并返回 true；否则返回 false。
    /// </summary>
    /// <remarks>
    /// 「是否为空」的四个前提（非 null / 有效 / 未关闭 / IsEmpty）本身就是一个复合判断，
    /// 单独抽出来让 <see cref="Poll"/> 只表达「空了就收尾」这一个意图，
    /// 而不是把四个句柄状态检查揉进主循环里。
    /// </remarks>
    /// <summary>
    /// 注入一个 job 句柄 —— 仅供测试。
    /// </summary>
    /// <remarks>
    /// 生产路径的 job 只能由 HandleStart 创建，但那要求真的 spawn 一个 target。
    /// 为了单独验证 <see cref="IsJobEmptiable"/> 的四种句柄状态判断
    /// （null / 无效 / 已关闭 / 非空），必须能直接放一个 job 进去。
    /// </remarks>
    internal void SetJobForTest(SafeJobHandle job) => _job = job;

    /// <summary>是否已有进程句柄（target 已启动）—— 仅供测试断言。</summary>
    internal bool HasProcessForTest => _process is not null;

    /// <summary>当前 job 句柄 —— 仅供测试清理。</summary>
    internal SafeJobHandle? JobForTest => _job;

    /// <summary>创建 job 的钩子；测试可替换为「必失败」实现以覆盖 EJOBCREATE 分支。</summary>
    internal Func<SafeJobHandle> CreateJob { get; set; } = SafeJobHandle.Create;

    /// <summary>spawn 的钩子；默认就是真实的 <see cref="SpawnTarget"/>。</summary>
    /// <remarks>
    /// 默认值必须指向真实实现 —— 否则一旦有人忘记设置，生产路径会静默不 spawn，
    /// 表现为「runner 起来了但 target 从未执行」。测试只在需要模拟
    /// CreateProcessW 抛异常时才替换它。
    /// </remarks>
    internal Action<StartRequest, SafeJobHandle>? SpawnTargetHook { get; set; }

    /// <summary>轮询钩子；默认就是真实的 <see cref="Poll"/>。</summary>
    /// <remarks>
    /// 主循环的异常兜底需要「Poll 抛异常」才能触发，而真实的 Poll
    /// 只在句柄被外部破坏等极端情况下才抛。用钩子替换后即可验证：
    /// 异常必须变成 EPOLL 错误投递给 host，而不是让 runner 静默死掉。
    /// </remarks>
    internal Action? PollHook { get; set; }

    internal bool IsJobEmptiable()
    {
        var job = _job;
        if (job is null || job.IsInvalid || job.IsClosed) return false;
        if (!job.IsEmpty()) return false;

        job.Dispose();
        _job = null;
        return true;
    }

    /// <summary>
    /// target 已退出则投递 target-exit 并收尾，返回 true。
    /// 尚未退出、或没有可用的 process 句柄时返回 false。
    /// </summary>
    private bool TryPublishExit(SafeKernelHandle? process)
    {
        if (!TryReadExitCode(process, out var code)) return false;

        Trace.Timed($"target exited code={code}");

        process!.Dispose();
        _process = null;
        // RUNNER-SPEC §6.1：投递 target-exit
        // 不做 (int) 强转：退出码是无符号 32 位，最高位为 1 时强转会翻成负数，
        // 而 host 侧要求 exitCode >= 0，收到负数会直接判协议非法。
        PublishResult(new TargetExitResult { ExitCode = code });
        return true;
    }

    /// <summary>
    /// 读取 target 的退出码；尚未退出（含句柄不可用）时返回 false。
    /// </summary>
    /// <remarks>
    /// 把「句柄是否可读」和「是否仍在运行」这两组前置判断从
    /// <see cref="TryPublishExit"/> 里分出来，后者就只剩「退出码处理」一个意图。
    /// </remarks>
    internal static bool TryReadExitCode(SafeKernelHandle? process, out uint code)
    {
        code = 0;
        if (process is null || process.IsInvalid || process.IsClosed) return false;
        if (!Native.GetExitCodeProcess(process.DangerousGetHandle(), out code)) return false;
        return code != Native.STILL_ACTIVE;
    }

    // ---------------- terminate ----------------

    internal void RequestTermination()
    {
        lock (_gate)
        {
            if (_terminateRequested) return;      // 幂等（RUNNER-SPEC §4.2）
            _terminateRequested = true;
        }
        TryTerminateJob(_job);
    }

    /// <summary>终止 job；失败静默吞掉。</summary>
    /// <remarks>
    /// terminate 与 target 正常退出天然存在竞态：target 可能刚好在这一刻退出，
    /// 于是 TerminateJobObject 失败（job 已空）。这不是错误，
    /// 但也不能让它把 runner 的收尾流程打断 —— 否则已经拿到的结果都投递不出去。
    /// </remarks>
    /// <summary>把轮询异常包装成 EPOLL 错误结果。</summary>
    /// <remarks>
    /// 主循环里任何未预料的异常都必须变成一条**明确的错误结果**投递给 host，
    /// 而不是让 runner 静默死掉。host 收到 EPOLL 能立刻知道「runner 内部出错了」，
    /// 否则只会看到子进程退出，误判成 target 自己的问题。
    /// </remarks>
    internal static ErrorResult MakePollError(Exception ex) => new()
    {
        Error = new SerializedError { Name = "Error", Message = ex.Message, Code = "EPOLL" },
    };

    internal static void TryTerminateJob(SafeJobHandle? job) =>
        TryTerminateJob(job, h => h.Terminate(1));

    /// <summary>TryTerminateJob 的接缝版本：终止动作可注入。</summary>
    /// <remarks>
    /// 「TerminateJobObject 抛异常」需要 target 恰好在同一刻退出，是竞态，
    /// 无法稳定复现。这里注入一个必抛的动作来验证兜底确实吞掉了异常 ——
    /// 兜底写错（比如漏了 catch）会让 runner 在收尾阶段崩溃，
    /// 连已经拿到的结果都投递不出去。
    /// </remarks>
    internal static void TryTerminateJob(SafeJobHandle? job, Action<SafeJobHandle> terminate)
    {
        try
        {
            if (job is not null) terminate(job);
        }
        catch
        {
            // terminate 失败不应 crash runner
        }
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

    // ---------------- 结果投递 ----------------

    // ── spawn 错误对齐表（逐项复制自 @deepseek-ai/dsh-subprocess-local/lib/runner.js）──
    // node 把 Win32 错误码映射成 Node 风格的 errno 字符串，再拼成
    //   { message: "<syscall> <code>", code, syscall, path? }
    // A/B 要求字节级一致，所以这张表必须逐条对齐，不能自创文本。

    /// <summary>Win32 错误码 → Node errno 字符串（对应 WINDOWS_SPAWN_ERROR_CODES）。</summary>
    internal static readonly Dictionary<int, string> WindowsSpawnErrorCodes = new()
    {
        [2] = "ENOENT",     // ERROR_FILE_NOT_FOUND
        [3] = "ENOENT",     // ERROR_PATH_NOT_FOUND
        [267] = "ENOENT",   // ERROR_DIRECTORY
        [5] = "EPERM",      // ERROR_ACCESS_DENIED
        [193] = "EFTYPE",   // ERROR_BAD_EXE_FORMAT
        [740] = "EACCES",   // ERROR_ELEVATION_REQUIRED
    };

    /// <summary>需要把程序名写入 syscall 和 path 的错误码（对应 NODE_SPAWN_DETAIL_CODES）。</summary>
    internal static readonly HashSet<string> NodeSpawnDetailCodes = new(StringComparer.Ordinal)
    {
        "EACCES", "ENOENT",
    };

    /// <summary>构造与 node 完全一致的 spawn 错误对象。</summary>
    internal static SerializedError MakeNodeSpawnError(string syscall, string code, string? path)
    {
        return new SerializedError
        {
            Name = "Error",
            Message = $"{syscall} {code}",
            Code = code,
            Syscall = syscall,
            Path = path,
        };
    }

    /// <summary>可执行文件在 PATH/cwd 中完全找不到 —— 对应 node 的 windowsPathNotFoundError。</summary>
    private void EmitSpawnEnoent(string program)
    {
        PublishResult(new ErrorResult
        {
            Error = MakeNodeSpawnError($"spawn {program}", "ENOENT", program),
        });
    }

    /// <summary>CreateProcessW 失败 —— 对应 node 的 asSpawnError。</summary>
    private void EmitCreateProcessError(int win32Code, string program)
    {
        Trace.Write($"CreateProcessW failed: win32Code={win32Code}");
        var code = WindowsSpawnErrorCodes.TryGetValue(win32Code, out var mapped) ? mapped : "UNKNOWN";
        // 详情型错误码把程序名带进 syscall/path；其余只保留 "spawn"
        PublishResult(new ErrorResult
        {
            Error = NodeSpawnDetailCodes.Contains(code)
                ? MakeNodeSpawnError($"spawn {program}", code, program)
                : MakeNodeSpawnError("spawn", code, null),
        });
    }

    /// <summary>
    /// 把终态结果对象序列化成协议 JSON。
    /// </summary>
    /// <remarks>
    /// 抽成 internal static 是为了能直接断言「未知类型不会把 runner 带崩」：
    /// 兜底分支返回 "{}" 而不是抛异常。runner 在收到无法识别的结果对象时
    /// 仍然必须给 host 一个**合法 JSON**，否则 host 侧的解析会失败，
    /// 表现为「调用挂住而不是报错」—— 比明确报错更难排查。
    /// </remarks>
    internal static string SerializeResult(object result) => result switch
    {
        TargetExitResult r => ProtocolJson.Serialize(r),
        ErrorResult r => ProtocolJson.Serialize(r),
        _ => "{}",
    };

    private void PublishResult(object result)
    {
        lock (_gate)
        {
            if (_resultDelivered) return;         // 只投递一次（RUNNER-SPEC §6.3）
            _resultDelivered = true;
        }

        WriteLine(SerializeResult(result));

        // RUNNER-SPEC §6.1 / 源码 publishTerminalResult(result, 0)：
        // 投递 terminal result 后立即 finish(0) —— runner 不应继续等待新消息。
        Finish();
    }

    internal void WriteLine(string json)
    {
        try
        {
            _channel.Send(json);
        }
        catch (Exception ex)
        {
            // host 已断开，忽略 —— 但留痕，免得「结果发出去了」这种假设永远不被质疑
            OnSendFailed(ex);
        }
    }

    /// <summary>发送失败的处理：只留痕，不抛出。</summary>
    /// <remarks>
    /// 独立成方法便于直接测试：真实场景里要制造「Send 抛异常」需要 host 断开，
    /// 而那是竞态，难以稳定复现。这里要守的行为很简单也很重要 ——
    /// **吞掉异常但留痕**。若改成直接吞掉不留痕，排查时会完全失去线索；
    /// 若改成重新抛出，runner 会在收尾阶段崩掉，连已有结果都丢了。
    /// </remarks>
    internal static void OnSendFailed(Exception ex) =>
        Trace.Write($"send failed: {ex.GetType().Name}: {ex.Message}");

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

/// <summary>按行读取 stdin（不依赖 Console.ReadLine 的编码假设）。</summary>
internal sealed class LineReader
{
    private readonly Stream _stream;
    private readonly byte[] _chunk = new byte[64 * 1024];
    private int _chunkPos;
    private int _chunkLen;
    private readonly List<byte> _buffer = new(4096);

    public LineReader(Stream stream) => _stream = stream;

    public string? ReadLine()
    {
        // 逐字节 ReadByte() 会让每个字节都变成一次 IO 调用。
        // 实测（Issue #9）：46KB 的 start 请求（大 env）比 3.4KB 的多花 **33ms**，
        // 而 node runner 在同一对比下是 0ms —— 差异全在这里。
        // 改为整块读入 64KB 缓冲，再从内存里切行。
        while (true)
        {
            if (_chunkPos >= _chunkLen && !Refill()) return TakeTail();

            var span = _chunk.AsSpan(_chunkPos, _chunkLen - _chunkPos);
            var nl = span.IndexOf((byte)'\n');
            if (nl >= 0) return TakeLine(span, nl);

            // 缓冲里没有换行：整块吞掉，继续读
            _buffer.AddRange(span.ToArray());
            _chunkPos = _chunkLen;
        }
    }

    /// <summary>
    /// 从底层流再读一块。读到 EOF 返回 false。
    /// </summary>
    private bool Refill()
    {
        _chunkLen = _stream.Read(_chunk, 0, _chunk.Length);
        _chunkPos = 0;
        return _chunkLen > 0;
    }

    /// <summary>
    /// 切出 <paramref name="nl"/> 位置之前的一行（并消费掉该换行符）。
    /// </summary>
    private string TakeLine(ReadOnlySpan<byte> span, int nl)
    {
        _buffer.AddRange(span[..nl].ToArray());
        _chunkPos += nl + 1;
        var line = Encoding.UTF8.GetString(_buffer.ToArray()).TrimEnd('\r');
        _buffer.Clear();
        return line;
    }

    /// <summary>
    /// EOF 时把缓冲区里残留的半行交出去；没有残留则返回 null。
    /// </summary>
    /// <remarks>
    /// 最后一行可能不带换行符 —— 直接丢弃会让最后一条消息静默消失。
    /// </remarks>
    private string? TakeTail()
    {
        if (_buffer.Count == 0) return null;
        var tail = Encoding.UTF8.GetString(_buffer.ToArray());
        _buffer.Clear();
        return tail;
    }
}

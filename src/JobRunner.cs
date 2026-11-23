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
internal sealed partial class JobRunner : IDisposable
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
            PublishTerminatedBeforeStart();
            return;
        }

        var job = TryCreateOwnedJob();
        if (job is null) return;                      // 错误已投递

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
            PublishResult(MakeJobCreateError(ex));
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
    /// 把 start 请求变成一次真实的进程启动：解析 → 构造 → 继承控制 → 起进程。
    /// </summary>
    /// <remarks>
    /// 这里只保留"顺序"和"任何一步失败就结束"这两件事，每一步自己的细节都在
    /// 各自的方法里。此前它是一个 65 行的方法，读的人要同时跟踪 5 个局部变量的
    /// 生命周期，才能确认第 4 步用的是第 2 步的哪个产物。
    /// </remarks>
    private void SpawnTarget(StartRequest req, SafeJobHandle job)
    {
        // ---- 1. 命令行 ----
        // CreateProcessW 的第一个参数为 NULL 时，用命令行首 token 查找可执行文件。
        // 若该 token 不含路径分隔符且不在 PATH 中，会返回 ERROR_FILE_NOT_FOUND(2)。
        // 所以这里先解析成绝对路径，不依赖 CreateProcessW 自己的搜索策略。
        string cmdline;
        using (Trace.Measure("build-cmdline")) cmdline = ExecutableResolver.BuildCommandLine(_argv);

        string? appName;
        using (Trace.Measure("resolve-exe")) appName = ExecutableResolver.ResolveExecutable(_argv[0], req.Cwd, req.Env);
        if (appName is null)
        {
            // 与 node 一致：候选全部不存在 → ENOENT，文本对齐 libuv/Node 的 spawn 错误
            EmitSpawnEnoent(_argv[0]);
            Finish();
            return;
        }

        // ---- 2. 环境块（CREATE_UNICODE_ENVIRONMENT → UTF-16）----
        // DSH_SUBPROCESS_CONTROL=pipe 由 **host** 注入（runner-launch 的
        // targetEnvironment / controlEnvironment），随 start 请求的 env 一起送达，
        // runner 只负责原样透传。runner 自己再注入一次会造成与 node 的分歧 ——
        // 那时 target 会看到一个 host 并没有设置的标记。
        byte[] envBlock;
        using (Trace.Measure("env-block")) envBlock = EnvironmentBlock.BuildEnvironmentBlock(req.Env);

        // ---- 3. target 的 stdio 接到 host 传入的通道 ----
        StdioHandles stdio;
        using (Trace.Measure("resolve-stdio")) stdio = ResolveStdioHandles();

        // ---- 4. control channel + 精确控制继承 ----
        if (!TryResolveControlTargets(req, stdio, out var hControl, out var inheritToggled)) return;

        LaunchWithDescriptorTable(new LaunchPlan(
            req, job, appName, cmdline, envBlock, stdio, hControl, inheritToggled));

        // 说明：早期版本曾在这里用 DSH_AOT_SUPPRESS=1 开关去清 fd 0/1/2 的继承标志。
        // 那是实验残留 —— runner 是 console 程序，fd 0/1/2 由 host 映射到 target 的
        // stdout/stderr，动它们会连带关掉输出通道，而抑制继承本来就不依赖这一步。
        // 真正保证 target 拿不到协议句柄的是：fd 4/5/6 之外不额外打开可继承句柄，
        // 且 CreateProcessW 返回后立刻在 finally 里恢复所有被改过的标志。
    }

    /// <summary>
    /// 解析 control 句柄并把 target 需要的句柄标成可继承。
    /// </summary>
    /// <returns>
    /// false 表示 host 声明了 control 却没给可用的 fd 7 —— 这是 host 侧契约违约，
    /// 错误已投递，调用方必须就此结束。不能静默降级成「无 control」，
    /// 否则 target 会永远等一条不存在的通道。
    /// </returns>
    private bool TryResolveControlTargets(
        StartRequest req,
        StdioHandles stdio,
        out IntPtr hControl,
        out List<(IntPtr Handle, bool WasInheritable)> inheritToggled)
    {
        var controlRequested = req.Control == "pipe";
        hControl = ResolveControlHandle(controlRequested);
        inheritToggled = [];

        if (controlRequested && !IsValid(hControl))
        {
            PublishControlMissingError();
            return false;
        }

        inheritToggled = EnableInheritanceFor(CollectTargetHandles(stdio, controlRequested, hControl));
        return true;
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
    /// <summary>
    /// 一次启动所需的全部已解析产物。
    /// </summary>
    /// <remarks>
    /// 用记录打包而不是继续加参数：这个方法此前已经 8 个参数（xp-gate 的
    /// too-many-params 上限是 7），而它们全都是「上游几步算出来、这里只是往下传」
    /// 的中间产物，没有一个是真正的配置项。打成一条记录后，新增一个产物
    /// 只会在记录上多一个字段，调用链不会随之变长。
    /// </remarks>
    private readonly record struct LaunchPlan(
        StartRequest Request,
        SafeJobHandle Job,
        string AppName,
        string Cmdline,
        byte[] EnvBlock,
        StdioHandles Stdio,
        IntPtr ControlHandle,
        List<(IntPtr Handle, bool WasInheritable)> InheritToggled);

    private void LaunchWithDescriptorTable(LaunchPlan plan)
    {
        // CRT 描述符表：只有 control 请求时才需要（其余情况走默认标准句柄表）
        var descriptorTable = CrtDescriptorTable.Encode(
            plan.Stdio.In, plan.Stdio.Out, plan.Stdio.Err, plan.ControlHandle);
        var descriptorPtr = IntPtr.Zero;
        if (descriptorTable is not null)
        {
            descriptorPtr = Marshal.AllocHGlobal(descriptorTable.Length);
            Marshal.Copy(descriptorTable, 0, descriptorPtr, descriptorTable.Length);
        }

        var si = BuildStartupInfo(plan.Stdio, descriptorTable, descriptorPtr);
        try
        {
            LaunchProcess(plan, si);
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
            // 不做 (short) 强转：cbReserved2 在 Win32 里是 WORD（无符号 16 位），
            // 强转成有符号 short 后，长度一旦超过 32767 就会翻成负数，
            // CreateProcessW 读到的是「负数字节数」。这正是 exitCode 那个 bug
            // 的同一模式 —— 只不过这里靠「表长固定为 8」碰巧没出事。
            //
            // 改成显式校验：真超了就明确报错，而不是静默回绕。
            if (descriptorTable!.Length > ushort.MaxValue)
            {
                throw new InvalidOperationException(
                    $"描述符表长度 {descriptorTable.Length} 超过 cbReserved2 的 WORD 上限");
            }

            // cast-audit:ignore 上面已显式校验过长度不超 ushort.MaxValue
            si.cbReserved2 = (ushort)descriptorTable.Length;
            si.lpReserved2 = descriptorPtr;
        }

        return si;
    }

    /// <summary>
    /// 调用 CreateProcessW 并完成 Job 入队、线程放行、句柄继承恢复。
    ///
    /// RUNNER-SPEC §5.3 步骤 3~5。任何一步失败都会 emit 错误并 Finish()。
    /// </summary>
    private void LaunchProcess(LaunchPlan plan, Native.STARTUPINFO si)
    {
        var envPtr = Marshal.AllocHGlobal(plan.EnvBlock.Length);
        try
        {
            Marshal.Copy(plan.EnvBlock, 0, envPtr, plan.EnvBlock.Length);
            var flags = Native.CREATE_SUSPENDED | Native.CREATE_UNICODE_ENVIRONMENT;
            // CreateProcessW 的 lpCurrentDirectory 必须是 Windows 路径格式（反斜杠），
            // 传入 "C:/" 这类正斜杠路径会返回 ERROR_INVALID_PARAMETER(87)。
            var cwd = ExecutableResolver.NormalizeWindowsPath(plan.Request.Cwd);

            Trace.Timed($"about to CreateProcessW: {plan.AppName}");
            try
            {
                LaunchSuspended(plan, si, envPtr, cwd, flags);
            }
            finally
            {
                RestoreInheritance(plan.InheritToggled);
            }
        }
        finally
        {
            Marshal.FreeHGlobal(envPtr);
        }
    }

    /// <summary>
    /// RUNNER-SPEC §5.3 步骤 3~5：创建挂起进程 → 入 Job → 放行线程。
    /// </summary>
    /// <remarks>
    /// 三步的顺序不可交换：
    ///   - 挂起创建：进程在入 Job 之前不能跑起来，否则它可能已经 spawn 出孙进程，
    ///     那些孙进程会漏出 Job 的回收范围。
    ///   - 先入 Job 再放行：反过来会有一段「进程已运行但不在 Job 里」的窗口，
    ///     runner 在这段窗口里崩溃就泄漏整棵树。
    /// </remarks>
    private void LaunchSuspended(LaunchPlan plan, Native.STARTUPINFO si, IntPtr envPtr, string? cwd, uint flags)
    {
        if (!CreateSuspendedProcess(plan.AppName, plan.Cmdline, envPtr, cwd, flags, si, out var pi))
        {
            Finish();
            return;
        }

        _process = new SafeKernelHandle(pi.hProcess);
        _thread = new SafeKernelHandle(pi.hThread);
        _targetPid = pi.dwProcessId;
        Trace.Timed($"CreateProcessW ok, pid={pi.dwProcessId}");

        // 步骤 4：先入 Job。
        // 无条件执行 —— 曾经有一个 DSH_AOT_NOJOB=1 实验开关用来诊断，
        // 但实测它会让 terminate 失效、target 进程树泄漏，属于生产路径上的
        // 定时炸弹，已移除。Job 隔离是本 runner 的核心契约，不可绕过。
        plan.Job.AssignProcess(pi.hProcess);
        Trace.Timed("AssignProcessToJobObject ok");

        // 步骤 5：再放行。
        if (!ResumeTargetThread(pi)) return;
        Trace.Timed("ResumeThread ok");

        // 注：DSH 的 runner.js 会在 spawn 后 closeSync(4/5/6/7) 关闭自己的副本。
        // AOT 版暂不照做 —— 现有 24 项 A/B 在不关的情况下已与 node 行为一致，
        // 贸然改动会影响已稳定的输出通道语义。见 Issue #2 的后续评估。
    }

    /// <summary>
    /// 把 <see cref="EnableInheritanceFor"/> 改过的继承标志恢复原样。
    /// </summary>
    /// <remarks>
    /// 必须无条件执行（放在 finally 里）：CreateProcessW 一旦返回，这些标志就没有
    /// 用处了，留着会让 runner 后续创建的 target 继承本不该继承的句柄。
    /// </remarks>
    private static void RestoreInheritance(List<(IntPtr Handle, bool WasInheritable)> toggled)
    {
        foreach (var (handle, wasInheritable) in toggled)
        {
            if (!wasInheritable)
                Native.SetHandleInformation(handle, Native.HANDLE_FLAG_INHERIT, 0);
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

    private static bool IsValid(IntPtr h) => h != IntPtr.Zero && h != new IntPtr(-1);

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

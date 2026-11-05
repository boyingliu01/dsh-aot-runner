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
    private const int PollIntervalMs = 10;          // RUNNER-SPEC §7

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

    private void HandleMessage(string line)
    {
        // 注意：这里只用 JsonDocument（启动开销 ~33ms）。
        // 绝不能用 JsonSerializer.Deserialize —— AOT 下会多付 ~1.2s 启动代价。
        var type = ProtocolJson.PeekType(line, out var jsonError);
        if (jsonError is not null)
        {
            FailProtocol($"invalid JSON: {jsonError}");
            return;
        }
        if (type is null)
        {
            FailProtocol("message missing 'type'");
            return;
        }

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
        var req = ProtocolJson.ParseStart(line, out var parseError);
        if (req is null)
        {
            FailProtocol($"invalid start request: {parseError ?? "parse failed"}");
            return;
        }

        HandleStart(req);
    }

    // ---------------- start ----------------

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
            job = SafeJobHandle.Create();
            job.EnableKillOnClose();                  // RUNNER-SPEC §5.3 步骤 1-2
        }
        catch (Win32Exception ex)
        {
            PublishResult(new ErrorResult
            {
                Error = new SerializedError { Name = "Error", Message = ex.Message, Code = "EJOBCREATE" }
            });
            return;
        }
        _job = job;

        try
        {
            SpawnTarget(req, job);
        }
        catch (Win32Exception ex)
        {
            // CreateProcessW 失败 → 错误带 path（RUNNER-SPEC §6.2）
            PublishResult(new ErrorResult
            {
                Error = new SerializedError
                {
                    Name = "Error",
                    Message = ex.Message,
                    Code = "ENOENT",
                    Syscall = "spawn",
                    Path = _argv.Length > 0 ? _argv[0] : null
                }
            });
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
        var cmdline = BuildCommandLine(_argv);
        var appName = ResolveExecutable(_argv[0], req.Cwd, req.Env);
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
        var envBlock = BuildEnvironmentBlock(req.Env);

        // ---- 3. 把 target 的 stdio 接到 host 传入的通道 ----
        var stdio = ResolveStdioHandles();

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
        controlRequested ? Native.CrtGetOsFHandle(CrtDescriptorTable.ControlFileDescriptor) : IntPtr.Zero;

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
        var hIn = Native.CrtGetOsFHandle(4);
        var hOut = Native.CrtGetOsFHandle(5);
        var hErr = Native.CrtGetOsFHandle(6);

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
    private void PublishControlMissingError()
    {
        PublishResult(new ErrorResult
        {
            Error = new SerializedError
            {
                Name = "Error",
                Message = "subprocess control channel was not inherited",
                Code = "EPROTOCOL",
            },
        });
    }

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
    private bool ResumeTargetThread(Native.PROCESS_INFORMATION pi)
    {
        var suspendCount = Native.ResumeThread(pi.hThread);
        if (suspendCount != Native.RESUME_THREAD_FAILED) return true;

        var resumeError = Marshal.GetLastWin32Error();
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
            try
            {
                // executableCandidateExists：存在且不是目录
                if (File.Exists(full)) return full;
            }
            catch { }
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
        }
        // 块终止符
        bytes.Add(0);
        bytes.Add(0);
        return bytes.ToArray();
    }

    // ---------------- poll ----------------

    private void PollLoop()
    {
        while (true)
        {
            lock (_gate)
            {
                if (_finished) return;
                if (_resultDelivered) return;
            }

            Thread.Sleep(PollIntervalMs);

            try
            {
                Poll();
            }
            catch (Exception ex)
            {
                PublishResult(new ErrorResult
                {
                    Error = new SerializedError { Name = "Error", Message = ex.Message, Code = "EPOLL" }
                });
                return;
            }
        }
    }

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
    private bool IsJobEmptiable()
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
        PublishResult(new TargetExitResult { ExitCode = (int)code });
        return true;
    }

    /// <summary>
    /// 读取 target 的退出码；尚未退出（含句柄不可用）时返回 false。
    /// </summary>
    /// <remarks>
    /// 把「句柄是否可读」和「是否仍在运行」这两组前置判断从
    /// <see cref="TryPublishExit"/> 里分出来，后者就只剩「退出码处理」一个意图。
    /// </remarks>
    private static bool TryReadExitCode(SafeKernelHandle? process, out uint code)
    {
        code = 0;
        if (process is null || process.IsInvalid || process.IsClosed) return false;
        if (!Native.GetExitCodeProcess(process.DangerousGetHandle(), out code)) return false;
        return code != Native.STILL_ACTIVE;
    }

    // ---------------- terminate ----------------

    private void RequestTermination()
    {
        lock (_gate)
        {
            if (_terminateRequested) return;      // 幂等（RUNNER-SPEC §4.2）
            _terminateRequested = true;
        }
        try
        {
            _job?.Terminate(1);
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
    private static readonly Dictionary<int, string> WindowsSpawnErrorCodes = new()
    {
        [2] = "ENOENT",     // ERROR_FILE_NOT_FOUND
        [3] = "ENOENT",     // ERROR_PATH_NOT_FOUND
        [267] = "ENOENT",   // ERROR_DIRECTORY
        [5] = "EPERM",      // ERROR_ACCESS_DENIED
        [193] = "EFTYPE",   // ERROR_BAD_EXE_FORMAT
        [740] = "EACCES",   // ERROR_ELEVATION_REQUIRED
    };

    /// <summary>需要把程序名写入 syscall 和 path 的错误码（对应 NODE_SPAWN_DETAIL_CODES）。</summary>
    private static readonly HashSet<string> NodeSpawnDetailCodes = new(StringComparer.Ordinal)
    {
        "EACCES", "ENOENT",
    };

    /// <summary>构造与 node 完全一致的 spawn 错误对象。</summary>
    private static SerializedError MakeNodeSpawnError(string syscall, string code, string? path)
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
        var code = WindowsSpawnErrorCodes.TryGetValue(win32Code, out var mapped) ? mapped : "UNKNOWN";
        // 详情型错误码把程序名带进 syscall/path；其余只保留 "spawn"
        PublishResult(new ErrorResult
        {
            Error = NodeSpawnDetailCodes.Contains(code)
                ? MakeNodeSpawnError($"spawn {program}", code, program)
                : MakeNodeSpawnError("spawn", code, null),
        });
    }

    private void PublishResult(object result)
    {
        lock (_gate)
        {
            if (_resultDelivered) return;         // 只投递一次（RUNNER-SPEC §6.3）
            _resultDelivered = true;
        }

        var json = result switch
        {
            TargetExitResult r => ProtocolJson.Serialize(r),
            ErrorResult r => ProtocolJson.Serialize(r),
            _ => "{}"
        };
        WriteLine(json);

        // RUNNER-SPEC §6.1 / 源码 publishTerminalResult(result, 0)：
        // 投递 terminal result 后立即 finish(0) —— runner 不应继续等待新消息。
        Finish();
    }

    private void WriteLine(string json)
    {
        try
        {
            _channel.Send(json);
        }
        catch (Exception ex)
        {
            // host 已断开，忽略 —— 但留痕，免得「结果发出去了」这种假设永远不被质疑
            Trace.Write($"send failed: {ex.GetType().Name}: {ex.Message}");
        }
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

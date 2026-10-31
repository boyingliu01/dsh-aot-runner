// 核心进程管理 —— 严格对齐 RUNNER-SPEC.md
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;   // 仅 JsonDocument（PeekType/ParseStart 内部用），禁用 JsonSerializer

namespace DshAotRunner;

/// <summary>
/// Windows Job runner：把一个目标命令放进 Job Object，使其可整树回收。
/// 语义基线见 RUNNER-SPEC.md。
/// </summary>
internal sealed class JobRunner
{
    private const int PollIntervalMs = 10;          // RUNNER-SPEC §7

    private readonly string[] _argv;
    private readonly Stream _out;
    private readonly object _gate = new();

    // 状态字段 —— 对齐 RUNNER-SPEC §4.1
    private bool _startSeen;
    private bool _terminateRequested;
    private bool _resultDelivered;
    private bool _finished;

    private SafeJobHandle? _job;
    private SafeKernelHandle? _process;
    private SafeKernelHandle? _thread;
    private int _targetPid;

    public JobRunner(string[] argv, Stream outStream)
    {
        _argv = argv;
        _out = outStream;
    }

    /// <summary>主循环：读 stdin 的 NDJSON 消息，直到 finished。</summary>
    public int Run()
    {
        var stdin = Console.OpenStandardInput();
        var reader = new LineReader(stdin);

        while (!_finished)
        {
            string? line;
            try
            {
                line = reader.ReadLine();
            }
            catch (IOException ex) when (ex.Message.Contains("Broken") || ex.Message.Contains("pipe"))
            {
                OnDisconnect();
                break;
            }

            if (line is null)
            {
                // stdin EOF = 父进程断开（RUNNER-SPEC §4.2）
                OnDisconnect();
                break;
            }

            if (line.Length == 0) continue;
            DbgT($"got message: {line}");
            HandleMessage(line);
        }

        ReleaseOwnedJob();
        return 0;
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

        if (type == "terminate")
        {
            RequestTermination();
            return;
        }

        if (type == "start")
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
            return;
        }

        FailProtocol($"unknown message type: {type}");
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
        var envBlock = BuildEnvironmentBlock(req.Env);

        // ---- 3. 把 target 的 stdio 接到 host 传入的通道 ----
        // host 用 Node 的 spawn stdio 数组按「文件描述符」编号传递通道：
        //   stdio[4] → fd 4 (target stdin)
        //   stdio[5] → fd 5 (target stdout)
        //   stdio[6] → fd 6 (target stderr)
        // Windows 上必须用 CRT 的 _get_osfhandle 取句柄 —— GetStdHandle(4/5/6)
        // 只会返回 INVALID_HANDLE_VALUE（实测 0xFFFFFFFF），因为它查的是标准
        // 句柄表的固定索引（-10/-11/-12），不是 CRT 的 fd 表。
        var hIn = Native.CrtGetOsFHandle(4);
        var hOut = Native.CrtGetOsFHandle(5);
        var hErr = Native.CrtGetOsFHandle(6);

        // 各句柄独立判断：位号不可用时退回本进程对应标准句柄
        var hStdIn = IsValid(hIn) ? hIn : Native.GetStdHandle(Native.STD_INPUT_HANDLE);
        var hStdOut = IsValid(hOut) ? hOut : Native.GetStdHandle(Native.STD_OUTPUT_HANDLE);
        var hStdErr = IsValid(hErr) ? hErr : Native.GetStdHandle(Native.STD_ERROR_HANDLE);

        // 【临时诊断已移除】

        if (Native.GetHandleInformation(hStdOut, out var infOut))
            Dbg($"hStdOut flags={infOut:X} (inherit={(infOut & 1)})");
        else
            Dbg($"hStdOut GetHandleInformation FAILED err={Marshal.GetLastWin32Error()}");

        // ---- 3b. 精确控制继承：只放行 target 需要的 3 个句柄 ----
        // CreateProcessW 的 bInheritHandles=true 会继承本进程所有「可继承」句柄。
        // runner 自己从 host 继承来的协议管道（fd0/fd1/fd2）默认就是可继承的，
        // 若不处理，target 会连 runner 的协议通道一起继承走。
        //
        // 这不只是洁癖问题：MSYS2/Cygwin 程序（git-bash）对句柄表极其敏感，
        // 多拿到 inherited 句柄会在初始化时崩在
        //   NtCreateDirectoryObject(\BaseNamedObjects\msys-2.0S5-...): 0xC0000022
        // 实测 bash 因此 100% 启动失败（exit=-1073741502）。
        //
        // 做法（对齐 @deepseek-ai/dsh-win32-process 的 spawnJobProcess）：
        //   1. 把 target 要用的 3 个句柄显式置为 HANDLE_FLAG_INHERIT
        //   2. 把这些句柄以外的继承标志关掉——通过「先全部关、再逐个开」实现
        var inheritToggled = new List<(IntPtr Handle, bool WasInheritable)>(3);
        foreach (var h in new[] { hStdIn, hStdOut, hStdErr })
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

        // 关掉 runner 自身协议通道的继承标志（target 绝不该看到它们）
        // 【实验】暂时全部禁用，验证继承抑制是否为 bash 崩溃的原因
        var suppressedInherit = new List<IntPtr>(0);
        if (Environment.GetEnvironmentVariable("DSH_AOT_SUPPRESS") == "1")
        {
            foreach (var fd in new[] { 0, 1, 2 })
            {
                var h = Native.CrtGetOsFHandle(fd);
                if (!IsValid(h)) continue;
                if (h == hStdIn || h == hStdOut || h == hStdErr) continue;
                if (Native.GetHandleInformation(h, out var f) && (f & Native.HANDLE_FLAG_INHERIT) != 0)
                {
                    suppressedInherit.Add(h);
                    Native.SetHandleInformation(h, Native.HANDLE_FLAG_INHERIT, 0);
                }
            }
        }

        var si = new Native.STARTUPINFO
        {
            cb = Marshal.SizeOf<Native.STARTUPINFO>(),
            dwFlags = Native.STARTF_USESTDHANDLES | Native.STARTF_USESHOWWINDOW,
            wShowWindow = Native.SW_HIDE,
            hStdInput = hStdIn,
            hStdOutput = hStdOut,
            hStdError = hStdErr,
        };

        var envPtr = Marshal.AllocHGlobal(envBlock.Length);
        try
        {
            Marshal.Copy(envBlock, 0, envPtr, envBlock.Length);
            var flags = Native.CREATE_SUSPENDED | Native.CREATE_UNICODE_ENVIRONMENT;
            // CreateProcessW 的 lpCurrentDirectory 必须是 Windows 路径格式（反斜杠），
            // 传入 "C:/" 这类正斜杠路径会返回 ERROR_INVALID_PARAMETER(87)。
            var cwd = NormalizeWindowsPath(req.Cwd);

            // RUNNER-SPEC §5.3 步骤 3
            DbgT($"about to CreateProcessW: {appName}");
            try
            {
                if (!Native.CreateProcessW(appName, cmdline, IntPtr.Zero, IntPtr.Zero,
                        bInheritHandles: true, dwCreationFlags: flags,
                        lpEnvironment: envPtr, lpCurrentDirectory: cwd,
                        ref si, out var pi))
                {
                    // 对齐 node 的 asSpawnError：把 Win32 码翻成 Node errno 文本，
                    // 而不是自创 "CreateProcessW failed for ..." 这类消息。
                    EmitCreateProcessError(Marshal.GetLastWin32Error(), _argv[0]);
                    Finish();
                    return;
                }

                _process = new SafeKernelHandle(pi.hProcess);
                _thread = new SafeKernelHandle(pi.hThread);
                _targetPid = pi.dwProcessId;

                DbgT($"CreateProcessW ok, pid={pi.dwProcessId}");
                // RUNNER-SPEC §5.3 步骤 4：先入 Job
                // 【实验】可用 DSH_AOT_NOJOB=1 跳过入 Job，验证 Job 是否为主要限制
                if (Environment.GetEnvironmentVariable("DSH_AOT_NOJOB") != "1")
                {
                    job.AssignProcess(pi.hProcess);
                    DbgT("AssignProcessToJobObject ok");
                }
                else
                {
                    DbgT("SKIP AssignProcessToJobObject (experiment)");
                }

                // RUNNER-SPEC §5.3 步骤 5：再放行
                Native.ResumeThread(pi.hThread);
                DbgT("ResumeThread ok");
            }
            finally
            {
                // 恢复句柄继承标志：CreateProcessW 一返回就没用了，
                // 留着会污染 runner 后续创建的其他 target。
                foreach (var h in suppressedInherit)
                    Native.SetHandleInformation(h, Native.HANDLE_FLAG_INHERIT, Native.HANDLE_FLAG_INHERIT);
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

    /// <summary>把路径规范化为 Windows 反斜杠格式；空值返回 null（表示继承当前目录）。</summary>
    private static string? NormalizeWindowsPath(string? path)
    {
        if (string.IsNullOrWhiteSpace(path)) return null;
        const char Bs = '\\';
        var normalized = path.Replace('/', Bs);
        // 去掉末尾多余的反斜杠（但保留根路径如 "C:\"）
        if (normalized.Length > 3 && normalized.EndsWith(Bs))
            normalized = normalized.TrimEnd(Bs);
        if (normalized.Length == 2 && normalized[1] == ':')
            normalized += Bs;
        return normalized;
    }

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
    private static string? ResolveExecutable(string program, string? cwd, Dictionary<string, string>? env)
    {
        if (string.IsNullOrEmpty(program)) return null;

        // windowsFileNameStart：定位文件名起始处（跳过盘符和目录部分）
        var nameStart = WindowsFileNameStart(program);
        var directory = program.Substring(0, nameStart);
        var name = program.Substring(nameStart);
        var hasPath = nameStart != 0;

        // 扩展名判定：点号存在且不是最后一个字符
        var dot = name.IndexOf('.');
        var hasExtension = dot >= 0 && dot < name.Length - 1;
        var separator = name.EndsWith(".") ? "" : ".";

        // 候选名顺序：自带扩展名的原样名 → .com → .exe
        var candidates = new List<string>(3);
        if (hasExtension) candidates.Add(name);
        candidates.Add(name + separator + "com");
        candidates.Add(name + separator + "exe");

        // 搜索根：带路径 → 只有该目录；不带路径 → cwd（可禁用）+ 各 PATH 目录
        var roots = new List<string>(8);
        if (hasPath)
        {
            roots.Add(directory);
        }
        else
        {
            // 本进程环境决定是否搜索 cwd（与 node 的 currentEnv 视角一致）
            var noDefaultCwd = Environment.GetEnvironmentVariable("NODEFAULTCURRENTDIRECTORYINEXEPATH");
            if (noDefaultCwd is null) roots.Add("");
            roots.AddRange(SplitPath(GetEnvValue(env, "PATH")
                ?? Environment.GetEnvironmentVariable("PATH") ?? ""));
        }

        foreach (var root in roots)
        {
            var basePath = WindowsSearchPathJoin(root, name, cwd ?? "");
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
        }
        return null;
    }

    /// <summary>定位文件名在整条路径中的起始索引（跳过 "C:\dir\" 这类前缀）。</summary>
    private static int WindowsFileNameStart(string command)
    {
        var i = command.Length;
        while (i > 0)
        {
            var c = command[i - 1];
            if (c == '\\' || c == '/') return i;
            if (c == ':' && i == 2) return i;   // 盘符，文件名从盘符后开始
            i--;
        }
        return 0;
    }

    /// <summary>把 PATH 拆成目录列表（分号分隔，去引号与空项）。</summary>
    private static IEnumerable<string> SplitPath(string pathVar)
    {
        foreach (var raw in pathVar.Split(';', StringSplitOptions.RemoveEmptyEntries))
        {
            var trimmed = raw.Trim().Trim('"');
            if (trimmed.Length > 0) yield return trimmed;
        }
    }

    /// <summary>按大小写不敏感取环境变量值。</summary>
    private static string? GetEnvValue(Dictionary<string, string>? env, string key)
    {
        if (env is null) return null;
        foreach (var kv in env)
        {
            if (string.Equals(kv.Key, key, StringComparison.OrdinalIgnoreCase)) return kv.Value;
        }
        return null;
    }

    /// <summary>把搜索根与文件名拼成基路径；根为空时用 cwd（对齐 windowsSearchPathJoin）。</summary>
    private static string WindowsSearchPathJoin(string root, string name, string cwd)
    {
        if (root.Length == 0)
            return cwd.Length == 0 ? "" : cwd.TrimEnd('\\', '/') + "\\";
        return root.TrimEnd('\\', '/') + "\\";
    }

    private static readonly System.Diagnostics.Stopwatch Sw = System.Diagnostics.Stopwatch.StartNew();
    private static void DbgT(string msg) => Dbg($"[{Sw.ElapsedMilliseconds,5}ms] {msg}");

    private static void Dbg(string msg)
    {
        if (Environment.GetEnvironmentVariable("DSH_AOT_DEBUG") != "1") return;
        // 写文件而不是 stderr：stderr 已被重定向到 fd2 管道，会丢
        try
        {
            var p = Environment.GetEnvironmentVariable("DSH_AOT_DEBUG_FILE")
                    ?? System.IO.Path.Combine(System.IO.Path.GetTempPath(), "aot-runner-trace.log");
            System.IO.File.AppendAllText(p, "[dbg] " + msg + Environment.NewLine);
        }
        catch { }
    }

    private static string BuildCommandLine(string[] argv)
    {
        var sb = new StringBuilder();
        for (var i = 0; i < argv.Length; i++)
        {
            if (i > 0) sb.Append(' ');
            AppendQuoted(sb, argv[i]);
        }
        return sb.ToString();
    }

    /// <summary>按 Windows 命令行解析规则加引号（CommandLineToArgvW 兼容）。</summary>
    private static void AppendQuoted(StringBuilder sb, string arg)
    {
        if (arg.Length > 0 && arg.IndexOfAny(new[] { ' ', '\t', '"' }) < 0)
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

    private static byte[] BuildEnvironmentBlock(Dictionary<string, string> env)
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
        var process = _process;
        var job = _job;

        if (process is not null && !process.IsInvalid && !process.IsClosed)
        {
            if (Native.GetExitCodeProcess(process.DangerousGetHandle(), out var code)
                && code != Native.STILL_ACTIVE)
            {
                DbgT($"target exited code={code}");

                process.Dispose();
                _process = null;
                // RUNNER-SPEC §6.1：投递 target-exit
                PublishResult(new TargetExitResult { ExitCode = (int)code });
                return;
            }
        }

        if (job is not null && !job.IsInvalid && !job.IsClosed && job.IsEmpty())
        {
            job.Dispose();
            _job = null;
            if (_resultDelivered) Finish();
        }
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
            var bytes = Encoding.UTF8.GetBytes(json + "\n");
            _out.Write(bytes, 0, bytes.Length);
            _out.Flush();
        }
        catch
        {
            // host 已断开，忽略
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
    }

    /// <summary>
    /// RUNNER-SPEC §8 / §9 清理顺序：TerminateJob → CloseJob → CloseProcess
    /// 顺序不可调换（架构专家指出：Job 先关会导致子进程逃逸）
    /// </summary>
    private void ReleaseOwnedJob()
    {
        lock (_gate)
        {
            if (_job is not null)
            {
                try { _job.Terminate(1); } catch { }
                try { _job.Dispose(); } catch { }
                _job = null;
            }
            if (_process is not null)
            {
                try { _process.Dispose(); } catch { }
                _process = null;
            }
            if (_thread is not null)
            {
                try { _thread.Dispose(); } catch { }
                _thread = null;
            }
        }
    }
}

/// <summary>按行读取 stdin（不依赖 Console.ReadLine 的编码假设）。</summary>
internal sealed class LineReader
{
    private readonly Stream _stream;
    private readonly List<byte> _buffer = new(4096);

    public LineReader(Stream stream) => _stream = stream;

    public string? ReadLine()
    {
        while (true)
        {
            var b = _stream.ReadByte();
            if (b < 0)
            {
                if (_buffer.Count == 0) return null;
                var tail = Encoding.UTF8.GetString(_buffer.ToArray());
                _buffer.Clear();
                return tail;
            }
            if (b == '\n')
            {
                var line = Encoding.UTF8.GetString(_buffer.ToArray()).TrimEnd('\r');
                _buffer.Clear();
                return line;
            }
            _buffer.Add((byte)b);
        }
    }
}

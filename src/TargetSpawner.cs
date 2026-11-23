// target 进程的启动编排：解析 → 构造 → 继承控制 → CreateProcessW → 入 Job → 放行。
//
// ## 为什么单独成类
//
// 这一整段（约 300 行）是一个**完整的、可独立描述的流程**：把一个 start 请求
// 变成一棵运行中的进程树。它原先属于 JobRunner，而 JobRunner 同时还负责
// 消息泵、退出码轮询、结果投递 —— 三件事的数据没有任何交集。
//
// ## 为什么用 Host 接口而不是直接读字段
//
// 启动过程中有 3 处需要"回到 runner"：报告 spawn 失败、报告 control 缺失、
// 以及结束整个 runner。直接用 JobRunner 的实例字段会让两个类互相依赖；
// 定义成窄接口后，TargetSpawner 不知道自己服务的是谁，测试也可以喂假的 Host。
//
// ## 为什么进程句柄是返回值而不是字段
//
// 原先 LaunchSuspended 直接写 `_process` / `_thread` / `_targetPid`。
// 改成一次性返回 SpawnedProcess 之后，「启动成功」这件事有了单一表达点：
// 返回 null（并已投递错误）= 没启动；返回对象 = 三个句柄都已就绪。
// 中间状态不再可见，也就不会有「句柄写了一半」的窗口。
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace DshAotRunner;

/// <summary>启动成功后三个必须一同存在的句柄。</summary>
internal sealed record SpawnedProcess(SafeKernelHandle Process, SafeKernelHandle Thread, uint Pid);

/// <summary>Spawner 需要 runner 提供的窄接口。只有启动流程用到的东西。</summary>
internal interface ISpawnHost
{
    /// <summary>命令行参数（argv[0] 是程序路径）。</summary>
    IReadOnlyList<string> Argv { get; }

    /// <summary>要执行的程序路径；argv 为空时是 null。</summary>
    string? ProgramName { get; }

    /// <summary>fd → 句柄的解析钩子（测试注入用）。</summary>
    Func<int, IntPtr>? StdioResolveHook { get; }

    /// <summary>control 句柄的解析钩子（测试注入用）。</summary>
    Func<int, IntPtr>? ResolveControlHook { get; }

    /// <summary>报告「可执行文件完全找不到」。</summary>
    void EmitSpawnEnoent(string program);

    /// <summary>报告 CreateProcessW 失败。</summary>
    void EmitCreateProcessError(int win32Code, string program);

    /// <summary>报告 control 通道缺失。</summary>
    void PublishControlMissingError();

    /// <summary>结束 runner（只生效一次）。</summary>
    void Finish();
}

internal sealed class TargetSpawner
{
    private readonly ISpawnHost Host;

    public TargetSpawner(ISpawnHost host) => Host = host;

    /// <summary>
    /// 把 start 请求变成一次真实的进程启动：解析 → 构造 → 继承控制 → 起进程。
    /// </summary>
    /// <remarks>
    /// 这里只保留"顺序"和"任何一步失败就结束"这两件事，每一步自己的细节都在
    /// 各自的方法里。此前它是一个 65 行的方法，读的人要同时跟踪 5 个局部变量的
    /// 生命周期，才能确认第 4 步用的是第 2 步的哪个产物。
    /// </remarks>
    public void Spawn(StartRequest req, SafeJobHandle job, out SpawnedProcess? spawned)
    {
        spawned = null;
        // ---- 1. 命令行 ----
        // CreateProcessW 的第一个参数为 NULL 时，用命令行首 token 查找可执行文件。
        // 若该 token 不含路径分隔符且不在 PATH 中，会返回 ERROR_FILE_NOT_FOUND(2)。
        // 所以这里先解析成绝对路径，不依赖 CreateProcessW 自己的搜索策略。
        string cmdline;
        using (Trace.Measure("build-cmdline")) cmdline = ExecutableResolver.BuildCommandLine([.. Host.Argv]);

        // argv 为空时没有"要找的程序"，ProgramName 为 null；
        // 统一收窄成空串，后续查找与错误文案都基于同一个值。
        var program = Host.ProgramName ?? string.Empty;

        string? appName;
        using (Trace.Measure("resolve-exe")) appName = ExecutableResolver.ResolveExecutable(program, req.Cwd, req.Env);
        if (appName is null)
        {
            // 与 node 一致：候选全部不存在 → ENOENT，文本对齐 libuv/Node 的 spawn 错误
            Host.EmitSpawnEnoent(program);
            Host.Finish();
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
            req, job, appName, cmdline, envBlock, stdio, hControl, inheritToggled, program), out spawned);

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

        if (controlRequested && !ProcessLauncher.IsValid(hControl))
        {
            Host.PublishControlMissingError();
            return false;
        }

        inheritToggled = ProcessLauncher.EnableInheritanceFor(
            ProcessLauncher.CollectTargetHandles(stdio, controlRequested, hControl));
        return true;
    }

    /// <summary>
    /// 解析 control channel 句柄；未请求 control 时返回无效值。
    /// </summary>
    private IntPtr ResolveControlHandle(bool controlRequested) =>
        controlRequested
            ? (Host.ResolveControlHook ?? DefaultResolveControl)(CrtDescriptorTable.ControlFileDescriptor)
            : IntPtr.Zero;

    private static IntPtr DefaultResolveControl(int fd) => Native.CrtGetOsFHandle(fd);

    /// <summary>
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
        List<(IntPtr Handle, bool WasInheritable)> InheritToggled,
        string ProgramName);

    private void LaunchWithDescriptorTable(LaunchPlan plan, out SpawnedProcess? spawned)
    {
        spawned = null;
        // CRT 描述符表：只有 control 请求时才需要（其余情况走默认标准句柄表）
        var descriptorTable = CrtDescriptorTable.Encode(
            plan.Stdio.In, plan.Stdio.Out, plan.Stdio.Err, plan.ControlHandle);
        var descriptorPtr = IntPtr.Zero;
        if (descriptorTable is not null)
        {
            descriptorPtr = Marshal.AllocHGlobal(descriptorTable.Length);
            Marshal.Copy(descriptorTable, 0, descriptorPtr, descriptorTable.Length);
        }

        var si = ProcessLauncher.BuildStartupInfo(plan.Stdio, descriptorTable, descriptorPtr);
        try
        {
            LaunchProcess(plan, si, out spawned);
        }
        finally
        {
            if (descriptorPtr != IntPtr.Zero) Marshal.FreeHGlobal(descriptorPtr);
        }
    }

    /// <summary>target 的三个 stdio 句柄。</summary>
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
    private StdioHandles ResolveStdioHandles()
    {
        var resolve = Host.StdioResolveHook ?? Native.CrtGetOsFHandle;
        var raw = new StdioHandles(resolve(4), resolve(5), resolve(6));

        // 每个句柄独立回退：某一位不可用时退回本进程对应的标准句柄。
        var effective = new StdioHandles(
            FallBackToStdHandle(raw.In, Native.STD_INPUT_HANDLE),
            FallBackToStdHandle(raw.Out, Native.STD_OUTPUT_HANDLE),
            FallBackToStdHandle(raw.Err, Native.STD_ERROR_HANDLE));

        LogStdioResolution(raw, effective);
        WarnIfAnyMissing(raw);
        return effective;
    }

    /// <summary>句柄有效则原样返回，否则退回本进程的某个标准句柄。</summary>
    /// <remarks>
    /// NUL 陷阱（Issue #11 实测发现）：真实 host 布局下本进程的 fd 0/1/2 是
    /// NUL 字符设备 —— 句柄有效，写入永远"成功"但内容丢弃。
    /// 若把它们当默认值传给 target，target 的输出会**静默消失**，
    /// 调用方拿到空输出却没有任何报错。所以这里只退到标准句柄并**记录**，
    /// 由 <see cref="WarnIfAnyMissing"/> 显式告警。
    /// </remarks>
    private static IntPtr FallBackToStdHandle(IntPtr handle, int stdHandleId) =>
        ProcessLauncher.IsValid(handle) ? handle : Native.GetStdHandle(stdHandleId);

    /// <summary>记录 fd 4/5/6 → 实际句柄的解析结果与文件类型。</summary>
    private static void LogStdioResolution(StdioHandles raw, StdioHandles effective)
    {
        Trace.Write($"stdio: fd4=0x{raw.In.ToInt64():X} fd5=0x{raw.Out.ToInt64():X} fd6=0x{raw.Err.ToInt64():X}"
                    + $" type4={Native.GetFileType(raw.In)} type5={Native.GetFileType(raw.Out)} type6={Native.GetFileType(raw.Err)}"
                    + $" -> in=0x{effective.In.ToInt64():X} out=0x{effective.Out.ToInt64():X} err=0x{effective.Err.ToInt64():X}");
    }

    /// <summary>fd 4/5/6 有任何一位缺失时告警：target 会继承本进程标准句柄，输出可能进 NUL。</summary>
    private static void WarnIfAnyMissing(StdioHandles raw)
    {
        if (ProcessLauncher.IsValid(raw.In) && ProcessLauncher.IsValid(raw.Out) && ProcessLauncher.IsValid(raw.Err))
            return;

        Trace.Write("stdio: WARNING fd4/5/6 缺失，target 将继承本进程标准句柄（输出可能进入 NUL）");
    }

    /// <summary>「control 通道未继承」的错误结果（host 侧契约违约）。</summary>
    /// <remarks>
    /// 这条错误必须存在且文案明确：host 声明了 control 却没传 fd 7 时，
    /// 若静默降级成「无 control」，target 会永远等一条不存在的通道 ——
    /// 表现为随机挂起，比明确报错难查得多。
    /// </remarks>
    /// <summary>Job Object 创建失败的错误结果。</summary>
    /// <summary>CreateProcessW 抛异常时的错误结果（带 path）。</summary>


    /// <summary>
    /// 调用 CreateProcessW 并完成 Job 入队、线程放行、句柄继承恢复。
    ///
    /// RUNNER-SPEC §5.3 步骤 3~5。任何一步失败都会 emit 错误并 Finish()。
    /// </summary>
    private void LaunchProcess(LaunchPlan plan, Native.STARTUPINFO si, out SpawnedProcess? spawned)
    {
        spawned = null;
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
                LaunchSuspended(plan, si, envPtr, cwd, flags, out spawned);
            }
            finally
            {
                ProcessLauncher.RestoreInheritance(plan.InheritToggled);
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
    private void LaunchSuspended(LaunchPlan plan, Native.STARTUPINFO si, IntPtr envPtr, string? cwd, uint flags, out SpawnedProcess? spawned)
    {
        spawned = null;
        var start = new ProcessStartup(plan.AppName, plan.Cmdline, envPtr, cwd, flags, plan.ProgramName);
        if (!CreateSuspendedProcess(start, si, out var pi))
        {
            Host.Finish();
            return;
        }

        spawned = new SpawnedProcess(
            new SafeKernelHandle(pi.hProcess), new SafeKernelHandle(pi.hThread), pi.dwProcessId);
        Trace.Timed($"CreateProcessW ok, pid={pi.dwProcessId}");

        // 步骤 4：先入 Job。
        // 无条件执行 —— 曾经有一个 DSH_AOT_NOJOB=1 实验开关用来诊断，
        // 但实测它会让 terminate 失效、target 进程树泄漏，属于生产路径上的
        // 定时炸弹，已移除。Job 隔离是本 runner 的核心契约，不可绕过。
        plan.Job.AssignProcess(pi.hProcess);
        Trace.Timed("AssignProcessToJobObject ok");

        // 步骤 5：再放行。
        if (!ResumeThread(pi.hThread)) return;
        Trace.Timed("ResumeThread ok");

        // 注：DSH 的 runner.js 会在 spawn 后 closeSync(4/5/6/7) 关闭自己的副本。
        // AOT 版暂不照做 —— 现有 24 项 A/B 在不关的情况下已与 node 行为一致，
        // 贸然改动会影响已稳定的输出通道语义。见 Issue #2 的后续评估。
    }


    /// <summary>
    /// 一次 CreateProcessW 调用的全部入参。
    ///
    /// 收成一个结构而不是 8 个位置参数：Win32 的这几个参数里
    /// envPtr / cwd / flags 全是非托管资源或位标志，位置传错**不会报错**，
    /// 只会表现成难以定位的行为差异（例如 cwd 传成正斜杠 → ERROR_INVALID_PARAMETER）。
    /// 具名字段让每个值在调用点都能被读出含义。
    /// </summary>
    private readonly record struct ProcessStartup(
        string AppName,
        string Cmdline,
        IntPtr EnvPtr,
        string? Cwd,
        uint Flags,
        string Program);

    /// <summary>CreateProcessW 封装；失败时按 node 的 errno 文本 emit 错误。</summary>
    private bool CreateSuspendedProcess(
        ProcessStartup start, Native.STARTUPINFO si, out Native.PROCESS_INFORMATION pi)
    {
        var ok = Native.CreateProcessW(start.AppName, start.Cmdline, IntPtr.Zero, IntPtr.Zero,
            bInheritHandles: true, dwCreationFlags: start.Flags,
            lpEnvironment: start.EnvPtr, lpCurrentDirectory: start.Cwd,
            ref si, out pi);
        if (ok) return true;

        // 对齐 node 的 asSpawnError：把 Win32 码翻成 Node errno 文本，
        // 而不是自创 "CreateProcessW failed for ..." 这类消息。
        Host.EmitCreateProcessError(Marshal.GetLastWin32Error(), start.Program);
        return false;
    }

    /// <summary>
    /// 放行挂起的 target 线程。
    ///
    /// ResumeThread 失败时返回 0xFFFFFFFF，必须检查 —— 不检查的话线程永远挂起，
    /// target 静默不执行，而我们却在等一个永远不会出现的退出码，
    /// 外部表现为「调用卡住」。
    /// </summary>
    private bool ResumeThread(IntPtr hThread) =>
        ResumeThreadCore(hThread, resumeThread: null, lastError: null);

    /// <summary>
    /// 放行线程的判定与失败处理，带测试接缝。
    /// </summary>
    /// <remarks>
    /// 真实的 ResumeThread 失败需要线程句柄被外部破坏，几乎无法复现；
    /// 但这段逻辑一旦写错后果很严重（线程永远挂起 → 调用方卡死在永不出现的退出码上）。
    /// 通过 <paramref name="resumeThread"/> / <paramref name="lastError"/> 注入，
    /// 就能把「失败必须报错并结束」这条支路钉住。
    /// </remarks>
    internal bool ResumeThreadCore(
        IntPtr hThread,
        Func<IntPtr, uint>? resumeThread,
        Func<int>? lastError)
    {
        if (ProcessLauncher.ResumeSuspendedThread(hThread, out var resumeError, resumeThread, lastError))
            return true;

        Host.EmitCreateProcessError(resumeError, Host.ProgramName ?? string.Empty);
        Host.Finish();
        return false;
    }
}

/// <summary>target 的三个 stdio 句柄。独立成类型：ProcessLauncher 与 Spawner 共用。</summary>
internal readonly record struct StdioHandles(IntPtr In, IntPtr Out, IntPtr Err);

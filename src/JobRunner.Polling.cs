// 退出检测 —— 「target 什么时候算结束、结果该按什么形态投递」的全部规则。
//
// 为什么从 JobRunner.cs 拆出来：这是一个**完整的状态机**，不是零散的辅助方法。
// 它自己维护一条生命周期：挂起创建 → 运行 → job 变空 → 投递 exit 结果 → 停止轮询。
// 此前它和「启动/命令行/环境块/句柄继承」挤在同一个文件里，导致读代码的人必须
// 在 1200 行里来回跳才能回答「结果到底在哪一步被写出去」。
//
// 拆分为 partial 而不是另建一个类型：轮询与主循环共享 <c>_gate</c>、<c>_finished</c>、
// <c>_process</c>、<c>_job</c> 这几个字段，且读写时序有明确约束
// （见 ShouldStopPolling 的注释）。把它们包成一个单独的类会引入一次
// 额外的所有权问题，却换不到任何隔离收益 —— 这个状态机本来就必须和
// 主循环看到同一份状态。partial 让「同一个对象、不同的关注点」在文件层面可见。
using System.Collections.Concurrent;

namespace DshAotRunner;

internal sealed partial class JobRunner
{
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
}

// 内核句柄的按序释放 —— RUNNER-SPEC §8 / §9 的清理规则。
//
// 为什么独立成类：释放顺序是**协议契约**，不是随手写的清理代码。
// TerminateJob → CloseJob → CloseProcess 顺序不可调换 ——
// Job 先关会让子进程逃逸出作业对象，于是 target 的整棵进程树在 runner 退出后
// 留在系统里（Issue #3 的同类问题）。
//
// 把它放在一个不认识 JobRunner 的类里，是为了让这条顺序规则**只有一处**，
// 且能被单独读到。三个句柄的释放形状完全一致（前置动作 + Dispose + 吞异常），
// 所以收敛成一处泛型实现 —— 少掉的重复正好也是原先的复杂度来源。
namespace DshAotRunner;

/// <summary>按 RUNNER-SPEC §8/§9 的顺序释放 runner 拥有的内核句柄。</summary>
internal static class ResourceReleaser
{
    /// <summary>
    /// 依次释放 job、process、thread。顺序固定，不可调换。
    /// </summary>
    /// <remarks>
    /// 用 <c>ref</c> 参数原地置 null，让调用方不必写三遍赋值。
    /// 返回后三个字段一定都是 null —— 重复调用是安全的。
    /// </remarks>
    internal static void ReleaseAll(
        ref SafeJobHandle? job,
        ref SafeKernelHandle? process,
        ref SafeKernelHandle? thread)
    {
        job = Release(job, static j => j.Terminate(1));
        process = Release(process, static _ => { });
        thread = Release(thread, static _ => { });
    }

    /// <summary>
    /// 释放一个可选句柄：先执行 <paramref name="beforeDispose"/>，再 Dispose，
    /// 任何异常都吞掉，最后返回 null。
    /// </summary>
    /// <remarks>
    /// 清理路径不该因为单个句柄失败而中断 —— 若 Terminate 抛异常就不关 Job，
    /// 泄漏的正是我们最不想要的东西。所以两个动作各自 try/catch，互不影响。
    /// </remarks>
    internal static T? Release<T>(T? handle, Action<T> beforeDispose) where T : class, IDisposable
    {
        if (handle is null) return null;
        try { beforeDispose(handle); } catch { }
        try { handle.Dispose(); } catch { }
        return null;
    }
}

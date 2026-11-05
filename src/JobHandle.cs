// Win32 句柄安全封装 —— 回应架构专家/技术专家指出的 GC Finalizer 风险
using Microsoft.Win32.SafeHandles;
using System.Runtime.InteropServices;

namespace DshAotRunner;

/// <summary>Job Object 句柄。派生 SafeHandle 保证不会被 GC 提前回收。</summary>
internal sealed class SafeJobHandle : SafeHandleZeroOrMinusOneIsInvalid
{
    // CA1419：SafeHandle 的派生类型的无参构造函数必须与类型本身一样可见，
    // 否则运行时无法通过反射创建继承者的实例（安全关键路径会失败）。
    // 这里把构造函数开放为 public，实例仍只经 Create() 产生。
    public SafeJobHandle() : base(true) { }

    public static SafeJobHandle Create()
    {
        var raw = Native.CreateJobObjectW(IntPtr.Zero, null);
        if (raw == IntPtr.Zero || raw == new IntPtr(-1))
            throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateJobObjectW failed");
        var handle = new SafeJobHandle();
        handle.SetHandle(raw);
        return handle;
    }

    /// <summary>设置 KILL_ON_JOB_CLOSE：句柄关闭时整树终止（防 #1527 进程堆积）。</summary>
    public void EnableKillOnClose()
    {
        var info = new Native.JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        info.BasicLimitInformation.LimitFlags = Native.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        var size = (uint)Marshal.SizeOf<Native.JOBOBJECT_EXTENDED_LIMIT_INFORMATION>();
        if (!Native.SetInformationJobObject(handle, Native.JobObjectExtendedLimitInformation, ref info, size))
            throw new Win32Exception(Marshal.GetLastWin32Error(), "SetInformationJobObject failed");
    }

    public void AssignProcess(IntPtr processHandle)
    {
        if (!Native.AssignProcessToJobObject(handle, processHandle))
            throw new Win32Exception(Marshal.GetLastWin32Error(), "AssignProcessToJobObject failed");
    }

    public void Terminate(uint exitCode)
    {
        if (!Native.TerminateJobObject(handle, exitCode))
        {
            // 清理路径吞掉异常：terminate 与退出竞态，失败不应掩盖已有结果
        }
    }

    /// <summary>Job 是否已无活跃进程。</summary>
    /// <remarks>
    /// 查询失败时返回 false（保守：当作「可能还有进程」），这个选择本身没问题；
    /// 问题在于查询曾**总是**失败，于是 IsEmpty() 恒为 false、
    /// <see cref="JobRunner"/> 里「job 空了就收尾」那条路径从未生效过。
    /// 两处成因都已修好：
    ///   1. 传的是裸数字 8（BasicAndIoAccountingInformation，要 96 字节缓冲区）
    ///      而非 BasicAccountingInformation(1)，每次都返回 ERROR_BAD_LENGTH；
    ///   2. <see cref="Native.QueryInformationJobObject"/> 的声明漏了
    ///      lpReturnLength 参数，调用恒定失败。
    /// 由 <c>JobHandleTests</c> 用「有活进程时不为空 / 退出后变空」两端守住。
    /// </remarks>
    public bool IsEmpty()
    {
        if (!Native.QueryInformationJobObject(handle, Native.JobObjectBasicAccountingInformation,
                out var acct, (uint)Marshal.SizeOf<Native.JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>(),
                out _))
            return false;
        return acct.ActiveProcesses == 0;
    }

    protected override bool ReleaseHandle()
    {
        return Native.CloseHandle(handle);
    }
}

/// <summary>普通内核句柄（进程/线程/管道）。</summary>
internal sealed class SafeKernelHandle : SafeHandleZeroOrMinusOneIsInvalid
{
    public SafeKernelHandle() : base(true) { }
    public SafeKernelHandle(IntPtr existing) : base(true) { SetHandle(existing); }
    protected override bool ReleaseHandle() => Native.CloseHandle(handle);
}

internal sealed class Win32Exception : Exception
{
    public int ErrorCode { get; }
    public Win32Exception(int code, string message) : base($"{message} (GetLastError={code})")
    {
        ErrorCode = code;
    }
}

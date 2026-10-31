// Win32 句柄安全封装 —— 回应架构专家/技术专家指出的 GC Finalizer 风险
using Microsoft.Win32.SafeHandles;
using System.Runtime.InteropServices;

namespace DshAotRunner;

/// <summary>Job Object 句柄。派生 SafeHandle 保证不会被 GC 提前回收。</summary>
internal sealed class SafeJobHandle : SafeHandleZeroOrMinusOneIsInvalid
{
    private SafeJobHandle() : base(true) { }

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
    public bool IsEmpty()
    {
        if (!Native.QueryInformationJobObject(handle, 8 /* BasicAccountingInformation */,
                out var acct, (uint)Marshal.SizeOf<Native.JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>()))
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

// Win32 进程启动原语：句柄继承开关、STARTUPINFO 构造、CreateProcessW 调用。
//
// 为什么单独成类：这 4 个方法全部是 **static 纯函数** —— 不读任何实例字段，
// 只做「把一组句柄/环境块/命令行交给 Win32」这一件事。它们原先挂在
// JobRunner 上，让那个类看起来有 45 个方法（god-class / srp 告警）。
//
// 抽出来的额外好处不是「行数变少」，而是**可测性**：这些函数现在可以不构造
// 整个 JobRunner 就被直接调用。它们守的是 Win32 的隐式契约（句柄必须可继承、
// cbReserved2 是 WORD 不能回绕），正是最该被单独钉住的部分。
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

namespace DshAotRunner;

/// <summary>CreateProcessW 的启动原语。全部 static，无实例状态。</summary>
internal static class ProcessLauncher
{
    /// <summary>收集需要放行继承的句柄集合（control 可选）。</summary>
    internal static IntPtr[] CollectTargetHandles(StdioHandles stdio, bool controlRequested, IntPtr hControl) =>
        controlRequested
            ? new[] { stdio.In, stdio.Out, stdio.Err, hControl }
            : new[] { stdio.In, stdio.Out, stdio.Err };

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
    internal static List<(IntPtr Handle, bool WasInheritable)> EnableInheritanceFor(IntPtr[] targetHandles)
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
    internal static Native.STARTUPINFO BuildStartupInfo(
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
    /// 把 <see cref="EnableInheritanceFor"/> 改过的继承标志恢复原样。
    /// </summary>
    /// <remarks>
    /// 必须无条件执行（放在 finally 里）：CreateProcessW 一旦返回，这些标志就没有
    /// 用处了，留着会让 runner 后续创建的 target 继承本不该继承的句柄。
    /// </remarks>
    internal static void RestoreInheritance(List<(IntPtr Handle, bool WasInheritable)> toggled)
    {
        foreach (var (handle, wasInheritable) in toggled)
        {
            if (!wasInheritable)
                Native.SetHandleInformation(handle, Native.HANDLE_FLAG_INHERIT, 0);
        }
    }

    /// <summary>Win32 句柄有效性判定：0（NULL）与 -1（INVALID_HANDLE_VALUE）都算无效。</summary>
    internal static bool IsValid(IntPtr h) => h != IntPtr.Zero && h != new IntPtr(-1);

    /// <summary>
    /// 放行 CREATE_SUSPENDED 挂起的 target 线程。返回 false 表示失败。
    ///
    /// ResumeThread 失败时返回 0xFFFFFFFF，必须检查 —— 不检查的话线程永远挂起，
    /// target 静默不执行，而我们却在等一个永远不会出现的退出码，
    /// 外部表现为「调用卡住」。
    ///
    /// 判定逻辑放在这里而不是各调用方，是为了让 JobRunner 与 TargetSpawner
    /// **共用同一份实现**：两份实现只有一份被测试覆盖，是覆盖率骗局的经典来源。
    /// <paramref name="resumeThread"/> / <paramref name="lastError"/> 是测试接缝 ——
    /// 真实的 ResumeThread 失败需要线程句柄被外部破坏，几乎无法复现。
    /// </summary>
    internal static bool ResumeSuspendedThread(
        IntPtr hThread,
        out int errorCode,
        Func<IntPtr, uint>? resumeThread = null,
        Func<int>? lastError = null)
    {
        var suspendCount = (resumeThread ?? Native.ResumeThread)(hThread);
        if (suspendCount != Native.RESUME_THREAD_FAILED)
        {
            errorCode = 0;
            return true;
        }

        errorCode = (lastError ?? Marshal.GetLastWin32Error)();
        // ERROR_NOT_SUSPENDED 说明线程已经是运行态，不是失败
        return errorCode == Native.ERROR_NOT_SUSPENDED;
    }
}

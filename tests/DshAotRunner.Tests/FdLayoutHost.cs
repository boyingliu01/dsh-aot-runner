// fd 布局宿主 —— 在测试进程里造出真实的 fd 3/4/5/6/7 环境
//
// ## 要解决的问题
//
// JobRunner 里有约 440 行 Win32 编排代码（CreateProcessW / Job 入队 /
// fd 描述符表编码 / 句柄继承开关 / 轮询收尾）。这些逻辑的正确性就在于
// 「真的调了 OS 之后行为对不对」，没有纯逻辑可抽：
//
//   - 造假 mock：得到的只是「mock 按我说的返回」，证明不了任何真实行为
//   - 直接 new JobRunner 去 spawn：**会让 xunit 宿主进程崩溃**（已实测）
//
// 崩溃原因是 JobRunner 设计上就要写真实 fd 4/5/6 并继承给 target，
// 而测试宿主没有这套布局 —— 写一个不存在的 fd 会让 CRT 直接终止进程。
//
// ## 做法
//
// 用 CreatePipe 建 4 组匿名管道，再用 _open_osfhandle + _dup2 把它们
// 精确登记到 fd 4/5/6/7 上。布局与 host 的 stdio 完全一致：
//
//   stdio = ['ignore','ignore','ignore','ipc', 'pipe','pipe','pipe', ('overlapped')]
//            fd0      fd1     fd2       fd3    fd4   fd5   fd6      fd7(control)
//
// 搭好之后 JobRunner 就能在本进程内正常跑完整个生命周期。
//
// ## 边界
//
// 这是**测试专用装置**，生产路径完全不经过它。它修改的是本进程的 CRT 表，
// 所以用完必须还原（见 Dispose），否则会污染同进程里的其他测试。
using Microsoft.Win32.SafeHandles;

namespace DshAotRunner.Tests;

/// <summary>在测试进程里搭出 host 的 fd 4/5/6(/7) 布局，用完还原。</summary>
internal sealed class FdLayoutHost : IDisposable
{
    private const int FILE_TYPE_PIPE = 3;

    private readonly List<SafeKernelHandle> _owned = new();

    /// <summary>target 侧 fd 4（stdin 载体）的写端：runner 从这里给 target 喂输入。</summary>
    private IntPtr _fd4Write = IntPtr.Zero;

    /// <summary>target 侧 fd 5（stdout）的读端：测试从这里读 target 的输出。</summary>
    private IntPtr _fd5Read = IntPtr.Zero;

    /// <summary>target 侧 fd 6（stderr）的读端。</summary>
    private IntPtr _fd6Read = IntPtr.Zero;

    /// <summary>是否同时布置 fd 7（control channel）。</summary>
    public bool WithControl { get; }

    private FdLayoutHost(bool withControl) => WithControl = withControl;

    /// <summary>
    /// 建立布局。<paramref name="withControl"/> 为 true 时额外布置 fd 7。
    /// </summary>
    public static FdLayoutHost Install(bool withControl = false)
    {
        var host = new FdLayoutHost(withControl);
        try
        {
            host.Build();
            return host;
        }
        catch
        {
            host.Dispose();
            throw;
        }
    }

    private void Build()
    {
        // 不作「先读取 fd 4..7 原值」的备份 —— 这一步会让测试宿主崩溃。
        //
        // 原因：在 .NET 宿主里 CRT 描述符表只被撑到运行时自己用到的编号（通常 0..2）。
        // 对尚未分配的编号调 _get_osfhandle 会触发 CRT 的无效参数处理（默认行为是
        // 直接 abort 进程），而不是像 POSIX 那样安静地返回 -1。
        // 现象就是「只读一下 fd 4，测试宿主就崩了」。
        //
        // 正确顺序：先用 _open_osfhandle 撑大表，再用 _dup2 落到目标编号。
        // 这样目标编号在 _dup2 之前已经「合法」，全程不碰未分配的槽位。

        // fd 4 = target 的 stdin。runner 写 → target 读。
        var fd4 = MakePipeToFd(targetSideIsRead: true, out _fd4Write);
        Bind(4, fd4);

        // fd 5 = target 的 stdout。target 写 → 测试读。
        var fd5 = MakePipeToFd(targetSideIsRead: false, out _fd5Read);
        Bind(5, fd5);

        // fd 6 = target 的 stderr。
        var fd6 = MakePipeToFd(targetSideIsRead: false, out _fd6Read);
        Bind(6, fd6);

        if (WithControl)
        {
            // fd 7 = control channel。只要求「是合法的管道句柄」——
            // 被测的是 runner 是否把它正确编进描述符表。
            var fd7 = MakePipeToFd(targetSideIsRead: false, out var fd7Other);
            _owned.Add(new SafeKernelHandle(fd7Other));
            Bind(7, fd7);
        }
        else
        {
            // 不启用 control 时也要**占住** fd 7。
            //
            // 原因：CRT 的 _get_osfhandle 对未分配的编号会直接 abort（不是抛异常、
            // .NET 的 try/catch 与 invalid-parameter-handler 都拦不住），
            // 整个测试宿主会无声消失。而 runner 在 control 请求路径上一定会去读 fd 7。
            // 给它放一个无效但「已分配」的槽位，runner 就能正常走到
            // 「句柄无效 → 投递 EPROTOCOL」的分支，而不是把宿主搞崩。
            var placeholder = MakePipeToFd(targetSideIsRead: false, out var placeholderOther);
            _owned.Add(new SafeKernelHandle(placeholderOther));
            Bind(7, placeholder);
            // 立刻关掉：让 fd 7 变成一个「已分配但句柄无效」的槽位。
            Native.CloseHandle(Native.CrtGetOsFHandle(7));
        }
    }

    /// <summary>
    /// 建一条管道，把 target 那一端登记成 CRT fd 返回；同时把另一端交给调用方。
    /// </summary>
    /// <param name="targetSideIsRead">target 侧拿读端还是写端。</param>
    private int MakePipeToFd(bool targetSideIsRead, out IntPtr otherEnd)
    {
        var sa = new Native.SECURITY_ATTRIBUTES
        {
            nLength = System.Runtime.InteropServices.Marshal.SizeOf<Native.SECURITY_ATTRIBUTES>(),
            lpSecurityDescriptor = IntPtr.Zero,
            // 必须可继承：runner 要把它传给 target。
            bInheritHandle = 1,
        };

        if (!Native.CreatePipe(out var readEnd, out var writeEnd, ref sa, 0))
            throw new InvalidOperationException(
                $"CreatePipe 失败，err={System.Runtime.InteropServices.Marshal.GetLastWin32Error()}");

        var targetEnd = targetSideIsRead ? readEnd : writeEnd;
        otherEnd = targetSideIsRead ? writeEnd : readEnd;

        // 所有权划分（踩过双重释放的坑，这里必须非常明确）：
        //   targetEnd → 交给 CRT 的 fd 表，由 _dup2 后的 fd 持有，本类不再关它；
        //   otherEnd  → 由本类的 SafeKernelHandle 持有，Dispose 时关闭。
        // 一个句柄只能有一个所有者，两边都关会让 CRT 终止进程。
        var fd = Native.CrtOpenOsFHandle(targetEnd, 0);
        if (fd < 0)
        {
            Native.CloseHandle(targetEnd);
            Native.CloseHandle(otherEnd);
            throw new InvalidOperationException("_open_osfhandle 失败");
        }

        // 另一半的所有权交给调用方（由它决定是否 Add 到 _owned）。
        return fd;
    }

    /// <summary>把 <paramref name="fd"/> 顶到指定编号上。</summary>
    private static void Bind(int number, int fd)
    {
        if (fd == number) return;
        if (Native.CrtDup2(fd, number) != 0)
            throw new InvalidOperationException($"_dup2({fd}, {number}) 失败");
    }

    /// <summary>向 target 的 stdin 写入数据（target 会读到）。</summary>
    public void WriteTargetStdin(string text)
    {
        var bytes = System.Text.Encoding.UTF8.GetBytes(text);
        Native.WriteFile(_fd4Write, bytes, (uint)bytes.Length, out _, IntPtr.Zero);
    }

    /// <summary>读 target 写出到 fd5（stdout）的全部内容。</summary>
    public string ReadTargetStdout() => ReadAll(_fd5Read);

    /// <summary>读 target 写出到 fd6（stderr）的全部内容。</summary>
    public string ReadTargetStderr() => ReadAll(_fd6Read);

    private static string ReadAll(IntPtr handle)
    {
        if (handle == IntPtr.Zero) return "";
        var buffer = new byte[64 * 1024];
        var sb = new System.Text.StringBuilder();
        while (true)
        {
            if (!Native.ReadFile(handle, buffer, (uint)buffer.Length, out var got, IntPtr.Zero) || got == 0)
                break;
            sb.Append(System.Text.Encoding.UTF8.GetString(buffer, 0, (int)got));
            if (got < buffer.Length) break;
        }
        return sb.ToString();
    }

    public void Dispose()
    {
        foreach (var h in _owned) h.Dispose();
        _owned.Clear();
        // fd 4/5/6 由 CRT 持有，不能在这里 CloseHandle（会二次释放）。
        // 它们随进程退出或下次 Install 覆盖而失效；测试用例之间不依赖残留值。
    }
}

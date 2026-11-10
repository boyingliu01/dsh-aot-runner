// Win32 P/Invoke 声明 —— 对齐 RUNNER-SPEC.md §5.1
using System.Runtime.InteropServices;

// 所有 P/Invoke 目标都是系统 DLL（kernel32/advapi32 等），显式限定只在
// System32 里搜索，关掉「按 PATH 顺序找 DLL」的劫持面（CA5392，本文件 21 处）。
//
// 写成**程序集级**声明而不是在每个 [DllImport] 上加 DefaultDllImportSearchPaths：
// 21 处逐个写，迟早有新增的 P/Invoke 忘记加，而漏掉一处就等于整条防线破了。
// 一行覆盖全部，且新增的 DllImport 自动继承。
//
// 为什么这条值得修：本项目是进程管理工具，判为「资源泄漏」的 CA2000/CA2213
// 实测下来要么误报、要么是进程级流不可 Dispose；真正有运行时安全意义的
// 反而是这个加载路径问题。
[assembly: DefaultDllImportSearchPaths(DllImportSearchPath.System32)]

namespace DshAotRunner;

internal static class Native
{
    // ---- 常量（abi.d.ts 佐证，见 RUNNER-SPEC §5.2）----
    public const uint CREATE_SUSPENDED = 0x00000004;
    public const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
    public const uint CREATE_NO_WINDOW = 0x08000000;
    public const int STARTF_USESTDHANDLES = 0x00000100;
    public const int STARTF_USESHOWWINDOW = 0x00000001;
    public const short SW_HIDE = 0;
    public const uint HANDLE_FLAG_INHERIT = 0x00000001;
    public const uint INFINITE = 0xFFFFFFFF;
    public const uint WAIT_TIMEOUT = 258;
    public const uint WAIT_OBJECT_0 = 0;

    // JOBOBJECTINFOCLASS 编号（winnt.h）。
    // 这两个值曾被写错：BasicAccountingInformation 是 **1**，不是 8。
    // 8 是 BasicAndIoAccountingInformation，要求 96 字节的输出缓冲区；
    // 只传 48 字节时 QueryInformationJobObject 返回 ERROR_BAD_LENGTH(24)，
    // 调用方把「查询失败」当成「job 非空」，于是 IsEmpty() 永远返回 false。
    // 用命名常量而不是裸数字，避免同一个坑再踩第二次。
    public const int JobObjectBasicAccountingInformation = 1;
    public const int JobObjectExtendedLimitInformation = 9;
    public const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;

    public const uint STILL_ACTIVE = 259;
    public const int ERROR_BROKEN_PIPE = 109;
    /// <summary>
    /// ERROR_PIPE_NOT_CONNECTED —— 管道未连接。
    /// </summary>
    /// <remarks>
    /// 这是 <b>host detach 之后读管道真正会拿到</b>的错误码，与
    /// <see cref="ERROR_NO_DATA"/>(232) 是不同的码。
    /// 该常量早就存在，但 <see cref="IpcChannel.IsEndOfStream"/> 曾只判 232 而没判它 ——
    /// 等于守门人认错了人。现已一并纳入，且有单测逐个错误码断言。
    /// </remarks>
    public const int ERROR_PIPE_NOT_CONNECTED = 233;

    /// <summary>ERROR_NOT_SUSPENDED —— 线程本来就处于运行态，不是 ResumeThread 失败。</summary>
    public const int ERROR_NOT_SUSPENDED = 267;

    /// <summary>ResumeThread 的失败返回值（同时也是「调用前挂起计数」的哨兵值）。</summary>
    public const uint RESUME_THREAD_FAILED = 0xFFFFFFFF;

    [StructLayout(LayoutKind.Sequential)]
    internal struct SECURITY_ATTRIBUTES
    {
        public int nLength;
        public IntPtr lpSecurityDescriptor;
        public int bInheritHandle;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct STARTUPINFO
    {
        public int cb;
        public IntPtr lpReserved;
        public IntPtr lpDesktop;
        public IntPtr lpTitle;
        public int dwX;
        public int dwY;
        public int dwXSize;
        public int dwYSize;
        public int dwXCountChars;
        public int dwYCountChars;
        public int dwFillAttribute;
        public int dwFlags;
        public short wShowWindow;
        public short cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct PROCESS_INFORMATION
    {
        public IntPtr hProcess;
        public IntPtr hThread;
        public int dwProcessId;
        public int dwThreadId;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct IO_COUNTERS
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    // ---- kernel32 ----
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern IntPtr CreateJobObjectW(IntPtr lpJobAttributes, string? lpName);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool SetInformationJobObject(IntPtr hJob, int jobObjectInformationClass,
        ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION lpJobObjectInformation, uint cbJobObjectInformationLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool TerminateJobObject(IntPtr hJob, uint uExitCode);

    // QueryInformationJobObject 的第 5 个参数 lpReturnLength **不可省略**。
    //
    // 这不只是「规范上应该有」—— 实测（Windows 11 / .NET 8）省略它时
    // 调用恒定返回 FALSE, GetLastError=998(ERROR_NOACCESS)；补上（哪怕是
    // IntPtr.Zero）就成功。原生 API 里它确实是指针参数，但 Win32 的实现
    // 会按 5 参数 ABI 读取它，4 参数声明把栈/寄存器布局错开了一位。
    //
    // 这个错误曾被上层 IsEmpty() 掩盖成「job 永远非空」，功能上是静默失效。
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool QueryInformationJobObject(IntPtr hJob, int jobObjectInformationClass,
        out JOBOBJECT_BASIC_ACCOUNTING_INFORMATION lpJobObjectInformation,
        uint cbJobObjectInformationLength, out uint lpReturnLength);

    [StructLayout(LayoutKind.Sequential)]
    internal struct JOBOBJECT_BASIC_ACCOUNTING_INFORMATION
    {
        public long TotalUserTime;
        public long TotalKernelTime;
        public long ThisPeriodTotalUserTime;
        public long ThisPeriodTotalKernelTime;
        public uint TotalPageFaultCount;
        public uint TotalProcesses;
        public uint ActiveProcesses;
        public uint TotalTerminatedProcesses;
    }

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern bool CreateProcessW(
        string? lpApplicationName,
        string lpCommandLine,
        IntPtr lpProcessAttributes,
        IntPtr lpThreadAttributes,
        bool bInheritHandles,
        uint dwCreationFlags,
        IntPtr lpEnvironment,
        string? lpCurrentDirectory,
        ref STARTUPINFO lpStartupInfo,
        out PROCESS_INFORMATION lpProcessInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern uint ResumeThread(IntPtr hThread);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool GetExitCodeProcess(IntPtr hProcess, out uint lpExitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern uint WaitForSingleObject(IntPtr hHandle, uint dwMilliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool CloseHandle(IntPtr hObject);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool SetHandleInformation(IntPtr hObject, uint dwMask, uint dwFlags);

    /// <summary>查询句柄类型：FILE_TYPE_PIPE(3) / FILE_TYPE_CHAR(2) / FILE_TYPE_DISK(1)。
    /// CRT 描述符表的 flags 字节需要它来区分管道与字符设备。</summary>
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern int GetFileType(IntPtr hFile);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool GetHandleInformation(IntPtr hObject, out uint lpdwFlags);

    // ---- 同步文件/管道 I/O ----
    // 用于 Node IPC 通道（fd 3）。为什么不用 FileStream：
    //   FileStream 在 AOT 下会引入额外的运行时 P/Invoke 层，且对「非 seekable 管道」
    //   的缓冲行为不可控（会做自己的 buffered 读，破坏按帧切分的时序）。
    //   直接 ReadFile/WriteFile 语义最清晰：一次调用返回多少个字节由 OS 决定。
    //
    // lpOverlapped 传 IntPtr.Zero = 同步 I/O（会阻塞调用线程）。
    // 阻塞是预期行为：调用方用「读线程 + 有界等待」结构把它隔离在后台线程上。
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool ReadFile(IntPtr hFile, byte[] lpBuffer, uint nNumberOfBytesToRead,
        out uint lpNumberOfBytesRead, IntPtr lpOverlapped);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool WriteFile(IntPtr hFile, byte[] lpBuffer, uint nNumberOfBytesToWrite,
        out uint lpNumberOfBytesWritten, IntPtr lpOverlapped);

    /// <summary>
    /// ERROR_NO_DATA(232) —— 管道正在被关闭。
    /// </summary>
    /// <remarks>
    /// 与 <see cref="ERROR_PIPE_NOT_CONNECTED"/>(233) 是两个不同的码，
    /// 历史上在 <see cref="IpcChannel"/> 里被混用过：注释写 233、常量写 232。
    /// 两者都表示「对端已不可用」，都必须判成 EOF。
    /// </remarks>
    public const int ERROR_NO_DATA = 232;


    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool CreatePipe(out IntPtr hReadPipe, out IntPtr hWritePipe,
        ref SECURITY_ATTRIBUTES lpPipeAttributes, uint nSize);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr GetStdHandle(int nStdHandle);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool SetStdHandle(int nStdHandle, IntPtr hHandle);

    // ---- CRT 文件描述符 → 操作系统句柄 ----
    // Node 的 spawn stdio 数组按「文件描述符」编号传给子进程（第 4/5/6 项 → fd 3/4/5）。
    // 在 Windows 上要拿到对应的 Win32 句柄，必须走 CRT 的 _get_osfhandle，
    // 而不是 GetStdHandle（后者只认标准句柄表的固定索引）。
    [DllImport("ucrtbase.dll", SetLastError = true)]
    private static extern IntPtr _get_osfhandle(int fd);

    public static IntPtr CrtGetOsFHandle(int fd) => _get_osfhandle(fd);

    // ---- 关于「探测 fd 是否有效」的重要限制 ----
    //
    // 对**尚未分配**的 fd 调 _get_osfhandle / _dup2，CRT 走的是 _invoke_watson
    // —— 它直接 abort 进程。这不是 .NET 异常，try/catch 拦不住，
    // _set_invalid_parameter_handler 也拦不住（已实测确认）。
    //
    // 因此本项目的规矩是：**从不主动探测任意编号的 fd**。
    // 只读 host 明确声明会给的那几个（3/4/5/6/7）；测试里由 FdLayoutHost
    // 预先把这些槽位占住，让探测落在「已分配但句柄无效」上而不是洞里。
    //
    // 曾尝试安装 _set_invalid_parameter_handler 来「挡住」abort，实测无效，
    // 代码已移除 —— 留一段装不上还会被误以为保护生效的代码，比没有更危险。

    // ---- CRT 文件描述符注入（仅测试宿主使用）----
    //
    // 生产路径只有 _get_osfhandle：fd 4/5/6 由 host 的 spawn 布局给定。
    // 但要在**单元测试**里覆盖 JobRunner 的编排逻辑（CreateProcessW / Job 入队 /
    // fd 表编码），必须先在自己的进程里造出同样的 fd 4/5/6 布局 ——
    // 否则那些代码路径只能靠端到端测试间接摸到。
    //
    // 仅供 tests/DshAotRunner.Tests/FdLayoutHost.cs 使用。
    [DllImport("ucrtbase.dll", SetLastError = true)]
    private static extern int _open_osfhandle(IntPtr osfhandle, int flags);

    [DllImport("ucrtbase.dll", SetLastError = true)]
    private static extern int _dup2(int fd1, int fd2);

    /// <summary>把 Win32 句柄登记进 CRT 描述符表，返回分配到的 fd（失败 -1）。</summary>
    /// <remarks>注意：登记成功后该句柄的所有权归 CRT。</remarks>
    public static int CrtOpenOsFHandle(IntPtr handle, int flags) =>
        _open_osfhandle(handle, flags);

    /// <summary>把 <paramref name="fd1"/> 复制到 <paramref name="fd2"/> 位置（成功 0）。</summary>
    public static int CrtDup2(int fd1, int fd2) => _dup2(fd1, fd2);

    public const int STD_INPUT_HANDLE = -10;
    public const int STD_OUTPUT_HANDLE = -11;
    public const int STD_ERROR_HANDLE = -12;
}


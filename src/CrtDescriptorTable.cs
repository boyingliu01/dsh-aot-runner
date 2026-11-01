// CRT 描述符表编码 —— 让 target 能用 fd 7 打开 control channel
//
// 背景：
//   DSH 的 subprocess 协议支持 start 请求带 control: "pipe"。此时 host 在
//   stdio[7] 位置传入一个管道，runner 必须把它交给 target。target 侧会用
//   openInheritedControlChannel() 以 fd 7 打开它。
//
// 为什么不能只靠 SetHandleInformation：
//   CreateProcessW 的 bInheritHandles 只决定「句柄进了子进程句柄表」，
//   不决定子进程的 CRT 如何给这些句柄分配 fd 编号。子进程的 fd 布局由
//   STARTUPINFO.lpReserved2 指向的**描述符表**决定：
//
//     [0..3]            uint32   描述符总数 count
//     [4 .. 4+count-1]  uint8    每槽 builds flag（FOPEN|FPIPE|FDEV …）
//     [4+count ..]      uint64   每槽 OS 句柄值，空槽填 INVALID_HANDLE_VALUE
//
//   不填这张表，target 的 fd 7 就是无效的（实测 [WinError 6] 句柄无效）。
//
// 对照实现：@deepseek-ai/dsh-win32-process/lib/index.js 的 inheritedControlStdio()。
// 本文件与其逐字节对齐，任何偏离都会导致 A/B 行为分歧。
using System.Buffers.Binary;

namespace DshAotRunner;

internal static class CrtDescriptorTable
{
    /// <summary>control channel 在 target 侧的固定描述符号。</summary>
    public const int ControlFileDescriptor = 7;

    private const byte FOPEN = 1;
    private const byte FPIPE = 8;
    private const byte FDEV = 64;

    private const int FILE_TYPE_CHAR = 2;
    private const int FILE_TYPE_PIPE = 3;

    private const int HandleBytes = 8;

    /// <summary>
    /// 编码 target 的 CRT 描述符表，作为 CreateProcessW 的
    /// STARTUPINFO.cbReserved2 / lpReserved2 传入。
    ///
    /// 只填 4 个槽：stdin/stdout/stderr/control。其余槽保持 INVALID_HANDLE_VALUE
    /// （已关闭状态），与 DSH 实现一致。
    /// </summary>
    /// <param name="stdin">target 的标准输入句柄</param>
    /// <param name="stdout">target 的标准输出句柄</param>
    /// <param name="stderr">target 的标准错误句柄</param>
    /// <param name="control">control channel 句柄；未启用 control 时传无效值则返回 null</param>
    /// <returns>描述符表字节；不需要时返回 null</returns>
    public static byte[]? Encode(IntPtr stdin, IntPtr stdout, IntPtr stderr, IntPtr control)
    {
        // 未启用 control：不提供描述符表，让 CreateProcessW 走默认的
        // 「标准句柄表」路径，与不传 control 的既有行为保持一致。
        if (!IsValidHandle(control)) return null;

        var count = ControlFileDescriptor + 1;
        var flagsOffset = 4;
        var handlesOffset = flagsOffset + count;
        var block = new byte[handlesOffset + count * HandleBytes];

        BinaryPrimitives.WriteUInt32LittleEndian(block.AsSpan(0, 4), (uint)count);

        // 所有槽先填 INVALID_HANDLE_VALUE
        for (var i = 0; i < count; i++)
            BinaryPrimitives.WriteUInt64LittleEndian(
                block.AsSpan(handlesOffset + i * HandleBytes, HandleBytes), ulong.MaxValue);

        Fill(0, stdin);
        Fill(1, stdout);
        Fill(2, stderr);
        Fill(ControlFileDescriptor, control);

        return block;

        void Fill(int fd, IntPtr handle)
        {
            if (!IsValidHandle(handle)) return;

            var fileType = Native.GetFileType(handle);
            var flags = (byte)FOPEN;
            if (fileType == FILE_TYPE_PIPE) flags |= FPIPE;
            else if (fileType == FILE_TYPE_CHAR) flags |= FDEV;

            block[flagsOffset + fd] = flags;
            BinaryPrimitives.WriteUInt64LittleEndian(
                block.AsSpan(handlesOffset + fd * HandleBytes, HandleBytes), (ulong)handle.ToInt64());
        }
    }

    private static bool IsValidHandle(IntPtr h) => h != IntPtr.Zero && h != new IntPtr(-1);
}

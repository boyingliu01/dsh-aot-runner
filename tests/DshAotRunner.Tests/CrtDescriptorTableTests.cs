// CrtDescriptorTable 单元测试 —— CRT 描述符表的字节布局与 NUL 陷阱
//
// 为什么这些测试值得存在：
//   这张表必须与 @deepseek-ai/dsh-win32-process 的 inheritedControlStdio()
//   **逐字节一致**。一旦布局错了，target 的 fd 7 就是无效的，表现为
//   [WinError 6] 句柄无效 —— 而端到端测试只能看到「control channel 打不开」，
//   说不出是哪个偏移错了。
//
//   另一类错误更隐蔽：把 \\?\NUL 字符设备填进 target 的标准槽。
//   句柄有效、写入永远成功、内容被丢弃 —— target 输出静默消失，
//   上层拿到空输出却没有任何报错。这种「成功但没结果」比直接失败更难查，
//   所以代码选择显式抛异常，这里就守住这条契约。
using System;
using System.Buffers.Binary;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using DshAotRunner;
using Xunit;

namespace DshAotRunner.Tests;

public sealed class CrtDescriptorTableTests : IDisposable
{
    private const int CountOffset = 0;
    private const int FlagsOffset = 4;
    private const int HandleBytes = 8;
    private const byte FOPEN = 1;
    private const byte FPIPE = 8;

    private readonly AnonymousPipeServerStream _pipe;

    public CrtDescriptorTableTests()
    {
        // 匿名管道提供真实的 FILE_TYPE_PIPE 句柄 —— 这是能拿到的最接近
        // 生产形态（host 传进来的 fd 4/5/6/7 就是管道）的测试输入。
        _pipe = new AnonymousPipeServerStream(PipeDirection.Out);
    }

    public void Dispose() => _pipe.Dispose();

    private IntPtr PipeHandle => _pipe.ClientSafePipeHandle.DangerousGetHandle();

    /// <summary>按文档布局读出一个槽的 flag 字节。</summary>
    private static byte FlagAt(byte[] block, int fd) => block[FlagsOffset + fd];

    /// <summary>按文档布局读出一个槽的句柄值。</summary>
    private static ulong HandleAt(byte[] block, int fd)
    {
        var count = (int)BinaryPrimitives.ReadUInt32LittleEndian(block.AsSpan(CountOffset, 4));
        var handlesOffset = FlagsOffset + count;
        return BinaryPrimitives.ReadUInt64LittleEndian(
            block.AsSpan(handlesOffset + fd * HandleBytes, HandleBytes));
    }

    // ============ control 未启用 ============

    [Fact]
    public void Encode_control为0_返回null()
    {
        Assert.Null(CrtDescriptorTable.Encode(PipeHandle, PipeHandle, PipeHandle, IntPtr.Zero));
    }

    [Fact]
    public void Encode_control为负一_返回null()
    {
        // INVALID_HANDLE_VALUE 同样是「没有 control」，不能当成有效句柄。
        var invalid = new IntPtr(-1);
        Assert.Null(CrtDescriptorTable.Encode(PipeHandle, PipeHandle, PipeHandle, invalid));
    }

    // ============ 表头布局 ============

    [Fact]
    public void Encode_描述符总数等于controlFd加一()
    {
        var block = CrtDescriptorTable.Encode(PipeHandle, PipeHandle, PipeHandle, PipeHandle);

        Assert.NotNull(block);
        Assert.Equal(
            (uint)(CrtDescriptorTable.ControlFileDescriptor + 1),
            BinaryPrimitives.ReadUInt32LittleEndian(block.AsSpan(CountOffset, 4)));
    }

    [Fact]
    public void Encode_总长度等于四字节头加count个flag加count个句柄()
    {
        var block = CrtDescriptorTable.Encode(PipeHandle, PipeHandle, PipeHandle, PipeHandle);

        Assert.NotNull(block);
        var count = CrtDescriptorTable.ControlFileDescriptor + 1;
        Assert.Equal(4 + count + count * HandleBytes, block.Length);
    }

    // ============ 槽位内容 ============

    [Fact]
    public void Encode_管道句柄的flag含FOPEN与FPIPE()
    {
        var block = CrtDescriptorTable.Encode(PipeHandle, PipeHandle, PipeHandle, PipeHandle);

        Assert.NotNull(block);
        foreach (var fd in new[] { 0, 1, 2, CrtDescriptorTable.ControlFileDescriptor })
        {
            Assert.Equal(FOPEN | FPIPE, FlagAt(block, fd));
        }
    }

    [Fact]
    public void Encode_四个槽的句柄值与传入一致()
    {
        var block = CrtDescriptorTable.Encode(PipeHandle, PipeHandle, PipeHandle, PipeHandle);

        Assert.NotNull(block);
        var expected = (ulong)PipeHandle.ToInt64();
        foreach (var fd in new[] { 0, 1, 2, CrtDescriptorTable.ControlFileDescriptor })
        {
            Assert.Equal(expected, HandleAt(block, fd));
        }
    }

    [Fact]
    public void Encode_未填的槽保持INVALID_HANDLE_VALUE()
    {
        // 只填 0/1/2 与 control(7)，3~6 必须是 ulong.MaxValue（已关闭状态）。
        var block = CrtDescriptorTable.Encode(PipeHandle, PipeHandle, PipeHandle, PipeHandle);

        Assert.NotNull(block);
        for (var fd = 3; fd < CrtDescriptorTable.ControlFileDescriptor; fd++)
        {
            Assert.Equal(ulong.MaxValue, HandleAt(block, fd));
            Assert.Equal(0, FlagAt(block, fd));
        }
    }

    [Fact]
    public void Encode_标准槽句柄为0时留空但不抛异常()
    {
        // 没有 stdio 时不应炸 —— 这是 NDJSON 调试路径会遇到的情形。
        var block = CrtDescriptorTable.Encode(IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, PipeHandle);

        Assert.NotNull(block);
        Assert.Equal(0, FlagAt(block, 0));
        Assert.Equal(ulong.MaxValue, HandleAt(block, 0));
        Assert.Equal(FOPEN | FPIPE, FlagAt(block, CrtDescriptorTable.ControlFileDescriptor));
    }

    // ============ NUL 陷阱 ============

    [Fact]
    public void Encode_标准槽拿到字符设备句柄时抛异常()
    {
        // 用 CONOUT$ 打开一个真实的字符设备句柄，模拟「host 把 NUL 当 stdio」。
        var charDevice = CreateCharacterDeviceHandle();
        Assert.NotEqual(IntPtr.Zero, charDevice);
        Assert.NotEqual(new IntPtr(-1), charDevice);

        var thrown = Assert.Throws<InvalidOperationException>(
            () => CrtDescriptorTable.Encode(charDevice, PipeHandle, PipeHandle, PipeHandle));

        Assert.Contains("字符设备", thrown.Message);
    }

    [Fact]
    public void Encode_control槽拿到字符设备不抛异常()
    {
        // control 槽 (fd 7) 不受「标准槽」限制：它的用途是 IPC，不是输出，
        // 不会造成静默丢输出，因此不需要拦。
        var charDevice = CreateCharacterDeviceHandle();

        var block = CrtDescriptorTable.Encode(PipeHandle, PipeHandle, PipeHandle, charDevice);

        Assert.NotNull(block);
        Assert.Equal(FOPEN | 64 /* FDEV */, FlagAt(block, CrtDescriptorTable.ControlFileDescriptor));
    }

    /// <summary>
    /// 打开一个真实字符设备句柄，用来模拟「host 把 NUL 当 stdio」。
    /// </summary>
    /// <remarks>
    /// 生产代码只需要 GetFileType，不需要 CreateFileW，所以这条 P/Invoke
    /// 声明留在测试里 —— 不让测试的便利扩大生产程序的 interop 面积。
    /// 优先 CONOUT$（控制台输出，一定是 FILE_TYPE_CHAR）；
    /// 在无控制台的 CI 会话里退回 NUL（同样是字符设备）。
    /// </remarks>
    private static IntPtr CreateCharacterDeviceHandle()
    {
        var handle = CreateFileW(
            "CONOUT$", 0x80000000 /* GENERIC_READ */, 0x3 /* FILE_SHARE_READ|WRITE */,
            IntPtr.Zero, 3 /* OPEN_EXISTING */, 0, IntPtr.Zero);

        if (handle == IntPtr.Zero || handle == new IntPtr(-1))
        {
            handle = CreateFileW(
                "NUL", 0x80000000, 0x3, IntPtr.Zero, 3, 0, IntPtr.Zero);
        }

        return handle;
    }

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern IntPtr CreateFileW(
        string lpFileName, uint dwDesiredAccess, uint dwShareMode,
        IntPtr lpSecurityAttributes, uint dwCreationDisposition,
        uint dwFlagsAndAttributes, IntPtr hTemplateFile);
}

// IpcChannel 测试接缝 —— 不依赖真实 fd 3 的通道行为测试
//
// ## 为什么这个文件重要
//
// IpcChannel 是 runner 与 DSH host 通信的**唯一通道**（fd 3），它失败的表现是
// 「整个会话的子进程全部挂掉」，而它此前**零单元覆盖**（0/64 行）。
//
// 之所以一直没测，是因为它需要真实 fd 3 才能构造。但真正危险的不是构造，
// 是那三种在真实管道上极难复现、一旦出错就灾难的分块形态：
//   1. 一次 ReadFile 返回多帧（消息粘在一起）
//   2. 一次 ReadFile 返回半帧（头到了、载荷没到）
//   3. detach 之后返回错误码而不是 0 字节
//
// 本文件通过 IChannelIo 接缝把底层 I/O 换成内存实现，精确炮制这几种形态。
//
// ## 顺带抓到的真缺陷
//
// 写这个文件的过程直接暴露了一个 bug：IsEndOfStream 只判 ERROR_NO_DATA(232)，
// 而 host detach 后管道真正返回的是 ERROR_PIPE_NOT_CONNECTED(233)。
// 那个常量在 Native.cs 里早就存在，只是从没被这条判断用过 ——
// 没有任何测试会发现「常量没用上」，这正是零覆盖的代价。
using System.Text;
using DshAotRunner;
using Xunit;

namespace DshAotRunner.Tests;

/// <summary>可编排的假通道：喂什么、读什么、写什么，全部由测试决定。</summary>
internal sealed class FakeChannelIo : IChannelIo
{
    private readonly Queue<(bool Ok, byte[] Data, int Error)> _reads = new();
    private readonly List<byte[]> _written = new();
    private int _writeQuota = int.MaxValue;

    /// <summary>已写入的全部字节（按调用顺序拼接前的原始片段）。</summary>
    public IReadOnlyList<byte[]> Written => _written;

    /// <summary>把全部已写片段拼成一整串字节。</summary>
    public byte[] WrittenBytes() => [.. _written.SelectMany(x => x)];

    /// <summary>排队一次成功读取。</summary>
    public FakeChannelIo ReadBytes(byte[] data)
    {
        _reads.Enqueue((true, data, 0));
        return this;
    }

    /// <summary>排队一次成功读取（字符串按 UTF-8 编码）。</summary>
    public FakeChannelIo ReadText(string text) => ReadBytes(Encoding.UTF8.GetBytes(text));

    /// <summary>排队一次失败读取（带 Win32 错误码）。</summary>
    public FakeChannelIo ReadError(int error)
    {
        _reads.Enqueue((false, [], error));
        return this;
    }

    /// <summary>限制每次 Write 最多写这么多字节，模拟「管道只吃下一部分」。</summary>
    public FakeChannelIo WithWriteQuota(int bytes)
    {
        _writeQuota = bytes;
        return this;
    }

    public (bool Ok, uint Got, int Error) Read(byte[] buffer)
    {
        if (_reads.Count == 0)
        {
            // 读空了 = 对端关闭。用 233 而不是 232，与真实 detach 行为一致。
            return (false, 0, Native.ERROR_PIPE_NOT_CONNECTED);
        }
        var (ok, data, error) = _reads.Dequeue();
        if (!ok) return (false, 0, error);
        data.CopyTo(buffer, 0);
        return (true, (uint)data.Length, 0);
    }

    public (bool Ok, uint Written, int Error) Write(byte[] buffer, int offset, int count)
    {
        var take = Math.Min(count, _writeQuota);
        if (take <= 0) return (true, 0, 0);          // 模拟「写回 0 字节」
        _written.Add(buffer[offset..(offset + take)]);
        return (true, (uint)take, 0);
    }
}

public class IpcChannelIoSeamTests
{
    /// <summary>按协议构造一帧：[type(8)][len(8)][payload]。</summary>
    private static byte[] Frame(string payload, long type = IpcFrameDecoder.NodeHandleNormal)
    {
        var body = Encoding.UTF8.GetBytes(payload);
        var frame = new byte[IpcFrameDecoder.HeaderLength + body.Length];
        BitConverter.GetBytes(type).CopyTo(frame, 0);
        BitConverter.GetBytes((long)body.Length).CopyTo(frame, 8);
        body.CopyTo(frame, IpcFrameDecoder.HeaderLength);
        return frame;
    }

    private static IpcChannel Channel(FakeChannelIo io) => new(io);

    // ============ 读取：分块边界 ============

    [Fact]
    public void ReadMessage_单帧完整到达()
    {
        var io = new FakeChannelIo().ReadBytes(Frame("{\"a\":1}"));
        var channel = Channel(io);

        Assert.Equal("{\"a\":1}", channel.ReadMessage());
    }

    [Fact]
    public void ReadMessage_一次读返回多帧_逐条取出不粘连()
    {
        // 真实管道最常见的形态：两条消息在一次 ReadFile 里一起到达。
        // 处理错就会「两条消息粘成一条」——host 侧表现为 JSON 解析失败。
        var io = new FakeChannelIo().ReadBytes([.. Frame("{\"n\":1}"), .. Frame("{\"n\":2}")]);
        var channel = Channel(io);

        Assert.Equal("{\"n\":1}", channel.ReadMessage());
        Assert.Equal("{\"n\":2}", channel.ReadMessage());
    }

    [Fact]
    public void ReadMessage_半帧到达_继续读到齐才返回()
    {
        var full = Frame("{\"half\":true}");
        // 头 16 字节 + 载荷拆成两次读：第一次给 20 字节（头 + 4 字节载荷）
        var io = new FakeChannelIo()
            .ReadBytes(full[..20])
            .ReadBytes(full[20..]);
        var channel = Channel(io);

        Assert.Equal("{\"half\":true}", channel.ReadMessage());
    }

    [Fact]
    public void ReadMessage_分块边界正好落在帧头中间()
    {
        // 头是 8+8 字节，在 8 字节处切开 —— 长度字段被劈成两半。
        var full = Frame("{\"split\":1}");
        var io = new FakeChannelIo()
            .ReadBytes(full[..8])
            .ReadBytes(full[8..]);
        var channel = Channel(io);

        Assert.Equal("{\"split\":1}", channel.ReadMessage());
    }

    [Fact]
    public void ReadMessage_UTF8多字节字符被切开仍能还原()
    {
        // 中文在 UTF-8 里是 3 字节，若按字节数切帧会切在半个字符上。
        var payload = "{\"msg\":\"中文\"}";
        var full = Frame(payload);
        // 在第 17 字节处切（头 16 之后第 1 个字节，即 '中' 的第一个字节）
        var io = new FakeChannelIo()
            .ReadBytes(full[..17])
            .ReadBytes(full[17..]);
        var channel = Channel(io);

        Assert.Equal(payload, channel.ReadMessage());
    }

    // ============ 读取：EOF 与错误 ============

    [Fact]
    public void ReadMessage_读回0字节判定为EOF()
    {
        var io = new FakeChannelIo().ReadBytes([]);       // ok=true, got=0
        var channel = Channel(io);

        Assert.Null(channel.ReadMessage());
        Assert.True(channel.IsClosed);
    }

    [Fact]
    public void ReadMessage_ERROR_BROKEN_PIPE判定为EOF()
    {
        // 109：管道已断，是 detach 的常见形态之一
        var io = new FakeChannelIo().ReadError(Native.ERROR_BROKEN_PIPE);
        var channel = Channel(io);

        Assert.Null(channel.ReadMessage());
        Assert.True(channel.IsClosed);
    }

    [Fact]
    public void ReadMessage_ERROR_PIPE_NOT_CONNECTED判定为EOF()
    {
        // 233：这才是 host detach 后管道真正返回的码。
        // 修复前这条判断只认 232，本用例会 FAIL —— 它就是那个 bug 的回归守卫。
        var io = new FakeChannelIo().ReadError(Native.ERROR_PIPE_NOT_CONNECTED);
        var channel = Channel(io);

        Assert.Null(channel.ReadMessage());
        Assert.True(channel.IsClosed);
    }

    [Fact]
    public void ReadMessage_ERROR_NO_DATA判定为EOF()
    {
        // 232：另一种「对端已不可用」的形态，也必须认。
        var io = new FakeChannelIo().ReadError(Native.ERROR_NO_DATA);
        var channel = Channel(io);

        Assert.Null(channel.ReadMessage());
        Assert.True(channel.IsClosed);
    }

    [Fact]
    public void ReadMessage_未知错误码抛协议异常()
    {
        // 5 = ERROR_ACCESS_DENIED：不是 EOF，必须让调用方知道通道真的坏了，
        // 而不是伪装成「对端正常关闭」。
        //
        // 这条用例曾 FAIL（实际判成了 EOF），暴露出 IsEndOfStream 丢掉了 ok 参数：
        // 「读失败 + got==0」被无条件当成 EOF，任何真错误都被静默吞掉。
        // 修复后 ok 参与判定，本用例成为该缺陷的回归守卫。
        var io = new FakeChannelIo().ReadError(5);
        var channel = Channel(io);

        var ex = Assert.Throws<IpcProtocolException>(() => channel.ReadMessage());
        Assert.Contains("err=5", ex.Message);
        Assert.False(channel.IsClosed);
    }

    [Fact]
    public void ReadMessage_已关闭后再次读取直接返回null()
    {
        var io = new FakeChannelIo().ReadError(Native.ERROR_BROKEN_PIPE);
        var channel = Channel(io);
        Assert.Null(channel.ReadMessage());

        // 第二次调用不应再消费 I/O（队列已空会返回 233，但不应走到那里）
        Assert.Null(channel.ReadMessage());
    }

    [Fact]
    public void Dispose_置为已关闭_后续读取返回null()
    {
        var io = new FakeChannelIo().ReadBytes(Frame("{\"x\":1}"));
        var channel = Channel(io);
        channel.Dispose();

        Assert.True(channel.IsClosed);
        Assert.Null(channel.ReadMessage());
    }

    // ============ 写入 ============

    [Fact]
    public void Send_帧布局正确_类型恒定长度含换行()
    {
        var io = new FakeChannelIo();
        var channel = Channel(io);

        channel.Send("{\"ok\":true}");

        var bytes = io.WrittenBytes();
        Assert.Equal(IpcFrameDecoder.NodeHandleNormal, BitConverter.ToInt64(bytes, 0));
        var len = BitConverter.ToInt64(bytes, 8);
        // 载荷 = JSON + '\n'
        Assert.Equal(Encoding.UTF8.GetByteCount("{\"ok\":true}") + 1, len);
        Assert.Equal(IpcFrameDecoder.HeaderLength + len, bytes.Length);
        Assert.Equal("{\"ok\":true}\n", Encoding.UTF8.GetString(bytes[IpcFrameDecoder.HeaderLength..]));
    }

    [Fact]
    public void BuildFrame_长度按字节数而非字符数()
    {
        // 中文 '中' 是 1 个字符、3 个字节。若按 string.Length 算长度，
        // host 会按错误长度切帧，切在半个汉字上 —— 表现为乱码或解析失败。
        var frame = IpcChannel.BuildFrame("中");

        Assert.Equal(16 + 4, frame.Length);              // 头16 + '中'3 + '\n'1
        Assert.Equal(4, BitConverter.ToInt64(frame, 8));
    }

    [Fact]
    public void BuildFrame_类型字段恒为NodeHandleNormal()
    {
        var frame = IpcChannel.BuildFrame("{}");

        Assert.Equal(1L, BitConverter.ToInt64(frame, 0));
        Assert.Equal(IpcFrameDecoder.NodeHandleNormal, BitConverter.ToInt64(frame, 0));
    }

    [Fact]
    public void Send_部分写入时循环写满()
    {
        // 管道满时 WriteFile 只写进去一部分，必须循环续写。
        // 少写字节的后果是 host 收到半帧，进而卡住等剩余数据 —— 表现为「调用不返回」。
        var io = new FakeChannelIo().WithWriteQuota(5);
        var channel = Channel(io);

        channel.Send("{\"loop\":true}");

        var expected = IpcChannel.BuildFrame("{\"loop\":true}");
        Assert.Equal(expected, io.WrittenBytes());
        Assert.True(io.Written.Count > 1, "应当被拆成多次 Write");
    }

    [Fact]
    public void Send_通道已关闭时静默丢弃()
    {
        var io = new FakeChannelIo();
        var channel = Channel(io);
        channel.Dispose();

        channel.Send("{\"ignored\":true}");

        Assert.Empty(io.Written);
    }

    // ============ IsEndOfStream 边界直接断言 ============

    [Theory]
    // ---- 读成功：只有 0 字节才是 EOF ----
    [InlineData(true, 0u, 0, true)]                            // 干净关闭
    [InlineData(true, 5u, 0, false)]                           // 读到数据 → 不是 EOF
    // ---- 读失败：只有「对端不可用」类错误码才是 EOF ----
    [InlineData(false, 0u, Native.ERROR_BROKEN_PIPE, true)]    // 109
    [InlineData(false, 0u, Native.ERROR_NO_DATA, true)]        // 232
    [InlineData(false, 0u, Native.ERROR_PIPE_NOT_CONNECTED, true)]  // 233 ← 修复前漏判
    [InlineData(false, 0u, 5, false)]                          // ACCESS_DENIED 是真错误
    [InlineData(false, 0u, 87, false)]                         // INVALID_PARAMETER 是真错误
    public void IsEndOfStream_分类(bool ok, uint got, int err, bool expected)
    {
        Assert.Equal(expected, IpcChannel.IsEndOfStream(ok, got, err));
    }
}

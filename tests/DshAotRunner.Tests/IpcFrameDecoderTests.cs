// IpcFrameDecoder 单元测试 —— Node IPC 帧切分的边界穷举
//
// 为什么这些测试值得存在：
//   IpcChannel 需要真实 fd 3 才能构造，端到端只能间接覆盖帧切分。
//   而这个解码器要处理的正是管道最真实的行为：
//     - 一次读返回半帧（头到了、载荷没到）
//     - 一次读返回多帧（两三条消息粘在一起）
//     - 分块边界恰好落在 8 字节头中间
//     - 对端发出畸形帧（type 不符 / 长度越界）
//   这些在手工调试中几乎不会出现，但一旦出错就是「消息丢失」或
//   「两条消息粘成一条」「进程挂死」，且只在特定分块边界复现。
using System.Text;
using DshAotRunner;
using Xunit;

namespace DshAotRunner.Tests;

public class IpcFrameDecoderTests
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

    [Fact]
    public void 单帧一次到达()
    {
        var d = new IpcFrameDecoder();
        d.Append(Frame("""{"a":1}"""));

        Assert.True(d.TryTakeFrame(out var payload));
        Assert.Equal("""{"a":1}""", payload);
        Assert.False(d.TryTakeFrame(out _));
    }

    [Fact]
    public void 空载荷帧()
    {
        var d = new IpcFrameDecoder();
        d.Append(Frame(""));

        Assert.True(d.TryTakeFrame(out var payload));
        Assert.Equal("", payload);
    }

    [Fact]
    public void 多帧粘在一起依次切出()
    {
        var d = new IpcFrameDecoder();
        var both = Frame("one").Concat(Frame("two")).ToArray();
        d.Append(both);

        Assert.True(d.TryTakeFrame(out var first));
        Assert.Equal("one", first);
        Assert.True(d.TryTakeFrame(out var second));
        Assert.Equal("two", second);
        Assert.False(d.TryTakeFrame(out _));
    }

    [Fact]
    public void 半帧等待更多数据()
    {
        // 先只给帧头 + 一部分载荷 —— 必须返回 false 而不是吐半条消息
        var d = new IpcFrameDecoder();
        var full = Frame("hello-world");
        d.Append(full.AsSpan(0, full.Length - 3));

        Assert.False(d.TryTakeFrame(out _));

        d.Append(full.AsSpan(full.Length - 3));
        Assert.True(d.TryTakeFrame(out var payload));
        Assert.Equal("hello-world", payload);
    }

    [Fact]
    public void 帧头本身被拆成两次到达()
    {
        // 分块边界落在 8 字节头中间：这是真实管道最典型的分块方式
        var d = new IpcFrameDecoder();
        var full = Frame("abc");

        d.Append(full.AsSpan(0, 5));          // 连 type 字段都没收全
        Assert.False(d.TryTakeFrame(out _));

        d.Append(full.AsSpan(5));             // 补齐剩余
        Assert.True(d.TryTakeFrame(out var payload));
        Assert.Equal("abc", payload);
    }

    [Fact]
    public void 逐字节喂入也能切出整帧()
    {
        var d = new IpcFrameDecoder();
        var full = Frame("""{"k":"v"}""");

        for (var i = 0; i < full.Length; i++)
        {
            var before = d.TryTakeFrame(out var p);
            // 最后一步之前都不该切出帧
            if (i < full.Length - 1) Assert.False(before);
            d.Append(full.AsSpan(i, 1));
        }

        Assert.True(d.TryTakeFrame(out var payload));
        Assert.Equal("""{"k":"v"}""", payload);
    }

    [Fact]
    public void type不是NORMAAL时抛协议异常()
    {
        var d = new IpcFrameDecoder();
        d.Append(Frame("x", type: -1));

        // 负值 = 内部句柄/命令帧，载荷不是 JSON，必须拒绝而不是当 JSON 解析
        Assert.Throws<IpcProtocolException>(() => d.TryTakeFrame(out _));
    }

    [Fact]
    public void 长度为负时抛协议异常()
    {
        var d = new IpcFrameDecoder();
        var frame = Frame("x");
        BitConverter.GetBytes(-5L).CopyTo(frame, 8);
        d.Append(frame);

        Assert.Throws<IpcProtocolException>(() => d.TryTakeFrame(out _));
    }

    [Fact]
    public void 长度超过上限时抛协议异常()
    {
        // 畸形帧声明一个天文数字：不能真的去分配那块内存
        var d = new IpcFrameDecoder();
        var frame = Frame("x");
        BitConverter.GetBytes(IpcFrameDecoder.MaxPayloadLength + 1).CopyTo(frame, 8);
        d.Append(frame);

        Assert.Throws<IpcProtocolException>(() => d.TryTakeFrame(out _));
    }

    [Fact]
    public void 恰好达到上限的长度是合法的()
    {
        // 边界：等于上限必须通过校验（不能误判为越界）。
        // 这里只验证「不抛异常」，不真的构造 8MB 载荷。
        var d = new IpcFrameDecoder();
        var frame = Frame("x");
        BitConverter.GetBytes(IpcFrameDecoder.MaxPayloadLength).CopyTo(frame, 8);
        d.Append(frame);

        // 载荷没到齐 → 返回 false（等更多数据），不是抛异常
        Assert.False(d.TryTakeFrame(out _));
    }

    [Fact]
    public void UTF8多字节字符跨分块边界()
    {
        // 中文 3 字节序列被切在中间：解码必须等到整帧齐了再解，
        // 不能在字节层面先解一次。
        var d = new IpcFrameDecoder();
        var full = Frame("中文");
        // 切在第二个字符的字节中间
        d.Append(full.AsSpan(0, full.Length - 2));
        Assert.False(d.TryTakeFrame(out _));
        d.Append(full.AsSpan(full.Length - 2));

        Assert.True(d.TryTakeFrame(out var payload));
        Assert.Equal("中文", payload);
    }

    [Fact]
    public void 超大载荷自动扩容并正确切出()
    {
        // 载荷超过初始容量（64KB）时必须扩容而不是丢数据
        var big = new string('x', 200_000);
        var d = new IpcFrameDecoder();

        var full = Frame(big);
        // 分两块喂入，模拟管道分次到达
        d.Append(full.AsSpan(0, full.Length / 2));
        Assert.False(d.TryTakeFrame(out _));
        d.Append(full.AsSpan(full.Length / 2));

        Assert.True(d.TryTakeFrame(out var payload));
        Assert.Equal(big.Length, payload.Length);
        Assert.Equal(big, payload);
    }

    [Fact]
    public void 消费后Available归零()
    {
        var d = new IpcFrameDecoder();
        d.Append(Frame("abc"));

        Assert.True(d.TryTakeFrame(out _));
        Assert.Equal(0, d.Available);
    }

    [Fact]
    public void Append空数据不改变状态()
    {
        var d = new IpcFrameDecoder();
        d.Append(ReadOnlySpan<byte>.Empty);

        Assert.Equal(0, d.Available);
        Assert.False(d.TryTakeFrame(out _));
    }

    [Fact]
    public void 三帧连续到达且中间夹杂半帧()
    {
        // 综合场景：完整帧 + 半帧
        var d = new IpcFrameDecoder();
        var f1 = Frame("a");
        var f2 = Frame("b");
        var f3 = Frame("cccc");

        var blob = f1.Concat(f2).Concat(f3.AsSpan(0, 5).ToArray()).ToArray();
        d.Append(blob);

        Assert.True(d.TryTakeFrame(out var p1));
        Assert.Equal("a", p1);
        Assert.True(d.TryTakeFrame(out var p2));
        Assert.Equal("b", p2);
        // 第三帧只有头的一部分 → 还不够
        Assert.False(d.TryTakeFrame(out _));

        d.Append(f3.AsSpan(5));
        Assert.True(d.TryTakeFrame(out var p3));
        Assert.Equal("cccc", p3);
    }

    [Fact]
    public void 构造时容量必须为正()
    {
        Assert.Throws<ArgumentOutOfRangeException>(() => new IpcFrameDecoder(0));
        Assert.Throws<ArgumentOutOfRangeException>(() => new IpcFrameDecoder(-1));
    }
}

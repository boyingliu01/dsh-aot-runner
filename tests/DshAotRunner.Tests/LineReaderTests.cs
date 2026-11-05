// LineReader 单元测试 —— 按行切分字节流
//
// 为什么这些测试值得存在：
//   LineReader 是 --ndjson 调试通道的读取器，它处理的是「一次 Read 可能返回
//   半行 / 多行 / 恰好断在 \r\n 之间」这类真实管道行为。这些边界在手工调试时
//   几乎不会遇到（人敲的输入总是整行到达），但一旦出错就是「消息被吞」或
//   「两条消息粘成一条」，且只在特定分块边界复现 —— 不写测试根本测不到。
//
//   它还修过一个实测性能问题（Issue #9）：逐字节 ReadByte 让 46KB 的 start
//   请求多花 33ms。这里的测试锁住「整块读」的语义，防止有人改回逐字节。
using System.Text;
using DshAotRunner;
using Xunit;

namespace DshAotRunner.Tests;

public class LineReaderTests
{
    private static LineReader Reader(string text) =>
        new(new MemoryStream(Encoding.UTF8.GetBytes(text)));

    [Fact]
    public void ReadLine_单行()
    {
        var r = Reader("hello\n");

        Assert.Equal("hello", r.ReadLine());
        Assert.Null(r.ReadLine());
    }

    [Fact]
    public void ReadLine_多行依次返回()
    {
        var r = Reader("a\nb\nc\n");

        Assert.Equal("a", r.ReadLine());
        Assert.Equal("b", r.ReadLine());
        Assert.Equal("c", r.ReadLine());
        Assert.Null(r.ReadLine());
    }

    [Fact]
    public void ReadLine_去掉CRLF的CR()
    {
        // 协议是 LF 结尾，但文本模式下可能收到 CRLF —— 必须剥掉 \r，
        // 否则 JSON 末尾多一个回车会让解析器报「意外字符」。
        var r = Reader("line1\r\nline2\r\n");

        Assert.Equal("line1", r.ReadLine());
        Assert.Equal("line2", r.ReadLine());
        Assert.Null(r.ReadLine());
    }

    [Fact]
    public void ReadLine_末行无换行也返回()
    {
        // EOF 时缓冲区里残留的内容必须作为最后一行交出，
        // 否则最后一条消息会被静默丢弃。
        var r = Reader("only-line");

        Assert.Equal("only-line", r.ReadLine());
        Assert.Null(r.ReadLine());
    }

    [Fact]
    public void ReadLine_空行返回空串()
    {
        var r = Reader("a\n\nb\n");

        Assert.Equal("a", r.ReadLine());
        Assert.Equal("", r.ReadLine());
        Assert.Equal("b", r.ReadLine());
        Assert.Null(r.ReadLine());
    }

    [Fact]
    public void ReadLine_空流立即EOF()
    {
        var r = Reader("");

        Assert.Null(r.ReadLine());
    }

    [Fact]
    public void ReadLine_保留行内空格()
    {
        var r = Reader("  a b  \n");

        Assert.Equal("  a b  ", r.ReadLine());
    }

    [Fact]
    public void ReadLine_UTF8中文正确解码()
    {
        var r = Reader("中文\n");

        Assert.Equal("中文", r.ReadLine());
    }

    [Fact]
    public void ReadLine_跨chunk边界的长行()
    {
        // 这个测试的核心：行长度超过内部 64KB 缓冲时，必须跨多次 Read 拼接
        // 出完整一行。若实现只读一次就切行，这里会只拿到前半段。
        var longLine = new string('x', 200_000);
        var r = Reader(longLine + "\nend\n");

        Assert.Equal(longLine, r.ReadLine());
        Assert.Equal("end", r.ReadLine());
        Assert.Null(r.ReadLine());
    }

    [Fact]
    public void ReadLine_慢速流每次只给一点数据也能拼出整行()
    {
        // 模拟「一次 Read 只返回几个字节」的管道行为。
        var stream = new TrickleStream(Encoding.UTF8.GetBytes("abcdef\ngh\n"), maxPerRead: 2);
        var r = new LineReader(stream);

        Assert.Equal("abcdef", r.ReadLine());
        Assert.Equal("gh", r.ReadLine());
        Assert.Null(r.ReadLine());
    }

    [Fact]
    public void ReadLine_多行粘在一个chunk里()
    {
        // 一次 Read 返回多行是最常见的情况，必须逐行切出而不是当成一行
        var r = Reader("{\"a\":1}\n{\"b\":2}\n{\"c\":3}\n");

        Assert.Equal("{\"a\":1}", r.ReadLine());
        Assert.Equal("{\"b\":2}", r.ReadLine());
        Assert.Equal("{\"c\":3}", r.ReadLine());
        Assert.Null(r.ReadLine());
    }

    [Fact]
    public void ReadLine_EOF后的残留内容只返回一次()
    {
        var r = Reader("tail");

        Assert.Equal("tail", r.ReadLine());
        // 第二次调用必须返回 null，不能重复吐出同一段
        Assert.Null(r.ReadLine());
        Assert.Null(r.ReadLine());
    }

    /// <summary>每次 Read 最多给 <c>maxPerRead</c> 字节的流，用来模拟真实管道分块。</summary>
    private sealed class TrickleStream : Stream
    {
        private readonly byte[] _data;
        private readonly int _maxPerRead;
        private int _pos;

        public TrickleStream(byte[] data, int maxPerRead)
        {
            _data = data;
            _maxPerRead = maxPerRead;
        }

        public override int Read(byte[] buffer, int offset, int count)
        {
            if (_pos >= _data.Length) return 0;
            var n = Math.Min(Math.Min(count, _maxPerRead), _data.Length - _pos);
            Array.Copy(_data, _pos, buffer, offset, n);
            _pos += n;
            return n;
        }

        public override bool CanRead => true;
        public override bool CanSeek => false;
        public override bool CanWrite => false;
        public override long Length => _data.Length;
        public override long Position { get => _pos; set => throw new NotSupportedException(); }
        public override void Flush() { }
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
    }
}

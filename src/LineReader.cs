// 按行读取 stdin（不依赖 Console.ReadLine 的编码假设）。
//
// 为什么独立成文件：它是纯逻辑 —— 只依赖一个 Stream，不知道 IPC、进程、
// 协议的任何事。此前它和 JobRunner 挤在同一个文件里（JobRunner.cs 末尾），
// 那让「进程生命周期」这个文件同时承载了一个可以单独理解和单独测试的工具类。
// 单测一直是有的（<c>LineReaderTests</c>），只是源码没有对应的边界。
using System.Text;

namespace DshAotRunner;

/// <summary>按行读取 stdin（不依赖 Console.ReadLine 的编码假设）。</summary>
internal sealed class LineReader
{
    private readonly Stream _stream;
    private readonly byte[] _chunk = new byte[64 * 1024];
    private int _chunkPos;
    private int _chunkLen;
    private readonly List<byte> _buffer = new(4096);

    public LineReader(Stream stream) => _stream = stream;

    public string? ReadLine()
    {
        // 逐字节 ReadByte() 会让每个字节都变成一次 IO 调用。
        // 实测（Issue #9）：46KB 的 start 请求（大 env）比 3.4KB 的多花 **33ms**，
        // 而 node runner 在同一对比下是 0ms —— 差异全在这里。
        // 改为整块读入 64KB 缓冲，再从内存里切行。
        while (true)
        {
            if (_chunkPos >= _chunkLen && !Refill()) return TakeTail();

            var span = _chunk.AsSpan(_chunkPos, _chunkLen - _chunkPos);
            var nl = span.IndexOf((byte)'\n');
            if (nl >= 0) return TakeLine(span, nl);

            // 缓冲里没有换行：整块吞掉，继续读
            _buffer.AddRange(span.ToArray());
            _chunkPos = _chunkLen;
        }
    }

    /// <summary>
    /// 从底层流再读一块。读到 EOF 返回 false。
    /// </summary>
    private bool Refill()
    {
        _chunkLen = _stream.Read(_chunk, 0, _chunk.Length);
        _chunkPos = 0;
        return _chunkLen > 0;
    }

    /// <summary>
    /// 切出 <paramref name="nl"/> 位置之前的一行（并消费掉该换行符）。
    /// </summary>
    private string TakeLine(ReadOnlySpan<byte> span, int nl)
    {
        _buffer.AddRange(span[..nl].ToArray());
        _chunkPos += nl + 1;
        var line = Encoding.UTF8.GetString(_buffer.ToArray()).TrimEnd('\r');
        _buffer.Clear();
        return line;
    }

    /// <summary>
    /// EOF 时把缓冲区里残留的半行交出去；没有残留则返回 null。
    /// </summary>
    /// <remarks>
    /// 最后一行可能不带换行符 —— 直接丢弃会让最后一条消息静默消失。
    /// </remarks>
    private string? TakeTail()
    {
        if (_buffer.Count == 0) return null;
        var tail = Encoding.UTF8.GetString(_buffer.ToArray());
        _buffer.Clear();
        return tail;
    }
}

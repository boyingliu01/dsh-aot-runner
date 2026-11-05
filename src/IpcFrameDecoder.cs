// Node IPC 帧解码 —— 纯逻辑，不碰任何 I/O
//
// 为什么单独抽出来：
//   帧格式的正确性（半帧等待、多帧连切、type 校验、长度越界）是协议的核心契约，
//   但 IpcChannel 需要真实的 fd 3 才能构造，端到端测试只能间接覆盖。
//   把「字节 → 消息」的判断逻辑独立成无 I/O 的类，就能用内存字节直接穷举边界：
//   一帧拆成两次到达、两帧粘在一起、畸形 type、越界长度。
//
//   这也是重构：原先 TryTakeFrame / Fill / EnsureWritable / CompactBuffer
//   四个方法揉在 IpcChannel 里，Fill 因此有 7 的 CCN。拆出解码器后，
//   IpcChannel 只负责「从 fd 读字节」，解码器只负责「字节里切帧」。
namespace DshAotRunner;

/// <summary>
/// 从字节缓冲中切出 Node IPC 帧。不持有任何 I/O 句柄。
/// </summary>
/// <remarks>
/// 帧格式（Windows 上 uv_pipe + 阻塞同步 I/O，无 sequence number）：
/// <code>
///   [8 字节 type (LE)][8 字节 payload 长度 (LE)][JSON payload]
/// </code>
/// type 是句柄类型标记：1 = NODE_HANDLE_NORMAL（普通 JSON 消息），
/// 负值表示内部句柄/命令帧，载荷不是 JSON，必须拒绝而不是当 JSON 解析。
/// </remarks>
internal sealed class IpcFrameDecoder
{
    /// <summary>NODE_HANDLE_NORMAL：普通 JSON 消息。</summary>
    public const long NodeHandleNormal = 1;

    /// <summary>帧头长度：type(8) + 长度(8)。</summary>
    public const int HeaderLength = 16;

    /// <summary>
    /// 单帧长度上限。实测 host 的最大消息量级在 MiB 级（3MiB 的 env 是单帧到达），
    /// 8MB 足够覆盖真实场景，同时防止畸形帧声明一个天文数字把内存吃光。
    /// </summary>
    public const long MaxPayloadLength = 8L * 1024 * 1024;

    private byte[] _buffer;
    private int _buffered;
    private int _consumed;

    public IpcFrameDecoder(int initialCapacity = 64 * 1024)
    {
        ArgumentOutOfRangeException.ThrowIfNegativeOrZero(initialCapacity);
        _buffer = new byte[initialCapacity];
    }

    /// <summary>当前缓冲区容量（供测试与诊断断言用）。</summary>
    public int Capacity => _buffer.Length;

    /// <summary>尚未被消费的字节数。</summary>
    public int Available => _buffered - _consumed;

    /// <summary>把新读到的字节追加进缓冲区。</summary>
    public void Append(ReadOnlySpan<byte> data)
    {
        if (data.IsEmpty) return;
        EnsureWritable(data.Length);
        // 直接拷到空闲区间末尾。先 CompactBuffer 保证有连续空间。
        data.CopyTo(_buffer.AsSpan(_buffered));
        _buffered += data.Length;
    }

    /// <summary>
    /// 尝试切出一帧。
    /// </summary>
    /// <param name="payload">帧载荷（UTF-8 解码后的文本）</param>
    /// <returns>切出完整一帧返回 true；数据不足（半帧）返回 false</returns>
    /// <exception cref="IpcProtocolException">
    /// type 不是 NODE_HANDLE_NORMAL，或声明的长度越界。
    /// </exception>
    public bool TryTakeFrame(out string payload)
    {
        payload = string.Empty;
        if (Available < HeaderLength) return false;

        var type = BitConverter.ToInt64(_buffer, _consumed);
        var length = BitConverter.ToInt64(_buffer, _consumed + 8);

        ValidateHeader(type, length);

        // 半帧：头到了但载荷没到齐，等更多数据。
        if (Available < HeaderLength + length) return false;

        payload = System.Text.Encoding.UTF8.GetString(
            _buffer, _consumed + HeaderLength, (int)length);
        _consumed += HeaderLength + (int)length;
        Compact();
        return true;
    }

    /// <summary>
    /// 校验帧头。非法帧在这里就拒绝，不要等到解码载荷时才发现。
    /// </summary>
    /// <exception cref="IpcProtocolException">type 不是 JSON 帧，或长度越界。</exception>
    private static void ValidateHeader(long type, long length)
    {
        // 负值/其它值 = 内部句柄或命令帧，载荷不是 JSON。
        // 冒充 JSON 解析只会得到迷惑性错误，所以明确拒绝。
        if (type != NodeHandleNormal)
            throw new IpcProtocolException($"非 JSON 帧：type={type}（只支持 NODE_HANDLE_NORMAL=1）");

        if (length < 0 || length > MaxPayloadLength)
            throw new IpcProtocolException($"帧长度越界：{length}（上限 {MaxPayloadLength}）");
    }

    /// <summary>缓冲是否已满且仍切不出帧（调用方据此判定畸形帧）。</summary>
    public bool IsFullWithoutFrame => _buffer.Length - _buffered == 0 && Available < HeaderLength;

    /// <summary>确保缓冲区至少还能容纳 <paramref name="needed"/> 字节。</summary>
    private void EnsureWritable(int needed)
    {
        if (_buffer.Length - _buffered >= needed) return;

        // 先把已消费的部分移出去，往往腾出足够空间
        Compact();
        if (_buffer.Length - _buffered >= needed) return;

        // 还不够就扩容，但不超过帧上限的两倍（防止被畸形帧撑爆内存）
        var target = Math.Max(_buffer.Length * 2, _buffered + needed);
        var cap = (int)(MaxPayloadLength + HeaderLength) * 2;
        target = Math.Min(target, Math.Max(cap, _buffered + needed));
        Array.Resize(ref _buffer, target);
    }

    /// <summary>把未消费区间前移到缓冲区开头。</summary>
    private void Compact()
    {
        if (_consumed == 0) return;
        var remaining = _buffered - _consumed;
        if (remaining > 0) Buffer.BlockCopy(_buffer, _consumed, _buffer, 0, remaining);
        _buffered = remaining;
        _consumed = 0;
    }
}

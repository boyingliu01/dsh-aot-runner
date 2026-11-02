// Node IPC 通道 —— 与 DSH host 通信的唯一通道（fd 3）
//
// 为什么需要这个类：DSH host 用 Node 的 child_process 启动 runner，并用
// child.send() / child.on("message") 通信。这条通道在 Windows 上是命名管道，
// 挂在文件描述符 3 上，帧格式由 Node 决定：
//
//   [8 字节 type (LE)][8 字节 payload 长度 (LE)][JSON payload + '\n']
//
// type 字段不是「序号」—— Windows 上 Node 走 uv_pipe + 阻塞同步 I/O，没有
// sequence number。这个字段是句柄类型标记：
//   1  = NODE_HANDLE_NORMAL  → 普通 JSON 消息
//   负值 = 内部句柄/命令帧    → 载荷不是 JSON，必须拒绝
//
// 三个实测出来的行为决定了这里的实现（不要「简化」掉）：
//   1. 一次 ReadFile 可能返回多帧，也可能返回半帧 → 必须缓冲 + 循环切帧
//   2. disconnect 后 ReadFile 返回 (ok=false, got=0, err=109=ERROR_BROKEN_PIPE)，
//      而不是 (ok=true, got=0)。只判 got==0 会让进程在 detach 后永远挂着
//      —— 这正是 Issue #3 修过的坑换个形式复发
//   3. 管道满时 WriteFile 会阻塞，所以写操作必须走已知能被排空的通道
//
// 与 Console.* 无关：真实 host 布局下 fd 0/1/2 是 NUL 设备，
// Console.OpenStandardInput() 读到的是 NUL 的 EOF，而不是 fd 3。
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace DshAotRunner;

/// <summary>
/// fd 3 上的 Node IPC 通道。<see cref="ReadMessage"/> 阻塞读完整帧，
/// <see cref="Send"/> 写入完整帧。
/// </summary>
internal sealed class IpcChannel : IMessageChannel
{
    /// <summary>NODE_HANDLE_NORMAL：普通 JSON 消息。host 发给 runner 的帧都是这个类型。</summary>
    private const long NodeHandleNormal = 1;

    /// <summary>帧头长度：type(8) + 长度(8)。</summary>
    private const int HeaderLength = 16;

    /// <summary>
    /// 单帧长度上限。实测 host 的最大消息量级在 MiB 级（3MiB 的 env 是单帧到达），
    /// 8MB 足够覆盖真实场景，同时防止畸形帧声明一个天文数字把内存吃光。
    /// </summary>
    private const long MaxPayloadLength = 8L * 1024 * 1024;

    /// <summary>单次 ReadFile 的请求量。实际返回量由 OS 决定，可能多帧也可能半帧。</summary>
    private const int ReadChunkSize = 64 * 1024;

    /// <summary>
    /// fd 3 对应的 Win32 句柄。
    /// </summary>
    /// <remarks>
    /// 用裸 IntPtr 而非 SafeFileHandle：这个句柄归 CRT 的 fd 表所有，
    /// 本进程不负责 CloseHandle（由 CRT 在退出时清理）。用 SafeFileHandle
    /// 会制造「谁拥有这个句柄」的歧义，而 ownsHandle:false 的语义又和
    /// Dispose 的意图相互矛盾。
    /// </remarks>
    private readonly IntPtr _handle;
    private readonly object _sendGate = new();

    /// <summary>待切帧的原始字节。索引 [_consumed, _buffered) 是未消费区间。</summary>
    private byte[] _buffer = new byte[ReadChunkSize];
    private int _buffered;
    private int _consumed;

    /// <summary>通道是否已到 EOF（对端关闭）。</summary>
    public bool IsClosed { get; private set; }

    /// <summary>通道建立时记录的诊断信息，方便在 Trace 里回溯。</summary>
    public string Diagnostics { get; }

    /// <param name="fileDescriptor">通常是 3（Node 的 'ipc' 项）。</param>
    public IpcChannel(int fileDescriptor)
    {
        var raw = Native.CrtGetOsFHandle(fileDescriptor);
        if (raw == IntPtr.Zero || raw == new IntPtr(-1))
            throw new InvalidOperationException(
                $"fd {fileDescriptor} 不是有效的管道句柄（Node IPC 通道未建立）");

        _handle = raw;

        var type = Native.GetFileType(raw);
        Diagnostics = $"fd{fileDescriptor} handle=0x{raw.ToInt64():X} fileType={type}";
    }

    /// <summary>
    /// 读取下一条完整消息。
    /// </summary>
    /// <returns>JSON 载荷；通道 EOF 时返回 null。</returns>
    /// <exception cref="IpcProtocolException">帧格式非法（type 错误 / 长度越界）。</exception>
    public string? ReadMessage()
    {
        while (true)
        {
            if (IsClosed) return null;

            // 缓冲区里已经有一帧完整的？
            if (TryTakeFrame(out var payload)) return payload;

            // 没读到足够数据，继续读。
            // 注意：即使缓冲区里已有半帧也要继续读，所以这里不区分「部分数据」和「空」。
            if (!Fill()) return null;
        }
    }

    /// <summary>
    /// 尝试从缓冲区切出一帧完整消息。
    /// </summary>
    private bool TryTakeFrame(out string payload)
    {
        payload = string.Empty;
        var available = _buffered - _consumed;
        if (available < HeaderLength) return false;

        var type = BitConverter.ToInt64(_buffer, _consumed);
        var length = BitConverter.ToInt64(_buffer, _consumed + 8);

        // 负值 = 内部句柄/命令帧，载荷不是 JSON。冒充 JSON 解析只会得到迷惑性错误。
        if (type != NodeHandleNormal)
            throw new IpcProtocolException($"非 JSON 帧：type={type}（只支持 NODE_HANDLE_NORMAL=1）");

        if (length < 0 || length > MaxPayloadLength)
            throw new IpcProtocolException($"帧长度越界：{length}（上限 {MaxPayloadLength}）");

        if (available < HeaderLength + length) return false;   // 半帧，等更多数据

        payload = Encoding.UTF8.GetString(_buffer, _consumed + HeaderLength, (int)length);
        _consumed += HeaderLength + (int)length;
        CompactBuffer();
        return true;
    }

    /// <summary>
    /// 从 fd 3 读一批数据进缓冲区。
    /// </summary>
    /// <returns>读到了数据返回 true；通道 EOF 返回 false（并置 <see cref="IsClosed"/>）。</returns>
    private bool Fill()
    {
        EnsureWritable(ReadChunkSize);

        var space = _buffer.Length - _buffered;
        if (space == 0)
        {
            // 缓冲区满但仍无完整帧 → 帧长度声明超出上限，或者没能切帧
            throw new IpcProtocolException(
                $"读缓冲区已满（{_buffer.Length} 字节）仍无法切出完整帧");
        }

        // 直接读进缓冲区的空闲区间：ReadFile 只写 [0, space)，不会碰已消费区间。
        // 用一个临时数组是因为 P/Invoke 要从数组起始处写，而我们想写到 _buffered 处，
        // 所以这里读小批再拷 —— 64KB 一次，代价可忽略。
        var chunk = new byte[Math.Min(space, ReadChunkSize)];
        var ok = Native.ReadFile(_handle, chunk, (uint)chunk.Length, out var got, IntPtr.Zero);

        if (!ok || got == 0)
        {
            // 关键：disconnect 之后是 (ok=false, err=109)，不是 (ok=true, got=0)。
            // 只判 got==0 会让进程在 detach 后永远挂着（Issue #3 同类问题）。
            var err = System.Runtime.InteropServices.Marshal.GetLastWin32Error();
            var isEof = got == 0
                        || err == Native.ERROR_BROKEN_PIPE
                        || err == Native.ERROR_NO_DATA;

            if (isEof)
            {
                IsClosed = true;
                Trace.Write($"ipc: EOF (ok={ok} got={got} err={err})");
                return false;
            }

            throw new IpcProtocolException($"ReadFile 失败：err={err}");
        }

        Buffer.BlockCopy(chunk, 0, _buffer, _buffered, (int)got);
        _buffered += (int)got;
        return true;
    }

    /// <summary>确保缓冲区至少还能容纳 <paramref name="needed"/> 字节（必要时扩容/前移）。</summary>
    private void EnsureWritable(int needed)
    {
        if (_buffer.Length - _buffered >= needed) return;

        // 先把已消费的部分移出去
        CompactBuffer();
        if (_buffer.Length - _buffered >= needed) return;

        // 还不够就扩容，但不超过帧上限的两倍（防止被畸形帧撑爆内存）
        var target = Math.Max(_buffer.Length * 2, _buffered + needed);
        var cap = (int)(MaxPayloadLength + HeaderLength) * 2;
        target = Math.Min(target, Math.Max(cap, _buffered + needed));
        Array.Resize(ref _buffer, target);
    }

    /// <summary>把未消费区间前移到缓冲区开头。</summary>
    private void CompactBuffer()
    {
        if (_consumed == 0) return;
        var remaining = _buffered - _consumed;
        if (remaining > 0) Buffer.BlockCopy(_buffer, _consumed, _buffer, 0, remaining);
        _buffered = remaining;
        _consumed = 0;
    }

    /// <summary>
    /// 向 host 发送一条消息。<paramref name="json"/> 是不含换行的 JSON 文本。
    /// </summary>
    /// <remarks>
    /// 非线程安全地并发调用会交错写入帧 —— 这里用锁串行化，因为 runner 可能从
    /// 结果线程和错误处理路径同时写。
    /// </remarks>
    public void Send(string json)
    {
        if (IsClosed) return;

        var payload = Encoding.UTF8.GetBytes(json + "\n");
        var frame = new byte[HeaderLength + payload.Length];
        BitConverter.GetBytes(NodeHandleNormal).CopyTo(frame, 0);
        BitConverter.GetBytes((long)payload.Length).CopyTo(frame, 8);
        payload.CopyTo(frame, HeaderLength);

        lock (_sendGate) WriteAll(frame);
    }

    /// <summary>
    /// 把 <paramref name="frame"/> 完整写入通道。
    /// </summary>
    /// <remarks>
    /// WriteFile 在管道上可能只写进去一部分（管道缓冲剩余空间不足时），
    /// 所以必须循环。用 ArraySegment + 拷贝是因为 P/Invoke 签名收的是 byte[]，
    /// 而这里要写的是「同一个数组的中间一段」。
    /// </remarks>
    private void WriteAll(byte[] frame)
    {
        var offset = 0;
        while (offset < frame.Length)
        {
            // 已写入的部分不需要再拷：首轮直接用原数组，续写时构造剩余片段的副本
            var chunk = offset == 0 ? frame : frame[offset..];
            var len = offset == 0 ? (uint)frame.Length : (uint)chunk.Length;

            if (!Native.WriteFile(_handle, chunk, len, out var written, IntPtr.Zero))
            {
                var err = System.Runtime.InteropServices.Marshal.GetLastWin32Error();
                throw new IpcProtocolException($"WriteFile 失败：err={err}");
            }
            if (written == 0)
                throw new IpcProtocolException("WriteFile 返回 0 字节，通道可能已关闭");

            offset += (int)written;
        }
    }

    /// <summary>
    /// 关闭通道。
    /// </summary>
    /// <remarks>
    /// 投递完终态结果后必须调用：host 侧的 settleRange 会等 ipcDisconnected 置位才收尾。
    /// 注意 _handle 的 ownsHandle 是 false（句柄归 CRT 的 fd 表），
    /// 所以这里不 CloseHandle，只解除本对象的引用并停止后续读写。
    /// </remarks>
    public void Dispose()
    {
        IsClosed = true;
        // 不 CloseHandle：句柄归 CRT fd 表（_get_osfhandle 返回的是表里的引用），
        // 由 CRT 在进程退出时统一清理。提前关掉会让 fd 3 处于半关闭状态。
    }
}

/// <summary>IPC 帧格式非法或通道 I/O 失败。</summary>
internal sealed class IpcProtocolException : Exception
{
    public IpcProtocolException(string message) : base(message) { }
}

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
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace DshAotRunner;

/// <summary>
/// IPC 通道的底层 I/O 抽象。
/// </summary>
/// <remarks>
/// <para>
/// 存在的唯一理由是<b>可测试性</b>：<see cref="IpcChannel"/> 的三个真实缺陷形态
/// （一次读返回多帧 / 返回半帧 / detach 后返回 ERROR_PIPE_NOT_CONNECTED）
/// 在真实管道上极难构造，而它们一旦出错就是「消息丢失」或「进程挂死」。
/// </para>
/// <para>
/// 生产路径只有 <see cref="Win32ChannelIo"/> 一个实现；测试里换成内存实现，
/// 就能精确炮制任意分块边界与错误码，而不需要真实 fd 3。
/// </para>
/// </remarks>
internal interface IChannelIo
{
    /// <summary>读一批数据到 <paramref name="buffer"/>。</summary>
    /// <returns>(是否成功, 读到的字节数, Win32 错误码)。</returns>
    (bool Ok, uint Got, int Error) Read(byte[] buffer);

    /// <summary>写<b>全部</b>字节；返回实际写入的字节数（可能小于请求量）。</summary>
    /// <returns>(是否成功, 写入的字节数, Win32 错误码)。</returns>
    (bool Ok, uint Written, int Error) Write(byte[] buffer, int offset, int count);
}

/// <summary>生产实现：直接调 kernel32 的 ReadFile / WriteFile。</summary>
internal sealed class Win32ChannelIo : IChannelIo
{
    private readonly IntPtr _handle;

    public Win32ChannelIo(IntPtr handle) => _handle = handle;

    public (bool Ok, uint Got, int Error) Read(byte[] buffer)
    {
        // cast-audit:ignore buffer.Length 是数组长度，CLR 保证非负且不超过 int.MaxValue
        var ok = Native.ReadFile(_handle, buffer, (uint)buffer.Length, out var got, IntPtr.Zero);
        // 失败时才读 LastError：成功路径上 GetLastWin32Error 的值无意义，
        // 提前读会拿到上一次调用的残留错误码，把「成功」误判成 EOF。
        return (ok, got, ok ? 0 : Marshal.GetLastWin32Error());
    }

    public (bool Ok, uint Written, int Error) Write(byte[] buffer, int offset, int count)
    {
        var chunk = offset == 0 && count == buffer.Length ? buffer : buffer[offset..(offset + count)];
        // cast-audit:ignore chunk 是数组切片，Length 非负且不超过 int.MaxValue
        var ok = Native.WriteFile(_handle, chunk, (uint)chunk.Length, out var written, IntPtr.Zero);
        return (ok, written, ok ? 0 : Marshal.GetLastWin32Error());
    }
}

/// <summary>
/// fd 3 上的 Node IPC 通道。<see cref="ReadMessage"/> 阻塞读完整帧，
/// <see cref="Send"/> 写入完整帧。
/// </summary>
internal sealed class IpcChannel : IMessageChannel
{
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
    private readonly IChannelIo _io;
    private readonly object _sendGate = new();

    /// <summary>帧切分逻辑（纯字节处理），与 I/O 分离以便单独测试。</summary>
    private readonly IpcFrameDecoder _decoder = new(ReadChunkSize);

    /// <summary>通道是否已到 EOF（对端关闭）。</summary>
    public bool IsClosed { get; private set; }

    /// <summary>通道建立时记录的诊断信息，方便在 Trace 里回溯。</summary>
    public string Diagnostics { get; }

    /// <param name="fileDescriptor">通常是 3（Node 的 'ipc' 项）。</param>
    public IpcChannel(int fileDescriptor)
        : this(Native.CrtGetOsFHandle(fileDescriptor), fileDescriptor)
    {
    }

    /// <summary>
    /// 从**已解析的**句柄构造。
    /// </summary>
    /// <remarks>
    /// 把「怎么从 fd 拿到句柄」与「拿到句柄之后怎么用」拆开，是为了让后者可测：
    /// 直接调 <see cref="IpcChannel(int)"/> 需要真实 fd 3，且探错未分配的 fd 会让
    /// CRT abort 整个进程。这个重载只收句柄，测试就能传任意值
    /// （包括 IntPtr.Zero）来验证校验分支，而不碰 CRT。
    /// </remarks>
    internal IpcChannel(IntPtr raw, int fileDescriptor = -1)
    {
        if (raw == IntPtr.Zero || raw == new IntPtr(-1))
            throw new InvalidOperationException(
                $"fd {fileDescriptor} 不是有效的管道句柄（Node IPC 通道未建立）");

        _handle = raw;
        _io = new Win32ChannelIo(raw);

        var type = Native.GetFileType(raw);
        Diagnostics = $"fd{fileDescriptor} handle=0x{raw.ToInt64():X} fileType={type}";
    }

    /// <summary>
    /// 测试专用构造：直接注入底层 I/O，不碰任何 Win32 句柄。
    /// </summary>
    /// <remarks>
    /// 用 <c>internal</c> 而非 public：生产代码不应该有第二条构造路径
    /// （建议 <see cref="IpcChannel(int)"/> 之外再暴露一个，容易被误用）。
    /// </remarks>
    internal IpcChannel(IChannelIo io, string diagnostics = "injected")
    {
        _handle = IntPtr.Zero;
        _io = io;
        Diagnostics = diagnostics;
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
            if (_decoder.TryTakeFrame(out var payload)) return payload;

            // 没读到足够数据，继续读。
            // 注意：即使缓冲区里已有半帧也要继续读，所以这里不区分「部分数据」和「空」。
            if (!Fill()) return null;
        }
    }

    /// <summary>
    /// 从 fd 3 读一批数据交给解码器。
    /// </summary>
    /// <returns>读到了数据返回 true；通道 EOF 返回 false（并置 <see cref="IsClosed"/>）。</returns>
    private bool Fill()
    {
        var chunk = new byte[ReadChunkSize];
        var (ok, got, err) = _io.Read(chunk);

        if (ok && got > 0)
        {
            // cast-audit:ignore got 是 ReadFile 实际读到的字节数，不会超过 chunk.Length
            _decoder.Append(chunk.AsSpan(0, (int)got));
            return true;
        }

        // 关键：disconnect 之后是 (ok=false, err=109)，不是 (ok=true, got=0)。
        // 只判 got==0 会让进程在 detach 后永远挂着（Issue #3 同类问题）。
        if (IsEndOfStream(ok, got, err))
        {
            IsClosed = true;
            Trace.Write($"ipc: EOF (ok={ok} got={got} err={err})");
            return false;
        }

        throw new IpcProtocolException($"ReadFile 失败：err={err}");
    }

    /// <summary>
    /// 这批读结果是否代表通道正常结束（对端关闭）。
    /// </summary>
    /// <remarks>
    /// <para>
    /// <b>EOF 的判定必须区分 ok。</b>「读成功 + 0 字节」是干净关闭；
    /// 「读失败」只有在错误码属于「对端已不可用」时才算 EOF
    /// （ERROR_BROKEN_PIPE / ERROR_NO_DATA / ERROR_PIPE_NOT_CONNECTED）。
    /// 早期版本丢掉了 ok，只看 <c>got == 0</c> 就判 EOF ——
    /// 于是 <c>ACCESS_DENIED</c> 这类真错误被伪装成正常关闭，
    /// 后果是「通道坏了但没人知道」。
    /// </para>
    /// <para>
    /// <b>这里修过一个真缺陷</b>：原实现只判 232，而 host detach 后管道真正返回的是
    /// <b>233</b>。232 与 233 是两个不同的 Win32 码，原注释写 233、常量定义 232，
    /// 两者矛盾却没人发现 —— 因为这行当时<b>零测试覆盖</b>。后果是 detach 后
    /// runner 抛异常而非正常收尾，属 Issue #3 那类问题的复发形态。
    /// </para>
    /// <para>
    /// 改成 internal 是为了让 <c>IpcChannelIoSeamTests</c> 逐个错误码断言，
    /// 新增码必须同时补用例。
    /// </para>
    /// 单独成方法是因为它是「哪些 Win32 状态算正常关闭」的知识点，
    /// 和「读到数据怎么处理」不是同一层关注点。
    /// </remarks>
    internal static bool IsEndOfStream(bool ok, uint got, int err)
    {
        // 读成功且拿到 0 字节 = 干净的 EOF（对端正常关闭）。
        if (ok) return got == 0;

        // 读失败：只有「对端已不可用」这一类错误码才算 EOF。
        // 其余错误码（ACCESS_DENIED / INVALID_PARAMETER …）是通道真的坏了，
        // 必须抛出，否则会被伪装成「正常关闭」，让上层以为 host 主动断开。
        return err == Native.ERROR_BROKEN_PIPE
            || err == Native.ERROR_NO_DATA
            || err == Native.ERROR_PIPE_NOT_CONNECTED;
    }

    /// <summary>
    /// <summary>
    /// 把一条 JSON 文本封装成 Node IPC 帧。
    /// </summary>
    /// <remarks>
    /// 抽成 internal static 是为了能脱离真实通道断言字节布局：
    /// type 恒为 <see cref="IpcFrameDecoder.NodeHandleNormal"/>（LE 8 字节）、
    /// 长度为<b>字节数</b>而非字符数（UTF-8 下中文是 3 字节）——
    /// 后者写错会让 host 按错误长度切帧，切在半个汉字上。
    /// </remarks>
    internal static byte[] BuildFrame(string json)
    {
        var payload = Encoding.UTF8.GetBytes(json + "\n");
        var frame = new byte[IpcFrameDecoder.HeaderLength + payload.Length];
        BitConverter.GetBytes(IpcFrameDecoder.NodeHandleNormal).CopyTo(frame, 0);
        BitConverter.GetBytes((long)payload.Length).CopyTo(frame, 8);
        payload.CopyTo(frame, IpcFrameDecoder.HeaderLength);
        return frame;
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

        var frame = BuildFrame(json);

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
            offset += WriteChunk(chunk);
        }
    }

    /// <summary>
    /// 写一段并返回实际写入的字节数。
    /// </summary>
    /// <remarks>
    /// 独立成方法是为了把「WriteFile 的两种失败形态」的判断收在一处：
    /// 返回 false（带 Win32 错误码）和返回 true 但写了 0 字节（通道已关）。
    /// 循环本身只关心「这轮推进了多少」。
    /// </remarks>
    private int WriteChunk(byte[] chunk)
    {
        var (ok, written, err) = _io.Write(chunk, 0, chunk.Length);
        if (!ok)
        {
            throw new IpcProtocolException($"WriteFile 失败：err={err}");
        }
        if (written == 0)
            throw new IpcProtocolException("WriteFile 返回 0 字节，通道可能已关闭");

        // cast-audit:ignore written 是 WriteFile 实际写入的字节数，不超过 chunk.Length
        return (int)written;
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

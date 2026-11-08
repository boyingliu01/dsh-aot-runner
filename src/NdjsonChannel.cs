// NDJSON over stdin/stdout —— 仅用于调试（--ndjson）
//
// 为什么保留这条路：手工驱动 runner 时（不通过 Node 的 child_process）
// 很难构造带 fd 3 的 IPC 通道。NDJSON 可以用 echo 直接喂、用管道直接看，
// 排查 Job Object / fd 4-7 的行为时非常方便。
//
// **它不是生产通道**：真实 host 给的是 ['ignore','ignore','ignore','ipc',...]，
// fd 0/1/2 都是 NUL 设备，NDJSON 根本收不到东西。生产必须走 IpcChannel。
using System.Text;

namespace DshAotRunner;

/// <summary>stdin/stdout 上的行分隔 JSON 通道。调试专用。</summary>
internal sealed class NdjsonChannel : IMessageChannel
{
    private readonly LineReader _reader;
    private readonly Stream _out;
    private readonly object _sendGate = new();

    public string Diagnostics { get; }

    public NdjsonChannel()
        : this(Console.OpenStandardInput(), Console.OpenStandardOutput())
    {
    }

    /// <summary>
    /// 测试专用构造：注入任意输入/输出流。
    /// </summary>
    /// <remarks>
    /// 生产路径固定用 stdin/stdout；但那样一来 Send/ReadMessage 就无法在不劫持
    /// 真实控制台的前提下测试。DSH 的 --ndjson 是调试入口，恰恰是最容易被随手改坏、
    /// 又最难被端到端覆盖的一块，所以给它留一条流注入的路径。
    /// </remarks>
    internal NdjsonChannel(Stream input, Stream output)
    {
        _out = output;
        _reader = new LineReader(input);
        Diagnostics = "--ndjson mode: stdin/stdout (debug only, NOT for production host)";
    }

    public string? ReadMessage() => _reader.ReadLine();

    public void Send(string json)
    {
        var bytes = Encoding.UTF8.GetBytes(json + "\n");
        lock (_sendGate)
        {
            _out.Write(bytes, 0, bytes.Length);
            _out.Flush();
        }
    }

    public void Dispose()
    {
        try { _out.Flush(); } catch { /* ignore */ }
    }
}

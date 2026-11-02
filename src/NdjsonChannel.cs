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
    {
        var stdin = Console.OpenStandardInput();
        _out = Console.OpenStandardOutput();
        _reader = new LineReader(stdin);
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

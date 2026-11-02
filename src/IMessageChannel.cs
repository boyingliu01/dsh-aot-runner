// 与 host 通信的通道抽象
//
// 生产路径只有 IpcChannel（Node IPC / fd 3）。抽出接口是为了让 --ndjson
// 调试模式能在不触碰生产实现的前提下复用同一套主循环 —— 而不是在主循环里
// 塞 if (debug) 分支。
namespace DshAotRunner;

/// <summary>runner 与 host 之间的消息通道。</summary>
internal interface IMessageChannel : IDisposable
{
    /// <summary>读取下一条消息；通道结束时返回 null。</summary>
    string? ReadMessage();

    /// <summary>发送一条消息。</summary>
    void Send(string json);

    /// <summary>通道建立时记录的诊断信息。</summary>
    string Diagnostics { get; }
}

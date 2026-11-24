// IPC 读线程 —— 把通道消息搬进一个有界队列。
//
// 为什么独立成类：这是一个**完整的并发边界**，不是零散的辅助方法。
// 主线程要能在 terminate 后 ≤50ms 内退出，就绝不能自己去阻塞读通道
// （Issue #3 实测：每次 terminate 泄漏一个 runner）。于是读和分发必须分开：
// 读线程只负责「把消息搬进 inbox」，主循环只负责「从 inbox 取、判断该不该退」。
//
// 这个类只做前者。它不认识 JobRunner 的任何状态，只认一个 IMessageChannel
// 和一个 BlockingCollection —— 因此可以在没有 runner 的情况下单独测试。
using System.Collections.Concurrent;

namespace DshAotRunner;

/// <summary>把通道消息（含 EOF 的 null）搬进队列的后台读线程。</summary>
internal static class IpcReader
{
    /// <summary>
    /// 启动读线程。返回的线程是后台线程，进程退出不会被它拖住。
    /// </summary>
    /// <remarks>
    /// 线程体里既有正常读取循环，又有异常转换（读失败等同 EOF）——
    /// 后者很重要：帧非法或 I/O 错误时不抛给调用方，而是**投递一个 null**
    /// 结束队列并留下 trace，这样主循环看到的终止条件只有一种（null）。
    /// 若让它抛出去，主线程会在 TryTake 的 50ms 超时里空转到天荒地老。
    /// </remarks>
    internal static Thread Start(IMessageChannel channel, BlockingCollection<string?> inbox)
    {
        var readerThread = new Thread(() => ReadLoop(channel, inbox))
        {
            IsBackground = true,
            Name = "ipc-reader",
        };
        readerThread.Start();
        return readerThread;
    }

    private static void ReadLoop(IMessageChannel channel, BlockingCollection<string?> inbox)
    {
        try
        {
            while (true)
            {
                var message = channel.ReadMessage();
                inbox.Add(message);
                if (message is null) break;      // EOF 之后不再产出
            }
        }
        catch (Exception ex)
        {
            // 读失败（帧非法或 I/O 错误）等同于通道结束，但要留下痕迹
            Trace.Write($"ipc reader stopped: {ex.GetType().Name}: {ex.Message}");
            inbox.Add(null);
        }
    }
}

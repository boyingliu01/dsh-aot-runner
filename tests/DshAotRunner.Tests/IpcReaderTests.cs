using System.Collections.Concurrent;
using Xunit;

namespace DshAotRunner.Tests;

/// <summary>
/// <see cref="IpcReader"/> 的行为测试。
/// </summary>
/// <remarks>
/// 这个类承载的是「读通道 → 投递 inbox」这条并发边界，它决定了主循环能否
/// 在 terminate 后 ≤50ms 内退出（Issue #3）。最关键的一条不变量是：
/// **无论读通道是正常 EOF 还是抛异常，inbox 都恰好收到一个 null 作为终止信号。**
/// 若异常路径漏投 null，主循环会永远空转在 TryTake(50ms) 超时上。
/// </remarks>
public sealed class IpcReaderTests
{
    [Fact]
    public void Start_正常EOF_投递消息后以null结束()
    {
        var channel = new ScriptedChannel("a", "b", null);
        using var inbox = new BlockingCollection<string?>();

        var thread = IpcReader.Start(channel, inbox);
        thread.Join(TimeSpan.FromSeconds(5));

        var got = new List<string?>();
        while (inbox.TryTake(out var m, TimeSpan.FromSeconds(1))) got.Add(m);

        Assert.Equal(new string?[] { "a", "b", null }, got);
    }

    [Fact]
    public void Start_读通道抛异常_仍投递null且不静默()
    {
        // 读失败（帧非法 / I/O 错误）必须等同于 EOF：
        // 投一个 null 让主循环退出，而不是让异常逃出读线程 ——
        // 逃出去的话主线程什么也收不到，只能靠超时空转，表现为「调用卡住」。
        var channel = new ScriptedChannel { ThrowAfter = 0 };
        using var inbox = new BlockingCollection<string?>();

        var thread = IpcReader.Start(channel, inbox);
        thread.Join(TimeSpan.FromSeconds(5));

        Assert.True(inbox.TryTake(out var message, TimeSpan.FromSeconds(1)), "异常后应仍投递终止信号");
        Assert.Null(message);
    }

    [Fact]
    public void Start_返回后台线程()
    {
        // 后台线程：进程退出不该被一个阻塞在 ReadFile 上的读线程拖住。
        var channel = new ScriptedChannel("x", null);
        using var inbox = new BlockingCollection<string?>();

        var thread = IpcReader.Start(channel, inbox);

        Assert.True(thread.IsBackground);
        Assert.Equal("ipc-reader", thread.Name);
        thread.Join(TimeSpan.FromSeconds(5));
    }

    /// <summary>按脚本产出消息的通道；可配置在第几条之后抛异常。</summary>
    private sealed class ScriptedChannel : IMessageChannel
    {
        private readonly Queue<string?> _queue = new();

        public ScriptedChannel(params string?[] messages)
        {
            foreach (var m in messages) _queue.Enqueue(m);
        }

        public int? ThrowAfter { get; init; }

        public string Diagnostics => "scripted";

        public string? ReadMessage()
        {
            if (ThrowAfter is int limit && _queue.Count <= limit)
            {
                throw new IOException("broken pipe");
            }
            return _queue.Count > 0 ? _queue.Dequeue() : null;
        }

        public void Send(string json) { }

        public void Dispose() { }
    }
}

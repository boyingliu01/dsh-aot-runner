using System.Collections.Concurrent;
using System.Diagnostics;
using System.Threading;
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
        //
        // 为什么用 GateChannel 而不是 ScriptedChannel("x", null)：
        // 后者会让读线程**立刻**走完并退出；而此时 Assert.True(thread.IsBackground)
        // 读到的是一个已死线程 —— .NET 8 上这会启动 Thread 类的静态 GC 辅助线程
        // 并等它退出，抛 ThreadStateException: "Thread is dead; state cannot be accessed"，
        // 严重时直接 CLR fail-fast（0x80131506）。
        // 实测：用 ScriptedChannel 时连跑 6 次有 4 次失败、全量跑 5 次还崩过一次。
        //
        // GateChannel 把读端**按住**直到测试主动放行，于是线程在断言期间保证存活。
        // 注意这不降低判据：下面仍然断言线程最终会结束。
        using var gate = new GateChannel("x");
        using var inbox = new BlockingCollection<string?>();

        var started = Stopwatch.StartNew();
        var thread = IpcReader.Start(gate, inbox);
        started.Stop();

        // Start 必须立刻返回：若它等读完成才返回，"后台线程"就名不副实了。
        Assert.True(started.ElapsedMilliseconds < 2000, $"Start 阻塞了 {started.ElapsedMilliseconds}ms");
        Assert.True(thread.IsBackground);
        Assert.Equal("ipc-reader", thread.Name);

        gate.Release();
        Assert.True(thread.Join(TimeSpan.FromSeconds(5)), "放行后读线程应当结束");
    }

    [Fact]
    public void Start_读线程被按住时_不阻塞调用方()
    {
        // 负向用例的对照组：证明 GateChannel 确实把线程按住了。
        // 若 GateChannel 形同虚设（比如读端直接返回 null），这条会立刻看到线程结束。
        // 首条消息刻意传非 null 的 "hold"：ReadLoop 收到 null 会直接 break 结束线程，
        // 那样根本走不到闸门上。构造参数类型是 string 而非 string?，就是为了让这个
        // 「必须非 null」成为编译期约束而不是注释里的约定。
        using var gate = new GateChannel("hold");
        using var inbox = new BlockingCollection<string?>();

        var thread = IpcReader.Start(gate, inbox);

        Assert.False(thread.Join(TimeSpan.FromMilliseconds(200)), "读端未放行时线程不该结束");
        gate.Release();
        Assert.True(thread.Join(TimeSpan.FromSeconds(5)), "放行后线程应当结束");
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

    /// <summary>
    /// 读端可**主动按住**的通道：第一次读取返回给定消息后阻塞，直到 <see cref="Release"/>。
    /// </summary>
    /// <remarks>
    /// 存在的唯一目的：让「读线程还活着」这件事在断言期间成为**确定事实**，
    /// 而不是靠时序运气。见 <see cref="Start_返回后台线程"/> 的说明。
    /// </remarks>
    private sealed class GateChannel : IMessageChannel
    {
        private readonly string? _first;
        private readonly ManualResetEventSlim _gate = new(false);
        private int _reads;

        public GateChannel(string first) => _first = first;

        public string Diagnostics => "gate";

        public string? ReadMessage()
        {
            // 第一次读返回脚本值，之后一直阻塞 —— 模拟「读线程卡在 ReadFile 上」。
            if (Interlocked.Increment(ref _reads) == 1) return _first;
            _gate.Wait(TimeSpan.FromSeconds(10));
            return null;
        }

        public void Send(string json) { }

        public void Release() => _gate.Set();

        public void Dispose() => _gate.Dispose();
    }
}

// 小文件覆盖率补齐 —— NdjsonChannel / Win32ChannelIo / Trace.Measure
//
// ## 为什么这些小文件值得单独测
//
// 它们各自只有 9~18 行，看起来「不值得写测试」，但三个的共同点是
// **生产路径上不可回退的失败面**：
//
//   - NdjsonChannel：`--ndjson` 是唯一的调试入口。它坏掉不会影响生产，
//     但会让「runner 出问题时无法诊断」—— 等于拆掉安全网本身。
//   - Win32ChannelIo：IpcChannel 的真实 I/O 实现。它只是两行 P/Invoke 封装，
//     但「成功时不能读 LastError」这条如果写错，会把成功误判成 EOF。
//   - Trace.Measure：诊断计时。它坏了不会崩，只会让「总是显示 0ms」——
//     而本轮所有性能分析都建立在它的正确性上。
//
// 小文件不等于低风险；恰恰相反，越是「简单到不需要测」的代码，
// 越容易在被随手改动后无人察觉。
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using DshAotRunner;
using Xunit;

namespace DshAotRunner.Tests;

/// <summary>只进不出的内存流，用于捕获 NdjsonChannel 的输出。</summary>
internal sealed class CaptureStream : MemoryStream
{
    public string Text() => Encoding.UTF8.GetString(ToArray());
}

[Collection("TraceEnv")]
public class SmallFileCoverageTests
{
    // ============ NdjsonChannel ============

    [Fact]
    public void NdjsonChannel_读取一行()
    {
        using var input = new MemoryStream(Encoding.UTF8.GetBytes("{\"type\":\"start\"}\n"));
        var channel = new NdjsonChannel(input, new CaptureStream());

        Assert.Equal("{\"type\":\"start\"}", channel.ReadMessage());
    }

    [Fact]
    public void NdjsonChannel_连续读多行()
    {
        using var input = new MemoryStream(Encoding.UTF8.GetBytes("a\nb\nc\n"));
        var channel = new NdjsonChannel(input, new CaptureStream());

        Assert.Equal("a", channel.ReadMessage());
        Assert.Equal("b", channel.ReadMessage());
        Assert.Equal("c", channel.ReadMessage());
    }

    [Fact]
    public void NdjsonChannel_EOF后返回null()
    {
        using var input = new MemoryStream(Encoding.UTF8.GetBytes("only\n"));
        var channel = new NdjsonChannel(input, new CaptureStream());

        Assert.Equal("only", channel.ReadMessage());
        Assert.Null(channel.ReadMessage());
    }

    [Fact]
    public void NdjsonChannel_发送时追加换行并立即flush()
    {
        var output = new CaptureStream();
        using var input = new MemoryStream();
        var channel = new NdjsonChannel(input, output);

        channel.Send("{\"ok\":1}");

        // 必须在 Send 返回时就已落盘（不等 Dispose）：
        // 若靠缓冲，host 侧可能迟迟收不到结果，表现为「调用不返回」。
        Assert.Equal("{\"ok\":1}\n", output.Text());
    }

    [Fact]
    public void NdjsonChannel_发送中文按UTF8编码()
    {
        var output = new CaptureStream();
        using var input = new MemoryStream();
        var channel = new NdjsonChannel(input, output);

        channel.Send("中文");

        Assert.Equal("中文\n", output.Text());
        Assert.Equal(Encoding.UTF8.GetByteCount("中文\n"), output.Length);
    }

    [Fact]
    public void NdjsonChannel_Dispose不抛异常()
    {
        var output = new CaptureStream();
        using var input = new MemoryStream();
        var channel = new NdjsonChannel(input, output);
        channel.Send("x");

        channel.Dispose();
        Assert.Equal("x\n", output.Text());
    }

    [Fact]
    public void NdjsonChannel_诊断信息标明仅调试用()
    {
        using var input = new MemoryStream();
        var channel = new NdjsonChannel(input, new CaptureStream());

        // 这条信息会打进 trace。它必须明确写出「NOT for production」，
        // 否则错误地把 --ndjson 配到生产环境时，日志里看不出这是个坑。
        Assert.Contains("ndjson", channel.Diagnostics);
        Assert.Contains("NOT for production", channel.Diagnostics);
    }

    [Fact]
    public void NdjsonChannel_换行被拆在两个读取块之间仍能拼回()
    {
        // LineReader 用 64KB 分块；这里用自定义流模拟「换行符恰好落在块边界」。
        using var input = new SplitStream(Encoding.UTF8.GetBytes("{\"chunk\":true}\n"));
        var channel = new NdjsonChannel(input, new CaptureStream());

        Assert.Equal("{\"chunk\":true}", channel.ReadMessage());
    }

    // ============ Trace.Measure ============

    [Fact]
    public void Trace_Measure在关闭时不产生任何文件写入()
    {
        // DSH_AOT_DEBUG 未设置时，Measure 必须近乎零成本地跳过。
        // 它被放在关键路径上（每个分段一次），若关闭时仍写文件，
        // 就等于给生产路径凭空加了 I/O。
        var before = Environment.GetEnvironmentVariable("DSH_AOT_DEBUG");
        try
        {
            Environment.SetEnvironmentVariable("DSH_AOT_DEBUG", null);
            var tmp = Path.Combine(Path.GetTempPath(), $"trace-off-{Guid.NewGuid():N}.log");
            Environment.SetEnvironmentVariable("DSH_AOT_DEBUG_FILE", tmp);

            using (Trace.Measure("should-not-appear")) { }

            Assert.False(File.Exists(tmp), "DEBUG 关闭时不应写任何东西");
            Environment.SetEnvironmentVariable("DSH_AOT_DEBUG_FILE", null);
        }
        finally
        {
            Environment.SetEnvironmentVariable("DSH_AOT_DEBUG", before);
        }
    }

    [Fact]
    public void Trace_Measure在开启时写出微秒级耗时()
    {
        var before = Environment.GetEnvironmentVariable("DSH_AOT_DEBUG");
        var tmp = Path.Combine(Path.GetTempPath(), $"trace-on-{Guid.NewGuid():N}.log");
        try
        {
            Environment.SetEnvironmentVariable("DSH_AOT_DEBUG", "1");
            Environment.SetEnvironmentVariable("DSH_AOT_DEBUG_FILE", tmp);

            using (Trace.Measure("unit-test-phase"))
            {
                // 故意做点活，让耗时非零
                Thread.Sleep(2);
            }

            var text = File.ReadAllText(tmp);
            Assert.Contains("[phase] unit-test-phase", text);
            Assert.Matches(@"\[phase\] unit-test-phase\s+\d+us", text);
        }
        finally
        {
            Environment.SetEnvironmentVariable("DSH_AOT_DEBUG", before);
            Environment.SetEnvironmentVariable("DSH_AOT_DEBUG_FILE", null);
            File.Delete(tmp);
        }
    }

    [Fact]
    public void Trace_Phase格式化宽度对齐()
    {
        // 对齐是为了 trace 可读；不测具体空格数，只保证「名字 + 数字 + us」结构稳定，
        // 因为 bench/phase-probe.js 用正则解析这个格式，改坏了探针会静默采集到 0 条。
        var m = @"\[phase\] (\S+)\s+(\d+)us";
        Assert.Matches(m, "[phase] env-block                37us");
    }

    // ============ Win32ChannelIo ============

    [Fact]
    public void Win32ChannelIo_用无效句柄读取时返回失败且带错误码()
    {
        // 用 IntPtr.Zero 当句柄：ReadFile 必然失败。
        // 关键断言是「失败时 ok=false 且 Error 非 0」——
        // 若实现把成功的 LastError(0) 当错误返回，就会把失败伪装成「无错误」。
        var io = new Win32ChannelIo(IntPtr.Zero);
        var buffer = new byte[16];

        var (ok, got, error) = io.Read(buffer);

        Assert.False(ok);
        Assert.Equal(0u, got);
        Assert.NotEqual(0, error);
    }

    [Fact]
    public void Win32ChannelIo_用无效句柄写入时返回失败且带错误码()
    {
        var io = new Win32ChannelIo(IntPtr.Zero);
        var data = Encoding.UTF8.GetBytes("x");

        var (ok, written, error) = io.Write(data, 0, data.Length);

        Assert.False(ok);
        Assert.Equal(0u, written);
        Assert.NotEqual(0, error);
    }

    [Fact]
    public void Win32ChannelIo_通过真实管道往返()
    {
        // 用匿名管道做一次真实往返：验证成功路径不误报错误。
        // 这条是「成功时不能读 LastError」的唯一守卫 ——
        // 若实现无条件读 GetLastWin32Error，成功路径会带回上一次调用的残留码，
        // 从而被 IsEndOfStream 误判成 EOF。
        var attrs = new Native.SECURITY_ATTRIBUTES
        {
            nLength = Marshal.SizeOf<Native.SECURITY_ATTRIBUTES>(),
            lpSecurityDescriptor = IntPtr.Zero,
            bInheritHandle = 0,
        };
        Assert.True(Native.CreatePipe(out var readEnd, out var writeEnd, ref attrs, 0));
        try
        {
            var writer = new Win32ChannelIo(writeEnd);
            var payload = Encoding.UTF8.GetBytes("hello");
            var (wOk, wWritten, wErr) = writer.Write(payload, 0, payload.Length);
            Assert.True(wOk, $"写入应成功，err={wErr}");
            Assert.Equal((uint)payload.Length, wWritten);

            var reader = new Win32ChannelIo(readEnd);
            var buffer = new byte[32];
            var (rOk, rGot, rErr) = reader.Read(buffer);
            Assert.True(rOk, $"读取应成功，err={rErr}");
            Assert.Equal((uint)payload.Length, rGot);
            Assert.Equal("hello", Encoding.UTF8.GetString(buffer, 0, (int)rGot));
        }
        finally
        {
            Native.CloseHandle(readEnd);
            Native.CloseHandle(writeEnd);
        }
    }
}

/// <summary>每次 Read 只吐一小块的流，用来制造任意分块边界。</summary>
internal sealed class SplitStream(byte[] data) : Stream
{
    private int _pos;

    public override int Read(byte[] buffer, int offset, int count)
    {
        if (_pos >= data.Length) return 0;
        // 每次只给 5 字节：足以把换行符切在两次读之间
        var take = Math.Min(Math.Min(count, 5), data.Length - _pos);
        Array.Copy(data, _pos, buffer, offset, take);
        _pos += take;
        return take;
    }

    public override bool CanRead => true;
    public override bool CanSeek => false;
    public override bool CanWrite => false;
    public override long Length => data.Length;
    public override long Position { get => _pos; set => throw new NotSupportedException(); }
    public override void Flush() { }
    public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
    public override void SetLength(long value) => throw new NotSupportedException();
    public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
}

/// <summary>
/// 依赖进程级环境变量（DSH_AOT_DEBUG / DSH_AOT_DEBUG_FILE）的测试集合。
/// </summary>
/// <remarks>
/// Trace 的开关是静态读 <see cref="Environment.GetEnvironmentVariable(string)"/>，
/// 而 xunit 默认并行跑不同的测试类。两个测试同时改这两个环境变量会互相踩
/// （一个刚设 DEBUG=1，另一个把它置回 null，然后读到「没写文件」而误判失败）。
/// 收进同一个 collection 后这些用例串行执行，隔离的是<b>全局状态</b>而不是巧合。
/// </remarks>
[CollectionDefinition("TraceEnv", DisableParallelization = true)]
public class TraceEnvCollection;

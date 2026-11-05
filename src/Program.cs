// 入口：解析 argv，接线 IPC 通道与 FD 4/5/6，启动 JobRunner
using System.Text;

namespace DshAotRunner;

internal static class Program
{
    private const string EnvSelector = "DSH_SUBPROCESS_RUNNER";

    /// <summary>Node IPC 通道所在的文件描述符（spawn 的 stdio[3] === 'ipc'）。</summary>
    private const int IpcFileDescriptor = 3;

    /// <summary>调试开关：改用 NDJSON over stdin，便于手工驱动（不用于生产）。</summary>
    private const string NdjsonFlag = "--ndjson";

    private static int Main(string[] rawArgs)
    {
        // 顶层兜底：StackTraceSupport=false 后未捕获异常会静默崩溃且无堆栈，
        // host 侧只能看到"runner 异常退出"。这里统一转成协议 error 对象。
        try
        {
            return RunCore(rawArgs);
        }
        catch (Exception ex)
        {
            try { EmitProtocolError($"runner crashed: {ex.GetType().Name}", "ERUNNER", null); } catch { }
            return 70; // EX_SOFTWARE
        }
    }

    private static int RunCore(string[] rawArgs)
    {
        Trace.Write($"enter: rawArgs=[{string.Join("|", rawArgs)}]");

        // 消费私有选择器（对齐 runnerEnvironment 行为）
        try { Environment.SetEnvironmentVariable(EnvSelector, null); } catch { }

        var (argv, ndjson) = ArgParsing.ParseArgs(rawArgs, NdjsonFlag);
        Trace.Write($"parsed argv=[{string.Join("|", argv)}] ndjson={ndjson}");

        if (argv.Length == 0 || string.IsNullOrEmpty(argv[0]))
        {
            // RUNNER-SPEC §2：argv[0] 缺失 → 立即报错退出
            EmitProtocolError("invalid argv: expected a non-empty program name at argv[0]", "EINVAL", null);
            return 127;
        }

        // FD 4/5/6 是 host 在 spawn 时按位号传进来的 target 通道；
        // FD 3 是与 host 通信的 Node IPC 通道。
        //
        // 注意不能用 Console.OpenStandardOutput()：真实 host 布局下 fd 0/1/2
        // 全是 'ignore'（\\?\NUL 设备），读它只会读到 NUL 的 EOF。
        using var channel = OpenChannel(ndjson);
        Trace.Write($"channel: {channel.Diagnostics}");

        using var runner = new JobRunner(argv, channel);
        var rc = runner.Run();
        Trace.Write($"run returned {rc}");
        return rc;
    }

    /// <summary>
    /// 打开与 host 通信的通道。默认走 Node IPC（生产路径），
    /// <paramref name="ndjson"/> 为 true 时走 stdin/stdout（调试）。
    /// </summary>
    private static IMessageChannel OpenChannel(bool ndjson)
        => ndjson ? new NdjsonChannel() : new IpcChannel(IpcFileDescriptor);

    /// <summary>
    /// 手写 JSON 拼装（不用 JsonSerializer —— AOT 下反射序列化被禁用）。
    ///
    /// 形状必须与 <see cref="ProtocolJson.Serialize(ErrorResult)"/> 严格一致：
    /// 只输出非 null 字段。早期这里写的是 <c>"code":</c> 后跟 <c>null</c>，
    /// 会产出 <c>{"code":null}</c> —— host 侧 <c>isSerializedRunnerError</c> 的
    /// <c>value.code === undefined || typeof value.code === "string"</c> 校验会判为
    /// 非法（null 既不是 undefined 也不是 string），整条错误结果被丢弃。
    ///
    /// 为什么自己开通道：这个函数在 argv 解析阶段就会被调用（那时 JobRunner
    /// 和主通道都还不存在）。fd 3 在进程启动时就已建立，所以可以随时打开。
    ///
    /// 为什么不能写 stdout：真实 host 布局下 fd 1 是 <c>\\?\NUL</c> —— 写入会
    /// "成功"但内容丢弃，调用方看到的是 runner 静默退出，完全无法定位。
    /// </summary>
    private static void EmitProtocolError(string message, string? code, string? path)
    {
        var error = new SerializedError
        {
            Name = "Error",
            Message = message,
            Code = code,
            Path = path,
        };

        var json = ProtocolJson.Serialize(new ErrorResult { Error = error });
        try
        {
            using var channel = new IpcChannel(IpcFileDescriptor);
            channel.Send(json);
        }
        catch (Exception ex)
        {
            // 通道不可用（例如调试模式下用 --ndjson 手工驱动）时退回 stdout
            Trace.Write($"EmitProtocolError: ipc unavailable ({ex.GetType().Name}), falling back to stdout");
            try
            {
                var bytes = Encoding.UTF8.GetBytes(json + "\n");
                var stdout = Console.OpenStandardOutput();
                stdout.Write(bytes, 0, bytes.Length);
                stdout.Flush();
            }
            catch { }
        }
    }
}

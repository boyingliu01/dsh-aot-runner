// 入口：解析 argv，接线 FD 4/5/6，启动 JobRunner
using System.Text;

namespace DshAotRunner;

internal static class Program
{
    private const string EnvSelector = "DSH_SUBPROCESS_RUNNER";

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

        // argv 形如：runner.exe -- <target> [args...]
        var argv = rawArgs;
        if (argv.Length > 0 && argv[0] == "--")
        {
            argv = argv[1..];
        }
        else if (argv.Length > 0 && argv[0].EndsWith(".js", StringComparison.OrdinalIgnoreCase))
        {
            var idx = Array.IndexOf(argv, "--");
            if (idx >= 0) argv = argv[(idx + 1)..];
        }

        Trace.Write($"parsed argv=[{string.Join("|", argv)}]");

        if (argv.Length == 0 || string.IsNullOrEmpty(argv[0]))
        {
            // RUNNER-SPEC §2：argv[0] 缺失 → 立即报错退出
            EmitProtocolError("invalid argv: expected a non-empty program name at argv[0]", "EINVAL", null);
            return 127;
        }

        // FD 4/5/6 是 host 在 spawn 时按位号传进来的 target 通道。
        // 本进程的 stdout(1) 是给 host 的 NDJSON 结果通道。
        var resultStream = Console.OpenStandardOutput();
        using var runner = new JobRunner(argv, resultStream);
        var rc = runner.Run();
        Trace.Write($"run returned {rc}");
        return rc;
    }

    /// <summary>
    /// 手写 JSON 拼装（不用 JsonSerializer —— AOT 下反射序列化被禁用）。
    ///
    /// 形状必须与 <see cref="ProtocolJson.Serialize(ErrorResult)"/> 严格一致：
    /// 只输出非 null 字段。早期这里写的是 <c>"code":</c> 后跟 <c>null</c>，
    /// 会产出 <c>{"code":null}</c> —— host 侧 <c>isSerializedRunnerError</c> 的
    /// <c>value.code === undefined || typeof value.code === "string"</c> 校验会判为
    /// 非法（null 既不是 undefined 也不是 string），整条错误结果被丢弃。
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

        var bytes = Encoding.UTF8.GetBytes(ProtocolJson.Serialize(new ErrorResult { Error = error }) + "\n");
        try
        {
            var stdout = Console.OpenStandardOutput();
            stdout.Write(bytes, 0, bytes.Length);
            stdout.Flush();
        }
        catch { }
    }
}

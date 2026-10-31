// 入口：解析 argv，接线 FD 4/5/6，启动 JobRunner
using System.Text;

namespace DshAotRunner;

internal static class Program
{
    private const string EnvSelector = "DSH_SUBPROCESS_RUNNER";

    private static void Dbg(string msg)
    {
        if (Environment.GetEnvironmentVariable("DSH_AOT_DEBUG") != "1") return;
        try
        {
            File.AppendAllText(Path.Combine(Path.GetTempPath(), "aot-runner-dbg.log"),
                msg + Environment.NewLine);
        }
        catch { }
    }

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
        Dbg($"enter: rawArgs=[{string.Join("|", rawArgs)}]");

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

        Dbg($"parsed argv=[{string.Join("|", argv)}]");

        if (argv.Length == 0 || string.IsNullOrEmpty(argv[0]))
        {
            // RUNNER-SPEC §2：argv[0] 缺失 → 立即报错退出
            EmitProtocolError("invalid argv: expected a non-empty program name at argv[0]", "EINVAL", null);
            return 127;
        }

        // FD 4/5/6 是 host 在 spawn 时按位号传进来的 target 通道。
        // 本进程的 stdout(1) 是给 host 的 NDJSON 结果通道。
        var resultStream = Console.OpenStandardOutput();
        var runner = new JobRunner(argv, resultStream);
        var rc = runner.Run();
        Dbg($"run returned {rc}");
        return rc;
    }

    /// <summary>
    /// 手写 JSON 拼装（不用 JsonSerializer —— AOT 下反射序列化被禁用）。
    /// 用 ProtocolJsonContext 的源生成路径做不到「任意字符串转义」，这里手写最小转义。
    /// </summary>
    private static void EmitProtocolError(string message, string? code, string? path)
    {
        var sb = new StringBuilder(128);
        sb.Append("{\"type\":\"error\",\"error\":{\"name\":\"Error\",\"message\":");
        AppendJsonString(sb, message);
        sb.Append(",\"code\":");
        if (code is null) sb.Append("null"); else AppendJsonString(sb, code);
        if (path is not null)
        {
            sb.Append(",\"path\":");
            AppendJsonString(sb, path);
        }
        sb.Append("}}");

        var bytes = Encoding.UTF8.GetBytes(sb.ToString() + "\n");
        try
        {
            var stdout = Console.OpenStandardOutput();
            stdout.Write(bytes, 0, bytes.Length);
            stdout.Flush();
        }
        catch { }
    }

    /// <summary>最小 JSON 字符串转义（RuntimeHelpers 不可用时手写）。</summary>
    internal static void AppendJsonString(StringBuilder sb, string s)
    {
        sb.Append('"');
        foreach (var c in s)
        {
            switch (c)
            {
                case '"': sb.Append("\\\""); break;
                case '\\': sb.Append("\\\\"); break;
                case '\n': sb.Append("\\n"); break;
                case '\r': sb.Append("\\r"); break;
                case '\t': sb.Append("\\t"); break;
                case '\b': sb.Append("\\b"); break;
                case '\f': sb.Append("\\f"); break;
                default:
                    if (c < 0x20 || c > 0x7E)
                        sb.Append("\\u").Append(((int)c).ToString("x4"));
                    else
                        sb.Append(c);
                    break;
            }
        }
        sb.Append('"');
    }
}

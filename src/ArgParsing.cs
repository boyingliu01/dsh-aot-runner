// argv 解析 —— 从进程参数里取出 target 的 argv
//
// 单独成文件（而不是放在 Program 里）的理由：Program.cs 含 Main 入口，
// 单元测试项目要链接被测源码，就会撞上「多个入口点」（CS0017）。
// 把纯解析逻辑放到这里，测试可以精确链接它而不必拖进入口点。
namespace DshAotRunner;

internal static class ArgParsing
{
    /// <summary>
    /// 从原始 argv 里解析出 target 的 argv 与调试开关。
    /// </summary>
    /// <remarks>
    /// 抽成独立方法有两个理由：
    ///   1. 这段逻辑有 5 条互斥分支（--ndjson 摘除、首项 "--"、首项 .js 后找 "--"、
    ///      找不到 "--" 保持原样、空数组），揉在 RunCore 里让它成了 CCN 10 的最大来源；
    ///   2. 它是纯函数（只读入参、不改环境），可以脱离真实进程单独测试
    ///      —— argv 形状错了的表现是「target 拿到了错位的参数」，很难从 e2e 反推。
    ///
    /// 兼容两种调用形状：
    ///   runner.exe -- &lt;target&gt; [args...]         （正常 spawn）
    ///   node runner.js ... -- &lt;target&gt; [args...]  （node 解释器前缀，取首个 "--" 之后）
    /// </remarks>
    /// <param name="rawArgs">进程收到的原始参数</param>
    /// <param name="ndjsonFlag">调试开关的字面量（--ndjson）</param>
    /// <returns>target 的 argv 与是否启用 --ndjson</returns>
    internal static (string[] Argv, bool Ndjson) ParseArgs(string[] rawArgs, string ndjsonFlag)
    {
        // --ndjson 调试开关：允许手工用管道驱动 runner（见 NdjsonChannel 的注释）。
        // 必须在 argv 解析**之前**摘掉，否则它会被当成 target 的程序名。
        var ndjson = rawArgs.Contains(ndjsonFlag);
        var argv = ndjson ? rawArgs.Where(a => a != ndjsonFlag).ToArray() : rawArgs;

        return (StripRunnerPrefix(argv), ndjson);
    }

    /// <summary>
    /// 剥掉 runner/node 自身的前缀，返回 target 的 argv。
    /// </summary>
    /// <remarks>
    /// 两种调用形状对应两条剥法，其余情况原样返回：
    ///   runner.exe -- &lt;target&gt;[...]          → 丢掉首项 "--"
    ///   node runner.js ... -- &lt;target&gt;[...]   → 丢掉首个 "--" 及其之前
    /// 拆成独立方法后，<see cref="ParseArgs"/> 只表达「摘开关 + 剥前缀」两步，
    /// 前缀识别本身也能被单独推理。
    /// </remarks>
    private static string[] StripRunnerPrefix(string[] argv)
    {
        if (argv.Length == 0) return argv;

        // 首项 "--"：直接丢掉，其后就是 target 的 argv
        if (argv[0] == "--") return argv[1..];

        // 首项是 .js（node 解释器前缀）：取第一个 "--" 之后的部分
        if (argv[0].EndsWith(".js", StringComparison.OrdinalIgnoreCase))
        {
            var idx = Array.IndexOf(argv, "--");
            if (idx >= 0) return argv[(idx + 1)..];
        }

        return argv;
    }
}

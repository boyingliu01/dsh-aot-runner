// 诊断日志 —— 全项目唯一的写入口
//
// 为什么写文件而不是 stderr：
//   runner 的 stderr(fd 2) 已被 host 重定向到 fd2 管道用于转发 target 的输出，
//   自己的诊断信息写进去会和 target 的 stderr 混在一起，既污染 A/B 比对，也常常丢失。
//
// 为什么不走 Console.WriteLine：
//   fd 1 是 NDJSON 协议通道，写一个字节就会破坏协议流。
//
// 开关：DSH_AOT_DEBUG=1 才启用；DSH_AOT_DEBUG_FILE 可覆盖输出路径。
// 默认关闭，正常路径上只有一次环境变量读取。
using System.Diagnostics;

namespace DshAotRunner;

internal static class Trace
{
    private static readonly Stopwatch Clock = Stopwatch.StartNew();

    private static bool Enabled =>
        Environment.GetEnvironmentVariable("DSH_AOT_DEBUG") == "1";

    /// <summary>带相对启动时间的诊断日志。</summary>
    public static void Timed(string message) => Write($"[{Clock.ElapsedMilliseconds,5}ms] {message}");

    /// <summary>不带时间戳的诊断日志。</summary>
    public static void Write(string message)
    {
        if (!Enabled) return;
        try
        {
            var path = Environment.GetEnvironmentVariable("DSH_AOT_DEBUG_FILE")
                       ?? Path.Combine(Path.GetTempPath(), "aot-runner-trace.log");
            File.AppendAllText(path, "[dbg] " + message + Environment.NewLine);
        }
        catch
        {
            // 诊断失败绝不能影响 runner 主流程
        }
    }
}

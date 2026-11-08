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

    /// <summary>
    /// 记录一个分段耗时（微秒精度），用于回答「这 N 毫秒花在哪一步」。
    /// </summary>
    /// <remarks>
    /// 为什么需要它：<see cref="Timed"/> 是毫秒截断的，而分段热点（例如 env 块构造）
    /// 往往在几百微秒到几毫秒之间，毫秒精度会把它们抹平成 0 或 1。
    /// <para>
    /// 只在 <c>DSH_AOT_DEBUG=1</c> 时工作；关闭时本方法在读完一次环境变量后立即返回，
    /// 调用它的成本是一次 <see cref="Enabled"/> 判断，可以放心放在关键路径上。
    /// </para>
    /// <para>
    /// <b>不要用它的输出去宣称性能收益</b>：这里量的是内部代码段，
    /// 端到端耗时由进程创建、target 启动等外部因素主导。两回事。
    /// </para>
    /// </remarks>
    /// <param name="phase">分段名，例如 "env-block"。</param>
    /// <param name="micros">该段耗时（微秒）。</param>
    public static void Phase(string phase, long micros) =>
        Write($"[phase] {phase,-18} {micros,8}us");

    /// <summary>
    /// 量一段代码的耗时。返回值的 <c>Dispose</c> 时写出。
    /// </summary>
    /// <remarks>
    /// 用 <c>using</c> 包住被测代码，异常路径也能记录 —— 否则「失败的调用」恰好是
    /// 最需要知道耗时分布的那批，却因为没有正常返回而漏记。
    /// </remarks>
    public static PhaseScope Measure(string phase) => new(phase);

    /// <summary><see cref="Measure"/> 的作用域对象。</summary>
    public readonly struct PhaseScope : IDisposable
    {
        private readonly string _phase;
        private readonly long _startTicks;

        internal PhaseScope(string phase)
        {
            _phase = phase;
            _startTicks = Enabled ? Stopwatch.GetTimestamp() : 0;
        }

        /// <inheritdoc/>
        public void Dispose()
        {
            if (_startTicks == 0) return;
            var micros = (Stopwatch.GetTimestamp() - _startTicks) * 1_000_000 / Stopwatch.Frequency;
            Phase(_phase, micros);
        }
    }

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

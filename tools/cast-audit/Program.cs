using System.Globalization;
using CastAudit;

// 强转审计工具入口。
//
// 用法：
//   dotnet run --project tools/cast-audit -- <目录或文件>...
//
// 退出码：0 = 没有发现问题；1 = 发现了需要看的强转（非豁免）。
//
// 设计取舍：默认**宁可选一个都不可能漏报的窄判据**，而不是「尽量多报」。
// 一条没人看的规则等于没有规则；把 20 个安全强转报成告警，真正的风险就会被淹没。
// 因此这里只报三类确定有范围风险的转换（见 CastRules）。
return CastAudit.CastAuditor.Run(args);

namespace CastAudit
{
    /// <summary>规则的严重级别。</summary>
    internal enum Severity
    {
        /// <summary>确定会丢数据或翻符号，必须处理或写明豁免理由。</summary>
        Risk,

        /// <summary>目前安全但依赖外部约束，值得看一眼。</summary>
        Note,
    }

    internal sealed record Finding(
        string File,
        int Line,
        int Column,
        Severity Severity,
        string RuleId,
        string Message,
        string Code);

    public static class CastAuditor
    {
        public static int Run(string[] args)
        {
            if (args.Length == 0)
            {
                Console.Error.WriteLine("用法: cast-audit <目录或 .cs 文件> [...]");
                return 2;
            }

            var findings = new List<Finding>();
            var failures = new List<string>();

            foreach (var path in args)
            {
                foreach (var file in Expand(path))
                {
                    try
                    {
                        findings.AddRange(CastAnalyzer.Analyze(file));
                    }
                    catch (Exception ex)
                    {
                        // 分析失败 ≠ 没有问题。必须让它可见，不能当成通过。
                        failures.Add($"{file}: 分析失败 - {ex.Message}");
                    }
                }
            }

            foreach (var f in failures)
                Console.Error.WriteLine($"❌ {f}");

            var risks = findings.Where(f => f.Severity == Severity.Risk).ToList();
            var notes = findings.Where(f => f.Severity == Severity.Note).ToList();

            Report(notes, "NOTE", "目前安全，但依赖外部约束");
            Report(risks, "RISK", "确定有范围风险");

            Console.WriteLine();
            Console.WriteLine($"检查完成：{risks.Count} 处风险，{notes.Count} 处提示。");

            if (failures.Count > 0)
            {
                Console.WriteLine("有文件分析失败 —— 这不是「没问题」，是「没查成」。");
                return 1;
            }

            return risks.Count > 0 ? 1 : 0;
        }

        private static void Report(List<Finding> items, string label, string blurb)
        {
            if (items.Count == 0) return;

            Console.WriteLine();
            Console.WriteLine($"━━ {label}（{items.Count} 处）：{blurb} ━━");
            foreach (var f in items.OrderBy(x => x.File).ThenBy(x => x.Line))
            {
                Console.WriteLine($"  {f.File}:{f.Line}:{f.Column}  [{f.RuleId}]");
                Console.WriteLine($"     {f.Message}");
                Console.WriteLine($"     > {f.Code}");
            }
        }

        private static IEnumerable<string> Expand(string path)
        {
            if (File.Exists(path)) return IsCheckable(path) ? [path] : [];

            if (!Directory.Exists(path))
            {
                Console.Error.WriteLine($"⚠️  路径不存在: {path}");
                return [];
            }

            return Directory.EnumerateFiles(path, "*.cs", SearchOption.AllDirectories)
                .Where(file => IsCheckable(file) && !IsBuildOutput(file));
        }

        /// <summary>是否是我们关心的源文件类型。</summary>
        private static bool IsCheckable(string path) =>
            path.EndsWith(".cs", StringComparison.OrdinalIgnoreCase);

        /// <summary>是否属于构建产物（obj/bin 里的代码不是人写的，不该报）。</summary>
        private static bool IsBuildOutput(string path)
        {
            var sep = Path.DirectorySeparatorChar;
            return path.Contains($"{sep}obj{sep}") || path.Contains($"{sep}bin{sep}");
        }
    }
}

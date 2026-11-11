using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

namespace CastAudit;

/// <summary>
/// 强转规则。
/// </summary>
/// <remarks>
/// <para>
/// 三条规则，全部围绕「**有符号/无符号错配**」和「**窄化截断**」。
/// 这两类正是 C# 编译器不会提示、却会在边界值上静默出错的地方。
/// </para>
/// <para>
/// <b>为什么不报「所有强转」</b>：本项目里光数值强转就有十几处，
/// 其中大多数是安全的（<c>(byte)'='</c>、<c>(uint)Marshal.SizeOf(...)</c>）。
/// 把它们全报出来，真正的风险会被淹没，规则会很快被人无视。
/// 所以这里只报「**确定会丢数据**」和「**依赖外部约束才安全**」的转换。
/// </para>
/// </remarks>
internal static class CastRules
{
    /// <summary>有符号类型及其取值范围。</summary>
    private static readonly Dictionary<SpecialType, (long Min, ulong Max, string Name)> Signed = new()
    {
        [SpecialType.System_SByte] = (sbyte.MinValue, (ulong)sbyte.MaxValue, "sbyte"),
        [SpecialType.System_Int16] = (short.MinValue, (ulong)short.MaxValue, "short"),
        [SpecialType.System_Int32] = (int.MinValue, (ulong)int.MaxValue, "int"),
        [SpecialType.System_Int64] = (long.MinValue, (ulong)long.MaxValue, "long"),
    };

    /// <summary>无符号类型及其最大值（Min 恒为 0）。</summary>
    private static readonly Dictionary<SpecialType, (ulong Max, string Name)> Unsigned = new()
    {
        [SpecialType.System_Byte] = (byte.MaxValue, "byte"),
        [SpecialType.System_UInt16] = (ushort.MaxValue, "ushort"),
        [SpecialType.System_UInt32] = (uint.MaxValue, "uint"),
        [SpecialType.System_UInt64] = (ulong.MaxValue, "ulong"),
    };

    /// <summary>
    /// 分析一个强转，返回发现（无风险时返回 null）。
    /// </summary>
    /// <param name="target">目标类型。</param>
    /// <param name="source">源类型。</param>
    /// <param name="isLiteralConstant">
    /// 源是否是可被编译器校验的常量表达式。常量在编译期就算好了，
    /// 溢出会直接报 CS0221（在 checked 下）或由开发者明确写了字面量 ——
    /// 这类不需要运行时规则兜底。
    /// </param>
    /// <param name="isChecked">
    /// 是否位于 <c>checked(...)</c> 里。这相当于 C++ 的 <c>static_cast</c>：
    /// 溢出立即抛异常，不静默回绕。
    /// </param>
    /// <param name="isMasked">
    /// 源表达式是否自带位掩码（如 <c>x &amp; 0xFF</c>）。
    /// 类型系统看不到值域约束，但掩码已经保证高位被清掉。
    /// </param>
    public static (Severity Severity, string RuleId, string Message)? Check(
        ITypeSymbol target, ITypeSymbol source, bool isLiteralConstant, bool isChecked, bool isMasked)
    {
        if (ShouldSkip(source, isLiteralConstant, isChecked, isMasked)) return null;

        var t = target.SpecialType;
        var s = source.SpecialType;

        if (!IsNumeric(t)) return null;

        return FirstHit(s, t);
    }

    /// <summary>
    /// 前置放行：这些情况下转换已有别的保障，不需要提示。
    /// </summary>
    /// <remarks>
    /// 单独成方法的理由：四条放行各自独立，写在一起会让主判定被
    /// 四个布尔条件淹没，而它们和「按类型选规则」是两件事。
    /// </remarks>
    private static bool ShouldSkip(ITypeSymbol source, bool isLiteralConstant, bool isChecked, bool isMasked)
    {
        // 常量溢出编译器自己会管（CS0221 / CS0220），规则不重复报。
        if (isLiteralConstant) return true;

        // checked(...) 是我们希望的「出错要响」，规则无需再提示。
        if (isChecked) return true;

        // 源表达式自带位掩码，高位在转换前就被清掉了。
        //
        // 这条不是「宽松处理」，而是必须的：类型系统看不到值域约束，
        // 而 (ch & 0xFF) 的结果必然落在 0..255 —— 类型上它是 int，
        // 语义上它已经是 byte。不识别掩码，这类模式会被永久误报，
        // 规则的可信度就会归零。
        return isMasked;
    }

    private static bool IsNumeric(SpecialType t) => Signed.ContainsKey(t) || Unsigned.ContainsKey(t);

    /// <summary>按顺序套三条规则，返回第一条命中的。</summary>
    private static (Severity, string, string)? FirstHit(SpecialType s, SpecialType t)
    {
        var hit = CheckUnsignedToSigned(s, t);
        if (hit is not null) return hit;

        // 窄化排在「有符号 → 无符号」之前：窄化是更本质的问题，
        // (byte)someInt 既有「负数变巨大值」也有「300 变 44」。
        hit = CheckNarrowing(s, t);
        if (hit is not null) return hit;

        return CheckSignedToUnsigned(s, t);
    }

    /// <summary>
    /// 规则 1：无符号 → 有符号，且目标装不下源的最大值。
    /// </summary>
    /// <remarks>
    /// 这是本项目实际出过的 bug：uint(4294967295) → int 得到 -1，
    /// host 判协议非法，工具调用失败。
    /// </remarks>
    private static (Severity, string, string)? CheckUnsignedToSigned(SpecialType s, SpecialType t)
    {
        if (!Unsigned.TryGetValue(s, out var u)) return null;
        if (!Signed.TryGetValue(t, out var sg)) return null;
        if (u.Max <= sg.Max) return null;

        return (Severity.Risk, "CASTR001",
            $"无符号 {u.Name} → 有符号 {sg.Name}：{u.Name}.Max={u.Max} 超出 {sg.Name}.Max={sg.Max}，" +
            $"最高位为 1 时会翻成负数。用 checked(...) 让溢出显式抛出，或换用够宽的整型。");
    }

    /// <summary>
    /// 规则 2：窄化截断（源最大值超出目标最大值）。
    /// </summary>
    /// <remarks>
    /// 放在「有符号 → 无符号」之前判断，因为窄化是更本质的问题：
    /// (byte)someInt 既有「负数变巨大值」也有「300 变 44」，后者更常踩到。
    /// </remarks>
    private static (Severity, string, string)? CheckNarrowing(SpecialType s, SpecialType t)
    {
        var srcMax = MaxOf(s);
        var tgtMax = MaxOf(t);
        if (srcMax is null || tgtMax is null || srcMax <= tgtMax) return null;

        return (Severity.Risk, "CASTR003",
            $"窄化截断：{NameOf(s)} → {NameOf(t)}，源最大值 {srcMax} 超出目标最大值 {tgtMax}，高位会静默丢失。" +
            $"用 checked(...) 或先做范围校验。");
    }

    /// <summary>
    /// 规则 3：有符号可为负 → 无符号，负值回绕成巨大值。
    /// </summary>
    private static (Severity, string, string)? CheckSignedToUnsigned(SpecialType s, SpecialType t)
    {
        if (!Signed.TryGetValue(s, out var sm) || sm.Min >= 0) return null;
        if (Signed.ContainsKey(t)) return null;
        if (!Unsigned.ContainsKey(t)) return null;

        return (Severity.Risk, "CASTR002",
            $"有符号 {sm.Name} → 无符号 {NameOf(t)}：{sm.Name} 可以是负数（Min={sm.Min}），" +
            $"负数转无符号会变成巨大的值。确认源确实非负，或加显式校验。");
    }

    /// <summary>
    /// 源表达式是否自带位掩码（`&amp; 常量` 或 `% 常量`），从而保证值域。
    /// </summary>
    /// <remarks>
    /// 只认最简单的两种形式，不做数据流分析 —— 这是个**故意保守**的判据：
    /// 认不出来就照常报，宁可多一条提示，也不要漏掉真正的风险。
    /// </remarks>
    public static bool HasMaskingGuard(ExpressionSyntax expr)
    {
        // 剥掉括号：((x & 0xFF)) 与 (x & 0xFF) 等价。
        while (expr is ParenthesizedExpressionSyntax p) expr = p.Expression;

        return expr is BinaryExpressionSyntax b &&
               (b.IsKind(SyntaxKind.BitwiseAndExpression) || b.IsKind(SyntaxKind.ModuloExpression));
    }

    private static ulong? MaxOf(SpecialType t)
    {
        if (Signed.TryGetValue(t, out var sg)) return sg.Max;
        if (Unsigned.TryGetValue(t, out var u)) return u.Max;
        return null;
    }

    private static string NameOf(SpecialType t)
    {
        if (Signed.TryGetValue(t, out var sg)) return sg.Name;
        if (Unsigned.TryGetValue(t, out var u)) return u.Name;
        return t.ToString();
    }
}

/// <summary>用 Roslyn 语义模型分析一个文件里的强转。</summary>
internal static class CastAnalyzer
{
    public static List<Finding> Analyze(string path)
    {
        var text = File.ReadAllText(path);
        var tree = CSharpSyntaxTree.ParseText(text, path: path);
        var lines = text.Split(new[] { (char)10 });

        // 引用本进程能拿到的全部程序集。这些强转都发生在 int/uint 之类的基础类型上，
        // System.Private.CoreLib 就够了 —— 不需要还原被分析项目的依赖，
        // 因此这个工具不用装 NuGet 包、也不用等 restore。
        var references = ((string)AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES")!)
            .Split(Path.PathSeparator)
            .Where(p => !string.IsNullOrEmpty(p) && File.Exists(p))
            .Select(p => (MetadataReference)MetadataReference.CreateFromFile(p))
            .ToList();

        var compilation = CSharpCompilation.Create(
            "cast-audit-analysis",
            [tree],
            references,
            new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));

        var model = compilation.GetSemanticModel(tree);

        return tree.GetRoot().DescendantNodes()
            .OfType<CastExpressionSyntax>()
            .Select(cast => AnalyzeCast(cast, model, lines, path))
            .OfType<Finding>()
            .ToList();
    }

    /// <summary>判定单个强转；不需要报时返回 null。</summary>
    private static Finding? AnalyzeCast(
        CastExpressionSyntax cast, SemanticModel model, string[] lines, string path)
    {
        var targetType = model.GetTypeInfo(cast.Type).Type;
        var sourceType = model.GetTypeInfo(cast.Expression).Type;
        if (targetType is null || sourceType is null) return null;

        var span = cast.GetLocation().GetLineSpan();

        // 豁免：同一行或上一行有 `// cast-audit:ignore 理由` 就跳过。
        // 强制要求写理由 —— 只写 ignore 不写理由的，照常报出来。
        if (HasExemption(lines, span.StartLinePosition.Line)) return null;

        var result = CastRules.Check(
            targetType,
            sourceType,
            isLiteralConstant: model.GetConstantValue(cast.Expression).HasValue,
            isChecked: cast.Parent is CheckedExpressionSyntax,
            isMasked: CastRules.HasMaskingGuard(cast.Expression));

        if (result is null) return null;

        var (severity, ruleId, message) = result.Value;
        var raw = lines[span.StartLinePosition.Line];
        return new Finding(
            path, span.StartLinePosition.Line + 1, span.StartLinePosition.Character + 1,
            severity, ruleId, message, raw.TrimEnd().Trim());
    }

    /// <summary>
    /// 该行（或紧邻上一行）是否有带理由的豁免注释。
    /// </summary>
    /// <remarks>
    /// <para>
    /// 语法：<c>// cast-audit:ignore 理由</c>，可写在强转所在行的行尾，
    /// 也可单独写在该行**上一行**。
    /// </para>
    /// <para>
    /// <b>强制要求理由</b>：只写 <c>cast-audit:ignore</c> 而不跟理由的，视为无效豁免，
    /// 照常报出来。理由存在的意义是把「我知道这里为什么安全」显式写下来 ——
    /// 否则豁免就退化成了「让工具闭嘴」，而半年后没人知道当初为什么安全。
    /// </para>
    /// </remarks>
    private static bool HasExemption(string[] lines, int lineIndex)
    {
        const string Marker = "cast-audit:ignore";

        for (var i = Math.Max(0, lineIndex - 1); i <= lineIndex; i++)
        {
            if (i >= lines.Length) continue;
            var idx = lines[i].IndexOf(Marker, StringComparison.Ordinal);
            if (idx < 0) continue;

            // 理由是否非空：忽略掉标记本身与常见分隔符后的剩余内容。
            var reason = lines[i][(idx + Marker.Length)..].Trim().TrimStart(':', '-', ' ');
            if (reason.Length > 0) return true;
        }

        return false;
    }
}

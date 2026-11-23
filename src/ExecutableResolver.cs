// 可执行文件解析与命令行拼装 —— 让 AOT runner 与 node 在「同一个 argv 会跑到
// 哪个文件」这件事上给出完全一致的答案。
//
// 为什么独立成文件：这一整块是**纯逻辑** —— 输入 argv/env/cwd，输出路径字符串。
// 它不碰进程、句柄、IPC。此前它散在 JobRunner.cs 中间，导致"进程管理"这个文件
// 同时承载了"Windows 路径解析规则"，而这两者的一致性目标完全不同：
//   - 进程生命周期：不能泄漏、不能卡死
//   - 路径解析：必须与 @deepseek-ai/dsh-subprocess-local 的
//     resolveWindowsExecutable 逐项对齐（A/B 字节级一致性）
// 混在一起时，改进程逻辑的人很难意识到自己正在动契约对齐代码。
//
// 这一块的等价性由 tests/DshAotRunner.Tests/JobRunnerResolveTests.cs 逐条锁住。
using System.Text;

namespace DshAotRunner;

/// <summary>
/// Windows 可执行文件解析与命令行 quoting。
/// </summary>
/// <remarks>
/// 全部方法保持 <c>static</c> 且无状态 —— 它们是规则，不是资源。
/// 唯一读的外部状态是 <see cref="System.Environment"/> 里的 PATH 与
/// NODEFAULTCURRENTDIRECTORYINEXEPATH（与 node 的 currentEnv 视角一致）。
/// </remarks>
internal static class ExecutableResolver
{
    /// <summary>把路径规范化为 Windows 反斜杠格式；空值返回 null（表示继承当前目录）。</summary>
    /// <remarks>
    /// 三条独立规则依次应用：统一分隔符 → 去掉末尾多余反斜杠 → 裸盘符补根斜杠。
    /// 每条规则都写成单独一行并在注释里点明「为什么」，比串成一串条件判断更容易核对。
    /// </remarks>
    internal static string? NormalizeWindowsPath(string? path)
    {
        if (string.IsNullOrWhiteSpace(path)) return null;

        // 1) 统一分隔符：Windows API 与 node 侧都用反斜杠
        var normalized = path.Replace('/', '\\');

        // 2) 去掉末尾多余的反斜杠（但保留根路径如 "C:\"）
        if (normalized.Length > 3 && normalized.EndsWith('\\'))
            normalized = normalized.TrimEnd('\\');

        // 3) 裸盘符（"C:"）补成 "C:\"，否则它表示「盘符当前目录」而非根目录
        if (IsBareDrive(normalized)) normalized += '\\';

        return normalized;
    }

    /// <summary>是否是没有任何路径部分的裸盘符（形如 <c>C:</c>）。</summary>
    private static bool IsBareDrive(string path) => path.Length == 2 && path[1] == ':';

    /// <summary>
    /// 把 argv[0] 解析成绝对路径，语义与 @deepseek-ai/dsh-subprocess-local 的
    /// <c>resolveWindowsExecutable</c> 逐项对齐（见 runner-launch-*.js）。
    ///
    /// 对齐要点（A/B 字节级一致性要求，任何偏离都会让 node 与 AOT 两条路径
    /// 对同一个 argv 得出不同结论）：
    ///   1. 候选扩展名只有 .com 和 .exe，**且 .com 优先** —— 不含 .bat/.cmd。
    ///      例：npm 只有 npm.cmd，因此 node 与 AOT 都必须解析失败（ENOENT），
    ///      而不能由 AOT 单方面补 .cmd 让它跑起来。
    ///   2. 自带扩展名（点号后至少 1 字符）时，只检查原样文件名一次。
    ///   3. 不含路径分隔符时，先搜 cwd（受 NODEFAULTCURRENTDIRECTORYINEXEPATH 控制），
    ///      再按 PATH 顺序搜。
    ///   4. 全部候选都不存在 → 返回 null，由调用方产出 ENOENT 错误，
    ///      而不是把裸名交给 CreateProcessW（那会产生不同的错误文本）。
    /// </summary>
    internal static string? ResolveExecutable(string program, string? cwd, Dictionary<string, string>? env)
    {
        if (string.IsNullOrEmpty(program)) return null;

        // windowsFileNameStart：定位文件名起始处（跳过盘符和目录部分）
        var nameStart = WindowsFileNameStart(program);
        var directory = program.Substring(0, nameStart);
        var name = program.Substring(nameStart);

        var candidates = BuildExecutableCandidates(name);
        var roots = BuildSearchRoots(nameStart != 0, directory, env);

        foreach (var root in roots)
        {
            var basePath = WindowsSearchPathJoin(root, name, cwd ?? "");
            var found = ProbeCandidates(basePath, candidates);
            if (found is not null) return found;
        }
        return null;
    }

    /// <summary>
    /// 候选名顺序：自带扩展名的原样名 → .com → .exe（与 libuv 一致）。
    /// </summary>
    internal static List<string> BuildExecutableCandidates(string name)
    {
        // 扩展名判定：点号存在且不是最后一个字符
        var dot = name.IndexOf('.');
        var hasExtension = dot >= 0 && dot < name.Length - 1;
        var separator = name.EndsWith('.') ? "" : ".";

        var candidates = new List<string>(3);
        if (hasExtension) candidates.Add(name);
        candidates.Add(name + separator + "com");
        candidates.Add(name + separator + "exe");
        return candidates;
    }

    /// <summary>
    /// 搜索根：带路径 → 只有该目录；不带路径 → cwd（可禁用）+ 各 PATH 目录。
    /// </summary>
    internal static List<string> BuildSearchRoots(bool hasPath, string directory, Dictionary<string, string>? env)
    {
        var roots = new List<string>(8);
        if (hasPath)
        {
            roots.Add(directory);
            return roots;
        }

        // 本进程环境决定是否搜索 cwd（与 node 的 currentEnv 视角一致）
        var noDefaultCwd = Environment.GetEnvironmentVariable("NODEFAULTCURRENTDIRECTORYINEXEPATH");
        if (noDefaultCwd is null) roots.Add("");

        roots.AddRange(SplitPath(GetEnvValue(env, "PATH")
            ?? Environment.GetEnvironmentVariable("PATH") ?? ""));
        return roots;
    }

    /// <summary>在某个基准路径下依次探测候选名，返回第一个存在的。</summary>
    internal static string? ProbeCandidates(string basePath, List<string> candidates)
    {
        foreach (var candidate in candidates)
        {
            var full = basePath.Length == 0 ? candidate : basePath + candidate;
            // executableCandidateExists：存在且不是目录
            //
            // 不需要 try/catch：实测 .NET 8 的 File.Exists 对非法字符、
            // 超长路径、无权限路径都只返回 false，不抛异常。
            // （.NET Framework 时代它会抛，所以老代码里常见这个兜底。）
            if (File.Exists(full)) return full;
        }
        return null;
    }

    /// <summary>定位文件名在整条路径中的起始索引（跳过 "C:\dir\" 这类前缀）。</summary>
    /// <remarks>
    /// 从尾部向前扫到第一个分隔符或盘符冒号即可 —— 用 LastIndexOfAny 表达同一意图，
    /// 比手写递减循环少一层「i 越界 / 提前 return」的状态。
    /// 盘符特例（"C:name" 这种无目录写法）单独一次判断，语义更直白。
    /// </remarks>
    internal static int WindowsFileNameStart(string command)
    {
        var sep = command.LastIndexOfAny(['\\', '/']);
        if (sep >= 0) return sep + 1;

        // 无分隔符但形如 "C:name"：文件名从盘符后开始
        // （"C:" 本身也返回 2，与原实现一致：此时 name 为空串）
        if (command.Length >= 2 && command[1] == ':') return 2;

        return 0;
    }

    /// <summary>把 PATH 拆成目录列表（分号分隔，去引号与空项）。</summary>
    internal static IEnumerable<string> SplitPath(string pathVar)
    {
        foreach (var raw in pathVar.Split(';', StringSplitOptions.RemoveEmptyEntries))
        {
            var trimmed = raw.Trim().Trim('"');
            if (trimmed.Length > 0) yield return trimmed;
        }
    }

    /// <summary>按大小写不敏感取环境变量值。</summary>
    internal static string? GetEnvValue(Dictionary<string, string>? env, string key)
    {
        if (env is null) return null;
        foreach (var kv in env)
        {
            if (string.Equals(kv.Key, key, StringComparison.OrdinalIgnoreCase)) return kv.Value;
        }
        return null;
    }

    /// <summary>把搜索根与文件名拼成基路径；根为空时用 cwd（对齐 windowsSearchPathJoin）。</summary>
    internal static string WindowsSearchPathJoin(string root, string name, string cwd)
    {
        if (root.Length == 0)
            return cwd.Length == 0 ? "" : cwd.TrimEnd('\\', '/') + "\\";
        return root.TrimEnd('\\', '/') + "\\";
    }

    internal static string BuildCommandLine(string[] argv)
    {
        var sb = new StringBuilder();
        for (var i = 0; i < argv.Length; i++)
        {
            if (i > 0) sb.Append(' ');
            AppendQuoted(sb, argv[i]);
        }
        return sb.ToString();
    }

    /// <summary>命令行里需要加引号的字符。静态复用，避免每次构串都分配数组。</summary>
    private static readonly char[] QuoteRequiredChars = { ' ', '\t', '"' };

    /// <summary>按 Windows 命令行解析规则加引号（CommandLineToArgvW 兼容）。</summary>
    internal static void AppendQuoted(StringBuilder sb, string arg)
    {
        if (arg.Length > 0 && arg.IndexOfAny(QuoteRequiredChars) < 0)
        {
            sb.Append(arg);
            return;
        }
        sb.Append('"');
        var backslashes = 0;
        foreach (var c in arg)
        {
            if (c == '\\') { backslashes++; continue; }
            if (c == '"')
            {
                sb.Append('\\', backslashes * 2 + 1);
                sb.Append('"');
            }
            else
            {
                sb.Append('\\', backslashes);
                sb.Append(c);
            }
            backslashes = 0;
        }
        sb.Append('\\', backslashes * 2);
        sb.Append('"');
    }
}

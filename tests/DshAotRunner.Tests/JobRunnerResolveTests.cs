// JobRunner 可测逻辑补齐 —— 错误码映射、可执行文件解析、路径正规化
//
// ## 为什么是这些、不是那些
//
// JobRunner 594 行里约 480 行未覆盖，绝大多数是 Win32 编排
// （CreateProcessW / Job 入队 / fd 表 / 句柄继承）。
//
// **在 xunit 宿主里直接构造 JobRunner 去 spawn 真实进程会崩掉测试宿主** ——
// 实测确认（真实 spawn 的用例单独跑会让 "测试主机进程崩溃"）。
// 原因是 JobRunner 设计上就要写真实 fd 4/5/6，而测试宿主里没有这套布局。
//
// 给每条 P/Invoke 造假 mock 同样不可取：得到的只是「mock 按我说的返回」，
// 证明不了任何真实行为，反而制造虚假安全感。
//
// 所以编排路径由 test/ab-verify.js 的 28 个真实场景兜底（它跑在真实 fd 布局下），
// 而本文件负责**能脱离 OS 环境确定性验证的那部分**：
//   - 错误码 → Node errno 的映射（错一个字母，A/B 就红）
//   - 可执行文件解析顺序（.com 优先于 .exe，与 libuv 一致）
//   - 路径正规化（正斜杠 → 反斜杠，CreateProcessW 只认后者）
using System.Text;
using DshAotRunner;
using Xunit;

namespace DshAotRunner.Tests;

public class JobRunnerResolveTests
{
    // ============ NormalizeWindowsPath ============

    [Fact]
    public void NormalizeWindowsPath_正斜杠转反斜杠()
    {
        // CreateProcessW 的 lpCurrentDirectory 传 "C:/" 会返回 ERROR_INVALID_PARAMETER(87)，
        // 必须转成 "C:\"。
        Assert.Equal(@"C:\Windows", JobRunner.NormalizeWindowsPath("C:/Windows"));
    }

    [Fact]
    public void NormalizeWindowsPath_盘符根保留尾反斜杠()
    {
        Assert.Equal(@"C:\", JobRunner.NormalizeWindowsPath("C:/"));
        Assert.Equal(@"C:\", JobRunner.NormalizeWindowsPath("C:\\"));
    }

    [Fact]
    public void NormalizeWindowsPath_null或空返回null()
    {
        Assert.Null(JobRunner.NormalizeWindowsPath(null));
        Assert.Null(JobRunner.NormalizeWindowsPath(""));
    }

    [Fact]
    public void NormalizeWindowsPath_裸盘符补全为根()
    {
        // "C:" 在 Win32 语义里是「C 盘的当前目录」，不是根。
        // 静默当成根会改变语义，所以这里补成 "C:\"。
        Assert.Equal(@"C:\", JobRunner.NormalizeWindowsPath("C:"));
    }

    [Fact]
    public void NormalizeWindowsPath_已规范路径不变()
    {
        Assert.Equal(@"D:\projects\x", JobRunner.NormalizeWindowsPath(@"D:\projects\x"));
    }

    [Fact]
    public void NormalizeWindowsPath_UNC路径保留双反斜杠()
    {
        var result = JobRunner.NormalizeWindowsPath(@"\\server\share\dir");
        Assert.StartsWith(@"\\server\share", result);
    }

    // ============ 可执行文件解析候选顺序 ============

    [Fact]
    public void BuildExecutableCandidates_无扩展名时com优先于exe()
    {
        // 与 libuv 的 windowsFileNameStart / 扩展名补全一致：
        // .com 在前（历史上 .com 是命令程序）。
        // 顺序若反了，同一个名字在两套实现里会解析到不同文件 → A/B 立刻红。
        var candidates = JobRunner.BuildExecutableCandidates("python");

        Assert.Equal(["python.com", "python.exe"], candidates);
    }

    [Fact]
    public void BuildExecutableCandidates_自带扩展名时原样名字排第一()
    {
        var candidates = JobRunner.BuildExecutableCandidates("python.exe");

        Assert.Equal("python.exe", candidates[0]);
        Assert.Contains("python.exe.com", candidates);
        Assert.Contains("python.exe.exe", candidates);
    }

    [Fact]
    public void BuildExecutableCandidates_尾随点的处理()
    {
        // Win32 会忽略文件名末尾的点。"python." 不该拼成 "python..com"。
        var candidates = JobRunner.BuildExecutableCandidates("python.");

        Assert.Contains("python.com", candidates);
        Assert.DoesNotContain("python..com", candidates);
    }

    [Fact]
    public void BuildExecutableCandidates_单点文件名视为无扩展名()
    {
        // "." 本身不是合法扩展名，应被当成无扩展名处理。
        var candidates = JobRunner.BuildExecutableCandidates(".");
        Assert.All(candidates, c => Assert.False(c.StartsWith(".."), $"不应产生 {c}"));
    }

    // ============ 搜索根 ============

    [Fact]
    public void BuildSearchRoots_带路径时只搜该目录()
    {
        var roots = JobRunner.BuildSearchRoots(true, @"C:\bin", null);

        Assert.Single(roots);
        Assert.Equal(@"C:\bin", roots[0]);
    }

    [Fact]
    public void BuildSearchRoots_不带路径时含cwd与PATH目录()
    {
        var env = new Dictionary<string, string> { ["PATH"] = @"C:\a;C:\b" };
        var roots = JobRunner.BuildSearchRoots(false, "", env);

        Assert.Contains("", roots);                       // cwd 占位
        Assert.Contains(@"C:\a", roots);
        Assert.Contains(@"C:\b", roots);
    }

    [Fact]
    public void BuildSearchRoots_优先用请求里的PATH而非进程环境()
    {
        // host 传下来的 env 是权威来源；进程环境只是兜底。
        // 混用会导致「runner 找得到、node 找不到」的解析分歧。
        var env = new Dictionary<string, string> { ["PATH"] = @"Z:\host-path" };
        var roots = JobRunner.BuildSearchRoots(false, "", env);

        Assert.Contains(@"Z:\host-path", roots);
    }

    // ============ 解析结果 ============

    [Fact]
    public void ResolveExecutable_显式路径存在时直接命中()
    {
        var exe = Path.Combine(Environment.SystemDirectory, "cmd.exe");
        var resolved = JobRunner.ResolveExecutable(exe, null, null);

        Assert.NotNull(resolved);
        Assert.Equal(exe, resolved, ignoreCase: true);
    }

    [Fact]
    public void ResolveExecutable_PATHEXT里能找到cmd()
    {
        var env = new Dictionary<string, string>
        {
            ["PATH"] = Environment.SystemDirectory,
        };
        var resolved = JobRunner.ResolveExecutable("cmd", null, env);

        Assert.NotNull(resolved);
        Assert.EndsWith("cmd.exe", resolved, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void ResolveExecutable_不存在的程序返回null()
    {
        Assert.Null(JobRunner.ResolveExecutable("no-such-exe-xyz-123", null, null));
    }

    [Fact]
    public void ResolveExecutable_空程序名返回null()
    {
        Assert.Null(JobRunner.ResolveExecutable("", null, null));
    }

    [Fact]
    public void ResolveExecutable_目录路径返回null()
    {
        // 指向一个目录（而非文件）不能算命中 —— 否则 CreateProcessW 会失败。
        Assert.Null(JobRunner.ResolveExecutable(Environment.SystemDirectory, null, null));
    }

    // ============ 文件名起点 / PATH 拆分 / 拼接 ============

    [Theory]
    [InlineData("cmd", 0)]
    [InlineData(@"C:\bin\cmd.exe", 7)]
    [InlineData(@"C:/bin/cmd.exe", 7)]
    [InlineData(@"\\server\share\cmd.exe", 15)]
    public void WindowsFileNameStart_定位文件名起点(string command, int expected)
    {
        Assert.Equal(expected, JobRunner.WindowsFileNameStart(command));
    }

    [Fact]
    public void SplitPath_按分号拆分并去空()
    {
        var parts = JobRunner.SplitPath(@"C:\a;;C:\b;").ToList();

        Assert.Equal([@"C:\a", @"C:\b"], parts);
    }

    // WindowsSearchPathJoin 返回的是「目录前缀」（含尾分隔符），文件名由
    // ProbeCandidates 拼上去。名字有误导性，但语义必须对齐 libuv 的
    // windowsSearchPathJoin —— 它是先拼目录、再逐个试候选扩展名。

    [Fact]
    public void WindowsSearchPathJoin_root为空且cwd为空时返回空()
    {
        Assert.Equal("", JobRunner.WindowsSearchPathJoin("", "cmd", ""));
    }

    [Fact]
    public void WindowsSearchPathJoin_root为空时退回cwd并补尾分隔符()
    {
        Assert.Equal(@"C:\work\", JobRunner.WindowsSearchPathJoin("", "cmd", @"C:\work"));
    }

    [Fact]
    public void WindowsSearchPathJoin_root末尾补一个反斜杠()
    {
        Assert.Equal(@"C:\bin\", JobRunner.WindowsSearchPathJoin(@"C:\bin", "cmd", ""));
    }

    [Fact]
    public void WindowsSearchPathJoin_root已带尾分隔符时不重复()
    {
        // 反斜杠与正斜杠都算分隔符：host 传来的 PATH 常是混合写法。
        Assert.Equal(@"C:\bin\", JobRunner.WindowsSearchPathJoin(@"C:\bin\", "cmd", ""));
        Assert.Equal(@"C:\bin\", JobRunner.WindowsSearchPathJoin(@"C:\bin/", "cmd", ""));
    }

    [Fact]
    public void WindowsSearchPathJoin_与ProbeCandidates配合能拼出完整路径()
    {
        // 这两者的契约是组合出来的：前缀 + 候选名 = 完整路径。
        var prefix = JobRunner.WindowsSearchPathJoin(Environment.SystemDirectory, "cmd", "");
        var found = JobRunner.ProbeCandidates(prefix, ["cmd.exe"]);

        Assert.NotNull(found);
        Assert.True(Path.IsPathRooted(found));
        Assert.EndsWith("cmd.exe", found, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void GetEnvValue_大小写不敏感()
    {
        // Windows 环境变量名大小写不敏感；用 Ordinal 比较会漏掉 host 传的 "Path"。
        var env = new Dictionary<string, string> { ["Path"] = "x" };

        Assert.Equal("x", JobRunner.GetEnvValue(env, "PATH"));
    }

    [Fact]
    public void GetEnvValue_精确匹配优先()
    {
        var env = new Dictionary<string, string> { ["PATH"] = "upper", ["Path"] = "mixed" };

        Assert.Equal("upper", JobRunner.GetEnvValue(env, "PATH"));
    }

    [Fact]
    public void GetEnvValue_缺失返回null()
    {
        Assert.Null(JobRunner.GetEnvValue(new Dictionary<string, string>(), "NOPE"));
        Assert.Null(JobRunner.GetEnvValue(null, "PATH"));
    }

    // ============ ProbeCandidates ============

    [Fact]
    public void ProbeCandidates_命中第一个存在的候选()
    {
        // basePath 是目录前缀（末尾带反斜杠），候选名拼在后面。
        var dir = Environment.SystemDirectory.TrimEnd('\\') + "\\";
        var found = JobRunner.ProbeCandidates(dir, ["cmd.exe", "nope.exe"]);

        Assert.NotNull(found);
        Assert.EndsWith("cmd.exe", found, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void ProbeCandidates_按候选顺序返回第一个命中()
    {
        var dir = Environment.SystemDirectory.TrimEnd('\\') + "\\";
        // 两个都真实存在时，必须返回列表里靠前的那个（顺序即 libuv 的解析顺序）。
        var found = JobRunner.ProbeCandidates(dir, ["cmd.exe", "where.exe"]);

        Assert.NotNull(found);
        Assert.EndsWith("cmd.exe", found, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void ProbeCandidates_全部不存在返回null()
    {
        var dir = Environment.SystemDirectory.TrimEnd('\\') + "\\";
        Assert.Null(JobRunner.ProbeCandidates(dir, ["nope-a.exe", "nope-b.exe"]));
    }

    // ============ 错误码映射（对应 node 的 asSpawnError）============

    [Theory]
    [InlineData(2, "ENOENT")]      // ERROR_FILE_NOT_FOUND
    [InlineData(3, "ENOENT")]      // ERROR_PATH_NOT_FOUND
    [InlineData(267, "ENOENT")]    // ERROR_DIRECTORY
    [InlineData(5, "EPERM")]       // ERROR_ACCESS_DENIED
    [InlineData(193, "EFTYPE")]    // ERROR_BAD_EXE_FORMAT
    [InlineData(740, "EACCES")]    // ERROR_ELEVATION_REQUIRED
    public void WindowsSpawnErrorCodes_与node一致(int win32, string expected)
    {
        // 这张表是 A/B 字节级一致的关键：code 错一个字母，错误对象的文本就对不上。
        Assert.Equal(expected, JobRunner.WindowsSpawnErrorCodes[win32]);
    }

    [Fact]
    public void WindowsSpawnErrorCodes_未收录的码返回UNKNOWN()
    {
        Assert.False(JobRunner.WindowsSpawnErrorCodes.ContainsKey(9999));
    }

    [Theory]
    [InlineData("EACCES", true)]
    [InlineData("ENOENT", true)]
    [InlineData("EPERM", false)]      // 详情型之外的码不带 path
    [InlineData("EFTYPE", false)]
    public void NodeSpawnDetailCodes_决定错误对象是否带path(string code, bool expected)
    {
        Assert.Equal(expected, JobRunner.NodeSpawnDetailCodes.Contains(code));
    }

    [Fact]
    public void MakeNodeSpawnError_文本格式与node一致()
    {
        // node 的错误对象形如 { message: "spawn ENOENT", code, syscall, path }
        var err = JobRunner.MakeNodeSpawnError("spawn foo", "ENOENT", "foo");

        Assert.Equal("Error", err.Name);
        Assert.Equal("spawn foo ENOENT", err.Message);
        Assert.Equal("ENOENT", err.Code);
        Assert.Equal("spawn foo", err.Syscall);
        Assert.Equal("foo", err.Path);
    }

    [Fact]
    public void MakeNodeSpawnError_不传path时字段为null()
    {
        var err = JobRunner.MakeNodeSpawnError("spawn", "UNKNOWN", null);

        Assert.Equal("spawn UNKNOWN", err.Message);
        Assert.Null(err.Path);
    }
}

// JobRunner 纯逻辑单元测试 —— Windows 命令行 quoting、argv[0] 解析、环境块
//
// 为什么这些测试值得存在：
//   这几段代码的契约是「与 Node 侧的 libuv/dsh-subprocess-local 逐字节一致」。
//   A/B 测试只能告诉你「A 和 B 不一致」，说不出是哪一条规则错了；
//   而且不规则路径（含空格、尾随反斜杠、引号）在端到端测试里几乎不会覆盖到。
//   一旦 quoting 错了，CreateProcessW 会把一个参数拆成两个 —— target 拿到
//   错位的 argv，表现为「脚本莫名报参数错误」，排查成本极高。
using System.Text;
using DshAotRunner;
using Xunit;

namespace DshAotRunner.Tests;

public class JobRunnerPureLogicTests
{
    // ============ BuildCommandLine / AppendQuoted ============
    // 规则来源：CommandLineToArgvW + MSVC CRT 的约定。

    private static string Quote(string arg)
    {
        var sb = new StringBuilder();
        JobRunner.AppendQuoted(sb, arg);
        return sb.ToString();
    }

    [Fact]
    public void Quote_普通参数不加引号()
    {
        Assert.Equal("abc", Quote("abc"));
        // 正斜杠、冒号、等号都不需要引号
        Assert.Equal(@"C:/tmp/a.exe", Quote("C:/tmp/a.exe"));
        Assert.Equal("a=b", Quote("a=b"));
    }

    [Fact]
    public void Quote_含空格加引号()
    {
        Assert.Equal("\"a b\"", Quote("a b"));
    }

    [Fact]
    public void Quote_含制表符加引号()
    {
        Assert.Equal("\"a\tb\"", Quote("a\tb"));
    }

    [Fact]
    public void Quote_空串产出空引号对()
    {
        // 空参数必须用 "" 表示，否则会被命令行解析吃掉，后面的参数整体左移
        Assert.Equal("\"\"", Quote(""));
    }

    [Fact]
    public void Quote_内部引号被反斜杠转义()
    {
        // a"b → "a\"b"
        Assert.Equal("\"a\\\"b\"", Quote("a\"b"));
    }

    [Fact]
    public void Quote_参数末尾的反斜杠在需要引号时加倍()
    {
        // 关键规则：引号前的反斜杠必须成对，否则 \" 会被理解成转义引号，
        // 引号无法闭合，后面所有参数错位。
        //
        // 注意：单独一个 "C:\dir\" 不需要引号（无空格无引号），会原样输出；
        // 只有在「需要加引号」的前提下，末尾反斜杠才要加倍。
        // 下面用含空格的路径来触发引号路径。
        Assert.Equal("\"C:\\dir x\\\\\"", Quote(@"C:\dir x\"));
    }

    [Fact]
    public void Quote_纯反斜杠路径不需要引号()
    {
        // 无空格/制表符/引号 → 不加引号，反斜杠原样保留（不加倍）
        Assert.Equal(@"C:\dir\", Quote(@"C:\dir\"));
    }

    [Fact]
    public void Quote_含空格且末尾反斜杠()
    {
        // "a b\" → "a b\\"
        Assert.Equal("\"a b\\\\\"", Quote(@"a b\"));
    }

    [Fact]
    public void Quote_内部引号前的反斜杠按2n加1()
    {
        // 规则：遇到引号时，前面累计的 n 个反斜杠要输出 2n+1 个
        // 输入 a\"b（反斜杠+引号）→ "a\\\"b"
        Assert.Equal("\"a\\\\\\\"b\"", Quote("a\\\"b"));
    }

    [Fact]
    public void Quote_单个反斜杠在中间原样保留()
    {
        Assert.Equal(@"a\b", Quote(@"a\b"));
    }

    [Fact]
    public void BuildCommandLine_多参数用空格连接()
    {
        var line = JobRunner.BuildCommandLine(new[] { "node", "a.js", "--flag" });

        Assert.Equal("node a.js --flag", line);
    }

    [Fact]
    public void BuildCommandLine_只给需要引号的参数加引号()
    {
        var line = JobRunner.BuildCommandLine(new[] { @"C:\Program Files\node.exe", "a.js" });

        Assert.Equal("\"C:\\Program Files\\node.exe\" a.js", line);
    }

    [Fact]
    public void BuildCommandLine_空数组产出空串()
    {
        Assert.Equal("", JobRunner.BuildCommandLine(Array.Empty<string>()));
    }

    [Fact]
    public void BuildCommandLine_空参数保留为引号对()
    {
        // 空参数不能被丢掉，否则 argv 位置整体左移
        var line = JobRunner.BuildCommandLine(new[] { "a", "", "c" });

        Assert.Equal("a \"\" c", line);
    }

    // ============ WindowsFileNameStart ============

    [Theory]
    [InlineData("node", 0)]
    [InlineData("node.exe", 0)]
    [InlineData(@"C:\dir\node.exe", 7)]     // "C:\dir\" 是 7 个字符
    [InlineData(@"C:/dir/node.exe", 7)]
    [InlineData("C:node.exe", 2)]           // 盘符相对路径：文件名从盘符后开始
    [InlineData(@"\node.exe", 1)]
    [InlineData("/node.exe", 1)]
    [InlineData("", 0)]
    public void WindowsFileNameStart_定位文件名起点(string command, int expected)
    {
        Assert.Equal(expected, JobRunner.WindowsFileNameStart(command));
    }

    // ============ NormalizeWindowsPath ============

    [Theory]
    [InlineData(null, null)]
    [InlineData("", null)]
    [InlineData("   ", null)]
    [InlineData("C:/a/b", @"C:\a\b")]
    [InlineData(@"C:\a\b\", @"C:\a\b")]
    [InlineData(@"C:\a\b///", @"C:\a\b")]
    [InlineData(@"C:\", @"C:\")]     // 根路径必须保留反斜杠
    [InlineData("C:", @"C:\")]       // 裸盘符补反斜杠
    public void NormalizeWindowsPath_规范化(string? input, string? expected)
    {
        Assert.Equal(expected, JobRunner.NormalizeWindowsPath(input));
    }

    // ============ BuildExecutableCandidates ============

    [Fact]
    public void BuildExecutableCandidates_无扩展名时补com和exe()
    {
        // .com 必须优先于 .exe（libuv 顺序）
        Assert.Equal(new[] { "node.com", "node.exe" }, JobRunner.BuildExecutableCandidates("node"));
    }

    [Fact]
    public void BuildExecutableCandidates_自带扩展名时原样名在前()
    {
        Assert.Equal(
            new[] { "node.exe", "node.exe.com", "node.exe.exe" },
            JobRunner.BuildExecutableCandidates("node.exe"));
    }

    [Fact]
    public void BuildExecutableCandidates_只支持com和exe不补cmd()
    {
        // 关键契约：npm 只有 npm.cmd，因此必须解析失败（ENOENT），
        // AOT 不能单方面补 .cmd 让它跑起来 —— 那会与 node 行为分歧。
        var candidates = JobRunner.BuildExecutableCandidates("npm");

        Assert.Equal(new[] { "npm.com", "npm.exe" }, candidates);
        Assert.DoesNotContain(candidates, c => c.EndsWith(".cmd"));
        Assert.DoesNotContain(candidates, c => c.EndsWith(".bat"));
    }

    [Fact]
    public void BuildExecutableCandidates_尾随点号不加分隔点()
    {
        // "name." → "name.com" / "name.exe"（不再补第二个点）
        Assert.Equal(
            new[] { "name.com", "name.exe" },
            JobRunner.BuildExecutableCandidates("name."));
    }

    // ============ SplitPath ============

    [Fact]
    public void SplitPath_按分号拆分并去空项()
    {
        Assert.Equal(
            new[] { @"C:\a", @"C:\b" },
            JobRunner.SplitPath(@"C:\a;;C:\b;").ToArray());
    }

    [Fact]
    public void SplitPath_去掉路径两端的引号()
    {
        // PATH 里常见的写法："C:\Program Files\nodejs"
        Assert.Equal(
            new[] { @"C:\Program Files\nodejs" },
            JobRunner.SplitPath("\"C:\\Program Files\\nodejs\"").ToArray());
    }

    [Fact]
    public void SplitPath_空串无输出()
    {
        Assert.Empty(JobRunner.SplitPath(""));
    }

    // ============ GetEnvValue ============

    [Fact]
    public void GetEnvValue_大小写不敏感()
    {
        var env = new Dictionary<string, string> { ["Path"] = @"C:\x" };

        Assert.Equal(@"C:\x", JobRunner.GetEnvValue(env, "PATH"));
        Assert.Equal(@"C:\x", JobRunner.GetEnvValue(env, "path"));
    }

    [Fact]
    public void GetEnvValue_缺失返回null()
    {
        var env = new Dictionary<string, string> { ["A"] = "1" };

        Assert.Null(JobRunner.GetEnvValue(env, "PATH"));
        Assert.Null(JobRunner.GetEnvValue(null, "PATH"));
    }

    // ============ WindowsSearchPathJoin ============

    [Theory]
    [InlineData(@"C:\a", @"C:\a\")]
    [InlineData(@"C:\a\", @"C:\a\")]
    [InlineData(@"C:/a/", @"C:/a\")]
    public void WindowsSearchPathJoin_目录补反斜杠(string root, string expected)
    {
        Assert.Equal(expected, JobRunner.WindowsSearchPathJoin(root, "n.exe", @"C:\cwd"));
    }

    [Fact]
    public void WindowsSearchPathJoin_空根用cwd()
    {
        Assert.Equal(@"C:\cwd\", JobRunner.WindowsSearchPathJoin("", "n.exe", @"C:\cwd"));
    }

    [Fact]
    public void WindowsSearchPathJoin_空根且空cwd时返回空()
    {
        // 返回空串表示「在当前目录下直接找」，由 ProbeCandidates 用裸名探测
        Assert.Equal("", JobRunner.WindowsSearchPathJoin("", "n.exe", ""));
    }

    // ============ BuildSearchRoots ============

    [Fact]
    public void BuildSearchRoots_带路径时只搜该目录()
    {
        var roots = JobRunner.BuildSearchRoots(true, @"C:\dir\", null);

        Assert.Equal(new[] { @"C:\dir\" }, roots);
    }

    [Fact]
    public void BuildSearchRoots_不带路径时cwd在前()
    {
        var env = new Dictionary<string, string> { ["PATH"] = @"C:\a;C:\b" };

        var roots = JobRunner.BuildSearchRoots(false, "", env);

        // 首项是空串（代表 cwd），其后是 PATH 各目录
        Assert.Equal("", roots[0]);
        Assert.Contains(@"C:\a", roots);
        Assert.Contains(@"C:\b", roots);
    }

    [Fact]
    public void BuildSearchRoots_优先用env里的PATH()
    {
        var env = new Dictionary<string, string> { ["PATH"] = @"C:\fromenv" };

        var roots = JobRunner.BuildSearchRoots(false, "", env);

        Assert.Contains(@"C:\fromenv", roots);
    }

    // ============ BuildEnvironmentBlock ============

    [Fact]
    public void BuildEnvironmentBlock_UTF16双null结尾()
    {
        var block = JobRunner.BuildEnvironmentBlock(new Dictionary<string, string> { ["A"] = "1" });

        // "A"=2 + "="=2 + "1"=2 + 值终止 2 = 8，再加整块终止 2 = 10
        Assert.Equal(10, block.Length);
        // 逐字节核对：A(0x41,0) =(0x3D,0) 1(0x31,0) \0\0 \0\0
        Assert.Equal(new byte[] { 0x41, 0, 0x3D, 0, 0x31, 0, 0, 0, 0, 0 }, block);
    }

    [Fact]
    public void BuildEnvironmentBlock_空env仍有双null()
    {
        // 关键回归：空 env 时若只产出 2 字节，CreateProcessW 返回
        // ERROR_INVALID_PARAMETER(87)。
        var block = JobRunner.BuildEnvironmentBlock(new Dictionary<string, string>());

        Assert.Equal(2, block.Length);
        Assert.Equal(new byte[] { 0, 0 }, block);
    }

    [Fact]
    public void BuildEnvironmentBlock_多个变量各自编码()
    {
        var block = JobRunner.BuildEnvironmentBlock(new Dictionary<string, string>
        {
            ["A"] = "1",
            ["B"] = "2",
        });

        // 每个 "K=V\0" 8 字节（K2 + =2 + V2 + 终止2）×2 + 整块终止 2 = 18
        Assert.Equal(18, block.Length);
    }

    [Fact]
    public void BuildEnvironmentBlock_非ASCII值按UTF16LE编码()
    {
        var block = JobRunner.BuildEnvironmentBlock(new Dictionary<string, string> { ["K"] = "中" });

        // "K=" 4 字节 + '中'(U+4E2D) 2 字节 + 值终止 2 + 块终止 2 = 10
        Assert.Equal(10, block.Length);
        Assert.Equal(0x2D, block[4]);
        Assert.Equal(0x4E, block[5]);
    }
}

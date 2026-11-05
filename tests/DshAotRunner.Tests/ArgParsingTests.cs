// ArgParsing 单元测试 —— runner 的 argv 解析
//
// 为什么这些测试值得存在：
//   这里决定了「哪些参数会成为 target 的 argv」。解析错了的表现不是崩溃，
//   而是 target 拿到错位的参数 —— 比如把 --ndjson 当成程序名，或者把
//   解释器前缀当成 target。这类缺陷在 e2e 里表现为「target 启动失败，
//   错误信息莫名指向一个不存在的程序」，排查成本远高于单测。
using DshAotRunner;
using Xunit;

namespace DshAotRunner.Tests;

public class ArgParsingTests
{
    private const string Flag = "--ndjson";

    private static (string[] Argv, bool Ndjson) Parse(params string[] args) =>
        ArgParsing.ParseArgs(args, Flag);

    [Fact]
    public void 首项是双横线时丢掉它()
    {
        var (argv, ndjson) = Parse("--", "node", "a.js");

        Assert.Equal(new[] { "node", "a.js" }, argv);
        Assert.False(ndjson);
    }

    [Fact]
    public void 没有双横线时原样返回()
    {
        var (argv, ndjson) = Parse("node", "a.js", "--flag");

        Assert.Equal(new[] { "node", "a.js", "--flag" }, argv);
        Assert.False(ndjson);
    }

    [Fact]
    public void ndjson开关被摘除()
    {
        // --ndjson 必须从 argv 里消失，否则会被当成 target 的程序名
        var (argv, ndjson) = Parse("--ndjson", "node", "a.js");

        Assert.True(ndjson);
        Assert.Equal(new[] { "node", "a.js" }, argv);
    }

    [Fact]
    public void ndjson开关在中间也被摘除()
    {
        var (argv, ndjson) = Parse("--", "node", "--ndjson", "a.js");

        Assert.True(ndjson);
        Assert.Equal(new[] { "node", "a.js" }, argv);
    }

    [Fact]
    public void ndjson关闭时flag为false()
    {
        var (_, ndjson) = Parse("node", "a.js");

        Assert.False(ndjson);
    }

    [Fact]
    public void 首项是js文件时取第一个双横线之后()
    {
        // node 解释器前缀形状：node runner.js -- target args
        var (argv, ndjson) = Parse("runner.js", "--", "node", "target.js");

        Assert.Equal(new[] { "node", "target.js" }, argv);
        Assert.False(ndjson);
    }

    [Fact]
    public void 首项是JS大写扩展名也识别()
    {
        var (argv, _) = Parse("runner.JS", "--", "target");

        Assert.Equal(new[] { "target" }, argv);
    }

    [Fact]
    public void 首项是js但没有双横线时原样返回()
    {
        // 找不到 "--" 就不能瞎猜边界，保持原样交给后续校验
        var (argv, _) = Parse("runner.js", "node", "a.js");

        Assert.Equal(new[] { "runner.js", "node", "a.js" }, argv);
    }

    [Fact]
    public void 空数组不崩溃()
    {
        var (argv, ndjson) = Parse();

        Assert.Empty(argv);
        Assert.False(ndjson);
    }

    [Fact]
    public void 只有双横线时得到空argv()
    {
        var (argv, _) = Parse("--");

        Assert.Empty(argv);
    }

    [Fact]
    public void 只启用ndjson时得到空argv()
    {
        var (argv, ndjson) = Parse("--ndjson");

        Assert.True(ndjson);
        Assert.Empty(argv);
    }

    [Fact]
    public void 多个ndjson标记全部摘除()
    {
        var (argv, ndjson) = Parse("--ndjson", "a", "--ndjson", "b");

        Assert.True(ndjson);
        Assert.Equal(new[] { "a", "b" }, argv);
    }

    [Fact]
    public void 双横线在js首项之后的多层嵌套()
    {
        // node x.js -- node y.js -- target 这种形状：取**第一个** "--" 之后
        var (argv, _) = Parse("x.js", "--", "node", "y.js", "--", "target");

        Assert.Equal(new[] { "node", "y.js", "--", "target" }, argv);
    }

    [Fact]
    public void 非js首项且不含双横线时保持全部参数()
    {
        var (argv, _) = Parse(@"C:\bin\node.exe", "-e", "console.log(1)");

        Assert.Equal(new[] { @"C:\bin\node.exe", "-e", "console.log(1)" }, argv);
    }

    [Fact]
    public void 首项为空串时原样保留()
    {
        // 空程序名由下游校验拒绝（RUNNER-SPEC §2），解析层不擅自丢弃
        var (argv, _) = Parse("", "a");

        Assert.Equal(new[] { "", "a" }, argv);
    }
}

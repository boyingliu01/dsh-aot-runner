// ProtocolJson 单元测试 —— NDJSON 协议编解码的正确性
//
// 为什么这些测试值得存在：
//   ProtocolJson 手写了 JSON 序列化（NativeAOT 下禁用 JsonSerializer，
//   见 Protocol.cs 顶部：反射序列化在 AOT 下要多付 ~1.2s 启动代价）。
//   手写意味着没有编译器帮你校验转义、字段省略、错误对象形状；
//   而这些形状直接决定 host 侧的 isSerializedRunnerError 校验是否通过。
//   一旦形状错了，host 会静默丢弃整条错误结果 —— 这类缺陷在端到端测试里
//   表现为「偶发超时」，极难定位。
using System.Text;
using DshAotRunner;
using Xunit;

namespace DshAotRunner.Tests;

public class ProtocolJsonTests
{
    // ---------------- ParseStart ----------------

    [Fact]
    public void ParseStart_读取全部字段()
    {
        const string line = """
            {"type":"start","cwd":"C:\\work","control":"pipe","env":{"PATH":"C:\\bin","NUM":"42"}}
            """;

        var req = ProtocolJson.ParseStart(line, out var error);

        Assert.Null(error);
        Assert.NotNull(req);
        Assert.Equal("start", req!.Type);
        Assert.Equal(@"C:\work", req.Cwd);
        Assert.Equal("pipe", req.Control);
        Assert.Equal(@"C:\bin", req.Env["PATH"]);
        // 非字符串的 env 值保留原始 JSON 文本（与 node 侧 JSON.stringify 对齐）
        Assert.Equal("42", req.Env["NUM"]);
    }

    [Fact]
    public void ParseStart_缺失可选字段时给默认值()
    {
        var req = ProtocolJson.ParseStart("""{"type":"start"}""", out var error);

        Assert.Null(error);
        Assert.NotNull(req);
        Assert.Equal("start", req.Type);
        Assert.Equal("", req.Cwd);
        Assert.Null(req.Control);
        Assert.Empty(req.Env);
    }

    [Fact]
    public void ParseStart_非法JSON返回错误而不是抛异常()
    {
        var req = ProtocolJson.ParseStart("{not json", out var error);

        Assert.Null(req);
        Assert.False(string.IsNullOrEmpty(error));
    }

    [Fact]
    public void ParseStart_非对象根节点被拒绝()
    {
        // 数组/字符串/数字都不是合法的 start 消息
        foreach (var payload in new[] { "[1,2,3]", "\"text\"", "42", "null" })
        {
            var req = ProtocolJson.ParseStart(payload, out var error);

            Assert.Null(req);
            Assert.Equal("message is not a JSON object", error);
        }
    }

    [Fact]
    public void ParseStart_env非对象时被忽略()
    {
        var req = ProtocolJson.ParseStart("""{"type":"start","env":"not-an-object"}""", out var error);

        Assert.Null(error);
        Assert.NotNull(req);
        Assert.Empty(req.Env);
    }

    [Fact]
    public void ParseStart_字符串字段类型不符时用默认值()
    {
        // type 给数字、cwd 给布尔 —— 类型不符必须回落而不是崩溃
        var req = ProtocolJson.ParseStart("""{"type":123,"cwd":true}""", out var error);

        Assert.Null(error);
        Assert.NotNull(req);
        Assert.Equal("", req!.Type);
        Assert.Equal("", req.Cwd);
    }

    // ---------------- PeekType ----------------

    [Fact]
    public void PeekType_取出type字段()
    {
        var type = ProtocolJson.PeekType("""{"type":"terminate"}""", out var error);

        Assert.Null(error);
        Assert.Equal("terminate", type);
    }

    [Fact]
    public void PeekType_缺失type返回null且无错误()
    {
        var type = ProtocolJson.PeekType("""{"other":1}""", out var error);

        Assert.Null(type);
        Assert.Null(error);
    }

    [Fact]
    public void PeekType_非法JSON报错()
    {
        var type = ProtocolJson.PeekType("{{", out var error);

        Assert.Null(type);
        Assert.False(string.IsNullOrEmpty(error));
    }

    [Fact]
    public void PeekType_非对象根节点返回null()
    {
        var type = ProtocolJson.PeekType("[1]", out var error);

        Assert.Null(type);
        Assert.Null(error);
    }

    // ---------------- AppendString（转义） ----------------

    [Fact]
    public void AppendString_转义JSON必需字符()
    {
        var sb = new StringBuilder();
        ProtocolJson.AppendString(sb, "a\"b\\c\nd\re\tf");

        Assert.Equal("\"a\\\"b\\\\c\\nd\\re\\tf\"", sb.ToString());
    }

    [Fact]
    public void AppendString_控制字符转成u转义()
    {
        var sb = new StringBuilder();
        ProtocolJson.AppendString(sb, "\u0001\u001f");

        Assert.Equal("\"\\u0001\\u001f\"", sb.ToString());
    }

    [Fact]
    public void AppendString_非ASCII字符逐码位转义()
    {
        // 实现把 >0x7E 的字符转成 \uXXXX —— 保证输出是纯 ASCII，
        // 不依赖宿主的代码页，也不给 AOT 的 UTF-8 编码留歧义。
        var sb = new StringBuilder();
        ProtocolJson.AppendString(sb, "中");

        Assert.Equal("\"\\u4e2d\"", sb.ToString());
    }

    [Fact]
    public void AppendString_空串产出空引号()
    {
        var sb = new StringBuilder();
        ProtocolJson.AppendString(sb, "");

        Assert.Equal("\"\"", sb.ToString());
    }

    [Fact]
    public void AppendString_不转义普通ASCII()
    {
        var sb = new StringBuilder();
        ProtocolJson.AppendString(sb, "abcXYZ019 _-.:/");

        Assert.Equal("\"abcXYZ019 _-.:/\"", sb.ToString());
    }

    // ---------------- Serialize ----------------

    [Fact]
    public void Serialize_TargetExitResult形状()
    {
        var json = ProtocolJson.Serialize(new TargetExitResult { ExitCode = 0 });

        Assert.Equal("""{"type":"target-exit","exitCode":0}""", json);
    }

    [Fact]
    public void Serialize_TargetExitResult最大无符号退出码()
    {
        // 退出码在 Windows 上是无符号 32 位。这个用例原先写的是 ExitCode = -1
        // 并断言输出 "-1" —— 把一个 bug 固化成了契约。
        //
        // host 侧 parseWindowsRunnerResult 的校验是
        //   Number.isSafeInteger(value.exitCode) && value.exitCode >= 0
        // 收到 -1 直接抛 "invalid target-exit result"。所以「能序列化出 -1」
        // 不是特性，是会让工具调用失败的缺陷。issue #15 C 项实测发现。
        var json = ProtocolJson.Serialize(new TargetExitResult { ExitCode = uint.MaxValue });

        Assert.Equal("""{"type":"target-exit","exitCode":4294967295}""", json);
    }

    [Fact]
    public void Serialize_TargetExitResult符号位翻转区间()
    {
        // 分界点：2147483647 是 int.MaxValue，再大就翻符号。
        // 逐个断言，避免以后有人又把类型改回 int。
        Assert.Equal("""{"type":"target-exit","exitCode":2147483647}""",
            ProtocolJson.Serialize(new TargetExitResult { ExitCode = 2147483647 }));
        Assert.Equal("""{"type":"target-exit","exitCode":2147483648}""",
            ProtocolJson.Serialize(new TargetExitResult { ExitCode = 2147483648 }));
    }

    [Fact]
    public void Serialize_ErrorResult只输出非null字段()
    {
        // 这是关键契约：null 字段必须完全省略，不能输出 "code":null。
        // host 侧校验 value.code === undefined || typeof value.code === "string"，
        // null 两者都不满足 → 整条错误被丢弃。
        var result = new ErrorResult
        {
            Error = new SerializedError { Name = "Error", Message = "boom", Code = "ENOENT" },
        };

        var json = ProtocolJson.Serialize(result);

        Assert.Equal(
            """{"type":"error","error":{"name":"Error","message":"boom","code":"ENOENT"}}""",
            json);
        Assert.DoesNotContain("null", json);
    }

    [Fact]
    public void Serialize_ErrorResult全字段()
    {
        var result = new ErrorResult
        {
            Error = new SerializedError
            {
                Name = "Error",
                Message = "spawn failed",
                Code = "ENOENT",
                Syscall = "spawn",
                Path = @"C:\missing.exe",
            },
        };

        var json = ProtocolJson.Serialize(result);

        Assert.Equal(
            """{"type":"error","error":{"name":"Error","message":"spawn failed","code":"ENOENT","syscall":"spawn","path":"C:\\missing.exe"}}""",
            json);
    }

    [Fact]
    public void Serialize_ErrorResult仅name时其余省略()
    {
        var result = new ErrorResult { Error = new SerializedError { Name = "Error", Message = "" } };

        var json = ProtocolJson.Serialize(result);

        Assert.Equal("""{"type":"error","error":{"name":"Error","message":""}}""", json);
    }

    [Fact]
    public void Serialize_输出可被JSON解析器读回()
    {
        // 形状对不对不能只靠字符串比对 —— 必须是合法 JSON 且字段值等价。
        var result = new ErrorResult
        {
            Error = new SerializedError { Name = "Error", Message = "引号\"与\\反斜杠", Code = "E1" },
        };

        var json = ProtocolJson.Serialize(result);
        using var doc = System.Text.Json.JsonDocument.Parse(json);
        var err = doc.RootElement.GetProperty("error");

        Assert.Equal("Error", err.GetProperty("name").GetString());
        Assert.Equal("引号\"与\\反斜杠", err.GetProperty("message").GetString());
        Assert.Equal("E1", err.GetProperty("code").GetString());
        Assert.Equal("error", doc.RootElement.GetProperty("type").GetString());
    }

    [Fact]
    public void Serialize_省略字段在JSON里确实不存在()
    {
        var result = new ErrorResult { Error = new SerializedError { Message = "only" } };

        using var doc = System.Text.Json.JsonDocument.Parse(ProtocolJson.Serialize(result));
        var err = doc.RootElement.GetProperty("error");

        Assert.False(err.TryGetProperty("syscall", out _));
        Assert.False(err.TryGetProperty("path", out _));
    }
}

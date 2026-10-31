// 手写 JSON 编解码 —— NativeAOT 下必须避开 JsonSerializer（见 Protocol.cs 顶部说明）
//
// 设计要点：
//   - 解析用 JsonDocument 遍历（启动开销 ~33ms，可接受）
//   - 序列化用 StringBuilder 手工拼装 + 最小转义（唯一用到 JsonDocument 的地方是解析）
//   - 严格保持与 Node runner 一致的字段名与错误对象形状
using System.Text;
using System.Text.Json;

namespace DshAotRunner;

internal static class ProtocolJson
{
    // ---------------- 解析 ----------------

    /// <summary>
    /// 解析一行 NDJSON。成功返回对象；失败通过 out 参数返回错误描述。
    /// 返回 null 表示解析失败。
    /// </summary>
    internal static StartRequest? ParseStart(string line, out string? error)
    {
        error = null;
        JsonDocument doc;
        try
        {
            doc = JsonDocument.Parse(line);
        }
        catch (JsonException ex)
        {
            error = ex.Message;
            return null;
        }

        using (doc)
        {
            var root = doc.RootElement;
            if (root.ValueKind != JsonValueKind.Object)
            {
                error = "message is not a JSON object";
                return null;
            }

            var req = new StartRequest();
            if (root.TryGetProperty("type", out var t) && t.ValueKind == JsonValueKind.String)
                req.Type = t.GetString() ?? "";

            if (root.TryGetProperty("cwd", out var c) && c.ValueKind == JsonValueKind.String)
                req.Cwd = c.GetString() ?? "";

            if (root.TryGetProperty("control", out var ctl) && ctl.ValueKind == JsonValueKind.String)
                req.Control = ctl.GetString();

            if (root.TryGetProperty("env", out var env) && env.ValueKind == JsonValueKind.Object)
            {
                foreach (var p in env.EnumerateObject())
                {
                    req.Env[p.Name] = p.Value.ValueKind == JsonValueKind.String
                        ? p.Value.GetString() ?? ""
                        : p.Value.GetRawText();
                }
            }
            return req;
        }
    }

    /// <summary>只取 type 字段，用于分派。解析失败返回 null。</summary>
    internal static string? PeekType(string line, out string? error)
    {
        error = null;
        try
        {
            using var doc = JsonDocument.Parse(line);
            if (doc.RootElement.ValueKind != JsonValueKind.Object) return null;
            if (!doc.RootElement.TryGetProperty("type", out var t)) return null;
            return t.ValueKind == JsonValueKind.String ? t.GetString() : null;
        }
        catch (JsonException ex)
        {
            error = ex.Message;
            return null;
        }
    }

    // ---------------- 序列化 ----------------

    internal static string Serialize(TargetExitResult r)
    {
        var sb = new StringBuilder(64);
        sb.Append("{\"type\":");
        AppendString(sb, r.Type);
        sb.Append(",\"exitCode\":").Append(r.ExitCode).Append('}');
        return sb.ToString();
    }

    internal static string Serialize(ErrorResult r)
    {
        var sb = new StringBuilder(256);
        sb.Append("{\"type\":");
        AppendString(sb, r.Type);
        sb.Append(",\"error\":{");
        AppendField(sb, "name", r.Error.Name, refFirst: true);
        AppendField(sb, "message", r.Error.Message, refFirst: false);
        AppendField(sb, "code", r.Error.Code, refFirst: false);
        AppendField(sb, "syscall", r.Error.Syscall, refFirst: false);
        AppendField(sb, "path", r.Error.Path, refFirst: false);
        sb.Append("}}");
        return sb.ToString();
    }

    private static void AppendField(StringBuilder sb, string key, string? value, bool refFirst)
    {
        if (value is null) return;      // 与 JsonIgnoreCondition.WhenWritingNull 一致
        if (!refFirst) sb.Append(',');
        AppendString(sb, key);
        sb.Append(':');
        AppendString(sb, value);
    }

    /// <summary>最小 JSON 字符串转义（等价于 JavaScriptEncoder.Default 对常见字符的行为）。</summary>
    internal static void AppendString(StringBuilder sb, string s)
    {
        sb.Append('"');
        foreach (var c in s)
        {
            switch (c)
            {
                case '"': sb.Append("\\\""); break;
                case '\\': sb.Append("\\\\"); break;
                case '\n': sb.Append("\\n"); break;
                case '\r': sb.Append("\\r"); break;
                case '\t': sb.Append("\\t"); break;
                case '\b': sb.Append("\\b"); break;
                case '\f': sb.Append("\\f"); break;
                default:
                    if (c < 0x20 || c > 0x7E)
                        sb.Append("\\u").Append(((int)c).ToString("x4"));
                    else
                        sb.Append(c);
                    break;
            }
        }
        sb.Append('"');
    }
}

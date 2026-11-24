// 消息类型解析 —— 把「一行 JSON 的 type 是什么」从主循环里分出来。
//
// 为什么独立：这是纯解析，不含任何 runner 状态，也不需要知道解析失败后
// 该投递什么错误（那是调用方的决定）。把它放在这里之后，主循环只剩
// 「拿到 type → 查表分发」一件事。
//
// ⚠️ 解析方式的选择很重要：只用 JsonDocument（启动开销 ~33ms），
// 绝不能用 JsonSerializer.Deserialize —— AOT 下会多付 ~1.2s 启动代价。
using System.Diagnostics.CodeAnalysis;

namespace DshAotRunner;

/// <summary>解析一行协议消息的 <c>type</c> 字段。</summary>
internal static class MessageType
{
    /// <summary>
    /// 取消息的 type 字段。成功返回 true 并输出 <paramref name="type"/>；
    /// 失败返回 false 并给出可直接投递的错误文案。
    /// </summary>
    /// <remarks>
    /// 用「返回 bool + out 错误」而不是「失败时回调投递」：
    /// 解析器不该知道错误要怎么送出去（IPC？stdout？），
    /// 否则它就和传输层绑死了，也没法在测试里单独验证。
    /// </remarks>
    internal static bool TryPeek(string line, [NotNullWhen(true)] out string? type, [NotNullWhen(false)] out string? error)
    {
        string? jsonError;
        using (Trace.Measure("json-peek-type"))
        {
            type = ProtocolJson.PeekType(line, out jsonError);
        }

        if (jsonError is not null)
        {
            error = $"invalid JSON: {jsonError}";
            type = null;
            return false;
        }

        if (type is null)
        {
            error = "message missing 'type'";
            return false;
        }

        error = null;
        return true;
    }
}

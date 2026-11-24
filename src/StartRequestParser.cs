// start 请求的 JSON 解析 —— 纯函数，不含 runner 状态。
//
// 为什么不判 null：调用方（HandleMessage）已经用 PeekType 校验过
// 「JSON 合法 + root 是对象 + type 是字符串」，而 ParseStart 只在
// 「JSON 非法」或「root 非对象」时返回 null —— 两种前置拒绝都已发生过。
// 保留一个永远进不去的分支比删掉更糟：它会让读者以为还有一条错误路径要维护。
namespace DshAotRunner;

/// <summary>把一行 start 消息解析成 <see cref="StartRequest"/>。</summary>
internal static class StartRequestParser
{
    /// <summary>解析。</summary>
    /// <remarks>
    /// 前置条件：<paramref name="line"/> 已通过 <see cref="MessageType.TryPeek"/>
    /// 的校验（合法 JSON、root 是对象、type 是字符串）。
    /// </remarks>
    internal static StartRequest Parse(string line)
    {
        StartRequest? req;
        using (Trace.Measure("json-parse-start"))
        {
            req = ProtocolJson.ParseStart(line, out var parseError);
            _ = parseError;   // 前置校验已拦下所有会返回 null 的情况
        }
        return req!;
    }
}

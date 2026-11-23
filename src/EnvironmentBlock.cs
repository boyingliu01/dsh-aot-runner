// CREATE_UNICODE_ENVIRONMENT 环境块构造。
//
// 为什么独立成文件：这是**纯函数** —— 输入一个字典，输出一段字节。
// 它不知道进程、IPC、Job Object 的任何事，却因为住在 JobRunner.cs 里，
// 每次想单测一个边界（空 env、特殊字符、宽字符）都要绕过整个 runner。
// 抽取后它的契约被 api 边界固定住：只有 <see cref="BuildEnvironmentBlock"/> 一个入口。
//
// 历史教训（不要"顺手简化"）：
//   - 用 StringBuilder + Encoding.Unicode.GetBytes 构块，空 env 时只得 2 字节，
//     CreateProcessW 返回 ERROR_INVALID_PARAMETER(87) —— 必须直接拼字节数组。
//   - 空 env 的正确结果不是 2 字节而是 4 字节。曾经的注释说"2 字节会返回 87"，
//     同文件的单测却断言 2 字节 —— 注释与断言互相矛盾，测试反而锁住了 bug。
using System.Text;

namespace DshAotRunner;

/// <summary>构造 CreateProcessW 的 Unicode 环境块。</summary>
internal static class EnvironmentBlock
{
    /// <summary>单个 `KEY=VALUE` 的宽字符终止符宽度（UTF-16 = 2 字节）。</summary>
    private const int WideCharBytes = 2;

    /// <summary>
    /// 把 <paramref name="env"/> 序列化成 CREATE_UNICODE_ENVIRONMENT 要求的环境块。
    /// </summary>
    /// <remarks>
    /// CREATE_UNICODE_ENVIRONMENT 要求：
    ///   每个 "KEY=VALUE" 以 \0 结尾，整块再以一个**额外的** \0 结尾（双 null 终止）。
    /// <para>
    /// 空 env 时整个块必须凑成 4 字节 —— 只给 2 字节会让 CreateProcessW
    /// 返回 ERROR_INVALID_PARAMETER(87)（实测：2 字节 → err=87，4 字节 → 成功）。
    /// 这意味着一旦 host 传空 env，所有 spawn 都会失败，而错误码 87 指向
    /// "环境块格式不对"这个结论非常不直观。
    /// </para>
    /// </remarks>
    public static byte[] BuildEnvironmentBlock(Dictionary<string, string> env)
    {
        var bytes = new List<byte>(256);

        foreach (var kv in env)
        {
            AppendWide(bytes, kv.Key);
            bytes.Add((byte)'=');
            bytes.Add(0);
            AppendWide(bytes, kv.Value);
            // 每个变量的两个 0 是「宽字符终止符」，不是块终止符。
            bytes.Add(0);
            bytes.Add(0);
        }

        // 块终止符：额外再补一个宽 NUL（双 NUL 收尾）。
        bytes.Add(0);
        bytes.Add(0);
        if (bytes.Count == WideCharBytes)
        {
            // 只有块终止符、没有任何变量 → 再补一对，凑成 4 字节（见上面 remarks）。
            bytes.Add(0);
            bytes.Add(0);
        }
        return bytes.ToArray();
    }

    /// <summary>按 UTF-16 小端逐字节追加一个字符串（不产生中间数组）。</summary>
    private static void AppendWide(List<byte> bytes, string value)
    {
        foreach (var ch in value)
        {
            bytes.Add((byte)(ch & 0xFF));
            // cast-audit:ignore char 右移 8 位后必然落在 0..255
            bytes.Add((byte)(ch >> 8));
        }
    }
}

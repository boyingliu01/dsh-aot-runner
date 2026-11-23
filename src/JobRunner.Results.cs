// JobRunner 的「结果投递」半边：把终态结果序列化并送到 host。
//
// 为什么单独成文件：这块是一个自洽的职责 —— 协议结果对象的构造、spawn 错误
// 与 Node 的对齐表、终态投递的一次性语义。它与「启动进程」「轮询退出码」
// 没有任何共同数据，原先挤在 JobRunner.cs 里只是历史原因。
//
// 两张错误码表逐项复制自 @deepseek-ai/dsh-subprocess-local/lib/runner.js，
// A/B 要求字节级一致，**不要自创文本**。
using System;
using System.Collections.Generic;

namespace DshAotRunner;

internal sealed partial class JobRunner
{
    // ---------------- 结果投递 ----------------

    // ── spawn 错误对齐表（逐项复制自 @deepseek-ai/dsh-subprocess-local/lib/runner.js）──
    // node 把 Win32 错误码映射成 Node 风格的 errno 字符串，再拼成
    //   { message: "<syscall> <code>", code, syscall, path? }
    // A/B 要求字节级一致，所以这张表必须逐条对齐，不能自创文本。

    /// <summary>Win32 错误码 → Node errno 字符串（对应 WINDOWS_SPAWN_ERROR_CODES）。</summary>
    internal static readonly Dictionary<int, string> WindowsSpawnErrorCodes = new()
    {
        [2] = "ENOENT",     // ERROR_FILE_NOT_FOUND
        [3] = "ENOENT",     // ERROR_PATH_NOT_FOUND
        [267] = "ENOENT",   // ERROR_DIRECTORY
        [5] = "EPERM",      // ERROR_ACCESS_DENIED
        [193] = "EFTYPE",   // ERROR_BAD_EXE_FORMAT
        [740] = "EACCES",   // ERROR_ELEVATION_REQUIRED
    };

    /// <summary>需要把程序名写入 syscall 和 path 的错误码（对应 NODE_SPAWN_DETAIL_CODES）。</summary>
    internal static readonly HashSet<string> NodeSpawnDetailCodes = new(StringComparer.Ordinal)
    {
        "EACCES", "ENOENT",
    };

    /// <summary>构造与 node 完全一致的 spawn 错误对象。</summary>
    internal static SerializedError MakeNodeSpawnError(string syscall, string code, string? path)
    {
        return new SerializedError
        {
            Name = "Error",
            Message = $"{syscall} {code}",
            Code = code,
            Syscall = syscall,
            Path = path,
        };
    }

    /// <summary>可执行文件在 PATH/cwd 中完全找不到 —— 对应 node 的 windowsPathNotFoundError。</summary>
    private void EmitSpawnEnoent(string program)
    {
        PublishResult(new ErrorResult
        {
            Error = MakeNodeSpawnError($"spawn {program}", "ENOENT", program),
        });
    }

    /// <summary>CreateProcessW 失败 —— 对应 node 的 asSpawnError。</summary>
    private void EmitCreateProcessError(int win32Code, string program)
    {
        Trace.Write($"CreateProcessW failed: win32Code={win32Code}");
        var code = WindowsSpawnErrorCodes.TryGetValue(win32Code, out var mapped) ? mapped : "UNKNOWN";
        // 详情型错误码把程序名带进 syscall/path；其余只保留 "spawn"
        PublishResult(new ErrorResult
        {
            Error = NodeSpawnDetailCodes.Contains(code)
                ? MakeNodeSpawnError($"spawn {program}", code, program)
                : MakeNodeSpawnError("spawn", code, null),
        });
    }

    /// <summary>
    /// 把终态结果对象序列化成协议 JSON。
    /// </summary>
    /// <remarks>
    /// 抽成 internal static 是为了能直接断言「未知类型不会把 runner 带崩」：
    /// 兜底分支返回 "{}" 而不是抛异常。runner 在收到无法识别的结果对象时
    /// 仍然必须给 host 一个**合法 JSON**，否则 host 侧的解析会失败，
    /// 表现为「调用挂住而不是报错」—— 比明确报错更难排查。
    /// </remarks>
    internal static string SerializeResult(object result) => result switch
    {
        TargetExitResult r => ProtocolJson.Serialize(r),
        ErrorResult r => ProtocolJson.Serialize(r),
        _ => "{}",
    };

    private void PublishResult(object result)
    {
        lock (_gate)
        {
            if (_resultDelivered) return;         // 只投递一次（RUNNER-SPEC §6.3）
            _resultDelivered = true;
        }

        WriteLine(SerializeResult(result));

        // RUNNER-SPEC §6.1 / 源码 publishTerminalResult(result, 0)：
        // 投递 terminal result 后立即 finish(0) —— runner 不应继续等待新消息。
        Finish();
    }

    internal void WriteLine(string json)
    {
        try
        {
            _channel.Send(json);
        }
        catch (Exception ex)
        {
            // host 已断开，忽略 —— 但留痕，免得「结果发出去了」这种假设永远不被质疑
            OnSendFailed(ex);
        }
    }

    /// <summary>发送失败的处理：只留痕，不抛出。</summary>
    /// <remarks>
    /// 独立成方法便于直接测试：真实场景里要制造「Send 抛异常」需要 host 断开，
    /// 而那是竞态，难以稳定复现。这里要守的行为很简单也很重要 ——
    /// **吞掉异常但留痕**。若改成直接吞掉不留痕，排查时会完全失去线索；
    /// 若改成重新抛出，runner 会在收尾阶段崩掉，连已有结果都丢了。
    /// </remarks>
    internal static void OnSendFailed(Exception ex) =>
        Trace.Write($"send failed: {ex.GetType().Name}: {ex.Message}");
}

// NDJSON 协议定义（替代 Node IPC，见 S2-IPC-结论.md §6）
//
// ⚠️ 重要性能约束（2026-10-30 实测）
// ------------------------------------------------------------------
// 禁止使用 JsonSerializer.Serialize/Deserialize + JsonSerializerContext。
// 在 NativeAOT 下，源生成上下文会让每个进程付出约 1.2 秒的启动代价：
//   - JsonDocument.Parse 手写解析 : 33ms   (2.71MB)
//   - JsonSerializer.Deserialize  : 1266ms (2.88MB)   ← 34 倍差距
// 原因是 AOT 运行时必须在启动期"水合"(hydrate) 序列化器所需的全部
// 类型元数据/反射信息，这段工作发生在 Main 之前，无法用环境变量关闭。
//
// 因此本文件只保留纯 POCO 数据模型；解析/序列化全部手写在 JobRunner
// 与 ProtocolJson 中（JsonDocument 遍历 + 手工 JSON 输出）。
// 如需新增字段，务必同步更新 ProtocolJson 里的手写映射。
// ------------------------------------------------------------------

namespace DshAotRunner;

internal sealed class StartRequest
{
    public string Type { get; set; } = "";
    public string Cwd { get; set; } = "";
    public Dictionary<string, string> Env { get; set; } = new();
    public string? Control { get; set; }
}

internal sealed class TargetExitResult
{
    public string Type { get; set; } = "target-exit";
    public int ExitCode { get; set; }
}

internal sealed class ErrorResult
{
    public string Type { get; set; } = "error";
    public SerializedError Error { get; set; } = new();
}

internal sealed class SerializedError
{
    public string Name { get; set; } = "Error";
    public string Message { get; set; } = "";
    public string? Code { get; set; }
    public string? Syscall { get; set; }
    public string? Path { get; set; }
}

// 轮询线程的启动 —— RUNNER-SPEC §7。
namespace DshAotRunner;

/// <summary>起退出检测用的后台线程。</summary>
internal static class PollerLauncher
{
    /// <summary>
    /// 起轮询线程。后台线程，进程退出不会等它。
    /// </summary>
    internal static void Start(ThreadStart pollBody) =>
        new Thread(pollBody) { IsBackground = true, Name = "poll" }.Start();
}

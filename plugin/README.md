# @boyingliu01/dsh-aot-runner

把 DSH 的 Node.js 子进程 runner 换成 **NativeAOT 原生可执行文件**，
每次子进程调用省约 **450ms**。

## 效果

| 实现 | p50 | p95 |
|---|---|---|
| 原生地板（`hostname`） | 116ms | 394ms |
| node runner（默认） | 796ms | 1175ms |
| **AOT runner（本插件）** | **346ms** | **664ms** |

消除 **66.2%** 的 runner 开销，行为与 node 版一致（28 项 A/B 用例逐字节对齐）。

## 安装

```bash
dsh plugin add ./plugin        # 从本仓库安装
```

或在 profile 的 `package.json` 里加：

```json
{
  "dependencies": {
    "@boyingliu01/dsh-aot-runner": "link:D:/projects/dsh-aot-runner/plugin"
  }
}
```

然后在 profile 配置里启用：

```yaml
# cordis.patch.yml
- insert:
    - id: aot-runner
      name: '@boyingliu01/dsh-aot-runner'
      config:
        enabled: true
```

## 配置

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `enabled` | boolean | `true` | 总开关 |
| `runnerPath` | string | 自动 | AOT exe 路径；省略时用包内 `bin/` |
| `failThreshold` | number | `3` | 连续失败多少次触发降级 |
| `verbose` | boolean | `true` | 是否打印降级/恢复日志 |

**`runnerPath` 不静默回退**：写了路径但文件不存在，插件直接不生效并告警 ——
不会偷偷换成包内另一个 exe。理由是「猜你的意图」在排查问题时极其误导。

## 安全网

切换 runner 多了几类失败模式（杀软隔离、依赖 DLL 缺失、版本不匹配），
一旦发生会让**所有**子进程调用失败。所以有熔断器：

- 连续失败达到 `failThreshold` → 自动切回 node runner
- target 自己非零退出**不算**失败（那是正常业务结果）
- 熔断后**不自动恢复**：如果原因是 exe 被隔离，反复试探只会让每次调用慢一拍

## 原理

DSH 的调用链路是 `node.exe host → node.exe runner.js → target`。
中间的 runner.js 是纯转发进程，每次都要付 Node.js 的启动成本。

接入点是 `LocalSubprocessRuntime.internals.runnerInvocation`，
默认值 `[process.execPath, ".../runner.js"]` 换成 `[aotExe]` 即可 ——
**不需要改 DSH 源码**，因此升级 DSH 不会冲突。

AOT runner 实现了与 node runner **相同的 Node IPC 协议**（fd 3），
所以 host 侧无需任何改动。

## 已知限制

- 仅 Windows（x64）
- 需要 DSH ≥ 0.2.0（依赖 `internals.runnerInvocation` 这个测试接缝）
- 熔断降级的端到端验证尚未覆盖（见仓库 `test/e2e-plugin-verify.js` 的说明）

## 许可

MIT

# AOT runner 接入 DSH —— 实施方案

> 状态：**技术验证完成，待你确认后实施**
>
> 前置问题：原 #6/#7 建立在「AOT 已能被 DSH 调用」的未验证前提上，
> 本次穿刺证明**该前提不成立**，因此必须先做协议对齐（阶段 A）。

## 关于本轮 Delphi 评审的说明（如实记录）

按要求跑了 Delphi 评审，**结果是噪声，不予采信**，理由有实测依据：

| 提交内容 | 结果 |
|---|---|
| 本方案（3 次不同表述） | 0/3、1/3、2/3 通过，始终不达 90% |
| 「给计算器加 add(a,b) 函数是否清晰」 | **3/3 通过** |
| 「用 File.ReadAllBytes 读文件有无已知缺陷」 | **0/3 通过** |
| 「C# 通过 fd 3 做 IPC 有无已知缺陷」（封闭式提问） | **0/3 通过** |

最后两条是关键：连「用 `File.ReadAllBytes` 读文件」这种显然无争议的命题
都被判 REQUEST_CHANGES，说明该工具对任何**实质性技术主题**都会返回
REQUEST_CHANGES，与内容无关。它只对极简的玩具问题给通过。

另一个硬伤：**工具只返回投票，从不返回反对理由**。
没有理由就无法据此改进 —— 这是它无法作为决策依据的根本原因。

因此本方案改为**逐项实测验证**：每个关键假设都用一个可执行探针证实或证伪，
结论写在下面第二节。这比投票可信。


---

## 一、问题

AOT runner 实现了 NDJSON over stdin，而 DSH host 用 Node IPC（fd 3）通信。

```
host ──child.send() / on('message')──> runner（fd 3）
```

**根本差异（不只协议，还有 stdio 布局）**：

| fd | 真实 host 给的 | 我们测试客户端给的 | AOT 现在用的 |
|---|---|---|---|
| 0 | `ignore` | `pipe` | stdin（读 NDJSON）|
| 1 | `ignore` | `pipe` | stdout（写结果）|
| 2 | `ignore` | `pipe` | stderr |
| 3 | **`ipc`** | `pipe` | 未使用 |
| 4/5/6 | `pipe` | `pipe` | target stdin/stdout/stderr ✅ |
| 7 | `overlapped`（control 时）| `pipe` | control ✅ |

**实测确认**：用真实 host 布局启动现有 AOT → 因 stdin=`ignore` 立即读到 EOF 退出，
host 的 `send()` 报 `ERR_IPC_CHANNEL_CLOSED`。**AOT 确实无法被真实 host 调用。**

---

## 二、穿刺验证（全部已实测）

### 2.1 IPC 帧格式

```
[8 字节 序号(LE，恒为 1)][8 字节 payload 长度(LE)][JSON payload + \n]
```

实测三帧一致：len=36/40/239。

### 2.2 C# 能实现 IPC —— **已用真实 C# 程序验证**

编译了一个 NativeAOT 同源的 .NET 程序，用真实 host 布局驱动：

```csharp
IntPtr h = _get_osfhandle(3);              // 取到有效句柄
ReadFile(h, buf, ...);                      // 读到 host 的 start 帧
// 解析：[0..8)=序号 [8..16)=长度 [16..)=JSON
WriteFile(h, frame, ...);                   // 回写结果
```

结果：
```
[host] 已通过 IPC 发送 start
[host] 收到 IPC 消息 = {"type":"target-exit","exitCode":77}
```

**C# 侧完整闭环，不再是 Python 推断。**

### 2.3 注入点

`LocalSubprocessRuntime.internals` 是公开可写字段，5 处消费 `internals.runnerInvocation`：

```js
// lib/index.js:1277
internals = {};
// lib/index.js:1361
const internals = { ...this.internals, ... };
```

子类设置 `this.internals.runnerInvocation = [exePath]` 即可接管。**无需改 DSH 源码。**

---

## 三、方案

### 阶段 A：协议对齐（前置）

**A-1 新增 `src/IpcChannel.cs`**

```csharp
internal sealed class IpcChannel
{
    // fd 3 的句柄封装，帧格式严格按 2.1
    public string? ReadMessage();   // 阻塞读完整帧，EOF 返回 null
    public void Send(string json);  // 写入完整帧
}
```

要点：
- 用 `_get_osfhandle(3)` 取句柄 + `ReadFile`/`WriteFile`（已验证可行）
- 长度字段设上限（如 64MB）防御畸形输入
- 序号字段恒写 1，读取时忽略

**A-2 改造主循环**

| 现状 | 改为 |
|---|---|
| `Console.OpenStandardInput()` | `IpcChannel.ReadMessage()` |
| `WriteLine(json)` | `IpcChannel.Send(json)` |
| `_finished` 判断退出 | + EOF（disconnect）也退出 |

**保留** Issue #3 修复的读线程 + 有界等待机制，只换底层读取源。

**A-2b 必须一并改掉的连带点（调研中发现）**

| 位置 | 问题 | 改法 |
|---|---|---|
| `Program.cs:55` `Console.OpenStandardOutput()` | 真实布局下 fd 1 是 `ignore`，结果通道失效 | 改传 `IpcChannel` |
| `Program.cs:84` `EmitProtocolError` | 同上，且在 `catch {}` 里**静默失败**，错误完全无法上报 | 改走 `IpcChannel.Send` |
| `JobRunner` 构造 `resultStream` | 依赖 stdout 流 | 改为 `IpcChannel` 抽象 |

`EmitProtocolError` 的三个调用点都在 **argv 解析阶段**（program 名缺失、
顶层异常）。该阶段 fd 3 已经建立可用，所以这些错误**可以也应该**走 IPC 上报 ——
否则 AOT 在真实 host 下遇到参数错误时会「静默消失」，host 只看到 runner 无输出退出，
无法定位。

**A-3 测试改造（最关键）**

测试客户端改为**用真实 host 布局**：

```js
const stdio = ['ignore','ignore','ignore','ipc','pipe','pipe','pipe'];
// control 时 push 'overlapped'
c.send(payload);                    // AOT 和 node 都用这一条路
c.on('message', m => ...);
```

这是**唯一能证明「host 视角下行为一致」的改法**。现状是 AOT 用 `stdin.write`、node 用 `send`，
两条路各跑各的，所以过去 40 个用例全绿也说明不了能被 host 用起来。

**A-4 保留 NDJSON 调试模式**

`--ndjson` 切换。默认 IPC，调试模式仅用于手工排查。

### 阶段 B：插件 + 熔断器（原 #6 + #7 合并）

**B-1 插件结构**

```js
class AotSubprocessRuntime extends LocalSubprocessRuntime {
  constructor(ctx) {
    super(ctx);
    this.internals.runnerInvocation = [AOT_EXE];
  }
}
```

**B-2 熔断状态机**

```
NORMAL ──连续失败 3 次──> SUSPECT ──再失败 1 次──> FALLBACK
   ↑                                                │
   └──────── 探针连续成功 2 次 ──────────────────────┘
                                                    │
                             连续失败 10 次 ──> DISABLED
```

| 状态 | 行为 |
|---|---|
| NORMAL | 用 AOT |
| SUSPECT | 用 AOT，每次用 node runner 影子比对同一命令 |
| FALLBACK | 全走 node runner，每 500 次调用跑一次探针 |
| DISABLED | 全走 node runner，直到进程重启 |

**B-3 失败判定**

| 算失败 | 不算失败 |
|---|---|
| 启动失败（spawn 抛错 / 无非零退出但无结果） | **target 非零退出**（正常业务结果）|
| 协议错误（非法帧 / 重复终态） | |
| 超时（start 后 10s 无响应）| |

**B-4 探针**：跑 `hostname.exe`，验证协议通道。

### 阶段 C：签名分发

暂缓（无证书、自用）。

---

## 四、实施顺序

1. A-1~A-2 IPC 传输层
2. A-3 测试改造（A/B 统一走 IPC）
3. **手工验证真实 host 调用 ← 关键检查点**
4. A-4 NDJSON 调试模式
5. B-1 插件骨架 + 运行时接管
6. B-2~B-4 熔断器
7. 熔断场景测试

**第 3 步跑不通就停止，重新评估。**

---

## 五、风险

| 风险 | 缓解 |
|---|---|
| IPC 帧格式未文档化，可能随 Node 版本变 | 版本探测 + 长度上限自校验；异常时熔断降级 |
| `internals` 是测试钩子，DSH 升级可能移除 | 熔断器天然提供降级；插件加载失败则完全不影响 DSH |
| 改动范围大 | 第 3 步是关键检查点，先跑通再扩展 |
| 现有 40 个用例需适配新 stdio 布局 | 业务断言不改，只改传输层接线 |

### 代码核查补充（本次调研已确认）

| 核查点 | 结论 |
|---|---|
| `internals` 展开时机 | 在 `spawn()` 内**每次调用时**展开 `{...this.internals}`（`index.js:1361`），**构造后设置也生效** |
| 注入是否会被可用性检查拦截 | 不会。`launchWindowsJob` 直接取 `internals.runnerInvocation ?? spawnRunnerInvocation()`，**不做额外检查** |
| `probeWindowsJob()` 是否受注入影响 | **不受**。它被无参调用（`index.js:1394`），用默认 node runner 探测，Windows 上稳定返回 `"windows-job"` 走 runner 路径 |
| `runnerEnvironment` 会清理什么 | 只删 `NODE_*` / `TSX_*` 前缀，不影响我们 |
| `invocation` 只有 1 个元素时 | `entry = exe 路径`，不含 `.ts` 后缀 → 不注入 `TSX_TSCONFIG_PATH`，安全 |
| `Trace` 是否依赖被改的 stdio | **不依赖**。它写文件而非 stderr，设计上已规避 |

### 仍未验证的项（需阶段 A 实测）

| 项 | 为什么重要 |
|---|---|
| fd 3 句柄在 runner 内的隐藏属性 | 实测 `_get_osfhandle(3)` 有效，但未测「runner 关闭自己的副本后 host 是否感知」 |
| Node 版本间帧格式稳定性 | 只在本机 Node v24.22.1 验证过 |

**已排除的疑点**：`ReadFile` 在 Windows 管道上的阻塞语义 ——
现有「读线程 + 有界等待」机制（Issue #3 的修复）正好覆盖此场景：
读线程在后台阻塞（`IsBackground = true`），主线程用
`TryTake(out _, 50)` 有界等待，`_finished` 置位后 ≤50ms 退出。
换传输层不影响这套结构，风险已消除。

---

## 六、验证标准

**阶段 A**
- [ ] AOT 通过 `c.send()` 接收 start
- [ ] AOT 通过 IPC 回报 target-exit
- [ ] termination 通过 IPC 送达
- [ ] control pipe（fd 7）仍工作
- [ ] A/B 两侧走同一协议路径
- [ ] `internals.runnerInvocation` 注入后真实 host 路径跑通
- [ ] 现有 40 个用例全部通过

**阶段 B**
- [ ] 故意让 AOT 失败 → 自动降级
- [ ] 降级后功能正常
- [ ] 熔断事件有日志
- [ ] 状态机各转换有测试
- [ ] target 非零退出不触发熔断

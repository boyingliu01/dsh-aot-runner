# 上游 Discussion 草稿：runner 启动 seam 在生产路径不可达

> 目标仓库：`deepseek-ai/deepseek-harness`
> 渠道：GitHub Discussions（按 CONTRIBUTING 要求）
> 关联：现有 [#11893](https://github.com/deepseek-ai/deepseek-harness/discussions/11893)
> 证据版本：`main` @ `fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159`

---

## 标题（候选）

```
[Bug] LocalSubprocessRuntime.spawn() 未透传 WindowsJobInternals / LinuxScopeInternals，导致 runner 启动 seam 在生产路径不可达
```

---

## 正文

### 现象

`windows-job.ts` 与 `linux-scope.ts` 都把 `runnerInvocation` 声明为**显式的可替换 seam**，
但 `LocalSubprocessRuntime.spawn()` 调用这两个函数时没有传 `internals`，
于是这些 seam 在**生产路径上恒不可达**——只有直接调用 `launchWindowsJob(spec, env, internals)`
的单元测试才能碰到。

这不是新问题，是 [#11893](https://github.com/deepseek-ai/deepseek-harness/discussions/11893) 描述现象在重构后的**同构剩余**：
缺陷从 `spawn()` 里的三元表达式，原样搬到了 `spawn()` 里 `launch` 的选择处。

### 证据

**Windows 侧** —— `packages/subprocess/subprocess-local/src/windows-job.ts:29-38`

```ts
/** Test seams for runner launch and dynamic capability checks. */
export interface WindowsJobInternals {
  spawn?: typeof spawn
  runnerInvocation?: RunnerInvocation          // ← 声明的 seam
  resolveRunnerInvocation?: () => RunnerInvocation
  runnerAvailable?: (invocation: RunnerInvocation) => boolean
  loadWin32ProcessBindings?: typeof loadWin32ProcessBindings
  probeCurrentTokenJobSupport?: typeof probeCurrentTokenJobSupport
}
```

`windows-job.ts:126-130` 确实消费了它：

```ts
export function launchWindowsJob(
  spec: SubprocessSpawnSpec,
  targetEnv: Record<string, string>,
  internals: WindowsJobInternals = {},      // ← 默认空对象
): ManagedProcessLaunch {
  const invocation = internals.runnerInvocation ?? spawnRunnerInvocation()
```

**但调用点** —— `index.ts:206-210`：

```ts
const launch = linuxScope === undefined
  ? launchWindowsJob(spec, env)                                      // ← 第三参数缺省 = {}
  : launchLinuxScope(spec, env, linuxScope.literalArgv)              // ← 第三位是 literalArgv
handle = bindManagedProcess(spec, launch, binding)
```

`spawn()` 已经算好了一份 `internals`（`index.ts:202`），但只喂给了 `fallback` 分支的
`spawnSubprocess(spec, internals)`，**没有喂给 `launchWindowsJob` / `launchLinuxScope`**。

**Linux 侧更明显**：`launchLinuxScope` 的签名是

```ts
// linux-scope.ts:672-677
export function launchLinuxScope(
  spec: SubprocessSpawnSpec,
  targetEnv: Record<string, string>,
  literalArgv: LiteralArgvOptions,
  internals: LinuxScopeInternals = {},      // ← 现在是第四位
): ManagedProcessLaunch {
  const invocation = internals.runnerInvocation ?? spawnRunnerInvocation()
```

`internals` 被挤到了第四位，而调用点只传三个参数。
`LinuxScopeInternals`（`linux-scope.ts:33-43`）里同样声明了
`runnerInvocation` / `resolveRunnerInvocation` / `runnerAvailable`，一个都到不了。

### 影响

1. **`internals` 上塞任何东西都不生效。** `LocalSubprocessRuntime.internals`（`index.ts:72`）
   是公开字段，但在 Windows / Linux-scope 主路径上，写进去的 `runnerInvocation` 被静默忽略。
   只有 `containmentMode === 'fallback'` 时才会被消费。
2. **失败是静默的。** 没有任何警告、没有类型错误（参数可选、有默认值），
   调用方会误以为自己成功替换了 runner，实际仍在跑默认实现。
3. **测试 seam 与生产路径不一致。** 单测直接调 `launchWindowsJob(spec, env, { runnerInvocation })`
   能拿到自定义 runner，同一条代码路径走 `spawn()` 就拿不到。这类"测了但没测到生产路径"的
   偏差，恰恰是 seam 类接口最容易出的事故。
4. **阻塞了所有想替换 runner 的实现。** 更换 runner 是实现层面的合法需求
   （例如用原生二进制替换 Node runner 以消除进程启动开销），而项目已为此准备好 seam，
   却无法从公开入口接上。

### 期望行为

`spawn()` 把已经构造好的 `internals` 透传给两个 `launch*`：

```ts
const launch = linuxScope === undefined
  ? launchWindowsJob(spec, env, internals)
  : launchLinuxScope(spec, env, linuxScope.literalArgv, internals)
```

若担心 `SpawnInternals` 与 `WindowsJobInternals` / `LinuxScopeInternals` 类型不兼容，
只需在调用处做一次窄化（这些字段本就是可选的，`SpawnInternals` 里没有的字段传 `undefined` 即可）。

### 为什么建议优先处理

- 修复面**极小**：一个调用点加一个参数，无控制流改动。
- **不需要社区代码**：这是让仓库**已有的** seam 真正可达，不涉及接受外部实现。
- 与项目自身设计意图一致：`WindowsJobInternals` 的文档注释写的是
  "Test seams for runner launch and dynamic capability checks"，
  说明"runner 启动方式可替换"是被有意设计的；当前只是没接到生产路径上。
- 顺手可加一条回归：构造一个 `spawn()` 级的测试，断言自定义 `runnerInvocation` 被调用到。
  这类测试能在未来再次重构时自动兜住同样的问题。

### 环境

- 仓库 `main` @ `fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159`
- 相关问题在 `0.2.0-rc.2` 已存在（`lib/index.js:1368`），重构后位置改变、性质未变
- 平台：Windows（同理适用于 Linux-scope 分支）

---

## 附：备选措辞（若维护者偏好提 PR）

如果需要，本问题也可以只以 Issue 形式跟踪，由维护者自行修复——
提出方不需要提交任何代码。上文"期望行为"已给出最小 patch 形态。

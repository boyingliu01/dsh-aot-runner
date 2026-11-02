# vendor/：DSH 上游补丁留档

这里存的是**对 `@deepseek-ai/dsh-subprocess-local` 的临时补丁**，不是本项目的代码。

## 为什么会有这个目录

DSH 0.2.0-rc.2 有一个传参缺陷，导致本项目的 AOT runner **完全无法生效**：

```js
// node_modules/@deepseek-ai/dsh-subprocess-local/lib/index.js:1368
handle = bindManagedProcess(spec,
  containmentMode === "linux-scope"
    ? launchLinuxScope(spec, env)      // ← 漏传第三参数 internals
    : launchWindowsJob(spec, env),     // ← 漏传第三参数 internals
  binding);
```

两个 `launch*` 函数都声明了 `internals = {}` 形参，内部也有
`internals.runnerInvocation ?? spawnRunnerInvocation()` —— 但因为调用时没传，
`internals` 恒为 `{}`，注入被完全忽略。

> **旁证**：`fallback` 分支是正确的（`spawnSubprocess(spec, internals)` 传到位了）。
> 两条路径不一致，说明这不是设计意图，是遗漏。

上游讨论：**[deepseek-ai/deepseek-harness#11893](https://github.com/deepseek-ai/deepseek-harness/discussions/11893)**

## 补丁内容

**只有 1 行**，语义等价于上游修好后的样子：

```diff
-  ... ? launchLinuxScope(spec, env) : launchWindowsJob(spec, env), binding);
+  ... ? launchLinuxScope(spec, env, internals) : launchWindowsJob(spec, env, internals), binding);
```

完整 diff 见 [`patch.diff`](dsh-subprocess-local-0.2.0-rc.2/patch.diff)。

## 目录内容

| 文件 | 说明 |
|---|---|
| `dsh-subprocess-local-0.2.0-rc.2/index.js.orig` | **原始文件留档**（md5 `0b4485aa…`），永不修改 |
| `dsh-subprocess-local-0.2.0-rc.2/index.js.patched` | 打过补丁的版本（md5 `66282a6b…`），供对照 |
| `dsh-subprocess-local-0.2.0-rc.2/patch.diff` | 两个版本的 unified diff |
| `patch-dsh.mjs` | 状态检查 / 打补丁 / 还原工具 |

## 用法

```bash
node vendor/patch-dsh.mjs status   # 查看当前状态（默认）
node vendor/patch-dsh.mjs apply    # 打补丁
node vendor/patch-dsh.mjs revert   # 还原
node vendor/patch-dsh.mjs verify   # 校验留档文件未被篡改
```

`status` 会明确告诉你三件事之一：

- **已打补丁** —— 插件可以生效
- **原始版本** —— 插件不会生效，需要 `apply`
- **未识别的代码形状** —— DSH 可能升级了，或上游已用别的方式修复，需要人工复核

## ⚠️ 这个补丁会丢

DSH 升级、`pnpm install`、重装依赖 —— **任何重写 node_modules 的操作都会覆盖它**。

丢了怎么办：

1. 跑 `node vendor/patch-dsh.mjs status` 看状态
2. 如果是「原始版本」，跑 `apply` 重新打上
3. 如果是「未识别的代码形状」，**先别急着 apply** —— 去看上游 discussion 是否已修复

## 上游修复后怎么办

**直接删掉整个 `vendor/` 目录**，并把插件依赖改回不需要补丁的状态。

判断是否已修复：跑 `status` 显示「未识别的代码形状」，且在
[#11893](https://github.com/deepseek-ai/deepseek-harness/discussions/11893)
里看到修复说明。

## 为什么不改 DSH 源码就做不了

排查时试过所有其他接缝：

| 方案 | 结果 |
|---|---|
| `internals.runnerInvocation` | ❌ 就是本文档说的缺陷 |
| `internals.spawn` | ❌ 同一处漏传，被调用 0 次 |
| `fallback` 分支 | ❌ 会丢 Job Object 进程隔离 |
| 复刻 `launchWindowsJob` | ❌ 依赖未导出的 `WindowsJobOwner` |
| 改 DSH 源码 | ❌ 升级即失效，且影响所有环境 |

所以补丁是唯一不放弃正确性的选择。这也是为什么值得把它提给上游 ——
不然每个想做 runner 优化的人都得踩一遍。

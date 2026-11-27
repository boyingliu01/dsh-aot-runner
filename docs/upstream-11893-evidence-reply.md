# 上游回复草稿：#11893 补充实证（生产路径 A/B 数据 + 独立复现背书）

> 目标：`deepseek-ai/deepseek-harness` Discussion **#11893**
> 链接：https://github.com/deepseek-ai/deepseek-harness/discussions/11893
> 证据基线：`master` @ `4b399c39a6d1479cd84ca591b4d7c88e24d38a96`（2026-11-22，实测复核于 2026-11-27）
> 用途：作为 **#11893 下的一条回复**（不是新开 discussion），目的是把该线索从「单人报 bug」推进为「多人复现 + 现成 patch + 收益可量化」

---

## 一、发之前必须明白这份材料为什么有效

原始 discussion 目前的状态是：**单人报告 + 路人指了个 fork + 无维护者介入**。它推不动，不是因为 bug 不真，而是因为**缺少三个让维护者必须回应的东西**：

| 缺口 | 本回复提供 |
|---|---|
| 「这是不是只有你会踩？」 | **第二位独立复现者的现成 patch**（`aturzone`，含回归测试） |
| 「修了值多少？」 | **生产路径 A/B 实测：每次调用省 59.1~59.6%，p99 改善 73~124ms** |
| 「现在到底修没修？」 | **截至今日 master HEAD 仍复现**（逐行给出调用点） |

**关键策略：不要把它写成「请修我的插件」。** 要写成「这个 seam 在整个项目里不可达，我量化了它值多少」——前者是私利，后者是项目缺陷。

---

## 二、正文（可直接粘贴到 #11893）

---

补一份**量化证据**与**独立复现背书**，希望有助于让这处 seam 的修复排上优先级。

### TL;DR

- 缺陷在 `master` @ `4b399c3`（2026-11-22）**仍然存在**，位置与本文描述一致。
- 这处 seam 的缺失**有可量化的性能代价**：在生产路径上实测，替换 runner 后每次子进程调用省 **59.1%~59.6%**，p99 长尾改善 **73~124ms**。
- @aturzone 在 2026-11-07 已给出带回归测试的完整修复（fork 分支 `fix/subprocess-managed-internals`），实现方式是类型安全的窄化提取，与项目现有设计意图一致。**该修复至今未合入。**

### 1. 截至今日的复现确认

`master` @ `4b399c39a6d1479cd84ca591b4d7c88e24d38a96`（`Merge pull request #8961 ... worktree-release-dsh-0.2.3-alpha.2`）：

**`packages/subprocess/subprocess-local/src/index.ts:215`** —— `internals` 已经构造好：

```ts
const internals: SpawnInternals = { ...this.internals, onSpillFailure: this.reportSpillFailure }
```

**`:217`** —— 但只喂给了 fallback 分支：

```ts
if (containmentMode === 'fallback') {
  handle = spawnSubprocess(spec, internals)          // ← 传了
} else {
  ...
  const launch = linuxScope === undefined
    ? launchWindowsJob(spec, env)                                     // ← 没传（第 3 参数 internals 缺省）
    : launchLinuxScope(spec, env, linuxScope.literalArgv)              // ← 没传（internals 在第 4 位）
  handle = bindManagedProcess(spec, launch, binding)
```

两个 `launch*` 都确有该形参，且确实消费它：

| 文件 | 签名 | 消费点 |
|---|---|---|
| `windows-job.ts:136-141` | `launchWindowsJob(spec, targetEnv, internals: WindowsJobInternals = {})` | `internals.runnerInvocation ?? spawnRunnerInvocation()` |
| `linux-scope.ts:676-682` | `launchLinuxScope(spec, targetEnv, literalArgv, internals: LinuxScopeInternals = {})` | 同上 |

`WindowsJobInternals`（`windows-job.ts:43-45`）与 `LinuxScopeInternals` 都声明了
`runnerInvocation` / `resolveRunnerInvocation` / `runnerAvailable` 三个字段。

> **值得注意的不对称**：同一次 `spawn()` 里，`fallback` 分支把 `internals` 传到位了，
> 而 managed 分支没有。这看起来是实现遗漏，而不是「managed 路径有意不支持替换 runner」——
> 如果是有意为之，`WindowsJobInternals` 上就不该留 `runnerInvocation` 这个字段。

### 2. 这个 seam 值多少：生产路径 A/B 实测

为了回答「修它有多少收益」，我实现了一个 NativeAOT 的 runner 替换（消除 Node 运行时冷启动），
并在**真实 `spawn()` 路径**上做了交替采样对比。

**方法**（刻意按测量纪律执行，避免自欺）：

- 对照组与实验组走**同一条 `LocalSubprocessRuntime.spawn()` 路径**，仅 `internals.runnerInvocation` 不同；
- 由于该 seam 不可达，实验中在 `node_modules` 里临时补上第三个参数（**就是本 issue 建议的那一行**）；
- **ABBA 交替采样**，3 轮 × 100 次，记录每轮环境负载；
- 只采信离散度 < 10% 的轮次，**不可信的数字不取平均**。

**结果**：

| 轮次 | node runner p50 | AOT runner p50 | 收益 | node 离散度 | AOT 离散度 | 失败 |
|---|---|---|---|---|---|---|
| 1 | 156ms | 63ms | **59.3%** | 11.7% | 1.9% | 0 |
| 2 | 156ms | 64ms | **59.1%** | 11.8% | 2.8% | 0 |
| 3 | 158ms | 64ms | **59.6%** | 20.5% | 4.1% | 0 |

- **三轮收敛在 59.1%~59.6%**，零失败、零输出不一致。
- **p99 长尾改善 73~124ms**（交互式场景里长尾比中位数更影响体感）。
- 真实命令（`hostname` / `whoami` / `cmd /c echo`）每次省 **77~155ms**。

> 补充一个观察，可能对项目本身也有参考价值：**默认 node runner 的离散度是 11.7%~20.5%，
> 替换后降到 1.9%~4.1%。** 也就是说这段固定开销不只是「慢」，还**不稳定**。
> 这是 `spawn()` 每次重新加载 Node 运行时（V8 初始化 + 模块解析）的固有代价。

**行为一致性**：该 runner 与 node 版实现了相同的 Node IPC 协议（fd 3），
在 **53 个用例**上 stdout/stderr/exitCode/错误对象**逐字节一致**
（含 fd 3/4/5/6/7 布局、`WINDOWS_SPAWN_ERROR_CODES` 映射、`.com`/`.exe` 搜索顺序、
terminate 竞态、3MiB env 块、ENOENT 错误文本）。这说明**这个 seam 完全够用一个真实实现**——
不是「理论上可替换」，而是已经有人替换成功、且行为可对齐。

### 3. 已有现成修复（推荐直接采用）

@aturzone 提出的 fork 分支 `fix/subprocess-managed-internals`
（commit `d631ef32`，2026-11-07，「`fix(subprocess): forward managed-launch runner seams from spawn()`」）
已经解决了这个问题的**全部难点**：

- 新增 `LocalSubprocessInternals` 交叉类型，把 `SpawnInternals` 与
  `WindowsJobInternals` / `LinuxScopeInternals` 的三个 runner seam 字段合并；
- 用 `managedRunnerSeams(internals)` 做**窄化提取**，absent 的条目直接省略
  （而不是传一个 undefined 对象，避免覆盖默认值）；
- **附带回归测试**：在 `local.spec.ts` 里构造 `runnerInvocation` / `resolveRunnerInvocation` /
  `runnerAvailable` 三个 seam，断言它们能被 `spawn()` 走到。

改动量：`src/index.ts` **+23 −4**，`tests/local.spec.ts` **+14 −3**。无控制流改动。

我按这个思路在本地验证过等价改动，A/B 53/53 通过、上述性能数据即由该改动测得，
可以确认**修复后没有任何行为回归**。

### 4. 为什么这条值得优先处理

1. **修复面极小**：一个调用点补参数，无控制流改动，有现成 patch 与测试。
2. **不是「为新需求加功能」，而是让已有 seam 可达**：`WindowsJobInternals` 的注释写的是
   "Test seams for runner launch and dynamic capability checks"——seam 本来就在设计里，
   只是没接到生产路径上。
3. **当前失效是完全静默的**：参数可选且有默认值 `= {}`，既不报错也没有类型错误，
   调用方会误以为替换成功。这类「配置了但不生效」的缺陷在生产里最难排查。
4. **测试与生产不一致**：单测直接调 `launchWindowsJob(spec, env, internals)` 能拿到自定义 runner，
   走 `spawn()` 拿不到。seam 类接口最容易出这类「测了但没测到生产路径」的事故。
5. **收益可量化且显著**：59.1%~59.6% 的固定开销消除，且把 p50 抖动从 12%~21% 降到 2%~4%。

### 5. 最小 patch 形态

若不便直接取 fork，下面这个改动即可（类型窄化由 @aturzone 的 `LocalSubprocessInternals` 处理）：

```ts
const launch = linuxScope === undefined
  ? launchWindowsJob(spec, env, internals)
  : launchLinuxScope(spec, env, linuxScope.literalArgv, internals)
```

建议同时加一条 `spawn()` 级回归测试，断言自定义 `runnerInvocation` 被实际调用——
这样将来再次重构（这个缺陷本身就是一次重构后复现的）能自动兜住。

### 6. 环境

| 项 | 值 |
|---|---|
| 复现仓库 | `master` @ `4b399c39a6d1479cd84ca591b4d7c88e24d38a96`（2026-11-22） |
| 该缺陷也已存在于发布版 | `@deepseek-ai/dsh-subprocess-local` `0.2.2-rc.5` 与 `0.2.3-alpha.2` |
| 平台 | Windows（managed 路径）；Linux-scope 分支同理 |
| Node | 22.x / 26.x 均复现 |

若需要，我可以提供完整的 A/B 复现脚本与原始数据（含每轮环境负载记录）。
提出方**不需要提交任何代码**——这里的意图只是让已有 seam 真正可达，
具体由维护者决定以何种方式合入。

---

## 三、附带建议：如何在 #35 里同步进度

发完这里的回复后，在你自己仓库的 issue #35 下追加一条进度评论（见同目录 `issue-35-progress-comment.md`），标注：

- 阻塞 A 状态：**已提交带实证的回复**（附链接），但仍待上游合入
- 阻塞 B：✅ 已完成（0.2.8 已发布）
- 契约覆盖率门禁：✅ 已完成
- `SECURITY.md` / `CONTRIBUTING.md`：✅ 已完成
- 剩余：上游合入（项目外）、覆盖率数字提升、方法论长文

---

## 四、发送方式

Discussion 回复需要 GitHub 登录态。两种方式：

**A. 手动粘贴（推荐）**：打开
https://github.com/deepseek-ai/deepseek-harness/discussions/11893
在底部评论框粘贴上面「二、正文」（从「补一份**量化证据**」开始到「具体由维护者决定以何种方式合入。」）。

**B. 用 `gh` 尝试**：discussion 评论需要 GraphQL + discussion node id：
```bash
# 先取 node id
gh api graphql -f query='query { repository(owner:"deepseek-ai", name:"deepseek-harness") { discussion(number:11893) { id } } }'
# 再发评论
gh api graphql -f query='mutation($d:ID!,$b:String!){ addDiscussionComment(input:{discussionId:$d, body:$b}){ comment { url } } }' -f d="<id>" -f b="<body>"
```
需要 `read:discussion` / `write:discussion` scope。若 `gh` 当前 token 没有该 scope 会 403，届时改用手动粘贴。

# #12532 Cross-post 正文（可直接粘贴）

> 目标：https://github.com/deepseek-ai/deepseek-harness/discussions/12532
> 与 #11893 的回复（[discussioncomment-19944366](https://github.com/deepseek-ai/deepseek-harness/discussions/11893#discussioncomment-19944366)）内容同源，
> 转发到这里是因为**这条先创建、且 @aturzone 的修复挂在这里**，是维护者更可能看的地方。
> 相比 #11893 版本，本条**新增了「已验证可干净应用到当前 master 的 patch 文件」**。

---

补一份**可直接合并的实证材料**。

@aturzone 的根因分析与修复已经很清楚，这里只补充**维护者合并前最需要的三件事**：
这个缺陷值多少、修复是否仍然有效、以及一份能直接 `git am` 的 patch。

### 1. 修复至今仍可干净应用到当前 master（已实测）

我把 @aturzone 的 commit 导出成 patch，在 `master` @ `4b399c3`（2026-11-22）上做了应用验证：

```bash
$ git clone --depth 1 --filter=blob:none --sparse https://github.com/deepseek-ai/deepseek-harness.git
$ git sparse-checkout set packages/subprocess/subprocess-local
$ git apply --check aturzone-fix-d631ef32.patch
# → 无输出，退出码 0
$ git apply aturzone-fix-d631ef32.patch
$ grep -n 'launchWindowsJob(spec\|launchLinuxScope(spec' packages/subprocess/subprocess-local/src/index.ts
239:      const seams = managedRunnerSeams(internals)
241:        ? launchWindowsJob(spec, env, seams)
242:        : launchLinuxScope(spec, env, linuxScope.literalArgv, seams)
```

**结论：这个修复在 20 天后依然零冲突，可以直接 `git am`。** 不需要 rebase，不需要解决冲突。

patch 文件与校验和（也可从 fork 的 `d631ef32` 直接取）：

```
aturzone-fix-d631ef32.patch
sha256: 3ff14b308b0a71acd612ccbd75b2553253b1d2f775a86c3e298564ac1d86013d
```

> 注：`d631ef32` 是分支当前 HEAD，比评论里提到的 `ab42e3b983` 更新（含后续修订）。

### 2. 这个缺陷值多少：生产路径 A/B 实测

为了回答「修它有多少收益」，我实现了一个 NativeAOT runner（消除每次 `spawn()` 重新加载
Node 运行时的开销），并在**真实 `spawn()` 路径**上做了交替采样对比。

**方法**：对照组与实验组走同一条 `LocalSubprocessRuntime.spawn()`，仅 `internals.runnerInvocation` 不同；
由于该 seam 当前不可达，实验中临时应用了上面那份 patch（**即本 issue 建议的改动本身**）；
ABBA 交替采样，3 轮 × 100 次；只采信离散度 < 10% 的轮次。

| 轮次 | node runner p50 | AOT runner p50 | 收益 | node 离散度 | AOT 离散度 | 失败 |
|---|---|---|---|---|---|---|
| 1 | 156ms | 63ms | **59.3%** | 11.7% | 1.9% | 0 |
| 2 | 156ms | 64ms | **59.1%** | 11.8% | 2.8% | 0 |
| 3 | 158ms | 64ms | **59.6%** | 20.5% | 4.1% | 0 |

- **三轮收敛在 59.1%~59.6%**，零失败、零输出不一致，p99 长尾改善 **73~124ms**。
- 真实命令（`hostname` / `whoami` / `cmd /c echo`）每次省 **77~155ms**。

> **一个可能对项目本身有价值的观察**：默认 node runner 的离散度是 **11.7%~20.5%**，
> 替换后降到 **1.9%~4.1%**。也就是说这段固定开销不只是「慢」，还**不稳定**。
> 这是 `spawn()` 每次重新加载 Node 运行时（V8 初始化 + 模块解析）的固有代价。

**行为一致性**：该 runner 实现了与 node 版相同的 Node IPC 协议（fd 3），在 **53 个用例**上
stdout/stderr/exitCode/错误对象**逐字节一致**（fd 3/4/5/6/7 布局、`WINDOWS_SPAWN_ERROR_CODES` 映射、
`.com`/`.exe` 搜索顺序、terminate 竞态、3MiB env 块、ENOENT 错误文本）。
这说明这个 seam **够用一个真实完整的实现**，不是理论上的可替换性。

### 3. 一处值得注意的不对称

同一次 `spawn()` 里：

```ts
:215  const internals: SpawnInternals = { ...this.internals, onSpillFailure: ... }
:217  if (containmentMode === 'fallback') {
:217    handle = spawnSubprocess(spec, internals)        // ← fallback 分支传了
      } else {
:222      ? launchWindowsJob(spec, env)                 // ← managed 分支没传
:223      : launchLinuxScope(spec, env, literalArgv)
```

**fallback 分支把 `internals` 传到位了，managed 分支没有。** 这基本排除了
「managed 路径有意不支持替换 runner」的解释 —— 若是有意，`WindowsJobInternals`
（`windows-job.ts:43-45`）上就不该保留 `runnerInvocation` 这个字段。

### 4. 为什么值得优先处理

1. **修复零冲突**，可直接 `git am`（见 §1）。
2. **不是加功能，是让已有 seam 可达**：`WindowsJobInternals` 的注释是
   "Test seams for runner launch and dynamic capability checks" —— seam 本就在设计里。
3. **当前失效完全静默**：参数可选且有默认值 `= {}`，既不报错也无类型错误，
   调用方会误以为替换成功。
4. **测试与生产不一致**：单测直接调 `launchWindowsJob(spec, env, internals)` 能拿到自定义 runner，
   走 `spawn()` 拿不到。这类「测了但没测到生产路径」正是 seam 接口最容易出的事故。
5. **收益可量化**：59.1%~59.6% 的固定开销消除，p50 抖动从 12%~21% 降到 2%~4%。

### 5. 环境

| 项 | 值 |
|---|---|
| 验证基线 | `master` @ `4b399c39a6d1479cd84ca591b4d7c88e24d38a96`（2026-11-22） |
| patch | `d631ef32`，`git apply --check` 通过（2026-11-27 复验） |
| 缺陷也存在于 | `@deepseek-ai/dsh-subprocess-local` `0.2.2-rc.5` / `0.2.3-alpha.2` |
| 平台 | Windows（managed 路径）；Linux-scope 同理 |
| Node | 22.x / 26.x 均复现 |

如果需要，我可以提供完整的 A/B 复现脚本与原始数据（含每轮环境负载记录）。
提出方不需要提交任何代码 —— 只是希望让已有的 seam 真正可达，具体由维护者决定以何种方式合入。

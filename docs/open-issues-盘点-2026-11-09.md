# Open Issues 盘点（2026-11-09）

> 盘点全部 open issue 的**真实状态**（原有 8 条 + 新发现 3 条），逐条核对仓库与外部证据，
> 区分「已可关闭 / 已过时 / 证据不足 / 真未做」。
>
> **Issue 是唯一事实来源**，本文只是给不看 Issue 的人一份带证据的结论。
> 核对时间：2026-11-09，HEAD = `6cb7753`。

---

## 一句话结论

**重新分为三类：**

- **4 条描述已过时**（#19/#20/#12/#18-A）—— 工作早已做完或上游已变，需要改台账，不是开发
- **3 条真未做**（#15/#16/#17）—— 范围清晰可开工，但都不是「修缺陷」
- **1 条卡着日常开发**（#21）—— 而且**修复代码已经写好并验证过，只差落地**

此外发现**3 件不在任何 issue 里的问题**（已建 #22/#23/#24），
其中 #24 是本次跑测试时才暴露的、会破坏工作区的真实缺陷。

最关键的一条：**#21 的修复既没提交也没装到本机 ——
修它的人停在了「验证通过」和「落地生效」之间，而拦住这个提交的，正是这个缺陷自己。**

---

## 状态总表

现有 8 条 open issue：

| # | 标题 | 盘点结论 | 证据 | 处置 |
|---|---|---|---|---|
| 21 | 含 .js 的提交无法通过 | **根因已修但未落地** | 见 §1 | 提交 + 安装，然后关闭 |
| 19 | 批量低成本修复 | **7 项中 4 项已完成**，标题已过时 | 见 §2 | 拆分改写，只留真未做的 |
| 20 | 上游跟进槽位 | **信息过时且偏悲观** | 见 §3 | 更新正文（上游已有实质回应） |
| 12 | 累积长期观测数据 | 进度约 3/5，**验收口径与物理条件不匹配** | 见 §4 | 改验收口径 |
| 15 | 契约漂移自动检测 | **真未做**，范围明确 | — | 可开工，中等工程量 |
| 16 | 隔离价值故障注入 | **真未做** | — | 可开工，需设计实验 |
| 17 | 测量方法论公开长文 | **真未做**，需推广渠道 | — | 依赖作者意愿，非代码工作 |
| 18 | 上游协作升级 + 降级可观测 | **A 项已有实质回应**；B/C 部分未做 | 见 §3 | A 改为「跟进」；B 可开工 |

盘点中另外**发现 3 件不在任何 issue 里的事**，已新建 2 条：

| # | 标题 | 为什么没被追踪到 |
|---|---|---|
| **22** | 收录 PR #13369 被 Submission gate 挡住 | #20 的自动槽位只记 `open/closed`，记不到「被检查挡住」 |
| **23** | `plugin/bin` 的 exe 比 `dist` 旧 | 构建防护正确报了 `exit 3`，但没人接住 → 无人登记 |
| **24** | 已暂存的 `pre-commit-shortcircuit-verify.js` 会挂死并破坏索引 | §6.2，跑一次才发现，无任何测试/门禁能发现 |

---

## §1 Issue #21：根因已修但未落地（最高优先级）

### 现场复现（本次实测）

在 HEAD `6cb7753` 上，任意含 `.js` 的提交依然被拦：

```
$ sh .githooks/pre-commit          # 暂存一个 .md 探针
...
→ Gate 5: Tests & coverage...
Running tests...
Source file(s) changed, finding related tests...
   No related test files found, running full test suite...
 MISSING DEPENDENCY  Cannot find dependency '@vitest/coverage-v8'

❌ BLOCKED - Tests FAILED in full test suite
```

issue 描述完全属实，**这个缺陷现在是本项目正常提交的主要障碍**。

### 但修复早已写好，只差落地

在 `xp-gate` 源码仓库（`D:\projects\xp-gate`）里：

```
$ git status --short githooks/adapters/typescript.sh
 M githooks/adapters/typescript.sh          # ← 98 行新增，34 行删除，未提交

$ git status --short githooks/__tests__/adapter-typescript-npx-probe.test.bats
?? githooks/__tests__/adapter-typescript-npx-probe.test.bats   # ← 178 行测试，未跟踪
```

改动包含 issue 里提的全部三个方向：

| issue 建议 | 修复是否覆盖 |
|---|---|
| 探测不得触发安装 | ✅ 新增 `_local_bin()`，只查 `node_modules/.bin`，彻底不用 `npx` 探测 |
| 测试运行器崩溃 ≠ 测试失败 | ✅ `run_coverage()` 捕获 `MISSING DEPENDENCY`，报 SKIP 而非失败 |
| SKIP 而非 BLOCK | ✅ 无本地 runner 时返回 0 并打印明确原因 |

**实测该修复对本案有效**（直接 source 修改后的 adapter 跑到 dsh-aot-runner）：

```
$ bash -c 'source githooks/adapter-common.sh; source githooks/adapters/typescript.sh; \
           cd /d/projects/dsh-aot-runner; run_tests; echo "RC=$?"'
Running TypeScript tests...
⏭️  SKIP - No test runner installed locally (node_modules/.bin has no vitest or jest)
   Install the runner this project uses, or declare its test command.
RC=0
```

改动前同样的调用必然走到 vitest 并崩在 coverage 依赖上。

### 为什么没生效：三道闸门都没过

| 闸门 | 状态 |
|---|---|
| 1. 提交到 xp-gate 仓库 | ❌ 未提交（改动只在工作区） |
| 2. 同步到 npm 包镜像 `src/npm-package/adapters/typescript.sh` | ❌ 仍是旧版（md5 不同，`diff` 显示 132 行差异） |
| 3. 装到本机 `~/.config/xp-gate/adapters/typescript.sh` | ❌ 仍是旧版，无 `_local_bin` |

**闸门 1 本身就是被 #21 挡住的** —— xp-gate 仓库自己也含 `.js` 文件，
提交这个修复会触发同一个缺陷。这是一个闭环：
**修 bug 的提交被这个 bug 拦住了。**

### 裁定

- 这不是「待开发」，是「待落地」。工作量 ≈ 提交 + 同步 + 安装，**远低于重写**。
- 但闸门 1 被自己挡住，需要绕行（见下方建议）。

### 建议处置（按顺序）

1. **绕行闸门 1**：在 xp-gate 仓库用 `--no-verify` 提交这两个文件，
   并在提交信息里注明「本次提交被 #21 自身挡住，故绕过；修复生效后不应再有此绕行」。
   *这是唯一需要绕行的一步，且理由有记录。*
2. 跑 `node scripts/sync-package-content.js` 同步 npm 镜像。
3. 跑 `xp-gate doctor --sync-hooks --force` 装到本机。
4. 回到本仓库，重放 §1 的复现步骤，确认 Gate 5 变成 SKIP。
5. 关闭 #21，并在 xp-gate 提一条说明「修复已发布版本 X」。

> 补充：闸门 3 的实际生效路径已核实 —— hook 的 adapter 解析顺序是
> `ADAPTER_DIR`（= `~/.config/xp-gate/adapters`，全局）优先于项目内副本，
> 所以**只改仓库不同步安装的话，本仓库永远跑不到新代码**。

---

## §2 Issue #19：7 项中 4 项已完成，标题已过时

标题写的是一批待办，但逐条核对下来**大部分早就做完了**，issue 没更新。

| 项 | issue 说 | 仓库实际 | 结论 |
|---|---|---|---|
| 0. README 声明 Windows 专用 | 待做 | README 第 22 行：「**这是 Windows x64 专用插件**」，并解释了原因 | ✅ 已完成 |
| 1. xp-gate 看不见 C# 的记录过时 | 待复核 | **记录确实过时**：`quality-status/main.json` 里 `csharp` 的 Gate 3/4 均为 `covered`，`csharp.sh` 适配器存在且生效 | ⚠️ **仍需改 ROADMAP.md:222-234、:323** |
| 2. `--clean` 删产物 | 待做 | `build.sh:258-270` 已改为「先备份 exe 到 mktemp，构建失败则还原」 | ✅ 已完成 |
| 3. `test:all` 不含 `--check` | 待做 | 实际上 `test:all` 仍不含 `--check`（只有 lint/coverage/各测试） | ❌ **仍未做** |
| 4. 覆盖率脚本报 0.0% | 待做 | `coverage-summary.py:152-168` 已实现「丢空报告 + 按 mtime 取最新」 | ✅ 已完成 |
| 5. CI Windows job 每次 push 不跑 | 待评估 | `ci.yml:101` 仍只在 `workflow_dispatch`/tag 跑 | ❌ 未做（原判断仍成立） |
| 6. `JobRunner`/`IpcChannel` 单元覆盖 | 待做 | 未做 | ❌ 未做（中等工程） |

**本次额外验证了第 2 项确实有效**：手动模拟 `--clean` 的删除路径后，
`dist/dsh-aot-runner.exe` 被删，但脚本的备份逻辑可完整还原（已实测还原并校验）。

### 裁定

issue 用「批量清单」的形态装了 7 件事，其中 4 件已完成且无人知晓。
**清单型 issue 的问题是完成一半以后没人愿意重构它**，于是一直挂着。

### 建议处置

拆成 3 条新 issue，然后关闭本条：

- **#19a（docs，极低成本）**：改 ROADMAP 里 2 处过时表述 —— 这是唯一「确定、便宜、有明确证据」的剩余项
- **#19b（infra）**：`test:all` 加 `--check` + CI Windows job 触发策略
- **#19c（test）**：`IpcChannel` 测试接缝 + 覆盖率

---

## §3 Issue #20 / #18-A：上游状态比 issue 正文乐观得多

issue #20 的正文是自动写的，只有两个标签：`upstream:broken`、`pr:OPEN`。
**它漏掉了最重要的进展。**

### 上游已有人分析并给出修复分支

`deepseek-ai/deepseek-harness` discussion #11893 与 #12532 有 **2 条评论都是实质内容**，
最新一条（2026-11-07 11:24，作者 `aturzone`）明确写道：

- 独立确认了根因：`spawn()` 构造的 `internals` 只传给了 `fallback` 分支，
  managed 分支的 `launchWindowsJob(spec, env)` / `launchLinuxScope(spec, env, argv)` 从未收到
- **给出了修复分支**：`fix/subprocess-managed-internals` @ commit `ab42e3b983`
  （<https://github.com/aturzone/deepseek-harness/tree/fix/subprocess-managed-internals>）
- 新增 `LocalSubprocessInternals` 类型 + `managedRunnerSeams()`，只透传存在的三个 seam
- 附了测试证据：把调用点还原成原样则该测试失败，恢复后通过
- 说明「仓库 PR 通道关闭，分支供 cherry-pick」

同时 #12532 的评论指出这是**同一类缺陷的第二处残留** —— 说明 upstream 里
「seam 只在单测可达」是个已知模式，不是孤例。

### 这对本项目的意义

| issue 原文的判断 | 实际情况 |
|---|---|
| 「0 条回复，未进入 upstream 视野」 | ❌ 已有维护者级别的分析与可 cherry-pick 的修复分支 |
| 结论 `upstream:broken` | ✅ 当前版本仍然 broken（未合并），但**结论不再是「没人管」** |
| 「最大保质期风险」 | 风险仍在，但从「无人理会」降为「修复在途」 |

### 另外：收录 PR #13369 被一个机械原因挡住

issue #20 只写 `pr:OPEN`，实际它 **`mergeable_state: unstable`，卡在一个检查上**：

```
Submission gate: failure

**https://github.com/boyingliu01/dsh-aot-runner**
- the entry points at the repository root, but the root `package.json` declares no
  `dsh.bundle` — `dsh plugin --profile web add github:...` would install nothing.
  The manifest is at `plugin/package.json`, so point the entry at that subpackage
  instead: url: .../tree/main/plugin   name: boyingliu01/dsh-aot-runner#plugin
  and rename the file to match.
```

核对属实：根 `package.json` 无 `dsh.bundle`，`dsh.bundle` 只在 `plugin/package.json`。
对方 contributing.md 第 54 行也写了 monorepo 子包的写法
（`url` 指向子目录、`name` 用 `owner/repo#subname`、文件名改为 `owner__repo--packages-...`）。

**这是一次改动即可解锁的收录**，比任何性能优化都更直接地增加曝光。

### 裁定

- #20 正文需要更新（补上游进展 + PR 被挡原因），**不宜作为「每周自动覆盖」的信息源**
- #18 的 A 项（升级为正式 issue）实际上**已被 upstream 自行发起分析完成了一半**，
  应当从「去开 issue」改为「跟进 ab42e3b983 是否被采纳」
- **收录 PR 的修复不在任何 issue 里** —— 应新建

---

## §4 Issue #12：数据积累卡在本机负载，验收标准定得太高

### 实测现状

`.aot-observation/history.jsonl` 共 6 条记录：

| 判定 | 条数 |
|---|---|
| `MEASURED` | **1** |
| `GAIN_CONSISTENT` | 2（收益 66.6% / 64.5%，跨度均 ≤4.4pp） |
| `UNRELIABLE` | 3 |

issue 的验收标准要求「≥5 条 `MEASURED`」，当前 1/5。

### 关键观察：`MEASURED` 这一档可能本来就不可达

`MEASURED` 要求**至少一轮单轮离散度 ≤10%**。但 issue 自己也写了：
本机常态负载 50~75%（火绒 + 常驻办公），单轮离散度基本压不到 10% 以下。

这正是当时加第二层判据 `GAIN_CONSISTENT` 的原因 —— **设计者已经知道第一档达不到**。
于是现在的状态是：验收标准要求一档已被证明在本机不可达的判据。

而且 `GAIN_CONSISTENT` 的两条记录（66.6% / 64.5%，跨度 1.4pp / 4.4pp）
其实**已经回答了 issue 的问题**：「收益比例中位数 60~70%」的结论是成立的。
卡住的是**记录形态**，不是**结论**。

### 裁定

这是验收标准与物理条件不匹配，**不是未完成的工作**。
继续死磕「≥5 条 MEASURED」的期望收益很低。

### 建议处置

把验收口径改为达成本意的判据：

- [ ] `MEASURED` **或** `GAIN_CONSISTENT` 累计 ≥5 条（当前 3）
- [ ] 收益比例中位数稳定在 60%~70%（当前 64.5% / 66.6%，**已满足**）
- [ ] 至少一次「node 漂移 / AOT 稳定」对照（已有 table，需固化进 docs）
- [ ] 结论写入 README/ROADMAP（需补）

---

## §5 Issue #15 / #16 / #17：真未做，按性价比排序

这三条是**确实没有开工**的，且范围清晰、可独立开工。

| # | 内容 | 工程量 | 依赖 | 建议 |
|---|---|---|---|---|
| 15 | 契约指纹 + 漂移检测 | 中（提取 + CI job + 补测 6 维度） | 无 | **优先**：上游漂移是本项目实际风险，且 #18-A 已证明 upstream 在动 |
| 16 | 隔离价值故障注入 | 中（4 个场景双实现对照） | 无 | **次之**：结论对 upstream 讨论有价值，但要严格遵守测量方法论 |
| 17 | 方法论独立长文 | 大（中英双语 + 推广） | **作者意愿/渠道** | 非代码工作，取决于是否愿意对外发布 |

---

## §6 本次盘点的额外发现（不在任何 issue 里）

### 6.1 插件 exe 与 dist 产物版本不一致

```
dist/dsh-aot-runner.exe              1397760 字节  2026-11-09 00:24
plugin/bin/dsh-aot-runner.exe        1388544 字节  2026-11-07 07:47   ← 旧 6 万字节
plugin/bin/dsh-aot-runner.exe.old    1388544 字节  2026-11-06 20:13
```

npm 包里带的是 `plugin/bin/` 的 exe，而它比 `dist/` 的最新产物旧。
`build.sh:344-368` 对此有防护（同步失败会 exit 3 并告警），
说明**最近一次构建时插件 exe 被占用没同步成功**。

发布前必须处理，否则 npm 包与源码不是一回事。**建议单独开一条 issue**。

### 6.2 已暂存的 `test/pre-commit-shortcircuit-verify.js` 会挂死，并破坏 git 索引

盘点时跑到这个已暂存的测试文件，**挂了 120 秒没退出**，被强杀后留下：

```
M  src/IpcChannel.cs          ← 文件里被追加了 "// shortcircuit probe" 探针，未清理
?? test/pre-commit-shortcircuit-verify.js   ← 原本是 A（已暂存），索引项丢了
.git/index.shortcircuit-test.bak            ← 测试的备份文件残留
```

（已在本次盘点中完整手工复原，工作区回到初始状态。）

根因在测试的 `runHookWithStaged()`：

- 它在**真实仓库的真实索引**上操作（备份 `.git/index` → `git reset` → 改文件 → `git add` → 跑 hook）
- 收尾靠 `finally` 恢复。**进程被强杀时 `finally` 不执行**，于是索引和探针都留在原地
- 而它调的 `.githooks/pre-commit` 第 2 段会 `exec` 全局 xp-gate 门禁 ——
  在当前 #21 未修的环境里，这一段本身就会长时间跑（全量测试套件）
- 于是 `node --test` 的默认超时先到，测试被 kill，`finally` 没机会跑

**这是一个真实的测试设计缺陷**，不是环境问题：

| 问题 | 后果 |
|---|---|
| 直接操作真实 `.git/index` | 进程中断即损坏开发者索引 |
| 无超时 | 一旦被调用的 hook 变慢/挂住，测试无限期挂住 |
| `finally` 是唯一的清理路径 | 被 kill 时清理失效 |

建议（属 #19c「测试接缝」同域）：

- 用 `GIT_INDEX_FILE` 指向临时索引，而不是备份/覆盖真实 `.git/index`
- 给 `spawnSync` 的 hook 调用加 `timeout`，超时即失败
- 探针写到临时工作副本，而不是真实 `src/` 文件

> 这条**不在任何现有 issue 里**，且比 #19 剩余项更急：
> 它已经暂存待提交，提交后每次 `npm run test:hook` 都可能破坏他人的工作区。

### 6.3 契约对齐门禁在本仓库是关闭状态

Gate 5c 输出：

```
⏭️  Gate 5c: spec/test alignment NOT CHECKED — .sprint-state/phase-outputs/req-ids.json missing
```

与 #15 的「契约漂移靠人工」是同一个问题域。若要做 #15，可顺带把 5c 打开。

---

## 建议的推进顺序

按「解除阻塞 → 拿低成本收益 → 真未做」排：

| 序 | 动作 | 类型 | 解锁什么 |
|---|---|---|---|
| 1 | 修 `pre-commit-shortcircuit-verify.js`（#24）—— **已暂存，最急** | 开发 | 避免提交后破坏他人索引 |
| 2 | xp-gate 侧提交 + 同步 + 安装 adapter 修复 | 落地 | **解除本项目提交阻塞**（#21） |
| 3 | 重放复现，确认 Gate 5 变 SKIP，关闭 #21 | 验证 | 恢复正常开发流 |
| 4 | 改收录 PR #13369（指向 `plugin/` + 改名，见 #22） | 外部 | **插件进市场，直接增曝光** |
| 5 | 更新 #20 正文（补上游进展 + PR 被挡） | 台账 | 不再误判「无人理会」 |
| 6 | 拆 #19 → 19a/19b/19c，关闭原 issue | 台账 | 让剩余项可被捡起 |
| 7 | #12 改验收口径 | 台账 | 把已达成的结论落成文档 |
| 8 | 处理 #23（plugin/bin 陈旧） | 发布 | 避免 npm 包带旧产物 |
| 9 | 开 #15（契约漂移）| 开发 | 兜住上游演进风险 |
| 10 | 开 #16（隔离价值）| 研究 | 给 upstream 提供设计依据 |

---

## 关于 sprint-flow

**本次不启动 sprint-flow**，理由：

1. 存量工作的大头是**台账整理**（改写/拆分/关闭 issue），不是功能开发 ——
   sprint-flow 的 6 阶段管道（PREP→DESIGN→BUILD→VERIFY→SHIP→CLOSE）对「改一个 checkbox」是纯开销
2. 唯一的真缺陷 #21 **代码已写好并验证过**，剩下的是提交与安装，不是设计工作
3. **前置条件不满足**：#21 未解除前，本仓库含 `.js` 的改动无法提交 ——
   而这恰好是 #15/#16/#18-B/#24 全部需要的改动类型。现在开 sprint，
   BUILD 阶段会卡在自己的门禁上
4. `ROADMAP.md` 已记录本项目**未走 sprint-flow**，且明确写了理由
   （单人维护、小规模迭代，引入 sprint 状态收益不抵成本）—— 本次没有推翻它的新证据

**建议的启动时机**：#21 关闭、提交流恢复正常后，
为 #15（契约漂移检测）单开一个 sprint。这是剩余未做项里唯一
「有明确验收标准 + 无外部依赖 + 直接兜住已知风险」的，
其余（#16/#17/#23）各自独立，不构成 sprint 的必要性。

---

## 盘点后的执行结果（2026-11-09 同日）

盘点结论被采纳后立即处理了三件事。**两件已完成并关闭，一件受外部约束无法在本会话修复。**

### ✅ #21 已关闭 —— 修复已落地并端到端验证

盘点发现修复代码早已写好但卡在「未提交 / 未同步 / 未安装」。逐项确认后：

| 闸门 | 结果 |
|---|---|
| 提交到 xp-gate 仓库 | ✅ `21c50968 fix(ts-adapter): 探测本地工具不再经过 npx` |
| 同步 npm 镜像 | ✅ 同提交内一并更新 |
| 装到本机 `~/.config/xp-gate/adapters/` | ✅ 三份 md5 一致 `894a3ea5…` |

另有一笔 `4864a1db fix(gate5): vitest 探测改用 --probe，未安装运行器时记为 SKIP` 补强 hook 侧。

**端到端复现验证**（暂存真实 `.js` 改动，跑真实 hook）：

```
修复前：❌ BLOCKED - Tests FAILED in full test suite
        MISSING DEPENDENCY Cannot find dependency '@vitest/coverage-v8'
修复后：⏭️ SKIP - No test runner installed locally
        Gate 5: Tests + Coverage    PASS (coverage: 97%)     EXIT=0
```

> 遗留：修复已进本机与源码仓库，但 npm 上的 `@boyingliu01/xp-gate@0.37.2`
> 尚未包含，其他使用者要等下次发布。

### ✅ #24 已关闭 —— 本会话内实际修复

这条是盘点时**跑测试才暴露的**，比预想的更严重：已经进 HEAD 的测试会破坏开发环境。

三处根因，三处修复：

| 根因 | 修复 |
|---|---|
| 直接操作真实 `.git/index` | `GIT_INDEX_FILE` 指向临时索引，真实索引全程只读 |
| 探针写进真实源码 | `hash-object` + `update-index --cacheinfo`，只写临时索引 |
| `spawnSync` 无 timeout | 120 s 上限，超时判失败并打印已捕获输出 |

修复后仍有 423 s —— 因为 hook 第 2 段（xp-gate 全局门禁）每次 25 s 起。
加了 `AOT_SKIP_GLOBAL_GATES=1` 只跳第 2 段：

- 默认关闭，实测未设开关时仍正常转交全局门禁
- 新增 **AC-716-7** 守住「默认关闭」与「跳过分支必须在第 2 段之后」两个不变量
  —— 放错位置会连被测的第 1 段一起跳过，测试就变成永远通过的空壳

最终：**423 s → 54 s，7 条断言全过，跑完后 `.git/index` 字节级不变**（commit `d20741b`）。

### ⛔ #23 无法在本会话修复 —— 结构性约束

`plugin/bin/dsh-aot-runner.exe` 被 **DSH 会话自己正在运行的 runner 进程占用**：

```
$ cp dist/dsh-aot-runner.exe plugin/bin/dsh-aot-runner.exe
cp: cannot create regular file '...': Device or resource busy

$ tasklist /FI "IMAGENAME eq dsh-aot-runner.exe"
"dsh-aot-runner.exe","16340",...          ← DSH 正通过它跑子进程
```

重试 3 次均失败，不是瞬时锁。`build.sh` 的防护没有失效，是被正确触发了 ——
**这条只能在没有 DSH 会话时重跑构建**，已把根因与长期修复方向（打包与构建解耦）写在 issue 里。

### 📌 状态更新

| Issue | 状态 |
|---|---|
| #21 | ✅ 已关闭（修复落地 + 端到端验证） |
| #24 | ✅ 已关闭（本会话修复，测试 423s→54s） |
| #23 | ⛔ 受 DSH 进程占用约束，已补证据，需在无 DSH 会话时处理 |

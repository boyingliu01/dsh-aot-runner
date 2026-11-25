# 设计：0.2.8 交付 + 契约覆盖率门禁（issue #35 阻塞B + §三C）

- **日期**: 2026-11-25
- **Sprint**: sprint-2026-11-25-01 / 分支 `sprint/2026-11-25-01`（base `1ce30a4`）
- **规模**: 标准
- **评审**: delphi-review 4 轮迭代（R1→R4），**最终 3/3 专家 APPROVED，100% 共识**

## 评审历程（三轮 REQUEST_CHANGES 修掉的 9 个实质缺陷）

| 轮 | 主要缺陷 | 修正 |
|---|---|---|
| R1 | ① 基线只记文件名，同名不同内容静默通过 ② 容差是魔法常量且只测单向 ③ `NPM_PUBLISH_EXPECTED` 是**新的**静默跳过源 ④ exit 2 混淆「未测得」与「基线过期」 ⑤ 单样本比基线，CI 会 flap | sha256 内容绑定；容差双向测试；删掉人工开关改为 tag 推导；拆 exit 3/4；重采中位数 |
| R2 | `ranges` 用**绝对计数**比固定基线，而分母本身在抖 → **漏报与误报同时存在** | 改**比率**判据 + 分母下限 |
| R3 | exit 3 永远 warning → 采集静默坏掉时「绿而盲」 | tag 构建上升级为阻塞 |
| R4 | —— | 3/3 APPROVED |

## VERIFY 阶段（Phase 4）的复审：R3 那条**在 BUILD 里漏掉了**

Phase 4 用实现后的真实代码再审一次，结果 **2/3 APPROVED（67%），未达 90% 门槛**。
专家 A 从第 1 轮起连续 5 轮 REQUEST_CHANGES，指出两件事，**两条都成立**：

| # | 缺陷 | 为什么严重 |
|---|---|---|
| 1 | `--check` 在 CI 上稳定返回 exit 3（CI 装的 `@latest` 是占位包，无 `runner-launch-*.js`），门禁**在最需要它的地方从不执行** | 把门禁从「警告」提升为「阻塞」却永不触发，**比原来的警告更糟** —— 它制造「已经检查过」的假象 |
| 2 | 基线绑定了契约内容（`contractSha256`），却没绑定**容差的推导依据** | 契约变了 → `--update` 重采数字 → 两个容差原封不动 → 它们描述的已是另一份契约的抖动特性，且没人会发现 |

第 1 条正是 R3 已经识别、并写明「tag 构建上升级为阻塞」的那条，
**BUILD 阶段实现了 ci.yml 的 4 态分支，却没在 release.yml 落地**。
设计文档里写了的约束，实现时漏了一半 —— 这是本次最值得记的教训：
**「设计里有」不等于「代码里有」，VERIFY 阶段必须对着实现复核设计承诺。**

### 修正

**第 1 条**：在 `release.yml` 新增「契约覆盖率棘轮」步骤，插在
「安装 DSH subprocess-local」**之后**、A/B 回归之前，exit 3/4/1 全部阻塞。

这里的关键（也是为什么两侧判据可以不同、却不是「一严一松」）：

| | ci.yml | release.yml |
|---|---|---|
| 装的包 | `@latest` = 占位版 0.0.x，**无** `runner-launch-*.js` | 钉死 `0.2.0-rc.2`，**有** |
| 「拿不到契约源」 | 稳定且已知的环境事实 → 判红等于 CI 永久红 | 真异常 → 必须拦 |
| 触发频次 | 每次 push | 只在发布时 |

所以 exit 3 在 ci.yml 是 warning、在 release.yml 是阻塞，依据是**环境不同**，
不是宽严不同。新增 2 个测试锁住这件事：release.yml 必须有该步骤、
且必须排在装包之后（排前面必然假拦截）。

**第 2 条**：`CALIBRATION` 常量记录实测依据（极差 129、余量 71、采样 5 次），
`calibrationProblems()` 校验「容差 = 极差 + 余量」且「余量 ≥ 极差的 50%」；
基线新增 `calibration` 段记录标定时的契约规模；`--update` 若发现契约规模变了，
**显式警告容差可能需要重新推导**（不拒绝 —— 那正是 `--update` 的正常场景，
但绝不允许悄悄沿用）。

> 为什么不自动重测容差：重测需要多次采样（每次 17 秒），把它放进门禁路径
> 会让每次 `--update` 变成几分钟。代价与收益不成比例。
> 选「不允许静默沿用」而不是「自动推导」，是这次能诚实做到的最强约束。

---

## 1. 需求

### REQ-1（阻塞 B）：0.2.8 真正交付
验收：`npm view @boyingliu01/dsh-aot-runner version` == `0.2.8` 且 GitHub Release 存在 `v0.2.8`。

issue 未记录的两个事实：

1. 远端 tag 止于 `v0.2.4`，而 CHANGELOG 已写到 `[0.2.8]` —— **0.2.5/6/7 从未发过 Release**。
   用户决策（DR-003）：只打 `v0.2.8`，把 0.2.5~0.2.7 合并成一份完整 Release Note。
2. `release.yml:336` 因 `permissions.id-token: write` 常开，`if ($env:ACTIONS_ID_TOKEN_REQUEST_URL)`
   **恒为真** → Trusted Publisher 未配时 `npm publish --provenance` 失败 → 仅打 `::warning::`（:340）
   → 落到 `NPM_TOKEN` 为空分支（:345）→ **`:350 exit 0`**。
   **结果：job 全绿、Release 成功、npm 无包、无任何失败信号。**

### REQ-2（§三C）：覆盖率从报告变门禁
三处与 issue 描述不符（已实测）：

1. `IpcChannel` 的可注入读源**已存在**（`src/IpcChannel.cs:44` 的 `IChannelIo` 接缝 +
   `IpcChannelIoSeamTests.cs` 18 用例），且该接缝写入时**抓到过真 bug**
   （`IsEndOfStream` 只判 `ERROR_NO_DATA(232)`，detach 实际返回 `ERROR_PIPE_NOT_CONNECTED(233)`）。→ 不重做。
2. 覆盖数字**抖动**：`ranges.covered` 42/43/44、`ranges.total` 156/159；
   而 `static.total`(293)、`functions.covered`(20)、`functions.total`(114) **完全稳定**。
   → issue 要求的「分支区间 ≥40%」现不可达（实测 26.9%），且「不得回退」做成精确比较会 flaky。
3. `collectOk === false`（采集驱动崩溃/超时）时脚本**退出码仍是 0**。

### 边界（明确不做）

| 不做 | 理由 |
|---|---|
| 阻塞 A（上游 discussion 推进） | 对外沟通，非代码；issue 自称「项目自己修不了」 |
| §四（重评估无补丁接缝、SECURITY.md、代码签名） | 探索性，与本 sprint 两块无依赖 |
| 补打 v0.2.5/6/7 | 会造出没有构建验证的空 Release，是噪声 |
| 一次做到「分支区间 ≥40%」 | issue 原文是「棘轮」= 逐步抬高；本次先建机制 |
| 重做 IpcChannel 接缝 | 已存在且抓过真 bug，无缺口 |

---

## 2. 方案对比

### 覆盖率门禁
- **A（选）** JSON 基线 + `--update`，复刻仓库已有唯一先例 `.contract-fingerprint.json`。
- **B（否）** 硬编码阈值：与 `build.sh:165-167`、`ci.yml:190-193` 成文拒绝理由正面冲突
  （"版本不同分支数就不同，设死阈值会在 DSH 升级时无端变红"）；`ranges.total` 抖动 → 天然 flaky；
  回退与未测得只能共用 exit 1。
- **C（否）** 本地 JSONL 历史：CI 无历史 → 永远"不可信" → 不能当门禁。
  `observe:check` 的 exit 1 是"CPU>40% 别测"，不是棘轮。

### 发布静默跳过
- **A（选）** 从 `github.ref` **自动推导**期望，fail-closed。
- **B（否）** 一律 exit 1：会把"二进制成功 + 蓄意不发"也算错；npm 一版只能发一次，误报代价高。
- **C（否）** 靠人工验证：issue 已证明"靠人记得"失败过一次。
- **D（否，R1 中被专家否决，已删除）** `NPM_PUBLISH_EXPECTED` 环境变量 —— 它就是新的静默跳过源。

---

## 3. 详细设计

### D-1 修 `IpcReaderTests.Start_返回后台线程`（前置阻塞项）

**现状**（`tests/DshAotRunner.Tests/IpcReaderTests.cs:49-60`）：

```csharp
var thread = IpcReader.Start(channel, inbox);
Assert.True(thread.IsBackground);      // ← 线程可能已死
Assert.Equal("ipc-reader", thread.Name);
thread.Join(TimeSpan.FromSeconds(5));
```

线程体喂 `ScriptedChannel("x", null)` 会立刻走完退出。.NET 8 对**已死线程**读 `IsBackground`
会启动 Thread 类的静态 GC 辅助线程并等其退出，抛 `ThreadStateException: Thread is dead`
—— 这是 CLR fail-fast `0x80131506` 的来源。

**实测**：单独跑 `IpcReaderTests` 6 次 **4 次失败**；全量 5 次 = 2 通过 / 2 单测失败 / 1 崩溃。
**这不是 2.7% 的机器抽风，是稳定缺陷被样本量放大后暴露。**

**修法**：改用「阻塞到测试主动放行」的通道，保证断言期间线程存活。断言保留五条：

1. `thread.IsBackground` == true
2. `thread.Name` == "ipc-reader"
3. **`Start()` 调用本身在 N ms 内返回**（证明不是串行化执行、没等读完成）
4. 主动放行后线程**最终结束**
5. **负向测试**：构造真会阻塞的通道，断言测试在超时后**失败**
   （证明"线程存活"不是靠无限等待换来的，也就不会掩盖真实并发缺陷）

不用 try/catch 吞掉 `ThreadStateException` —— 那会把「线程已死」这个真实信号掩盖掉。

### D-2 `--check` / `--update` 与四态退出码

**基线** `.contract-coverage.json`（仓库根，与 `.contract-fingerprint.json` 并列）：

```json
{
  "dshVersion": "0.2.0-rc.2",
  "contractFile": "runner-launch-B2zsQ1Dz.js",
  "contractSha256": "<契约文件内容 sha256>",
  "capturedAt": "2026-11-25T00:00:00Z",
  "static": 293,
  "functions": { "covered": 20, "total": 114 },
  "ranges": { "covered": 44, "total": 159, "ratioPp": 2767 },
  "uncoveredFunctions": ["..."]
}
```

`ratioPp` = `round(covered/total*10000)`，即**百分点 ×100 的整数**，
这样比较完全在整数域进行，`−2.0pp` 边界是确定性的（浮点比较会出现 `0.1+0.2 != 0.3` 类问题）。

**判定表**：

| 条件 | 判定 | 退出码 | PR/分支 | tag vX.Y.Z |
|---|---|---|---|---|
| 采不到契约源 / `collectOk!==true` / merged 空 | **未测得** | **3** | warning | **阻塞** |
| 基线文件缺失 | **缺基线** | **4** | 阻塞 | 阻塞 |
| `contractSha256` 不匹配 | **基线过期** | **4** | 阻塞 | 阻塞 |
| `dshVersion` 或 `contractFile` 不匹配 | **基线过期** | **4** | 阻塞 | 阻塞 |
| `static.total` < 基线 | **回退** | 1 | 阻塞 | 阻塞 |
| `functions.covered` < 基线 | **回退** | 1 | 阻塞 | 阻塞 |
| `ranges.total` < 基线 − 3（分母塌缩） | **回退** | 1 | 阻塞 | 阻塞 |
| `ranges.ratioPp` < 基线 `ratioPp` − 200（= −2.00pp） | **回退** | 1 | 阻塞 | 阻塞 |
| 否则 | 通过 | 0 | — | — |

**容差标定（为什么是 2.0pp / −3）**：
实测抖动 (42..44)/(156..159)，比率区间 26.92%~28.21%，极差 **1.29pp** → 取 2.0pp（极差+0.7 余量）；
`ranges.total` 极差 **3** → 分母下限取 −3。

> ⚠️ **这两个数字是标定值，不是真理**：契约面（DSH 版本）变化后必须重新标定。
> 基线里存了 `contractSha256`，一旦契约变就判「基线过期」并要求 `--update`，
> 这正是迫使重新标定的机制 —— 否则它就会退化成被否决方案 B 的那种"死数字"。

**为什么要分母下限**：比率判据单独用会漏掉「分母塌缩伪造比率」——
例如 30/110 ≈ 27.3% 会通过，但实际测试面缩水了。下限 −3 专门堵这个。

**重采与并列规则**：疑似回退时进程内重采 3 次取**中位数**。
2 低 1 高 → 中位数为低值 → **判回退**；并列取较小值。
**非对称是刻意的**：反向（2 高 1 低）同样取低值，所以**改进不会被虚报**。
残余风险：单次幸运高样本仍可能掩盖真回退，由标定容差兜底。

### D-3 接进执行路径

| 位置 | 改动 |
|---|---|
| `package.json` | 新增 `contract:coverage`（`--check`）、`contract:coverage:update`（`--update`），对齐既有 `contract` / `contract:update` |
| `package.json` 的 `test:all` | 加入 `npm run test:contract-coverage`（self-test）与 `npm run contract:coverage` |
| `ci.yml` | 按四态分支：0 通过 / 1 阻塞 / 3 warning（**tag 构建升级为阻塞**）/ 4 阻塞并提示 `--update` |
| `build.sh:162-171` | 同样按退出码分支；tag 构建时 3 也阻塞 |
| `build.sh:165-167`、`ci.yml:190-193` | **必须同步改写**"不作为门禁、不设阈值"的注释，否则下次审计会按注释认为它仍非阻塞 |
| `.archlint.yaml` | 新入口脚本补白名单（避免 Gate 6 Dead Code 误报复发，issue #32 原样重现过） |

### D-4 新 self-test，让失败分支**一定被执行**

现有 `test/contract-coverage-selftest.mjs` 两处结构缺陷必须避开：
① 把"跳过"当"通过"（113-117 行在能构造失败场景时打印"跳过"仍 `pass++`）；
② 不是 `node --test` 用例，自写 `check()` 累加、不接测试框架。

新 `test/contract-coverage-check-verify.js`：`node --test` + `mkdtemp` 临时仓库 +
`copyFileSync` 造假输入（照抄 `check-release-verify.js` / `check-version-verify.js` 的既有做法，
含 `git -c core.hooksPath=` 关 hook）。用例：

- 比率边界**双向**：刚好在 2.0pp 内 → exit 0；刚好超出 → exit 1
- **分母塌缩**（total 降超 3）→ exit 1
- `contractSha256` 不匹配 → exit 4
- 基线缺失 → exit 4
- 契约源不可得 → exit 3，且措辞明确是「未测得」不是「覆盖率低」
- `--update` 之后 `--check` → exit 0（闭环）
- tag 模式下 exit 3 **升级为阻塞**
- 采集驱动崩溃（`collectOk=false`）→ exit 3（**不再是 0**）

### D-5 堵掉 `release.yml` 静默跳过（fail-closed，零人工开关）

```
发布步骤：
  成功 → GITHUB_ENV 写 NPM_PUBLISHED=true
  失败 → GITHUB_ENV 写 NPM_PUBLISHED=false + 原因
新增最后一步「发布结果校验」：
  env: GITHUB_REF_VALUE: ${{ github.ref }}          # 经 step-level env 映射，不内联表达式
  $EXPECT = ($env:GITHUB_REF_VALUE -match '^refs/tags/v\d+\.\d+\.\d+$')
  if ($EXPECT -and $env:NPM_PUBLISHED -ne "true") { exit 1 }
  if (-not $EXPECT) { 输出「本次非 tag 发布，不要求发 npm」 }
```

三条约束（来自评审）：

1. **正则锚定** `^refs/tags/v\d+\.\d+\.\d+$`，避免 `vtest` 之类的误打 tag。
2. **发布步骤的触发条件必须与 `$EXPECT` 用同一个正则**，否则 `v0.2.8-rc.1` 类 tag
   会「真发到 npm 但最后一步说非 tag 发布」—— 又是一个新的静默跳过路径。
3. `github.ref` 必须通过 step-level `env:` 映射进脚本，不用内联表达式。

两种结果都打印**可 grep 的单独摘要行**，事后可审计。

### D-6 Release Note 合并 0.2.5~0.2.8
`release.yml` 的 `body` 手写四段，重点是「**0.2.4 有退出码符号位翻转 bug（`23d9939`），
会导致工具调用失败，请升级**」；保留 `generate_release_notes` 的 commit 列表作附录。

### D-7 发布前预检（防不可恢复失败）
打 tag 前跑 `npm view @boyingliu01/dsh-aot-runner versions`。
npm 禁止版本号重用：若 `0.2.8` 曾发布又 unpublish，**必须 bump 版本，不能硬打 tag**。
预检带**重试退避**（3 次，间隔 2/5/10s，**只对网络错误重试，不对 404 重试**）——
否则 registry 传播延迟会把"版本可用"误判成"版本已占用"或反之。

---

## 4. 成功标准

| ID | 验收标准 | 测法 |
|---|---|---|
| AC-1 | `IpcReaderTests` 连续 10 次 0 失败 0 崩溃 | 循环跑 |
| AC-2 | 全量 C# 测试连续 5 次 0 失败 0 崩溃 | 循环跑 |
| AC-3 | `--check` 基线一致时 exit 0 | 直接跑 |
| AC-4 | 篡改基线比率后 exit 1 且输出指明回退项 | 临时仓库测试 |
| AC-5 | 契约源不可得 → exit 3，措辞是「未测得」 | 临时仓库测试 |
| AC-6 | `--update` 后 `--check` exit 0（闭环） | 临时仓库测试 |
| AC-7 | `--check`/`--update` 已接入 `test:all` | 读 package.json + 断言脚本存在 |
| AC-8 | `contractSha256` 不匹配 → exit 4；基线缺失 → exit 4 | 临时仓库测试 |
| AC-9 | 比率**双向**边界 + **分母塌缩** → exit 1 | 临时仓库测试 |
| AC-13 | `npm view` == 0.2.8 | **发布后运维确认**，不在代码验收内 |
| AC-14 | `npm run test:all` 全绿 | 直接跑 |
| AC-15 | CHANGELOG / Release Note 覆盖 0.2.5~0.2.8 全部用户可感知变更 | 人工对照 |

---

## 5. 风险与缓解

| 风险 | 缓解 |
|---|---|
| CLR 崩溃是环境问题，改测试不解决 | 已单独复现 6 次得 4 次；修后连跑 10 次验证（AC-1/AC-2），且有负向测试防掩盖 |
| 容差 2.0pp / -3 是死数字 | 基线绑 `contractSha256`，契约变即判「基线过期」强制重标定；文档写明标定依据 |
| 单次幸运高样本掩盖真回退 | 重采中位数 + 标定容差兜底；残余风险已声明 |
| `--update` 被滥用刷基线 | 基线入库、Review 可见；self-test 断言闭环；提交信息须写明标定理由 |
| CI 拿不到契约源 | 沿用既有 `::warning::`（issue #15 已定取舍）；**tag 构建例外，升级为阻塞** |
| npm 版本号被占用 | D-7 预检（含退避重试），不可恢复前拦住 |
| 本机 SDK 10 vs CI 8 | 以 CI release.yml 结果为准，本机绿仅作快速反馈 |

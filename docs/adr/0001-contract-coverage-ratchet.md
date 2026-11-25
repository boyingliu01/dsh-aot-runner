# ADR-0001: 契约覆盖率棘轮采用「内容绑定基线 + 四态退出码」

- **状态**: 已接受
- **日期**: 2026-11-25
- **Sprint**: sprint-2026-11-25-01
- **相关**: issue #35 §三C、issue #15 B 项、`scripts/contract-branch-coverage.mjs`

## 背景

`scripts/contract-branch-coverage.mjs` 自 issue #15 B 项落地以来**只报告不进判据**。
`build.sh:165-167` 与 `ci.yml:190-193` 都写明了理由：

> 明确**不作为阻塞门禁**：覆盖率依赖本机能拿到哪个版本的 DSH 包，
> 版本不同分支数就不同，设死阈值会在 DSH 升级时无端变红。

这条理由本身是对的。issue #35 要求「把覆盖率变成门禁而非报告」，因此必须给出一个
**既不违背这条理由、又能真正拦住回退**的形态。

## 决策

采用 **JSON 基线 + `--update` 重建 + 四态退出码**：

1. 基线文件 `.contract-coverage.json` 入库，与 `.contract-fingerprint.json` 并列。
2. 基线记录 `dshVersion`、`contractFile`、**`contractSha256`**（契约文件内容哈希），
   以及 `static` / `functions` / `ranges` 三项计数与 `ratioPp`（整数百分点 ×100）。
3. 四级退出码：`0` 通过 / `1` 回退 / `3` 未测得 / **`4` 基线缺失或过期**。
4. 比率判据用整数（`ratioPp`），容差 2.0pp；`ranges.total` 另有 −3 的下限。
5. 判定回退前进程内重采 3 次取中位数。
6. **tag 构建时 `3`（未测得）升级为阻塞**，其余构建保持 warning。

## 被否决的备选方案

### 方案 B：硬编码阈值常量（复刻 `coverage-summary.py` 的 `THRESHOLDS`）

- **为什么诱人**：没有基线文件，阈值在代码里一眼可见，与 `coverage-summary.py` 的
  `THRESHOLDS = { "生产源码": 99.0 }` 同一个模式。
- **为什么否决**：
  1. 与上面引用的成文理由**正面冲突** —— 版本不同分支数就不同。
  2. 实测 `ranges.total` 在 156↔159 抖动，百分比阈值天然 flaky。
  3. 回退与未测得只能共用 exit 1，CI 无法区分「该补测试」与「该查环境」，
     而这两件事的补救方向相反。

### 方案 C：本地 JSONL 历史 + 中位数（复刻 `aot-observe`）

- **为什么诱人**：能看趋势，且 `.aot-observation/` 已有先例（不入库）。
- **为什么否决**：CI 上没有历史 → 永远「不可信」→ **不能当门禁**。
  另外必须澄清一个误读：`npm run observe:check` 的 exit 1 语义是「CPU > 40%，现在别测」，
  它压根不碰基线，不是棘轮先例，照抄会抄错对象。

### 方案 D：外部环境变量声明「本次应该发布/校验」

在设计评审 R1 中被提出又被否决。它会把「靠人记得」这个缺陷原样搬到新位置 ——
而「靠人记得」正是本 issue 诊断的失败模式（白名单漂移、`coverage-summary.json` 根本不存在）。

## 后果

**正面**

- DSH 升级换契约版本时**不会无端变红**：`contractSha256` 不匹配直接报「基线过期」（exit 4），
  语义是「请重采基线」，不是「你退步了」。
- 「没测成」与「测出来是 0」彻底分开（exit 3 vs exit 1）—— 与仓库既有的
  「宁可 null 不补 0」（`.aot-observation` / `bench-verdict`）同源。
- 只有 `ranges` 一个指标需要容差，因为它**唯一**有抖动；其余三项三次实测零抖动，
  精确比对，不给真实回退留后门。

**负面 / 代价**

- 多一个入库文件，`--update` 存在被滥用刷基线的可能。
  缓解：基线入库使 diff 在 Review 中可见；self-test 断言「update 后 check 必须过」的闭环。
- 容差 2.0pp / −3 是**当前契约面的标定值**，契约增长后必须重标定。
  缓解：`contractSha256` 强制在契约变化时重走一遍 `--update`，使重标定无法被跳过。
- 残余风险：单次幸运高样本仍可能掩盖一次真实回退，由标定容差兜底。
  这是可接受的，因为反向（幸运低样本误报）会被重采中位数吸收。

## 附：为什么 IpcChannel 的「可注入读源」不再需要做

issue #35 §三C 第三条要求「改为给 `IpcChannel.TryTakeFrame` 加可注入读源」。
实测该接缝**已存在**（`src/IpcChannel.cs:44` 的 `IChannelIo` + 18 个用例），
且它在写入时抓到了真缺陷：`IsEndOfStream` 只判 `ERROR_NO_DATA(232)`，
而 host detach 后管道实际返回 `ERROR_PIPE_NOT_CONNECTED(233)`。
那个常量在 `Native.cs` 里早就有，只是从没被这条判断用过 ——
**没有任何测试会发现「常量没用上」，这正是零覆盖的代价。**
本 sprint 不重做该项，只核实。

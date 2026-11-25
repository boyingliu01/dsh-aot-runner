# v0.2.8 发布说明

> 本文件是 `v0.2.8` 的 GitHub Release 正文来源（`release.yml` 的 `body`）。
> `generate_release_notes` 生成的 commit 列表只作为附录 —— 它表达不了
> 「你手上那个 0.2.4 有一个真 bug」这件最重要的事。

---

## 请升级：0.2.4 上有一个会导致工具调用失败的 bug

如果你在用 `0.2.4`，**建议直接升到 `0.2.8`**，不要逐版本升。

`0.2.4` 的退出码处理有一处符号位翻转：子进程正常退出时回报的退出码是错的，
表现为 DSH 认为工具调用失败。`0.2.5` 已修复。

## 版本跳了四个号，因为中间三个版本从未发布

远端 tag 此前停在 `v0.2.4`，而 CHANGELOG 已经写到 `0.2.8`。
也就是说 `0.2.5` / `0.2.6` / `0.2.7` **只存在于 git 历史里，从未发过 Release**。
本次一次性发布到 `0.2.8`，下面按版本列出这四个版本的全部用户可感知变更。

---

## 0.2.5 — 内部重构 + 修好全量自查入口

- **拆开 god-class `JobRunner`。** 1468 行 / 65 个方法，同时承担子进程启动、
  退出检测、环境块组装、可执行文件解析、行缓冲读取五件事。抽出
  `LineReader` / `EnvironmentBlock` / `ExecutableResolver`，退出检测改为
  `partial class`。逐行等价搬迁，五次搬迁做过脚本化比对。
- **修 `npm run lint` 在 0.2.4 上是红的**（issue #29）。两个 `.mjs` 自测文件
  不在任何 ESLint 配置块里，导致全量自查入口本身是坏的。
- **修一个更隐蔽的同类问题**：`bench/load-matrix.cjs` 落在通用配置块之外，
  仍然会被扫到所以不报错，看起来是绿的，实际一条正确性规则都没拿到。
- 新增 `test/eslint-config-coverage-selftest.mjs` 锁住上述失效模式。
  它的判据演进值得一提：最初只断言「文件有没有被某个带规则的块覆盖」，
  变异测试（删掉 ESM 块）显示**它依然全绿** —— 因为 `.mjs` 扩展名本身就让
  ESLint 按 module 解析，丢的是 `NODE_GLOBALS` 而不是解析模式。

## 0.2.6 — 技术债清零

- **继续拆 `JobRunner` 的启动职责**（46 → 21 个方法）：`ProcessLauncher`
  （CreateProcessW 原语，全是 static 纯函数，首次可单独测试）、`TargetSpawner`
  （启动编排，通过窄接口取依赖）、`RunnerErrors`。
- **进程句柄改为返回值。** 原先 `LaunchSuspended` 直接写 `_process`/`_thread`/`_targetPid`，
  中间状态可被观察到；现在一次性返回 `SpawnedProcess`，「启动成功」有了单一表达点。
- **`ResumeThread` 的判定统一到一处。** 此前 `JobRunner` 与 `TargetSpawner`
  各有一份实现，**只有一份被测试覆盖** —— 这是覆盖率骗局的经典来源。
- **`.archlint.yaml` 白名单补齐**（issue #32）：停在 3 条而实际入口脚本有 8 个，
  5 个文件被报成 Dead Code。archlint 8.5/10 → **10.0/10**。新增防漂移自检。
- **Gate 3 突破：所有函数 CCN ≤ 5。** 提交时被拦下 6 个高复杂度函数，逐个按职责拆分。
- **发布验证 85 项全过**，含 **A/B 53/53**（用例从 28 增到 53）。
  这一步的重要性：11-11 之后有 636 行从 `JobRunner.cs` 移出，但生产运行的 exe
  一直是 11-11 那份。A/B 53/53 证明重构后的二进制与 node runner **字节级等价**，
  闭环了「验证对象 ≠ 交付对象」这个盲区。

## 0.2.7 — god-class 告警清零

- `JobRunner` 21 → **15 个方法**，xp-gate principles 对 `src/` 的可修项全部消除。
- 抽出 5 个类，每个对应一条真实职责边界：`IpcReader`（并发边界）、
  `MessageType`、`StartRequestParser`、`ResourceReleaser`（§8/§9 释放顺序是协议契约）、
  `PollerLauncher`。
- **合并两份逐字相同的骨架**：`Finish` 与 `OnDisconnect` 只差一个 `ExitCode`，
  合并后「一次终态只清理一次」这个不变量从两条实现变成一条。
- 过程中自己引入又修掉两个问题：覆盖率从 100% 掉到 99.4%（补 4 个测试回到 878/878）；
  内联 `HandleEof` 让 CCN 从 5 升到 6 超阈值 —— 暴露了「方法数门禁与复杂度门禁
  会互相拉扯，只看其中一个会把另一个推红」。

## 0.2.8 — 修好版本号扇出 + 契约覆盖率变门禁

- **修好版本号扇出。** Gate 0 的报错文案无条件打印 `node scripts/sync-version.cjs`，
  而那个脚本当时并不存在；补上之后自动扇出又只暂存了仓库根 `package.json`，
  `plugin/package.json` 与 `package-lock.json` 改了却没进暂存区。
  现在 `--sync` 以 `VERSION` 为准写齐 4 处（含 lockfile 的**两个** version 字段），
  `--staged` 抓「已同步但没暂存」，两者都幂等且有失败分支测试。
- **契约分支覆盖率从「报告」升级为「门禁」**（issue #35 §三C）。
  此前它在 `build.sh` 与 CI 里都明确标注「不作为阻塞门禁」，理由是
  「版本不同分支数就不同，设死阈值会在 DSH 升级时无端变红」。
  那条理由成立，所以这次不是设固定阈值，而是与**内容绑定的基线**比：
  - 基线 `.contract-coverage.json` 记着契约文件的 `sha256`，契约一变就判「基线过期」，
    要求 `--update` 重新标定 —— DSH 升级不会误红，用例丢了则会被拦住。
  - **四态退出码**：`0` 未回退 / `1` 回退 / `3` 未测得 / `4` 基线缺失或过期。
    `3` 与 `4` 必须分开，因为补救方向相反：一个是换环境重跑，一个是重采基线。
  - 判据用**比率**而非绝对计数。实测同一契约连跑，区间覆盖数在 42/43/44、
    区间总数在 156/159 之间抖；只比绝对值会同时漏报与误报。另给分母设下限，
    挡住「区间总数塌缩把比率做高」这种伪造。
  - **修掉一个会静默放行的缺陷**：采集驱动崩溃时（`collectOk=false`）
    旧版退出码仍是 `0`，任何读 JSON 判成败的门禁都会把「没测成」当成「通过」。
- **修 `IpcReaderTests` 的 CLR fail-fast。** 测试在断言 `thread.IsBackground` 时
  线程可能已经结束；.NET 8 上读已死线程的该属性会启动 Thread 类的静态 GC 辅助线程
  并抛 `ThreadStateException`，严重时直接进程退出（`0x80131506`）。
  实测单独跑 6 次有 4 次失败、全量跑 5 次崩过一次 —— 它拦住 pre-commit，
  等于拦住每一次提交。改用「阻塞到测试主动放行」的通道，
  并新增负向用例证明线程确实被按住（不是靠无限等待换来的）。
- **发布链路不再静默跳过 npm。** `release.yml` 的 `permissions.id-token: write` 常开，
  于是 OIDC 判断恒为真；Trusted Publisher 没配时 `npm publish` 失败只打 warning，
  然后落到「没有 NPM_TOKEN」分支并 `exit 0` ——
  **job 全绿、GitHub Release 成功、npm 上什么都没有、零失败信号。**
  现在发布期望由 `github.ref` 自动推导（`refs/tags/vX.Y.Z` 就必须发 npm），
  末尾新增校验步骤，没发出去就失败。不引入任何人工开关 ——
  那只会把「靠人记得」这个缺陷搬个位置。
- **新增发布前预检**（`npm run release:precheck`）：npm 不允许版本号重用，
  一旦某版本发过（哪怕之后 unpublish）就永远不能再用。打 tag 前先查一句，
  换掉一次不可逆的失误。
- **修两处让 `test:all` 永远跑不起来的缺陷**：`test:all` 第一个命令是 `./build.sh`，
  在 Windows 上经 `npm run`（走 cmd.exe）无法执行；`archlint-whitelist-selftest.mjs`
  的候选集正则不匹配 `.cjs`，导致 `scripts/sync-version.cjs` 稳定误报成
  「白名单指向不存在的脚本」。

---

## 安装 / 升级

**方式 A：接入 DSH**（推荐）

```bash
npm install -g @boyingliu01/dsh-aot-runner@0.2.8
```

⚠️ 在 DSH `0.2.0-rc.2` 上还需一行上游补丁才能生效，见 README 顶部说明。

**方式 B：只要原生 exe**（不经插件）

下载 `dsh-aot-runner-v0.2.8-win-x64.zip`，解压即得 `dsh-aot-runner.exe`。
校验完整性：

```powershell
Get-FileHash dsh-aot-runner.exe -Algorithm SHA256   # 对照 SHA256SUMS
```

## 构建信息

- 目标：`win-x64`，NativeAOT 自包含
- 无 VC++ 运行时依赖、无 .NET 运行时依赖（已验证）
- 由 CI 从 tag 对应 commit 构建，可复现

## 验证

| 项 | 结果 |
|---|---|
| C# 单元测试 | **340 通过**（+1：新增负向并发用例） |
| 生产源码覆盖率 | **100%（878/878 行）** |
| 契约覆盖率门禁 | 基线 43/159 = 27.04%，未回退 |
| archlint | **10.0/10**，0 smells |
| NativeAOT 产物 | 1,403,392 字节，无 VC++ / .NET 运行时依赖 |

## 已知限制（未变）

- 仅支持 Windows x64。
- `archlint` 不覆盖 C#：10.0/10 只描述 JS/TS，`src/` 的 C# 文件从未被架构规则检查过。
- 契约覆盖率在 CI 上通常拿不到契约源（npm 上的 `@deepseek-ai/dsh-subprocess-local`
  是早期占位版，结构不同），此时如实报「未测得」而不是假成功。

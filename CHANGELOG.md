# CHANGELOG

本文件格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.2.3] - 2026-11-10

**修复发布：解决插件安装后 `plugin/bin/*.exe` 被占用导致替换失败，以及降级静默失效无感知。建议升级。**

### 新增

- **降级路径可观测**（#18 B）。runner 是纯性能增益：进程挂掉时功能一切正常，
  只是慢 2~3 倍——**不报错、不崩溃、没有任何用户可见症状**。此前这类失效
  只在 `verbose` 日志里，等于没人知道。现在降级会明确告知，并说明「已降级到内联模式」。

- **发布前置校验**（`npm run check:release`，已接进 `prepublishOnly`）：
  校验 `plugin/bin/*.exe` 与 `dist/*.exe` 逐字节一致，且 `plugin/bin/` 没有
  被 `files` 通配带进去的残留文件。此前这类不一致只在用户装完后才暴露。

- **上游契约漂移自动检测**（#15 A 项）。机械提取 DSH runner 的 4 类契约
  （start 请求字段集、Windows spawn 错误码表、可执行文件解析顺序、stdio fd 布局），
  生成 SHA256 指纹存入 `.contract-fingerprint.json`。DSH 升级改动契约时，
  pre-commit 会直接失败并指出哪一类变了，不再依赖人工核对备忘录。

- **`npm run lint`**：JS 语法检查 + ESLint，扫描口径收敛到
  `scripts/check-js-syntax.mjs` 一处定义，CI 与本机共用同一份。

- **`npm run isolation`**：故障注入量化「独立 runner 进程」的隔离价值（#16）。

### 修复

- **`plugin/bin/*.exe` 被占用导致替换失败**（#23）。插件从自身目录启动的短命
  `dsh-aot-runner.exe` 子进程会短暂持有 exe 句柄，直接覆盖会失败。
  改为**改名换位**：先 `mv` 旧文件让出句柄，再写入新文件。

- **`build.sh --check` 永远无法通过**。收敛 JS 扫描口径时删掉了
  `JS_SYNTAX_COUNT` 变量，但第 213 行仍在引用它——`set -u` 下直接
  `unbound variable` 退出。构建门禁因此在到达「全部通过」之前就中止。
  **这个 bug 让 `--check` 从一次重构起就是坏的，而没人发现，因为它总是「失败」，
  看起来像是代码有问题。** 现在删除该行，计数由脚本自己打印。

- **pre-commit 显式指定 `.sln`**（#6cb7753）。仓库同时存在 `.sln` 和 `.csproj` 时
  `dotnet format` 无法自行选择 workspace，会抛 `FileNotFoundException`
  直接崩掉——那道检查从「检查格式」变成了「一律失败」，与代码是否合规无关。

- **pre-commit 短路测试会破坏 git 索引**（`d20741b`）。测试在真实仓库里
  模拟提交，失败时会留下半提交状态并挂死。

- **覆盖率采集绕开 `KillTree` 崩溃路径**（#25 部分修复）。见「已知问题」。

- **CI 四处修复**：适配器下载改用相对路径、Windows job 补装 A/B 基线、
  `DSH_RUNNER` 指向基线并转成原生路径。此前 Windows CI 的红灯是环境问题，
  不是代码问题——**「测试环境未就绪」和「测试失败」在 CI 上长得一样**。

### 文档

- 新增 `docs/质量门禁现状审计-2026-11-10.md`：实测 pre-commit/pre-push 两个
  hook 的真实覆盖情况。结论是 **pre-push 在本仓库从未执行过**（`core.hooksPath`
  与 `xp-gate init` 安装位置冲突），而 pre-commit 的 Gate 1 对 C# 项目静默跳过
  （扩展名正则漏了 `.cs`，输出却是 `✅ PASSED`）。
- 补 `docs/测量方法论-当工具比被测对象更容易出错.md` 案例 10，
  以及 `ROADMAP.md` 的两条已知盲区。

### 已知问题（未在本版修复）

- **偶发 CLR 崩溃**（#25）。`dotnet test` 覆盖率那一遍偶尔会以
  `Fatal error. Internal CLR error. (0x80131506)` 中止，栈指向 xunit 的
  `TestInvoker<T>` 泛型实例化路径。发生概率约 1/10~1/300 次连续运行，
  **不是确定性缺陷**。目前靠 xp-gate 侧的「崩溃后单次重试」缓解：
  第一次崩、第二次过则放行；两次都崩则不放行（防止重试变成掩盖手段）。
  根因仍在追。

- **契约分支覆盖率与未覆盖维度补测**（#15 B/C 项）尚未完成。

## [0.2.2] - 2026-11-08

**这是一次修复发布：0.2.1 中的两个缺陷会让 runner 在特定条件下不可用。建议升级。**

### 修复（重要）

- **空环境变量导致所有 spawn 失败。**
  `BuildEnvironmentBlock` 在 env 为空时只产出 2 字节，而 `CreateProcessW` 对
  这块内存要求至少 4 字节（双 NUL 终止），实测返回 `ERROR_INVALID_PARAMETER(87)`。
  也就是说：**host 一旦传空 env，runner 完全无法启动 target**。

  更值得记下的是它为什么没被发现 —— 当时那条单测写的是「断言 2 字节」，
  而它的注释写着「2 字节会让 CreateProcessW 返回 87」。注释与断言互相矛盾，
  **测试反而把这个 bug 锁死了**。这是「测试通过 ≠ 行为正确」的典型样本。

- **IPC 通道关闭时误判为协议错误。**
  `IpcChannel.IsEndOfStream` 只认 `ERROR_BROKEN_PIPE(109)` 和 `ERROR_NO_DATA(232)`，
  漏掉了 `ERROR_PIPE_NOT_CONNECTED(233)`，同时还丢弃了 `ReadFile` 的 `ok` 标志。
  对端以 233 关闭通道时，runner 会抛 `IpcProtocolException` 而不是正常结束。

### 测试

- **生产源码覆盖率 89.2% → 100.0%**（1020/1020 行），单元测试 254 → 319。
- 新增 `FdLayoutHost`：在测试进程里**真实分配** fd 3/4/5/6/7，
  让 `JobRunner` 的编排代码可以被真正覆盖，而不是靠 mock 自证 ——
  mock 只能证明「mock 返回了我告诉它的值」。
- 难测的失败路径（Job 创建失败、spawn 异常、fd 缺失、轮询异常）统一走
  「**默认真实实现、测试可替换**」的注入接缝。接缝默认值必须指向真实实现，
  写成空操作会让生产路径静默失效。
- 修正 `TraceTests` 的集合名：`[Collection("TraceEnvironment")]` 从未定义
  （实际定义叫 `TraceEnv`），导致修改进程环境变量的测试**完全没有隔离**，
  是全量跑时的偶发失败源。
- `ProtocolJson` 的十六进制转义补上 `InvariantCulture`。

### 质量门禁

- **编译严格度收敛到单一来源。** 此前严格度被抄在两个 csproj、`build.sh`
  以及 CI/release 的 `dotnet` 命令里，靠「改了记得同步」的注释维系。
  现在只有 XP-Gate Gate 13 适配器中的 `gate13_csharp_flags()` 一处定义，
  构建脚本与 CI 都向它索取，找不到即报错退出（不退回默认值）。

- **修掉两个实际漏检：**
  - Gate 13 只构建第一个 `*.??proj`，**测试项目从未被严格检查过**。
    新增 `DshAotRunner.sln` 把两个项目都纳入后，浮出 508 个此前隐藏的分析器告警。
    测试代码的写法惯例（如 xUnit 方法名含下划线的 CA1707）已通过
    `tests/DshAotRunner.Tests/.editorconfig` 定点豁免，`src/` 严格度不受影响。
  - CI 的 `dotnet publish` 没有任何严格度参数，实测放入未使用字段时
    **只有 warning、发布照常成功** —— 等于 CI 不拦任何代码质量问题。

- 覆盖率门槛从 88% 提到 99%（实际已达 100%），`build.sh` 未达标即中断。

### 致谢

两个缺陷都是在为项目补建测试安全网的过程中暴露的，详见
`docs/测量方法论-当工具比被测对象更容易出错.md` 案例 9 与案例 10。

## [0.2.1] - 2026-11-06

**runner 行为无任何变化** —— 本次只动发布与门禁基建。二进制与 0.2.0 逐字节相同
（同一份源码、同一套工具链），升级不会改变运行时行为。

### 发布

- **npm 发布改用 OIDC Trusted Publishing**（优先），保留 granular token 回退。
  零密钥、无泄露风险、无需定期轮换。
  之所以要回退路径：npm 的硬限制是**全新包的首个版本无法用 OIDC 发布**，
  0.2.0 必须先走 token，OIDC 从本版开始才生效。

- 修掉 Release 工作流的一个真实风险（被 Gate 7 / checkov `CKV_GHA_7` 拦下）：
  原设计用 `workflow_dispatch` 的 `tag` 输入决定发布名，而这个自由填写的字符串
  会进入 zip 文件名、Release 标题和**版本一致性断言** —— 后者是唯一的版本闸门。
  等于说谁能手动触发 workflow，谁就能用自造的 tag 名绕过它。
  改为不接受任何输入，只认 `github.ref_name`，权限收敛到「只能重发已存在的 tag」。

- README 增加 npm / license / platform 徽章。

### 质量门禁

- **补上 `.archlint.yaml`，让 Gate 6（架构验证）真正生效。** 之前一直缺这份配置，
  Gate 6 每次 BLOCK。写配置前先跑了原始分析：53 个 smell、2.9/10，
  其中 47 个来自 `bench/node-tuning/`（一次性实验脚本，重复是刻意的）、
  3 个来自 `.git/`、3 个是入口脚本被误判为死代码，
  **`src/` 与 `plugin/` 是 0 个**。忽略项基于「这些代码本就不该用架构规则衡量」，
  不是为了让门禁变绿而放水。配置后 53 → 0，10.0/10。

  已知限制：archlint 0.16.0 不解析 C#，所以 `src/*.cs` 仍是盲区（非本次引入）。

- `.gitignore` 补 `*.exe.old`、`.xp-gate/reports/`、`.xp-gate/quality-status/`、
  `.quality-history.jsonl`。

### 其他

- `bench/node-tuning/` 的 5 个脚本不再硬编码作者本机路径，改为 `path.resolve(__dirname, ...)`。
- 清理 npm 包里混入的 `bin/dsh-aot-runner.exe.old` 残留（多 1.4MB 无意义体积）。

## [0.2.0] - 2026-11-06

本次为**公开发布版本**：在 0.1.0 基础上完成了大规模重构、建立了 C# 回归测试基线，
并修掉了一批由发布前评估发现的工程缺陷。

### 发布

- **新增 Release 工作流**（`.github/workflows/release.yml`）：打 `v*` tag 后自动构建、
  验证并发布 **GitHub Release（含编译好的二进制）** 与 npm 包。
  产出 `dsh-aot-runner-<tag>-win-x64.zip`、裸 `dsh-aot-runner.exe`、
  `SHA256SUMS` 与 `LICENSE`。

  为什么二进制必须进 Release 而不只是塞在 npm 包里：
  1. **从 git clone 的人拿不到 exe** —— 构建产物不入库，而自建需要约 8GB 的
     C++ 工具链（NativeAOT 强制要求 MSVC 链接器）。为了"用一个快 60% 的 runner"
     而装整套 Visual Studio 是不合理的门槛。
  2. **可校验** —— Release 资产有独立 SHA256，且由 CI 从 tag 对应 commit 构建，
     比本机产物更可审计、更可复现。
  3. **只想要二进制、不装插件的场景**（自定义部署、丢进 PATH）此前无处获取。

  发布前跑完整门禁（版本一致性 → C# 单测 → 构建 → 体积哨兵 → 依赖检查 → A/B + IPC），
  任一失败即中止 —— 宁可不发，不发错的。

- **README 新增「下载」章节**：说明三种获取方式（Release / npm / 源码构建）及适用场景。

- 修掉 npm 包里混入的 `bin/dsh-aot-runner.exe.old` 残留（多出 1.4MB 无意义体积）。

### 测试

- **C# 回归测试基线 0 → 139 用例**，配套可测的覆盖率收集。
  此前 `src/*.cs` 完全没有单测保护，重构只能靠 e2e 兜底。
- **修复零泄漏测试的环境依赖缺陷**，观测器补第二层判据（防"测试永远为真"）。
- **全部套件 216 项通过**（JS 77 + C# 139）。

### 重构

- 拆分 `IpcChannel` 帧解码与 `ArgParsing`，把"字节→消息"的判断从 I/O 里剥出来，
  使它能被穷举测试（`IpcFrameDecoder` 覆盖 95.8%）。
- 消除 xp-gate 报告的复杂度与重复代码违规（CCN > 5 → 0）。

### 新增

- **DSH 设置页状态卡片**（`plugin/client/`）：只读展示生效情况、exe 路径、熔断阈值。
- **长期观测器 `bench/aot-observe.js`**：多轮采样 + 可信度判定。
  README 的"收益比例才是稳定指标"这一结论就来自它。
- **`docs/测量方法论-当工具比被测对象更容易出错.md`**：复盘 5 次测量假象，6 条可复用规则。
- **GitHub Actions 工作流**（省额度设计）。
- **`docs/发布前评估报告-2026-11-06.md`**：公开发布前的完整评估记录。

### 修复（发布前评估，2026-11-06）

- **文档口径统一**：性能收益此前在 README（59%）、plugin README（65.0%）、
  实测（63.5%）三处互相矛盾，且 plugin README 内部同时出现两个比例。
  现统一为「**约 63~67%**」，并在两处都写明**绝对毫秒数随负载波动、比例才是稳定指标**。
  依据：独立测量 64.1%（5 轮可信观测）/ 66.6%（3 轮跨轮一致）/ 63.5%（单次 30 样本）。

- **License 自相矛盾**：README 末尾写「Private / internal use」，而 `LICENSE` 是 MIT。
  已改为 MIT，并补一句通俗的权利说明。公开仓库后这会立刻成为法律疑问。

- **`plugin/README.md` 缺失关键前提**：全篇未提「需要一行上游补丁」，
  而补丁是插件能否生效的**必要条件**。用户装完会看到「不生效」并误以为插件有 bug。
  已在顶部加入醒目警告，并把安装流程重写为三步（确认 exe → 打补丁 → 安装插件），
  同时新增「装上但没生效？」排查清单。

- **安装指引含作者本机路径**：`link:D:/projects/dsh-aot-runner/plugin` 对任何人都不适用。
  已改为占位路径 + npm 版本号两种写法。

- **`scripts/coverage-summary.py` 读错文件，覆盖率门禁形同虚设**（本次评估最实质的缺陷）：
  原实现 `collect(files[0])` 依赖 `glob` 的顺序，而 `TestResults/` 会累积历史报告
  （实测 14 份，其中 4 份是 `lines-valid="0"` 的空报告）。`files[0]` 恰好命中空报告，
  脚本恒输出 `0.0% (0/0 行)`，而真实生产覆盖率是 **41.3%**。
  现改为「先过滤空报告，再按 mtime 取最新」，并打印所用报告路径便于核对。

- **`scripts/check-deps.sh` 在无 VC++ 工具链时永远失败**：
  硬依赖 `dumpbin.exe`，找不到就 `exit 2`，导致 `build.sh` 中止。
  已增加 `llvm-readobj --coff-imports` 后备路径（实测可用），并打印当前使用的工具。

- **`build.sh --clean` 会毁掉唯一可用产物**：构建可能因缺链接器/网络失败而中止，
  但 `--clean` 已先把 `dist/*.exe` 删掉，而它不在版本库里（`*.exe` 被 `.gitignore` 排除）——
  「清理重建」直接把项目变成不可运行状态。现改为**构建前备份、失败则还原**。

- **`npm run test:all` 未覆盖全部门禁**：遗漏了 `lint` 与 `test:coverage`。
  已补上，使「一条命令跑完全部门禁」真的成立。

- **测试项数文档过时**：README 多处写「60 项」，实际是 **216 项**
  （JS 77 + C# 139，后者是重构期间新增的）。已按套件逐项列出。

- **`plugin/README.md` 文档错报默认值**：写 `enabled` 默认 `true`，
  而插件包自带 `cordis.patch.yml` 实际是 `false`。
  `false` 是有意的安全设计（装上不自动接管子进程），改文档而不是改代码。

- **DSH 状态卡片挂载点**：初版误用 `settings.plugin.item`，该 slot 在
  DSH 0.1.7-rc.2 之前已废弃、在 0.2.0-rc.2 里完全不存在，卡片不会显示。
  已改用 `plugins.row.config`（侧栏「插件」页里该行的详情区）。

### 说明

- 状态卡片**只读**而非可写是有意的：客户端跑在浏览器里，读不到服务端内存中的
  熔断状态，硬做一套 remote 通道来显示它，收益抵不上复杂度。运行时降级仍看日志。
  启用/停用仍走侧栏「插件」页面的官方开关，本卡片不重复做开关 —— 避免两个真相来源。

- 明确「两个开关」的区别：侧栏开关卸载 loader 行（代码不加载），
  `config.enabled` 只跳过注入。切换开关不会丢配置。

## [0.1.0] - 2026-11-02

首个公开发布。NativeAOT runner 可替代 DSH 的 Node.js runner，并通过插件接入。

> **重要前提**：在 DSH 0.2.0-rc.2 上必须配合一行上游补丁才能生效，
> 详见 [vendor/README.md](vendor/README.md) 与
> [上游 discussion #11893](https://github.com/deepseek-ai/deepseek-harness/discussions/11893)。
> 插件会自检并在这个前提不满足时告警、自动停用。

### 性能（生产路径实测，DSH 真实 launchWindowsJob）

| 指标 | node runner | AOT runner |
|---|---|---|
| p50 | 156~158ms | **63~64ms** |
| p99 | 249~279ms | **142~206ms** |
| 离散度 | 11.7%~20.5% | **1.9%~4.1%** |

- 每次净省 **92~94ms（约 59%）**，三轮收敛
- p99 长尾改善 73~124ms
- 300 次连续调用 0 失败，无内存累积增长

### 新增

- **插件接入**（`plugin/`）：配置开关、熔断降级（连续 3 次失败自动退回 node runner）、
  启动自检（检测 DSH 缺陷并主动停用，而不是假装工作）
- **`vendor/` 上游补丁留档**：原始文件 + 补丁工具，支持 status/apply/revert/verify
- **完整测试套件 60 项**：IPC 协议、真实 host 路径、插件单元、端到端、
  A/B 对比、泄漏、竞态
- **性能对比报告**（`docs/性能对比测试报告.md`）三层数据与完整方法论

### 修复

- **测试假阳性**：端到端与 host 路径测试原先只断言「注入字段被赋值」，
  而 node runner 同样能让调用成功 —— 于是插件完全失效时测试照样全绿。
  现改为观测实际启动的命令行，断言必须是 AOT exe。
- **测试依赖本机路径**：硬编码的家目录路径改为运行时多候选解析（DSH_HOME / USERPROFILE / 仓库 node_modules）

### 已知限制

- 仅 Windows（Job Object 进程树回收依赖 Win32 API）
- 依赖 DSH 的 `internals` 接缝，而 DSH 0.2.0-rc.2 的上游缺陷会切断该接缝
  —— 需要打补丁（`vendor/README.md`），插件已内置自检，检测到未打补丁会自动停用
  并明确告警，不会出现「看似启用实则无效」
- 无设置面板 UI（状态通过日志暴露；需要完整 UI 得写 React 客户端插件）
- **代码尚未达到项目自定的质量标准**：xp-gate 目前不支持 C#，
  主体代码（`src/*.cs`）的门禁检查是盲区。
  已在 xp-gate 提 issue（<https://github.com/boyingliu01/xp-gate/issues/717>），
  待其支持 C# 后另起任务重构。**在此之前仓库保持 private。**

## [Unreleased]

正式开发环境基建。不改变对外行为 —— 24 项 A/B 验证保持 24/24 通过，
产物体积从 1,212,928 降到 1,207,296 字节。

### 新增

- **本地质量门禁**（`./build.sh --check`）：C# 格式 + 0 警告静态检查 + JS 语法，
  三道检查任一失败即非零退出。已做正反例自校验（注入违规能拦下，恢复后通过）。
- **`.editorconfig` / `.csharp-formatting.json`**：C# 格式规则，`dotnet format` 可一键修复。
- **`scripts/check-integrity.sh`**：Low IL 目录自检，`build.sh` 在构建前自动调用，
  命中 Low Integrity 直接中止而不是产出一个跑不起来的 exe。
- **`src/Trace.cs`**：唯一的诊断日志写入口。此前 `Program.cs` 与 `JobRunner.cs`
  各有一套 `Dbg`，一处硬编码文件名且不认 `DSH_AOT_DEBUG_FILE`。
- **`docs/开发环境.md`**：工具链版本、验证步骤、runner 路径解析规则、故障排查表。

### 变更

- **产物目录** 从 `%TEMP%/dsh-aot-runner-dist` 改为仓库内 `dist/`，可追溯。
  新增 `./build.sh --out` 指定目录。
- **测试不再硬编码机器路径**：`test/runner-client.js` 与 `bench/d1-ab-bench.js`
  改为多级查找（`AOT_RUNNER` / `DSH_RUNNER` → 仓库 `node_modules` → `DSH_HOME` /
  `%USERPROFILE%/.workbuddy/...`），找不到时给出可操作报错。
- **静态检查升级为硬约束**：`TreatWarningsAsErrors=true`，`AnalysisLevel=latest-recommended`。
- `JobRunner` 实现 `IDisposable`，句柄清理挂到语言级释放约定上。

### 修复

引入严格 analyzer 后一次性暴露并修复的真实缺陷：

- **`ResumeThread` 返回值被忽略**（CA1806）：失败时线程永远挂起，target 静默不执行，
  而 runner 在等一个永远不会出现的退出码，外部表现为「调用卡住」。
- **`resolveAotRunner` 静默回退到过期产物**：当 `dist/` 未构建时，测试会拿
  `%TEMP%` 里的**旧二进制**做 A/B，结论全绿却毫无意义。
- **`EmitProtocolError` 输出 `"code":null`**：与 `ProtocolJson` 承诺的「null 字段不输出」
  不一致；host 侧 `isSerializedRunnerError` 会判定为非法并丢弃整条错误结果。
- **`DSH_AOT_NOJOB=1` 实验开关能让 Job 隔离失效**：实测 terminate 后 target 进程树泄漏
  （`PING.EXE` 残留）且不回报结果。已删除，`AssignProcessToJobObject` 改为无条件执行。
- **`SafeJobHandle` 私有构造函数**（CA1419）：SafeHandle 派生类型的无参构造函数
  必须与类型同可见，否则运行时无法通过反射创建实例。

### 移除

- 实验开关 `DSH_AOT_NOJOB`、`DSH_AOT_SUPPRESS` 及其残留分支。
- `Program.cs` 中重复的 `Dbg` 实现与死代码 `AppendJsonString`。

### 文档

- README / ROADMAP 与线上 Issue 对齐：修正 Issue 编号错位（熔断器是 #6 不是 #1）、
  待办按 P0/P1/P2 重排。
- 记录 **CI 决策**：暂不搭建 GitHub Actions，用本地质量门禁替代，
  该项从 v2.0.0 阻塞条件中划掉。
- 修正 **`resolveWindowsExecutable` 搜索根缺口的误判**：复核 DSH 源码
  （`runner-launch-*.js:1485`）确认其搜索根只有 cwd + PATH，AOT 实现本就一致；
  早先观察到的差异是探测脚本传了 glob 模式的 cwd 导致的测量伪迹。

### Issue #11 阶段 A：Node IPC 协议对齐（破坏性变更）

**这是项目迄今最重要的修复**：AOT runner 此前**从未能被真实 DSH host 调用**。

#### 问题

AOT 实现的是 NDJSON over stdin，而 DSH host 用 Node IPC（fd 3），
`stdio[0..2]` 全是 `'ignore'`。实测旧版在真实布局下会立刻因 stdin EOF 退出，
host 侧 `send()` 抛 `ERR_IPC_CHANNEL_CLOSED`。

过去 40 个用例全绿是**测试假象**：测试客户端自己为 AOT 和 node 实现了两套协议，
两边各跑各的，从未验证过「同一套 host 布局能否驱动 AOT」。

#### 新增

- **`src/IpcChannel.cs`**：fd 3 上的帧读写。
  - 帧格式 `[8B type][8B len][JSON]`；`type` 是类型不是序号（Windows 无 seq）
  - 内部缓冲 + 循环切帧：一次 `ReadFile` 可能返回多帧或半帧
  - EOF 判定含 `ERROR_BROKEN_PIPE(109)` / `ERROR_NO_DATA(232)`
  - `type != 1` 报 `EPROTOCOL`；单帧上限 8MB
- **`src/IMessageChannel.cs`**：消息通道抽象。
- **`src/NdjsonChannel.cs`**：`--ndjson` 调试模式（手工驱动用，非生产）。
- **`test/ipc-verify.js`**（6 条）：disconnect 退出、多帧、半帧、后续帧、
  3MiB env、stdio 映射。
- **`test/host-path-verify.js`**（1 条）：**真实 `LocalSubprocessRuntime` 路径** ——
  注入 `internals.runnerInvocation` 后确认 AOT 被选中、执行、结果回流。

#### 变更

- **主循环协议**：`LineReader`(stdin) → `IMessageChannel`(IPC)。
  保留 Issue #3 的「读线程 + 有界等待」结构，只换底层读取源，
  因此没有重新引入挂起风险。
- **`Program.cs` 去掉 stdout 依赖**：`Console.OpenStandardOutput()` → `IpcChannel`；
  `EmitProtocolError` 也改走 IPC（否则参数错误会静默消失）。
- **测试客户端统一协议**：`test/runner-client.js` 对 AOT 与 node 使用**相同的真实
  host 布局**，两侧都走 `c.send()` / `c.on('message')`。这是让 A/B 真正可比的前提。
- **`CrtDescriptorTable.Encode` 拒绝字符设备**：真实布局下 runner 自己的
  fd 0/1/2 是 `\\?\NUL`，把它填进 target 标准槽会让输出静默丢失。
  现在直接抛异常，让问题在启动期暴露。

#### 修复

- `test/race-verify.js` 加**文件级** timeout（900s）：五条用例串行累计 >120s，
  会被 `node:test` 的文件级默认超时误杀。单条 timeout 不解决这个问题
  （文件级超时先触发）。
- 测试客户端对已断开的 IPC 通道调用 `send()` 会抛**异步** error（
  `ERR_IPC_CHANNEL_CLOSED`），`try/catch` 抓不住、会带崩测试进程；
  改为先用 `c.connected` 判断。

#### 已知盲区（诚实记录）

「切帧后丢弃缓冲区剩余数据」这类缺陷，现有测试**抓不到**。
三种构造（小帧连发 / 大帧+小帧 / 256KB 噪声帧+terminate+start）都试过，
由于 Node 发送端的排队行为，多条帧很少落在同一次 `ReadFile` 里。
需要 runner 侧可注入「一次读返回多帧」的测试接缝，尚未实现。

#### 验证

| 套件 | 结果 |
|---|---|
| IPC 协议回归 | 6/6 |
| 真实 host 路径 | 1/1（`selectContainmentMode` = `windows-job`）|
| A/B 一致性 | 28/28（两侧现走同一协议）|
| 零泄漏 / 混沌 | 7/7 |
| terminate 竞态 | 5/5 |
| 质量门禁 | 全绿 |

### Issue #11 阶段 B：插件接入 + 熔断器

不修改 DSH 源码，通过 `LocalSubprocessRuntime.internals.runnerInvocation`
这个既有接缝把 runner 换成 AOT exe。

#### 新增 `plugin/`（`@boyingliu01/dsh-aot-runner@0.1.0`）

- **`lib/index.js`** — cordis 插件主体
  - `resolveRunnerPath()`：config → env → 包内 `bin/`。
    **显式配置不静默回退** —— 写了路径就是想用那个 exe，
    静默换成另一个会在排查时严重误导
  - `findRuntime()`：兼容 `ctx.subprocess` 与 `ctx.reflect.get('subprocess')`
  - 包装 `runtime.spawn`，把 `handle.done` 的 reject 接到熔断器
  - `ctx.effect` 注册卸载还原
- **`lib/circuit-breaker.js`** — 只数连续失败，成功一次即清零。
  刻意不做滑动窗口/半开计时：熔断逻辑本身出 bug 比没有熔断更危险。
  熔断后不自动恢复（若原因是 exe 被隔离，反复试探只会让每次调用慢一拍）
- **`cordis.patch.yml`** / `package.json` / `README.md`
- `build.sh` 构建后自动同步产物到 `plugin/bin/`（该目录被 `.gitignore` 排除）

#### 测试

- `plugin/test/index.test.js`（7 条）：注入 / 缺 exe 不动 runtime /
  `enabled=false` / 熔断降级 / target 非零退出不误判 / 卸载还原 /
  成功清零（偶发失败不累积）
- `test/e2e-plugin-verify.js`（2 条）：插件 + **真实 `LocalSubprocessRuntime`**
  跑通；runner 缺失时插件不生效且会话仍可用

#### 修复

`runtime.spawn` 还原时曾把 `bind` 后的函数赋回去，导致还原后
`runtime.spawn` 不再是原型方法（引用不等、多次 apply 会层层包装）。
改为分别保存原方法引用与绑定版本。

#### 自校验

- 注入「成功不清零」→ 新增的交替失败用例抓到 ✔
- 注入「永不熔断」→ 熔断用例抓到 ✔

#### 诚实记录的测试缺口

熔断的 **e2e** 验证被移除。用「存在但非 PE 的 exe」构造 runner 失败时，
`node x.cjs` 下 `handle.done` 正常 reject，`node --test` 下却 resolve 成
`{exitCode: 0}` —— 三条独立最小复现都指向 node:test 环境差异，原因未查明。
**测不出差异的测试比没有测试更糟**（假绿灯），因此熔断改在单元层用假
runtime 验证（结果确定），e2e 层只保留「降级后会话仍可用」。

#### 全套件结果

| 套件 | 结果 |
|---|---|
| IPC 协议回归 | 6/6 |
| 真实 host 路径 | 1/1 |
| 插件单元 | 7/7 |
| 插件端到端 | 2/2 |
| A/B 一致性 | 28/28 |
| 零泄漏 / 混沌 | 7/7 |
| terminate 竞态 | 5/5 |
| **合计** | **56/56** |

### 性能对比验证（第一层 + 第二层）

#### 改进基准本身

同一台机器连跑三次同一基准，收益比例得到 40.5% / 64.0% / 65.6%。
**单次测量完全不可信**，且原先没有判据说明哪一轮可不可信。

> 修正一处误判：起初怀疑「基准是先跑完 A 再跑 B，负载漂移污染结果」，
> 核对代码后发现**早就是交错采样**（每轮地板→node→AOT）。
> 真正原因是系统负载波动，不是设计缺陷。

改动：

- 每轮记录 CPU 负载与可用内存（取不到时显示 `n/a`，不编造 0）
- 输出增加 **p99 与 max** —— 卡顿感来自长尾，只看 p50 会漏掉
- 离散度用 **IQR / 中位数**，不用标准差：启动耗时有长尾，
  标准差会被几个异常样本拉爆，反而看不出主体数据稳不稳
- **自动可信度判定**：失败>0 或离散度>10% 判 `UNRELIABLE`，
  5~10% 判 `FAIR`，<5% 判 `GOOD`
- 输出 `SUMMARY` JSON 行，便于多轮汇总

> 加自动判定的理由：只给数字不给判据，读者（包括未来的自己）会下意识
> 挑一个好看的数字。把判据写死在代码里，事后就没法自我美化。

#### 第一层：隔离基准（5 轮 × 30 次）

| 轮次 | node p50 | AOT p50 | 收益 | 离散度 | 判定 |
|---|---|---|---|---|---|
| 1 | 250ms | 109ms | 64.8% | 6.4%/1.1% | FAIR |
| 2 | 279ms | 125ms | 63.4% | 16.4%/15.1% | UNRELIABLE |
| 3 | 260ms | 124ms | 60.0% | 9.8%/12.9% | UNRELIABLE |
| 4 | 238ms | 187ms | 24.8% | 3.3%/49.8% | UNRELIABLE |
| 5 | 238ms | 109ms | 65.0% | 2.9%/1.5% | GOOD |

**5 轮里 3 轮被判不可信** —— 判定机制立刻证明了价值。
**只报可信轮次：64.8% / 65.0%，runner 开销 217ms → 76ms，每次省 130~141ms。**

第 4 轮的 24.8% 是真实测到的：单独抓分布呈明显双峰（≈110ms / ≈190ms 两簇），
是外部干扰，无法从基准侧消除，只能靠记录 + 多轮取可信值处理。

#### 第二层：真实负载对照（3 轮 × 40 次）

| 轮次 | node p50 | AOT p50 | 收益 | node p99 | AOT p99 | p99 改善 | 失败 |
|---|---|---|---|---|---|---|---|
| 1 | 249ms | 109ms | 64.6% | 379ms | 173ms | 206ms | 0 |
| 2 | 253ms | 109ms | 66.0% | 393ms | 220ms | 173ms | 0 |
| 3 | 243ms | 109ms | 63.4% | 331ms | 200ms | 131ms | 0 |

**关键发现：p99 / max 全部改善，且幅度比 p50 更显著。**
交互式使用时，偶发一次 400ms 比平均快 130ms 更影响体感。

#### 稳定性

120 次连续调用：**0 失败**，RSS 52.6 → 54.7MB 无累积增长，
p50 109ms / p99 205ms / max 219ms。

#### 全程对现有 DSH 的影响

独立 node 进程跑基准，**未安装插件、未改动任何 profile、未重启 DSH**，
测试期间 web 会话全程正常运行。

完整数据见 [`docs/性能对比测试报告.md`](docs/性能对比测试报告.md)。

## [1.0.0] - 2026-10-31

首个可用版本。DSH 子进程 runner 的 NativeAOT 实现，S4 A/B 验证 24/24 通过。

### 新增

- **核心运行时**（`src/`）
  - `JobRunner.cs` — `CreateProcessW` + Job Object 启动/监控/终止 target；
    严格对齐 `@deepseek-ai/dsh-subprocess-local` 的调用契约
    （stdio fd 4/5/6 布局、`hasExactKeys` 严格字段校验、NDJSON 协议通道）
  - `JobHandle.cs` — Job Object 封装，`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`
    保证 runner 退出时整棵进程树回收
  - `Native.cs` — P/Invoke 声明（含 `_get_osfhandle` 取 CRT fd 句柄的正确方式）
  - `Protocol.cs` / `ProtocolJson.cs` — 协议 POCO 与零反射手写序列化

- **测试**（`test/`）
  - `runner-client.js` — 共享测试工具，封装真实 DSH 调用契约
  - `ab-verify.js` — 24 项字节级 A/B（stdout/stderr/exitCode/error 对象

- **基准**（`bench/`）
  - `d1-ab-bench.js` — 交错采样，避免系统负载漂移影响对比结论

- **构建**（`build.sh`）— 一键构建 / 测试 / 基准

- **文档**（`docs/`）
  - JSON 序列化选型调研与极致启动优化（含 12 用例迁移矩阵）
  - S2b 性能实测报告
  - S2 进展与阻塞记录

### 修复

- **bash/ls 崩溃**（`0xC0000022`）：根因是工作区目录被 DSH Windows 沙箱标记为
  `Mandatory Label\Low Mandatory Level`，从该目录启动的 exe 继承 Low IL 后无法创建
  `BaseNamedObjects` 对象。构建产物改落 `%TEMP%` 规避，并在 `DshAotRunner.csproj`
  与 README 中留存完整诊断路径。
- **`ResolveExecutable` 与 node 行为分歧**：逐项对齐 `resolveWindowsExecutable` —
  候选扩展名只有 `.com`/`.exe`（`.com` 优先），不含 `.bat`/`.cmd`；
  全部候选不存在时返回 ENOENT 而非把裸名交给 `CreateProcessW`。
  修正了「`npm` 在 node 下报 ENOENT、在 AOT 下却能跑」的分歧。
- **ENOENT 错误对象文本不一致**：逐项复制 `WINDOWS_SPAWN_ERROR_CODES` 映射表与
  `NODE_SPAWN_DETAIL_CODES` 规则，使错误对象与 node 完全一致。

### 性能

同一时间窗交错采样（n=30）：

| | min | p50 | p95 |
|---|---|---|---|
| 原生地板 `hostname.exe` | 36ms | 54ms | 189ms |
| node runner（改前） | 280ms | 413ms | 673ms |
| **AOT runner（改后）** | 138ms | **199ms** | 342ms |

每次调用净省 **214ms**，消除 **59.6%** 的 runner 固定开销。

### 已知限制

- `control pipe` 语义未实现（`Control` 字段已解析但未使用）
- S5 进程树泄漏/混沌测试未做
- `dumpbin /DEPENDENTS` 依赖检查未做
- 尚未接入 `ctx.subprocess`（S6）
- JSON 层仍在用 `JsonDocument`，`Utf8JsonReader` 迁移未完成
- 复用 DSH 内部契约，DSH 升级时需重新核对（`test/ab-verify.js` 是回归闸门）

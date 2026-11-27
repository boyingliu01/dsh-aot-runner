# 贡献指南

欢迎。这个项目是一个人下班后写的，所以下面这些规矩都围绕一件事：
**让「别人提的改动」和「我自己能验证的改动」尽可能快地重合。**

如果你只想用、不想改，直接看 [README](README.md) 就行，这里没有你需要的东西。

---

## 一、这个项目最需要什么样的帮助

按**当前最缺什么**排序，而不是按「什么最难」排：

| 优先级 | 需要什么 | 为什么是最需要的 | 需要什么能力 |
|---|---|---|---|
| 🥇 **最高** | **在其他机器 / DSH 版本上跑验证** | 项目所有性能数据都来自**一台机器**（见 README 的口径说明）。第二个人的数据比任何代码都值钱 | 会跑命令即可，不用懂 C# |
| 🥇 **最高** | **上游 DSH 的修复推进** | 上游缺陷 #11893 是本项目**唯一**的硬阻塞，详见 [vendor/README.md](vendor/README.md) | 会英文、能写清复现步骤 |
| 🥈 高 | **在 macOS / Linux 上做可行性测定** | 目前只有 Windows 实现。跨平台是**未验证假设**，不是「已知能做得更快」 | 愿意做实验，接受「结论可能是做不了」 |
| 🥈 高 | **测试用例** | 契约覆盖率的分母是上游契约的分支数，补用例是直接可测的贡献 | 会写 JS / C# 的基本测试 |
| 🥉 中 | 文档与翻译 | README 是中文的，英文读者进不来 | 双语能力 |
| 🥉 中 | 代码重构 / 性能优化 | 工程侧已相当饱和（内部质量门禁全绿），杠杆在别处 | 能读懂门禁规则 |

> **一句话**：本项目**不缺代码**，缺的是「第二个人的实测数据」和「上游的那个参数」。

### 最容易上手的贡献：帮我复现一次

不需要写一行代码。在**你的**机器上跑下面这条，然后开个 issue 贴结果：

```bash
git clone https://github.com/boyingliu01/dsh-aot-runner
cd dsh-aot-runner
npm run bench        # 需要先 ./build.sh 构建
```

请**连同负载一起报告**（这一点非常重要，理由见下方「测量纪律」）：

```powershell
# Windows：跑之前和之后各采一次
Get-CimInstance Win32_Processor | Select-Object -ExpandProperty LoadPercentage
```

---

## 二、开 issue 之前

1. **先搜一眼现有 issue** —— 特别是 [#35](https://github.com/boyingliu01/dsh-aot-runner/issues/35)
   与 [#34](https://github.com/boyingliu01/dsh-aot-runner/issues/34)，
   它们记录了当前已知的全部阻塞。
2. **如果是「插件装了不生效」** —— 先跑 `node vendor/patch-dsh.mjs status`，
   九成是这个原因，[vendor/README.md](vendor/README.md) 有一节专讲。
3. **如果是安全问题** —— **不要开公开 issue**，走 [SECURITY.md](SECURITY.md)。

### 请附上这些信息

不同的 bug 需要不同证据，但下面几项对**任何**问题都有用：

```bash
node --version              # 本项目 CI 用 Node 22；开发机常用更新的版本
dotnet --version            # 构建需要 .NET 8+
node vendor/patch-dsh.mjs status   # 补丁状态
./build.sh --check 2>&1 | tail -30 # 门禁结论（如果跑得动）
```

Windows 上再加一句：你的 DSH 版本（`dsh --version`）与是否受管（企业 EDR / AppLocker）。
**受管环境装不上是预期行为**，见 [SECURITY.md](SECURITY.md) §二。

---

## 三、提 PR 之前

### 3.1 必须能跑通这两条

```bash
npm run lint        # 语法 + ESLint + 4 个自测
./build.sh --check  # 8 项质量门禁
```

它们**不是形式要求**。这个仓库踩过太多次「门禁看起来绿了，其实什么都没测」，
所以门禁里有一批**变异自测**（故意改坏被测对象，确认门禁会红）。
你新增任何检查时，请沿用这个习惯 —— 见 `test/eslint-config-coverage-selftest.mjs` 的写法。

### 3.2 提交信息

用 [Conventional Commits](https://www.conventionalcommits.org/) 前缀，
**正文里写「为什么」而不是「改了什么」**（改了什么是 diff 已经说了的）。

```
fix(vendor): 补丁工具支持多代上游写法

上游从 0.2.2-rc.5 起把这行代码重写过，锚点匹配不上，
升级 DSH 后插件静默失效。改成形态表后每种已知写法都能识别。
```

好的提交信息在这个仓库里的标准是：**半年后你自己能靠它判断「当时为什么这么改」**。

### 3.3 代码风格

不靠主观约定，靠可执行的门禁。你**不需要读一份风格手册**，跑一遍就行：

| 关注点 | 判据 | 工具 |
|---|---|---|
| C# 格式 | `.editorconfig` + `dotnet format` | `./build.sh --check` |
| 复杂度 | 圈复杂度 ≤ 5 | xp-gate Gate 3 |
| 函数长度 | ≤ 50 行 | xp-gate Gate 4 |
| 类大小 / 方法数 | ≤ 1150 行 / ≤ 15 方法 | xp-gate Gate 4 |
| JS 风格 | `eslint.config.mjs`（含覆盖自测） | `npm run lint` |
| 架构 | `.archlint.yaml` | archlint |
| 覆盖率地板 | 生产源码 ≥ 99% | Gate 5 |

> ⚠️ **有一类告警不要去「修」**：xp-gate 的 C# 适配器有已知测量失步
> （报 373 行、实际 7 行这种），记录在 [`docs/TODO.md`](docs/TODO.md) 的 §2.1。
> 那些告警是上游缺陷的产物，改代码没用 —— 先去 `docs/TODO.md` 确认是不是已知项。

---

## 四、测量纪律（本项目最看重的一条）

如果 PR 里包含**任何性能数字**，请保证下面五条全部满足。
这不是洁癖 —— 这个项目的历史上，「测量方法错了」比「代码写错了」造成的返工多得多，
完整案例见 [`docs/测量方法论-当工具比被测对象更容易出错.md`](docs/测量方法论-当工具比被测对象更容易出错.md)。

1. **调用契约要对。** AOT runner 要求 `stdio[3]='ipc'` 的完整协议。
   用 `stdio: 'ignore'` 直调 argv 测出来的数字与真实性能无关
   （`bench/d1-ab-bench.js` 开头就写了这个警告）。
2. **用被测系统自带的基准工具**，不要自写简化基线 —— 会显著低估收益。
3. **交替采样（ABBA）**，不要单调 A→B→A。单调下降往往是时间趋势，不是处理效应。
4. **记录并报告负载**。负载差 > 5% 的两组对比**无效**，请直接说明「测不出来」。
5. **宁可说「测不出来」，不要给方向错误的确定结论。**
   错误结论比没有结论更糟 —— 它会让人基于错误前提做决策。

> 一个具体的例子：本项目曾三次测「AOT 在高负载下是否更稳」，结论方向翻转了一次。
> 最后的正确结论是「**离散度这个指标在高负载下的重复性不足以支撑任何一方的结论**」，
> 而不是挑一次对自己有利的数据报上去。见 [ROADMAP](ROADMAP.md) 的「已知短板」。

---

## 五、我不太会接受的 PR

提前说清楚，省得你白做：

| 类型 | 为什么 |
|---|---|
| **纯格式化 / 大范围重命名** | diff 噪音会淹没真正的改动，且会让 `git blame` 失效 |
| **降低门禁严格度** | 若某条门禁误报，正确做法是修判据或记录为已知上游缺陷，不是关掉它 |
| **为规避工具误报而扭曲代码** | 实测过：把对象抽成常量规避 xp-gate 误报，**误报会跟着走**。不为了哄工具改代码结构 |
| **引入运行时依赖** | 当前零运行时依赖是发布形态的前提，新增依赖需要非常强的理由 |
| **自动更新机制** | 它本身是更大的攻击面，本项目刻意不引入，见 [SECURITY.md](SECURITY.md) §五 |
| **无声的降级** | 任何「失败就悄悄退回 Node runner 且不留痕」的改动都不接受。熔断必须可观测 |

---

## 六、开发环境

完整的搭建步骤在 [`docs/开发环境.md`](docs/开发环境.md)，这里只列最常见的一个坑：

**NativeAOT 在 Windows 上强制要求 MSVC 链接器。** 只装 .NET SDK 会报
`error : Platform linker not found`。需要 Visual Studio Build Tools 的 C++ 工作负载（约 8GB）。

**不想装工具链？** 直接下 [Release](https://github.com/boyingliu01/dsh-aot-runner/releases/latest)
里的预编译 exe —— 但那样只能「用」，不能「改代码」。

> 本项目**不迁移到 WSL / Linux**。这是有意识的选择，不是偷懒：
> `CreateProcessW`、Job Object、CRT 描述符表注入全是 Win32 API，
> 搬到 Linux 不是「兼容性调整」而是**换一个项目**。理由记录在 `docs/TODO.md`。

---

## 七、许可

贡献即表示你同意以 [MIT](LICENSE) 许可发布你的贡献。

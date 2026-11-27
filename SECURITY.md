# 安全策略

本文件说明本项目的**威胁模型、已知风险、以及你如何独立核验**。
它不是一份「本项目很安全」的声明 —— 恰恰相反，本插件做了两件按常规标准**该被警惕**的事，
所以下面把这两件事的边界写清楚，由你来判断在你的环境里是否可接受。

- 项目主页：[boyingliu01/dsh-aot-runner](https://github.com/boyingliu01/dsh-aot-runner)
- 许可：[MIT](LICENSE)
- 上游依赖缺陷：[deepseek-ai/deepseek-harness#11893](https://github.com/deepseek-ai/deepseek-harness/discussions/11893)

---

## 一、报告漏洞

**请不要为安全漏洞开公开 issue。**

- 首选：GitHub 的 [Private vulnerability reporting](https://github.com/boyingliu01/dsh-aot-runner/security/advisories/new)
- 或：在仓库的 [Issues](https://github.com/boyingliu01/dsh-aot-runner/issues) 里**只**留下你的联系方式，
  说明「有安全问题，希望私下沟通」，不要在公开区写细节。

请包含：影响版本、复现步骤、影响范围（最好是「能读到什么 / 能执行什么」的判定），
以及你认为合理的修复方向。**如果暂时不确定算不算漏洞，也请先私下说** ——
宁可多一次误报，不要先公开。

响应预期：个人项目，尽力在 **7 天内**首次回复。这是承诺的下限，不是 SLA。

### 支持范围

只有**最近一个发布版本**接受安全修复。Windows x64 是本项目唯一支持的目标平台
（原因见 [`docs/TODO.md`](docs/TODO.md) 的「环境决策」一节：
`CreateProcessW`、Job Object、CRT 描述符表注入全部是 Win32 API，不是可移植代码）。

---

## 二、本项目的威胁模型（务必读）

本插件在**你自己的机器上、以你自己的权限**替换 DSH 的子进程启动器。它不联网、
不提权、不持久化。它带来的风险不是「它可能被远程攻击」，而是
「**你运行了一个别人编译的原生二进制，并且它改动了一个第三方文件**」。

因此真正的信任问题只有两个，逐个说明。

### 风险 1：原生二进制没有代码签名

`dsh-aot-runner.exe` **未做代码签名**（无证书，见
[issue #8](https://github.com/boyingliu01/dsh-aot-runner/issues/8)）。后果是现实且具体的：

| 场景 | 会发生什么 |
|---|---|
| 用户首次双击运行 | Windows SmartScreen 提示「未知发布者」 |
| 企业 EDR / AppLocker / WDAC | 可能**直接拦截**，且无法通过用户交互放行 |
| 部分杀毒软件 | 可能启发式上报（NativeAOT 产物对某些引擎属于少见形态） |

**这意味着：在受管企业环境里，本项目大概率装不上。** 这不是缺陷，是事实，
写在这里免得你花半天排查 EDR 规则。

在不受管制的开发机上，缓解手段是**核对校验和**——所有 Release 都带 `SHA256SUMS`：

```powershell
Get-FileHash dsh-aot-runner.exe -Algorithm SHA256   # 与你下载页面的 SHA256SUMS 对照
```

校验和能防「下载被篡改 / 传输出错」，**不能**证明「构建者没有恶意」。
要证明后者，唯一的办法是**自己从源码构建**（`./build.sh`），这也是本项目
为什么把构建脚本与 CI 全部公开的原因。

有关签名的实际取舍，见 [issue #8](https://github.com/boyingliu01/dsh-aot-runner/issues/8)：
当前结论是「个人项目、无证书、暂不签名」，**如果将来要正式分发，这一项必须重开**。

### 风险 2：安装过程需要改动 `node_modules` 里的一个第三方文件

这是本项目**唯一一处侵入式操作**，也是最该被质疑的地方。

**改什么**：`@deepseek-ai/dsh-subprocess-local/lib/index.js` 里的**一处实参插入**。

```diff
-  ... ? launchLinuxScope(spec, env) : launchWindowsJob(spec, env), binding);
+  ... ? launchLinuxScope(spec, env, internals) : launchWindowsJob(spec, env, internals), binding);
```

**为什么必须改**：上游 `LocalSubprocessRuntime.spawn()` 调用两个 `launch*` 函数时漏传了
`internals` 参数，导致所有基于 `internals` 的注入被静默忽略 —— 这是本插件无法生效的
**唯一**原因，详见 [`vendor/README.md`](vendor/README.md) 与上游讨论 #11893。

**为什么它是「最小可辨」的改动**：

| 性质 | 说明 |
|---|---|
| 文件数 | **1 个** `.js` 文件 |
| 行数变化 | **0**（只是在一行里插入实参） |
| 语义 | 把**已经存在于作用域里的局部变量** `internals` 往下传一层；不新增行为、不改控制流 |
| 取值 | 上游自己声明了 `internals = {}` 形参，自己写了 `const internals = {...}`，自己用了 `internals.runnerInvocation ?? spawnRunnerInvocation()` —— 只差传参 |
| 校验 | 补丁工具的锚点必须**恰好出现一次**，出现两次直接拒绝替换（不猜着全替换） |
| 可逆 | `node vendor/patch-dsh.mjs revert` 一键还原；`apply` 时会自动留时间戳备份 |
| 副作用 | 工具只读写那一个 `.js` 文件；不联网、不提权、不写注册表、不加计划任务 |

**你要承担的风险**是明确的：你信任这个仓库来生成并施加那处替换。
不想承担的话，有两条路：

1. **不用本插件** —— 完全合理，这也是它的默认状态（插件检测到注入未生效时会
   告警并停用自己，不会假装在工作）。
2. **自己核对改动面** —— 见下一节，无需信任本文档。

### 不在此威胁模型内的东西

为避免误解，明确列出本项目**不**解决的问题：

- **DSH 本身的权限模型**。插件只改变「子进程由哪个可执行文件启动」，
  不改变子进程能做什么。Job Object 进程隔离的语义保持不变（这是设计约束，
  `fallback` 分支被明确否决，因为它会丢隔离）。
- **被启动命令的安全性**。用户让 DSH 跑什么，它就照跑什么 —— 插件不介入。
- **供应链上游**。本插件依赖 DSH 的内部结构（`internals` 接缝），
  上游重构会让它失效。失效方式是**明确报错/停用**，不是静默降级到不安全状态。

---

## 三、自己核验（不需要信任本仓库）

以下命令全部只读本地文件，不联网。建议在**安装前**跑一遍，而不是装完再查。

### 3.1 核对二进制来自源码

```bash
# 用同一份源码自己构建，再与 Release 下载的 exe 比对
./build.sh
sha256sum dist/dsh-aot-runner.exe
# 与 Release 里的 SHA256SUMS 对照；或直接只用自己构建的那一份
```

CI 在 `windows-latest` 上从 tag 对应的 commit 构建并跑 A/B 验证
（见 [`.github/workflows/release.yml`](.github/workflows/release.yml)），
但 **CI 产物也不该被无条件信任** —— 自己构建是唯一不需要信任的路径。

### 3.2 核对补丁到底改了什么

```bash
node vendor/patch-dsh.mjs status    # 当前状态 + 目标文件绝对路径
node vendor/patch-dsh.mjs verify    # 留档原件 md5 未被篡改

# 拿留档原件与当前实际文件对比：预期只有那一行不同
diff "$(node -e 'console.log(require.resolve("@deepseek-ai/dsh-subprocess-local/package.json").replace(/package\.json$/,"lib/index.js"))')" \
     vendor/dsh-subprocess-local-0.2.0-rc.2/index.js.orig
```

若 diff 出现**除那一行之外**的任何改动，立即 `revert` 并当作安全事件处理。

### 3.3 核对「补丁真的只做那件事」

`test/vendor-seam-verify.js` 在临时目录里造两份副本（一份打补丁、一份不打），
跑同一个 host 场景，断言「直接子进程」从 `node.exe` 变成 `dsh-aot-runner.exe`。
它**不写真实的 `node_modules`**，只操作临时目录。

```bash
node --test test/vendor-seam-verify.js
```

### 3.4 核对构建产物的外部依赖

```powershell
# 应当没有 VC++ 运行时 / .NET 运行时的依赖（NativeAOT 静态链接）
dumpbin /DEPENDENTS dsh-aot-runner.exe
```

CI 中已验证产物**零外部运行时依赖**（这也是它能直接放进 npm 包的前提）。
完整输出留档见 [`docs/依赖清单.md`](docs/依赖清单.md)。

---

## 四、数据与隐私

- 插件**不收集遥测**，不上报任何使用数据，不包含任何网络请求代码。
- 插件不读你的凭据、环境变量内容以外的文件；`env` 只是**透传**给子进程
  （这是 runner 的职责），不做记录。
- 本地可能留下的痕迹：`vendor/patch-dsh.mjs apply` 会在目标文件旁留
  `index.js.bak-<时间戳>` 备份；构建产物在 `dist/` 与 `plugin/bin/`。
  这些都在你的机器上，不会被上传。
- 仓库里的 `.aot-observation/` 是本机的性能观测记录，已被 `.gitignore` 排除、
  且**不含**任何用户数据（只有延迟数字与负载读数）。

---

## 五、已知的安全相关取舍（明确记录）

| 取舍 | 现状 | 为什么不改 |
|---|---|---|
| 代码签名 | ❌ 无 | 无证书；个人项目。要正式分发必须重开 [issue #8](https://github.com/boyingliu01/dsh-aot-runner/issues/8) |
| 改 `node_modules` | ⚠️ 需要（1 文件） | 上游缺陷 #11893 未修；其他接缝都被实测否决，见 `vendor/README.md` 的「为什么不改 DSH 源码就做不了」 |
| 自动更新 | ❌ 无 | 自动更新本身是更大的攻击面（要信任更新通道），本项目选择不引入 |
| 校验和 | ✅ 有（`SHA256SUMS`） | 防传输篡改；不防恶意构建者 |
| 零外部运行时依赖 | ✅ 已验证（[`docs/依赖清单.md`](docs/依赖清单.md)） | 减少一个供应链面（没有 VC++ / .NET 运行时可被劫持） |
| 依赖面 | 极窄 | 无第三方 npm 运行时依赖；C# 侧仅 BCL |

---

## 六、如果你在做安全评估

以下结论可以直接引用，且都附了可复核的依据：

1. **补丁改动面 = 1 个文件里的一处实参插入，行数不变，可一键还原。**
   依据：`vendor/README.md`「改动面为什么天然很小」；核验命令见本文 §3.2。
2. **补丁的有效性在上游最新版 `0.2.3-alpha.2` 上实测确认。**
   依据：`test/vendor-seam-verify.js`（可复跑）+ `vendor/README.md` 的对照表。
3. **未签名的原生二进制在受管企业环境中大概率被拦截。** 依据：本文 §二·风险 1。
4. **本插件不改变进程隔离语义。** 依据：`docs/隔离价值量化-2026-11-10.md`，
   以及 `fallback` 分支被明确否决的记录（`vendor/README.md`）。
5. **无遥测、无网络请求。** 核验方式：全仓搜索无 HTTP 客户端调用；
   `package.json` 无运行时依赖。

# vendor/：DSH 上游补丁留档

这里存的是**对 `@deepseek-ai/dsh-subprocess-local` 的临时补丁**，不是本项目的代码。

> **先读这一节，再决定要不要装。** 装这个插件需要改动 `node_modules` 里的一个第三方文件。
> 这是本项目唯一一处「侵入式」操作，所以把**改什么、怎么验、怎么退**全部写在这里，
> 而不是只说一句「跑 apply」。安全论证见仓库根目录的 [`SECURITY.md`](../SECURITY.md)。

---

## TL;DR（30 秒版）

| 问题 | 答案 |
|---|---|
| 改了几个文件？ | **1 个**：`@deepseek-ai/dsh-subprocess-local/lib/index.js` |
| 改了几行？ | **2 处实参插入**（同一行内的两个调用各补一个 `internals`），不增删行 |
| 改动做了什么？ | 把已经存在于作用域里的局部变量 `internals` 作为第三个实参传下去 |
| 会不会动网络 / 提权 / 写注册表？ | 都不会。工具只读写那一个 `.js` 文件 |
| 能退回去吗？ | 能。`revert` 一键还原，`apply` 时还会自动留时间戳备份 |
| 怎么自己验证只有这些改动？ | 见 [§ 自己验证改动面](#自己验证改动面三步) |

---

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

上游讨论有两个（同一根因，**两个都还没修**）：

| | [#12532](https://github.com/deepseek-ai/deepseek-harness/discussions/12532) | [#11893](https://github.com/deepseek-ai/deepseek-harness/discussions/11893) |
|---|---|---|
| 创建时间 | 早 2 分钟 | 晚 2 分钟 |
| 第三方修复挂在哪 | ✅ **这里**（`aturzone`） | |
| 想帮上忙就去 | ✅ **这条** | |

> **如果你是从文章来的**：直接去 **#12532**。
> 它先创建，而且 `aturzone` 的修复分支（含回归测试）挂在那条下面 ——
> 维护者最可能看的是这一条。
>
> 现成 patch 已导出并实测可干净应用到 master：见
> [`upstream/aturzone-fix-d631ef32.patch`](upstream/aturzone-fix-d631ef32.patch)。

### 2026-11-26 补证：这是「测试没覆盖到」，不是「忘了加参数」

拿上游 `0.2.2-rc.5` / `0.2.3-alpha.1` / `0.2.3-alpha.2` 三个版本解包对比，
这一行**连行号都是 1574**，三个版本完全相同：

```js
handle = bindManagedProcess(spec, linuxScope === void 0
  ? launchWindowsJob(spec, env)
  : launchLinuxScope(spec, env, linuxScope.literalArgv), binding);
```

上游在重构时**保留了 `internals` 形参、也保留了 `const internals = {...}` 局部变量**
（`index.js:1566-1569`），却依然没把它传下去。也就是说：参数在手上，变量在作用域里，
就是没传 —— 这是那条代码路径没有测试覆盖时的典型残留，比「忘了加参数」更能说明
为什么它三个月没被发现。

---

## 补丁内容

**只有 1 行**，语义等价于上游修好后的样子。

0.2.0-rc.2 那一代：

```diff
-  ... ? launchLinuxScope(spec, env) : launchWindowsJob(spec, env), binding);
+  ... ? launchLinuxScope(spec, env, internals) : launchWindowsJob(spec, env, internals), binding);
```

0.2.2-rc.5 ~ 0.2.3-alpha.2 那一代：

```diff
-  ... ? launchWindowsJob(spec, env) : launchLinuxScope(spec, env, linuxScope.literalArgv), binding);
+  ... ? launchWindowsJob(spec, env, internals) : launchLinuxScope(spec, env, linuxScope.literalArgv, internals), binding);
```

两代都只是「在 `launch*` 的实参表末尾补上 `internals`」。完整 diff 见
[`patch.diff`](dsh-subprocess-local-0.2.0-rc.2/patch.diff)。

### 改动面为什么天然很小

补丁工具的判据是**「锚点必须恰好出现一次」**（`apply` 里会校验，
见 `patch-dsh.mjs` 的 `text.split(state.shape.before).length - 1 !== 1`）：

- 上游若有第二处同样的调用 → 直接报错拒绝替换，而不是猜着全替换
- `before` 是一整行**逐字**匹配（含空格），不是正则，不会误伤相似代码
- 替换后**行长只变长 42 字节左右**，行数不变

实测（2026-11-26，在本机 DSH 0.2.0-rc.2 上）：

```
$ diff <(sed 's/launchLinuxScope(spec, env)/launchLinuxScope(spec, env, internals)/; s/launchWindowsJob(spec, env)/launchWindowsJob(spec, env, internals)/' index.js.bak) index.js
（无输出 —— 即补丁的全部效果就是这两处实参插入）
```

`patch-dsh.mjs verify` 还会校验 vendor 里留档的 `index.js.orig` 的 md5
未被篡改，保证「对照基准」本身是可信的。

---

## 这个补丁真的能让插件生效吗（2026-11-26 实测）

**能，而且是在上游最新版 `0.2.3-alpha.2` 上实测的。** 这是本轮最重要的核实 ——
此前文档里「改 DSH 源码是唯一选择」这句话只被 `0.2.0-rc.2` 的经验支持，
`0.2.3-alpha.2` 换了写法，谁都没验过。

用同一份未打补丁的上游 `0.2.3-alpha.2`，只切换「那一行补丁打没打」，
观察 host 的**直接子进程**是什么：

| | host 的直接子进程 | 命令行 |
|---|---|---|
| **不打补丁** | `node.exe` | `node.exe …/lib/runner.js -- cmd.exe /c "ping -n 4 127.0.0.1"` |
| **打上补丁** | **`dsh-aot-runner.exe`** | `dsh-aot-runner.exe -- cmd.exe /c "ping -n 4 127.0.0.1"` |

两组的 `internals.runnerInvocation` 指向同一个 AOT exe，唯一变量就是那 2 处实参插入。
即：**`0.2.3-alpha.2` 上，打完这 1 行补丁后 `internals` 注入链路是通的**，
插件不需要额外的上游修改。

> **这条证据由 `test/vendor-seam-verify.js` 守着。** 它会在本机能解析到
> `@deepseek-ai/dsh-subprocess-local` 时复跑上面的对照；解析不到就明确 SKIP，
> 不会假装通过。这样下次上游再改写这行代码，测试会先红，而不是等到用户装不上才发现。

---

## 用法

```bash
node vendor/patch-dsh.mjs status   # 查看当前状态（默认）
node vendor/patch-dsh.mjs apply    # 打补丁
node vendor/patch-dsh.mjs revert   # 还原
node vendor/patch-dsh.mjs verify   # 校验留档文件未被篡改
```

`status` 会明确告诉你四件事之一：

| 输出 | 含义 | 该做什么 |
|---|---|---|
| **已打补丁** | 插件可以生效 | 无 |
| **原始版本** | 插件不会生效 | `apply` |
| **未识别的代码形状** | DSH 升级了，或上游换了写法 | **先别 apply**，看 [#11893](https://github.com/deepseek-ai/deepseek-harness/discussions/11893) 与 [§ 上游修复后怎么办](#上游修复后怎么办) |
| **找不到目标** | 当前目录解析不到 DSH 包 | 在装 DSH 的那个目录里跑，或按 `patch-dsh.mjs` 里的候选顺序排查 |

### 卸载（完整还原）

三步，缺一不可 —— 只删插件不还原补丁，DSH 会带着一个无人使用的改动继续跑：

```bash
node vendor/patch-dsh.mjs revert   # 1. 还原上游文件
dsh plugin remove @boyingliu01/dsh-aot-runner   # 2. 卸掉插件
rm -rf vendor/                     # 3. 删掉补丁留档（可选）
```

`revert` 是**幂等**的：已经是原始版本时再跑一次会输出「无需还原」并返回 0。

---

## 自己验证改动面（三步）

不想相信本文档的话，以下命令可以独立核实，全部只看本地文件、不联网：

```bash
# 1. 当前状态 + 目标文件路径
node vendor/patch-dsh.mjs status

# 2. 留档原件没被篡改（md5 与 0.2.0-rc.2 官方发布一致）
node vendor/patch-dsh.mjs verify

# 3. 拿留档原件与「当前实际文件」对比，看清楚到底改了什么
#    （apply 时会在目标文件旁留一个 index.js.bak-<时间戳>）
diff "$(node -e 'console.log(require.resolve("@deepseek-ai/dsh-subprocess-local/package.json").replace(/package\.json$/,"lib/index.js"))')" \
     vendor/dsh-subprocess-local-0.2.0-rc.2/index.js.orig
```

第 3 步的预期输出：**只有那一行不同**（`<` 是当前文件的未打补丁版本，
`>` 是留档原件 —— 方向取决于你当前是否已打补丁）。如果 diff 出现了别的改动，
那就不正常，应当 `revert` 后重新排查。

---

## ⚠️ 这个补丁会丢

DSH 升级、`pnpm install`、重装依赖 —— **任何重写 node_modules 的操作都会覆盖它**。

丢了怎么办：

1. 跑 `node vendor/patch-dsh.mjs status` 看状态
2. 如果是「原始版本」，跑 `apply` 重新打上
3. 如果是「未识别的代码形状」，**先别急着 apply** —— 去看上游 discussion 是否已修复
4. 插件自身也会兜底：检测到注入未生效时会**告警并停用自己**，不会假装在工作

## 上游修复的进展（2026-11-26 复核，重要）

**已经有第三方独立写了修复，但还没合入 master。**

| 事项 | 状态 |
|---|---|
| 上游 master 是否已修 | ❌ **仍未修**（直接读 `packages/subprocess/subprocess-local/src/index.ts`：第 215 行构造 `internals`，第 222/223 行两个 `launch*` 仍未传入） |
| 是否有人复现 | ✅ 第三方贡献者 `aturzone` 在 [#12532](https://github.com/deepseek-ai/deepseek-harness/discussions/12532) 独立确认同一根因 |
| 是否有人写修复 | ✅ 分支 `aturzone/deepseek-harness:fix/subprocess-managed-internals`，commit `ab42e3b983`，**含测试** |
| 为什么没合入 | 仓库 `has_issues=false`，**不接受 PR**；修复只能靠维护者手动 cherry-pick |

### 那个修复与本补丁的差别（读一遍，避免误解）

| | 本补丁 | 上游第三方修复 |
|---|---|---|
| 传什么 | 直接传整个 `internals` 对象 | 传一个 `seams` 子集（只含 `runnerInvocation` / `resolveRunnerInvocation` / `runnerAvailable`） |
| 影响的参数 | 比修复**多**（把 `internals` 里其余字段也一并暴露给 `launch*`） | 更窄，只暴露三个 runner seam |
| 对**本插件** | 够用（插件只用 `runnerInvocation`） | 同样够用 |

> **结论：对本插件的功能而言两者等价。**
> 上游修复更保守（只放行三个字段），如果你在意「最小暴露面」，
> 可以自己把补丁改成只传那三个字段 —— 但本插件的验证
> （[`test/vendor-seam-verify.js`](../test/vendor-seam-verify.js)）是针对当前写法做的。

### 想帮忙推进？

去 **[#12532](https://github.com/deepseek-ai/deepseek-harness/discussions/12532)** 留言
（它是先创建的、且有修复挂靠的那个议题）。**不需要重新论证** —— 指出
「修复分支存在但未合入」就够了。重复开新议题只会让信息更分散。

## 上游修复后怎么办

**直接删掉整个 `vendor/` 目录**，并把插件依赖改回不需要补丁的状态。

判断是否已修复：

1. 跑 `status` 显示「未识别的代码形状」或「已打补丁」但**你没打过**；
2. 去 `lib/index.js` 里搜 `launchWindowsJob(spec, env, internals)` —— 若上游已自带，就是修好了；
3. 在 [#11893](https://github.com/deepseek-ai/deepseek-harness/discussions/11893)
   或 [#12532](https://github.com/deepseek-ai/deepseek-harness/discussions/12532)
   里看到维护者确认合入。

修好之后 `apply` 会报「已经是打过补丁的状态」，此时应该删掉 `vendor/` 而不是继续用它。

## 为什么不改 DSH 源码就做不了

排查时试过所有其他接缝（2026-11-26 复核仍成立）：

| 方案 | 结果 |
|---|---|
| `internals.runnerInvocation` | ❌ 就是本文档说的缺陷 |
| `internals.spawn` | ❌ 同一处漏传，被调用 0 次 |
| `fallback` 分支 | ❌ 会丢 Job Object 进程隔离 |
| 复刻 `launchWindowsJob` | ❌ 依赖未导出的 `WindowsJobOwner` |
| 改 DSH 源码 | ❌ 升级即失效，且影响所有环境 |

> **2026-11-26 补一句精确的边界**：上表里的「改 DSH 源码」，指的是**改源码语义**。
> 本补丁不属于这一类 —— 它不新增行为，只是把**上游自己声明了、自己创建了、
> 却没往下传**的那个参数接上。所以它的失效方式是「上游一改写法就报 unknown-shape」，
> 而不是「悄悄改变 DSH 行为」。这是它相对其他侵入式方案的主要优势。

所以补丁是唯一不放弃正确性的选择。这也是为什么值得把它提给上游 ——
不然每个想做 runner 优化的人都得踩一遍。

## 目录内容

| 文件 | 说明 |
|---|---|
| `dsh-subprocess-local-0.2.0-rc.2/index.js.orig` | **原始文件留档**（md5 `0b4485aa…`），永不修改 |
| `dsh-subprocess-local-0.2.0-rc.2/index.js.patched` | 打过补丁的版本（md5 `66282a6b…`），供对照 |
| `dsh-subprocess-local-0.2.0-rc.2/patch.diff` | 两个版本的 unified diff |
| `patch-dsh.mjs` | 状态检查 / 打补丁 / 还原工具（含上游形态表） |
| `../test/patch-shapes-verify.js` | 形态表单测（新形态必须能匹配真实上游片段） |
| `../test/vendor-seam-verify.js` | 端到端接缝名测：补丁前后 host 子进程是不是 AOT exe |

#!/usr/bin/env bash
# 构建 AOT runner。
#
# 产物默认落在仓库内 dist/，构建前会做 Low Integrity 目录自检
# （原因见 DshAotRunner.csproj 的「产物目录」注释与 README「重要陷阱」章节）。
#
# 用法：
#   ./build.sh                    # 增量构建
#   ./build.sh --clean            # 清理后重建
#   ./build.sh --check            # 只跑质量门禁（格式 + 静态检查 + JS 语法），不构建
#   ./build.sh --test             # 构建后跑 A/B 验证
#   ./build.sh --bench            # 构建后跑性能基准
#   ./build.sh --all              # 质量门禁 + 清理重建 + 测试 + 基准
#   ./build.sh --out <目录>       # 指定产物目录（相对仓库或绝对路径）
#
# 环境变量：
#   RunnerOutDir  同 --out，优先级低于命令行参数
set -euo pipefail

cd "$(dirname "$0")"

# 向全局 XP-Gate 的 Gate 13 适配器索取 C# 编译严格度参数。
#
# 为什么不在这里写一份常量：那必然要配一句「Gate 13 改了记得同步」的注释，
# 而这种提醒既容易漏、也容易抄错，错了还没人发现。
# 现在严格度只有一处定义（门禁适配器），本地检查和提交门禁用的是同一组参数，
# 不可能出现「本地过了、提交被拦」或「本地比门禁宽松」的情况。
#
# 适配器路径依次取：$XP_GATE_ADAPTER > $XP_GATE_HOME/adapters > ~/.config/xp-gate/adapters
# 找不到就**直接失败**而不是退回一组默认值 —— 退回默认等于悄悄换了严格度标准，
# 那正是这里要避免的事。
gate13_csharp_flags_for_build() {
  local adapter=""
  local candidates=()

  if [ -n "${XP_GATE_ADAPTER:-}" ]; then
    candidates+=("$XP_GATE_ADAPTER")
  fi
  if [ -n "${XP_GATE_HOME:-}" ]; then
    candidates+=("$XP_GATE_HOME/adapters/gate-13-compiler-strictness.sh")
  fi
  candidates+=("$HOME/.config/xp-gate/adapters/gate-13-compiler-strictness.sh")

  local c
  for c in "${candidates[@]}"; do
    if [ -f "$c" ]; then adapter="$c"; break; fi
  done

  if [ -z "$adapter" ]; then
    echo "找不到 XP-Gate Gate 13 适配器（找过：${candidates[*]}）。" >&2
    echo "C# 编译严格度由它统一提供，缺失时无法判断该用多严的参数。" >&2
    echo "请先安装 xp-gate，或用 XP_GATE_ADAPTER 指定适配器路径。" >&2
    return 1
  fi

  # 只取函数定义，适配器被 source 时不会执行主流程（已验证无副作用）。
  # shellcheck disable=SC1090  # 路径是运行时解析的
  source "$adapter"

  if ! declare -F gate13_csharp_flags >/dev/null 2>&1; then
    echo "适配器 $adapter 里没有 gate13_csharp_flags()，版本可能过旧。" >&2
    echo "请升级 xp-gate 后重试。" >&2
    return 1
  fi

  # 与提交门禁取同一个 tier（默认 balanced，可用 XP_GATE_COMPILER_STRICTNESS 覆盖）。
  gate13_csharp_flags "$(gate13_resolve_tier)"
}


OUT="${RunnerOutDir:-$PWD/dist}"
CLEAN=0
TEST=0
BENCH=0
CHECK=0

while [ $# -gt 0 ]; do
  case "$1" in
    --clean) CLEAN=1 ;;
    --check) CHECK=1 ;;
    --test)  TEST=1 ;;
    --bench) BENCH=1 ;;
    --all)   CLEAN=1; CHECK=1; TEST=1; BENCH=1 ;;
    --out)
      shift
      [ $# -gt 0 ] || { echo "--out 需要一个目录参数" >&2; exit 2; }
      OUT="$1"
      ;;
    *) echo "未知参数: $1" >&2; exit 2 ;;
  esac
  shift
done

# ---- 质量门禁 ----
# 1. C# 格式：.editorconfig + .csharp-formatting.json 定义的规则
# 2. C# 静态检查：编译期 analyzer（严格度由全局 XP-Gate Gate 13 注入，csproj 不声明）
# 3. JS 语法：测试/基准脚本
if [ "$CHECK" = "1" ]; then
  echo "==> 质量门禁：C# 代码格式"
  # 必须显式指定 workspace：仓库根同时存在 DshAotRunner.sln 与 DshAotRunner.csproj 时，
  # `dotnet format` 无法自行二选一，直接抛 FileNotFoundException 退出。
  if ! dotnet format DshAotRunner.sln --verify-no-changes --verbosity quiet; then
    echo "格式不合规。用 'dotnet format DshAotRunner.sln' 自动修复后重试。" >&2
    exit 1
  fi

  echo "==> 质量门禁：C# 静态检查（0 警告）"
  # 注意：不能写成 `dotnet build | grep ... && exit` —— 管道的退出码是 grep 的，
  # 而 `set -e` 对 `cmd || true` 形式会吞掉真实失败，门禁就形同虚设。
  # 这里先落盘再判读 dotnet 自己的退出码。
  #
  # 严格度参数**不在这里定义**，而是直接向全局 XP-Gate Gate 13 适配器要。
  # 之前这里抄了一份常量，靠注释提醒「Gate 13 变了要同步改」—— 那种提醒迟早会漏，
  # 抄错一个字符也不会有人发现。现在只有一个定义处，改了适配器这里自动跟随。
  STRICT_FLAGS=$(gate13_csharp_flags_for_build) || exit 1

  BUILD_LOG=$(mktemp)
  # workspace 同样必须显式指定，否则 sln + csproj 并存会让 dotnet 报 MSB1011。
  #
  # 这里不能传 -r win-x64：NETSDK1134 明确禁止对解决方案指定 RuntimeIdentifier。
  # 两个项目各自在 csproj 里已经声明了 RuntimeIdentifier=win-x64，不需要重复传。
  # shellcheck disable=SC2086  # $STRICT_FLAGS 是有意的分词列表
  if ! dotnet build DshAotRunner.sln -c Release -v quiet $STRICT_FLAGS >"$BUILD_LOG" 2>&1; then
    grep -E "error|warning" "$BUILD_LOG" || tail -20 "$BUILD_LOG"
    rm -f "$BUILD_LOG"
    echo "静态检查未通过（构建失败）。" >&2
    exit 1
  fi
  if grep -qE "warning [A-Z]+[0-9]+" "$BUILD_LOG"; then
    grep -E "warning [A-Z]+[0-9]+" "$BUILD_LOG" | sort -u
    rm -f "$BUILD_LOG"
    echo "静态检查未通过（存在告警）。" >&2
    exit 1
  fi
  rm -f "$BUILD_LOG"

  echo "==> 质量门禁：版本一致性"
  node scripts/check-version.mjs

  echo "==> 质量门禁：C# 单元测试"
  # C# 侧此前完全没有单元测试，重构只能靠 e2e（30s+ 且失败点模糊）。
  # 这里把 dotnet test 纳入门禁：协议编解码、命令行 quoting、PATH 解析、
  # 环境块、按行切分等纯逻辑都有断言守着，重构才敢动。
  #
  # 顺带收集覆盖率（coverlet + runsettings），因为 xp-gate 的 Gate 5 会问
  # "覆盖率多少"，而这个数字必须是真量出来的，不能靠门禁闭嘴。
  if command -v dotnet >/dev/null 2>&1; then
    if ! dotnet test tests/DshAotRunner.Tests/DshAotRunner.Tests.csproj \
         --nologo --verbosity quiet \
         --collect:"XPlat Code Coverage" \
         --settings tests/DshAotRunner.Tests/coverage.runsettings \
         >/tmp/cs-test.log 2>&1; then
      tail -30 /tmp/cs-test.log >&2
      echo "C# 单元测试未通过。" >&2
      exit 1
    fi
    grep -E "已通过|Passed!" /tmp/cs-test.log | tail -2 || true
    # 覆盖率硬门槛：阈值定义在 scripts/coverage-summary.py 的 THRESHOLDS 里，
    # 未达标时脚本以非 0 退出，这里据此中断构建。
    #
    # 为什么现在是硬门槛：先前只报告不拦截，理由是「立刻卡一个数字会逼着人
    # 写凑数的测试」。现在各文件都已真正测到（生产源码 ~89%，JobRunner ~86%），
    # 风险反过来变成了「新代码悄悄拉低整体」。门槛取当前实测值向下取整，
    # 后续只升不降（ratchet）。
    if [ -f scripts/coverage-summary.py ]; then
      if ! python scripts/coverage-summary.py > /tmp/cs-cov.log 2>&1; then
        tail -25 /tmp/cs-cov.log >&2
        echo "覆盖率未达门槛（阈值见 scripts/coverage-summary.py 的 THRESHOLDS）" >&2
        exit 1
      fi
      head -6 /tmp/cs-cov.log
    fi
  else
    echo "跳过：未找到 dotnet"
  fi

  echo "==> 质量门禁：覆盖率门槛（对应 xp-gate Gate 5）"
  if command -v npx >/dev/null 2>&1; then
    npx --no-install c8 node --test plugin/test/index.test.js >/dev/null || {
      echo "覆盖率未达标（阈值见 .c8rc.json）" >&2
      npx --no-install c8 node --test plugin/test/index.test.js 2>&1 | tail -8 >&2
      exit 1
    }
  else
    echo "跳过：未找到 npx"
  fi

  echo "==> 质量门禁：ESLint（对应 xp-gate Gate 1）"
  if command -v npx >/dev/null 2>&1; then
    npx --no-install eslint . || {
      echo "ESLint 未通过。若提示找不到 eslint，请先 npm i -g eslint。" >&2
      exit 1
    }
  else
    echo "跳过：未找到 npx"
  fi

  echo "==> 质量门禁：JS 语法"
  # 用扫描而不是逐行列举：原来那份手写清单已经漏掉过文件
  # （test/test-utils.js），新加文件忘了登记就会静默跳过检查，
  # 而漏检是看不出来的。扫描口径与 npm 发布范围一致，
  # 因此 dist/obj/bin/node_modules 天然不在其中。
  JS_SYNTAX_FAIL=0
  JS_SYNTAX_COUNT=0
  while IFS= read -r jsfile; do
    jsfile="${jsfile#./}"
    case "$jsfile" in
      dist/*|dist-*/*|obj/*|bin/*|node_modules/*|vendor/dsh-subprocess-local-*/*) continue ;;
    esac
    JS_SYNTAX_COUNT=$((JS_SYNTAX_COUNT + 1))
    if ! node --check "$jsfile"; then
      echo "  语法错误: $jsfile" >&2
      JS_SYNTAX_FAIL=1
    fi
  done < <(find test bench plugin scripts vendor -name '*.js' -o -name '*.mjs' | sort)
  if [ "$JS_SYNTAX_FAIL" -ne 0 ]; then
    echo "JS 语法检查未通过。" >&2
    exit 1
  fi
  if [ "$JS_SYNTAX_COUNT" -eq 0 ]; then
    echo "没找到任何 JS 文件 —— 扫描路径可能不对。" >&2
    exit 1
  fi
  echo "  $JS_SYNTAX_COUNT 个文件通过"

  echo "==> 质量门禁：上游补丁留档"
  node vendor/patch-dsh.mjs verify

  echo "==> 质量门禁全部通过"
  [ "$CLEAN$TEST$BENCH" = "000" ] && exit 0
  echo
fi

mkdir -p "$OUT"
OUT_ABS=$(cd "$OUT" && pwd)
OUT_WIN=$(cygpath -w "$OUT_ABS" 2>/dev/null || echo "$OUT_ABS")

# ---- Low Integrity 自检：带 Low IL 标签的目录会让产物运行时崩溃 ----
if [ -x scripts/check-integrity.sh ]; then
  echo "==> Low Integrity 自检: $OUT_WIN"
  if ! scripts/check-integrity.sh "$OUT_ABS"; then
    echo
    echo "中止构建：产物目录带 Low Integrity 标签，产出的 exe 会继承 Low IL 并在运行时崩溃。" >&2
    echo "换一个 Medium IL 目录后重试，例如：" >&2
    echo "  ./build.sh --out \"\$TEMP/dsh-aot-runner-dist\"" >&2
    exit 1
  fi
  echo
fi

if [ "$CLEAN" = "1" ]; then
  echo "==> 清理 obj/ bin/ 与产物目录"
  # ${OUT_ABS:?} 是必须的：OUT_ABS 若为空（cd 失败或 --out 传了怪值），
  # 展开会变成 rm -rf /*，把根目录删掉。这里宁可报错中止。
  #
  # ⚠️ 但不能把现有 exe 一起删掉（2026-11-06 踩过）：
  #    构建可能因为缺链接器 / 缺依赖 / 网络失败而中止，此时唯一的可用产物
  #    已经被删了，而它通常**不在版本库里**（*.exe 被 .gitignore 排除），
  #    于是「清理重建」这一步直接把项目变成了不可运行状态。
  #    做法：先把 exe 挪到临时位置，构建成功后再丢弃；失败则还原。
  EXE_TMP="$OUT_ABS/dsh-aot-runner.exe"
  if [ -f "$EXE_TMP" ]; then
    EXE_BACKUP=$(mktemp -t aot-runner-backup.XXXXXX.exe)
    cp "$EXE_TMP" "$EXE_BACKUP"
    echo "    已备份现有产物 -> $EXE_BACKUP"
  fi
  rm -rf obj bin "${OUT_ABS:?}"/*

  # dotnet test 每跑一次就在 TestResults/ 下生成一个新的 GUID 目录，从不自清。
  # 实测累积了 66 个目录 / 35MB —— 而 coverage-summary.py 只读**最新一份非空报告**
  # （见 scripts/coverage-summary.py:pick_latest_report），历史那些是纯死重。
  # 这些目录被 .gitignore 排除，所以在 git status 里看不出来，只能靠 --clean 收。
  #
  # 用 find 而不是 `rm -rf tests/*/TestResults`：后者在 glob 不匹配时会因
  # `set -e` 之外的行为难以察觉地什么都不删，这里显式检查存在性。
  TEST_RESULTS_DIRS=$(find tests -type d -name TestResults 2>/dev/null || true)
  if [ -n "$TEST_RESULTS_DIRS" ]; then
    echo "    清理 dotnet test 历史产物 TestResults/"
    # shellcheck disable=SC2086
    rm -rf $TEST_RESULTS_DIRS
  fi
fi

echo "==> 构建 NativeAOT (输出: $OUT_WIN)"
dotnet publish -c Release -r win-x64 -o "$OUT_ABS" -p:RunnerOutDir="$OUT_WIN" 2>&1 \
  | grep -E "error|warning|已还原|->" || true

EXE="$OUT_ABS/dsh-aot-runner.exe"
if [ ! -f "$EXE" ]; then
  echo "构建失败：找不到 $EXE" >&2
  # 把备份还原回去，让项目保持可运行 —— 「清理重建失败」不该顺带毁掉旧产物。
  if [ -n "${EXE_BACKUP:-}" ] && [ -f "$EXE_BACKUP" ]; then
    cp "$EXE_BACKUP" "$EXE"
    echo "已还原上次构建的产物: $EXE" >&2
    echo "（本次构建未产生新 exe，旧产物仍可继续使用）" >&2
  fi
  exit 1
fi

SIZE=$(stat -c %s "$EXE" 2>/dev/null || stat -f %z "$EXE")
echo "==> 构建成功: $(basename "$EXE") 体积 $SIZE 字节"

# 依赖检查：确认没有 VC++ / .NET 运行时依赖（Issue #5）。
# 放在构建后立即执行 —— 这决定了产物能不能直接分发给别人，
# 一旦回归应当立刻暴露，而不是等到发布时才发现。
echo
./scripts/check-deps.sh "$EXE" || {
  echo "依赖检查未通过，产物不可分发。" >&2
  exit 1
}

export AOT_RUNNER="$EXE"

if [ "$TEST" = "1" ]; then
  echo
  echo "==> C# 单元测试（协议/quoting/PATH/环境块/按行切分）"
  dotnet test tests/DshAotRunner.Tests/DshAotRunner.Tests.csproj --nologo --verbosity quiet

  echo
  echo "==> S0 Node IPC 协议回归（Issue #11）"
  node --test test/ipc-verify.js

  echo
  echo "==> S0 真实 host 路径验证（Issue #11 关键检查点）"
  node --test test/host-path-verify.js

  echo
  echo "==> 插件单元测试（Issue #11 阶段 B）"
  node --test plugin/test/index.test.js

  echo
  echo "==> 插件端到端验证（插件 + 真实 runtime）"
  node --test test/e2e-plugin-verify.js

  echo
  echo "==> S4 A/B 验证（node runner vs AOT runner）"
  node --test test/ab-verify.js

  echo
  echo "==> S5 零泄漏 / 混沌回归（约 90s）"
  node --test test/leak-verify.js

  echo
  echo "==> S3 terminate 竞态回归（约 100s）"
  node --test test/race-verify.js
fi

if [ "$BENCH" = "1" ]; then
  echo
  echo "==> D1 性能基准"
  node bench/d1-ab-bench.js
fi

echo
echo "完成。runner 路径: $EXE"

# 把产物同步到插件包内，让 @boyingliu01/dsh-aot-runner 开箱即用。
# plugin/bin/ 被 .gitignore 排除（构建产物不入库），所以每次构建都要重放。
#
# ⚠️ 这一段必须能失败时报错（2026-11-06 修复）：
#    DSH 会话本身就在通过 AOT runner 跑子进程，于是 plugin/bin/*.exe 正被占用，
#    `cp` 报 "Device or resource busy" —— 但脚本此前仍然打印「完成」并以 0 退出，
#    结果是**插件包里躺着上一版 exe**，而构建日志看起来一切正常。
#    这类「静默不同步」最危险：发布出去的包和刚构建的源码不是一回事。
mkdir -p plugin/bin
PLUGIN_EXE="plugin/bin/$(basename "$EXE")"
if cp "$EXE" "$PLUGIN_EXE" 2>/dev/null && cmp -s "$EXE" "$PLUGIN_EXE"; then
  echo "已同步到插件包: $PLUGIN_EXE"
else
  echo
  echo "⚠️  无法同步到插件包: $PLUGIN_EXE（文件被占用或复制失败）" >&2
  echo "    原因通常是 DSH 正在通过该 exe 跑子进程。" >&2
  echo "    这不影响 dist/ 下的新产物，但 plugin/bin/ 里仍是旧版本 ——" >&2
  echo "    **打包发布前必须解决**，否则 npm 包会带上旧 exe。" >&2
  echo "    处理办法：关掉 DSH 会话后重跑构建，或手动 cp 覆盖。" >&2
  exit 3
fi

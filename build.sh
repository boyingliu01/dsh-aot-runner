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
# 2. C# 静态检查：编译期 analyzer（csproj 里 TreatWarningsAsErrors=true）
# 3. JS 语法：测试/基准脚本
if [ "$CHECK" = "1" ]; then
  echo "==> 质量门禁：C# 代码格式"
  if ! dotnet format --verify-no-changes --verbosity quiet; then
    echo "格式不合规。用 'dotnet format' 自动修复后重试。" >&2
    exit 1
  fi

  echo "==> 质量门禁：C# 静态检查（0 警告）"
  # 注意：不能写成 `dotnet build | grep ... && exit` —— 管道的退出码是 grep 的，
  # 而 `set -e` 对 `cmd || true` 形式会吞掉真实失败，门禁就形同虚设。
  # 这里先落盘再判读 dotnet 自己的退出码。
  BUILD_LOG=$(mktemp)
  if ! dotnet build -c Release -r win-x64 -v quiet >"$BUILD_LOG" 2>&1; then
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
    # 覆盖率只报告、不设硬门槛：当前生产源码覆盖率是基线，
    # 立刻卡一个数字会逼着人写凑数的测试。先让它可见，再逐步抬高。
    if [ -f scripts/coverage-summary.py ]; then
      python scripts/coverage-summary.py 2>/dev/null | head -6 || true
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
  rm -rf obj bin "${OUT_ABS:?}"/*
fi

echo "==> 构建 NativeAOT (输出: $OUT_WIN)"
dotnet publish -c Release -r win-x64 -o "$OUT_ABS" -p:RunnerOutDir="$OUT_WIN" 2>&1 \
  | grep -E "error|warning|已还原|->" || true

EXE="$OUT_ABS/dsh-aot-runner.exe"
if [ ! -f "$EXE" ]; then
  echo "构建失败：找不到 $EXE" >&2
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
mkdir -p plugin/bin
cp "$EXE" plugin/bin/
echo "已同步到插件包: plugin/bin/$(basename "$EXE")"

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

  echo "==> 质量门禁：JS 语法"
  node --check test/runner-client.js
  node --check test/ab-verify.js
  node --check bench/d1-ab-bench.js

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
  rm -rf obj bin "$OUT_ABS"/*
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
export AOT_RUNNER="$EXE"

if [ "$TEST" = "1" ]; then
  echo
  echo "==> S4 A/B 验证（node runner vs AOT runner）"
  node --test test/ab-verify.js
fi

if [ "$BENCH" = "1" ]; then
  echo
  echo "==> D1 性能基准"
  node bench/d1-ab-bench.js
fi

echo
echo "完成。runner 路径: $EXE"

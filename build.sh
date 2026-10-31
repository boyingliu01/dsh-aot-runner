#!/usr/bin/env bash
# 构建 AOT runner，输出目录默认落在 %TEMP%\dsh-aot-runner-dist
# （避开 Low Integrity 目录，原因见 DshAotRunner.csproj 注释）
#
# 用法：
#   ./build.sh                    # 增量构建
#   ./build.sh --clean            # 清理后重建
#   ./build.sh --test             # 构建后跑 A/B 验证
#   ./build.sh --all              # 清理重建 + 测试 + 基准
set -euo pipefail

cd "$(dirname "$0")"

OUT="${RunnerOutDir:-$TEMP/dsh-aot-runner-dist}"
OUT_WIN=$(cygpath -w "$OUT" 2>/dev/null || echo "$OUT")
CLEAN=0
TEST=0
BENCH=0

for arg in "$@"; do
  case "$arg" in
    --clean) CLEAN=1 ;;
    --test)  TEST=1 ;;
    --bench) BENCH=1 ;;
    --all)   CLEAN=1; TEST=1; BENCH=1 ;;
    *) echo "未知参数: $arg" >&2; exit 2 ;;
  esac
done

if [ "$CLEAN" = "1" ]; then
  echo "==> 清理 obj/ bin/ 与输出目录"
  rm -rf obj bin "$OUT"
fi

echo "==> 构建 NativeAOT (输出: $OUT_WIN)"
dotnet publish -c Release -r win-x64 -o "$OUT" 2>&1 | grep -E "error|已还原|->" || true

EXE="$OUT/dsh-aot-runner.exe"
if [ ! -f "$EXE" ]; then
  echo "构建失败：找不到 $EXE" >&2
  exit 1
fi

SIZE=$(stat -c %s "$EXE" 2>/dev/null || stat -f %z "$EXE")
echo "==> 构建成功: $(basename "$EXE") 体积 $SIZE 字节"
export AOT_RUNNER="$EXE"

if [ "$TEST" = "1" ]; then
  echo
  echo "==> S4 A/B 验证（node runner vs AOT runner，25 用例）"
  node --test test/ab-verify.js
fi

if [ "$BENCH" = "1" ]; then
  echo
  echo "==> D1 性能基准"
  node bench/d1-ab-bench.js
fi

echo
echo "完成。runner 路径: $EXE"

#!/bin/sh
# 校验 NativeAOT 产物的外部依赖（Issue #5 / S1b）
#
# 目标：确认 exe 没有 VC++ 运行时依赖、没有 .NET 运行时依赖，
# 只依赖 Windows 自带组件。这是「能不能直接分发给别人」的硬前提 ——
# 依赖 vcruntime140 的 exe 在没装 VC++ 可再发行包的机器上会直接起不来。
#
# 用法：./scripts/check-deps.sh [exe路径]
set -eu

cd "$(dirname "$0")/.."

EXE="${1:-dist/dsh-aot-runner.exe}"
[ -f "$EXE" ] || { echo "找不到产物: $EXE（先跑 ./build.sh）" >&2; exit 2; }

# 相对路径转成 Windows 绝对路径给 dumpbin 用
EXE_WIN=$(cd "$(dirname "$EXE")" && pwd -W)/$(basename "$EXE")

# 取产物的依赖 DLL 清单。两条路，任一成功即可：
#   1. dumpbin /DEPENDENTS —— 随 MSVC 工具链安装，输出格式稳定
#   2. llvm-readobj --coff-imports —— 随 LLVM/Clang 安装
#
# 为什么要有后备（2026-11-06 加）：本机曾只有 .NET SDK 而没有 VC++ 工具链，
# dumpbin 找不到 → 脚本 exit 2 → build.sh 中止构建。
# 结果是「依赖检查」这道门禁**永远失败**，等于形同虚设；
# 而实际依赖可以用 LLVM 工具独立测出来。多一条路让门禁在更多环境里真正生效。
find_dumpbin() {
  for root in "/c/Program Files (x86)/Microsoft Visual Studio" \
              "/c/Program Files/Microsoft Visual Studio" \
              "/c/BuildTools"; do
    [ -d "$root" ] || continue
    found=$(find "$root" -name dumpbin.exe -path "*Hostx64/x64*" 2>/dev/null | head -1)
    [ -n "$found" ] && { echo "$found"; return 0; }
  done
  return 1
}

find_llvm_readobj() {
  if command -v llvm-readobj >/dev/null 2>&1; then
    command -v llvm-readobj
    return 0
  fi
  for candidate in \
    "/c/Program Files/LLVM/bin/llvm-readobj.exe" \
    "$HOME/scoop/apps/llvm/current/bin/llvm-readobj.exe"; do
    [ -x "$candidate" ] && { echo "$candidate"; return 0; }
  done
  return 1
}

DEPS=""
if DUMPBIN=$(find_dumpbin); then
  # dumpbin 输出是 CRLF，且依赖块前后都有空行。
  # 这里不按「空行」切分（行尾 \r 会让模式失配），而是直接抓所有以 .dll 结尾的行 ——
  # 依赖清单本身就是整个输出里唯一符合该形态的内容。
  DEPS=$(MSYS2_ARG_CONV_EXCL='*' "$DUMPBIN" /DEPENDENTS "$EXE_WIN" 2>/dev/null \
    | tr -d '\r' \
    | grep -oiE '^[[:space:]]+[A-Za-z0-9_.-]+\.dll$' \
    | tr -d ' ' \
    | sort -u)
  TOOL="dumpbin"
elif READOBJ=$(find_llvm_readobj); then
  # llvm-readobj 输出形如 "  Name: KERNEL32.dll"
  DEPS=$(MSYS2_ARG_CONV_EXCL='*' "$READOBJ" --coff-imports "$EXE_WIN" 2>/dev/null \
    | tr -d '\r' \
    | sed -n 's/^[[:space:]]*Name:[[:space:]]*\([A-Za-z0-9_.-]*\.dll\)$/\1/ip' \
    | sort -u)
  TOOL="llvm-readobj"
else
  echo "找不到 dumpbin.exe 或 llvm-readobj —— 无法检查依赖。" >&2
  echo "装任意一个即可：VS 的 C++ 工具链，或 LLVM。" >&2
  exit 2
fi

[ -n "$DEPS" ] || { echo "未解析到依赖列表（$TOOL 输出格式可能变了）" >&2; exit 2; }
echo "==> 检查工具: $TOOL"

echo "==> 产物: $EXE"
echo "==> 依赖清单:"
echo "$DEPS" | sed 's/^/    /'
echo

FAIL=0

# ---- 禁止项：VC++ 运行时（目标机器不一定装了可再发行包）----
for pat in vcruntime msvcp msvcr concrt vccorlib; do
  hit=$(echo "$DEPS" | grep -i "^${pat}" || true)
  if [ -n "$hit" ]; then
    echo "[ FAIL ] 出现 VC++ 运行时依赖: $hit"
    FAIL=1
  fi
done

# ---- 禁止项：.NET 运行时 ----
for pat in coreclr hostpolicy clrjit; do
  hit=$(echo "$DEPS" | grep -i "$pat" || true)
  if [ -n "$hit" ]; then
    echo "[ FAIL ] 出现 .NET 运行时依赖: $hit"
    FAIL=1
  fi
done

# ---- 白名单：只允许 Windows 自带组件 ----
# api-ms-win-crt-* 是 UCRT 的 API set 转发 DLL，Windows 10+ 自带；
# 其余为系统 DLL。
UNEXPECTED=$(echo "$DEPS" | grep -viE \
  '^(kernel32|ntdll|advapi32|bcrypt|ole32|crypt32|user32|ws2_32|shell32|secur32|userenv|shlwapi|iphlpapi|dbghelp|api-ms-win-[a-z0-9-]+|msvcrt|ucrtbase)\.dll$' || true)
if [ -n "$UNEXPECTED" ]; then
  echo "[ WARN ] 以下依赖不在预期白名单内（请确认目标 Windows 版本自带）:"
  echo "$UNEXPECTED" | sed 's/^/    /'
fi

echo
if [ "$FAIL" = "1" ]; then
  echo "==> 依赖检查未通过"
  exit 1
fi
echo "==> 依赖检查通过：无 VC++ 运行时依赖、无 .NET 运行时依赖"

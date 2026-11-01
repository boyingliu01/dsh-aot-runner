#!/usr/bin/env bash
# Low Integrity (Low IL) 目录自检
#
# 为什么需要：
#   如果构建产物所在的目录被标记为 "Mandatory Label\Low Mandatory Level"，
#   从该目录启动的 exe 会继承 Low IL 完整性级别。由此产生两类失败：
#     1. 无法创建 BaseNamedObjects 下的对象 → MSYS/Cygwin 程序（bash/ls/sh）
#        崩在 NtCreateDirectoryObject(\BaseNamedObjects\msys-2.0S5-...)，0xC0000022
#     2. 无法写 Medium IL 的 %TEMP% → "Access is denied"
#   典型来源是 DSH Windows 沙箱在 workspace-write 模式下给工作目录打的标签，
#   且退出时会保留（源码注释："workspace ACEs stay standing as the reuse cache"）。
#
# 用法：
#   scripts/check-integrity.sh <目录> [...]
#   退出码 0 = 全部 Medium IL 或更高；1 = 存在 Low IL 目录
#
# 本脚本本身不做任何修改，只做检测并给出可操作的建议。
set -uo pipefail

# Low IL 的 SID 是 S-1-16-4096，icacls 的文本表现是 "Mandatory Label\Low Mandatory Level"
LOW_IL_PATTERN='Low Mandatory Level|S-1-16-4096'

status=0
checked=0

for target in "$@"; do
  if [ ! -e "$target" ]; then
    echo "  [skip] $target (不存在)"
    continue
  fi
  checked=$((checked + 1))

  # icacls 在非 Windows 平台上不存在，直接跳过而不是误报
  if ! command -v icacls.exe >/dev/null 2>&1; then
    echo "  [skip] icacls.exe 不可用（非 Windows 环境）"
    break
  fi

  win_path=$(cygpath -w "$target" 2>/dev/null || echo "$target")
  acl=$(MSYS2_ARG_CONV_EXCL='*' icacls.exe "$win_path" 2>&1)

  if printf '%s' "$acl" | grep -qiE "$LOW_IL_PATTERN"; then
    echo "  [FAIL] $win_path"
    echo "         → 目录带 Low Integrity 标签，构建产物会继承 Low IL 并运行时崩溃"
    echo "         → 用 -p:RunnerOutDir=<Medium IL 目录> 换一个输出目录，例如："
    echo "           ./build.sh --out \"\$TEMP/dsh-aot-runner-dist\""
    status=1
  else
    echo "  [ OK ] $win_path (Medium IL 或更高)"
  fi
done

if [ "$checked" -eq 0 ]; then
  echo "  [skip] 没有可检查的目录"
fi

exit "$status"

# 发布后 24h 指标采集 —— 无人值守入口（供 Windows 计划任务调用）
#
# 为什么要有这一层：计划任务的环境与交互式 shell 不同，
# 没有 PATH 里那些 gh/node 的路径，也没有工作目录保证。
# 直接把 `node scripts/collect-launch-metrics.mjs` 塞进计划任务，
# 失败方式会是「什么都没发生」—— 而这正是本项目反复踩的坑
# （静默失效比报错更难查）。
#
# 所以这里做三件事：
#   1. 显式定位 node 与 gh
#   2. 把成功/失败都写进日志文件，不依赖窗口停留
#   3. 失败时给出明确原因，而不是静默退出

$ErrorActionPreference = 'Stop'
$Repo  = 'D:\projects\dsh-aot-runner'
$LogDir = Join-Path $Repo 'logs'
$Log   = Join-Path $LogDir ("launch-check-{0}.log" -f (Get-Date -Format 'yyyy-MM-dd'))

if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null }

function Write-Log([string]$msg) {
  $line = "[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $msg
  Add-Content -Path $Log -Value $line -Encoding utf8
  Write-Output $line
}

try {
  Write-Log '=== 发布后指标采集开始 ==='

  Push-Location $Repo

  # 显式定位可执行文件：计划任务的 PATH 不可靠
  $node = (Get-Command node -ErrorAction SilentlyContinue).Source
  if (-not $node) { throw '找不到 node（计划任务的 PATH 可能不含 Node.js）' }

  $gh = (Get-Command gh -ErrorAction SilentlyContinue).Source
  if (-not $gh) { Write-Log '警告：找不到 gh，discussion 与流量指标将标记为「取不到」' }
  else { Write-Log "gh: $gh" }

  Write-Log "node: $node"

  # 采集并落盘
  $out = & $node 'scripts/collect-launch-metrics.mjs' '--save' 2>&1
  $out | ForEach-Object { Write-Log $_ }

  if ($LASTEXITCODE -ne 0) { throw "采集脚本退出码 $LASTEXITCODE" }

  Write-Log '=== 采集完成 ==='
  Pop-Location
  exit 0
}
catch {
  Write-Log "失败：$($_.Exception.Message)"
  exit 1
}

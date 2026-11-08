<#
.SYNOPSIS
  在 Windows 目标机上执行部署：解包、安装生产依赖、重启进程、健康检查。

.DESCRIPTION
  由 .github/workflows/deploy.yml 通过 SSH 调用，也可在服务器上手动执行。
  发布包由 `git archive` 生成，不含 node_modules、runtime 与 .env，因此不会覆盖密钥和业务数据。

  托管方式默认自动探测，顺序为：Windows 服务 → NSSM → pm2 → 计划任务。
  也可以用 -RestartMode 显式指定；-RestartMode none 表示只更新文件、不重启（需自行启动）。

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File qtb-deploy.ps1 `
    -TargetPath C:\sites\qiantubailian -ServiceName qiantubailian -HealthUrl http://127.0.0.1:3000/readyz
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$TargetPath,
  [string]$Archive = (Join-Path $env:USERPROFILE 'qtb-release.tgz'),
  [string]$ServiceName = '',
  [ValidateSet('auto', 'service', 'nssm', 'pm2', 'task', 'none')][string]$RestartMode = 'auto',
  [string]$HealthUrl = 'http://127.0.0.1:3000/readyz',
  [int]$HealthTimeoutSeconds = 90
)

$ErrorActionPreference = 'Stop'

function Step([string]$text) { Write-Host "==> $text" }

# Windows PowerShell 5.1 在 $ErrorActionPreference='Stop' 下会把原生命令的 stderr
# 当成终止错误（如 npm 的告警），这里临时降级并原样透传输出，退出码仍取 $LASTEXITCODE。
function Invoke-Native {
  param([scriptblock]$Command)
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    & $Command 2>&1 | ForEach-Object { Write-Host $_ }
  } finally {
    $ErrorActionPreference = $previous
  }
}

# 探测用：不输出、不抛错，只返回原生命令是否以 0 退出。
function Test-NativeQuiet {
  param([scriptblock]$Command)
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    & $Command *> $null
  } finally {
    $ErrorActionPreference = $previous
  }
  return $LASTEXITCODE -eq 0
}

function Get-DetectedMode {
  param([string]$Mode, [string]$Name)
  $order = if ($Mode -eq 'auto') { @('service', 'nssm', 'pm2', 'task') } else { @($Mode) }
  foreach ($candidate in $order) {
    switch ($candidate) {
      'service' {
        if ($Name -and (Get-Service -Name $Name -ErrorAction SilentlyContinue)) { return 'service' }
      }
      'nssm' {
        if ($Name -and (Get-Command nssm -ErrorAction SilentlyContinue) -and (Test-NativeQuiet { & nssm status $Name })) {
          return 'nssm'
        }
      }
      'pm2' {
        if ($Name -and (Get-Command pm2 -ErrorAction SilentlyContinue) -and (Test-NativeQuiet { & pm2 describe $Name })) {
          return 'pm2'
        }
      }
      'task' {
        if ($Name -and (Test-NativeQuiet { & schtasks /Query /TN $Name })) {
          return 'task'
        }
      }
    }
  }
  return $null
}

function Stop-App([string]$Mode, [string]$Name) {
  switch ($Mode) {
    'service' { Stop-Service -Name $Name -Force -ErrorAction Stop }
    'nssm' { & nssm stop $Name | Out-Null }
    'pm2' { & pm2 stop $Name | Out-Null }
    'task' { & schtasks /End /TN $Name | Out-Null }
  }
}

function Start-App([string]$Mode, [string]$Name) {
  switch ($Mode) {
    'service' { Start-Service -Name $Name -ErrorAction Stop }
    'nssm' { & nssm start $Name | Out-Null }
    'pm2' { & pm2 start $Name | Out-Null }
    'task' { & schtasks /Run /TN $Name | Out-Null }
  }
}

if ($TargetPath -match '\s') { throw "部署目录不能包含空格：$TargetPath" }
if (-not (Test-Path -LiteralPath $TargetPath)) { throw "部署目录不存在：$TargetPath" }
if (-not (Test-Path -LiteralPath $Archive)) { throw "发布包不存在：$Archive" }
foreach ($command in @('node', 'npm.cmd', 'tar.exe')) {
  if (-not (Get-Command $command -ErrorAction SilentlyContinue)) {
    throw "找不到命令 $command，请确认 Node 22.22.2 与 tar 已加入 PATH"
  }
}

$mode = $null
if ($RestartMode -ne 'none') {
  $mode = Get-DetectedMode -Mode $RestartMode -Name $ServiceName
  if (-not $mode) {
    throw "未找到名为 '$ServiceName' 的 Windows 服务/NSSM/pm2 进程/计划任务（模式 $RestartMode）。请确认托管方式，或用 -RestartMode 指定。"
  }
  Step "停止进程（$mode · $ServiceName）"
  Stop-App $mode $ServiceName
}

try {
  Step "解包 $Archive → $TargetPath"
  Invoke-Native { & tar.exe -xzf $Archive -C $TargetPath }
  if ($LASTEXITCODE -ne 0) { throw '解包失败' }
  Remove-Item -LiteralPath $Archive -Force -ErrorAction SilentlyContinue

  Step '安装生产依赖（npm ci --omit=dev）'
  Push-Location $TargetPath
  try {
    Invoke-Native { & npm.cmd ci --omit=dev --no-audit --no-fund }
    if ($LASTEXITCODE -ne 0) { throw 'npm ci 失败' }
  } finally {
    Pop-Location
  }
} finally {
  if ($mode) {
    Step "启动进程（$mode · $ServiceName）"
    Start-App $mode $ServiceName
  }
}

if ($RestartMode -eq 'none') {
  Step '已跳过重启（-RestartMode none）'
  return
}

Step "健康检查 $HealthUrl（最多 $HealthTimeoutSeconds 秒）"
$deadline = (Get-Date).AddSeconds($HealthTimeoutSeconds)
$lastError = '尚未收到响应'
while ((Get-Date) -lt $deadline) {
  try {
    $response = Invoke-WebRequest -Uri $HealthUrl -UseBasicParsing -TimeoutSec 5
    if ($response.StatusCode -eq 200) {
      Write-Host "健康检查通过（HTTP $($response.StatusCode)）"
      return
    }
    $lastError = "HTTP $($response.StatusCode)"
  } catch {
    $lastError = $_.Exception.Message
  }
  Start-Sleep -Seconds 3
}
throw "部署后健康检查失败：$lastError"

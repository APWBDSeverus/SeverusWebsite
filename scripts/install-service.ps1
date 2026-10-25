# 一次装好：站点 + 隧道 都做成开机自启的计划任务
# 用法（必须以管理员身份运行 PowerShell）：
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-service.ps1
#
# 不使用 Windows 服务（cloudflared service install）：
# 遇到 "SERVICE_MARKED_FOR_DELETE" 时 SCM 会拒绝重建，必须重启才能清。
# 计划任务同样能开机自启，而且更好排查。

$ErrorActionPreference = "Continue"

# ---------- 0. 管理员检查 ----------
$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Host "需要管理员权限。请右键开始菜单 -> 终端(管理员)，再运行本脚本。" -ForegroundColor Red
    exit 1
}

$projectDir  = Split-Path -Parent $PSScriptRoot
$python      = (Get-Command python.exe).Source
$cloudflared = "E:\cloudflared\cloudflared.exe"
$cfConfig    = "$env:USERPROFILE\.cloudflared\config.yml"
$dataDir     = "E:\Severus"
$port        = 8080

Write-Host "=== 环境检查 ===" -ForegroundColor Cyan
if (-not (Test-Path $cloudflared)) { throw "找不到 $cloudflared" }
if (-not (Test-Path $cfConfig))    { throw "找不到隧道配置 $cfConfig" }
if (-not (Test-Path (Join-Path $projectDir "server.py"))) { throw "找不到 server.py" }
Write-Host "  项目 : $projectDir"
Write-Host "  数据 : $dataDir"
Write-Host "  隧道 : $cfConfig"

# ---------- 1. 清掉可能残留的服务（尽力而为） ----------
Write-Host "`n=== 1/4 清理旧的 cloudflared 服务 ===" -ForegroundColor Cyan
$svc = Get-Service cloudflared -ErrorAction SilentlyContinue
if ($svc) {
    Write-Host "  检测到服务 cloudflared（$($svc.Status)），尝试移除…"
    $out = & sc.exe delete cloudflared 2>&1
    Write-Host "  $out"
    Write-Host "  若提示已标记为删除，忽略即可 —— 我们改用计划任务，不再依赖它。"
} else {
    Write-Host "  没有残留服务，跳过。"
}

# ---------- 2. 站点计划任务 ----------
Write-Host "`n=== 2/4 注册站点自启 ===" -ForegroundColor Cyan

$siteTask = "SeverusSite"
Unregister-ScheduledTask -TaskName $siteTask -Confirm:$false -ErrorAction SilentlyContinue

$siteAction = New-ScheduledTaskAction -Execute $python `
    -Argument "server.py --host 127.0.0.1 --port $port" `
    -WorkingDirectory $projectDir
$siteTrigger = New-ScheduledTaskTrigger -AtStartup
$siteSettings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
    -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero)
$sitePrincipal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest

Register-ScheduledTask -TaskName $siteTask -Action $siteAction -Trigger $siteTrigger `
    -Settings $siteSettings -Principal $sitePrincipal `
    -Description "Severus 站点（Python，端口 $port）" | Out-Null
Write-Host "  已注册：$siteTask"

[Environment]::SetEnvironmentVariable("SEVERUS_DATA", $dataDir, "Machine")
Write-Host "  已写入系统环境变量 SEVERUS_DATA=$dataDir"

# ---------- 3. 隧道计划任务 ----------
Write-Host "`n=== 3/4 注册隧道自启 ===" -ForegroundColor Cyan

$tunnelTask = "SeverusTunnel"
Unregister-ScheduledTask -TaskName $tunnelTask -Confirm:$false -ErrorAction SilentlyContinue

$tunnelAction = New-ScheduledTaskAction -Execute $cloudflared `
    -Argument "--config `"$cfConfig`" tunnel run severus" `
    -WorkingDirectory "E:\cloudflared"
$tunnelTrigger = New-ScheduledTaskTrigger -AtStartup
$tunnelSettings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
    -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
$tunnelPrincipal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest

Register-ScheduledTask -TaskName $tunnelTask -Action $tunnelAction -Trigger $tunnelTrigger `
    -Settings $tunnelSettings -Principal $tunnelPrincipal `
    -Description "Severus 隧道（cloudflared，severus.dpdns.org）" | Out-Null
Write-Host "  已注册：$tunnelTask"

# ---------- 4. 立刻启动并验证 ----------
Write-Host "`n=== 4/4 启动并验证 ===" -ForegroundColor Cyan

Get-CimInstance Win32_Process -Filter "Name='python.exe'" |
    Where-Object { $_.CommandLine -like "*server.py*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Get-Process cloudflared -ErrorAction SilentlyContinue |
    ForEach-Object { Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue }
Start-Sleep -Seconds 2

Start-ScheduledTask -TaskName $siteTask
Start-Sleep -Seconds 5
try {
    $r = Invoke-WebRequest "http://127.0.0.1:$port/" -UseBasicParsing -TimeoutSec 10
    Write-Host "  本地 :$port -> $($r.StatusCode) OK" -ForegroundColor Green
} catch {
    Write-Host "  本地失败：$($_.Exception.Message)" -ForegroundColor Red
}

Start-ScheduledTask -TaskName $tunnelTask
Write-Host "  隧道已启动，等待连接…"
Start-Sleep -Seconds 12

try {
    $r2 = Invoke-WebRequest "https://severus.dpdns.org/" -UseBasicParsing -TimeoutSec 20
    Write-Host "  公网 -> $($r2.StatusCode) OK   https://severus.dpdns.org/" -ForegroundColor Green
} catch {
    Write-Host "  公网暂时不通（隧道可能还在重连，等 30 秒后再试一次）" -ForegroundColor Yellow
}

Write-Host "`n=== 完成 ===" -ForegroundColor Cyan
Get-ScheduledTask -TaskName $siteTask, $tunnelTask -ErrorAction SilentlyContinue |
    Select-Object TaskName, State | Format-Table -AutoSize
Write-Host "重启电脑后两个任务会自动运行。"
Write-Host "临时停站：  Stop-ScheduledTask -TaskName SeverusSite"
Write-Host "临时停隧道：Stop-ScheduledTask -TaskName SeverusTunnel"

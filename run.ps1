# 启动站点（允许局域网访问）
# 用法：
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\run.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\run.ps1 -Port 80
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\run.ps1 -Local      # 只听本机
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\run.ps1 -DataDir D:\mydata
#
# 数据默认放在 E:\Severus（没有 E 盘就退回本目录的 data）。

param(
    [int]$Port = 8080,
    [switch]$Local,
    [string]$DataDir = ""
)

$ErrorActionPreference = 'Stop'
Set-Location (Split-Path -Parent $MyInvocation.MyCommand.Path)

function Test-PortFree([int]$Candidate) {
    $listener = $null
    try {
        $listener = New-Object System.Net.Sockets.TcpListener -ArgumentList ([System.Net.IPAddress]::Any), $Candidate
        $listener.Start()
        return $true
    } catch {
        return $false
    } finally {
        if ($listener) { $listener.Stop() }
    }
}

# 优先 80（浏览器不用输端口），被占用就退到 8080
if ($Port -eq 8080 -and (Test-PortFree 80)) {
    $Port = 80
}

if (-not (Test-PortFree $Port)) {
    Write-Host "端口 $Port 被占用，请用 -Port 指定别的" -ForegroundColor Red
    exit 1
}

$host_ = if ($Local) { '127.0.0.1' } else { '0.0.0.0' }

# 决定数据目录：显式参数 > E:\Severus > 本目录 data
if (-not $DataDir) {
    if (Test-Path 'E:\') { $DataDir = 'E:\Severus' }
    else { $DataDir = Join-Path (Get-Location) 'data' }
}
New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
$env:SEVERUS_DATA = $DataDir

if (-not $Local) {
    Write-Host ''
    Write-Host '提示：手机访问需要防火墙放行。首次启动 Windows 会弹窗，必须点允许。' -ForegroundColor Yellow
    Write-Host '没弹窗就运行（管理员）： .\scripts\lan-firewall.ps1' -ForegroundColor DarkGray
}

Write-Host ''
Write-Host "数据目录： $DataDir" -ForegroundColor Cyan
Write-Host ''

& python server.py --host $host_ --port $Port

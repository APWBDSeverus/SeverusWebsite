<#
按网段放行 Windows 防火墙入站端口（需要管理员权限）

默认只放行热点网段 192.168.137.0/24，校园网上的其他设备访问不到，
避免在校园网里意外暴露服务。

用法（管理员 PowerShell）：
    powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\lan-firewall.ps1 -Port 80
    # 同时允许同校园网段设备访问
    powershell ... -File .\scripts\lan-firewall.ps1 -Port 80 -Scope both
    # 撤销
    powershell ... -File .\scripts\lan-firewall.ps1 -Port 80 -Remove
#>
param(
    [int]$Port = 80,
    [ValidateSet('hotspot', 'lan', 'both')]
    [string]$Scope = 'hotspot',
    [switch]$Remove
)

$ErrorActionPreference = 'Stop'

$principal = New-Object Security.Principal.WindowsPrincipal -ArgumentList ([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Host '需要管理员权限。' -ForegroundColor Red
    Write-Host '请这样操作：开始菜单搜索「PowerShell」→ 右键 → 以管理员身份运行，然后执行：' -ForegroundColor Yellow
    Write-Host "  cd `"$((Split-Path -Parent $PSScriptRoot))`"" -ForegroundColor Yellow
    Write-Host "  powershell -ExecutionPolicy Bypass -File .\scripts\lan-firewall.ps1 -Port $Port -Scope $Scope" -ForegroundColor Yellow
    exit 1
}

$ruleName = "mysite-in-tcp-$Port"

if ($Remove) {
    $existing = Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
    if ($existing) {
        $existing | Remove-NetFirewallRule
        Write-Host "已删除防火墙规则：$ruleName" -ForegroundColor Green
    } else {
        Write-Host "没找到规则 $ruleName，无需删除" -ForegroundColor Yellow
    }
    exit 0
}

$sources = switch ($Scope) {
    'hotspot' { @('192.168.137.0/24') }
    'lan'     { @('LocalSubnet') }
    'both'    { @('192.168.137.0/24', 'LocalSubnet') }
}

# 幂等：先删旧的再建
Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue |
    Remove-NetFirewallRule -ErrorAction SilentlyContinue

New-NetFirewallRule `
    -DisplayName $ruleName `
    -Description 'mysite 局域网访问（按来源网段限制）' `
    -Direction Inbound `
    -Action Allow `
    -Protocol TCP `
    -LocalPort $Port `
    -Profile Any `
    -RemoteAddress $sources | Out-Null

Write-Host "已放行入站 TCP $Port，来源限定：$($sources -join ', ')" -ForegroundColor Green
Write-Host '（Profile=Any 是按来源网段做限制，比按网络类型更可靠）' -ForegroundColor DarkGray

# ---------------------------------------------------------------- 状态

$hotspot = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object { $_.IPAddress -like '192.168.137.*' }

Write-Host ''
if ($hotspot) {
    Write-Host "热点已开启，手机连上后访问： http://192.168.137.1:$Port" -ForegroundColor Green
} else {
    Write-Host '还没开热点。开热点：设置 → 网络和 Internet → 移动热点' -ForegroundColor Yellow
    Write-Host '或者执行： Start-Process ms-settings:network-mobilehotspot' -ForegroundColor DarkGray
    Write-Host '开好后手机连这个 WiFi，再访问 http://192.168.137.1' -ForegroundColor DarkGray
}

Write-Host ''
Write-Host '当前所有 IPv4 地址：' -ForegroundColor DarkGray
Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object { $_.IPAddress -notlike '127.*' } |
    ForEach-Object { Write-Host ("  {0,-16} {1}" -f $_.IPAddress, $_.InterfaceAlias) -ForegroundColor DarkGray }

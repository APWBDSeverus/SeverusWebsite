# 部署指引

这份文档覆盖本项目（Python 自建服务 + SQLite + 本地媒体）的三种部署方式。
按需选一条，不必全做。

---

## 0. 先弄清定位

| 项 | 说明 |
|---|---|
| 运行时 | 单个 Python 进程（标准库，无第三方依赖） |
| 数据 | SQLite + 本地磁盘媒体，默认 `E:\Severus` |
| 端口 | 默认 `80`（可用 `--port` 改） |
| 适配 | **不是静态站**，不能用 Pages / Netlify / GitHub Pages 托管 |

启动命令：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\run.ps1
```

或直接：

```powershell
$env:SEVERUS_DATA = "E:\Severus"
python server.py --host 0.0.0.0 --port 80
```

---

## 1. 局域网部署（最快）

**适用**：家里 / 自己的路由器下，几台设备互访。

### 步骤

1. 启动服务（绑定 `0.0.0.0`）
2. 查本机地址：
   ```powershell
   Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254*' }
   ```
3. 放行防火墙（**管理员** PowerShell）：
   ```powershell
   New-NetFirewallRule -DisplayName "Severus 80" -Direction Inbound -Protocol TCP -LocalPort 80 -Action Allow -Profile Public,Private,Domain
   ```
4. 手机浏览器打开 `http://<本机IP>/`

### 常见失败原因

| 现象 | 原因 | 处理 |
|---|---|---|
| 本机能开、手机打不开 | 防火墙 | 执行第 3 步 |
| 手机 IP 与本机不同网段 | 不在同一网络 | 看两者前三段是否一致 |
| 同网段仍不通 | **客户端隔离**（单位/校园网常见） | 换热点或走第 2 节穿透 |

---

## 2. 公网访问

### 2.1 SSH 反向隧道（零安装，临时）

系统自带 `ssh.exe`，不需要下载任何东西。

```powershell
ssh -o StrictHostKeyChecking=no -R 80:127.0.0.1:80 nokey@localhost.run
```

运行后终端会打印一个 `https://xxxx.lhr.life` 的地址，外网可访问。
**关掉窗口即下线**，适合验证链路。

其他同类：`serveo.net`、`pinggy.io`。

### 2.2 Cloudflare Tunnel（推荐，长期）

分两档：

| 形态 | 账号 | 域名 | 网址 |
|---|---|---|---|
| Quick Tunnel | 不需要 | 不需要 | 随机 `*.trycloudflare.com`，重启即变 |
| **Named Tunnel** | 需要 | 需要（NS 托管到 CF） | `severus.你的域名.com`，固定 |

#### Quick Tunnel（试用）

```powershell
E:\cloudflared\cloudflared.exe tunnel --url http://127.0.0.1:80
```

#### Named Tunnel（正式）

```powershell
cloudflared tunnel login
cloudflared tunnel create severus
cloudflared tunnel route dns severus severus.example.com
```

`C:\Users\<你>\.cloudflared\config.yml`：

```yaml
tunnel: severus
credentials-file: C:\Users\<你>\.cloudflared\<隧道ID>.json

ingress:
  - hostname: severus.example.com
    service: http://127.0.0.1:80
    originRequest:
      connectTimeout: 30s
  - service: http_status:404
```

```powershell
cloudflared tunnel run severus
```

开机自启**不要用** `cloudflared service install`——一旦遇到
`SERVICE_MARKED_FOR_DELETE`（服务已标记为删除），`Set-Service`/`Start-Service`
会全部失败且必须重启才能清。改用计划任务：

```powershell
$act = New-ScheduledTaskAction -Execute "E:\cloudflared\cloudflared.exe" `
  -Argument "--config `"$env:USERPROFILE\.cloudflared\config.yml`" tunnel run severus" `
  -WorkingDirectory "E:\cloudflared"
$trg = New-ScheduledTaskTrigger -AtStartup
Register-ScheduledTask -TaskName SeverusTunnel -Action $act -Trigger $trg -RunLevel Highest -User SYSTEM
```

本项目已提供一键脚本：`scripts\install-service.ps1`（需管理员）。

#### 可选：Cloudflare Access

在 Zero Trust 里给这个域名加一条 Access 策略（邮箱验证码 / 指定邮箱白名单），
免费额度 50 人。相当于在站点外面再加一道门，适合半公开阶段。

#### 注意：部分网络会封 QUIC

如果日志里出现 `Failed to dial a quic connection`，而 TCP 预检是 PASS，
说明 UDP 7844 被挡住了。在 `config.yml` 里加一行强制 HTTP/2：

```yaml
protocol: http2
```

#### 两个硬限制

- **单次请求 100MB**（免费计划）。本项目上传已按 **8MB 分片**，不受影响；
  但不要改大分片。
- 国内速度不保证，视频拖动会卡。长期看视频多建议 R2 + CDN 或国内服务器。

### 2.3 云服务器（最稳，要花钱）

| 步骤 | 命令 |
|---|---|
| 装 Python | `apt install -y python3 nginx` |
| 放代码 | `cp -r ./* /opt/severus/` |
| 数据目录 | `mkdir -p /var/lib/severus`，`Environment=SEVERUS_DATA=/var/lib/severus` |
| systemd | 见 README 的部署章节 |
| Nginx 反代 | `client_max_body_size 1600m; proxy_request_buffering off;` |
| HTTPS | `certbot --nginx -d 你的域名` |

---

## 3. 上线前必做

| 项 | 怎么做 |
|---|---|
| 改管理员密码 | `python reset_admin.py 新密码` |
| 关闭自由注册 | 后台 → 设置 → 取消「允许新用户自己注册」 |
| 开启申请制 | 后台 → 设置 → 勾选「改成申请制」 |
| 设配额 | 后台 → 设置 → 每人存储（建议 5GB）、每日上传数（建议 20） |
| 业务检查 | 确认没有私密照片被当成公开内容 |
| HTTPS | 走 Cloudflare 或 certbot，**不要用裸 HTTP 传密码** |

---

## 4. 开机自启

### Windows（任务计划，管理员）

```powershell
$act = New-ScheduledTaskAction -Execute "python" -Argument "server.py --host 0.0.0.0 --port 80" -WorkingDirectory "C:\path\to\severus"
$trg = New-ScheduledTaskTrigger -AtStartup
Register-ScheduledTask -TaskName "Severus" -Action $act -Trigger $trg -RunLevel Highest -User "SYSTEM"
```

### Linux（systemd）

```ini
[Unit]
Description=Severus
After=network.target

[Service]
Type=simple
User=severus
WorkingDirectory=/opt/severus
Environment=SEVERUS_DATA=/var/lib/severus
ExecStart=/usr/bin/python3 server.py --host 127.0.0.1 --port 8080
Restart=always

[Install]
WantedBy=multi-user.target
```

---

## 5. 备份

- 后台 → 设置 → **下载整站备份**（打包含数据库与全部媒体）
- 数据目录整体拷走也行：`E:\Severus` 即是全部（`severus.db` + `media/`）
- 建议：每周一次，异地存一份

---

## 6. 排障速查

| 现象 | 查什么 |
|---|---|
| 页面空白 | 浏览器控制台报错；强刷 `Ctrl+F5` |
| 接口 401 | 登录态过期，重新登录 |
| 接口 404「接口不存在」 | 方法不对（GET/POST/PATCH）或路径拼错 |
| 上传失败 | 看后台设置里的配额、单文件上限 |
| 手机连不上 | 见 1.1 的三条 |

---

## 7. 当前推荐路线

1. **今天**：SSH 反向隧道验证外网可达（零安装）
2. **本周**：拿到 cloudflared → Quick Tunnel → 手机长期验证
3. **稳定后**：买域名 → Named Tunnel → 加 Access → 配开机自启 + 定时备份

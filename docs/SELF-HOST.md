# 部署手册（自建服务器版，零成本优先）

你有：**一台服务器 + 阿里云 OSS + 没有备案域名**。

先说一个绕不过去的事实，它决定了后面所有选择：

> **微信小程序调用外部服务，必须使用"已 ICP 备案 + 已在小程序后台配置"的 HTTPS 域名，且不支持 IP 和端口。**
> 这是微信平台规则，不是技术限制，没有任何配置能绕过。

所以"小程序 + 自己的服务器 + 没备案"这三个条件同时成立时，**小程序连不上你的服务器**。

出路只有三条：

| 路线 | 形态 | 月成本 | 需要什么 | 多久能用上 |
| --- | --- | --- | --- | --- |
| **B（本文主推）** | 网页版 PWA，微信里打开链接 | **¥0** | 什么都不用 | **今天** |
| **A** | 小程序 | **≈ ¥1**（域名 ¥10–30/年，备案免费） | 一个域名 + 备案 2–3 周 | 3 周后 |
| C | 小程序 + 云开发 | ¥19.9 起 | —— | 今天，但要花钱 |

**建议：先按 B 上线（今天就能用），同时去备案；备案下来后把小程序切过来，两套后端是同一份代码、同一个数据库，数据不用迁移。**

后端只写了一次，两种形态共用：小程序和网页版读的是同一个 `/api`。

---

## 0. 架构

```
                         ┌──────────────────────────────┐
   小程序（备案后）  ────▶ │  POST /api  {action, payload}│
                         │  Bearer token 鉴权           │
   网页版 PWA  ─────────▶ │                              │
                         └──────────────┬───────────────┘
                                        │
                              ┌─────────▼─────────┐
                              │  SQLite（单文件）  │
                              │  data/babycare.db │
                              └─────────┬─────────┘
                                        │ 每天 03:30
                              ┌─────────▼─────────┐
                              │ 阿里云 OSS 快照    │
                              │ babycare/YYYY-MM-DD│
                              └───────────────────┘
```

- 服务端 **零依赖**：只用 Node 内置的 `node:http`、`node:sqlite`、`node:crypto`、`fetch`。**不需要 `npm install`**，也就不存在供应链和编译问题。
- 数据库是单个文件，备份 = 复制文件；快照 = 一个 JSON。
- OSS 只做冷备份，不参与读写，挂了也不影响使用。

---

## 1. 成本明细（真实数字）

| 项 | 费用 | 说明 |
| --- | --- | --- |
| 服务器 | 已有 = ¥0 | 1 核 512M 就够，空闲内存约 30–60 MB |
| Node.js | ¥0 | 开源 |
| 代码依赖 | ¥0 | 零 npm 依赖 |
| 数据库 | ¥0 | SQLite 单文件 |
| 阿里云 OSS | **每月 < ¥0.01** | 一年约 3 MB；标准存储 ¥0.12/GB/月；上传流量免费 |
| 域名（走小程序时） | **¥10–30/年** | `.top`/`.xyz` 首年常见 ¥9–19；`.cn` 约 ¥30 |
| ICP 备案 | **¥0** | 阿里云备案服务免费 |
| HTTPS 证书 | ¥0 | Let's Encrypt（Caddy 自动）或 Cloudflare |

**走 B：¥0。走 A：≈ ¥10–30/年，平均每月 1–3 元。**

---

## 2. 准备服务器

要求：Linux（Debian/Ubuntu/CentOS 都行）、**Node.js ≥ 22.5**（推荐 24 LTS）、能出网。

```bash
# 用 nvm 装（不污染系统包）
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
source ~/.bashrc
nvm install 24
node -v        # 应输出 v24.x
node -e "require('node:sqlite'); console.log('sqlite ok')"
```

> 如果 `node:sqlite` 报错，说明 Node 版本低于 22.5；Node 22.x 需要加 `--experimental-sqlite` 参数，建议直接上 24。

---

## 3. 上传代码

```bash
# 在本地仓库根目录
rsync -av --exclude node_modules --exclude 'server/data' --exclude '.git' \
  ./ user@your-server:/opt/babycare/
```

只需要 `server/`、`web/` 和 `miniprogram/utils/`（`server` 复用了小程序里的统计函数，不要漏）。

服务器上创建数据目录：

```bash
cd /opt/babycare
mkdir -p server/data
```

---

## 4. 配置

```bash
cp server/.env.example server/.env
```

编辑 `server/.env`，**这几项必须改**：

```bash
# 固定密钥，否则每次重启全家都要重新登录
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
TOKEN_SECRET=<把上面输出粘进来>

# 网页版入口口令（微信里打开链接时输入）
WEB_PASSCODE=换成你自己的6位以上口令
```

其余按需：

```bash
# 只有用小程序时才需要（公众平台 → 开发管理 → 开发设置）
WX_APPID=wx1234567890abcdef
WX_SECRET=从后台生成并复制，只填一次

# 阿里云 OSS 备份（不填就备份到本地 data/backups/）
OSS_ENDPOINT=oss-cn-hangzhou.aliyuncs.com
OSS_BUCKET=你的bucket
OSS_ACCESS_KEY_ID=...
OSS_ACCESS_KEY_SECRET=...
OSS_PREFIX=babycare/
```

> `.env` 已在 `.gitignore` 里，不会被提交。权限建议 `chmod 600 server/.env`。

---

## 5. 启动并验证

先前台跑一遍，确认没问题：

```bash
cd /opt/babycare
node server/index.js
```

应看到：

```
宝宝作息服务已启动
  地址: http://127.0.0.1:3000
  数据库: ./data/babycare.db
  备份: 阿里云 OSS
```

另开一个终端验证：

```bash
curl http://127.0.0.1:3000/healthz
# {"ok":true,"data":{"status":"ok",...}}

curl -X POST http://127.0.0.1:3000/api \
  -H 'Content-Type: application/json' \
  -d '{"action":"auth.webLogin","payload":{"passcode":"你的口令"}}'
# 返回 data.token 即成功
```

### 5.1 做成系统服务

```bash
sudo useradd -r -s /bin/false babycare || true
sudo chown -R babycare:babycare /opt/babycare/server/data
```

`/etc/systemd/system/babycare.service`：

```ini
[Unit]
Description=Babycare server
After=network.target

[Service]
Type=simple
User=babycare
WorkingDirectory=/opt/babycare
ExecStart=/usr/bin/node server/index.js
EnvironmentFile=/opt/babycare/server/.env
Restart=always
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now babycare
sudo systemctl status babycare
journalctl -u babycare -f        # 看日志
```

> `ExecStart` 里的 node 路径用 `which node` 的实际输出（nvm 装的路径类似 `/home/user/.nvm/versions/node/v24.x/bin/node`）。

---

## 6. 路线 B：零成本，今天就能用（网页版）

### 方式 1：Cloudflare Tunnel（免费 HTTPS，推荐）

不用买域名、不用备案、不用开端口。

```bash
# 装 cloudflared
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 \
  -o /usr/local/bin/cloudflared && chmod +x /usr/local/bin/cloudflared

# 临时隧道（前台跑，按 Ctrl+C 停）
cloudflared tunnel --url http://127.0.0.1:3000
```

输出里会有一行 `https://xxx-xxx-xxx.trycloudflare.com`，直接发给家人：

- 手机微信里点开 → 输入 `WEB_PASSCODE` → 开始记录
- Safari / Chrome 打开 → 「添加到主屏幕」，就像一个 App

**注意**：免费临时隧道每次重启换地址，链接要重新发。想要固定地址有两个办法：把一个域名托管到 Cloudflare（域名本身要花钱），或者用系统服务固定跑（地址仍会变）。

做成后台服务（地址仍会变，但不用手动起）：

```bash
sudo tee /etc/systemd/system/babycare-tunnel.service > /dev/null <<'EOF'
[Unit]
Description=Babycare cloudflare tunnel
After=network.target babycare.service

[Service]
ExecStart=/usr/local/bin/cloudflared tunnel --url http://127.0.0.1:3000
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl enable --now babycare-tunnel
journalctl -u babycare-tunnel | grep trycloudflare
```

### 方式 2：自签证书 + IP:8443（地址固定，零成本）

地址不会变，但浏览器会提示证书不受信任（家人第一次要点"继续访问"；**微信内置浏览器对自签证书可能直接拦截**，所以这条更适合在系统浏览器里用）。

```bash
sudo mkdir -p /opt/babycare/certs && cd /opt/babycare/certs
sudo openssl req -x509 -newkey rsa:2048 -nodes -keyout key.pem -out cert.pem \
  -days 3650 -subj "/CN=babycare"
```

`server/.env` 里加：

```bash
TLS_CERT=/opt/babycare/certs/cert.pem
TLS_KEY=/opt/babycare/certs/key.pem
HOST=0.0.0.0
PORT=8443
```

放行端口（阿里云安全组也要加）：

```bash
sudo ufw allow 8443/tcp
```

访问 `https://你的服务器IP:8443`。

### 方式 3：直接 HTTP（最省事，最不安全）

`HOST=0.0.0.0 PORT=8080`，访问 `http://IP:8080`。**只在局域网或用 VPN 时这么干**——明文传输，家庭作息也是隐私。

### 装到手机主屏幕

- **Android Chrome**：菜单 →「添加到主屏幕」
- **iPhone Safari**：分享 →「添加到主屏幕」
- **微信内**：只能每次点链接，或把链接存到「文件传输助手」置顶

---

## 7. 路线 A：备案域名 + 小程序（≈¥1/月）

### 7.1 买域名

阿里云/腾讯云随便，`.top`/`.xyz` 首年最便宜。**买完先做域名实名认证**（备案的前提）。

> 服务器必须在**中国大陆境内**才能备案。如果你的服务器在香港/海外，这条路走不通，只能停在路线 B。

### 7.2 备案

1. 阿里云控制台 → 备案 → 开始备案（用这台 ECS 申请免费备案服务号）。
2. 填主体信息（个人）+ 网站信息（网站名称不要带"宝宝""医疗"等可能被卡的词，写"个人生活记录"这类中性名）。
3. 上传证件、做人脸核验。
4. 阿里云初审 1–2 个工作日 → 管局审核 1–20 个工作日（一般 7–10 天）。
5. 通过后会拿到备案号，域名才能在大陆服务器上对外服务。

备案期间域名访问 80/443 会被阿里云拦截，这是正常的。

### 7.3 配 HTTPS（Caddy，自动证书）

```bash
sudo apt install -y caddy     # Debian/Ubuntu
```

`/etc/caddy/Caddyfile`：

```
baby.example.com {
    encode zstd gzip
    reverse_proxy 127.0.0.1:3000
}
```

```bash
sudo systemctl reload caddy
```

Caddy 会自动申请 Let's Encrypt 证书并续期，你什么都不用管。

> 用 Nginx 也行：`proxy_pass http://127.0.0.1:3000;` + `certbot --nginx`。

### 7.4 小程序端配置

改 [`miniprogram/config.js`](../miniprogram/config.js)：

```js
module.exports = {
  TRANSPORT: 'http',
  API_BASE: 'https://baby.example.com',   // 只填域名，不要带路径和端口
  ...
}
```

微信公众平台 → 开发管理 → 开发设置 → 服务器域名 → **request 合法域名** 添加 `https://baby.example.com`。

再回填服务端的 `WX_APPID` / `WX_SECRET`（小程序登录要用来换 openid），重启服务。

然后正常上传/预览/发布小程序即可。

> 开发阶段没备案也能在开发者工具里调通：详情 → 本地设置 → 勾选「不校验合法域名」。但体验版/正式版必须备案。

---

## 8. 阿里云 OSS 备份配置

### 8.1 建 Bucket

- 读写权限：**私有**
- 区域：离服务器近的（如 `oss-cn-hangzhou`）
- 不需要开静态网站托管

### 8.2 用 RAM 子账号（不要用主账号 AK）

RAM → 用户 → 创建用户 → 只勾「OpenAPI 调用访问」→ 拿到 AccessKey ID/Secret。

再建一个自定义权限策略，**只允许操作这个前缀**：

```json
{
  "Version": "1",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["oss:PutObject", "oss:GetObject", "oss:DeleteObject"],
      "Resource": ["acs:oss:*:*:你的bucket/babycare/*"]
    }
  ]
}
```

把策略授权给这个子账号，AK 填进 `server/.env`。

### 8.3 验证备份

服务里有两种触发：

- 自动：每天 03:30（`BACKUP_HOUR`/`BACKUP_MINUTE` 可改），保留 `BACKUP_KEEP_DAYS`（默认 30）天
- 手动：网页版「设置 → 立即生成云端快照」，或：

```bash
curl -X POST http://127.0.0.1:3000/api \
  -H "Authorization: Bearer <token>" -H 'Content-Type: application/json' \
  -d '{"action":"backup.run","payload":{}}'
```

去 OSS 控制台看 `babycare/2026-11-03/family-fam_xxx-1699....json` 是否存在。

**没配 OSS 时**会写到 `server/data/backups/`，同样可用（记得让这个目录落在有备份的磁盘上）。

---

## 9. 恢复演练（请务必做一次）

### 9.1 单条误删

```bash
node -e "
const {DatabaseSync}=require('node:sqlite');
const db=new DatabaseSync('./server/data/babycare.db');
db.prepare('UPDATE records SET deleted=0, updated_at=? WHERE id=?').run(Date.now(),'r_xxx');
console.log('已恢复');
"
```

改完让客户端刷新（重启 App / 下拉）。

### 9.2 整库丢了 / 数据错乱 → 用快照

```bash
# 先看一眼会恢复多少条
node server/restore.js server/data/backups/2026-11-03/family-fam_xxx-1699.json --dry-run

# 真正恢复（记录按 _id 覆盖，不会重复；家庭组不存在会自动重建）
node server/restore.js server/data/backups/2026-11-03/family-fam_xxx-1699.json
```

从 OSS 恢复就先下载：

```bash
# 用 ossutil（阿里云官方 CLI）或直接在控制台下载
ossutil cp oss://你的bucket/babycare/2026-11-03/family-fam_xxx.json ./
```

恢复后重启服务、客户端重新登录或下拉刷新。

### 9.3 冷备份整个数据库（最保险）

```bash
sudo systemctl stop babycare
cp server/data/babycare.db* /backup/          # 连同 -wal/-shm 一起复制
sudo systemctl start babycare
```

或者不停服做一致性备份（需要 sqlite3 命令行）：

```bash
sqlite3 server/data/babycare.db ".backup '/backup/babycare-$(date +%F).db'"
```

---

## 10. 安全清单

| 项 | 做法 |
| --- | --- |
| HTTPS | 小程序必须；网页版建议（Cloudflare Tunnel 免费给） |
| 口令 | `WEB_PASSCODE` 至少 8 位，别用 123456；登录接口有 10 次/10 分钟限流 |
| token 密钥 | `TOKEN_SECRET` 固定且随机，泄了等于所有人可登录 |
| 数据库文件 | 权限 `600`，只给服务账号读 |
| `.env` | 不入库、不截图、不发群 |
| OSS AK | 用 RAM 子账号 + 前缀级最小权限，绝不使用主账号 AK |
| 防火墙 | 只放行 22/80/443（或 8443），数据库端口不对外 |
| 备份验证 | 每月打开一次 OSS 看快照是否在生成 |

---

## 11. 排错

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 启动报 `Cannot find module 'node:sqlite'` | Node < 22.5 | 升到 24（或 22 + `--experimental-sqlite`） |
| 网页打开是 404 / 空白 | `web/` 没上传 | 确认 `/opt/babycare/web/index.html` 存在 |
| 登录提示"口令不正确" | `.env` 没生效 | 用 `EnvironmentFile` 或确认 cwd 下有 `.env`；改完重启 |
| 登录后立刻又回登录页 | `TOKEN_SECRET` 每次重启都变 | 在 `.env` 里固定它 |
| 小程序报"不在合法域名列表" | 域名没配或没备案 | 见 §7.4 |
| 小程序报 1003 | 域名不是 https 或证书无效 | 用 Caddy 自动证书 |
| 备份没生成 | 时间没到 / OSS AK 错 | 手动 `backup.run` 看返回的错误信息 |
| 数据突然"少了" | 同一微信加入过两个家庭组 | 设置页看邀请码是否一致；旧家庭组数据仍在库中 |
| 服务内存持续上涨 | 版本 bug | `systemctl restart babycare`，并提 issue |

---

## 12. 升级

```bash
cd /opt/babycare
sudo systemctl stop babycare
cp -a server/data /tmp/babycare-data-backup   # 先备份数据
rsync -av --exclude node_modules --exclude 'server/data' ./ user@server:/opt/babycare/
sudo systemctl start babycare
curl http://127.0.0.1:3000/healthz
```

数据库结构变更都是 `CREATE TABLE IF NOT EXISTS`，升级不会清数据；但**升级前备份仍然必须**。

---

## 13. 从云开发迁过来（如果你之前跑过云开发版）

1. 云开发控制台 → 数据库 → `records` → 导出 JSON（JSON Lines）。
2. 转成本项目的快照格式：

```bash
node -e "
const fs=require('fs');
const lines=fs.readFileSync('records.jsonl','utf8').trim().split('\n');
const records=lines.map(l=>JSON.parse(l));
fs.writeFileSync('snapshot.json', JSON.stringify({
  kind:'babycare-snapshot', schemaVersion:1, exportedAt:Date.now(),
  family:{name:'迁移的家庭'}, recordCount:records.length, records
}));
console.log('ok', records.length);
"
```

3. `node server/restore.js snapshot.json`
4. 手机端清一次缓存（设置 → 清空本机缓存），重新登录拉全量。

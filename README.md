# 宝宝作息（睡眠 / 喝奶）

记录婴儿的**睡眠**（起止、时长、每天总时长）和**喝奶**（亲喂 / 瓶喂母乳 / 配方奶）。

**两种形态，同一套后端、同一个数据库：**

| 形态 | 成本 | 需要什么 | 什么时候能用 |
| --- | --- | --- | --- |
| **网页版（PWA）** — 微信里打开链接 | **¥0** | 只需要你的服务器 | 立刻 |
| **微信小程序** | ≈ ¥1/月（域名） | 已备案域名（小程序硬性要求） | 备案后（2–3 周） |

> 关键约束：微信小程序只能调用**已 ICP 备案**的 HTTPS 域名（不支持 IP 地址；端口支持，但需在后台精确配置）。所以"自己的服务器 + 没备案"时，小程序连不上服务器——这是平台规则，绕不过去。
> 详见 [自建部署手册](docs/SELF-HOST.md) 的路线对比。

## 特点

- **零依赖后端**：只用 Node 内置模块（`node:http` / `node:sqlite` / `node:crypto`），**不需要 `npm install`**。
- **零成本运行**：SQLite 单文件 + 阿里云 OSS 每日快照，一年数据约 3 MB。
- **抱娃单手可用**：`开始睡觉` → `醒了`，`亲喂·左` → `结束`，两下记完；支持夜间模式。
- **离线可用**（小程序端）：断网也能记，联网自动补传；网页版在线使用。
- **家庭共享**：邀请码 6 位，多人看同一份数据。
- **数据不丢**：数据库 + 每日 OSS 快照(30 天) + CSV 导出 + 恢复脚本。

## 快速开始

### 网页版（零成本，推荐先跑这个）

```bash
cp server/.env.example server/.env   # 改 TOKEN_SECRET 和 WEB_PASSCODE
node server/index.js                 # 不需要 npm install
```

浏览器打开 `http://127.0.0.1:3000`，输入 `WEB_PASSCODE` 即可用。
要让家人在手机上访问，见 [docs/SELF-HOST.md §6](docs/SELF-HOST.md)（Cloudflare Tunnel 免费拿 HTTPS）。

### 小程序

1. 微信开发者工具导入本仓库根目录，填 AppID
2. 改 [`miniprogram/config.js`](miniprogram/config.js)：`TRANSPORT: 'http'` + `API_BASE: 'https://你的域名'`
3. 公众平台 → 开发设置 → 服务器域名 → 添加该域名（需已备案）
4. 服务端 `.env` 填 `WX_APPID` / `WX_SECRET`（用于 `wx.login` 换 openid）

完整步骤见 [docs/SELF-HOST.md §7](docs/SELF-HOST.md)。

## 测试

```bash
npm test     # 100 项，无需微信环境、无需 npm install
```

| 文件 | 覆盖 | 数量 |
| --- | --- | --- |
| `tests/stats.test.js` | 统计口径：跨天拆分、夜觉边界、进行中记录、时区 | 23 |
| `tests/store.test.js` | 小程序离线写入、断网补传、多设备合并、软删除、分页 | 14 |
| `tests/server.test.js` | 自建后端：真 SQLite + 真 HTTP，家庭隔离、幂等、冲突、导出、备份、恢复 | 36 |
| `tests/api.test.js` | 云开发版云函数（备选后端） | 27 |

网页版 UI 端到端测试（真实 DOM + 真实 HTTP）需要额外装 jsdom，不在 `npm test` 里：

```bash
npm i -D jsdom && npm run test:ui    # 18 项：登录、打卡、喂奶、统计、设置、数据落库
```

## 目录

```
server/                  自建后端（零依赖）
  index.js               HTTP 服务、鉴权、静态文件、定时任务
  handlers.js            业务逻辑（与云函数版规则一致）
  db.js                  SQLite 表结构与访问
  auth.js                签名 token
  oss.js                 阿里云 OSS 上传（手写 V1 签名，零依赖）
  backup.js              每日快照 + 过期清理
  restore.js             从快照恢复（灾难恢复）
  config.js / .env.example
web/                     网页版 PWA（原生 JS，无构建）
miniprogram/             小程序端
  config.js              TRANSPORT 切换 http / cloud
  utils/                 store（离线同步）、stats（统计口径）、api（传输层）…
cloudfunctions/          备选后端：微信云开发版（不推荐，需付费套餐）
tests/                   全部测试
docs/
  ALTERNATIVES.md        低成本方案全景（云开发/云托管/自建/Serverless 全对比）
  SELF-HOST.md           自建部署手册（含备案、OSS、恢复演练、零成本方案）
  DESIGN.md              设计方案：架构、数据模型、统计口径、持久化
  DEPLOY.md              云开发版部署手册（备选）
```

## 数据在哪

| 层 | 位置 | 作用 |
| --- | --- | --- |
| 主存储 | `server/data/babycare.db`（SQLite） | 权威数据 |
| 本机缓存 | 小程序 `wx.setStorageSync` | 离线记录、秒开 |
| 云端快照 | 阿里云 OSS `babycare/YYYY-MM-DD/` | 每天 03:30 自动，保留 30 天 |
| 离机留存 | 设置页导出 CSV | 自己保存一份，可导入 Excel |

删除是**软删除**，误删可在库里改回来；恢复步骤见 [docs/SELF-HOST.md §9](docs/SELF-HOST.md)。

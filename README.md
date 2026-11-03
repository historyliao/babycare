# 宝宝作息（微信小程序）

记录婴儿的**睡眠**（起止时间、时长、每天总时长）和**喝奶**（亲喂 / 瓶喂母乳 / 配方奶）。

- 主打「单手、两秒完成一次打卡」：`开始睡觉` → `醒了`，`亲喂·左` → `结束`，点两下就记完。
- 数据落在**微信云开发**，自己账号下的数据库，不经过第三方服务。
- **离线可用**：没网也能记，联网后自动补传。
- **家庭共享**：爸爸妈妈爷爷奶奶用邀请码进同一个家庭组，看到同一份数据。
- 内置**每日云端快照**与 **CSV 导出**，防丢。

## 快速开始（5 步）

```bash
git clone <this-repo> && cd babycare
```

1. 微信开发者工具 → 导入项目，目录选**本仓库根目录**，AppID 填自己的小程序 AppID。
2. 工具栏「云开发」→ 开通 → 创建环境，复制**环境 ID**，填进 [`miniprogram/config.js`](miniprogram/config.js) 的 `ENV_ID`。
3. 右键 [`cloudfunctions/api`](cloudfunctions/api) → **上传并部署：云端安装依赖**；对 [`cloudfunctions/backup`](cloudfunctions/backup) 同样操作，并「上传触发器」。
4. 云开发控制台 → 数据库 → 四个集合 `users` / `families` / `records` / `backups` 的权限都设为**仅管理端可读写**（集合会在首次调用时自动创建）。
5. 点「编译」。首页出现「开始睡觉」即成功。

完整步骤（含双人共享、备份恢复演练、上线审核）见 [docs/DEPLOY.md](docs/DEPLOY.md)。

## 测试

纯逻辑与云函数都有测试，不需要微信环境：

```bash
npm test          # 依次跑 统计 / 同步引擎 / 云函数 三组测试
```

- `tests/stats.test.js`：统计口径（跨天拆分、夜觉边界、进行中记录、时区）23 例。
- `tests/store.test.js`：离线写入、断网补传、多设备合并、软删除同步、坏数据隔离、分页拉取 14 例，打桩 `wx.storage`。
- `tests/api.test.js`：云函数集成（家庭隔离、幂等、冲突、软删除、导出、备份、分页）27 例，用内存版 `wx-server-sdk` 打桩。

## 目录

```
miniprogram/
  config.js            环境 ID、时区、夜间时段等配置
  pages/
    home/              记录：快捷打卡 + 今日概览 + 24h 时间轴
    records/           明细：按天分组、筛选、进入编辑
    stats/             统计：近 7/30 天，睡眠与喂奶
    settings/          设置：家庭组、同步、导出、快照、夜间模式
    edit/              补录 / 编辑 / 删除
  utils/
    store.js           本地缓存 + 离线同步引擎
    stats.js           统计口径（纯函数，有单测）
    date.js            时区安全的日期工具（纯函数，有单测）
    api.js             云函数调用封装
    view.js            列表/时间轴的展示格式化
    theme.js / id.js   夜间模式、记录 ID
cloudfunctions/
  api/                 单入口业务接口（家庭组、记录 CRUD、导出）
  backup/              每日快照到云存储（定时触发）
tests/                 Node 单测与打桩
docs/
  DESIGN.md            设计方案：架构、数据模型、统计口径、持久化
  DEPLOY.md            部署与运行手册
```

## 文档

- [设计方案](docs/DESIGN.md) — 技术选型、数据模型、统计口径、持久化与容灾、安全、成本、路线图
- [部署与运行](docs/DEPLOY.md) — 从注册 AppID 到上线审核、备份恢复演练、排错

## 数据在哪

| 层 | 位置 | 作用 |
| --- | --- | --- |
| 主存储 | 云开发数据库 `records` 集合 | 权威数据，多设备共享 |
| 本机缓存 | `wx.setStorageSync('bc:store:v1')` | 秒开 + 离线记录，联网自动补传 |
| 云端快照 | 云存储 `backups/YYYY-MM-DD/*.json` | 每天 03:30 自动生成，保留 30 天 |
| 离机留存 | 设置页导出 CSV | 自己保存一份，可导入 Excel |

删除是**软删除**（`deleted: true`），误删可在控制台改回来；详见 DEPLOY 的「恢复演练」。

/**
 * 全局配置
 *
 * 两套后端二选一，改 TRANSPORT 即可，页面代码不用动：
 *   'http'  → 你自己的服务器（推荐：成本最低、数据完全自己掌控）
 *   'cloud' → 微信云开发（备选：不用运维，但要买套餐，约 ¥19.9/月起）
 */
module.exports = {
  // ---------------- 后端选择 ----------------
  TRANSPORT: 'http',

  // http 模式：后端地址。必须是 https，且域名已在微信后台备案配置。
  // 例：'https://baby.example.com'   或  'https://1.2.3.4:8443'
  API_BASE: '',

  // cloud 模式：云开发环境 ID
  ENV_ID: '',

  API_FUNCTION: 'api',
  BACKUP_FUNCTION: 'backup',

  // ---------------- 业务参数 ----------------
  // 统计时区（分钟）。480 = UTC+8。
  TZ_OFFSET_MIN: 480,

  // 夜间时段：[19:00, 次日 07:00)
  NIGHT_START_HOUR: 19,
  NIGHT_END_HOUR: 7,

  MAX_RECORD_BACK_DAYS: 3650,
  MAX_FAMILY_MEMBERS: 10
}

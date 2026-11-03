/**
 * 全局配置
 *
 * ENV_ID 必填：微信开发者工具 → 云开发 → 设置 → 环境 ID。
 * 未填写时小程序会提示"还没连上云端"，本地仍可记录（离线可用）。
 */
module.exports = {
  // 云开发环境 ID，例如 'babycare-7g8h9i0j'
  ENV_ID: '',

  // 云函数名（与 cloudfunctions/ 下目录同名）
  API_FUNCTION: 'api',
  BACKUP_FUNCTION: 'backup',

  // 统计时区（分钟）。480 = UTC+8。中国无夏令时，用固定偏移最稳。
  TZ_OFFSET_MIN: 480,

  // 夜间时段定义：[19:00, 次日 07:00)。用于区分"夜觉"与"白天小睡"。
  NIGHT_START_HOUR: 19,
  NIGHT_END_HOUR: 7,

  // 同一天最多允许结束多少年前的记录（防止误操作把时间设到 1970）
  MAX_RECORD_BACK_DAYS: 3650,

  // 家庭组人数上限（防止邀请码被陌生人滥用）
  MAX_FAMILY_MEMBERS: 10
}

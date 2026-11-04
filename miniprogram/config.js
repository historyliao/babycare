/**
 * 全局配置
 *
 * 当前方案：微信云开发 + 小程序体验版（详见 docs/PLAN.md）
 * 不需要域名、备案、服务器。
 */
module.exports = {
  // 云开发环境 ID（云开发控制台 → 设置 → 环境 ID）
  // 留空则使用账号下的默认环境；多环境时务必显式填写，否则容易连错。
  ENV_ID: '',

  // 云函数名（与 cloudfunctions/ 下目录同名）
  API_FUNCTION: 'api',
  BACKUP_FUNCTION: 'backup',

  // 统计时区（分钟）。480 = UTC+8。中国无夏令时，用固定偏移最稳。
  TZ_OFFSET_MIN: 480,

  // 夜间时段：[19:00, 次日 07:00)，用于区分"夜觉"与"白天小睡"
  NIGHT_START_HOUR: 19,
  NIGHT_END_HOUR: 7,

  // 单条记录最多能回溯多久（防止误操作把时间设到 1970）
  MAX_RECORD_BACK_DAYS: 3650,

  // 家庭组人数上限（防止邀请码被陌生人滥用）
  MAX_FAMILY_MEMBERS: 10
}

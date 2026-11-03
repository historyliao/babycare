/**
 * 时间工具（纯函数，无 wx 依赖，可在 Node 中单测）
 *
 * 约定：
 * - 所有时间戳都是 UTC 毫秒数，只做存储与比较。
 * - 所有"日期"都按固定时区偏移 tzOffsetMin 计算（中国 = 480）。
 *   固定偏移而非 IANA 时区，是因为孩子在国内，且可避免夏令时/历史时区数据带来的漂移。
 */

const MIN_MS = 60 * 1000
const HOUR_MS = 60 * MIN_MS
const DAY_MS = 24 * HOUR_MS

function pad2(n) {
  return n < 10 ? '0' + n : String(n)
}

/** 当天 00:00 的时间戳 */
function startOfDay(ts, tzOffsetMin) {
  const tz = tzOffsetMin || 0
  return Math.floor((ts + tz * MIN_MS) / DAY_MS) * DAY_MS - tz * MIN_MS
}

/** 当天 24:00 的时间戳 */
function endOfDay(ts, tzOffsetMin) {
  return startOfDay(ts, tzOffsetMin) + DAY_MS
}

/** 'YYYY-MM-DD' */
function dayKey(ts, tzOffsetMin) {
  const d = new Date(ts + (tzOffsetMin || 0) * MIN_MS)
  return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate())
}

/** 'YYYY-MM-DD' → 该日 00:00 时间戳 */
function parseDayKey(key, tzOffsetMin) {
  const parts = String(key).split('-')
  const y = Number(parts[0])
  const m = Number(parts[1])
  const d = Number(parts[2])
  if (!y || !m || !d) throw new Error('非法日期：' + key)
  return Date.UTC(y, m - 1, d) - (tzOffsetMin || 0) * MIN_MS
}

/** 日期键加减天数 */
function shiftDayKey(key, days, tzOffsetMin) {
  return dayKey(parseDayKey(key, tzOffsetMin) + days * DAY_MS, tzOffsetMin)
}

/** 两天之间的天数（含首尾则 +1，这里返回差值） */
function diffDays(keyA, keyB, tzOffsetMin) {
  return Math.round((parseDayKey(keyB, tzOffsetMin) - parseDayKey(keyA, tzOffsetMin)) / DAY_MS)
}

/** 当天第几分钟（0-1439） */
function minutesOfDay(ts, tzOffsetMin) {
  const local = ts + (tzOffsetMin || 0) * MIN_MS
  return Math.floor((local % DAY_MS) / MIN_MS)
}

/** 'HH:mm' */
function formatTime(ts, tzOffsetMin) {
  const m = minutesOfDay(ts, tzOffsetMin)
  return pad2(Math.floor(m / 60)) + ':' + pad2(m % 60)
}

/** 'MM-DD HH:mm' */
function formatDateTime(ts, tzOffsetMin) {
  return dayKey(ts, tzOffsetMin).slice(5) + ' ' + formatTime(ts, tzOffsetMin)
}

/** 'HH:mm' → 当天分钟数 */
function parseTimeToMinutes(hhmm) {
  const parts = String(hhmm).split(':')
  return Number(parts[0]) * 60 + Number(parts[1])
}

/** 日期键 + 'HH:mm' → 时间戳 */
function atTime(dayKeyStr, hhmm, tzOffsetMin) {
  return parseDayKey(dayKeyStr, tzOffsetMin) + parseTimeToMinutes(hhmm) * MIN_MS
}

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

function weekdayCN(ts, tzOffsetMin) {
  const d = new Date(ts + (tzOffsetMin || 0) * MIN_MS)
  return WEEKDAYS[d.getUTCDay()]
}

/** '11月3日 周一' */
function dayLabel(key, tzOffsetMin) {
  const ts = parseDayKey(key, tzOffsetMin)
  const d = new Date(ts + (tzOffsetMin || 0) * MIN_MS)
  return (d.getUTCMonth() + 1) + '月' + d.getUTCDate() + '日 ' + WEEKDAYS[d.getUTCDay()]
}

/** '今天' / '昨天' / '11月1日 周六' */
function relativeDayLabel(key, tzOffsetMin, now) {
  const today = dayKey(now || Date.now(), tzOffsetMin)
  const delta = diffDays(key, today, tzOffsetMin)
  if (delta === 0) return '今天'
  if (delta === 1) return '昨天'
  if (delta === 2) return '前天'
  return dayLabel(key, tzOffsetMin)
}

/** 分钟 → '1小时20分' */
function formatDuration(minutes) {
  const m = Math.max(0, Math.round(minutes || 0))
  const h = Math.floor(m / 60)
  const r = m % 60
  if (h <= 0) return r + '分'
  if (r === 0) return h + '小时'
  return h + '小时' + r + '分'
}

/** 分钟 → '1h20m'（图表/紧凑场景） */
function formatDurationShort(minutes) {
  const m = Math.max(0, Math.round(minutes || 0))
  const h = Math.floor(m / 60)
  const r = m % 60
  if (h <= 0) return m + 'm'
  return r === 0 ? h + 'h' : h + 'h' + pad2(r) + 'm'
}

/** 小时（保留一位） */
function toHours(minutes) {
  return Math.round(((minutes || 0) / 60) * 10) / 10
}

module.exports = {
  MIN_MS,
  HOUR_MS,
  DAY_MS,
  pad2,
  startOfDay,
  endOfDay,
  dayKey,
  parseDayKey,
  shiftDayKey,
  diffDays,
  minutesOfDay,
  formatTime,
  formatDateTime,
  parseTimeToMinutes,
  atTime,
  weekdayCN,
  dayLabel,
  relativeDayLabel,
  formatDuration,
  formatDurationShort,
  toHours
}

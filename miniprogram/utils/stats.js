/**
 * 统计口径（纯函数，可在 Node 中单测）
 *
 * 核心决策：每日总睡眠 = "这一天的 00:00-24:00 内实际睡着的分钟数"
 *   即把每条睡眠记录裁剪到当天窗口后累加。理由见 docs/DESIGN.md「统计口径」。
 *   跨天夜觉会被自动拆到两天，例如 22:00→06:00 记为 2h + 6h。
 *   替代口径「按入睡日归属」会把 8h 全记在入睡那天，导致"昨晚"看起来睡很久、
 *   但今天实际只睡了 6h 的错觉，不适合"每天总时长"这一诉求。
 *
 * 喂奶按"开始时间"归属到某一天（一次喂奶不会跨天拆分）。
 */

const dateUtil = require('./date')

const MIN_MS = 60 * 1000
const HOUR_MS = 3600 * 1000
const DAY_MS = 24 * HOUR_MS

function normalizeOpts(o) {
  o = o || {}
  return {
    tzOffsetMin: o.tzOffsetMin == null ? 480 : o.tzOffsetMin,
    nightStartHour: o.nightStartHour == null ? 19 : o.nightStartHour,
    nightEndHour: o.nightEndHour == null ? 7 : o.nightEndHour,
    now: o.now || Date.now()
  }
}

function overlapMs(a1, a2, b1, b2) {
  const s = Math.max(a1, b1)
  const e = Math.min(a2, b2)
  return e > s ? e - s : 0
}

function isLive(r) {
  return r && !r.deleted
}

/** 当前进行中的记录（最新一条） */
function activeRecord(records, type) {
  let best = null
  for (let i = 0; i < records.length; i++) {
    const r = records[i]
    if (!isLive(r) || r.type !== type || r.endAt) continue
    if (!best || r.startAt > best.startAt) best = r
  }
  return best
}

/** 单日汇总 */
function computeDaySummary(records, dayKeyStr, options) {
  const o = normalizeOpts(options)
  const tz = o.tzOffsetMin
  const ds = dateUtil.parseDayKey(dayKeyStr, tz)
  const de = ds + DAY_MS

  // 夜间窗口：当天 00:00-07:00 与 19:00-24:00
  const nightWindows = []
  const nightEndTs = ds + o.nightEndHour * HOUR_MS
  if (nightEndTs > ds) nightWindows.push([ds, Math.min(nightEndTs, de)])
  const nightStartTs = ds + o.nightStartHour * HOUR_MS
  if (nightStartTs < de) nightWindows.push([Math.max(nightStartTs, ds), de])

  let sleepMs = 0
  let nightMs = 0
  let feedCount = 0
  let feedMl = 0
  let breastMs = 0
  let breastCount = 0
  let bottleCount = 0
  const sessions = []
  const feeds = []

  for (let i = 0; i < records.length; i++) {
    const r = records[i]
    if (!isLive(r)) continue

    if (r.type === 'sleep') {
      const s = r.startAt
      // 进行中的睡眠：算到"现在"为止（不越界到未来）
      const e = r.endAt || Math.min(o.now, Number.MAX_SAFE_INTEGER)
      if (!(e > s)) continue
      const from = Math.max(s, ds)
      const to = Math.min(e, de)
      if (!(to > from)) continue

      let nightPart = 0
      for (let w = 0; w < nightWindows.length; w++) {
        nightPart += overlapMs(from, to, nightWindows[w][0], nightWindows[w][1])
      }
      const dur = to - from
      sleepMs += dur
      nightMs += nightPart

      sessions.push({
        id: r._id,
        startAt: s,
        endAt: r.endAt || null,
        ongoing: !r.endAt,
        minutes: Math.round(dur / MIN_MS),
        fromMin: Math.round((from - ds) / MIN_MS),
        toMin: Math.round((to - ds) / MIN_MS),
        isNight: nightPart * 2 >= dur,
        startText: dateUtil.formatTime(s, tz),
        endText: r.endAt ? dateUtil.formatTime(r.endAt, tz) : '',
        durationText: dateUtil.formatDuration(dur / MIN_MS)
      })
    } else if (r.type === 'feed') {
      // 按开始时间归属
      if (!(r.startAt >= ds && r.startAt < de)) continue
      feedCount++
      const e = r.endAt || o.now
      const dur = Math.max(0, Math.min(e, de) - Math.max(r.startAt, ds))

      if (r.feedKind === 'breast') {
        breastCount++
        breastMs += dur
      } else {
        bottleCount++
        if (r.amountMl) feedMl += r.amountMl
      }

      feeds.push({
        id: r._id,
        startAt: r.startAt,
        endAt: r.endAt || null,
        ongoing: !r.endAt,
        feedKind: r.feedKind || 'breast',
        side: r.side || null,
        amountMl: r.amountMl || 0,
        minutes: Math.round(dur / MIN_MS),
        fromMin: Math.round((Math.max(r.startAt, ds) - ds) / MIN_MS),
        toMin: Math.round((Math.min(e, de) - ds) / MIN_MS),
        startText: dateUtil.formatTime(r.startAt, tz)
      })
    }
  }

  sessions.sort(function (a, b) { return a.startAt - b.startAt })
  feeds.sort(function (a, b) { return a.startAt - b.startAt })

  let napMs = sleepMs - nightMs
  if (napMs < 0) napMs = 0

  const napCount = sessions.filter(function (s) { return !s.isNight }).length
  const nightCount = sessions.length - napCount
  const longest = sessions.reduce(function (m, s) { return Math.max(m, s.minutes) }, 0)

  return {
    dayKey: dayKeyStr,
    dayLabel: dateUtil.dayLabel(dayKeyStr, tz),
    sleepMin: Math.round(sleepMs / MIN_MS),
    nightMin: Math.round(nightMs / MIN_MS),
    napMin: Math.round(napMs / MIN_MS),
    sleepCount: sessions.length,
    napCount: napCount,
    nightCount: nightCount,
    longestSleepMin: longest,
    feedCount: feedCount,
    feedMl: feedMl,
    breastCount: breastCount,
    bottleCount: bottleCount,
    breastMin: Math.round(breastMs / MIN_MS),
    sessions: sessions,
    feeds: feeds,
    // 便于视图直接绑定
    sleepText: dateUtil.formatDuration(sleepMs / MIN_MS),
    nightText: dateUtil.formatDuration(nightMs / MIN_MS),
    napText: dateUtil.formatDuration(napMs / MIN_MS),
    feedText: feedCount + '次',
    mlText: feedMl ? feedMl + 'ml' : ''
  }
}

/** 区间汇总（含每一天） */
function computeRange(records, fromKey, toKey, options) {
  const o = normalizeOpts(options)
  const days = []
  let key = fromKey
  let guard = 0
  while (dateUtil.diffDays(key, toKey, o.tzOffsetMin) >= 0 && guard < 800) {
    days.push(computeDaySummary(records, key, o))
    key = dateUtil.shiftDayKey(key, 1, o.tzOffsetMin)
    guard++
  }

  const totals = {
    sleepMin: 0, nightMin: 0, napMin: 0, feedCount: 0, feedMl: 0,
    breastCount: 0, bottleCount: 0, breastMin: 0, sleepCount: 0, napCount: 0
  }
  days.forEach(function (d) {
    totals.sleepMin += d.sleepMin
    totals.nightMin += d.nightMin
    totals.napMin += d.napMin
    totals.feedCount += d.feedCount
    totals.feedMl += d.feedMl
    totals.breastCount += d.breastCount
    totals.bottleCount += d.bottleCount
    totals.breastMin += d.breastMin
    totals.sleepCount += d.sleepCount
    totals.napCount += d.napCount
  })

  const n = days.length || 1
  const maxSleep = days.reduce(function (m, d) { return Math.max(m, d.sleepMin) }, 0)
  const maxFeed = days.reduce(function (m, d) { return Math.max(m, d.feedCount) }, 0)

  return {
    fromKey: fromKey,
    toKey: toKey,
    days: days,
    totals: totals,
    avgSleepMin: Math.round(totals.sleepMin / n),
    avgFeedCount: Math.round((totals.feedCount / n) * 10) / 10,
    avgFeedMl: Math.round(totals.feedMl / n),
    maxSleepMin: maxSleep,
    maxFeedCount: maxFeed
  }
}

/** 给定时刻之前最近一次喂奶 */
function lastFeedBefore(records, ts) {
  let best = null
  for (let i = 0; i < records.length; i++) {
    const r = records[i]
    if (!isLive(r) || r.type !== 'feed') continue
    if (r.startAt > ts) continue
    if (!best || r.startAt > best.startAt) best = r
  }
  return best
}

/** 给定时刻之前最近一次睡眠结束 */
function lastWakeBefore(records, ts) {
  let best = null
  for (let i = 0; i < records.length; i++) {
    const r = records[i]
    if (!isLive(r) || r.type !== 'sleep' || !r.endAt) continue
    if (r.endAt > ts) continue
    if (!best || r.endAt > best.endAt) best = r
  }
  return best
}

module.exports = {
  computeDaySummary,
  computeRange,
  activeRecord,
  lastFeedBefore,
  lastWakeBefore,
  overlapMs
}

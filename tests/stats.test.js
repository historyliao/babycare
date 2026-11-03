/**
 * 纯逻辑单测（不需要微信环境）
 * 运行：node tests/stats.test.js
 */
const assert = require('assert')

const date = require('../miniprogram/utils/date')
const stats = require('../miniprogram/utils/stats')

const TZ = 480
const OPTS = { tzOffsetMin: TZ, nightStartHour: 19, nightEndHour: 7 }

let passed = 0
let failed = 0

function test(name, fn) {
  try {
    fn()
    passed++
    console.log('  PASS  ' + name)
  } catch (e) {
    failed++
    console.log('  FAIL  ' + name)
    console.log('        ' + e.message)
  }
}

function at(dayStr, hhmm) {
  return date.atTime(dayStr, hhmm, TZ)
}

function sleepRec(id, s, e) {
  return { _id: id, type: 'sleep', startAt: s, endAt: e, deleted: false }
}

function feedRec(id, s, e, extra) {
  return Object.assign({ _id: id, type: 'feed', startAt: s, endAt: e, deleted: false }, extra || {})
}

/* ============ 日期工具 ============ */

console.log('\n[date]')

test('dayKey / parseDayKey 往返一致', function () {
  const key = '2026-03-01'
  assert.strictEqual(date.dayKey(date.parseDayKey(key, TZ), TZ), key)
})

test('跨月加一天', function () {
  assert.strictEqual(date.shiftDayKey('2026-02-28', 1, TZ), '2026-03-01')
  assert.strictEqual(date.shiftDayKey('2026-03-01', -1, TZ), '2026-02-28')
})

test('跨年加一天', function () {
  assert.strictEqual(date.shiftDayKey('2026-12-31', 1, TZ), '2027-01-01')
})

test('atTime 得到当天正确时刻', function () {
  const ts = at('2026-11-03', '00:00')
  assert.strictEqual(date.dayKey(ts, TZ), '2026-11-03')
  assert.strictEqual(date.formatTime(ts, TZ), '00:00')
})

test('时长格式化', function () {
  assert.strictEqual(date.formatDuration(0), '0分')
  assert.strictEqual(date.formatDuration(45), '45分')
  assert.strictEqual(date.formatDuration(60), '1小时')
  assert.strictEqual(date.formatDuration(80), '1小时20分')
  assert.strictEqual(date.formatDurationShort(80), '1h20m')
})

test('时区不影响 UTC 存储', function () {
  const ts = at('2026-11-03', '08:00')
  assert.strictEqual(new Date(ts).toISOString(), '2026-11-03T00:00:00.000Z')
})

/* ============ 单日汇总 ============ */

console.log('\n[day summary]')

test('空数据返回 0', function () {
  const d = stats.computeDaySummary([], '2026-11-03', OPTS)
  assert.strictEqual(d.sleepMin, 0)
  assert.strictEqual(d.feedCount, 0)
  assert.strictEqual(d.napCount, 0)
  assert.strictEqual(d.sessions.length, 0)
})

test('白天小睡 10:00-11:30 → 90 分钟小睡', function () {
  const recs = [sleepRec('s1', at('2026-11-03', '10:00'), at('2026-11-03', '11:30'))]
  const d = stats.computeDaySummary(recs, '2026-11-03', OPTS)
  assert.strictEqual(d.sleepMin, 90)
  assert.strictEqual(d.nightMin, 0)
  assert.strictEqual(d.napMin, 90)
  assert.strictEqual(d.napCount, 1)
  assert.strictEqual(d.sleepText, '1小时30分')
})

test('跨天夜觉 22:00→次日06:00 拆分到两天', function () {
  const s = at('2026-11-02', '22:00')
  const e = at('2026-11-03', '06:00')
  const recs = [sleepRec('s1', s, e)]

  const d1 = stats.computeDaySummary(recs, '2026-11-02', OPTS)
  const d2 = stats.computeDaySummary(recs, '2026-11-03', OPTS)

  assert.strictEqual(d1.sleepMin, 120, '11-02 只算 22:00-24:00')
  assert.strictEqual(d2.sleepMin, 360, '11-03 只算 00:00-06:00')
  assert.strictEqual(d1.nightMin, 120)
  assert.strictEqual(d2.nightMin, 360)
  assert.strictEqual(d1.sleepMin + d2.sleepMin, 480, '总时长守恒')
})

test('跨天夜觉 23:00→次日01:00 各 60 分钟', function () {
  const recs = [sleepRec('s1', at('2026-11-02', '23:00'), at('2026-11-03', '01:00'))]
  assert.strictEqual(stats.computeDaySummary(recs, '2026-11-02', OPTS).sleepMin, 60)
  assert.strictEqual(stats.computeDaySummary(recs, '2026-11-03', OPTS).sleepMin, 60)
})

test('跨天夜觉继续到上午 09:00：夜觉只算到 07:00', function () {
  const recs = [sleepRec('s1', at('2026-11-02', '20:00'), at('2026-11-03', '09:00'))]
  const d2 = stats.computeDaySummary(recs, '2026-11-03', OPTS)
  assert.strictEqual(d2.sleepMin, 540, '00:00-09:00')
  assert.strictEqual(d2.nightMin, 420, '00:00-07:00')
  assert.strictEqual(d2.napMin, 120, '07:00-09:00 算小睡')
})

test('18:00-19:30 跨夜间边界：30 夜觉 + 60 小睡', function () {
  const recs = [sleepRec('s1', at('2026-11-03', '18:00'), at('2026-11-03', '19:30'))]
  const d = stats.computeDaySummary(recs, '2026-11-03', OPTS)
  assert.strictEqual(d.sleepMin, 90)
  assert.strictEqual(d.nightMin, 30)
  assert.strictEqual(d.napMin, 60)
})

test('进行中的睡眠按 now 截断', function () {
  const now = at('2026-11-03', '12:45')
  const recs = [sleepRec('s1', at('2026-11-03', '12:00'), null)]
  const d = stats.computeDaySummary(recs, '2026-11-03', Object.assign({}, OPTS, { now: now }))
  assert.strictEqual(d.sleepMin, 45)
  assert.strictEqual(d.sessions[0].ongoing, true)
})

test('进行中的睡眠不越过当天 24:00', function () {
  const now = at('2026-11-04', '02:00')
  const recs = [sleepRec('s1', at('2026-11-03', '23:00'), null)]
  const d = stats.computeDaySummary(recs, '2026-11-03', Object.assign({}, OPTS, { now: now }))
  assert.strictEqual(d.sleepMin, 60, '只算到 24:00')
})

test('已删除记录不计入', function () {
  const rec = sleepRec('s1', at('2026-11-03', '10:00'), at('2026-11-03', '11:00'))
  rec.deleted = true
  const d = stats.computeDaySummary([rec], '2026-11-03', OPTS)
  assert.strictEqual(d.sleepMin, 0)
})

test('喂奶按开始时间归属日，不跨天拆分', function () {
  const rec = feedRec('f1', at('2026-11-03', '23:50'), at('2026-11-03', '23:59'), {
    feedKind: 'bottle_breast', amountMl: 120
  })
  const d1 = stats.computeDaySummary([rec], '2026-11-03', OPTS)
  const d2 = stats.computeDaySummary([rec], '2026-11-04', OPTS)
  assert.strictEqual(d1.feedCount, 1)
  assert.strictEqual(d1.feedMl, 120)
  assert.strictEqual(d2.feedCount, 0)
})

test('奶量只统计瓶喂，亲喂统计时长', function () {
  const recs = [
    feedRec('f1', at('2026-11-03', '08:00'), at('2026-11-03', '08:20'), { feedKind: 'breast', side: 'left' }),
    feedRec('f2', at('2026-11-03', '12:00'), at('2026-11-03', '12:10'), { feedKind: 'formula', amountMl: 90 })
  ]
  const d = stats.computeDaySummary(recs, '2026-11-03', OPTS)
  assert.strictEqual(d.feedCount, 2)
  assert.strictEqual(d.breastCount, 1)
  assert.strictEqual(d.bottleCount, 1)
  assert.strictEqual(d.breastMin, 20)
  assert.strictEqual(d.feedMl, 90)
})

test('24:00 整点开始的记录归下一天', function () {
  const rec = sleepRec('s1', at('2026-11-03', '23:30'), at('2026-11-04', '00:00'))
  const d = stats.computeDaySummary([rec], '2026-11-03', OPTS)
  const d2 = stats.computeDaySummary([rec], '2026-11-04', OPTS)
  assert.strictEqual(d.sleepMin, 30)
  assert.strictEqual(d2.sleepMin, 0)
})

test('时间轴区块百分比换算', function () {
  const recs = [sleepRec('s1', at('2026-11-03', '12:00'), at('2026-11-03', '18:00'))]
  const d = stats.computeDaySummary(recs, '2026-11-03', OPTS)
  assert.strictEqual(d.sessions[0].fromMin, 720)
  assert.strictEqual(d.sessions[0].toMin, 1080)
})

/* ============ 区间汇总 ============ */

console.log('\n[range summary]')

test('7 天区间包含 7 个自然日', function () {
  const res = stats.computeRange([], '2026-10-28', '2026-11-03', OPTS)
  assert.strictEqual(res.days.length, 7)
  assert.strictEqual(res.days[0].dayKey, '2026-10-28')
  assert.strictEqual(res.days[6].dayKey, '2026-11-03')
})

test('日均睡眠 = 总睡眠 / 天数', function () {
  const recs = [
    sleepRec('s1', at('2026-11-01', '10:00'), at('2026-11-01', '12:00')),
    sleepRec('s2', at('2026-11-02', '10:00'), at('2026-11-02', '11:00'))
  ]
  const res = stats.computeRange(recs, '2026-11-01', '2026-11-02', OPTS)
  assert.strictEqual(res.totals.sleepMin, 180)
  assert.strictEqual(res.avgSleepMin, 90)
  assert.strictEqual(res.maxSleepMin, 120)
})

test('最近一次喂奶 / 醒来', function () {
  const recs = [
    feedRec('f1', at('2026-11-03', '08:00'), at('2026-11-03', '08:20'), { feedKind: 'breast' }),
    feedRec('f2', at('2026-11-03', '11:00'), at('2026-11-03', '11:10'), { feedKind: 'formula', amountMl: 100 }),
    sleepRec('s1', at('2026-11-03', '09:00'), at('2026-11-03', '10:00'))
  ]
  const now = at('2026-11-03', '12:00')
  assert.strictEqual(stats.lastFeedBefore(recs, now)._id, 'f2')
  assert.strictEqual(stats.lastWakeBefore(recs, now)._id, 's1')
})

test('进行中记录识别取最新一条', function () {
  const recs = [
    sleepRec('s1', at('2026-11-03', '09:00'), null),
    sleepRec('s2', at('2026-11-03', '10:00'), null)
  ]
  assert.strictEqual(stats.activeRecord(recs, 'sleep')._id, 's2')
})

console.log('\n结果：' + passed + ' 通过，' + failed + ' 失败\n')
process.exit(failed ? 1 : 0)

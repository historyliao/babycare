const config = require('../../config')
const store = require('../../utils/store')
const themeUtil = require('../../utils/theme')
const dateUtil = require('../../utils/date')
const stats = require('../../utils/stats')

const TZ = config.TZ_OFFSET_MIN
const OPTS = {
  tzOffsetMin: TZ,
  nightStartHour: config.NIGHT_START_HOUR,
  nightEndHour: config.NIGHT_END_HOUR
}

Page({
  data: {
    theme: 'light',
    range: 7,
    tab: 'sleep',
    days: [],
    summary: {
      avgSleep: '0分', nightAvg: '0分', avgFeed: 0, avgMl: 0,
      totalSleep: '0分', totalFeed: 0
    }
  },

  onShow() {
    themeUtil.sync(this)
    this.render()
  },

  onPullDownRefresh() {
    this.render()
    wx.stopPullDownRefresh()
  },

  setRange(e) {
    const r = Number(e.currentTarget.dataset.r)
    if (r === this.data.range) return
    this.setData({ range: r })
    this.render()
  },

  setTab(e) {
    const t = e.currentTarget.dataset.t
    if (t === this.data.tab) return
    this.setData({ tab: t })
    this.render()
  },

  render() {
    const now = Date.now()
    const toKey = dateUtil.dayKey(now, TZ)
    const fromKey = dateUtil.shiftDayKey(toKey, -(this.data.range - 1), TZ)
    const res = stats.computeRange(store.all(), fromKey, toKey, Object.assign({}, OPTS, { now }))

    const maxSleep = Math.max(60, res.maxSleepMin)
    const maxFeed = Math.max(1, res.maxFeedCount)

    const days = res.days.map(function (d) {
      return {
        key: d.dayKey,
        label: d.dayKey.slice(5).replace('-', '/'),
        weekday: dateUtil.weekdayCN(dateUtil.parseDayKey(d.dayKey, TZ), TZ),
        sleepText: dateUtil.formatDurationShort(d.sleepMin),
        sleepPct: Math.max(2, Math.round((d.sleepMin / maxSleep) * 100)) + '%',
        sleepSub: '小睡 ' + d.napCount + ' 次',
        feedText: d.feedCount + '次',
        feedPct: Math.max(2, Math.round((d.feedCount / maxFeed) * 100)) + '%',
        feedSub: d.feedMl ? d.feedMl + 'ml' : '—',
        isToday: d.dayKey === toKey
      }
    })

    const n = res.days.length || 1

    this.setData({
      days: days,
      summary: {
        avgSleep: dateUtil.formatDuration(res.avgSleepMin),
        nightAvg: dateUtil.formatDuration(res.totals.nightMin / n),
        avgFeed: res.avgFeedCount,
        avgMl: res.avgFeedMl,
        totalSleep: dateUtil.formatDuration(res.totals.sleepMin),
        totalFeed: res.totals.feedCount
      }
    })
  }
})

const config = require('../../config')
const store = require('../../utils/store')
const themeUtil = require('../../utils/theme')
const dateUtil = require('../../utils/date')
const stats = require('../../utils/stats')
const view = require('../../utils/view')

const TZ = config.TZ_OFFSET_MIN
const OPTS = {
  tzOffsetMin: TZ,
  nightStartHour: config.NIGHT_START_HOUR,
  nightEndHour: config.NIGHT_END_HOUR
}

Page({
  data: {
    theme: 'light',
    filter: 'all',
    groups: [],
    total: 0
  },

  onShow() {
    themeUtil.sync(this)
    this.render()
  },

  onPullDownRefresh() {
    this.render()
    wx.stopPullDownRefresh()
  },

  setFilter(e) {
    const f = e.currentTarget.dataset.f
    if (f === this.data.filter) return
    this.setData({ filter: f })
    this.render()
  },

  render() {
    const all = store.all()
    const live = all.filter(function (r) { return !r.deleted })
    const filter = this.data.filter
    const filtered = filter === 'all' ? live : live.filter(function (r) { return r.type === filter })

    const byDay = {}
    filtered.forEach(function (r) {
      const k = dateUtil.dayKey(r.startAt, TZ)
      if (!byDay[k]) byDay[k] = []
      byDay[k].push(r)
    })

    const keys = Object.keys(byDay).sort().reverse()
    const groups = keys.map(function (k) {
      const sum = stats.computeDaySummary(all, k, OPTS)
      const items = byDay[k]
        .sort(function (a, b) { return b.startAt - a.startAt })
        .map(view.describeRecord)
      const meta = '睡眠 ' + sum.sleepText + (sum.feedCount ? ' · 喂奶 ' + sum.feedCount + ' 次' : '')
      return {
        key: k,
        label: dateUtil.relativeDayLabel(k, TZ),
        meta: meta,
        items: items
      }
    })

    this.setData({ groups: groups, total: filtered.length })
  },

  open(e) {
    wx.navigateTo({ url: '/pages/edit/index?mode=edit&id=' + e.currentTarget.dataset.id })
  },

  add() {
    wx.navigateTo({ url: '/pages/edit/index?mode=create' })
  }
})

const config = require('../../config')
const api = require('../../utils/api')
const store = require('../../utils/store')
const themeUtil = require('../../utils/theme')
const dateUtil = require('../../utils/date')
const stats = require('../../utils/stats')
const idUtil = require('../../utils/id')
const view = require('../../utils/view')

const TZ = config.TZ_OFFSET_MIN
const STAT_OPTS = {
  tzOffsetMin: TZ,
  nightStartHour: config.NIGHT_START_HOUR,
  nightEndHour: config.NIGHT_END_HOUR
}

Page({
  data: {
    theme: 'light',
    ready: false,
    error: '',
    offline: false,
    syncing: false,
    pending: 0,
    dateLabel: '',
    familyName: '',
    summary: { sleepText: '0分', nightText: '0分', napCount: 0, feedText: '0次', mlText: '' },
    sleepCard: { active: false, headline: '0分', sub: '', btnText: '开始睡觉' },
    feedCard: { active: false, sub: '', headline: '', nextSideText: '右侧' },
    timeline: { sleep: [], feed: [] },
    axis: ['00:00', '06:00', '12:00', '18:00', '24:00'],
    recent: []
  },

  onLoad() {
    this._booted = false
    this._timer = null
    this.render()
  },

  onShow() {
    themeUtil.sync(this)
    this.render()
    this.startTimer()
    this.ensureFamily()
  },

  onHide() {
    this.stopTimer()
  },

  onUnload() {
    this.stopTimer()
  },

  onPullDownRefresh() {
    const self = this
    this.syncNow().catch(function () {}).then(function () {
      wx.stopPullDownRefresh()
    })
  },

  startTimer() {
    const self = this
    this.stopTimer()
    this._timer = setInterval(function () {
      self.render()
    }, 30000)
  },

  stopTimer() {
    if (this._timer) {
      clearInterval(this._timer)
      this._timer = null
    }
  },

  /* ---------------- 数据 → 视图 ---------------- */

  render() {
    const now = Date.now()
    const todayKey = dateUtil.dayKey(now, TZ)
    const records = store.all()
    const summary = stats.computeDaySummary(records, todayKey, Object.assign({}, STAT_OPTS, { now }))
    const activeSleep = stats.activeRecord(records, 'sleep')
    const activeFeed = stats.activeRecord(records, 'feed')
    const lastWake = stats.lastWakeBefore(records, now)
    const lastFeed = stats.lastFeedBefore(records, now)
    const fam = store.family()

    let sleepCard
    if (activeSleep) {
      sleepCard = {
        active: true,
        headline: '已睡 ' + dateUtil.formatDuration((now - activeSleep.startAt) / 60000),
        sub: '入睡于 ' + dateUtil.formatTime(activeSleep.startAt, TZ),
        btnText: '醒了'
      }
    } else {
      sleepCard = {
        active: false,
        headline: dateUtil.formatDuration(summary.sleepMin),
        sub: lastWake
          ? '上次醒来 ' + dateUtil.formatTime(lastWake.endAt, TZ) + ' · 已醒 ' + dateUtil.formatDuration((now - lastWake.endAt) / 60000)
          : '今天还没有睡眠记录',
        btnText: '开始睡觉'
      }
    }

    let feedCard
    if (activeFeed) {
      feedCard = {
        active: true,
        headline: '已喂 ' + dateUtil.formatDuration((now - activeFeed.startAt) / 60000),
        sub: (view.KIND_LABEL[activeFeed.feedKind] || '喂奶') +
          (activeFeed.side ? ' · ' + view.SIDE_LABEL[activeFeed.side] : '') +
          ' · ' + dateUtil.formatTime(activeFeed.startAt, TZ) + ' 开始',
        nextSideText: activeFeed.side === 'left' ? '右侧' : '左侧'
      }
    } else {
      const parts = ['今日 ' + summary.feedCount + ' 次']
      if (summary.feedMl) parts.push(summary.feedMl + 'ml')
      feedCard = {
        active: false,
        headline: lastFeed ? '距上次喂奶 ' + dateUtil.formatDuration((now - lastFeed.startAt) / 60000) : '',
        sub: parts.join(' · '),
        nextSideText: '右侧'
      }
    }

    const timelineSleep = summary.sessions.map(function (s) {
      const st = view.blockStyle(s.fromMin, s.toMin)
      return { id: s.id, left: st.left, width: st.width, ongoing: s.ongoing }
    })
    const timelineFeed = summary.feeds.map(function (f) {
      const st = view.blockStyle(f.fromMin, Math.max(f.toMin, f.fromMin))
      return { id: f.id, left: st.left, width: st.width, ongoing: f.ongoing }
    })

    const recent = store.list().slice(0, 6).map(view.describeRecord)

    this.setData({
      dateLabel: dateUtil.dayLabel(todayKey, TZ),
      familyName: (fam && fam.name) || '我的家庭',
      summary: summary,
      sleepCard: sleepCard,
      feedCard: feedCard,
      timeline: { sleep: timelineSleep, feed: timelineFeed },
      recent: recent,
      pending: store.pendingCount()
    })
  },

  /* ---------------- 连接与同步 ---------------- */

  ensureFamily() {
    const self = this
    if (self._booted) {
      self.syncNow().catch(function () {})
      return
    }
    api.call('family.bootstrap', {}).then(function (data) {
      store.setFamily(data.family)
      self._booted = true
      self.setData({ ready: true, error: '' })
      self.render()
      return self.syncNow()
    }).catch(function (err) {
      const fam = store.family()
      if (fam) {
        self._booted = true
        self.setData({ ready: true, error: '', offline: err.code === 'NETWORK' })
        self.render()
      } else {
        self.setData({ ready: false, error: err.message || '初始化失败' })
      }
    })
  },

  retryBootstrap() {
    this._booted = false
    this.setData({ error: '' })
    this.ensureFamily()
  },

  syncNow() {
    const self = this
    if (store.isSyncing()) return Promise.resolve()
    self.setData({ syncing: true })
    return store.sync(api).then(function (res) {
      self.setData({ syncing: false, offline: false, pending: store.pendingCount() })
      self.render()
      self.warnFailedOnce()
      return res
    }).catch(function (err) {
      self.setData({
        syncing: false,
        offline: err.code === 'NETWORK',
        pending: store.pendingCount()
      })
      self.render()
      throw err
    })
  },

  /** 有记录被服务端拒绝时提醒一次，避免用户以为都同步好了 */
  warnFailedOnce() {
    if (this._warnedFailed) return
    const n = store.failedCount()
    if (!n) return
    this._warnedFailed = true
    wx.showToast({ title: '有 ' + n + ' 条记录未同步，请到明细里检查', icon: 'none' })
  },

  /**
   * 写完立刻尝试上传；冲突（另一台设备正在计时）时自动收口，不打扰用户。
   */
  flush(retry) {
    const self = this
    return self.syncNow().catch(function (err) {
      if (retry !== false && err.code === 'ACTIVE_EXISTS' && err.data && err.data.activeId && err.data.recordId) {
        const active = store.get(err.data.activeId)
        const incoming = store.get(err.data.recordId)
        if (active && incoming && incoming.startAt > active.startAt) {
          store.patch(active._id, { endAt: incoming.startAt })
          self.render()
          return self.flush(false)
        }
      }
      if (err.code !== 'NETWORK') {
        wx.showToast({ title: err.message || '同步失败', icon: 'none' })
      }
      return null
    })
  },

  /* ---------------- 写操作 ---------------- */

  createRecord(fields) {
    const now = Date.now()
    const rec = Object.assign({
      _id: idUtil.genId('r'),
      type: 'sleep',
      startAt: now,
      endAt: null,
      feedKind: null,
      side: null,
      amountMl: null,
      note: '',
      deleted: false,
      createdAt: now
    }, fields)
    store.put(rec)
    this.render()
    this.flush()
    return rec
  },

  startSleep() {
    if (this.data.sleepCard.active) return
    this.createRecord({ type: 'sleep', startAt: Date.now(), endAt: null })
    this.buzz()
    wx.showToast({ title: '开始记录睡眠', icon: 'none' })
  },

  endSleep() {
    const active = stats.activeRecord(store.all(), 'sleep')
    if (!active) return
    store.patch(active._id, { endAt: Date.now() })
    this.render()
    this.flush()
    this.buzz()
    wx.showToast({ title: '已记录醒来', icon: 'none' })
  },

  startBreast(e) {
    if (this.data.feedCard.active) return
    const side = (e && e.currentTarget && e.currentTarget.dataset.side) || 'left'
    this.createRecord({ type: 'feed', feedKind: 'breast', side: side, startAt: Date.now(), endAt: null })
    this.buzz()
    wx.showToast({ title: '开始亲喂·' + (view.SIDE_LABEL[side] || ''), icon: 'none' })
  },

  startBreastLeft() {
    this.startBreast({ currentTarget: { dataset: { side: 'left' } } })
  },

  startBreastRight() {
    this.startBreast({ currentTarget: { dataset: { side: 'right' } } })
  },

  endFeed() {
    const active = stats.activeRecord(store.all(), 'feed')
    if (!active) return
    store.patch(active._id, { endAt: Date.now() })
    this.render()
    this.flush()
    this.buzz()
    wx.showToast({ title: '已记录喂奶', icon: 'none' })
  },

  /** 换边：结束当前侧 + 新开另一侧，保证每侧时长准确 */
  switchSide() {
    const active = stats.activeRecord(store.all(), 'feed')
    if (!active) return
    const now = Date.now()
    const nextSide = active.side === 'left' ? 'right' : 'left'
    store.patch(active._id, { endAt: now })
    this.createRecord({ type: 'feed', feedKind: 'breast', side: nextSide, startAt: now, endAt: null })
    this.buzz()
    wx.showToast({ title: '已换到' + view.SIDE_LABEL[nextSide], icon: 'none' })
  },

  bottle() {
    const self = this
    wx.showActionSheet({
      itemList: ['瓶喂母乳', '配方奶'],
      success: function (res) {
        const kind = res.tapIndex === 0 ? 'bottle_breast' : 'formula'
        self.promptAmount(kind)
      }
    })
  },

  promptAmount(kind) {
    const self = this
    wx.showModal({
      title: kind === 'formula' ? '配方奶 ml' : '瓶喂母乳 ml',
      editable: true,
      placeholderText: '例如 120',
      success: function (res) {
        if (!res.confirm) return
        const ml = parseInt(res.content, 10)
        if (!(ml > 0 && ml <= 1000)) {
          wx.showToast({ title: '请输入 1-1000 的奶量', icon: 'none' })
          return
        }
        const now = Date.now()
        self.createRecord({
          type: 'feed',
          feedKind: kind,
          amountMl: ml,
          startAt: now,
          endAt: now
        })
        wx.showToast({ title: '已记录 ' + ml + 'ml', icon: 'none' })
      }
    })
  },

  buzz() {
    try {
      wx.vibrateShort({ type: 'light' })
    } catch (e) {}
  },

  /* ---------------- 跳转 ---------------- */

  manualAdd() {
    wx.navigateTo({ url: '/pages/edit/index?mode=create' })
  },

  openRecord(e) {
    const id = e.currentTarget.dataset.id
    wx.navigateTo({ url: '/pages/edit/index?mode=edit&id=' + id })
  }
})

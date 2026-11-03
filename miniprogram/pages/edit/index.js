const config = require('../../config')
const api = require('../../utils/api')
const store = require('../../utils/store')
const themeUtil = require('../../utils/theme')
const dateUtil = require('../../utils/date')
const idUtil = require('../../utils/id')

const TZ = config.TZ_OFFSET_MIN
const KIND_KEYS = ['breast', 'bottle_breast', 'formula']
const KIND_NAMES = ['亲喂', '瓶喂母乳', '配方奶']
const SIDE_KEYS = ['left', 'right', 'both']
const SIDE_NAMES = ['左侧', '右侧', '双侧']
const DAY_MS = 86400000

function toast(title) {
  wx.showToast({ title: title, icon: 'none' })
}

Page({
  data: {
    theme: 'light',
    mode: 'create',
    id: '',
    type: 'sleep',
    isBreast: true,
    showEnd: true,
    ongoing: false,
    startDate: '',
    startTime: '',
    endDate: '',
    endTime: '',
    kindIndex: 0,
    kindNames: KIND_NAMES,
    sideIndex: 0,
    sideNames: SIDE_NAMES,
    amountMl: '',
    note: '',
    canDelete: false
  },

  onLoad(options) {
    const now = Date.now()
    const todayKey = dateUtil.dayKey(now, TZ)

    if (options && options.mode === 'edit' && options.id) {
      const r = store.get(options.id)
      if (!r) {
        toast('记录不存在')
        wx.navigateBack()
        return
      }
      this.setData({
        mode: 'edit',
        id: r._id,
        type: r.type,
        startDate: dateUtil.dayKey(r.startAt, TZ),
        startTime: dateUtil.formatTime(r.startAt, TZ),
        endDate: r.endAt ? dateUtil.dayKey(r.endAt, TZ) : todayKey,
        endTime: r.endAt ? dateUtil.formatTime(r.endAt, TZ) : dateUtil.formatTime(now, TZ),
        ongoing: !r.endAt,
        kindIndex: Math.max(0, KIND_KEYS.indexOf(r.feedKind || 'breast')),
        sideIndex: Math.max(0, SIDE_KEYS.indexOf(r.side || 'left')),
        amountMl: r.amountMl ? String(r.amountMl) : '',
        note: r.note || '',
        canDelete: true
      })
      wx.setNavigationBarTitle({ title: '编辑记录' })
    } else {
      const type = options && options.type === 'feed' ? 'feed' : 'sleep'
      const span = type === 'sleep' ? 30 * 60000 : 15 * 60000
      const endAt = now + span
      this.setData({
        mode: 'create',
        type: type,
        startDate: todayKey,
        startTime: dateUtil.formatTime(now, TZ),
        endDate: dateUtil.dayKey(endAt, TZ),
        endTime: dateUtil.formatTime(endAt, TZ)
      })
      wx.setNavigationBarTitle({ title: '补录记录' })
    }

    this.refreshDerived()
  },

  onShow() {
    themeUtil.sync(this)
  },

  refreshDerived() {
    const d = this.data
    const isBreast = d.type === 'feed' && d.kindIndex === 0
    const showEnd = d.type === 'sleep' || isBreast
    this.setData({
      isBreast: isBreast,
      showEnd: showEnd,
      ongoing: showEnd ? d.ongoing : false
    })
  },

  /* ---------- 表单事件 ---------- */

  onType(e) {
    const t = e.currentTarget.dataset.type
    if (t === this.data.type) return
    this.setData({ type: t })
    this.refreshDerived()
  },

  onKind(e) {
    this.setData({ kindIndex: Number(e.detail.value) })
    this.refreshDerived()
  },

  onSide(e) {
    this.setData({ sideIndex: Number(e.detail.value) })
  },

  onStartDate(e) { this.setData({ startDate: e.detail.value }) },
  onStartTime(e) { this.setData({ startTime: e.detail.value }) },
  onEndDate(e) { this.setData({ endDate: e.detail.value }) },
  onEndTime(e) { this.setData({ endTime: e.detail.value }) },

  onOngoing(e) {
    this.setData({ ongoing: !!e.detail.value })
  },

  onAmount(e) {
    this.setData({ amountMl: e.detail.value })
  },

  onNote(e) {
    this.setData({ note: e.detail.value })
  },

  /* ---------- 保存 ---------- */

  save() {
    const d = this.data
    const now = Date.now()
    const startAt = dateUtil.atTime(d.startDate, d.startTime, TZ)

    if (startAt > now + 60000) return toast('开始时间不能晚于现在')
    if (startAt < now - config.MAX_RECORD_BACK_DAYS * DAY_MS) return toast('时间太早了')

    let endAt = null
    if (d.showEnd && !d.ongoing) {
      endAt = dateUtil.atTime(d.endDate, d.endTime, TZ)
      if (endAt <= startAt) return toast('结束时间要晚于开始时间')
      if (endAt - startAt > 48 * 3600000) return toast('单条记录不能超过 48 小时')
    } else if (!d.showEnd) {
      endAt = startAt // 瓶喂视为瞬时事件
    }

    const kind = KIND_KEYS[d.kindIndex] || 'breast'
    let amountMl = null
    if (d.type === 'feed' && kind !== 'breast' && d.amountMl) {
      amountMl = parseInt(d.amountMl, 10)
      if (!(amountMl > 0 && amountMl <= 1000)) return toast('奶量需在 1-1000 之间')
    }

    const prev = d.mode === 'edit' ? store.get(d.id) : null
    const rec = {
      _id: d.id || idUtil.genId('r'),
      type: d.type,
      startAt: startAt,
      endAt: endAt,
      feedKind: d.type === 'feed' ? kind : null,
      side: d.type === 'feed' && kind === 'breast' ? SIDE_KEYS[d.sideIndex] : null,
      amountMl: amountMl,
      note: (d.note || '').slice(0, 200),
      deleted: false,
      createdAt: prev ? prev.createdAt : now
    }

    store.put(rec)

    // 同一类型只保留一条"进行中"：把更早的那条在本次开始时间收口，
    // 避免多设备/补录时触发服务端的 ACTIVE_EXISTS 冲突。
    if (endAt === null) {
      store.all().forEach(function (r) {
        if (r.deleted || r.endAt || r.type !== d.type || r._id === rec._id) return
        if (r.startAt < startAt) store.patch(r._id, { endAt: startAt })
      })
    }

    apiSilentSync()
    wx.navigateBack()
  },

  del() {
    const self = this
    if (!self.data.id) return
    wx.showModal({
      title: '删除这条记录？',
      content: '删除后各设备都会同步移除（云端仍保留一份可恢复的软删除标记）',
      confirmText: '删除',
      confirmColor: '#e5533d',
      success: function (res) {
        if (!res.confirm) return
        store.remove(self.data.id)
        apiSilentSync()
        wx.navigateBack()
      }
    })
  }
})

function apiSilentSync() {
  store.sync(api).catch(function () {})
}

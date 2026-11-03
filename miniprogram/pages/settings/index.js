const config = require('../../config')
const api = require('../../utils/api')
const store = require('../../utils/store')
const themeUtil = require('../../utils/theme')
const dateUtil = require('../../utils/date')

const TZ = config.TZ_OFFSET_MIN
const VERSION = '1.0.0'
const DAY_MS = 86400000

function toast(title) {
  wx.showToast({ title: title, icon: 'none' })
}

Page({
  data: {
    theme: 'light',
    family: { name: '我的家庭' },
    inviteCode: '',
    memberCount: 0,
    pending: 0,
    lastSyncText: '从未同步',
    syncing: false,
    joinCode: '',
    version: VERSION
  },

  onShow() {
    themeUtil.sync(this)
    this.render()
  },

  render() {
    const fam = store.family() || {}
    const last = store.lastSyncAt()
    this.setData({
      family: fam,
      inviteCode: fam.inviteCode || '',
      memberCount: fam.memberCount || 0,
      pending: store.pendingCount(),
      lastSyncText: last ? dateUtil.formatDateTime(last, TZ) : '从未同步',
      syncing: store.isSyncing()
    })
  },

  /* ---------------- 家庭组 ---------------- */

  copyCode() {
    if (!this.data.inviteCode) return toast('还没有邀请码，请先联网初始化')
    wx.setClipboardData({
      data: this.data.inviteCode,
      success: function () {
        wx.showToast({ title: '邀请码已复制', icon: 'none' })
      }
    })
  },

  onJoinInput(e) {
    this.setData({ joinCode: (e.detail.value || '').toUpperCase() })
  },

  join() {
    const self = this
    const code = (self.data.joinCode || '').trim().toUpperCase()
    if (code.length !== 6) return toast('邀请码是 6 位')
    wx.showLoading({ title: '正在加入', mask: true })
    let migrated = 0
    api.call('family.join', { code: code }).then(function (data) {
      migrated = data.migrated || 0
      store.setFamily(data.family)
      // 丢掉旧家庭组的本地缓存，保留还没上传的记录，再全量拉取
      store.dropSynced()
      self.setData({ joinCode: '' })
      return store.sync(api)
    }).then(function () {
      wx.hideLoading()
      toast(migrated ? ('已加入，迁移 ' + migrated + ' 条记录') : '已加入，数据同步中')
      self.render()
    }).catch(function (err) {
      wx.hideLoading()
      toast(err.message || '加入失败')
    })
  },

  /* ---------------- 同步 ---------------- */

  syncNow() {
    const self = this
    if (self.data.syncing) return
    self.setData({ syncing: true })
    store.sync(api).then(function () {
      self.setData({ syncing: false })
      self.render()
      toast('已同步')
    }).catch(function (err) {
      self.setData({ syncing: false })
      self.render()
      toast(err.message || '同步失败')
    })
  },

  /* ---------------- 数据安全 ---------------- */

  exportCsv() {
    const self = this
    const now = Date.now()
    const to = now
    const from = dateUtil.parseDayKey(dateUtil.shiftDayKey(dateUtil.dayKey(now, TZ), -90, TZ), TZ)
    wx.showLoading({ title: '正在生成', mask: true })
    api.call('records.export', { from: from, to: to }).then(function (res) {
      wx.hideLoading()
      if (!res.rows) {
        toast('还没有可导出的记录')
        return
      }
      const path = wx.env.USER_DATA_PATH + '/' + res.filename
      try {
        wx.getFileSystemManager().writeFileSync(path, res.csv, 'utf8')
      } catch (e) {
        toast('写文件失败，已改为复制')
        self.copyCsv(res.csv)
        return
      }
      if (wx.shareFileMessage) {
        wx.shareFileMessage({
          filePath: path,
          fileName: res.filename,
          fail: function () { self.copyCsv(res.csv) }
        })
      } else {
        self.copyCsv(res.csv)
      }
    }).catch(function (err) {
      wx.hideLoading()
      toast(err.message || '导出失败')
    })
  },

  copyCsv(csv) {
    if (csv.length > 300000) {
      toast('数据量较大，请到开发者工具里导出')
      return
    }
    wx.setClipboardData({
      data: csv,
      success: function () {
        wx.showToast({ title: '已复制 CSV 到剪贴板', icon: 'none' })
      }
    })
  },

  backupNow() {
    wx.showLoading({ title: '正在备份', mask: true })
    api.callFn(config.BACKUP_FUNCTION, { scope: 'family' }).then(function (res) {
      wx.hideLoading()
      wx.showModal({
        title: '备份完成',
        content: '已生成 ' + res.count + ' 条记录的云端快照：\n' + res.fileName,
        showCancel: false
      })
    }).catch(function (err) {
      wx.hideLoading()
      toast(err.message || '备份失败')
    })
  },

  /* ---------------- 外观 ---------------- */

  toggleTheme(e) {
    const t = themeUtil.set(e.detail.value ? 'dark' : 'light')
    this.setData({ theme: t })
  },

  /* ---------------- 其他 ---------------- */

  resetLocal() {
    const self = this
    wx.showModal({
      title: '清空本机缓存？',
      content: '云端数据不会被删除，重新进入会从云端重新拉取。仅用于本机缓存异常。',
      confirmText: '清空',
      confirmColor: '#e5533d',
      success: function (res) {
        if (!res.confirm) return
        store.reset()
        self.render()
        toast('已清空本机缓存，回到首页可重新同步')
      }
    })
  },

  storageDoc() {
    wx.showModal({
      title: '数据存在哪里',
      content: '记录同时存在于：\n1）微信云数据库（主存储）\n2）本机缓存（离线可用）\n3）云端每日快照（保留 30 天）\n\n可随时导出 CSV 自行留存。',
      showCancel: false
    })
  }
})

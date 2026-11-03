const config = require('./config')
const theme = require('./utils/theme')

App({
  globalData: {
    theme: 'light',
    config: config
  },

  onLaunch() {
    this.globalData.theme = theme.get()

    // 只有选了云开发后端才需要初始化；自建服务器模式不碰云开发
    if (config.TRANSPORT !== 'cloud') return

    if (!wx.cloud) {
      console.error('[app] 基础库版本过低，请使用 2.2.3 及以上')
      return
    }

    const options = { traceUser: true }
    if (config.ENV_ID) options.env = config.ENV_ID
    wx.cloud.init(options)
  }
})

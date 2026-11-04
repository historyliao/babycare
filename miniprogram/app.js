const config = require('./config')
const theme = require('./utils/theme')

App({
  globalData: {
    theme: 'light',
    config: config
  },

  onLaunch() {
    this.globalData.theme = theme.get()

    if (!wx.cloud) {
      console.error('[app] 基础库版本过低，请使用 2.2.3 及以上')
      return
    }

    const options = { traceUser: true }
    // 留空表示使用账号下的默认环境
    if (config.ENV_ID) options.env = config.ENV_ID
    wx.cloud.init(options)
  }
})

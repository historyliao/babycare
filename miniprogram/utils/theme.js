/**
 * 夜间模式。喂夜奶时屏幕不能刺眼，所以提供手动切换（默认浅色）。
 */
const KEY = 'bc:theme'

function get() {
  try {
    return wx.getStorageSync(KEY) || 'light'
  } catch (e) {
    return 'light'
  }
}

function apply(themeName) {
  const dark = themeName === 'dark'
  try {
    wx.setNavigationBarColor({
      frontColor: dark ? '#ffffff' : '#000000',
      backgroundColor: dark ? '#11151c' : '#f5f6f8',
      animation: { duration: 120, timingFunc: 'easeIn' }
    })
  } catch (e) {
    // 低版本基础库忽略即可
  }
  try {
    // 仅 tabBar 页面有效，其他页面失败可忽略
    wx.setTabBarStyle({
      color: dark ? '#8b94a3' : '#8a8f99',
      selectedColor: dark ? '#6f9bff' : '#5b8def',
      backgroundColor: dark ? '#1a2029' : '#ffffff',
      borderStyle: dark ? 'black' : 'white'
    })
  } catch (e) {}
}

function set(themeName) {
  const t = themeName === 'dark' ? 'dark' : 'light'
  try {
    wx.setStorageSync(KEY, t)
  } catch (e) {}
  const app = getApp()
  if (app && app.globalData) app.globalData.theme = t
  apply(t)
  return t
}

/**
 * 页面 onShow 调用：同步 data.theme 与导航栏颜色
 */
function sync(page) {
  const t = get()
  if (page && page.setData && page.data.theme !== t) page.setData({ theme: t })
  apply(t)
  return t
}

module.exports = { get, set, apply, sync }

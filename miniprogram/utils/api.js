/**
 * 云函数调用封装。
 * 云函数统一返回 { ok, data } / { ok, error }，这里转成 Promise。
 */
const config = require('../config')

function callFunction(name, data) {
  return new Promise(function (resolve, reject) {
    if (!wx.cloud) {
      const e = new Error('当前微信版本不支持云开发，请升级微信')
      e.code = 'NO_CLOUD'
      return reject(e)
    }

    wx.cloud.callFunction({
      name: name,
      data: data || {},
      success: function (res) {
        const r = res && res.result
        if (!r) {
          const e = new Error('云函数无返回，请确认已部署 ' + name)
          e.code = 'EMPTY_RESULT'
          return reject(e)
        }
        if (r.ok) return resolve(r.data)
        const err = new Error((r.error && r.error.message) || '请求失败')
        err.code = (r.error && r.error.code) || 'UNKNOWN'
        err.data = (r.error && r.error.data) || null
        reject(err)
      },
      fail: function (e) {
        const err = new Error('网络不可用，记录已存在本机，联网后自动同步')
        err.code = 'NETWORK'
        err.raw = e
        reject(err)
      }
    })
  })
}

/** 调用 api 云函数（业务接口） */
function call(action, payload) {
  return callFunction(config.API_FUNCTION, { action: action, payload: payload || {} })
}

/** 调用任意云函数（如 backup） */
function callFn(name, payload) {
  return callFunction(name, payload || {})
}

module.exports = { call: call, callFn: callFn }

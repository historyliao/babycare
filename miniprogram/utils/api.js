/**
 * 云函数调用封装（当前方案：微信云开发 + 体验版）
 *
 * 云函数统一返回 { ok, data } / { ok, error }，这里转成 Promise。
 * 调用失败统一归一为 NETWORK，让上层（store.js）能识别"离线"并保留本地队列。
 */
const config = require('../config')

function makeError(code, message, data) {
  const e = new Error(message)
  e.code = code
  e.data = data || null
  return e
}

function cloudRaw(name, data) {
  return new Promise(function (resolve, reject) {
    if (!wx.cloud) {
      return reject(makeError('NO_CLOUD', '当前微信版本不支持云开发，请升级微信'))
    }

    wx.cloud.callFunction({
      name: name,
      data: data || {},
      success: function (res) {
        const r = res && res.result
        if (!r) {
          return reject(makeError('EMPTY_RESULT', '云函数无返回，请确认已部署 ' + name))
        }
        if (r.ok) return resolve(r.data)
        reject(makeError(
          (r.error && r.error.code) || 'UNKNOWN',
          (r.error && r.error.message) || '请求失败',
          r.error && r.error.data
        ))
      },
      fail: function () {
        reject(makeError('NETWORK', '网络不可用，记录已存在本机，联网后自动同步'))
      }
    })
  })
}

/** 调用业务云函数 api */
function call(action, payload) {
  return cloudRaw(config.API_FUNCTION, { action: action, payload: payload || {} })
}

/** 调用其它云函数（如 backup） */
function callFn(name, payload) {
  return cloudRaw(name, payload || {})
}

module.exports = { call: call, callFn: callFn }

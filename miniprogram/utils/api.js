/**
 * 统一接口层：屏蔽"自建服务器"和"云开发"的差异。
 *
 * - TRANSPORT = 'http'  → POST {API_BASE}/api，body = {action, payload}
 * - TRANSPORT = 'cloud' → wx.cloud.callFunction({name:'api'})
 *
 * 两者返回同样的 { ok, data } / { ok, error } 结构，
 * 所以页面、本地缓存、同步引擎完全不需要区分。
 */
const config = require('../config')

const TOKEN_KEY = 'bc:token'
const REQUEST_TIMEOUT = 15000

/* ---------------- token ---------------- */

function getToken() {
  try {
    return wx.getStorageSync(TOKEN_KEY) || ''
  } catch (e) {
    return ''
  }
}

function setToken(token) {
  try {
    wx.setStorageSync(TOKEN_KEY, token || '')
  } catch (e) {}
}

function clearToken() {
  setToken('')
}

/* ---------------- 错误归一 ---------------- */

function makeError(code, message, data) {
  const e = new Error(message)
  e.code = code
  e.data = data || null
  return e
}

function networkError() {
  return makeError('NETWORK', '网络不可用，记录已存在本机，联网后自动同步')
}

/* ---------------- 云开发通道 ---------------- */

function cloudRaw(name, data) {
  return new Promise(function (resolve, reject) {
    if (!wx.cloud) return reject(makeError('NO_CLOUD', '当前微信版本不支持云开发，请升级微信'))

    wx.cloud.callFunction({
      name: name,
      data: data,
      success: function (res) {
        const r = res && res.result
        if (!r) return reject(makeError('EMPTY_RESULT', '云函数无返回，请确认已部署 ' + name))
        if (r.ok) return resolve(r.data)
        reject(makeError((r.error && r.error.code) || 'UNKNOWN', (r.error && r.error.message) || '请求失败', r.error && r.error.data))
      },
      fail: function () { reject(networkError()) }
    })
  })
}

function cloudCall(action, payload) {
  return cloudRaw(config.API_FUNCTION, { action: action, payload: payload || {} })
}

/* ---------------- HTTP 通道 ---------------- */

function httpRaw(action, payload) {
  return new Promise(function (resolve, reject) {
    if (!config.API_BASE) {
      return reject(makeError('NO_API_BASE', '未配置 API_BASE，请填写服务器地址'))
    }

    const token = getToken()
    const header = { 'Content-Type': 'application/json' }
    if (token) header['Authorization'] = 'Bearer ' + token

    wx.request({
      url: config.API_BASE.replace(/\/+$/, '') + '/api',
      method: 'POST',
      timeout: REQUEST_TIMEOUT,
      header: header,
      data: { action: action, payload: payload || {} },
      success: function (res) {
        const body = res.data
        if (!body || typeof body !== 'object') {
          return reject(makeError('BAD_RESPONSE', '服务端返回格式异常'))
        }
        if (body.ok) return resolve(body.data)
        reject(makeError(
          (body.error && body.error.code) || 'UNKNOWN',
          (body.error && body.error.message) || '请求失败',
          body.error && body.error.data
        ))
      },
      fail: function () { reject(networkError()) }
    })
  })
}

/** wx.login → 换 token */
function login() {
  return new Promise(function (resolve, reject) {
    wx.login({
      success: function (res) {
        if (!res.code) return reject(makeError('NO_CODE', '微信登录失败，请重试'))
        httpRaw('auth.login', { code: res.code }).then(function (data) {
          setToken(data.token)
          resolve(data)
        }).catch(reject)
      },
      fail: function () { reject(networkError()) }
    })
  })
}

function httpCall(action, payload) {
  return httpRaw(action, payload).catch(function (err) {
    if (err.code !== 'UNAUTHORIZED') throw err
    // token 过期：静默重登一次再重试
    clearToken()
    return login().then(function () { return httpRaw(action, payload) })
  })
}

/* ---------------- 对外 ---------------- */

function call(action, payload) {
  if (config.TRANSPORT === 'cloud') return cloudCall(action, payload)

  if (!getToken() && action !== 'auth.login') {
    return login().then(function () { return httpRaw(action, payload) })
  }
  return httpCall(action, payload)
}

/**
 * 调用"另一个云函数"（历史接口）。
 * http 模式下映射为对应的 action：
 *   backup → backup.run
 */
function callFn(name, payload) {
  if (config.TRANSPORT === 'cloud') return cloudRaw(name, payload || {})

  if (name === config.BACKUP_FUNCTION) return call('backup.run', payload)
  return call(name, payload)
}

module.exports = {
  call: call,
  callFn: callFn,
  login: login,
  getToken: getToken,
  clearToken: clearToken
}

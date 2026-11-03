/**
 * 极简签名 token（HMAC-SHA256），不引 jsonwebtoken。
 * 格式：base64url(payload) + "." + base64url(hmac)
 */
const crypto = require('node:crypto')
const config = require('./config')

function b64url(buf) {
  return Buffer.from(buf).toString('base64url')
}

function issue(openid) {
  const payload = { sub: openid, iat: Date.now(), exp: Date.now() + config.TOKEN_TTL_MS }
  const body = b64url(JSON.stringify(payload))
  const sig = crypto.createHmac('sha256', config.TOKEN_SECRET).update(body).digest('base64url')
  return body + '.' + sig
}

function verify(token) {
  if (!token || typeof token !== 'string') return null
  const parts = token.split('.')
  if (parts.length !== 2) return null

  const expect = crypto.createHmac('sha256', config.TOKEN_SECRET).update(parts[0]).digest('base64url')
  const a = Buffer.from(parts[1])
  const b = Buffer.from(expect)
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null

  let payload
  try {
    payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'))
  } catch (e) {
    return null
  }
  if (!payload || !payload.sub || !payload.exp || payload.exp < Date.now()) return null
  return payload
}

module.exports = { issue, verify }

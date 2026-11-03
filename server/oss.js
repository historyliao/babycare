/**
 * 阿里云 OSS 上传（零依赖，手写 V1 签名）
 *
 * 只用到 PUT / DELETE 两个动作，足够做"每日快照"。
 * 如果没配 OSS_*，备份会写本地磁盘（用 rsync/挂载盘同样安全）。
 */
const crypto = require('node:crypto')
const config = require('./config')

function isConfigured() {
  return !!(
    config.OSS_ENDPOINT &&
    config.OSS_BUCKET &&
    config.OSS_ACCESS_KEY_ID &&
    config.OSS_ACCESS_KEY_SECRET
  )
}

function safeKey(key) {
  if (!/^[A-Za-z0-9._\-\/]+$/.test(key)) throw new Error('OSS key 含非法字符: ' + key)
  return key
}

function sign(method, contentType, md5, date, key) {
  const resource = '/' + config.OSS_BUCKET + '/' + key
  const stringToSign = [method, md5, contentType, date, resource].join('\n')
  return crypto.createHmac('sha1', config.OSS_ACCESS_KEY_SECRET).update(stringToSign).digest('base64')
}

function endpointFor(key) {
  return 'https://' + config.OSS_BUCKET + '.' + config.OSS_ENDPOINT + '/' + safeKey(key)
}

async function putObject(key, body) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8')
  const contentType = 'application/json'
  const md5 = crypto.createHash('md5').update(buf).digest('base64')
  const date = new Date().toUTCString()
  const auth = 'OSS ' + config.OSS_ACCESS_KEY_ID + ':' + sign('PUT', contentType, md5, date, key)

  const res = await fetch(endpointFor(key), {
    method: 'PUT',
    headers: {
      'Content-Type': contentType,
      'Content-MD5': md5,
      'Date': date,
      'Authorization': auth
    },
    body: buf
  })

  if (!res.ok) {
    const text = await res.text().catch(function () { return '' })
    throw new Error('OSS 上传失败 HTTP ' + res.status + ' ' + text.slice(0, 200))
  }
  return { key: key, url: endpointFor(key) }
}

async function deleteObject(key) {
  const contentType = ''
  const md5 = ''
  const date = new Date().toUTCString()
  const auth = 'OSS ' + config.OSS_ACCESS_KEY_ID + ':' + sign('DELETE', contentType, md5, date, key)

  const res = await fetch(endpointFor(key), {
    method: 'DELETE',
    headers: { 'Date': date, 'Authorization': auth }
  })
  // 404 视为已删除
  if (!res.ok && res.status !== 404) {
    throw new Error('OSS 删除失败 HTTP ' + res.status)
  }
  return true
}

function keyFromUrl(target) {
  const prefix = 'oss://' + config.OSS_BUCKET + '/'
  if (target && target.indexOf(prefix) === 0) return target.slice(prefix.length)
  return null
}

module.exports = { isConfigured, putObject, deleteObject, keyFromUrl }

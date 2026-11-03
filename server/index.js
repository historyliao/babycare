/**
 * HTTP 服务（零依赖，只用 node:http / node:https / node:sqlite）
 *
 * 路由：
 *   POST /api            统一入口，body = { action, payload }，与云函数版同构
 *   GET  /healthz        健康检查
 *   GET  /*              网页版（PWA）静态文件
 *
 * 启动：
 *   node server/index.js
 *   node server/index.js --migrate-from-cloud backups/xxx.json   （可选，导入云开发快照）
 */
const http = require('node:http')
const https = require('node:https')
const fs = require('node:fs')
const path = require('node:path')

const config = require('./config')
const db = require('./db')
const auth = require('./auth')
const handlers = require('./handlers')
const backup = require('./backup')

const PUBLIC_DIR = path.join(__dirname, '..', 'web')

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
}

/* ---------------- 小工具 ---------------- */

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  })
  res.end(body)
}

function ok(res, data) {
  sendJson(res, 200, { ok: true, data: data })
}

function fail(res, status, code, message, data) {
  sendJson(res, status, { ok: false, error: { code: code, message: message, data: data || null } })
}

function readBody(req, limit) {
  return new Promise(function (resolve, reject) {
    let size = 0
    const chunks = []
    req.on('data', function (chunk) {
      size += chunk.length
      if (size > limit) {
        reject(new Error('BODY_TOO_LARGE'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', function () {
      resolve(Buffer.concat(chunks).toString('utf8'))
    })
    req.on('error', reject)
  })
}

function bearer(req) {
  const h = req.headers['authorization'] || ''
  const m = /^Bearer\s+(.+)$/i.exec(h)
  return m ? m[1].trim() : ''
}

function maskId(id) {
  const s = String(id || '')
  if (s.length <= 8) return '***'
  return s.slice(0, 4) + '***' + s.slice(-4)
}

/* ---------------- 登录限流（防口令爆破） ---------------- */

const attempts = new Map()

function tooManyAttempts(ip) {
  const rec = attempts.get(ip)
  if (!rec) return false
  if (Date.now() - rec.first > 10 * 60 * 1000) {
    attempts.delete(ip)
    return false
  }
  return rec.count >= 10
}

function noteFailure(ip) {
  const rec = attempts.get(ip)
  if (!rec || Date.now() - rec.first > 10 * 60 * 1000) {
    attempts.set(ip, { first: Date.now(), count: 1 })
  } else {
    rec.count++
  }
}

/* ---------------- 静态文件 ---------------- */

function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname
  let file = path.join(PUBLIC_DIR, rel)

  // 防目录穿越
  const resolved = path.resolve(file)
  if (resolved !== PUBLIC_DIR && !resolved.startsWith(PUBLIC_DIR + path.sep)) {
    return fail(res, 403, 'FORBIDDEN', '禁止访问')
  }

  fs.readFile(resolved, function (err, buf) {
    if (err) {
      if (rel !== '/index.html') {
        // 未知路径回落到单页
        return serveStatic(req, res, '/index.html')
      }
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      return res.end('网页版前端未安装（缺少 web/index.html）')
    }
    const ext = path.extname(resolved).toLowerCase()
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': buf.length,
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer'
    })
    res.end(buf)
  })
}

/* ---------------- API ---------------- */

async function handleApi(req, res) {
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    (req.socket && req.socket.remoteAddress) || 'unknown'

  let raw
  try {
    raw = await readBody(req, config.MAX_BODY_BYTES)
  } catch (e) {
    return fail(res, 413, 'BODY_TOO_LARGE', '请求体过大')
  }

  let msg
  try {
    msg = JSON.parse(raw || '{}')
  } catch (e) {
    return fail(res, 400, 'BAD_JSON', '请求格式错误')
  }

  const action = msg && msg.action
  const payload = (msg && msg.payload) || {}

  try {
    // 登录类动作不需要 token
    if (action === 'auth.login') {
      const openid = await handlers.loginWithWxCode(payload.code)
      return ok(res, { token: auth.issue(openid), openid: maskId(openid) })
    }

    if (action === 'auth.webLogin') {
      if (tooManyAttempts(ip)) return fail(res, 429, 'TOO_MANY', '尝试次数过多，请 10 分钟后再试')
      let openid
      try {
        openid = handlers.loginWithPasscode(payload.passcode)
      } catch (e) {
        noteFailure(ip)
        throw e
      }
      attempts.delete(ip)
      return ok(res, { token: auth.issue(openid), openid: maskId(openid) })
    }

    const session = auth.verify(bearer(req))
    if (!session) return fail(res, 401, 'UNAUTHORIZED', '登录已过期，请重新进入')

    const handler = handlers.HANDLERS[action]
    if (typeof handler !== 'function') {
      return fail(res, 200, 'BAD_ACTION', '未知操作：' + action)
    }

    const data = await handler(payload, { openid: session.sub })
    return ok(res, data)
  } catch (e) {
    const code = e && e.code && typeof e.code === 'string' ? e.code : 'INTERNAL'
    const status = code === 'INTERNAL' ? 500 : 200
    if (code === 'INTERNAL') console.error('[api]', action, e)
    return fail(res, status, code, (e && e.message) || '服务异常', e && e.data)
  }
}

/* ---------------- 入口 ---------------- */

function requestListener(req, res) {
  const parsed = new URL(req.url, 'http://' + (req.headers.host || 'localhost'))

  if (parsed.pathname === '/healthz') {
    return ok(res, { status: 'ok', time: Date.now() })
  }

  if (parsed.pathname === '/api') {
    if (req.method !== 'POST') return fail(res, 405, 'METHOD_NOT_ALLOWED', '只支持 POST')
    return handleApi(req, res).catch(function (e) {
      console.error('[api] 未捕获异常', e)
      fail(res, 500, 'INTERNAL', '服务异常')
    })
  }

  if (req.method !== 'GET') return fail(res, 405, 'METHOD_NOT_ALLOWED', '只支持 GET')
  return serveStatic(req, res, parsed.pathname)
}

function createServer() {
  if (config.TLS_CERT && config.TLS_KEY) {
    return https.createServer({
      cert: fs.readFileSync(config.TLS_CERT),
      key: fs.readFileSync(config.TLS_KEY)
    }, requestListener)
  }
  return http.createServer(requestListener)
}

function scheduleBackup() {
  const delay = backup.msUntilNextRun()
  const timer = setTimeout(async function () {
    try {
      const r = await backup.runAll()
      console.log('[backup] 完成', r.families, '个家庭组，清理', r.pruned, '份过期快照')
      if (r.errors.length) console.error('[backup] 部分失败', r.errors)
    } catch (e) {
      console.error('[backup] 失败', e)
    }
    scheduleBackup()
  }, Math.min(delay, 2147483647))
  timer.unref && timer.unref()
  return timer
}

function start() {
  db.init(config.DB_FILE)
  const server = createServer()

  server.listen(config.PORT, config.HOST, function () {
    const scheme = config.TLS_CERT && config.TLS_KEY ? 'https' : 'http'
    console.log('\n宝宝作息服务已启动')
    console.log('  地址: ' + scheme + '://' + config.HOST + ':' + config.PORT)
    console.log('  数据库: ' + (config.DB_FILE === ':memory:' ? '内存' : config.DB_FILE))
    console.log('  备份: ' + (require('./oss').isConfigured() ? '阿里云 OSS' : config.BACKUP_DIR))
    if (require('./oss').isConfigured()) {
      console.log('  每日快照: ' + config.BACKUP_HOUR + ':' + String(config.BACKUP_MINUTE).padStart(2, '0') + '（UTC+8）')
    }
    if (config.TOKEN_SECRET_EPHEMERAL) {
      console.warn('\n  ⚠ 未设置 TOKEN_SECRET，重启后所有登录会失效（请在 server/.env 里固定一个）\n')
    }
    if (!config.WEB_PASSCODE) {
      console.warn('  ⚠ 未设置 WEB_PASSCODE，网页版登录已关闭（小程序不受影响）\n')
    }
  })

  scheduleBackup()
  return server
}

if (require.main === module) {
  start()
}

module.exports = { createServer, start, requestListener }

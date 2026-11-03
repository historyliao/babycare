/**
 * 配置加载（零依赖：手写 .env 解析）
 *
 * 优先读取 server/.env，其次读进程环境变量（已存在的环境变量不会被覆盖）。
 */
const fs = require('node:fs')
const path = require('node:path')

function loadEnvFile(file) {
  if (!fs.existsSync(file)) return
  const text = fs.readFileSync(file, 'utf8')
  text.split(/\r?\n/).forEach(function (line) {
    const s = line.trim()
    if (!s || s.charAt(0) === '#') return
    const i = s.indexOf('=')
    if (i < 0) return
    const key = s.slice(0, i).trim()
    let val = s.slice(i + 1).trim()
    if (
      (val.length > 1 && val.charAt(0) === '"' && val.charAt(val.length - 1) === '"') ||
      (val.length > 1 && val.charAt(0) === "'" && val.charAt(val.length - 1) === "'")
    ) {
      val = val.slice(1, -1)
    }
    if (process.env[key] === undefined) process.env[key] = val
  })
}

loadEnvFile(path.join(__dirname, '.env'))
loadEnvFile(path.join(process.cwd(), '.env'))

function str(name, def) {
  const v = process.env[name]
  return v === undefined || v === '' ? def : v
}

function num(name, def) {
  const v = Number(process.env[name])
  return isFinite(v) && v > 0 ? v : def
}

const config = {
  PORT: num('PORT', 3000),
  HOST: str('HOST', '127.0.0.1'),

  DB_FILE: str('DB_FILE', path.join(__dirname, 'data', 'babycare.db')),
  BACKUP_DIR: str('BACKUP_DIR', path.join(__dirname, 'data', 'backups')),

  TOKEN_SECRET: str('TOKEN_SECRET', ''),
  TOKEN_TTL_MS: num('TOKEN_TTL_DAYS', 30) * 86400000,

  // 小程序登录（走 jscode2session，需要小程序后台的 AppID / AppSecret）
  WX_APPID: str('WX_APPID', ''),
  WX_SECRET: str('WX_SECRET', ''),

  // 网页版（PWA）登录口令；留空则关闭网页版登录
  WEB_PASSCODE: str('WEB_PASSCODE', ''),

  // 统计口径，与小程序的 config.js 保持一致
  TZ_OFFSET_MIN: 480,
  NIGHT_START_HOUR: 19,
  NIGHT_END_HOUR: 7,

  // 直接对外提供 HTTPS 时使用（放在 Caddy/Nginx 后面则不用）
  TLS_CERT: str('TLS_CERT', ''),
  TLS_KEY: str('TLS_KEY', ''),

  BACKUP_KEEP_DAYS: num('BACKUP_KEEP_DAYS', 30),
  BACKUP_HOUR: num('BACKUP_HOUR', 3),
  BACKUP_MINUTE: num('BACKUP_MINUTE', 30),

  // 阿里云 OSS（留空则备份只写本地磁盘）
  OSS_ENDPOINT: str('OSS_ENDPOINT', ''), // 如 oss-cn-hangzhou.aliyuncs.com
  OSS_BUCKET: str('OSS_BUCKET', ''),
  OSS_ACCESS_KEY_ID: str('OSS_ACCESS_KEY_ID', ''),
  OSS_ACCESS_KEY_SECRET: str('OSS_ACCESS_KEY_SECRET', ''),
  OSS_PREFIX: str('OSS_PREFIX', 'babycare/'),

  MAX_BODY_BYTES: 2 * 1024 * 1024,
  MAX_FAMILY_MEMBERS: 10
}

if (!config.TOKEN_SECRET) {
  // 没配就用一个随机密钥（重启后所有 token 失效，需要重新登录）。
  // 生产环境请务必在 .env 里固定下来，否则重启一次全家都要重新登录。
  config.TOKEN_SECRET = require('node:crypto').randomBytes(32).toString('hex')
  config.TOKEN_SECRET_EPHEMERAL = true
}

module.exports = config

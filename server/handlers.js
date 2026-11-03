/**
 * 业务逻辑（与云函数版的规则一一对应，错误码也保持一致）
 *
 * 统计口径直接复用小程序里的纯函数（miniprogram/utils/stats.js），
 * 保证"手机上看"和"网页上看"的数字完全一致。
 */
const crypto = require('node:crypto')
const db = require('./db')
const config = require('./config')
const stats = require('../miniprogram/utils/stats')
const dateUtil = require('../miniprogram/utils/date')

const DAY_MS = 86400000
const MAX_PAGE = 1000
const MAX_EXPORT_ROWS = 5000
const MAX_MEMBERS = 10

function fail(code, message, data) {
  const e = new Error(message)
  e.code = code
  e.data = data || null
  return e
}

function opts() {
  return {
    tzOffsetMin: config.TZ_OFFSET_MIN,
    nightStartHour: config.NIGHT_START_HOUR,
    nightEndHour: config.NIGHT_END_HOUR
  }
}

function publicFamily(f) {
  const row = db.get('SELECT COUNT(*) AS c FROM family_members WHERE family_id = ?', f.id)
  return {
    _id: f.id,
    name: f.name,
    inviteCode: f.invite_code,
    memberCount: row ? Number(row.c) : 0,
    tzOffsetMin: f.tz_offset_min,
    schemaVersion: f.schema_version
  }
}

function toApiRecord(r) {
  return {
    _id: r.id,
    familyId: r.family_id,
    type: r.type,
    startAt: r.start_at,
    endAt: r.end_at,
    feedKind: r.feed_kind,
    side: r.side,
    amountMl: r.amount_ml,
    note: r.note || '',
    deleted: !!r.deleted,
    deletedAt: r.deleted_at,
    createdBy: r.created_by,
    updatedBy: r.updated_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    schemaVersion: r.schema_version
  }
}

/* ---------------- 身份 ---------------- */

function setActiveFamily(openid, familyId) {
  const now = Date.now()
  const user = db.get('SELECT openid FROM users WHERE openid = ?', openid)
  if (user) {
    db.run('UPDATE users SET active_family_id = ?, updated_at = ? WHERE openid = ?', familyId, now, openid)
  } else {
    db.run('INSERT INTO users (openid, active_family_id, created_at, updated_at) VALUES (?, ?, ?, ?)',
      openid, familyId, now, now)
  }
}

function activeFamily(openid) {
  const user = db.get('SELECT * FROM users WHERE openid = ?', openid)
  if (!user || !user.active_family_id) return null
  return db.get('SELECT * FROM families WHERE id = ?', user.active_family_id) || null
}

function requireFamily(openid) {
  const fam = activeFamily(openid)
  if (!fam) throw fail('NO_FAMILY', '还没有家庭组，请先初始化')
  return fam
}

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

function randomCode() {
  let s = ''
  for (let i = 0; i < 6; i++) s += CODE_CHARS.charAt(crypto.randomInt(CODE_CHARS.length))
  return s
}

function uniqueInviteCode() {
  for (let i = 0; i < 8; i++) {
    const code = randomCode()
    if (!db.get('SELECT id FROM families WHERE invite_code = ?', code)) return code
  }
  throw fail('INTERNAL', '生成邀请码失败，请重试')
}

/** 小程序登录：code → openid */
async function loginWithWxCode(code) {
  if (!config.WX_APPID || !config.WX_SECRET) {
    throw fail('WX_NOT_CONFIGURED', '服务端未配置 WX_APPID / WX_SECRET')
  }
  if (!code) throw fail('NO_CODE', '缺少 code')
  const url = 'https://api.weixin.qq.com/sns/jscode2session?appid=' +
    encodeURIComponent(config.WX_APPID) +
    '&secret=' + encodeURIComponent(config.WX_SECRET) +
    '&js_code=' + encodeURIComponent(code) +
    '&grant_type=authorization_code'

  let data
  try {
    const res = await fetch(url, { method: 'GET' })
    data = await res.json()
  } catch (e) {
    throw fail('NETWORK', '无法连接微信服务器，请检查服务器出网')
  }
  if (!data || !data.openid) {
    throw fail('WX_LOGIN_FAILED', (data && data.errmsg) || '微信登录失败，请检查 AppID/AppSecret')
  }
  return data.openid
}

/** 网页版登录：口令 → 固定身份 web:main（所有网页设备共享同一个家庭） */
function loginWithPasscode(passcode) {
  if (!config.WEB_PASSCODE) throw fail('WEB_DISABLED', '服务端未开启网页版登录')
  const given = String(passcode || '')
  const a = crypto.createHash('sha256').update(given).digest()
  const b = crypto.createHash('sha256').update(config.WEB_PASSCODE).digest()
  if (!crypto.timingSafeEqual(a, b)) throw fail('BAD_PASSCODE', '口令不正确')
  return 'web:main'
}

/* ---------------- 家庭组 ---------------- */

function familyBootstrap(payload, ctx) {
  let fam = activeFamily(ctx.openid)
  if (fam) {
    const member = db.get('SELECT openid FROM family_members WHERE family_id = ? AND openid = ?', fam.id, ctx.openid)
    if (!member) {
      db.run('INSERT INTO family_members (family_id, openid, created_at) VALUES (?, ?, ?)', fam.id, ctx.openid, Date.now())
    }
    return { family: publicFamily(fam), isNew: false }
  }

  const now = Date.now()
  const id = 'fam_' + crypto.randomBytes(8).toString('hex')
  db.run(
    'INSERT INTO families (id,name,owner_openid,invite_code,tz_offset_min,night_start_hour,night_end_hour,created_at,updated_at,schema_version) ' +
    'VALUES (?,?,?,?,?,?,?,?,?,1)',
    id, '我的家庭', ctx.openid, uniqueInviteCode(),
    config.TZ_OFFSET_MIN, config.NIGHT_START_HOUR, config.NIGHT_END_HOUR, now, now
  )
  db.run('INSERT INTO family_members (family_id, openid, created_at) VALUES (?, ?, ?)', id, ctx.openid, now)
  setActiveFamily(ctx.openid, id)

  fam = db.get('SELECT * FROM families WHERE id = ?', id)
  return { family: publicFamily(fam), isNew: true }
}

function familyJoin(payload, ctx) {
  const code = String(payload.code || '').trim().toUpperCase()
  if (!/^[A-Z0-9]{6}$/.test(code)) throw fail('BAD_CODE', '邀请码格式不正确')

  const fam = db.get('SELECT * FROM families WHERE invite_code = ?', code)
  if (!fam) throw fail('CODE_NOT_FOUND', '邀请码不存在，请核对')

  const prev = activeFamily(ctx.openid)
  const prevMembers = prev
    ? db.all('SELECT openid FROM family_members WHERE family_id = ?', prev.id)
    : []
  const members = db.all('SELECT openid FROM family_members WHERE family_id = ?', fam.id)
  const already = members.some(function (m) { return m.openid === ctx.openid })

  if (!already) {
    if (members.length >= MAX_MEMBERS) throw fail('FAMILY_FULL', '该家庭组成员已满')
    db.run('INSERT INTO family_members (family_id, openid, created_at) VALUES (?, ?, ?)', fam.id, ctx.openid, Date.now())
  }

  setActiveFamily(ctx.openid, fam.id)

  // 关键：判断的是"原来那个家庭组"是不是只有自己一个人。
  // 是的话把记录一起搬过来，避免"加入后自己之前记的数据消失"。
  let migrated = 0
  if (prev && prev.id !== fam.id && prevMembers.length <= 1) {
    const r = db.run('UPDATE records SET family_id = ?, updated_at = ? WHERE family_id = ?', fam.id, Date.now(), prev.id)
    migrated = r.changes
  }

  return { family: publicFamily(fam), joined: true, migrated: migrated }
}

function familyRename(payload, ctx) {
  const fam = requireFamily(ctx.openid)
  const name = String(payload.name || '').trim().slice(0, 20)
  if (!name) throw fail('BAD_NAME', '家庭名称不能为空')
  db.run('UPDATE families SET name = ?, updated_at = ? WHERE id = ?', name, Date.now(), fam.id)
  fam.name = name
  return { family: publicFamily(fam) }
}

/* ---------------- 记录 ---------------- */

function validateRecord(rec, now) {
  if (!rec || typeof rec !== 'object') throw fail('BAD_RECORD', '记录格式错误')

  const id = String(rec._id || '')
  if (!/^[A-Za-z0-9_-]{6,48}$/.test(id)) throw fail('BAD_RECORD', '记录 ID 非法')
  if (rec.type !== 'sleep' && rec.type !== 'feed') throw fail('BAD_RECORD', '记录类型非法')

  const startAt = Number(rec.startAt)
  if (!isFinite(startAt) || startAt <= 0) throw fail('BAD_RECORD', '开始时间非法')
  if (startAt > now + 5 * 60000) throw fail('BAD_RECORD', '开始时间不能晚于当前时间')
  if (startAt < now - 3650 * DAY_MS) throw fail('BAD_RECORD', '开始时间太早')

  let endAt = null
  if (rec.endAt !== null && rec.endAt !== undefined && rec.endAt !== '') {
    endAt = Number(rec.endAt)
    if (!isFinite(endAt) || endAt < startAt) throw fail('BAD_RECORD', '结束时间必须晚于开始时间')
    if (endAt - startAt > 48 * 3600000) throw fail('BAD_RECORD', '单条记录不能超过 48 小时')
    if (endAt > now + 5 * 60000) throw fail('BAD_RECORD', '结束时间不能晚于当前时间')
  }

  let feedKind = null
  let side = null
  let amountMl = null

  if (rec.type === 'feed') {
    feedKind = rec.feedKind || 'breast'
    if (['breast', 'bottle_breast', 'formula'].indexOf(feedKind) < 0) {
      throw fail('BAD_RECORD', '喂养方式非法')
    }
    if (feedKind === 'breast') {
      side = rec.side || 'left'
      if (['left', 'right', 'both'].indexOf(side) < 0) throw fail('BAD_RECORD', '哺乳侧非法')
    } else if (rec.amountMl !== null && rec.amountMl !== undefined && rec.amountMl !== '') {
      amountMl = Math.round(Number(rec.amountMl))
      if (!isFinite(amountMl) || amountMl <= 0 || amountMl > 1000) {
        throw fail('BAD_RECORD', '奶量需在 1-1000ml 之间')
      }
    }
  }

  return {
    id: id,
    type: rec.type,
    startAt: startAt,
    endAt: endAt,
    feedKind: feedKind,
    side: side,
    amountMl: amountMl,
    note: String(rec.note || '').slice(0, 200),
    deleted: rec.deleted ? 1 : 0
  }
}

function recordsUpsert(payload, ctx) {
  const fam = requireFamily(ctx.openid)
  const now = Date.now()
  const input = validateRecord(payload.record, now)

  if (!input.deleted && input.type === 'sleep' && input.endAt === null) {
    const other = db.get(
      "SELECT id, start_at FROM records WHERE family_id = ? AND type = 'sleep' AND end_at IS NULL AND deleted = 0 AND id <> ? LIMIT 1",
      fam.id, input.id
    )
    if (other) {
      throw fail('ACTIVE_EXISTS', '另一台设备还在计时睡眠', {
        activeId: other.id,
        activeStartAt: other.start_at,
        recordId: input.id
      })
    }
  }

  const existing = db.get('SELECT * FROM records WHERE id = ?', input.id)
  if (existing && existing.family_id !== fam.id) throw fail('FORBIDDEN', '无权修改这条记录')

  const createdAt = existing ? existing.created_at : now
  const createdBy = existing ? existing.created_by : ctx.openid

  db.run(
    'INSERT INTO records (id,family_id,type,start_at,end_at,feed_kind,side,amount_ml,note,deleted,deleted_at,created_by,updated_by,created_at,updated_at,schema_version) ' +
    'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1) ' +
    'ON CONFLICT(id) DO UPDATE SET ' +
    'family_id=excluded.family_id, type=excluded.type, start_at=excluded.start_at, end_at=excluded.end_at, ' +
    'feed_kind=excluded.feed_kind, side=excluded.side, amount_ml=excluded.amount_ml, note=excluded.note, ' +
    'deleted=excluded.deleted, deleted_at=excluded.deleted_at, updated_by=excluded.updated_by, updated_at=excluded.updated_at',
    input.id, fam.id, input.type, input.startAt, input.endAt, input.feedKind, input.side,
    input.amountMl, input.note, input.deleted, input.deleted ? now : null,
    createdBy, ctx.openid, createdAt, now
  )

  return toApiRecord(db.get('SELECT * FROM records WHERE id = ?', input.id))
}

function recordsList(payload, ctx) {
  const fam = requireFamily(ctx.openid)
  const since = Math.max(0, Number(payload.since) || 0)
  const limit = Math.min(Math.max(Number(payload.limit) || 800, 1), MAX_PAGE)
  const skip = Math.max(0, Number(payload.skip) || 0)
  const startedAt = Date.now()

  const rows = db.all(
    'SELECT * FROM records WHERE family_id = ? AND updated_at > ? ORDER BY updated_at ASC LIMIT ? OFFSET ?',
    fam.id, since, limit, skip
  )

  return {
    records: rows.map(toApiRecord),
    count: rows.length,
    hasMore: rows.length === limit,
    serverTime: startedAt
  }
}

function recordsGet(payload, ctx) {
  const fam = requireFamily(ctx.openid)
  const row = db.get('SELECT * FROM records WHERE id = ?', String(payload.id || ''))
  if (!row || row.family_id !== fam.id) throw fail('NOT_FOUND', '记录不存在')
  return toApiRecord(row)
}

function recordsRemove(payload, ctx) {
  const fam = requireFamily(ctx.openid)
  const id = String(payload.id || '')
  const row = db.get('SELECT * FROM records WHERE id = ?', id)
  if (!row || row.family_id !== fam.id) throw fail('NOT_FOUND', '记录不存在')

  const now = Date.now()
  db.run('UPDATE records SET deleted = 1, deleted_at = ?, updated_at = ?, updated_by = ? WHERE id = ?',
    now, now, ctx.openid, id)
  return { _id: id, deleted: true, updatedAt: now }
}

function csvCell(v) {
  const s = v === null || v === undefined ? '' : String(v)
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"'
  return s
}

function recordsExport(payload, ctx) {
  const fam = requireFamily(ctx.openid)
  const tz = fam.tz_offset_min || config.TZ_OFFSET_MIN
  const to = Number(payload.to) || Date.now()
  const from = Number(payload.from) || (to - 90 * DAY_MS)

  const rows = db.all(
    'SELECT * FROM records WHERE family_id = ? AND start_at >= ? AND start_at < ? AND deleted = 0 ORDER BY start_at ASC LIMIT ?',
    fam.id, from, to, MAX_EXPORT_ROWS
  )

  if (!rows.length) return { rows: 0, csv: '', filename: '' }

  const kindMap = { breast: '亲喂', bottle_breast: '瓶喂母乳', formula: '配方奶' }
  const sideMap = { left: '左侧', right: '右侧', both: '双侧' }
  const header = ['日期', '类型', '开始', '结束', '时长(分钟)', '喂养方式', '侧', '奶量(ml)', '备注', '记录ID']
  const lines = [header.map(csvCell).join(',')]

  rows.forEach(function (r) {
    lines.push([
      dateUtil.dayKey(r.start_at, tz),
      r.type === 'sleep' ? '睡眠' : '喂奶',
      dateUtil.formatTime(r.start_at, tz),
      r.end_at ? dateUtil.formatTime(r.end_at, tz) : '进行中',
      r.end_at ? String(Math.round((r.end_at - r.start_at) / 60000)) : '',
      r.feed_kind ? (kindMap[r.feed_kind] || '') : '',
      r.side ? (sideMap[r.side] || '') : '',
      r.amount_ml || '',
      r.note || '',
      r.id
    ].map(csvCell).join(','))
  })

  return {
    rows: rows.length,
    csv: '\ufeff' + lines.join('\r\n'),
    filename: 'babycare-' + dateUtil.dayKey(Date.now(), tz).replace(/-/g, '') + '.csv'
  }
}

/* ---------------- 统计（网页版用） ---------------- */

function familyRecords(familyId) {
  return db.all('SELECT * FROM records WHERE family_id = ?', familyId).map(toApiRecord)
}

function statsDay(payload, ctx) {
  const fam = requireFamily(ctx.openid)
  const dayKey = String(payload.dayKey || dateUtil.dayKey(Date.now(), fam.tz_offset_min || 480))
  return stats.computeDaySummary(familyRecords(fam.id), dayKey, Object.assign(opts(), {
    tzOffsetMin: fam.tz_offset_min || config.TZ_OFFSET_MIN
  }))
}

function statsRange(payload, ctx) {
  const fam = requireFamily(ctx.openid)
  const tz = fam.tz_offset_min || config.TZ_OFFSET_MIN
  const toKey = String(payload.toKey || dateUtil.dayKey(Date.now(), tz))
  const fromKey = String(payload.fromKey || dateUtil.shiftDayKey(toKey, -6, tz))
  return stats.computeRange(familyRecords(fam.id), fromKey, toKey, Object.assign(opts(), { tzOffsetMin: tz }))
}

/* ---------------- 备份 ---------------- */

async function backupRun(payload, ctx) {
  const backup = require('./backup')
  const fam = requireFamily(ctx.openid)
  const result = await backup.runFamily(fam)
  await backup.prune()
  return result
}

const HANDLERS = {
  'auth.login': null, // 由 index.js 特殊处理
  'auth.webLogin': null,
  'family.bootstrap': familyBootstrap,
  'family.join': familyJoin,
  'family.rename': familyRename,
  'records.upsert': recordsUpsert,
  'records.list': recordsList,
  'records.get': recordsGet,
  'records.remove': recordsRemove,
  'records.export': recordsExport,
  'stats.day': statsDay,
  'stats.range': statsRange,
  'backup.run': backupRun
}

module.exports = {
  HANDLERS,
  loginWithWxCode,
  loginWithPasscode,
  publicFamily,
  toApiRecord,
  requireFamily,
  fail
}

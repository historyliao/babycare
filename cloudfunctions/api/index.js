/**
 * 业务接口云函数（单入口 action 路由）
 *
 * 安全模型：
 * - 云数据库集合权限设为「仅管理端可读写」，客户端无法直连数据库。
 * - 所有读写都经过这里，familyId 由服务端根据 openid 反查，客户端传什么都不作数。
 * - 因此同家庭组共享、跨家庭组隔离，且无法伪造别人的 familyId。
 */

const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const _ = db.command

const COLLECTIONS = ['users', 'families', 'records', 'backups']
const MAX_PAGE = 1000
const MAX_PULL = 800   // 单次同步返回条数，避免响应体过大
const MAX_MEMBERS = 10
const MAX_EXPORT_ROWS = 5000
const DAY_MS = 86400000

let collectionsReady = false

/* ---------------- 基础工具 ---------------- */

function fail(code, message, data) {
  const e = new Error(message)
  e.code = code
  e.data = data || null
  return e
}

function pad2(n) {
  return n < 10 ? '0' + n : String(n)
}

function fmtDate(ts, tz) {
  const d = new Date(ts + tz * 60000)
  return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate())
}

function fmtTime(ts, tz) {
  const d = new Date(ts + tz * 60000)
  return pad2(d.getUTCHours()) + ':' + pad2(d.getUTCMinutes())
}

async function ensureCollections() {
  if (collectionsReady) return
  for (let i = 0; i < COLLECTIONS.length; i++) {
    try {
      await db.createCollection(COLLECTIONS[i])
    } catch (e) {
      // 已存在：忽略
    }
  }
  collectionsReady = true
}

function publicFamily(f) {
  return {
    _id: f._id,
    name: f.name || '我的家庭',
    inviteCode: f.inviteCode || '',
    memberCount: (f.members || []).length,
    tzOffsetMin: f.tzOffsetMin || 480,
    schemaVersion: f.schemaVersion || 1
  }
}

function randomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let s = ''
  for (let i = 0; i < 6; i++) {
    s += chars.charAt(Math.floor(Math.random() * chars.length))
  }
  return s
}

async function uniqueInviteCode() {
  for (let i = 0; i < 6; i++) {
    const code = randomCode()
    const res = await db.collection('families').where({ inviteCode: code }).limit(1).get()
    if (!res.data.length) return code
  }
  // 理论上到不了这里
  return randomCode() + 'X'
}

/** openid → 当前家庭组（唯一可信来源） */
async function getActiveFamily(openid) {
  await ensureCollections()
  const ures = await db.collection('users').where({ openid: openid }).limit(1).get()
  const user = ures.data[0]
  if (!user || !user.activeFamilyId) return null
  try {
    const fres = await db.collection('families').doc(user.activeFamilyId).get()
    return fres.data || null
  } catch (e) {
    return null
  }
}

async function requireFamily(openid) {
  const fam = await getActiveFamily(openid)
  if (!fam) throw fail('NO_FAMILY', '还没有家庭组，请先初始化')
  return fam
}

async function setActiveFamily(openid, familyId) {
  const ures = await db.collection('users').where({ openid: openid }).limit(1).get()
  const now = Date.now()
  if (ures.data.length) {
    await db.collection('users').doc(ures.data[0]._id).update({
      data: { activeFamilyId: familyId, updatedAt: now }
    })
  } else {
    await db.collection('users').add({
      data: { openid: openid, activeFamilyId: familyId, createdAt: now, updatedAt: now }
    })
  }
}

/* ---------------- 家庭组 ---------------- */

async function familyBootstrap(payload, ctx) {
  await ensureCollections()

  const ures = await db.collection('users').where({ openid: ctx.openid }).limit(1).get()
  const user = ures.data[0]

  if (user && user.activeFamilyId) {
    let fres = null
    try {
      fres = await db.collection('families').doc(user.activeFamilyId).get()
    } catch (e) {
      fres = null
    }
    if (fres && fres.data) {
      // 自我修复：确保成员列表里有自己
      const fam = fres.data
      const members = fam.members || []
      if (members.indexOf(ctx.openid) < 0) {
        members.push(ctx.openid)
        await db.collection('families').doc(fam._id).update({ data: { members: members } })
        fam.members = members
      }
      return { family: publicFamily(fam), isNew: false }
    }
  }

  const now = Date.now()
  const doc = {
    name: '我的家庭',
    ownerOpenid: ctx.openid,
    members: [ctx.openid],
    inviteCode: await uniqueInviteCode(),
    tzOffsetMin: 480,
    nightStartHour: 19,
    nightEndHour: 7,
    createdAt: now,
    updatedAt: now,
    schemaVersion: 1
  }
  const add = await db.collection('families').add({ data: doc })
  doc._id = add._id
  await setActiveFamily(ctx.openid, add._id)
  return { family: publicFamily(doc), isNew: true }
}

async function familyJoin(payload, ctx) {
  await ensureCollections()
  const code = String(payload.code || '').trim().toUpperCase()
  if (!/^[A-Z0-9]{6}$/.test(code)) throw fail('BAD_CODE', '邀请码格式不正确')

  const res = await db.collection('families').where({ inviteCode: code }).limit(1).get()
  const fam = res.data[0]
  if (!fam) throw fail('CODE_NOT_FOUND', '邀请码不存在，请核对')

  const prev = await getActiveFamily(ctx.openid)
  const now = Date.now()

  const members = fam.members || []
  if (members.indexOf(ctx.openid) < 0) {
    if (members.length >= MAX_MEMBERS) throw fail('FAMILY_FULL', '该家庭组成员已满')
    members.push(ctx.openid)
    await db.collection('families').doc(fam._id).update({
      data: { members: members, updatedAt: now }
    })
    fam.members = members
  }

  // 切到该家庭组
  await setActiveFamily(ctx.openid, fam._id)

  // 如果原来是"独自一人"的家庭组，把已有记录一起迁移过来，
  // 避免用户加入家庭后看不到自己之前记的数据。
  let migrated = 0
  if (prev && prev._id !== fam._id && (prev.members || []).length <= 1) {
    try {
      const up = await db.collection('records').where({ familyId: prev._id }).update({
        data: { familyId: fam._id, updatedAt: now }
      })
      migrated = (up.stats && up.stats.updated) || 0
    } catch (e) {
      migrated = 0
    }
  }

  return { family: publicFamily(fam), joined: true, migrated: migrated }
}

async function familyRename(payload, ctx) {
  const fam = await requireFamily(ctx.openid)
  const name = String(payload.name || '').trim().slice(0, 20)
  if (!name) throw fail('BAD_NAME', '家庭名称不能为空')
  await db.collection('families').doc(fam._id).update({
    data: { name: name, updatedAt: Date.now() }
  })
  fam.name = name
  return { family: publicFamily(fam) }
}

/* ---------------- 记录读写 ---------------- */

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
    _id: id,
    type: rec.type,
    startAt: startAt,
    endAt: endAt,
    feedKind: feedKind,
    side: side,
    amountMl: amountMl,
    note: String(rec.note || '').slice(0, 200),
    deleted: !!rec.deleted
  }
}

async function recordsUpsert(payload, ctx) {
  const fam = await requireFamily(ctx.openid)
  const now = Date.now()
  const input = validateRecord(payload.record, now)

  // 同一时刻只允许一段进行中的睡眠：多设备同时开计时时给出明确冲突
  if (!input.deleted && input.type === 'sleep' && input.endAt === null) {
    const activeRes = await db.collection('records').where({
      familyId: fam._id,
      type: 'sleep',
      endAt: null,
      deleted: false,
      _id: _.neq(input._id)
    }).limit(5).get()
    if (activeRes.data.length) {
      const other = activeRes.data[0]
      throw fail('ACTIVE_EXISTS', '另一台设备还在计时睡眠', {
        activeId: other._id,
        activeStartAt: other.startAt,
        recordId: input._id
      })
    }
  }

  const col = db.collection('records')
  let createdAt = now
  let createdBy = ctx.openid

  try {
    const cur = await col.doc(input._id).get()
    if (cur.data) {
      if (cur.data.familyId !== fam._id) throw fail('FORBIDDEN', '无权修改这条记录')
      createdAt = cur.data.createdAt || now
      createdBy = cur.data.createdBy || ctx.openid
    }
  } catch (e) {
    if (e && e.code === 'FORBIDDEN') throw e
    // 文档不存在：正常新建
  }

  const doc = {
    familyId: fam._id,
    type: input.type,
    startAt: input.startAt,
    endAt: input.endAt,
    feedKind: input.feedKind,
    side: input.side,
    amountMl: input.amountMl,
    note: input.note,
    deleted: input.deleted,
    deletedAt: input.deleted ? now : null,
    createdBy: createdBy,
    updatedBy: ctx.openid,
    createdAt: createdAt,
    updatedAt: now,
    schemaVersion: 1
  }

  // doc(id).set 对已存在文档是整体覆盖，客户端 ID 幂等
  await col.doc(input._id).set({ data: doc })
  doc._id = input._id
  return doc
}

async function recordsList(payload, ctx) {
  const fam = await requireFamily(ctx.openid)
  const since = Math.max(0, Number(payload.since) || 0)
  const limit = Math.min(Math.max(Number(payload.limit) || MAX_PULL, 1), MAX_PAGE)
  const skip = Math.max(0, Number(payload.skip) || 0)
  const startedAt = Date.now()

  const res = await db.collection('records')
    .where({ familyId: fam._id, updatedAt: _.gt(since) })
    .orderBy('updatedAt', 'asc')
    .skip(skip)
    .limit(limit)
    .get()

  return {
    records: res.data,
    count: res.data.length,
    hasMore: res.data.length === limit,
    // 服务端在查询开始前取时间，客户端据此推进游标，避免漏掉查询期间的新写入
    serverTime: startedAt
  }
}

async function recordsGet(payload, ctx) {
  const fam = await requireFamily(ctx.openid)
  let res = null
  try {
    res = await db.collection('records').doc(String(payload.id || '')).get()
  } catch (e) {
    throw fail('NOT_FOUND', '记录不存在')
  }
  if (!res.data || res.data.familyId !== fam._id) throw fail('NOT_FOUND', '记录不存在')
  return res.data
}

async function recordsRemove(payload, ctx) {
  const fam = await requireFamily(ctx.openid)
  const id = String(payload.id || '')
  let res = null
  try {
    res = await db.collection('records').doc(id).get()
  } catch (e) {
    throw fail('NOT_FOUND', '记录不存在')
  }
  if (!res.data || res.data.familyId !== fam._id) throw fail('NOT_FOUND', '记录不存在')
  const now = Date.now()
  await db.collection('records').doc(id).update({
    data: { deleted: true, deletedAt: now, updatedAt: now, updatedBy: ctx.openid }
  })
  return { _id: id, deleted: true, updatedAt: now }
}

/* ---------------- 导出 ---------------- */

function csvCell(v) {
  const s = v === null || v === undefined ? '' : String(v)
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"'
  return s
}

async function recordsExport(payload, ctx) {
  const fam = await requireFamily(ctx.openid)
  const tz = fam.tzOffsetMin || 480
  const to = Number(payload.to) || Date.now()
  const from = Number(payload.from) || (to - 90 * DAY_MS)

  // 云数据库单次查询最多 1000 条，这里翻页取
  const where = { familyId: fam._id, startAt: _.gte(from).and(_.lt(to)) }
  const rows = []
  let skip = 0

  while (rows.length < MAX_EXPORT_ROWS) {
    const pageSize = Math.min(MAX_PAGE, MAX_EXPORT_ROWS - rows.length)
    const page = await db.collection('records')
      .where(where)
      .orderBy('startAt', 'asc')
      .skip(skip)
      .limit(pageSize)
      .get()

    for (let i = 0; i < page.data.length; i++) {
      if (!page.data[i].deleted) rows.push(page.data[i])
    }
    if (page.data.length < pageSize) break
    skip += page.data.length
  }

  if (!rows.length) return { rows: 0, csv: '', filename: '' }

  const kindMap = { breast: '亲喂', bottle_breast: '瓶喂母乳', formula: '配方奶' }
  const sideMap = { left: '左侧', right: '右侧', both: '双侧' }

  const header = ['日期', '类型', '开始', '结束', '时长(分钟)', '喂养方式', '侧', '奶量(ml)', '备注', '记录ID']
  const lines = [header.map(csvCell).join(',')]

  rows.forEach(function (r) {
    let dur = ''
    if (r.endAt) dur = String(Math.round((r.endAt - r.startAt) / 60000))
    lines.push([
      fmtDate(r.startAt, tz),
      r.type === 'sleep' ? '睡眠' : '喂奶',
      fmtTime(r.startAt, tz),
      r.endAt ? fmtTime(r.endAt, tz) : '进行中',
      dur,
      r.feedKind ? (kindMap[r.feedKind] || '') : '',
      r.side ? (sideMap[r.side] || '') : '',
      r.amountMl || '',
      r.note || '',
      r._id
    ].map(csvCell).join(','))
  })

  return {
    rows: rows.length,
    csv: '\ufeff' + lines.join('\r\n'),
    filename: 'babycare-' + fmtDate(Date.now(), tz).replace(/-/g, '') + '.csv'
  }
}

/* ---------------- 系统 ---------------- */

async function systemInit(payload, ctx) {
  await ensureCollections()
  return { collections: COLLECTIONS, ready: true }
}

/* ---------------- 路由 ---------------- */

const HANDLERS = {
  'family.bootstrap': familyBootstrap,
  'family.join': familyJoin,
  'family.rename': familyRename,
  'records.upsert': recordsUpsert,
  'records.list': recordsList,
  'records.get': recordsGet,
  'records.remove': recordsRemove,
  'records.export': recordsExport,
  'system.init': systemInit
}

exports.main = async function (event) {
  const action = event && event.action
  const payload = (event && event.payload) || {}
  const wxContext = cloud.getWXContext()

  try {
    if (!wxContext.OPENID) throw fail('NO_OPENID', '未获取到微信身份')
    const handler = HANDLERS[action]
    if (!handler) throw fail('BAD_ACTION', '未知操作：' + action)
    const data = await handler(payload, { openid: wxContext.OPENID })
    return { ok: true, data: data }
  } catch (e) {
    console.error('[api]', action, e && e.code, e && e.message)
    return {
      ok: false,
      error: {
        code: (e && e.code) || 'INTERNAL',
        message: (e && e.message) || '服务异常',
        data: (e && e.data) || null
      }
    }
  }
}

/**
 * 每日快照备份云函数
 *
 * - 定时触发（默认每天 03:30）：把每个家庭组的所有记录导出成 JSON，写入云存储。
 * - 手动触发（小程序设置页）：scope=family，只备份当前用户所在家庭组。
 *
 * 为什么需要它：云数据库是主存储，但误删集合/误操作/账号异常时，
 * 云存储里的历史快照是独立的一份，可以据此恢复。
 */

const cloud = require('wx-server-sdk')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

const db = cloud.database()
const _ = db.command

const MAX_PAGE = 1000
const KEEP_DAYS = 30
const TZ = 480

function pad2(n) {
  return n < 10 ? '0' + n : String(n)
}

function dayKey(ts) {
  const d = new Date(ts + TZ * 60000)
  return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate())
}

async function fetchAll(collection, where) {
  const out = []
  let skip = 0
  while (skip < 50000) {
    const q = where ? db.collection(collection).where(where) : db.collection(collection)
    const res = await q.orderBy('_id', 'asc').skip(skip).limit(MAX_PAGE).get()
    for (let i = 0; i < res.data.length; i++) out.push(res.data[i])
    if (res.data.length < MAX_PAGE) break
    skip += MAX_PAGE
  }
  return out
}

async function resolveFamilies(scope, openid) {
  if (scope === 'family') {
    if (!openid) throw new Error('未获取到微信身份')
    const ures = await db.collection('users').where({ openid: openid }).limit(1).get()
    const user = ures.data[0]
    if (!user || !user.activeFamilyId) throw new Error('还没有家庭组')
    const fres = await db.collection('families').doc(user.activeFamilyId).get()
    if (!fres.data) throw new Error('家庭组不存在')
    return [fres.data]
  }
  return fetchAll('families')
}

async function backupOne(family) {
  const records = await fetchAll('records', { familyId: family._id })
  const now = Date.now()
  const payload = {
    schemaVersion: 1,
    kind: 'babycare-snapshot',
    exportedAt: now,
    exportedAtText: dayKey(now) + ' ' + new Date(now + TZ * 60000).toISOString().slice(11, 16),
    family: {
      _id: family._id,
      name: family.name,
      ownerOpenid: family.ownerOpenid,
      members: family.members || [],
      tzOffsetMin: family.tzOffsetMin || 480
    },
    recordCount: records.length,
    records: records
  }

  const fileName = 'family-' + family._id + '-' + now + '.json'
  const cloudPath = 'backups/' + dayKey(now) + '/' + fileName

  const up = await cloud.uploadFile({
    cloudPath: cloudPath,
    fileContent: Buffer.from(JSON.stringify(payload), 'utf8')
  })

  await db.collection('backups').add({
    data: {
      familyId: family._id,
      day: dayKey(now),
      fileID: up.fileID,
      recordCount: records.length,
      bytes: JSON.stringify(payload).length,
      createdAt: now
    }
  })

  return { familyId: family._id, count: records.length, fileName: fileName, fileID: up.fileID }
}

async function prune() {
  const cutoff = Date.now() - KEEP_DAYS * 86400000
  let removed = 0
  let fileIDs = []
  try {
    const res = await db.collection('backups').where({ createdAt: _.lt(cutoff) }).limit(100).get()
    const docs = res.data
    if (!docs.length) return 0
    fileIDs = docs.map(function (d) { return d.fileID }).filter(Boolean)
    for (let i = 0; i < docs.length; i++) {
      await db.collection('backups').doc(docs[i]._id).remove()
    }
    removed = docs.length
  } catch (e) {
    return 0
  }
  for (let i = 0; i < fileIDs.length; i += 50) {
    try {
      await cloud.deleteFile({ fileList: fileIDs.slice(i, i + 50) })
    } catch (e) {
      // 文件可能已被手工删除，忽略
    }
  }
  return removed
}

exports.main = async function (event) {
  const scope = (event && event.scope) || 'auto'
  const wxContext = cloud.getWXContext()

  try {
    const families = await resolveFamilies(scope, wxContext.OPENID)
    const results = []
    const errors = []

    for (let i = 0; i < families.length; i++) {
      try {
        results.push(await backupOne(families[i]))
      } catch (e) {
        errors.push({ familyId: families[i]._id, message: e.message })
      }
    }

    const pruned = await prune()

    if (scope === 'family') {
      if (!results.length) throw new Error(errors.length ? errors[0].message : '没有可备份的数据')
      return {
        ok: true,
        data: {
          count: results[0].count,
          fileName: results[0].fileName,
          fileID: results[0].fileID,
          pruned: pruned
        }
      }
    }

    return { ok: true, data: { families: results.length, details: results, errors: errors, pruned: pruned } }
  } catch (e) {
    console.error('[backup]', e)
    return { ok: false, error: { code: 'BACKUP_FAILED', message: e.message || '备份失败' } }
  }
}

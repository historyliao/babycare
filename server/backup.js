/**
 * 每日快照：把每个家庭组的全部记录导出成 JSON，
 * 上传到 OSS（已配置）或写入本地 BACKUP_DIR（未配置）。
 */
const fs = require('node:fs')
const path = require('node:path')
const db = require('./db')
const config = require('./config')
const oss = require('./oss')
const dateUtil = require('../miniprogram/utils/date')

function dayKey(ts) {
  return dateUtil.dayKey(ts, config.TZ_OFFSET_MIN)
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

async function runFamily(fam) {
  const rows = db.all('SELECT * FROM records WHERE family_id = ?', fam.id)
  const now = Date.now()
  const day = dayKey(now)
  const fileName = 'family-' + fam.id + '-' + now + '.json'

  const payload = {
    schemaVersion: 1,
    kind: 'babycare-snapshot',
    exportedAt: now,
    family: {
      _id: fam.id,
      name: fam.name,
      ownerOpenid: fam.owner_openid,
      tzOffsetMin: fam.tz_offset_min
    },
    recordCount: rows.length,
    records: rows.map(toApiRecord)
  }

  const json = JSON.stringify(payload)
  let target

  if (oss.isConfigured()) {
    const prefix = config.OSS_PREFIX.replace(/\/+$/, '') + '/'
    const key = prefix + day + '/' + fileName
    await oss.putObject(key, json)
    target = 'oss://' + config.OSS_BUCKET + '/' + key
  } else {
    const dir = path.join(config.BACKUP_DIR, day)
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, fileName)
    fs.writeFileSync(file, json, 'utf8')
    target = file
  }

  db.run(
    'INSERT INTO backups (family_id, day, target, record_count, bytes, created_at) VALUES (?,?,?,?,?,?)',
    fam.id, day, target, rows.length, Buffer.byteLength(json), now
  )

  return { count: rows.length, fileName: fileName, target: target, day: day }
}

async function runAll() {
  const families = db.all('SELECT * FROM families')
  const results = []
  const errors = []
  for (const fam of families) {
    try {
      results.push(await runFamily(fam))
    } catch (e) {
      errors.push({ familyId: fam.id, message: e.message })
    }
  }
  const pruned = await prune()
  return { families: results.length, details: results, errors: errors, pruned: pruned }
}

async function prune() {
  const cutoff = Date.now() - config.BACKUP_KEEP_DAYS * 86400000
  const rows = db.all('SELECT * FROM backups WHERE created_at < ?', cutoff)
  let removed = 0

  for (const row of rows) {
    const key = oss.keyFromUrl(row.target)
    try {
      if (key && oss.isConfigured()) {
        await oss.deleteObject(key)
      } else if (!key) {
        fs.unlinkSync(row.target)
      }
    } catch (e) {
      // 文件可能已被手工删除，忽略
    }
    db.run('DELETE FROM backups WHERE id = ?', row.id)
    removed++
  }
  return removed
}

/** 计算下一次 03:30（按 UTC+8，不依赖服务器时区）的毫秒延迟 */
function msUntilNextRun() {
  const now = Date.now()
  const dayStart = dateUtil.startOfDay(now, config.TZ_OFFSET_MIN)
  let target = dayStart + config.BACKUP_HOUR * 3600000 + config.BACKUP_MINUTE * 60000
  if (target <= now) target += 86400000
  return target - now
}

module.exports = { runFamily, runAll, prune, msUntilNextRun }

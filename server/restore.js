/**
 * 从快照 JSON 恢复记录（灾难恢复用）
 *
 * 用法：
 *   node server/restore.js data/backups/2026-11-03/family-fam_xxx-1699.json
 *   node server/restore.js <快照文件> --dry-run     # 只看会恢复多少条，不写库
 *
 * 特点：
 * - 已存在的记录按 _id 覆盖（不会产生重复）
 * - 家庭组不存在时会自动新建（邀请码重新生成）
 * - 记录被软删除前的状态会一并恢复（deleted 字段原样写回）
 */
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const config = require('./config')
const db = require('./db')

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

function randomCode() {
  let s = ''
  for (let i = 0; i < 6; i++) s += CODE_CHARS.charAt(crypto.randomInt(CODE_CHARS.length))
  return s
}

function main() {
  const args = process.argv.slice(2)
  const file = args.filter(function (a) { return a.indexOf('--') !== 0 })[0]
  const dryRun = args.indexOf('--dry-run') >= 0

  if (!file) {
    console.error('用法：node server/restore.js <快照文件.json> [--dry-run]')
    process.exit(1)
  }
  if (!fs.existsSync(file)) {
    console.error('文件不存在：' + file)
    process.exit(1)
  }

  const snap = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (snap.kind !== 'babycare-snapshot') {
    console.error('这不是本项目的快照文件（缺少 kind=babycare-snapshot）')
    process.exit(1)
  }

  const records = Array.isArray(snap.records) ? snap.records : []
  const famInfo = snap.family || {}
  const now = Date.now()

  if (dryRun) {
    console.log('[dry-run] 快照时间：' + new Date(snap.exportedAt).toISOString())
    console.log('[dry-run] 家庭组：' + (famInfo.name || '(未命名)') + ' / ' + (famInfo._id || '(无 id)'))
    console.log('[dry-run] 将恢复 ' + records.length + ' 条记录')
    return
  }

  db.init(config.DB_FILE)

  let familyId = famInfo._id
  let fam = familyId ? db.get('SELECT * FROM families WHERE id = ?', familyId) : null

  if (!fam) {
    familyId = familyId || 'fam_' + crypto.randomBytes(8).toString('hex')
    db.run(
      'INSERT INTO families (id,name,owner_openid,invite_code,tz_offset_min,night_start_hour,night_end_hour,created_at,updated_at,schema_version) ' +
      'VALUES (?,?,?,?,?,?,?,?,?,1)',
      familyId,
      famInfo.name || '恢复的家庭',
      famInfo.ownerOpenid || 'restore',
      randomCode(),
      famInfo.tzOffsetMin || config.TZ_OFFSET_MIN,
      config.NIGHT_START_HOUR,
      config.NIGHT_END_HOUR,
      now,
      now
    )
    console.log('已新建家庭组：' + familyId)
  } else {
    console.log('写入已有家庭组：' + familyId)
  }

  let restored = 0
  let skipped = 0

  for (const r of records) {
    if (!r || !r._id || !r.type) {
      skipped++
      continue
    }
    db.run(
      'INSERT INTO records (id,family_id,type,start_at,end_at,feed_kind,side,amount_ml,note,deleted,deleted_at,created_by,updated_by,created_at,updated_at,schema_version) ' +
      'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1) ' +
      'ON CONFLICT(id) DO UPDATE SET ' +
      'family_id=excluded.family_id, type=excluded.type, start_at=excluded.start_at, end_at=excluded.end_at, ' +
      'feed_kind=excluded.feed_kind, side=excluded.side, amount_ml=excluded.amount_ml, note=excluded.note, ' +
      'deleted=excluded.deleted, deleted_at=excluded.deleted_at, updated_at=excluded.updated_at',
      r._id,
      familyId,
      r.type,
      r.startAt,
      r.endAt === undefined ? null : r.endAt,
      r.feedKind || null,
      r.side || null,
      r.amountMl || null,
      r.note || '',
      r.deleted ? 1 : 0,
      r.deletedAt || null,
      r.createdBy || 'restore',
      r.updatedBy || 'restore',
      r.createdAt || now,
      now // updatedAt 用当前时间，保证所有客户端都能增量拉到
    )
    restored++
  }

  db.close()

  console.log('完成：恢复 ' + restored + ' 条，跳过 ' + skipped + ' 条')
  console.log('提示：恢复后请在手机/网页上重新登录或下拉刷新，让客户端拉到这些记录。')
}

main()

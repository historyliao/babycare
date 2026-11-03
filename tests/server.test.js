/**
 * 自建后端集成测试（真实 SQLite + 真实 HTTP，不打桩）
 * 运行：node tests/server.test.js
 */
const assert = require('assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

// 必须在 require server/config 之前设置环境
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'babycare-test-'))
process.env.TOKEN_SECRET = 'test-secret-do-not-use'
process.env.WEB_PASSCODE = '246810'
process.env.DB_FILE = ':memory:'
process.env.BACKUP_DIR = path.join(TMP, 'backups')
process.env.OSS_BUCKET = ''
process.env.OSS_ACCESS_KEY_ID = ''

const db = require('../server/db')
const handlers = require('../server/handlers')
const auth = require('../server/auth')
const backupMod = require('../server/backup')
const serverMod = require('../server/index')

db.init(':memory:')

let passed = 0
let failed = 0

async function test(name, fn) {
  try {
    await fn()
    passed++
    console.log('  PASS  ' + name)
  } catch (e) {
    failed++
    console.log('  FAIL  ' + name)
    console.log('        ' + (e && e.message))
  }
}

function call(action, payload, openid) {
  const handler = handlers.HANDLERS[action]
  assert.ok(handler, '未实现 action: ' + action)
  return handler(payload || {}, { openid: openid })
}

async function expectFail(action, payload, openid, code) {
  let err = null
  try {
    await call(action, payload, openid)
  } catch (e) {
    err = e
  }
  assert.ok(err, '期望失败但成功了')
  assert.strictEqual(err.code, code, '期望 ' + code + '，实际 ' + err.code)
  return err
}

const TZ = 480
function at(dayStr, hhmm) {
  const p = dayStr.split('-').map(Number)
  const t = hhmm.split(':').map(Number)
  return Date.UTC(p[0], p[1] - 1, p[2], t[0], t[1]) - TZ * 60000
}

function dayAgo(n) {
  const ts = Date.now() - n * 86400000
  const d = new Date(ts + TZ * 60000)
  return d.toISOString().slice(0, 10)
}

const D1 = dayAgo(2)
const D2 = dayAgo(1)

function sleepRecord(id, startAt, endAt) {
  return {
    _id: id,
    type: 'sleep',
    startAt: startAt,
    endAt: endAt === undefined ? null : endAt,
    deleted: false
  }
}

async function main() {
  console.log('\n[家庭组]')
  let famA = null
  let codeA = ''

  await test('首次 bootstrap 自动建家庭组', async function () {
    const data = await call('family.bootstrap', {}, 'openid_a')
    assert.strictEqual(data.isNew, true)
    assert.strictEqual(data.family.memberCount, 1)
    assert.ok(/^[A-Z0-9]{6}$/.test(data.family.inviteCode))
    famA = data.family
    codeA = data.family.inviteCode
  })

  await test('bootstrap 幂等', async function () {
    const data = await call('family.bootstrap', {}, 'openid_a')
    assert.strictEqual(data.isNew, false)
    assert.strictEqual(data.family._id, famA._id)
    const rows = db.all('SELECT id FROM families')
    assert.strictEqual(rows.length, 1)
  })

  await test('邀请码加入后共享家庭组', async function () {
    await call('family.bootstrap', {}, 'openid_b')
    const data = await call('family.join', { code: codeA }, 'openid_b')
    assert.strictEqual(data.family._id, famA._id)
    assert.strictEqual(data.family.memberCount, 2)
  })

  await test('错误邀请码被拒绝', async function () {
    await expectFail('family.join', { code: 'ZZZZZZ' }, 'openid_b', 'CODE_NOT_FOUND')
  })

  await test('加入时迁移自己原有的记录', async function () {
    await call('family.bootstrap', {}, 'openid_c')
    await call('records.upsert', { record: sleepRecord('r_c_migrate1', at(D1, '10:00'), at(D1, '11:00')) }, 'openid_c')
    const data = await call('family.join', { code: codeA }, 'openid_c')
    assert.strictEqual(data.migrated, 1)

    const list = await call('records.list', { since: 0 }, 'openid_c')
    assert.ok(list.records.some(function (r) { return r._id === 'r_c_migrate1' }))
  })

  console.log('\n[记录]')

  await test('写入进行中的睡眠', async function () {
    const data = await call('records.upsert', {
      record: sleepRecord('r_sleep_1', at(D1, '20:00'), null)
    }, 'openid_a')
    assert.strictEqual(data._id, 'r_sleep_1')
    assert.strictEqual(data.familyId, famA._id)
    assert.strictEqual(data.endAt, null)
  })

  await test('同 ID 重复写入不产生重复行（幂等）', async function () {
    await call('records.upsert', { record: sleepRecord('r_sleep_1', at(D1, '20:00'), null) }, 'openid_a')
    const rows = db.all('SELECT id FROM records WHERE id = ?', 'r_sleep_1')
    assert.strictEqual(rows.length, 1)
  })

  await test('第二段进行中的睡眠被拦截', async function () {
    const e = await expectFail('records.upsert', {
      record: sleepRecord('r_sleep_2', at(D1, '21:00'), null)
    }, 'openid_b', 'ACTIVE_EXISTS')
    assert.strictEqual(e.data.activeId, 'r_sleep_1')
    assert.strictEqual(e.data.recordId, 'r_sleep_2')
  })

  await test('结束上一段后可以开新段', async function () {
    await call('records.upsert', { record: sleepRecord('r_sleep_1', at(D1, '20:00'), at(D1, '21:00')) }, 'openid_b')
    const data = await call('records.upsert', { record: sleepRecord('r_sleep_2', at(D1, '21:00'), null) }, 'openid_b')
    assert.strictEqual(data.endAt, null)
  })

  await test('结束时间早于开始时间被拒绝', async function () {
    await expectFail('records.upsert', {
      record: sleepRecord('r_bad_1', at(D1, '22:00'), at(D1, '21:00'))
    }, 'openid_a', 'BAD_RECORD')
  })

  await test('非法类型被拒绝', async function () {
    const rec = sleepRecord('r_bad_2', at(D1, '22:00'), null)
    rec.type = 'poop'
    await expectFail('records.upsert', { record: rec }, 'openid_a', 'BAD_RECORD')
  })

  await test('异常奶量被拒绝', async function () {
    await expectFail('records.upsert', {
      record: {
        _id: 'r_bad_3',
        type: 'feed',
        startAt: at(D1, '10:00'),
        endAt: at(D1, '10:10'),
        feedKind: 'formula',
        amountMl: 5000,
        deleted: false
      }
    }, 'openid_a', 'BAD_RECORD')
  })

  await test('未来时间被拒绝', async function () {
    await expectFail('records.upsert', {
      record: sleepRecord('r_bad_4', Date.now() + 3600000, null)
    }, 'openid_a', 'BAD_RECORD')
  })

  await test('新增瓶喂记录', async function () {
    const data = await call('records.upsert', {
      record: {
        _id: 'r_feed_1',
        type: 'feed',
        startAt: at(D1, '08:00'),
        endAt: at(D1, '08:10'),
        feedKind: 'formula',
        amountMl: 120,
        deleted: false
      }
    }, 'openid_a')
    assert.strictEqual(data.amountMl, 120)
    assert.strictEqual(data.feedKind, 'formula')
  })

  console.log('\n[隔离与同步]')

  await test('家庭成员能看到彼此记录', async function () {
    const list = await call('records.list', { since: 0 }, 'openid_b')
    assert.ok(list.records.some(function (r) { return r._id === 'r_feed_1' }))
  })

  await test('其他家庭组看不到', async function () {
    await call('family.bootstrap', {}, 'openid_other')
    const list = await call('records.list', { since: 0 }, 'openid_other')
    assert.strictEqual(list.records.length, 0)
  })

  await test('不能读别人家庭组的记录', async function () {
    await expectFail('records.get', { id: 'r_feed_1' }, 'openid_other', 'NOT_FOUND')
  })

  await test('不能改别人家庭组的记录', async function () {
    await expectFail('records.upsert', {
      record: {
        _id: 'r_feed_1',
        type: 'feed',
        startAt: at(D1, '08:00'),
        endAt: at(D1, '09:00'),
        feedKind: 'formula',
        amountMl: 90,
        deleted: false
      }
    }, 'openid_other', 'FORBIDDEN')
  })

  await test('软删除后增量同步可见', async function () {
    const before = await call('records.list', { since: 0 }, 'openid_a')
    const data = await call('records.remove', { id: 'r_feed_1' }, 'openid_a')
    assert.strictEqual(data.deleted, true)

    const after = await call('records.list', { since: before.serverTime - 1000 }, 'openid_a')
    const hit = after.records.filter(function (r) { return r._id === 'r_feed_1' })[0]
    assert.ok(hit, '增量里应包含被删除的记录')
    assert.strictEqual(hit.deleted, true)
  })

  await test('since 游标只返回更新的记录', async function () {
    const first = await call('records.list', { since: 0 }, 'openid_a')
    const second = await call('records.list', { since: first.serverTime + 1000 }, 'openid_a')
    assert.strictEqual(second.records.length, 0)
  })

  await test('分页 hasMore / skip 正确', async function () {
    const p1 = await call('records.list', { since: 0, limit: 2 }, 'openid_a')
    assert.strictEqual(p1.records.length, 2)
    assert.strictEqual(p1.hasMore, true)

    const p2 = await call('records.list', { since: 0, limit: 2, skip: 2 }, 'openid_a')
    const ids1 = p1.records.map(function (r) { return r._id })
    const ids2 = p2.records.map(function (r) { return r._id })
    assert.strictEqual(ids1.filter(function (id) { return ids2.indexOf(id) >= 0 }).length, 0)
  })

  console.log('\n[导出与统计]')

  await test('导出 CSV 含表头与数据', async function () {
    const data = await call('records.export', {
      from: at(D1, '00:00'),
      to: at(D2, '23:59')
    }, 'openid_a')
    assert.ok(data.rows >= 2)
    assert.ok(data.csv.indexOf('日期,类型,开始') === 1, 'CSV 应带 BOM')
    const lines = data.csv.replace(/^\ufeff/, '').split('\r\n')
    assert.strictEqual(lines.length, data.rows + 1)
  })

  await test('统计接口返回与小程序的统计口径一致', async function () {
    // 先把进行中的那段收口，让断言稳定：
    // 10:00-11:00（迁移过来的）+ 20:00-21:00 + 21:00-22:00 = 180 分钟
    await call('records.upsert', {
      record: sleepRecord('r_sleep_2', at(D1, '21:00'), at(D1, '22:00'))
    }, 'openid_a')

    const day = await call('stats.day', { dayKey: D1 }, 'openid_a')
    assert.strictEqual(day.dayKey, D1)
    assert.strictEqual(day.sleepMin, 180)
    assert.strictEqual(day.feedCount, 0, '瓶喂已被软删除')

    const range = await call('stats.range', { fromKey: D1, toKey: D2 }, 'openid_a')
    assert.strictEqual(range.days.length, 2)
    assert.strictEqual(range.totals.sleepMin, 180)
  })

  console.log('\n[备份]')

  await test('快照写入本地目录（未配置 OSS 时）', async function () {
    const fam = db.get('SELECT * FROM families WHERE id = ?', famA._id)
    const result = await backupMod.runFamily(fam)
    assert.ok(result.count >= 2)
    assert.ok(fs.existsSync(result.target), '快照文件应存在')
    const json = JSON.parse(fs.readFileSync(result.target, 'utf8'))
    assert.strictEqual(json.kind, 'babycare-snapshot')
    assert.strictEqual(json.records.length, result.count)
  })

  await test('全量备份 + 过期清理不报错', async function () {
    const r = await backupMod.runAll()
    assert.strictEqual(r.errors.length, 0)
    assert.ok(r.families >= 2)
  })

  await test('restore.js 能从快照恢复（先 dry-run 再实际写入）', async function () {
    const { execFileSync } = require('node:child_process')
    const { DatabaseSync } = require('node:sqlite')
    const restorePath = path.join(__dirname, '..', 'server', 'restore.js')

    const fam = db.get('SELECT * FROM families WHERE id = ?', famA._id)
    const snap = await backupMod.runFamily(fam)
    assert.ok(fs.existsSync(snap.target))

    const dry = execFileSync(process.execPath, [restorePath, snap.target, '--dry-run'], { encoding: 'utf8' })
    assert.ok(dry.indexOf('[dry-run]') >= 0)
    assert.ok(dry.indexOf('将恢复 ' + snap.count + ' 条记录') >= 0, dry)

    const freshDb = path.join(TMP, 'restore-target.db')
    const out = execFileSync(process.execPath, [restorePath, snap.target], {
      encoding: 'utf8',
      env: Object.assign({}, process.env, { DB_FILE: freshDb })
    })
    assert.ok(out.indexOf('恢复 ' + snap.count + ' 条') >= 0, out)

    const check = new DatabaseSync(freshDb)
    const row = check.prepare('SELECT COUNT(*) AS c FROM records').get()
    assert.strictEqual(Number(row.c), snap.count, '恢复后记录数应与快照一致')
    const famRow = check.prepare('SELECT COUNT(*) AS c FROM families').get()
    assert.strictEqual(Number(famRow.c), 1, '应自动重建家庭组')
    check.close()
  })

  console.log('\n[鉴权]')

  await test('口令登录签发 token，错误口令被拒', async function () {
    const openid = handlers.loginWithPasscode('246810')
    assert.strictEqual(openid, 'web:main')

    let err = null
    try {
      handlers.loginWithPasscode('000000')
    } catch (e) {
      err = e
    }
    assert.ok(err)
    assert.strictEqual(err.code, 'BAD_PASSCODE')
  })

  await test('token 签发/校验，篡改后失效', async function () {
    const t = auth.issue('openid_a')
    assert.strictEqual(auth.verify(t).sub, 'openid_a')
    assert.strictEqual(auth.verify(t + 'x'), null)
    assert.strictEqual(auth.verify('abc.def'), null)
    assert.strictEqual(auth.verify(''), null)
  })

  console.log('\n[HTTP]')

  const server = serverMod.createServer()
  await new Promise(function (resolve) { server.listen(0, '127.0.0.1', resolve) })
  const base = 'http://127.0.0.1:' + server.address().port

  async function http(action, payload, token) {
    const headers = { 'Content-Type': 'application/json' }
    if (token) headers['Authorization'] = 'Bearer ' + token
    const res = await fetch(base + '/api', {
      method: 'POST',
      headers: headers,
      body: JSON.stringify({ action: action, payload: payload || {} })
    })
    return { status: res.status, body: await res.json() }
  }

  let webToken = ''

  await test('GET /healthz', async function () {
    const res = await fetch(base + '/healthz')
    assert.strictEqual(res.status, 200)
    const body = await res.json()
    assert.strictEqual(body.ok, true)
  })

  await test('网页口令登录拿到 token', async function () {
    const r = await http('auth.webLogin', { passcode: '246810' })
    assert.strictEqual(r.status, 200)
    assert.strictEqual(r.body.ok, true)
    assert.ok(r.body.data.token)
    webToken = r.body.data.token
  })

  await test('无 token 请求被拒绝（401）', async function () {
    const r = await http('family.bootstrap', {})
    assert.strictEqual(r.status, 401)
    assert.strictEqual(r.body.error.code, 'UNAUTHORIZED')
  })

  await test('带 token 完成 bootstrap → 写入 → 读取', async function () {
    const boot = await http('family.bootstrap', {}, webToken)
    assert.strictEqual(boot.body.ok, true)
    const familyId = boot.body.data.family._id

    const up = await http('records.upsert', {
      record: sleepRecord('r_web_1', at(D1, '14:00'), at(D1, '15:00'))
    }, webToken)
    assert.strictEqual(up.body.ok, true)
    assert.strictEqual(up.body.data.familyId, familyId)

    const list = await http('records.list', { since: 0 }, webToken)
    assert.ok(list.body.data.records.some(function (r) { return r._id === 'r_web_1' }))
  })

  await test('错误密码返回 BAD_PASSCODE', async function () {
    const r = await http('auth.webLogin', { passcode: 'wrong' })
    assert.strictEqual(r.body.ok, false)
    assert.strictEqual(r.body.error.code, 'BAD_PASSCODE')
  })

  await test('未知 action 返回 BAD_ACTION', async function () {
    const r = await http('nope.nope', {}, webToken)
    assert.strictEqual(r.body.error.code, 'BAD_ACTION')
  })

  await test('非法 JSON 返回 400', async function () {
    const res = await fetch(base + '/api', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{oops'
    })
    assert.strictEqual(res.status, 400)
  })

  await test('GET /api 返回 405', async function () {
    const res = await fetch(base + '/api')
    assert.strictEqual(res.status, 405)
  })

  await new Promise(function (resolve) { server.close(resolve) })

  db.close()
  fs.rmSync(TMP, { recursive: true, force: true })

  console.log('\n结果：' + passed + ' 通过，' + failed + ' 失败\n')
  process.exit(failed ? 1 : 0)
}

main().catch(function (e) {
  console.error('测试运行出错：', e)
  process.exit(1)
})

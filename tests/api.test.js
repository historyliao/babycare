/**
 * 云函数集成测试（打桩 wx-server-sdk）
 * 运行：node tests/api.test.js
 *
 * 覆盖：初始化家庭组、幂等写入、进行中睡眠冲突、跨设备共享、
 *       家庭隔离、软删除同步、导出、参数校验。
 */
const assert = require('assert')
const path = require('path')

const mock = require('./mock-wx-server-sdk').createMock()
const uninstall = mock.install()

const apiPath = path.join(__dirname, '..', 'cloudfunctions', 'api', 'index.js')
const backupPath = path.join(__dirname, '..', 'cloudfunctions', 'backup', 'index.js')

const api = require(apiPath)
const backup = require(backupPath)
const dateUtil = require('../miniprogram/utils/date')

let passed = 0
let failed = 0

function test(name, fn) {
  try {
    fn()
    passed++
    console.log('  PASS  ' + name)
  } catch (e) {
    failed++
    console.log('  FAIL  ' + name)
    console.log('        ' + (e && e.message))
  }
}

async function testAsync(name, fn) {
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

async function call(action, payload) {
  return api.main({ action: action, payload: payload || {} })
}

function ok(res) {
  assert.strictEqual(res.ok, true, '期望成功，实际：' + JSON.stringify(res.error))
  return res.data
}

function err(res, code) {
  assert.strictEqual(res.ok, false, '期望失败，实际成功')
  assert.strictEqual(res.error.code, code, '期望错误码 ' + code + '，实际 ' + res.error.code)
  return res.error
}

const TZ = 480
const TODAY = dateUtil.dayKey(Date.now(), TZ)
const D1 = dateUtil.shiftDayKey(TODAY, -2, TZ)
const D2 = dateUtil.shiftDayKey(TODAY, -1, TZ)

function at(dayStr, hhmm) {
  const parts = dayStr.split('-').map(Number)
  const t = hhmm.split(':').map(Number)
  return Date.UTC(parts[0], parts[1] - 1, parts[2], t[0], t[1]) - TZ * 60000
}

function sleepRecord(id, startAt, endAt) {
  return {
    _id: id,
    type: 'sleep',
    startAt: startAt,
    endAt: endAt === undefined ? null : endAt,
    feedKind: null,
    side: null,
    amountMl: null,
    note: '',
    deleted: false
  }
}

function feedRecord(id, startAt, endAt, extra) {
  return Object.assign({
    _id: id,
    type: 'feed',
    startAt: startAt,
    endAt: endAt,
    note: '',
    deleted: false
  }, extra || {})
}

async function main() {
  console.log('\n[family]')
  let familyA = null
  let codeA = ''

  await testAsync('首次调用自动创建家庭组', async function () {
    mock.as('openid_A')
    const res = await call('family.bootstrap')
    const data = ok(res)
    assert.strictEqual(data.isNew, true)
    assert.strictEqual(data.family.memberCount, 1)
    assert.strictEqual(data.family.inviteCode.length, 6)
    assert.ok(/^[A-Z0-9]{6}$/.test(data.family.inviteCode))
    assert.strictEqual(data.family.members, undefined, '不应把成员 openid 列表下发给客户端')
    familyA = data.family
    codeA = data.family.inviteCode
  })

  await testAsync('再次调用返回同一家庭组（不重复创建）', async function () {
    const res = await call('family.bootstrap')
    const data = ok(res)
    assert.strictEqual(data.isNew, false)
    assert.strictEqual(data.family._id, familyA._id)
    assert.strictEqual(mock.store.families.length, 1)
  })

  await testAsync('邀请码加入后共享同一家庭组', async function () {
    mock.as('openid_B')
    ok(await call('family.bootstrap'))
    assert.strictEqual(mock.store.families.length, 2, 'B 先有自己的家庭组')
    const data = ok(await call('family.join', { code: codeA }))
    assert.strictEqual(data.family._id, familyA._id)
    assert.strictEqual(data.family.memberCount, 2)
  })

  await testAsync('错误邀请码被拒绝', async function () {
    mock.as('openid_B')
    err(await call('family.join', { code: 'ZZZZZZ' }), 'CODE_NOT_FOUND')
  })

  await testAsync('加入自己已在的家庭组是幂等的', async function () {
    mock.as('openid_B')
    const data = ok(await call('family.join', { code: codeA }))
    assert.strictEqual(data.family._id, familyA._id)
    assert.strictEqual(data.family.memberCount, 2, '不应重复计数')
  })

  await testAsync('加入家庭组时自动迁移原家庭组的记录', async function () {
    mock.as('openid_D')
    ok(await call('family.bootstrap'))
    ok(await call('records.upsert', {
      record: sleepRecord('r_migrate_1', at(D1, '10:00'), at(D1, '11:00'))
    }))

    const data = ok(await call('family.join', { code: codeA }))
    assert.strictEqual(data.migrated, 1, '应迁移 1 条记录')

    const list = ok(await call('records.list', { since: 0 }))
    assert.ok(list.records.some(function (r) { return r._id === 'r_migrate_1' }), '迁移后能拉到自己的记录')
  })

  console.log('\n[records]')

  await testAsync('写入进行中的睡眠', async function () {
    mock.as('openid_A')
    const rec = sleepRecord('r_sleep_1', at(D1, '20:00'), null)
    const data = ok(await call('records.upsert', { record: rec }))
    assert.strictEqual(data._id, 'r_sleep_1')
    assert.strictEqual(data.familyId, familyA._id)
    assert.strictEqual(data.endAt, null)
    assert.ok(data.updatedAt > 0)
  })

  await testAsync('重复推送同一 ID 不会产生重复记录（幂等）', async function () {
    mock.as('openid_A')
    const rec = sleepRecord('r_sleep_1', at(D1, '20:00'), null)
    ok(await call('records.upsert', { record: rec }))
    const list = ok(await call('records.list', { since: 0 }))
    const same = list.records.filter(function (r) { return r._id === 'r_sleep_1' })
    assert.strictEqual(same.length, 1)
  })

  await testAsync('第二段进行中的睡眠被拦截（跨设备冲突）', async function () {
    mock.as('openid_B')
    const rec = sleepRecord('r_sleep_2', at(D1, '21:00'), null)
    const e = err(await call('records.upsert', { record: rec }), 'ACTIVE_EXISTS')
    assert.strictEqual(e.data.activeId, 'r_sleep_1')
    assert.strictEqual(e.data.recordId, 'r_sleep_2')
  })

  await testAsync('结束上一段后再开新的一段成功', async function () {
    mock.as('openid_B')
    const ended = sleepRecord('r_sleep_1', at(D1, '20:00'), at(D1, '21:00'))
    ok(await call('records.upsert', { record: ended }))
    const rec = sleepRecord('r_sleep_2', at(D1, '21:00'), null)
    ok(await call('records.upsert', { record: rec }))
  })

  await testAsync('结束时间早于开始时间被拒绝', async function () {
    mock.as('openid_A')
    const rec = sleepRecord('r_bad_1', at(D1, '22:00'), at(D1, '21:00'))
    err(await call('records.upsert', { record: rec }), 'BAD_RECORD')
  })

  await testAsync('非法类型被拒绝', async function () {
    mock.as('openid_A')
    const rec = sleepRecord('r_bad_2', at(D1, '22:00'), null)
    rec.type = 'poop'
    err(await call('records.upsert', { record: rec }), 'BAD_RECORD')
  })

  await testAsync('异常奶量被拒绝', async function () {
    mock.as('openid_A')
    const rec = feedRecord('r_bad_3', at(D1, '10:00'), at(D1, '10:10'), {
      feedKind: 'formula', amountMl: 5000
    })
    err(await call('records.upsert', { record: rec }), 'BAD_RECORD')
  })

  await testAsync('未来时间被拒绝', async function () {
    mock.as('openid_A')
    const rec = sleepRecord('r_bad_4', Date.now() + 3600000, null)
    err(await call('records.upsert', { record: rec }), 'BAD_RECORD')
  })

  await testAsync('新增喂奶记录', async function () {
    mock.as('openid_A')
    const rec = feedRecord('r_feed_1', at(D1, '08:00'), at(D1, '08:20'), {
      feedKind: 'breast', side: 'left'
    })
    const data = ok(await call('records.upsert', { record: rec }))
    assert.strictEqual(data.feedKind, 'breast')
    assert.strictEqual(data.side, 'left')
    assert.strictEqual(data.amountMl, null)
  })

  console.log('\n[isolation & sync]')

  await testAsync('家庭成员能看到对方的记录', async function () {
    mock.as('openid_B')
    const list = ok(await call('records.list', { since: 0 }))
    const ids = list.records.map(function (r) { return r._id })
    assert.ok(ids.indexOf('r_feed_1') >= 0, '应看到 A 记的喂奶')
  })

  await testAsync('其他家庭组看不到（隔离）', async function () {
    mock.as('openid_C')
    ok(await call('family.bootstrap'))
    const list = ok(await call('records.list', { since: 0 }))
    assert.strictEqual(list.records.length, 0)
  })

  await testAsync('不能读取别人家庭组的记录', async function () {
    mock.as('openid_C')
    err(await call('records.get', { id: 'r_feed_1' }), 'NOT_FOUND')
  })

  await testAsync('不能修改别人家庭组的记录', async function () {
    mock.as('openid_C')
    const rec = feedRecord('r_feed_1', at(D1, '08:00'), at(D1, '09:00'), {
      feedKind: 'breast', side: 'left'
    })
    err(await call('records.upsert', { record: rec }), 'FORBIDDEN')
  })

  await testAsync('软删除后增量同步能感知到', async function () {
    mock.as('openid_A')
    const before = ok(await call('records.list', { since: 0 }))
    const data = ok(await call('records.remove', { id: 'r_feed_1' }))
    assert.strictEqual(data.deleted, true)

    const after = ok(await call('records.list', { since: before.serverTime - 1000 }))
    const hit = after.records.filter(function (r) { return r._id === 'r_feed_1' })[0]
    assert.ok(hit, '增量里应包含被删除的记录')
    assert.strictEqual(hit.deleted, true)

    const full = ok(await call('records.list', { since: 0 }))
    const live = full.records.filter(function (r) { return !r.deleted && r._id === 'r_feed_1' })
    assert.strictEqual(live.length, 0)
  })

  await testAsync('since 游标只返回更新的记录', async function () {
    mock.as('openid_A')
    const first = ok(await call('records.list', { since: 0 }))
    const second = ok(await call('records.list', { since: first.serverTime + 1000 }))
    assert.strictEqual(second.records.length, 0)
  })

  await testAsync('records.list 分页：hasMore 与 skip 正确', async function () {
    mock.as('openid_A')
    const page1 = ok(await call('records.list', { since: 0, limit: 2 }))
    assert.strictEqual(page1.records.length, 2)
    assert.strictEqual(page1.hasMore, true)

    const page2 = ok(await call('records.list', { since: 0, limit: 2, skip: 2 }))
    assert.ok(page2.records.length >= 1)

    const ids1 = page1.records.map(function (r) { return r._id })
    const ids2 = page2.records.map(function (r) { return r._id })
    const dup = ids1.filter(function (id) { return ids2.indexOf(id) >= 0 })
    assert.strictEqual(dup.length, 0, '两页不应重复')

    const last = ok(await call('records.list', { since: 0, limit: 2, skip: 200 }))
    assert.strictEqual(last.records.length, 0)
    assert.strictEqual(last.hasMore, false)
  })

  console.log('\n[export]')

  await testAsync('导出 CSV 含表头与数据行', async function () {
    mock.as('openid_A')
    const data = ok(await call('records.export', {
      from: at(D1, '00:00'),
      to: at(D2, '23:59')
    }))
    assert.ok(data.rows >= 2, '应有至少 2 行数据')
    assert.ok(data.csv.indexOf('日期,类型,开始') === 1, 'CSV 应带 BOM 与表头')
    assert.ok(/\.csv$/.test(data.filename))
    const lines = data.csv.replace(/^\ufeff/, '').split('\r\n')
    assert.strictEqual(lines.length, data.rows + 1)
  })

  await testAsync('导出替换了逗号不会破坏列', async function () {
    mock.as('openid_A')
    const rec = feedRecord('r_note_1', at(D1, '15:00'), at(D1, '15:10'), {
      feedKind: 'formula', amountMl: 60, note: '有点,吐奶 "偏多"'
    })
    ok(await call('records.upsert', { record: rec }))
    const data = ok(await call('records.export', {
      from: at(D1, '00:00'),
      to: at(D2, '23:59')
    }))
    assert.ok(data.csv.indexOf('"有点,吐奶 ""偏多"""') > 0)
  })

  console.log('\n[backup]')

  await testAsync('手动备份生成云端快照', async function () {
    mock.as('openid_A')
    const res = await backup.main({ scope: 'family' })
    assert.strictEqual(res.ok, true, JSON.stringify(res.error))
    assert.ok(res.data.count >= 2)
    assert.ok(/^family-/.test(res.data.fileName))
    assert.ok(mock.store.backups.length >= 1)
    assert.ok(/^cloud:\/\//.test(mock.store.backups[0].fileID))
  })

  await testAsync('定时备份覆盖所有家庭组', async function () {
    mock.as('')
    const res = await backup.main({})
    assert.strictEqual(res.ok, true)
    assert.strictEqual(res.data.families, mock.store.families.length)
    assert.strictEqual(res.data.errors.length, 0)
  })

  console.log('\n[unknown action]')

  await testAsync('未知 action 返回明确错误', async function () {
    mock.as('openid_A')
    err(await call('nope.nope'), 'BAD_ACTION')
  })

  console.log('\n结果：' + passed + ' 通过，' + failed + ' 失败\n')
  uninstall()
  process.exit(failed ? 1 : 0)
}

main().catch(function (e) {
  console.error('测试运行出错：', e)
  uninstall()
  process.exit(1)
})

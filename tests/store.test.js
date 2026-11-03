/**
 * 本地缓存 + 同步引擎单测（打桩 wx.storage 与云函数）
 * 运行：node tests/store.test.js
 */
const assert = require('assert')

// 必须在 require store 之前准备好 wx
const memory = {}
global.wx = {
  getStorageSync: function (key) {
    if (memory[key] === undefined) return ''
    return JSON.parse(JSON.stringify(memory[key]))
  },
  setStorageSync: function (key, value) {
    memory[key] = JSON.parse(JSON.stringify(value))
  }
}

const store = require('../miniprogram/utils/store')

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

function makeApi() {
  const server = new Map()
  let clock = 1000000
  const api = {
    server: server,
    offline: false,
    call: function (action, payload) {
      if (api.offline) {
        const e = new Error('network down')
        e.code = 'NETWORK'
        return Promise.reject(e)
      }
      clock += 100
      if (action === 'records.upsert') {
        const doc = Object.assign({}, payload.record, {
          updatedAt: clock,
          familyId: 'fam_test'
        })
        server.set(doc._id, doc)
        return Promise.resolve(doc)
      }
      if (action === 'records.list') {
        const since = payload.since || 0
        const skip = payload.skip || 0
        const size = api.pageSize || 1000
        const all = []
        server.forEach(function (r) {
          if (r.updatedAt > since) all.push(JSON.parse(JSON.stringify(r)))
        })
        all.sort(function (a, b) { return a.updatedAt - b.updatedAt })
        const page = all.slice(skip, skip + size)
        return Promise.resolve({
          records: page,
          count: page.length,
          hasMore: page.length === size,
          serverTime: clock
        })
      }
      return Promise.reject(new Error('unknown action ' + action))
    }
  }
  return api
}

function rec(id, startAt, extra) {
  return Object.assign({
    _id: id,
    type: 'sleep',
    startAt: startAt,
    endAt: startAt + 3600000,
    deleted: false
  }, extra || {})
}

async function main() {
  // 整个用例共用一个"服务端"，模拟真实后端在测试期间持续存在
  const shared = makeApi()

  console.log('\n[离线优先写入]')

  await test('新记录立刻可读，且不依赖网络', async function () {
    store.reset()
    store.put(rec('r_local_1', 1000))
    const list = store.list()
    assert.strictEqual(list.length, 1)
    assert.strictEqual(list[0]._id, 'r_local_1')
    assert.strictEqual(store.pendingCount(), 1)
  })

  await test('断网时同步失败，但数据仍在本机', async function () {
    const api = shared
    api.offline = true
    let err = null
    try {
      await store.sync(api)
    } catch (e) {
      err = e
    }
    assert.ok(err, '应抛出网络错误')
    assert.strictEqual(err.code, 'NETWORK')
    assert.strictEqual(store.list().length, 1, '本地记录不能丢')
    assert.strictEqual(store.pendingCount(), 1, '仍待上传')
  })

  console.log('\n[联网补传]')

  await test('恢复网络后自动补传，dirty 清零', async function () {
    const api = shared
    api.offline = false
    const res = await store.sync(api)
    assert.strictEqual(res.pushed, 1)
    assert.strictEqual(store.pendingCount(), 0)
    assert.ok(api.server.has('r_local_1'), '服务端应有这条记录')
  })

  await test('服务端返回的 familyId 会落到本地', async function () {
    const local = store.get('r_local_1')
    assert.strictEqual(local.familyId, 'fam_test')
    assert.strictEqual(local.dirty, false)
  })

  await test('重复同步是幂等的（不会产生重复记录）', async function () {
    const api = shared
    api.server.set('r_local_1', Object.assign({}, store.get('r_local_1')))
    await store.sync(api)
    await store.sync(api)
    assert.strictEqual(store.list().filter(function (r) { return r._id === 'r_local_1' }).length, 1)
    assert.strictEqual(store.pendingCount(), 0)
  })

  await test('单条记录被服务端拒绝不会阻塞其他记录', async function () {
    const api = shared
    const origCall = api.call
    api.call = function (action, payload) {
      if (action === 'records.upsert' && payload.record._id === 'r_bad_1') {
        const e = new Error('数据校验未通过')
        e.code = 'BAD_RECORD'
        return Promise.reject(e)
      }
      return origCall(action, payload)
    }

    store.put(rec('r_bad_1', 1000))
    store.put(rec('r_good_1', 2000))
    await store.sync(api)

    assert.strictEqual(api.server.has('r_good_1'), true, '正常记录应传上去')
    assert.ok(store.get('r_bad_1').syncError, '异常记录应被标记')
    assert.strictEqual(store.failedCount(), 1)
    assert.strictEqual(store.get('r_bad_1').dirty, true, '异常记录仍待处理，数据不丢')

    api.call = origCall
    store.patch('r_bad_1', { endAt: 1500 })  // 用户修正后会重试
    await store.sync(api)
    assert.strictEqual(store.failedCount(), 0)
    assert.strictEqual(store.pendingCount(), 0)
  })

  console.log('\n[多设备]')

  await test('能拉到其他设备新增的记录', async function () {
    const api = shared
    // 模拟另一台设备写入
    api.call('records.upsert', { record: rec('r_other_1', 5000) })
    await store.sync(api)
    const ids = store.list().map(function (r) { return r._id })
    assert.ok(ids.indexOf('r_other_1') >= 0)
  })

  await test('本地未推送的修改不会被远端旧版本覆盖', async function () {
    const api = shared

    // 服务端已有 r_local_1
    api.server.set('r_local_1', {
      _id: 'r_local_1',
      type: 'sleep',
      startAt: 1000,
      endAt: 2000,
      deleted: false,
      updatedAt: 900000,
      familyId: 'fam_test'
    })

    // 本地改结束时间（dirty）
    store.patch('r_local_1', { endAt: 9999 })
    assert.strictEqual(store.get('r_local_1').dirty, true)

    await store.sync(api)

    // 推送后服务端与本地都应是新值
    assert.strictEqual(store.get('r_local_1').endAt, 9999)
    assert.strictEqual(api.server.get('r_local_1').endAt, 9999)
    assert.strictEqual(store.get('r_local_1').dirty, false)
  })

  await test('记录较多时分页拉取，不丢不重', async function () {
    const api = shared
    api.pageSize = 2
    for (let i = 0; i < 5; i++) {
      await api.call('records.upsert', { record: rec('r_page_' + i, 10000 + i) })
    }

    store.reset()
    const res = await store.sync(api)
    api.pageSize = 1000

    const ids = store.list()
      .map(function (r) { return r._id })
      .filter(function (id) { return id.indexOf('r_page_') === 0 })
    assert.strictEqual(ids.length, 5, '5 条都要拉到，实际 ' + ids.length)
    assert.strictEqual(new Set(ids).size, 5, '不应重复')
    assert.ok(res.pulled >= 5)
  })

  console.log('\n[删除]')

  await test('软删除：列表消失但仍可查到，且会同步到服务端', async function () {
    const api = shared
    await store.sync(api)

    store.remove('r_other_1')
    assert.strictEqual(store.list().filter(function (r) { return r._id === 'r_other_1' }).length, 0)

    const raw = store.get('r_other_1')
    assert.strictEqual(raw.deleted, true)
    assert.strictEqual(raw.dirty, true)

    await store.sync(api)
    assert.strictEqual(api.server.get('r_other_1').deleted, true)
    assert.strictEqual(store.pendingCount(), 0)
  })

  await test('删除能被另一台设备拉到', async function () {
    const api = shared
    // 另一个空的本地状态模拟新设备
    store.reset()
    await store.sync(api)
    const hit = store.get('r_other_1')
    assert.ok(hit, '应拉到该记录')
    assert.strictEqual(hit.deleted, true)
    assert.strictEqual(store.list().filter(function (r) { return r._id === 'r_other_1' }).length, 0)
  })

  console.log('\n[本地存储]')

  await test('数据写入 Storage，进程重启后仍在', async function () {
    store.put(rec('r_persist_1', 4000))
    assert.ok(memory['bc:store:v1'], 'Storage 里应有数据')
    const dump = JSON.stringify(memory['bc:store:v1'])
    assert.ok(dump.indexOf('r_persist_1') >= 0, '记录应序列化进 Storage')
    assert.strictEqual(store.get('r_persist_1')._id, 'r_persist_1')
  })

  await test('reset 清空本机缓存', async function () {
    store.reset()
    assert.strictEqual(store.list().length, 0)
    assert.strictEqual(store.pendingCount(), 0)
    assert.strictEqual(store.lastSyncAt(), 0)
  })

  await test('dropSynced 只保留未上传的记录', async function () {
    const api = shared
    store.reset()
    store.put(rec('r_keep_1', 2000))
    await store.sync(api)
    store.put(rec('r_dirty_1', 3000))

    const before = store.list().map(function (r) { return r._id })
    assert.ok(before.indexOf('r_keep_1') >= 0)
    assert.ok(before.indexOf('r_dirty_1') >= 0)

    store.dropSynced()
    const ids = store.list().map(function (r) { return r._id })
    assert.deepStrictEqual(ids, ['r_dirty_1'], '已同步的被丢弃，未上传的保留')
    assert.strictEqual(store.lastSyncAt(), 0, '游标重置，下次会全量拉取')
  })

  console.log('\n结果：' + passed + ' 通过，' + failed + ' 失败\n')
  process.exit(failed ? 1 : 0)
}

main().catch(function (e) {
  console.error(e)
  process.exit(1)
})

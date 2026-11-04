/**
 * 传输层测试：验证 TRANSPORT='cloud' 时 api.js 的分派与错误映射。
 * 运行：node tests/transport.test.js
 *
 * 只测当前生效的传输模式；如果将来切回 'http'，本测试会自动跳过。
 */
const assert = require('assert')

const calls = []
let nextResult = null
let nextFail = null

global.wx = {
  getStorageSync: function () { return '' },
  setStorageSync: function () {},
  login: function (opt) { if (opt && opt.fail) opt.fail({}) },
  cloud: {
    callFunction: function (opt) {
      calls.push(opt)
      if (nextFail) {
        const e = nextFail
        nextFail = null
        return opt.fail(e)
      }
      const result = nextResult !== null ? nextResult : { ok: true, data: { echoed: opt.data } }
      nextResult = null
      return opt.success({ result: result })
    }
  }
}

const config = require('../miniprogram/config')

if (config.TRANSPORT !== 'cloud') {
  console.log('\n跳过传输层测试：当前 TRANSPORT = ' + config.TRANSPORT + '（本测试针对 cloud 模式）\n')
  process.exit(0)
}

const api = require('../miniprogram/utils/api')

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

async function main() {
  console.log('\n[cloud 模式分派]')

  await test('call() 走 wx.cloud.callFunction，并带上 action/payload', async function () {
    calls.length = 0
    const data = await api.call('family.bootstrap', { foo: 1 })
    assert.strictEqual(calls.length, 1)
    assert.strictEqual(calls[0].name, 'api')
    assert.deepStrictEqual(calls[0].data, { action: 'family.bootstrap', payload: { foo: 1 } })
    assert.deepStrictEqual(data.echoed, { action: 'family.bootstrap', payload: { foo: 1 } })
  })

  await test('payload 缺省时传空对象', async function () {
    calls.length = 0
    await api.call('records.list')
    assert.deepStrictEqual(calls[0].data.payload, {})
  })

  await test('callFn() 直接调用同名云函数（backup）', async function () {
    calls.length = 0
    await api.callFn('backup', { scope: 'family' })
    assert.strictEqual(calls[0].name, 'backup')
    assert.deepStrictEqual(calls[0].data, { scope: 'family' })
  })

  console.log('\n[错误映射]')

  await test('ok:false → 抛出带 code 的错误', async function () {
    nextResult = { ok: false, error: { code: 'ACTIVE_EXISTS', message: '还在计时', data: { activeId: 'r1' } } }
    let err = null
    try {
      await api.call('records.upsert', {})
    } catch (e) {
      err = e
    }
    assert.ok(err, '应抛出')
    assert.strictEqual(err.code, 'ACTIVE_EXISTS')
    assert.strictEqual(err.message, '还在计时')
    assert.strictEqual(err.data.activeId, 'r1')
  })

  await test('云函数调用失败 → 归一为 NETWORK', async function () {
    nextFail = { errMsg: 'cloud.callFunction:fail' }
    let err = null
    try {
      await api.call('records.list', {})
    } catch (e) {
      err = e
    }
    assert.ok(err)
    assert.strictEqual(err.code, 'NETWORK')
  })

  await test('云函数无返回 → EMPTY_RESULT', async function () {
    nextResult = null
    const orig = global.wx.cloud.callFunction
    global.wx.cloud.callFunction = function (opt) {
      return opt.success({})
    }
    let err = null
    try {
      await api.call('records.list', {})
    } catch (e) {
      err = e
    }
    global.wx.cloud.callFunction = orig
    assert.ok(err)
    assert.strictEqual(err.code, 'EMPTY_RESULT')
  })

  console.log('\n结果：' + passed + ' 通过，' + failed + ' 失败\n')
  process.exit(failed ? 1 : 0)
}

main().catch(function (e) {
  console.error(e)
  process.exit(1)
})

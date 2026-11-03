/**
 * 网页版端到端测试：真实 DOM（jsdom）+ 真实后端（进程内起服务）。
 *
 * 这是唯一需要额外依赖的测试：
 *   npm i -D jsdom
 *   npm run test:ui
 *
 * 没装 jsdom 时会自动跳过，不影响 `npm test`（其余测试零依赖）。
 */
const assert = require('assert')
const path = require('node:path')

let JSDOM = null
try {
  JSDOM = require('jsdom').JSDOM
} catch (e) {
  console.log('\n跳过网页版 UI 测试：未安装 jsdom')
  console.log('安装后再跑：npm i -D jsdom && npm run test:ui\n')
  process.exit(0)
}

process.env.TOKEN_SECRET = 'ui-test-secret'
process.env.WEB_PASSCODE = '246810'
process.env.DB_FILE = ':memory:'
process.env.BACKUP_DIR = path.join(require('node:os').tmpdir(), 'babycare-ui-backups')

const db = require('../server/db')
const serverMod = require('../server/index')

db.init(':memory:')

let passed = 0
let failed = 0

function check(name, cond, extra) {
  if (cond) {
    passed++
    console.log('  PASS  ' + name)
  } else {
    failed++
    console.log('  FAIL  ' + name + (extra ? '  → ' + extra : ''))
  }
}

function sleep(ms) {
  return new Promise(function (r) { setTimeout(r, ms) })
}

async function waitFor(fn, timeout) {
  const deadline = Date.now() + (timeout || 5000)
  while (Date.now() < deadline) {
    try {
      const v = fn()
      if (v) return v
    } catch (e) {}
    await sleep(50)
  }
  return null
}

async function main() {
  const server = serverMod.createServer()
  await new Promise(function (resolve) { server.listen(0, '127.0.0.1', resolve) })
  const BASE = 'http://127.0.0.1:' + server.address().port

  const html = await fetch(BASE + '/').then(function (r) { return r.text() })

  const dom = new JSDOM(html, {
    url: BASE + '/',
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    beforeParse: function (window) {
      window.fetch = function (input, init) {
        const url = typeof input === 'string' ? new URL(input, BASE).href : input.url
        return fetch(url, init)
      }
      window.confirm = function () { return true }
      window.prompt = function () { return '120' }
    }
  })

  await new Promise(function (resolve) {
    if (dom.window.document.readyState === 'complete') return resolve()
    dom.window.addEventListener('load', resolve)
    setTimeout(resolve, 3000)
  })

  const doc = dom.window.document
  const $ = function (s) { return doc.querySelector(s) }

  console.log('\n[登录]')
  check('登录框可见、主界面隐藏', !$('#login').classList.contains('hidden') && $('#app').classList.contains('hidden'))

  $('#passcode').value = '246810'
  $('#login-btn').dispatchEvent(new dom.window.Event('click'))

  const loggedIn = await waitFor(function () { return !$('#app').classList.contains('hidden') }, 8000)
  check('口令登录成功', !!loggedIn, $('#login-err').textContent)
  check('家庭名已显示', ($('#family-name').textContent || '').length > 0)

  console.log('\n[睡眠打卡]')
  await waitFor(function () { return $('#sleep-btn').dataset.action === 'start-sleep' })

  $('#sleep-btn').dispatchEvent(new dom.window.Event('click'))
  const started = await waitFor(function () { return $('#sleep-btn').dataset.action === 'end-sleep' }, 8000)
  check('点击后进入进行中', !!started)
  check('按钮文案变为「醒了」', $('#sleep-btn').textContent.trim() === '醒了')
  check('显示已睡时长', /已睡/.test($('#sleep-headline').textContent))

  check('时间轴出现睡眠块',
    !!(await waitFor(function () { return $('#tl-sleep').querySelectorAll('.tl-block').length > 0 })))
  check('最近记录出现条目',
    !!(await waitFor(function () { return $('#recent').querySelectorAll('.item').length > 0 })))

  $('#sleep-btn').dispatchEvent(new dom.window.Event('click'))
  check('结束后回到「开始睡觉」',
    !!(await waitFor(function () { return $('#sleep-btn').dataset.action === 'start-sleep' }, 8000)))

  console.log('\n[喂奶]')
  const feedBtn = await waitFor(function () {
    return $('#feed-actions').querySelector('[data-action="breast-left"]')
  })
  check('喂奶按钮组存在', !!feedBtn)
  if (feedBtn) {
    feedBtn.dispatchEvent(new dom.window.Event('click', { bubbles: true }))
    const feeding = await waitFor(function () {
      return $('#feed-actions').querySelector('[data-action="end-feed"]')
    }, 8000)
    check('亲喂开始后出现「结束」', !!feeding)
    if (feeding) {
      feeding.dispatchEvent(new dom.window.Event('click', { bubbles: true }))
      check('结束后回到按钮组', !!(await waitFor(function () {
        return $('#feed-actions').querySelector('[data-action="breast-left"]')
      }, 8000)))
    }
  }

  console.log('\n[统计与设置]')
  doc.querySelector('[data-view="stats"]').dispatchEvent(new dom.window.Event('click'))
  await sleep(700)
  check('统计列表有日期行', $('#stats-list').querySelectorAll('.day-row').length > 0)
  check('统计摘要 4 格', $('#stats-summary').querySelectorAll('.stat').length === 4)

  doc.querySelector('[data-view="settings"]').dispatchEvent(new dom.window.Event('click'))
  await sleep(200)
  check('显示 6 位邀请码', /^[A-Z0-9]{6}$/.test(($('#invite-code').textContent || '').trim()))
  check('显示成员数', /\d/.test($('#member-count').textContent))

  console.log('\n[数据一致性]')
  const token = dom.window.localStorage.getItem('bc_token')
  check('token 持久化到 localStorage', !!token)

  const res = await fetch(BASE + '/api', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
    body: JSON.stringify({ action: 'records.list', payload: { since: 0 } })
  }).then(function (r) { return r.json() })

  check('后端确实存下了记录', res.ok && res.data.records.length >= 2,
    '条数=' + (res.ok ? res.data.records.length : 'N/A'))

  dom.window.close()
  await new Promise(function (resolve) { server.close(resolve) })
  db.close()

  console.log('\n结果：' + passed + ' 通过，' + failed + ' 失败\n')
  process.exit(failed ? 1 : 0)
}

main().catch(function (e) {
  console.error('UI 测试出错：', e)
  process.exit(1)
})

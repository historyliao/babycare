/* 宝宝作息 · 网页版（PWA）
 * 纯原生 JS，无构建、无框架。数据来自自建后端 /api。
 */
(function () {
  'use strict'

  var TOKEN_KEY = 'bc_token'
  var WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

  var state = {
    token: localStorage.getItem(TOKEN_KEY) || '',
    family: null,
    records: [],
    today: null,
    view: 'home',
    range: 7,
    busy: false
  }

  function $(sel) { return document.querySelector(sel) }

  function esc(s) {
    return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    })
  }

  function pad2(n) { return n < 10 ? '0' + n : '' + n }

  function dayKey(d) {
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate())
  }

  function fmtTime(ts) {
    var d = new Date(ts)
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes())
  }

  function fmtDuration(min) {
    var m = Math.max(0, Math.round(min || 0))
    var h = Math.floor(m / 60)
    var r = m % 60
    if (h <= 0) return r + '分'
    if (r === 0) return h + '小时'
    return h + '小时' + r + '分'
  }

  function fmtDurationShort(min) {
    var m = Math.max(0, Math.round(min || 0))
    var h = Math.floor(m / 60)
    var r = m % 60
    if (h <= 0) return m + 'm'
    return r === 0 ? h + 'h' : h + 'h' + pad2(r) + 'm'
  }

  function toast(msg) {
    var el = $('#toast')
    el.textContent = msg
    el.classList.add('show')
    clearTimeout(toast._t)
    toast._t = setTimeout(function () { el.classList.remove('show') }, 2200)
  }

  /* ---------------- API ---------------- */

  function api(action, payload) {
    var headers = { 'Content-Type': 'application/json' }
    if (state.token) headers['Authorization'] = 'Bearer ' + state.token

    return fetch('/api', {
      method: 'POST',
      headers: headers,
      body: JSON.stringify({ action: action, payload: payload || {} })
    }).then(function (res) {
      return res.json().then(function (body) {
        if (!body || body.ok !== true) {
          var err = new Error((body && body.error && body.error.message) || '请求失败')
          err.code = (body && body.error && body.error.code) || 'UNKNOWN'
          throw err
        }
        return body.data
      })
    }).catch(function (e) {
      if (e instanceof TypeError) {
        var n = new Error('网络不可用')
        n.code = 'NETWORK'
        throw n
      }
      throw e
    })
  }

  function setSync(text, on) {
    var el = $('#sync-pill')
    el.textContent = text
    el.classList.toggle('on', !!on)
  }

  /* ---------------- 登录 ---------------- */

  function showLogin(msg) {
    $('#login').classList.remove('hidden')
    $('#app').classList.add('hidden')
    $('#login-err').textContent = msg || ''
  }

  function hideLogin() {
    $('#login').classList.add('hidden')
    $('#app').classList.remove('hidden')
  }

  function doLogin() {
    var passcode = $('#passcode').value.trim()
    if (!passcode) return
    $('#login-err').textContent = ''
    $('#login-btn').disabled = true

    api('auth.webLogin', { passcode: passcode }).then(function (data) {
      state.token = data.token
      localStorage.setItem(TOKEN_KEY, data.token)
      return boot()
    }).catch(function (e) {
      $('#login-err').textContent = e.message || '登录失败'
    }).then(function () {
      $('#login-btn').disabled = false
    })
  }

  /* ---------------- 数据 ---------------- */

  function pullRecords() {
    var all = []
    var skip = 0

    function page() {
      return api('records.list', { since: 0, skip: skip, limit: 500 }).then(function (res) {
        all = all.concat(res.records)
        if (res.hasMore && all.length < 5000) {
          skip += res.records.length
          return page()
        }
        state.records = all
          .filter(function (r) { return !r.deleted })
          .sort(function (a, b) { return b.startAt - a.startAt })
        return null
      })
    }
    return page()
  }

  function refreshToday() {
    var key = dayKey(new Date())
    return api('stats.day', { dayKey: key }).then(function (day) {
      state.today = day
      return day
    })
  }

  function refreshAll() {
    setSync('同步中…', false)
    return pullRecords()
      .then(refreshToday)
      .then(function () {
        setSync('已同步', true)
        render()
      })
      .catch(function (e) {
        if (e.code === 'UNAUTHORIZED') return showLogin('登录已过期，请重新输入口令')
        setSync('同步失败', false)
        toast(e.message || '同步失败')
      })
  }

  function boot() {
    return api('family.bootstrap', {}).then(function (data) {
      state.family = data.family
      hideLogin()
      return refreshAll()
    }).catch(function (e) {
      if (e.code === 'UNAUTHORIZED' || e.code === 'NO_FAMILY') {
        showLogin('')
      } else {
        showLogin(e.message || '无法连接服务')
      }
    })
  }

  /* ---------------- 渲染 ---------------- */

  function render() {
    var d = new Date()
    $('#today-label').textContent = (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + WEEK[d.getDay()]
    $('#family-name').textContent = (state.family && state.family.name) || '我的家庭'

    renderSummary()
    renderSleep()
    renderFeed()
    renderTimeline()
    renderRecent()

    if (state.view === 'stats') renderStats()
    if (state.view === 'settings') renderSettings()
  }

  function renderSummary() {
    var s = state.today || { sleepMin: 0, nightMin: 0, napCount: 0, feedCount: 0, feedMl: 0 }
    $('#summary').innerHTML = [
      stat(fmtDuration(s.sleepMin), '今日睡眠'),
      stat(fmtDuration(s.nightMin), '夜间'),
      stat(String(s.napCount), '小睡次数'),
      stat(s.feedCount + '次', s.feedMl ? s.feedMl + 'ml' : '今日喂奶')
    ].join('')
  }

  function stat(num, label) {
    return '<div class="stat"><b>' + esc(num) + '</b><span>' + esc(label) + '</span></div>'
  }

  function activeOf(type) {
    var best = null
    state.records.forEach(function (r) {
      if (r.type !== type || r.endAt) return
      if (!best || r.startAt > best.startAt) best = r
    })
    return best
  }

  function renderSleep() {
    var active = activeOf('sleep')
    var s = state.today || {}
    var sub = $('#sleep-sub')
    var btn = $('#sleep-btn')
    var head = $('#sleep-headline')

    if (active) {
      head.textContent = '已睡 ' + fmtDuration((Date.now() - active.startAt) / 60000)
      sub.textContent = '入睡于 ' + fmtTime(active.startAt)
      btn.textContent = '醒了'
      btn.dataset.action = 'end-sleep'
    } else {
      head.textContent = fmtDuration(s.sleepMin || 0)
      var lastWake = null
      state.records.forEach(function (r) {
        if (r.type !== 'sleep' || !r.endAt) return
        if (!lastWake || r.endAt > lastWake.endAt) lastWake = r
      })
      sub.textContent = lastWake ? '上次醒来 ' + fmtTime(lastWake.endAt) : '今天还没有记录'
      btn.textContent = '开始睡觉'
      btn.dataset.action = 'start-sleep'
    }
  }

  function renderFeed() {
    var active = activeOf('feed')
    var s = state.today || {}
    var sub = $('#feed-sub')
    var head = $('#feed-headline')
    var actions = $('#feed-actions')

    if (active) {
      head.textContent = '已喂 ' + fmtDuration((Date.now() - active.startAt) / 60000)
      sub.textContent = (active.side === 'left' ? '亲喂·左侧' : '亲喂·右侧') + ' · ' + fmtTime(active.startAt)
      actions.innerHTML =
        '<button class="btn btn-line" data-action="switch-side">换到' +
        (active.side === 'left' ? '右侧' : '左侧') + '</button>' +
        '<button class="btn btn-primary" data-action="end-feed">结束</button>'
    } else {
      head.textContent = s.feedCount ? '今日 ' + s.feedCount + ' 次' : ''
      sub.textContent = s.feedMl ? s.feedMl + 'ml' : ''
      actions.innerHTML =
        '<button class="btn btn-line" data-action="breast-left">亲喂·左</button>' +
        '<button class="btn btn-line" data-action="breast-right">亲喂·右</button>' +
        '<button class="btn btn-line" data-action="bottle">瓶喂</button>'
    }
  }

  function renderTimeline() {
    var day = state.today || { sessions: [], feeds: [] }

    function block(fromMin, toMin, cls) {
      var left = (fromMin / 1440) * 100
      var width = ((toMin - fromMin) / 1440) * 100
      if (left < 0) left = 0
      if (width < 0.5) width = 0.5
      if (left + width > 100) width = 100 - left
      return '<div class="tl-block ' + cls + '" style="left:' + left.toFixed(3) + '%;width:' + width.toFixed(3) + '%"></div>'
    }

    $('#tl-sleep').innerHTML = (day.sessions || []).map(function (s) {
      return block(s.fromMin, s.toMin, 'sleep')
    }).join('')

    $('#tl-feed').innerHTML = (day.feeds || []).map(function (f) {
      return block(f.fromMin, Math.max(f.toMin, f.fromMin), 'feed')
    }).join('')
  }

  function describe(r) {
    if (r.type === 'sleep') {
      return {
        cls: 'sleep', icon: '睡', title: '睡眠',
        time: fmtTime(r.startAt) + ' - ' + (r.endAt ? fmtTime(r.endAt) : '进行中'),
        right: r.endAt ? fmtDuration((r.endAt - r.startAt) / 60000) : '进行中'
      }
    }
    var kinds = { breast: '亲喂', bottle_breast: '瓶喂母乳', formula: '配方奶' }
    var sides = { left: '左侧', right: '右侧', both: '双侧' }
    var title = (kinds[r.feedKind] || '喂奶') + (r.side ? '·' + (sides[r.side] || '') : '')
    if (r.feedKind !== 'breast' && r.amountMl) title += ' ' + r.amountMl + 'ml'
    return {
      cls: 'feed', icon: '奶', title: title,
      time: fmtTime(r.startAt) + (r.feedKind === 'breast' && r.endAt ? ' - ' + fmtTime(r.endAt) : ''),
      right: r.feedKind === 'breast' && r.endAt ? fmtDuration((r.endAt - r.startAt) / 60000) : ''
    }
  }

  function renderRecent() {
    var list = state.records.slice(0, 8)
    $('#record-count').textContent = state.records.length ? '共 ' + state.records.length + ' 条' : ''

    if (!list.length) {
      $('#recent').innerHTML = '<p class="muted">还没有记录，点上面的按钮开始</p>'
      return
    }

    $('#recent').innerHTML = list.map(function (r) {
      var d = describe(r)
      return '<div class="item">' +
        '<div class="icon ' + d.cls + '">' + d.icon + '</div>' +
        '<div class="flex1"><div class="item-title">' + esc(d.title) + '</div>' +
        '<div class="item-sub">' + esc(d.time) + '</div></div>' +
        '<div class="item-right">' + esc(d.right) + '</div>' +
        '<button class="del" data-del="' + esc(r._id) + '">删除</button>' +
        '</div>'
    }).join('')
  }

  function renderStats() {
    var to = new Date()
    var from = new Date(to.getTime() - (state.range - 1) * 86400000)
    var toKey = dayKey(to)
    var fromKey = dayKey(from)

    $('#stats-list').innerHTML = '<p class="muted">加载中…</p>'

    api('stats.range', { fromKey: fromKey, toKey: toKey }).then(function (res) {
      var max = Math.max(60, res.maxSleepMin)
      var n = res.days.length || 1

      $('#stats-summary').innerHTML = [
        stat(fmtDuration(res.avgSleepMin), '日均睡眠'),
        stat(fmtDuration(res.totals.nightMin / n), '日均夜间'),
        stat(String(res.avgFeedCount), '日均喂奶'),
        stat(String(res.avgFeedMl), '日均 ml')
      ].join('')

      $('#stats-total').textContent = '合计 ' + fmtDuration(res.totals.sleepMin)

      $('#stats-list').innerHTML = res.days.slice().reverse().map(function (d) {
        var pct = Math.max(2, Math.round((d.sleepMin / max) * 100))
        return '<div class="day-row">' +
          '<div class="day-label">' + esc(d.dayKey.slice(5)) + '</div>' +
          '<div class="bar-wrap"><div class="bar" style="width:' + pct + '%"></div></div>' +
          '<div class="day-val">' + esc(fmtDurationShort(d.sleepMin)) + '</div>' +
          '</div>'
      }).join('') || '<p class="muted">暂无数据</p>'
    }).catch(function (e) {
      if (e.code === 'UNAUTHORIZED') return showLogin('登录已过期')
      $('#stats-list').innerHTML = '<p class="muted">' + esc(e.message || '加载失败') + '</p>'
    })
  }

  function renderSettings() {
    var f = state.family || {}
    $('#invite-code').textContent = f.inviteCode || '——'
    $('#member-count').textContent = f.memberCount || 0
  }

  /* ---------------- 操作 ---------------- */

  function genId() {
    return 'r_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
  }

  function createRecord(fields) {
    var rec = Object.assign({
      _id: genId(),
      type: 'sleep',
      startAt: Date.now(),
      endAt: null,
      deleted: false
    }, fields)

    return api('records.upsert', { record: rec }).then(refreshAll).catch(function (e) {
      if (e.code === 'ACTIVE_EXISTS' && e.data && e.data.activeId) {
        return api('records.upsert', {
          record: Object.assign({}, state.records.filter(function (r) {
            return r._id === e.data.activeId
          })[0], { endAt: rec.startAt })
        }).then(function () {
          return api('records.upsert', { record: rec })
        }).then(refreshAll)
      }
      throw e
    })
  }

  function patchRecord(id, fields) {
    var cur = state.records.filter(function (r) { return r._id === id })[0]
    if (!cur) return Promise.resolve()
    var next = Object.assign({}, cur, fields)
    return api('records.upsert', { record: next }).then(refreshAll)
  }

  function removeRecord(id) {
    return api('records.remove', { id: id }).then(refreshAll)
  }

  function ask(text) {
    return Promise.resolve(window.confirm(text))
  }

  function handleSleep() {
    var active = activeOf('sleep')
    if (active) {
      return patchRecord(active._id, { endAt: Date.now() }).then(function () { toast('已记录醒来') })
    }
    return createRecord({ type: 'sleep', startAt: Date.now(), endAt: null }).then(function () {
      toast('开始记录睡眠')
    })
  }

  function handleFeed(action) {
    var active = activeOf('feed')
    var now = Date.now()

    if (action === 'end-feed' && active) {
      return patchRecord(active._id, { endAt: now }).then(function () { toast('已记录喂奶') })
    }

    if (action === 'switch-side' && active) {
      var nextSide = active.side === 'left' ? 'right' : 'left'
      return patchRecord(active._id, { endAt: now }).then(function () {
        return createRecord({ type: 'feed', feedKind: 'breast', side: nextSide, startAt: now, endAt: null })
      }).then(function () { toast('已换到' + (nextSide === 'left' ? '左侧' : '右侧')) })
    }

    if (action === 'breast-left' || action === 'breast-right') {
      var side = action === 'breast-left' ? 'left' : 'right'
      return createRecord({ type: 'feed', feedKind: 'breast', side: side, startAt: now, endAt: null })
        .then(function () { toast('开始亲喂') })
    }

    if (action === 'bottle') {
      var ml = window.prompt('奶量（ml）', '120')
      if (!ml) return Promise.resolve()
      var n = parseInt(ml, 10)
      if (!(n > 0 && n <= 1000)) { toast('请输入 1-1000 的奶量'); return Promise.resolve() }
      var kind = window.confirm('点“确定”记为配方奶，点“取消”记为瓶喂母乳') ? 'formula' : 'bottle_breast'
      return createRecord({ type: 'feed', feedKind: kind, amountMl: n, startAt: now, endAt: now })
        .then(function () { toast('已记录 ' + n + 'ml') })
    }

    return Promise.resolve()
  }

  function run(promise) {
    if (state.busy) return
    state.busy = true
    promise.catch(function (e) {
      if (e.code === 'UNAUTHORIZED') return showLogin('登录已过期')
      toast(e.message || '操作失败')
    }).then(function () {
      state.busy = false
    })
  }

  function exportCsv() {
    var now = Date.now()
    setSync('导出中…', false)
    api('records.export', { from: now - 90 * 86400000, to: now }).then(function (res) {
      setSync('已同步', true)
      if (!res.rows) return toast('还没有可导出的记录')

      var blob = new Blob([res.csv], { type: 'text/csv;charset=utf-8' })
      var url = URL.createObjectURL(blob)
      var a = document.createElement('a')
      a.href = url
      a.download = res.filename
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      setTimeout(function () { URL.revokeObjectURL(url) }, 1000)
      toast('已导出 ' + res.rows + ' 条')
    }).catch(function (e) {
      setSync('同步失败', false)
      toast(e.message || '导出失败')
    })
  }

  function backupNow() {
    setSync('备份中…', false)
    api('backup.run', {}).then(function (res) {
      setSync('已同步', true)
      toast('已备份 ' + res.count + ' 条到 ' + (res.target.indexOf('oss://') === 0 ? '阿里云 OSS' : '服务器'))
    }).catch(function (e) {
      setSync('同步失败', false)
      toast(e.message || '备份失败')
    })
  }

  function switchView(view) {
    state.view = view
    ;['home', 'stats', 'settings'].forEach(function (v) {
      $('#view-' + v).classList.toggle('hidden', v !== view)
    })
    document.querySelectorAll('.tab').forEach(function (el) {
      el.classList.toggle('on', el.dataset.view === view)
    })
    if (view === 'stats') renderStats()
    if (view === 'settings') renderSettings()
  }

  /* ---------------- 事件 ---------------- */

  $('#login-btn').addEventListener('click', doLogin)
  $('#passcode').addEventListener('keydown', function (e) {
    if (e.key === 'Enter') doLogin()
  })

  document.querySelectorAll('.tab').forEach(function (el) {
    el.addEventListener('click', function () { switchView(el.dataset.view) })
  })

  $('#range-seg').addEventListener('click', function (e) {
    var btn = e.target.closest('[data-range]')
    if (!btn) return
    state.range = Number(btn.dataset.range)
    document.querySelectorAll('#range-seg .seg-item').forEach(function (el) {
      el.classList.toggle('on', el === btn)
    })
    renderStats()
  })

  $('#sleep-btn').addEventListener('click', function () {
    run(handleSleep())
  })

  $('#feed-actions').addEventListener('click', function (e) {
    var btn = e.target.closest('[data-action]')
    if (!btn) return
    run(handleFeed(btn.dataset.action))
  })

  $('#recent').addEventListener('click', function (e) {
    var btn = e.target.closest('[data-del]')
    if (!btn) return
    ask('删除这条记录？').then(function (yes) {
      if (!yes) return
      run(removeRecord(btn.dataset.del))
    })
  })

  $('#export-btn').addEventListener('click', exportCsv)
  $('#backup-btn').addEventListener('click', backupNow)

  $('#logout-btn').addEventListener('click', function () {
    ask('退出登录？记录不会删除。').then(function (yes) {
      if (!yes) return
      localStorage.removeItem(TOKEN_KEY)
      state.token = ''
      location.reload()
    })
  })

  // 每分钟刷新"已睡多久"
  setInterval(function () {
    if (state.view === 'home' && state.token) {
      renderSleep()
      renderFeed()
    }
  }, 60000)

  /* ---------------- 启动 ---------------- */

  if (state.token) boot()
  else showLogin('')

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('/sw.js').catch(function () {})
    })
  }
})()

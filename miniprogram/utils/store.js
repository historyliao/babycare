/**
 * 本地缓存 + 同步引擎（离线优先）
 *
 * 设计要点：
 * 1. 写操作先落本机（wx.setStorageSync），UI 立即响应，不等网络。
 * 2. 每条本地修改打 dirty 标记；sync() 先推 dirty，再按 since 拉增量。
 * 3. 记录 _id 由客户端生成并直接作为云端 _id，所以推送天然幂等：
 *    网络超时重试不会产生重复记录。
 * 4. 删除是软删除（deleted=true），保证多设备之间能同步"删除"这一动作。
 * 5. sync 串行执行，避免多入口（onShow / 下拉 / 定时）并发打架。
 */

const KEY = 'bc:store:v1'
const BUF_MS = 2 * 60 * 1000 // 拉取增量时回看的缓冲窗口，防边界丢数据
const MAX_PULL_PAGES = 20 // 单次同步最多翻多少页，防止一次拉太多

// 只允许上行这些字段，防止把本地私有字段（dirty 等）写进云端
const SYNC_FIELDS = [
  '_id', 'type', 'startAt', 'endAt',
  'feedKind', 'side', 'amountMl', 'note', 'deleted'
]

let state = null
let syncChain = Promise.resolve()
let syncing = false

function blankState() {
  return { version: 1, records: {}, family: null, lastSyncAt: 0 }
}

function load() {
  if (state) return state
  let raw = null
  try {
    raw = wx.getStorageSync(KEY)
  } catch (e) {
    raw = null
  }
  state = raw && raw.records ? raw : blankState()
  if (!state.records) state.records = {}
  return state
}

function persist() {
  try {
    wx.setStorageSync(KEY, state)
    return true
  } catch (e) {
    // 超出 10MB 配额等极端情况：保留内存状态，提示上层
    console.error('[store] 本地持久化失败', e)
    return false
  }
}

/* ---------------- 读 ---------------- */

/** 未删除记录，按开始时间倒序 */
function list() {
  const s = load()
  const out = []
  Object.keys(s.records).forEach(function (k) {
    const r = s.records[k]
    if (r && !r.deleted) out.push(r)
  })
  out.sort(function (a, b) { return b.startAt - a.startAt })
  return out
}

/** 全部记录（含已删除、含未同步），统计用 */
function all() {
  const s = load()
  return Object.keys(s.records).map(function (k) { return s.records[k] })
}

function get(id) {
  return load().records[id] || null
}

function family() {
  return load().family
}

function pendingCount() {
  const s = load()
  let n = 0
  Object.keys(s.records).forEach(function (k) {
    if (s.records[k].dirty) n++
  })
  return n
}

/** 被服务端规则拒绝、需要用户处理的记录数 */
function failedCount() {
  const s = load()
  let n = 0
  Object.keys(s.records).forEach(function (k) {
    if (s.records[k].dirty && s.records[k].syncError) n++
  })
  return n
}

function lastSyncAt() {
  return load().lastSyncAt || 0
}

/* ---------------- 写 ---------------- */

function touch(rec, patch) {
  const now = Date.now()
  const next = Object.assign({}, rec, patch || {}, {
    updatedAt: now,
    _localRev: now,
    dirty: true,
    syncError: null
  })
  return next
}

/** 新增或整体覆盖一条本地记录（标记为待同步） */
function put(rec) {
  const s = load()
  const prev = s.records[rec._id]
  const merged = touch(prev || {}, rec)
  merged._id = rec._id
  s.records[rec._id] = merged
  persist()
  return merged
}

/** 局部修改 */
function patch(id, fields) {
  const s = load()
  const cur = s.records[id]
  if (!cur) return null
  const next = touch(cur, fields)
  s.records[id] = next
  persist()
  return next
}

/** 软删除 */
function remove(id) {
  return patch(id, { deleted: true })
}

function setFamily(fam) {
  const s = load()
  s.family = fam || null
  persist()
}

function reset() {
  state = blankState()
  persist()
}

/** 只重置同步游标（切换家庭组后需要重新全量拉取） */
function resetCursor() {
  const s = load()
  s.lastSyncAt = 0
  persist()
}

/**
 * 丢弃已同步过的本地记录，只保留还没上传的。
 * 切换家庭组后调用，避免把上一个家庭组的数据混进新家庭组的统计里。
 */
function dropSynced() {
  const s = load()
  Object.keys(s.records).forEach(function (k) {
    if (!s.records[k].dirty) delete s.records[k]
  })
  s.lastSyncAt = 0
  persist()
}

/* ---------------- 同步 ---------------- */

function strip(rec) {
  const o = {}
  SYNC_FIELDS.forEach(function (f) {
    if (rec[f] !== undefined) o[f] = rec[f]
  })
  return o
}

function applyServer(list) {
  const s = load()
  ;(list || []).forEach(function (r) {
    if (!r || !r._id) return
    const cur = s.records[r._id]
    // 本地有未推送的修改 → 以本地为准，下次推送覆盖云端
    if (cur && cur.dirty) return
    s.records[r._id] = Object.assign({}, r, { dirty: false })
  })
  persist()
}

function doSync(api) {
  const s = load()
  // syncError 的记录本轮跳过，避免一条脏数据卡住整个队列；
  // 用户编辑/删除该记录时 syncError 会被清掉，下轮自动重试。
  const dirtyIds = Object.keys(s.records).filter(function (k) {
    const r = s.records[k]
    return r.dirty && !r.syncError
  })

  let chain = Promise.resolve()
  let pushed = 0

  dirtyIds.forEach(function (id) {
    chain = chain.then(function () {
      const rec = load().records[id]
      if (!rec || !rec.dirty || rec.syncError) return null
      return api.call('records.upsert', { record: strip(rec) }).then(function (saved) {
        const cur = load().records[id]
        // 推送期间本地又被改过 → 保留本地 dirty，下轮再推
        if (cur && cur.dirty && cur._localRev !== rec._localRev) return
        load().records[id] = Object.assign({}, saved, { dirty: false, syncError: null })
        persist()
        pushed++
      }).catch(function (err) {
        const code = err && err.code
        // 服务端永久性拒绝：标记出来交给用户处理，但不阻塞其他记录
        if (code === 'BAD_RECORD' || code === 'FORBIDDEN' || code === 'NOT_FOUND') {
          const cur = load().records[id]
          if (cur) {
            cur.syncError = (err && err.message) || '数据校验未通过'
            persist()
          }
          return null
        }
        throw err
      })
    })
  })

  return chain.then(function () {
    const since = Math.max(0, (load().lastSyncAt || 0) - BUF_MS)
    let skip = 0
    let pages = 0
    let serverTime = 0
    let cursorTs = 0
    let pulled = 0
    let incomplete = false

    function pullPage() {
      return api.call('records.list', { since: since, skip: skip }).then(function (res) {
        if (!serverTime) serverTime = res.serverTime || Date.now()
        applyServer(res.records)

        const list = res.records || []
        pulled += list.length
        list.forEach(function (r) {
          if (r.updatedAt && r.updatedAt > cursorTs) cursorTs = r.updatedAt
        })

        pages++
        if (res.hasMore) {
          if (pages >= MAX_PULL_PAGES) {
            incomplete = true
            return null
          }
          skip += list.length
          return pullPage()
        }
        return null
      })
    }

    return pullPage().then(function () {
      const st = load()
      // 拉完用服务端时间推进游标；没拉完则用最后一条的 updatedAt，
      // 保证下次从断点继续，不会跳过任何记录。
      st.lastSyncAt = incomplete ? cursorTs : (serverTime || Date.now())
      persist()
      return { pushed: pushed, pulled: pulled, incomplete: incomplete, serverTime: st.lastSyncAt }
    })
  })
}

/**
 * 串行同步。失败会 reject（调用方决定是否提示），但不会破坏本地数据。
 */
function sync(api) {
  if (syncing) return syncChain.catch(function () { return { skipped: true } })
  syncing = true
  syncChain = doSync(api).then(
    function (r) { syncing = false; return r },
    function (e) { syncing = false; throw e }
  )
  return syncChain
}

function isSyncing() {
  return syncing
}

module.exports = {
  load: load,
  list: list,
  all: all,
  get: get,
  family: family,
  put: put,
  patch: patch,
  remove: remove,
  setFamily: setFamily,
  pendingCount: pendingCount,
  failedCount: failedCount,
  lastSyncAt: lastSyncAt,
  sync: sync,
  isSyncing: isSyncing,
  reset: reset,
  resetCursor: resetCursor,
  dropSynced: dropSynced,
  strip: strip
}

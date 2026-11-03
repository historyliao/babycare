/**
 * 内存版 wx-server-sdk 打桩，用于在没有微信环境时验证云函数业务逻辑。
 * 只实现 api / backup 用到的子集：where / orderBy / skip / limit / get /
 * add / doc().get|set|update|remove / command 的 gt|gte|lt|eq|neq|and。
 */
const Module = require('module')

function createStore() {
  return { users: [], families: [], records: [], backups: [], seq: 0 }
}

function clone(o) {
  return JSON.parse(JSON.stringify(o))
}

function makeCommand() {
  function op(name, value) {
    const node = {
      __op: name,
      value: value,
      and: function (other) {
        return { __op: 'and', conds: [node, other] }
      }
    }
    return node
  }
  return {
    gt: function (v) { return op('gt', v) },
    gte: function (v) { return op('gte', v) },
    lt: function (v) { return op('lt', v) },
    lte: function (v) { return op('lte', v) },
    eq: function (v) { return op('eq', v) },
    neq: function (v) { return op('neq', v) }
  }
}

function matchField(value, cond) {
  if (cond && cond.__op) {
    switch (cond.__op) {
      case 'gt': return value > cond.value
      case 'gte': return value >= cond.value
      case 'lt': return value < cond.value
      case 'lte': return value <= cond.value
      case 'eq': return value === cond.value
      case 'neq': return value !== cond.value
      case 'and': return cond.conds.every(function (c) { return matchField(value, c) })
      default: return false
    }
  }
  if (Array.isArray(value)) return value.indexOf(cond) >= 0
  return value === cond
}

function matches(doc, where) {
  const keys = Object.keys(where)
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i]
    if (!matchField(doc[k], where[k])) return false
  }
  return true
}

function notFound() {
  const e = new Error('document not found')
  e.errCode = -1
  return e
}

function createMock() {
  const store = createStore()
  const command = makeCommand()

  function docApi(name, id) {
    return {
      get: async function () {
        const doc = store[name].find(function (d) { return d._id === id })
        if (!doc) throw notFound()
        return { data: clone(doc) }
      },
      set: async function (arg) {
        const i = store[name].findIndex(function (d) { return d._id === id })
        const doc = Object.assign({}, arg.data, { _id: id })
        if (i >= 0) store[name][i] = doc
        else store[name].push(doc)
        return { _id: id }
      },
      update: async function (arg) {
        const doc = store[name].find(function (d) { return d._id === id })
        if (!doc) throw notFound()
        Object.assign(doc, arg.data)
        return { stats: { updated: 1 } }
      },
      remove: async function () {
        const i = store[name].findIndex(function (d) { return d._id === id })
        if (i < 0) throw notFound()
        store[name].splice(i, 1)
        return { stats: { removed: 1 } }
      }
    }
  }

  function collection(name) {
    if (!store[name]) throw new Error('collection not exists: ' + name)
    const q = { where: null, order: null, skipN: 0, limitN: 100 }

    const api = {
      where: function (w) { q.where = w; return api },
      orderBy: function (field, dir) { q.order = { field: field, dir: dir }; return api },
      skip: function (n) { q.skipN = n; return api },
      limit: function (n) { q.limitN = n; return api },
      get: async function () {
        let rows = store[name].filter(function (d) { return !q.where || matches(d, q.where) })
        if (q.order) {
          const f = q.order.field
          const sign = q.order.dir === 'desc' ? -1 : 1
          rows = rows.slice().sort(function (a, b) {
            if (a[f] === b[f]) return 0
            return (a[f] > b[f] ? 1 : -1) * sign
          })
        }
        rows = rows.slice(q.skipN, q.skipN + q.limitN)
        return { data: rows.map(clone) }
      },
      add: async function (arg) {
        store.seq++
        const _id = arg.data._id || (name + '_' + store.seq)
        if (store[name].some(function (d) { return d._id === _id })) {
          const e = new Error('duplicate _id')
          e.errCode = -502001
          throw e
        }
        store[name].push(Object.assign({}, arg.data, { _id: _id }))
        return { _id: _id }
      },
      update: async function (arg) {
        const rows = store[name].filter(function (d) { return !q.where || matches(d, q.where) })
        rows.forEach(function (d) { Object.assign(d, arg.data) })
        return { stats: { updated: rows.length } }
      },
      doc: function (id) { return docApi(name, id) }
    }
    return api
  }

  const db = {
    command: command,
    collection: collection,
    createCollection: async function (name) {
      if (store[name]) {
        const e = new Error('collection exists')
        e.errCode = -501001
        throw e
      }
      store[name] = []
      return { ok: true }
    }
  }

  let openid = 'openid_A'

  const sdk = {
    DYNAMIC_CURRENT_ENV: 'test-env',
    init: function () {},
    database: function () { return db },
    getWXContext: function () { return { OPENID: openid } },
    uploadFile: async function (arg) {
      return { fileID: 'cloud://test/' + arg.cloudPath }
    },
    deleteFile: async function () { return { fileList: [] } }
  }

  return {
    store: store,
    sdk: sdk,
    as: function (id) { openid = id },
    install: function () {
      const orig = Module._load
      Module._load = function (request) {
        if (request === 'wx-server-sdk') return sdk
        return orig.apply(this, arguments)
      }
      return function uninstall() { Module._load = orig }
    }
  }
}

module.exports = { createMock: createMock }

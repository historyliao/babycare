/**
 * 客户端生成记录 ID。
 * 直接把它当作云数据库 _id 使用，保证"重试不会产生重复记录"（幂等）。
 */
let seq = 0

function genId(prefix) {
  seq = (seq + 1) % 1296
  const t = Date.now().toString(36)
  const s = seq.toString(36)
  const r = Math.random().toString(36).slice(2, 8)
  return (prefix || 'r') + '_' + t + s + r
}

module.exports = { genId }

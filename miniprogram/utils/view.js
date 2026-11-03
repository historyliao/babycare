/**
 * 视图层共享的格式化逻辑（页面只做数据绑定，不在 WXML 里算）
 */
const dateUtil = require('./date')
const config = require('../config')

const TZ = config.TZ_OFFSET_MIN

const KIND_LABEL = { breast: '亲喂', bottle_breast: '瓶喂母乳', formula: '配方奶' }
const SIDE_LABEL = { left: '左侧', right: '右侧', both: '双侧' }

/** 时间轴块的 left/width（百分比字符串） */
function blockStyle(fromMin, toMin) {
  let left = (fromMin / 1440) * 100
  let width = ((toMin - fromMin) / 1440) * 100
  if (left < 0) left = 0
  if (width < 0.45) width = 0.45
  if (left + width > 100) width = 100 - left
  return { left: left.toFixed(3) + '%', width: width.toFixed(3) + '%' }
}

/** 记录 → 列表项 */
function describeRecord(r) {
  if (r.type === 'sleep') {
    return {
      id: r._id,
      tone: 'sleep',
      icon: '睡',
      title: '睡眠',
      time: dateUtil.formatTime(r.startAt, TZ) + ' - ' +
        (r.endAt ? dateUtil.formatTime(r.endAt, TZ) : '进行中'),
      right: r.endAt ? dateUtil.formatDuration((r.endAt - r.startAt) / 60000) : '进行中'
    }
  }

  const kind = KIND_LABEL[r.feedKind] || '喂奶'
  const side = r.side ? '·' + SIDE_LABEL[r.side] : ''
  let title = kind + side
  let right = ''

  if (r.feedKind === 'breast') {
    right = r.endAt ? dateUtil.formatDuration((r.endAt - r.startAt) / 60000) : '进行中'
  } else {
    title = kind + (r.amountMl ? ' ' + r.amountMl + 'ml' : '')
    right = dateUtil.formatTime(r.startAt, TZ)
  }

  return {
    id: r._id,
    tone: 'feed',
    icon: '奶',
    title: title,
    time: dateUtil.formatTime(r.startAt, TZ) +
      (r.endAt && r.feedKind === 'breast' ? ' - ' + dateUtil.formatTime(r.endAt, TZ) : ''),
    right: right
  }
}

module.exports = {
  TZ: TZ,
  KIND_LABEL: KIND_LABEL,
  SIDE_LABEL: SIDE_LABEL,
  blockStyle: blockStyle,
  describeRecord: describeRecord
}

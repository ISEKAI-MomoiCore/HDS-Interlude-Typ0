/* Shared, side-effect-free timeline geometry. Times are UTC milliseconds. */
globalThis.TimelineModel = Object.freeze({
  minSpan: 20_000,
  maxSpan: 14 * 86400_000,
  clampSpan(span) { return Math.max(this.minSpan, Math.min(this.maxSpan, span)) },
  zoom(from, span, factor, anchor) {
    const next = this.clampSpan(span * factor)
    return { from: from + anchor * (span - next), span: next }
  },
  resize(from, to, time, side) {
    if (side === 'left') {
      const start = Math.max(to - this.maxSpan, Math.min(to - this.minSpan, time))
      return { from: start, span: to - start }
    }
    const end = Math.min(from + this.maxSpan, Math.max(from + this.minSpan, time))
    return { from, span: end - from }
  },
  wheelPixels(delta, mode, height) { return delta * (mode === 1 ? 16 : mode === 2 ? height : 1) },
  interval(start, end, from, span, width, minimum = 3) {
    if (end < from || start > from + span) return null
    const left = Math.max(0, (start - from) / span * width)
    return { left, width: Math.min(width - left, Math.max(minimum, (Math.min(end, from + span) - from) / span * width - left)) }
  },
  // 行分配只依赖时间数据（与视窗/缩放无关，且包含窗外项），拖动/缩放时行号稳定。
  // end==next.start（相接）视为不重叠（1ms 容差）——HDSI 剧本是连续单条。
  rows(items) {
    const ends = []; const result = new Map()
    for (const item of [...items].sort((a, b) => a.start - b.start || String(a.id).localeCompare(String(b.id)))) {
      let row = ends.findIndex(end => end <= item.start + 1)
      if (row < 0) { row = ends.length; ends.push(item.end) }
      else if (item.end > ends[row]) ends[row] = item.end
      result.set(item.id, row)
    }
    return result
  },
})

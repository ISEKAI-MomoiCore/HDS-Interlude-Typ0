const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const context = {}
vm.runInNewContext(fs.readFileSync('src/renderer/timeline-model.js', 'utf8'), context)
const model = context.TimelineModel
test('zoom preserves the mouse time and is reversible', () => {
  const a = model.zoom(100000, 3600000, Math.exp(0.2), 0.3)
  assert.ok(Math.abs(a.from + a.span * 0.3 - (100000 + 3600000 * 0.3)) < 0.001)
  const b = model.zoom(a.from, a.span, Math.exp(-0.2), 0.3)
  assert.ok(Math.abs(b.from - 100000) < 0.001)
})
test('resize limits preserve the non-moving endpoint', () => {
  const left = model.resize(0, 60000, 90000, 'left')
  assert.equal(left.from + left.span, 60000)
  assert.equal(left.span, 20000)
  const right = model.resize(0, 60000, -10000, 'right')
  assert.equal(right.from, 0)
  assert.equal(right.span, 20000)
})
test('wheel units integrate independently of event count', () => {
  assert.equal(model.wheelPixels(100, 0, 500), 10 * model.wheelPixels(10, 0, 500))
  assert.equal(model.wheelPixels(1, 1, 500), 16)
  assert.equal(model.wheelPixels(1, 2, 500), 500)
})
test('offscreen events are absent and overlapping clips have independent rows', () => {
  assert.equal(model.interval(0, 1, 10, 100, 800), null)
  const rows = model.rows(Array.from({ length: 50 }, (_, id) => ({ id, start: 20, end: 30 })))
  assert.equal(new Set(rows.values()).size, 50)
})
test('touching sequential segments share one row (script is a single strip)', () => {
  const rows = model.rows([
    { id: 0, start: 0, end: 100 },
    { id: 1, start: 100, end: 250 },
    { id: 2, start: 250, end: 400 },
  ])
  assert.deepEqual([...rows.values()], [0, 0, 0])
})
test('row assignment is viewport-independent and includes offscreen clips', () => {
  const items = [
    { id: 0, start: 0, end: 1000 },
    { id: 1, start: 500, end: 1500 },
    { id: 2, start: 2000, end: 2600 },
  ]
  // 同一份数据，无论顺序怎么打乱，重叠关系决定行号；窗外的项也参与分配。
  // （模型在 vm 沙箱里跑，返回值跨 realm，用 JSON 文本比较）
  assert.equal(JSON.stringify([...model.rows(items).entries()]), '[[0,0],[1,1],[2,0]]')
  assert.equal(JSON.stringify([...model.rows([...items].reverse()).entries()]), '[[0,0],[1,1],[2,0]]')
})
test('contained clip does not corrupt row end tracking', () => {
  const rows = model.rows([
    { id: 0, start: 0, end: 1000 },
    { id: 1, start: 100, end: 300 },
    { id: 2, start: 500, end: 800 },
  ])
  // 1、2 都套在 0 内部但彼此错开 → 复用第 1 行；行 0 的 end 保持 1000 不被缩短
  assert.equal(JSON.stringify([...rows.entries()]), '[[0,0],[1,1],[2,1]]')
  assert.equal(JSON.stringify([...model.rows([{ id: 3, start: 1000, end: 1200 }]).entries()]), '[[3,0]]')
})
test('renderer has no duplicate function declarations', () => {
  const source = fs.readFileSync('src/renderer/app.js', 'utf8')
  const names = [...source.matchAll(/^(?:async )?function\s+(\w+)\s*\(/gm)].map(match => match[1])
  assert.equal(new Set(names).size, names.length)
})
test('10k entries: row assignment and viewport culling hold a linear-time budget (P2 竞态/性能批次)', () => {
  // 合成 1 万条混合负载：8 成连续剧本段（应共享稀疏行——HDSI 剧本是连续单条）
  // + 每 5 条穿插一个散点消息。预算宽松（rows 现实现为排序 + 每条一次
  // ends.findIndex，稀疏行下为近似线性，实测 tens of ms；预算留一个数量级
  // 余量——若有人引入逐条全表扫描的 O(n²)，10k×10k=1e8 次比较会显著超支）。
  const n = 10_000
  const items = []
  let t = 0
  for (let i = 0; i < n; i++) {
    if (i % 5 === 0) items.push({ id: 'msg' + i, start: t + 500, end: t + 500 })
    else { items.push({ id: 'seg' + i, start: t, end: t + 1000 }); t += 1000 }
  }
  const startedRows = process.hrtime.bigint()
  const rows = model.rows(items)
  const rowsMs = Number(process.hrtime.bigint() - startedRows) / 1e6
  assert.equal(rows.size, n, '全部条目都获得行号')
  const usedRows = new Set(rows.values())
  assert.ok(usedRows.size > 0 && usedRows.size < 30, '行数应保持稀疏（连续段共享行），实际 ' + usedRows.size)
  // 打乱后行分配结果一致（行分配只依赖重叠关系——既有小规模用例的规模版）。
  const shuffled = model.rows([...items].sort(() => Math.random() - 0.5))
  assert.equal(JSON.stringify([...shuffled.entries()].sort()), JSON.stringify([...rows.entries()].sort()))
  assert.ok(rowsMs < 500, '10k 行分配耗时 ' + rowsMs.toFixed(1) + 'ms 超预算（疑似复杂度回归）')
  // 视口剔除同规模：全量 14 天窗口下 interval 调用必须保持廉价。
  const startedCull = process.hrtime.bigint()
  let visible = 0
  for (const item of items) if (model.interval(item.start, item.end, 0, 14 * 86400_000, 1200)) visible++
  const cullMs = Number(process.hrtime.bigint() - startedCull) / 1e6
  assert.ok(visible === n, '全窗口下全部可见，实际 ' + visible)
  assert.ok(cullMs < 300, '10k interval 剔除耗时 ' + cullMs.toFixed(1) + 'ms 超预算')
})

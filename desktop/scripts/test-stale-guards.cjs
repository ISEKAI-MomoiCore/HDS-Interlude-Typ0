// P2 测试批次 C 档：worker 重启竞态守卫的行为级验证（puppeteer + mock bridge）。
// 场景：timelineRange 在飞期间 worker 重启（pid 变化）→ 迟到响应必须被 pid 守卫
// 丢弃（state.snapshot 不被污染、staleDropCounters 计数）；pid 稳定时同一响应
// 正常接受（守卫不误伤）。与 test-studio-ui.cjs 同一 harness 模式。
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const { pathToFileURL } = require('node:url')
const puppeteer = require(require.resolve('puppeteer-core', { paths: [process.cwd(), 'C:/dev/HDS-Interlude'] }))
;(async () => {
  const browser = await puppeteer.launch({ executablePath: process.env.UI_TEST_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: 'shell', args: ['--edge-skip-compat-layer-relaunch'] })
  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 1440, height: 900 })
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.evaluateOnNewDocument(() => {
      const now = Date.now()
      const story = { meta: { id: 'fixture', name: '竞态 fixture', characterName: '角色', phase: 'running' }, running: true, bridgeReady: true, pid: 4242 }
      const entries = [0, 1, 2].map(id => ({ id: id + 1, entityId: 'entry:' + (id + 1), kind: 'script', actor: 'narrator', track: 'script', content: '竞态守卫验证用剧本条目。'.repeat(40), occurredAt: new Date(now - (3 - id) * 600000).toISOString() }))
      // 可控的 timelineRange：首个（无 cursor、非 limit=1）请求挂起，等测试放行。
      globalThis.fixture = { story, pending: [] }
      const respond = q => ({ entries: q.limit === 1 || q.cursor ? [] : entries, revision: 'r9', range: q, timezone: 'UTC', scenes: [], facts: [] })
      const api = {
        stories: {
          list: async () => [story],
          timelineRange: async (_id, q) => (q.limit !== 1 && !q.cursor)
            ? await new Promise(resolve => globalThis.fixture.pending.push(() => resolve(respond(q))))
            : respond(q),
          timeline: async () => ({ entries, revision: 'r9', updatedAt: new Date().toISOString() }),
          deliveries: async () => [], usage: async () => [], mixerRead: async () => [], mixerWrite: async () => ({ applied: [] }),
        },
        runtime: { resources: async () => ({ runningWorkers: 1, maxWorkers: 3 }), overview: async () => ({ inbox: { pending: 0 }, outbox: { states: {} }, worker: {}, recentErrors: [] }) },
        accounts: { status: async () => ({}) }, logs: { query: async () => [], stats: async () => ({}) }, console: { info: async () => ({}) },
      }
      window.hdsiDesktop = new Proxy(api, { get: (target, key) => target[key] || (() => {}) })
    })
    await page.goto(pathToFileURL(path.resolve(process.env.UI_TEST_DIST ? 'dist/renderer/index.html' : 'src/renderer/index.html')).href)
    // boot 的 readSnapshot 会挂起首个 timelineRange——先等它进 pending、放行，
    // 时间线才会渲染出 .primary-clip。
    await page.waitForFunction(() => globalThis.fixture?.pending?.length > 0, { timeout: 10_000 })
    await page.evaluate(() => globalThis.fixture.pending.pop()?.())
    await page.waitForFunction(() => document.querySelector('.primary-clip'))
    const result = await page.evaluate(async () => {
      const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
      await wait(300)
      const out = {}
      // 场景 1：worker 重启（pid 变化）后，旧 worker 的迟到响应必须被丢弃。
      // 真实时序里 story:exit → refresh 会先清空快照，这里同样先清——被丢弃的
      // 响应不得把它写回去。pid 必须在请求发出之后、落地之前变化（请求发起时
      // 捕获旧 worker 的 pid 作为锚点）。
      state.snapshot = null
      staleDropCounters.timeline = 0
      const inFlight = refreshSnapshot()
      state.stories[0].pid = 9999
      globalThis.fixture.pending.pop()?.()
      await inFlight.catch(() => {})
      await wait(200)
      out.droppedAfterRestart = staleDropCounters.timeline
      out.snapshotAfterRestart = state.snapshot === null ? 'null' : String(state.snapshot?.revision)
      // 场景 2：pid 稳定时同一响应正常接受（守卫不误伤）。
      staleDropCounters.timeline = 0
      const stable = refreshSnapshot()
      globalThis.fixture.pending.pop()?.()
      await stable.catch(() => {})
      await wait(200)
      out.acceptedWhenStable = state.snapshot?.revision === 'r9'
      out.droppedWhenStable = staleDropCounters.timeline
      return out
    })
    assert.deepEqual(errors, [], '页面错误')
    assert.equal(result.droppedAfterRestart, 1, 'worker 重启后迟到响应应恰好丢弃一次，实际 ' + result.droppedAfterRestart)
    assert.equal(result.snapshotAfterRestart, 'null', '被丢弃的响应不得写回 state.snapshot，实际 ' + result.snapshotAfterRestart)
    assert.equal(result.acceptedWhenStable, true, 'pid 稳定时响应应正常接受（守卫不误伤）')
    assert.equal(result.droppedWhenStable, 0, '稳定路径不应计丢弃，实际 ' + result.droppedWhenStable)
    console.log('stale guard 行为验证通过：重启丢弃 / 稳定接受 / 计数正确')
  } finally {
    await browser.close()
  }
})().catch(error => { console.error(error); process.exit(1) })

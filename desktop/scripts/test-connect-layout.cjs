// Regression test for the connect page layout and post-mount button interactions.
// It deliberately starts with corrupted persisted panel widths to cover the user-visible failure.
const assert = require('node:assert/strict')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const puppeteer = require(require.resolve('puppeteer-core', { paths: [process.cwd(), 'C:/dev/HDS-Interlude'] }))

;(async () => {
  const browser = await puppeteer.launch({ executablePath: process.env.UI_TEST_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true })
  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 1280, height: 768 })
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.evaluateOnNewDocument(() => {
      localStorage.setItem('hdsi.typ0.workspace', JSON.stringify({
        surface: 'connect', storyId: 'fixture',
        storyLayouts: { fixture: { panels: { browser: true, inspector: true, detail: true }, panelWidths: { browser: 36, inspector: 58 }, panelHeights: { detail: 174 } } },
      }))
      const story = { meta: { id: 'fixture', name: 'Connect fixture', characterName: '角色', phase: 'paused' }, running: false, bridgeReady: false }
      const api = {
        stories: {
          list: async () => [story],
          timelineRange: async () => ({ entries: [], revision: '1', range: {}, scenes: [], facts: [] }),
          deliveries: async () => [], usage: async () => [], configSection: async () => [],
        },
        connection: {
          detect: async () => ({ snowluma: 'running', snowlumaWebui: { port: 5099 }, snowlumaAccounts: [] }),
          firstRunReadiness: async () => ({ checks: [], allOk: true, criticalOk: true }),
        },
        accounts: { list: async () => [], status: async () => ({}) },
        runtime: { resources: async () => ({ runningWorkers: 0, maxWorkers: 1 }), overview: async () => ({ inbox: { pending: 0 }, outbox: { states: {} }, worker: {}, recentErrors: [] }) },
        logs: { query: async () => [], stats: async () => ({}) },
        console: { info: async () => ({}) },
        secrets: { set: async () => ({}) },
      }
      window.hdsiDesktop = new Proxy(api, { get: (target, key) => target[key] || (() => {}) })
    })
    await page.goto(pathToFileURL(path.resolve('src/renderer/index.html')).href, { waitUntil: 'load' })
    await new Promise(resolve => setTimeout(resolve, 500))
    await page.evaluate(() => { state.storyId = 'fixture'; setSurface('connect') })
    await page.waitForSelector('#connect-open-wizard', { timeout: 10000 })

    const geometry = await page.evaluate(() => {
      const rect = selector => {
        const node = document.querySelector(selector)
        if (!node) return null
        const box = node.getBoundingClientRect()
        return { x: box.x, width: box.width }
      }
      return {
        browser: rect('.browser-panel'),
        workspace: rect('.workspace-panel'),
        inspector: rect('.inspector-panel'),
        ready: rect('#connect-ready-panel'),
        steps: rect('#connect-main > .connect-layout > .connect-steps'),
      }
    })
    assert.ok(geometry.browser.width >= 150, JSON.stringify(geometry))
    assert.equal(geometry.inspector.width, 0, 'Connect defaults to a focused layout')
    const restored = await page.evaluate(() => {
      togglePanel('inspector')
      const width = byId('inspector-panel').getBoundingClientRect().width
      setSurface('studio'); setStudioView('timeline')
      const timelineWidth = byId('inspector-panel').getBoundingClientRect().width
      return { width, timelineWidth, saved: layoutFor().panels.inspector }
    })
    assert.ok(restored.width >= 180 && restored.timelineWidth >= 180, JSON.stringify(restored))
    assert.equal(restored.saved, true, 'task choices must not overwrite timeline preferences')
    await page.evaluate(() => setSurface('connect'))
    assert.ok(geometry.steps.width >= 260, JSON.stringify(geometry))
    assert.ok(geometry.ready.width <= 340, JSON.stringify(geometry))

    const interaction = await page.evaluate(() => {
      let openedTab = ''
      window.openConfigTab = tab => { openedTab = tab }
      const wizardButton = document.querySelector('#connect-open-wizard')
      wizardButton.click()
      const dialogOpen = document.querySelector('#account-wizard')?.open === true
      document.querySelector('#account-wizard')?.close()
      const modelsButton = document.querySelector('#connect-goto-models')
      modelsButton.click()
      const platformButtons = [...document.querySelectorAll('.connect-platform')]
      platformButtons[1].click()
      return { dialogOpen, openedTab, platformActive: platformButtons[1].classList.contains('active') }
    })
    assert.equal(interaction.dialogOpen, true)
    assert.equal(interaction.openedTab, 'providers')
    assert.equal(interaction.platformActive, true)
    assert.deepEqual(errors, [])
    console.log('Connect layout clamps corrupted panel widths and mounted controls are clickable: PASS')
  } finally {
    await browser.close()
  }
})().catch(error => { console.error(error); process.exitCode = 1 })

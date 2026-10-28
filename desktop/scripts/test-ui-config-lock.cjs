// 配置窗"字段改不了"死锁回归：二开 openConfig 且 stories.config 失败时，
// 不得停留在"卡片可见 + 整面板 inert"的不可编辑死锁态（必须清卡或可编辑）。
const path = require('node:path')
const assert = require('node:assert/strict')
const puppeteer = require(require.resolve('puppeteer-core', { paths: [process.cwd(), 'C:/dev/HDS-Interlude'] }))

const PROVIDERS = [{ id: 'main', mode: 'openai-compatible', model: '$secret:primary-model', endpoint: '$secret:primary-endpoint', apiKey: '$secret:primary-key', temperature: 0.8, useForMain: true }]

;(async () => {
  const browser = await puppeteer.launch({ executablePath: process.env.UI_TEST_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: 'shell', args: ['--edge-skip-compat-layer-relaunch'] })
  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 1440, height: 900 })
    const errors = []
    page.on('pageerror', e => errors.push(e.message))
    await page.evaluateOnNewDocument(require('./fixtures/studio.cjs'))
    await page.goto('file://' + path.resolve(process.env.UI_TEST_DIST ? 'dist/renderer/index.html' : 'src/renderer/index.html'))
    await page.waitForFunction(() => document.querySelector('.primary-clip'))
    await page.evaluate(providers => {
      let failNextConfig = false
      window.__setFailConfig = v => { failNextConfig = v }
      window.hdsiDesktop.stories.config = async () => {
        if (failNextConfig) { failNextConfig = false; throw new Error('mock IPC failure') }
        return { source: 'plugins:\n', aliases: [] }
      }
      window.hdsiDesktop.stories.configSection = async (_id, section) => section === 'providers' ? providers : []
      window.hdsiDesktop.stories.plugins = async () => ({ plugins: [] })
    }, PROVIDERS)

    const state = () => ({
      ready: configSectionsReady,
      inert: document.querySelector('#config-form .config-body')?.inert,
      saveDisabled: byId('config-save')?.disabled,
      cards: document.querySelectorAll('#cfg-providers-list .cfg-card').length,
    })

    // 正常打开：可编辑
    await page.evaluate(() => openConfig('fixture'))
    await new Promise(r => setTimeout(r, 400))
    await page.click('[data-config-tab="providers"]')
    await new Promise(r => setTimeout(r, 150))
    const s0 = await page.evaluate(state)
    assert.equal(s0.ready, true); assert.equal(s0.inert, false); assert.equal(s0.cards, 1)
    const typed = await page.evaluate(() => {
      const input = document.querySelector('#cfg-providers-list input[data-row="label"]')
      input.focus(); input.value = ''; document.execCommand('insertText', false, 'abc')
      return input.value
    })
    assert.equal(typed, 'abc', '正常打开时 providers 字段必须可输入')

    // 二开 + stories.config 失败：不得死锁（有卡片 && inert 同时成立即失败）
    await page.evaluate(() => { window.__setFailConfig(true); openConfig('fixture') })
    await new Promise(r => setTimeout(r, 400))
    const s1 = await page.evaluate(state)
    assert.ok(!(s1.cards > 0 && s1.inert), `死锁态：${JSON.stringify(s1)}`)
    assert.equal(s1.ready, false)
    assert.equal(s1.saveDisabled, true, '加载失败后保存必须禁用')
    const statusText = await page.evaluate(() => byId('config-status')?.textContent || '')
    assert.match(statusText, /配置加载失败/, '状态栏必须给出可解释的失败原因')

    // 关闭后重开恢复正常
    await page.evaluate(() => byId('config-dialog').close())
    await new Promise(r => setTimeout(r, 100))
    await page.evaluate(() => openConfig('fixture'))
    await new Promise(r => setTimeout(r, 400))
    const s2 = await page.evaluate(state)
    assert.equal(s2.ready, true); assert.equal(s2.inert, false); assert.equal(s2.cards, 1)

    assert.deepEqual(errors, [], 'page errors')
    console.log('Config lock regression: PASS')
  } finally { await browser.close() }
})().catch(error => { console.error(error); process.exit(1) })

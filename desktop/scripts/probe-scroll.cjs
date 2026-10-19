// 一次性诊断探针：扫描“可滚动容器底部被裁掉（内容滚不到）”的界面状态。
const path = require('node:path')
const puppeteer = require(require.resolve('puppeteer-core', { paths: [process.cwd(), 'C:/dev/HDS-Interlude'] }))

const SCAN = () => {
  const out = []
  const limitOf = el => {
    let limit = innerHeight, limiter = 'viewport'
    let node = el.parentElement
    while (node && node !== document.body) {
      const s = getComputedStyle(node)
      const r = node.getBoundingClientRect()
      const isDialog = node.tagName === 'DIALOG' && node.open
      const clips = s.overflowY === 'hidden' || s.overflowY === 'clip' || s.overflow === 'hidden' || s.overflow === 'clip' || isDialog
      if (clips && r.bottom < limit) {
        limit = r.bottom
        limiter = isDialog ? 'dialog#' + (node.id || '?') : (node.id ? '#' + node.id : node.tagName + '.' + [...node.classList].slice(0, 2).join('.'))
      }
      node = node.parentElement
    }
    return { limit, limiter }
  }
  for (const el of document.querySelectorAll('body *')) {
    const s = getComputedStyle(el)
    if (!/(auto|scroll)/.test(s.overflowY) || el.scrollHeight <= el.clientHeight + 1) continue
    const r = el.getBoundingClientRect()
    if (r.height < 4) continue
    const { limit, limiter } = limitOf(el)
    const lost = Math.round(r.bottom - limit)
    if (lost > 2) out.push({
      sel: (el.id ? '#' + el.id : '') + (el.classList.length ? '.' + [...el.classList].slice(0, 3).join('.') : '') || el.tagName,
      scrollablePx: el.scrollHeight - el.clientHeight,
      lostPx: lost, limiter,
      rect: [Math.round(r.top), Math.round(r.bottom)], limitAt: Math.round(limit), vh: innerHeight,
    })
  }
  return out.sort((a, b) => b.lostPx - a.lostPx)
}

;(async () => {
  const browser = await puppeteer.launch({ executablePath: process.env.UI_TEST_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true })
  try {
    const page = await browser.newPage()
    page.on('pageerror', e => console.log('PAGEERROR:', e.message))
    await page.evaluateOnNewDocument(require('./fixtures/studio.cjs'))
    await page.goto('file://' + path.resolve(process.env.UI_TEST_DIST ? 'dist/renderer/index.html' : 'src/renderer/index.html'))
    await page.waitForFunction(() => document.querySelector('.primary-clip'))
    page.on('console', msg => { if (msg.text().includes('PAGEERROR')) console.log(msg.text()) })

    const states = [
      ['hud-overview', () => {}],
      ['studio-timeline', () => { setSurface('studio') }],
      ['mixer-model', () => { setSurface('studio'); setStudioView('mixer') }],
      ['connect', () => { setSurface('connect') }],
      ['logs', () => { setSurface('logs') }],
      ['koishi', () => { setSurface('koishi') }],
      ['config-story', () => { openConfig('fixture'); document.querySelector('[data-config-tab="story"]')?.click() }],
      ['config-yaml', () => { openConfig('fixture'); document.querySelector('[data-config-tab="yaml"]')?.click() }],
      ['config-providers', () => { openConfig('fixture'); document.querySelector('[data-config-tab="providers"]')?.click() }],
      ['config-plugins', () => { openConfig('fixture'); document.querySelector('[data-config-tab="plugins"]')?.click() }],
      ['theme-dialog', () => { byId('theme-menu-btn').click() }],
      ['story-wizard', () => { byId('story-dialog').showModal() }],
      ['help', () => { byId('help-dialog').showModal() }],
      ['connect-inflated', () => {
        setSurface('connect')
        // 模拟真实数据量：塞入大量卡片，验证滚动区在超高内容下仍完整可达
        const main = byId('connect-main')
        for (let i = 0; i < 24; i++) main.insertAdjacentHTML('beforeend', '<div class="connect-card" style="height:120px">filler</div>')
        byId('connect-ready-panel').insertAdjacentHTML('beforeend', '<div class="connect-card" style="height:400px">side filler</div>')
      }],
    ]
    for (const [width, height] of [[1440, 900], [1280, 800]]) {
      await page.setViewport({ width, height })
      for (const [name, action] of states) {
        await page.evaluate(() => { document.querySelectorAll('dialog[open]').forEach(d => d.close()) })
        const err = await page.evaluate(actionString => { try { eval(actionString) } catch (error) { return error.message } }, `(${action.toString()})()`)
        if (err) { console.log(`[${width}x${height}] ${name}: EVAL FAIL ${err}`); continue }
        await new Promise(r => setTimeout(r, 350))
        const found = await page.evaluate(SCAN)
        if (found.length) {
          console.log(`[${width}x${height}] ${name}:`)
          for (const item of found.slice(0, 6)) console.log('   ', JSON.stringify(item))
        }
      }
    }
    console.log('probe done')
  } finally { await browser.close() }
})().catch(error => { console.error(error); process.exit(1) })

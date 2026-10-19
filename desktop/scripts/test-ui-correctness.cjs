// First-round layout regressions against the real renderer with an isolated preload.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const puppeteer = require(require.resolve('puppeteer-core', { paths: [process.cwd(), 'C:/dev/HDS-Interlude'] }))
const output = process.env.UI_TEST_SCREENSHOT_DIR || path.join(os.tmpdir(), 'hdsi-ui-correctness')
fs.mkdirSync(output, { recursive: true })

;(async () => {
  const browser = await puppeteer.launch({ executablePath: process.env.UI_TEST_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true })
  try {
    const page = await browser.newPage()
    const errors = [], measurements = []
    page.on('pageerror', error => errors.push(error.message))
    await page.setViewport({ width: 1440, height: 900 })
    await page.evaluateOnNewDocument(require('./fixtures/studio.cjs'))
    await page.evaluateOnNewDocument(() => {
      hdsiDesktop.accounts.list = async () => [
        { storyId: 'fixture', storyName: '林间 · 城市的另一侧'.repeat(8), selfId: '123456789', channelKind: 'qq', nickname: '林间的长账号名称'.repeat(8), externalState: 'online', externalUpstream: { endpoint: 'ws://127.0.0.1:3001/onebot/' + 'long-path/'.repeat(30) } },
        { storyId: 'fixture-wx', storyName: '雨夜 · 微信支线', selfId: 'wxid_fixture_character', channelKind: 'wechat', nickname: '微信端点', externalState: 'connecting', externalUpstream: { endpoint: 'ws://127.0.0.1:3002/onebot' } },
      ]
      hdsiDesktop.connection = {
        detect: async () => ({ snowluma: 'running', snowlumaWebui: { port: 5099 }, snowlumaAccounts: [] }),
        firstRunReadiness: async () => ({ checks: [], allOk: true, criticalOk: true }),
      }
      hdsiDesktop.console.resize = async () => ({})
      hdsiDesktop.stories.semanticAnalysis = async () => { throw new Error('当前 Worker 尚未提供语义分析接口') }
    })
    await page.goto(pathToFileURL(path.resolve(process.env.UI_TEST_DIST ? 'dist/renderer/index.html' : 'src/renderer/index.html')).href)
    await page.waitForSelector('.primary-clip')
    const capture = async name => {
      await page.evaluate(() => window.scrollTo(0, 0))
      await page.screenshot({ path: path.join(output, name + '.png') })
    }

    for (const [width, height] of [[1440, 900], [1280, 768], [760, 600]]) {
      await page.setViewport({ width, height })
      await page.evaluate(() => { setSurface('studio'); setStudioView('overview') })
      const dialog = await page.evaluate(() => {
        const node = byId('story-dialog'), before = document.documentElement.scrollHeight
        const hidden = !node.open && getComputedStyle(node).display === 'none'
        openWizard()
        const rect = node.getBoundingClientRect()
        const opened = node.open && getComputedStyle(node).display === 'flex'
        node.close()
        return { hidden, opened, top: rect.top, bottom: rect.bottom, height: innerHeight, before, after: document.documentElement.scrollHeight, closed: getComputedStyle(node).display === 'none' }
      })
      assert.ok(dialog.hidden && dialog.opened && dialog.closed, JSON.stringify(dialog))
      assert.ok(dialog.top >= 0 && dialog.bottom <= height + 1, JSON.stringify(dialog))
      assert.ok(dialog.after <= height + 1 && dialog.after === dialog.before, JSON.stringify(dialog))
      await page.evaluate(() => openWizard())
      await capture('wizard-' + width)
      await page.evaluate(() => byId('story-dialog').close())
      await page.evaluate(() => setSurface('connect'))
      await page.waitForSelector('.account-card')
      const accounts = await page.evaluate(() => [...document.querySelectorAll('.account-card')].map(card => {
        const box = card.getBoundingClientRect()
        return { width: card.clientWidth, scroll: card.scrollWidth, endpoint: getComputedStyle(card.querySelector('.account-card-endpoint')).display,
          clipped: [...card.querySelectorAll('.account-card-actions button, .account-card-status, .account-card-head, .account-card-endpoint')].filter(node => { const r = node.getBoundingClientRect(); return r.left < box.left || r.right > box.right + 1 }).map(node => node.className || node.textContent),
          identityStacked: card.querySelector('.account-card-head b').getBoundingClientRect().bottom <= card.querySelector('.account-card-head small').getBoundingClientRect().top,
          buttons: card.querySelectorAll('.account-card-actions button').length }
      }))
      accounts.forEach(card => { assert.ok(card.scroll <= card.width + 1, JSON.stringify(card)); assert.deepEqual(card.clipped, []); assert.ok(card.identityStacked); assert.equal(card.buttons, 3); assert.notEqual(card.endpoint, 'none') })
      measurements.push({ width, height, dialog, accounts })
      await capture('connect-' + width)

      await page.evaluate(() => { setSurface('studio'); setStudioView('timeline'); setDetail('script'); const entries = state.snapshot.entries.filter(entry => entry.kind === 'script').slice(0, 2).map(entry => ({ ...entry, content: entry.content + '\n\n保留换行与完整原文 <不是 HTML>\n' + 'unbroken'.repeat(100) })); state.selectedScript = { start: entries[0].occurredAt, end: entries[1].occurredAt, entries }; lastDetailKey = ''; renderDetail() })
      const detail = await page.evaluate(() => {
        const script = document.querySelector('.script-detail'), para = script.querySelector('p'), css = getComputedStyle(para)
        const osd = byId('osd-hud'), a = osd.getBoundingClientRect(), b = byId('detail-panel').getBoundingClientRect()
        return { padding: parseFloat(getComputedStyle(script).paddingLeft), whiteSpace: css.whiteSpace, lineHeight: parseFloat(css.lineHeight), fontSize: parseFloat(css.fontSize), gap: getComputedStyle(script.querySelector('article > div')).columnGap,
          paragraphs: script.querySelectorAll('p').length, complete: para.textContent === state.selectedScript.entries[0].content,
          width: byId('detail-content').clientWidth, scroll: byId('detail-content').scrollWidth,
          statusScrollable: getComputedStyle(osd.parentElement).overflowX === 'auto', osdInStatus: osd.parentElement.classList.contains('status-ruler'), osdPosition: getComputedStyle(osd).position, overlap: a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top }
      })
      assert.ok(detail.padding >= 16 && detail.lineHeight >= detail.fontSize * 1.6, JSON.stringify(detail))
      assert.equal(detail.whiteSpace, 'pre-wrap'); assert.ok(detail.complete); assert.equal(detail.paragraphs, 2)
      assert.ok(parseFloat(detail.gap) >= 8); assert.ok(detail.scroll <= detail.width + 1, JSON.stringify(detail))
      assert.ok(detail.statusScrollable && detail.osdInStatus && detail.osdPosition === 'static' && !detail.overlap, JSON.stringify(detail))
      await capture('script-' + width)

      for (const ready of [false, true]) {
        await page.evaluate(ready => { desktop.console.info = async () => ({ descriptor: ready ? { endpoint: 'http://127.0.0.1:5140/' } : null, embedded: false }); setSurface('koishi'); return refreshConsoleInfo() }, ready)
        const consoleBox = await page.evaluate(() => {
          const anchor = byId('koishi-embed-anchor').getBoundingClientRect(), pane = byId('koishi-console-pane').getBoundingClientRect(), overlay = byId('koishi-overlay').getBoundingClientRect()
          return { anchor: { width: anchor.width, height: anchor.height }, paneHeight: pane.height, overlayHeight: overlay.height, overlayTop: overlay.top, paneTop: pane.top, overlayBottom: overlay.bottom, paneBottom: pane.bottom, validBounds: !!koishiAnchorBounds(), title: byId('koishi-overlay-title').textContent }
        })
        assert.ok(consoleBox.validBounds && consoleBox.paneHeight > 50 && consoleBox.overlayHeight > 0, JSON.stringify(consoleBox))
        assert.ok(consoleBox.overlayTop >= consoleBox.paneTop && consoleBox.overlayBottom <= consoleBox.paneBottom + 1, JSON.stringify(consoleBox))
        assert.equal(consoleBox.title.includes('已就绪'), ready)
        measurements.push({ width, ready, consoleBox })
        await capture(`console-${ready ? 'ready' : 'waiting'}-${width}`)
      }
      await page.evaluate(() => { consoleState.embedded = true; renderKoishiState() })
      assert.equal(await page.$eval('#koishi-overlay', el => getComputedStyle(el).display), 'none')
      await page.evaluate(() => { consoleState.embedded = false; setSurface('studio') })
      assert.equal(await page.$eval('#koishi-surface', el => getComputedStyle(el).display), 'none')
    }

    await page.setViewport({ width: 1440, height: 900 })
    for (const view of ['session', 'mixer', 'stats', 'analysis', 'timeline', 'facts', 'schedule', 'overview']) {
      await page.evaluate(view => setStudioView(view), view)
      // Let the playhead animation run too: hiding it for only one render is insufficient.
      await new Promise(resolve => setTimeout(resolve, 150))
      const timeline = ['timeline', 'facts', 'schedule', 'overview'].includes(view)
      const layers = await page.evaluate(() => ({ hidden: byId('studio-surface').classList.contains('timeline-hidden'),
        items: ['#arrangement-ruler', '#timeline-scroller-container', '.time-knob-wrap', '.now-playhead'].map(selector => getComputedStyle(document.querySelector(selector)).display),
        arrangementHeight: byId('arrangement').getBoundingClientRect().height,
      }))
      assert.equal(layers.hidden, !timeline, view)
      if (!timeline) { assert.ok(layers.items.every(value => value === 'none'), view + JSON.stringify(layers)); assert.ok(layers.arrangementHeight > 100, view) }
      if (view === 'timeline') assert.notEqual(layers.items[0], 'none')
      measurements.push({ view, layers })
      await capture('studio-' + view)
    }
    await page.evaluate(() => setSurface('logs'))
    await capture('logs')
    for (const mode of ['daily', 'diagnostics', 'workbench']) {
      await page.evaluate(mode => { setSurface('studio'); document.querySelector(`[data-view-mode="${mode}"]`).click() }, mode)
      const overlap = await page.evaluate(() => {
        const a = byId('osd-hud').getBoundingClientRect(), b = byId('detail-panel').getBoundingClientRect()
        return a.width > 0 && b.width > 0 && a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top
      })
      assert.equal(overlap, false, mode)
      await capture('mode-' + mode)
    }

    await page.evaluate(() => HDSIWorkspaceProfile.apply('v7'))
    for (const theme of ['default', 'hdsi-japanese-light', 'hdsi-sumi', 'hdsi-aizome', 'hdsi-matcha', 'hdsi-akari']) {
      await page.evaluate(theme => HDSIThemeV3.apply(theme), theme)
      const contrast = await page.evaluate(() => {
        const parse = value => (value.match(/[\d.]+/g) || []).map(Number)
        const blend = (fg, bg) => { const a = fg[3] ?? 1; return fg.slice(0, 3).map((v, i) => v * a + bg[i] * (1 - a)) }
        const background = node => { let bg = [255, 255, 255]; const stack = []; for (; node; node = node.parentElement) stack.unshift(node); for (const el of stack) bg = blend(parse(getComputedStyle(el).backgroundColor), bg); return bg }
        const luminance = rgb => rgb.slice(0, 3).map(v => { v /= 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4 }).reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0)
        return ['.brand-text', '.surface-tabs button.active', '.surface-tabs button:not(.active)', '.surface-tabs button small', '.transport-story select', '.transport-state button', '.resource-state', '.clock', '#theme-menu-btn', '#new-story'].map(selector => {
          const node = document.querySelector(selector), fg = luminance(parse(getComputedStyle(node).color)), bg = luminance(background(node))
          return { selector, ratio: (Math.max(fg, bg) + .05) / (Math.min(fg, bg) + .05), color: getComputedStyle(node).color }
        })
      })
      contrast.forEach(item => assert.ok(item.ratio >= (item.selector === '#new-story' ? 3 : 4.5), theme + JSON.stringify(item)))
      await page.hover('.surface-tabs button:not(.active)')
      assert.equal(await page.$eval('.surface-tabs button:not(.active)', node => getComputedStyle(node).color), await page.$eval('.brand-text', node => getComputedStyle(node).color))
      measurements.push({ theme, contrast })
      await capture('v7-' + theme)
    }
    await page.evaluate(() => { HDSIThemeV3.apply('default'); HDSIWorkspaceProfile.apply('v4') })
    assert.deepEqual(errors, [], 'renderer errors')
    fs.writeFileSync(path.join(output, 'measurements.json'), JSON.stringify(measurements, null, 2))
    console.log('Seven first-round UI regressions, 3 window sizes, 8 Studio views, 3 host modes and 6 theme palettes: PASS')
    console.log('Screenshots and layout measurements:', output)
  } finally { await browser.close() }
})().catch(error => { console.error(error); process.exitCode = 1 })

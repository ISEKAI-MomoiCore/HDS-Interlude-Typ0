// Isolated renderer integration: no real worker, config, account or database access.
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const { pathToFileURL } = require('node:url')
const screenshotDir = process.env.UI_TEST_SCREENSHOT_DIR || require('node:os').tmpdir()
fs.mkdirSync(screenshotDir, { recursive: true })
const puppeteer = require(require.resolve('puppeteer-core', { paths: [process.cwd(), 'C:/dev/HDS-Interlude'] }))
;(async () => {
  const browser = await puppeteer.launch({ executablePath: process.env.UI_TEST_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true })
  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 1440, height: 900 })
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.evaluateOnNewDocument(require('./fixtures/studio.cjs'))
    await page.goto(pathToFileURL(path.resolve(process.env.UI_TEST_DIST ? 'dist/renderer/index.html' : 'src/renderer/index.html')).href)
    await page.waitForFunction(() => document.querySelector('.primary-clip'))
    assert.deepEqual(errors, [], 'cold startup errors')
    await page.click('[data-browser-view=overview]')
    await page.waitForFunction(() => document.querySelector('.hud-scene-copy strong')?.textContent.includes('雨声') && document.querySelector('[data-hud-activity]')?.textContent.includes('测试宿主错误记录'))
    const hud = await page.evaluate(() => ({
      title: document.querySelector('.hud-scene-copy strong')?.textContent,
      fact: document.querySelector('.hud-fact strong')?.textContent,
      preplan: document.querySelector('.hud-preplan b')?.textContent,
      activity: document.querySelector('[data-hud-activity]')?.textContent,
      endpointLabels: [...document.querySelectorAll('.context-endpoint em')].map(node => node.textContent),
      topAction: document.querySelector('[data-time-preset=now]')?.textContent.trim(),
    }))
    assert.match(hud.title, /雨声/)
    assert.match(hud.fact, /黑伞/)
    assert.match(hud.preplan, /起.*至/)
    assert.match(hud.activity, /失败|测试宿主错误记录/)
    assert.deepEqual(hud.endpointLabels, [], 'RC57 range records do not expose metadata.channel')
    assert.equal(hud.topAction, 'NOW')
    const projection = await page.evaluate(() => ({
      factsCount: document.querySelector('.studio-hud-signal.moss span').textContent,
      cards: document.querySelectorAll('.hud-fact').length,
      inspector: byId('inspector-content').textContent,
      usageDay: document.querySelector('.context-inspector-section dt[title]')?.title,
    }))
    assert.match(projection.factsCount, /6 条投影事实/)
    assert.equal(projection.cards, 4, 'only the preview is capped, not the fact count')
    assert.equal(projection.usageDay, '2026-10-17')
    assert.doesNotMatch(projection.inspector, /今日模型调用/)
    // A legacy/full snapshot may include sources. Never label observations as online.
    await page.evaluate(async () => { fixtureChannels = true; fixtureRevision(); await refreshSnapshot() })
    assert.deepEqual(await page.$$eval('.context-endpoint em', nodes => nodes.map(node => node.textContent)), ['近期出现', '近期出现'])
    await page.evaluate(async () => { fixtureChannels = false; fixtureRevision(); await refreshSnapshot() })
    const phases = await page.evaluate(() => {
      const story = selectedStory(), initial = { running: story.running, bridgeReady: story.bridgeReady, phase: story.meta.phase }
      const results = []
      for (const [phase, running, bridgeReady] of [['running', true, true], ['muted', true, true], ['paused', true, true], ['running', false, false], ['running', true, false]]) {
        story.meta.phase = phase; story.running = running; story.bridgeReady = bridgeReady; updateRunStateText()
        results.push({ label: getComputedStyle(document.querySelector('.transport-state'), '::before').content, pressed: [...document.querySelectorAll('.transport-state button[aria-pressed="true"]')].map(button => button.dataset.phase) })
      }
      story.running = initial.running; story.bridgeReady = initial.bridgeReady; story.meta.phase = initial.phase; updateRunStateText()
      return results
    })
    assert.deepEqual(phases.map(item => item.label.replaceAll('"', '')), ['RUNNING', 'MUTED', 'PAUSED', 'OFFLINE', 'BOOTING'])
    assert.deepEqual(phases[3].pressed, [])
    for (const width of [1440, 1280, 1000, 760]) {
      await page.setViewport({ width, height: 900 })
      await new Promise(resolve => setTimeout(resolve, 320))
      const geometry = await page.evaluate(() => {
        byId('story-hud').scrollTop = 0
        const rows = [...document.querySelectorAll('#arrangement > .arrangement-track')].filter(node => getComputedStyle(node).display !== 'none')
        const rect = node => node.getBoundingClientRect()
        const firstLane = document.querySelector('.track-lane'), ticks = document.querySelector('#arrangement-ruler > div')
        const scroller = byId('timeline-scroller-container')
        return {
          rows: rows.map(node => ({ visible: getComputedStyle(node).visibility, height: rect(node).height })),
          gap: rect(document.querySelector('.studio-hud-signals')).top - rect(rows.at(-1)).bottom,
          rulerDelta: Math.abs(rect(firstLane).left - rect(ticks).left),
          scrollerVisible: getComputedStyle(scroller).opacity === '1' && rect(scroller).height > 20,
          scrollerBottom: rect(scroller).bottom, workspaceBottom: rect(document.querySelector('.workspace-panel')).bottom,
          topbarOverflow: [...document.querySelector('.transport-bar').children].filter(node => rect(node).width > 0).filter(node => rect(node).left < -1 || rect(node).right > innerWidth + 1).map(node => node.className || node.id),
          documentOverflow: document.documentElement.scrollWidth > innerWidth + 1,
        }
      })
      assert.equal(geometry.rows.length, 3, 'overview has three shared rails')
      geometry.rows.forEach(row => { assert.equal(row.visible, 'visible'); assert.equal(row.height, 34) })
      assert.ok(geometry.gap >= 8 && geometry.gap <= 22, JSON.stringify({ width, geometry }))
      assert.ok(geometry.rulerDelta <= 1, JSON.stringify({ width, geometry }))
      assert.equal(geometry.scrollerVisible, true, JSON.stringify({ width, geometry }))
      assert.ok(geometry.scrollerBottom <= geometry.workspaceBottom + 1, JSON.stringify({ width, geometry }))
      assert.deepEqual(geometry.topbarOverflow, [], JSON.stringify({ width, geometry }))
      assert.equal(geometry.documentOverflow, false, JSON.stringify({ width, geometry }))
      await page.screenshot({ path: path.join(screenshotDir, 'typ0-studio-next-overview-' + width + '.png') })
    }
    await page.setViewport({ width: 1440, height: 900 })
    await new Promise(resolve => setTimeout(resolve, 300))
    await page.click('[data-hud-action=facts]')
    await page.waitForFunction(() => state.browserView === 'facts')
    await page.click('[data-browser-view=overview]')
    await page.click('[data-hud-action=deliveries]')
    await page.waitForFunction(() => state.detail === 'deliveries')
    const hostRefresh = await page.evaluate(async () => {
      const rail = document.querySelector('#arrangement > .arrangement-track'), revision = state.snapshot.revision
      document.querySelector('[data-hud-action=timeline]').focus({ preventScroll: true })
      fixtureHostChange(); await refreshHostProjection()
      return { focused: document.activeElement?.dataset.hudAction, retained: rail === document.querySelector('#arrangement > .arrangement-track'), revisionUnchanged: revision === state.snapshot.revision, hud: byId('story-hud').textContent, detail: byId('detail-content').textContent }
    })
    assert.equal(hostRefresh.focused, 'timeline', 'projection refresh preserves keyboard focus')
    assert.equal(hostRefresh.retained, true, 'host refresh must not rebuild timeline rails')
    assert.equal(hostRefresh.revisionUnchanged, true)
    assert.match(hostRefresh.hud, /7 待处理.*1 结果未知/)
    assert.match(hostRefresh.detail, /结果未知.*测试投递结果未知/)
    const unread = await page.evaluate(() => {
      const overview = state.hostOverview; state.hostOverview = null
      renderStoryHud(byId('story-hud'), null)
      const text = byId('story-hud').textContent
      state.hostOverview = overview; renderStoryHud(byId('story-hud'), state.snapshot)
      return text
    })
    assert.match(unread, /时间线尚未可读/)
    assert.match(unread, /账本尚未可读/)
    await page.click('[data-hud-action=logs]')
    await page.waitForFunction(() => state.surface === 'logs')
    await page.evaluate(() => setSurface('studio'))
    await page.click('[data-browser-view=overview]')
    await page.screenshot({path:path.join(screenshotDir, 'typ0-studio-next-overview.png'), fullPage:false})
    const result = await page.evaluate(async () => {
      const before = timelineViewport()
      byId('arrangement').dispatchEvent(new WheelEvent('wheel', {deltaX:10,deltaY:0,bubbles:true,cancelable:true}))
      await new Promise(r=>setTimeout(r,80))
      const after = timelineViewport()
      const pan = after.center - before.center
      const node = nowPlayheadEl
      fixtureRevision(); await refreshSnapshot()
      const connected = node.isConnected
      const trackToggle = document.querySelector('[data-track-toggle="receive"]')
      trackToggle.click()
      const hidden = !document.querySelector('.arrangement-track.receive')
      document.querySelector('[data-browser-view="mixer"]').click()
      await new Promise(r=>setTimeout(r,100))
      // P2-1: 分组按目标组织——MODEL→模型与费用、TEMPO→联系节奏；默认落在「人物与故事」（无 fixture 参数）。
      document.querySelector('[data-mixer-section="模型与费用"]').click()
      const modelCount = document.querySelectorAll('.mixer-channel').length
      if(getComputedStyle(nowPlayheadEl).display!=='none')throw Error('Timeline overlay remains in Mixer')
      const selectCount = document.querySelectorAll('.mixer-select').length
      const number = document.querySelector('.mixer-number'); number.value='1.2';number.dispatchEvent(new Event('change'))
      document.querySelector('[data-mixer-section="联系节奏"]').click()
      const tempoCount = document.querySelectorAll('.mixer-channel').length
      document.querySelector('[data-mixer-section="模型与费用"]').click()
      const retained = document.querySelector('.mixer-number').value
      await flushMixer('fixture')
      return {pan,span:before.span,connected,hidden,modelCount,selectCount,tempoCount,retained,writes:fixtureWrites}
    })
    assert.ok(result.pan > 0 && result.pan < result.span * .05)
    assert.equal(result.connected,true)
    assert.equal(result.hidden,true)
    assert.equal(result.modelCount,2)
    assert.equal(result.selectCount,1)
    assert.equal(result.tempoCount,1)
    assert.equal(result.retained,'1.2')
    assert.equal(result.writes[0].patch.a,1.2)
    await page.click('[data-browser-view="overview"]')
    await page.waitForSelector('.scroller-window')
    const rect = await page.$eval('.scroller-window', el => { const r=el.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height} })
    await page.mouse.move(rect.x+rect.width/2,rect.y+rect.height/2)
    await page.mouse.down()
    await page.mouse.move(rect.x+rect.width/2+35,rect.y+rect.height/2,{steps:10})
    await page.mouse.up()
    await new Promise(resolve=>setTimeout(resolve,500))
    const center = await page.evaluate(()=>timelineViewport().center)
    await page.evaluate(()=>refreshSnapshot())
    assert.equal(await page.evaluate(()=>timelineViewport().center),center,'refresh must not recenter a dragged viewport')
    // Geometry alignment is a Timeline contract. Overview intentionally uses
    // a denser 166px rail label column and does not share the ruler baseline.
    await page.click('[data-browser-view="timeline"]')
    await new Promise(resolve=>setTimeout(resolve,820))
    for (const width of [1280,1440]) {
      await page.setViewport({width,height:800})
      await new Promise(resolve=>setTimeout(resolve,300))
      const geometry = await page.evaluate(()=>{
        const lane=document.querySelector('.track-lane').getBoundingClientRect()
        const ticks=document.querySelector('#arrangement-ruler > div').getBoundingClientRect()
        return {delta:Math.abs(lane.left-ticks.left),width:lane.width,expected:canvas.viewWidthPx}
      })
      assert.ok(geometry.delta<=1,JSON.stringify(geometry))
      assert.ok(Math.abs(geometry.width-geometry.expected)<=1)
      const nowDelta = await page.evaluate(()=>Math.abs(nowPlayheadEl.getBoundingClientRect().left-(document.querySelector('.track-lane').getBoundingClientRect().left+timeToPx(Date.now()))))
      assert.ok(nowDelta<2,'NOW vs lane offset: '+nowDelta)
    }
    await page.screenshot({path:path.join(screenshotDir, 'typ0-ui-repair-verification.png')})
    await page.click('[data-browser-view="mixer"]')
    await page.waitForSelector('.mixer-channel')
    await page.screenshot({path:path.join(screenshotDir, 'typ0-mixer-repair-verification.png')})
    assert.deepEqual(errors, [], 'interaction errors')
    console.log('Studio cold-start, RC57 overview projections/refresh/focus, 4 viewport layouts, navigation, wheel, track visibility, Mixer drafts/save: PASS')
  } finally { await browser.close() }
})().catch(error => { console.error(error); process.exitCode = 1 })

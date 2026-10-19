// Renderer button regression coverage: verify real pointer hit-testing and
// event wiring across the shell, menus, Studio views, dialogs and Connect.
const assert = require('node:assert/strict')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const puppeteer = require(require.resolve('puppeteer-core', { paths: [process.cwd(), 'C:/dev/HDS-Interlude'] }))

;(async () => {
  const browser = await puppeteer.launch({ executablePath: process.env.UI_TEST_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true })
  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 1440, height: 900 })
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.evaluateOnNewDocument(() => {
      const now = Date.now()
      const story = { meta: { id: 'fixture', name: '按钮回归剧本', characterName: '角色', phase: 'paused' }, running: false, bridgeReady: false }
      const entries = [{ id: 1, kind: 'script', track: 'script', content: '按钮点击回归测试', occurredAt: new Date(now - 60000).toISOString() }]
      const config = { storyDefaults: {}, userAccounts: [], groupChats: [], botAccounts: [], providers: [] }
      const api = {
        stories: {
          list: async () => [story], timelineRange: async () => ({ entries, revision: '1', range: {}, scenes: [], facts: [] }),
          deliveries: async () => [], usage: async () => [], configSection: async (_id, section, value) => value === undefined ? (config[section] ?? {}) : (config[section] = value, { ok: true }),
          mixerRead: async () => [], mixerWrite: async () => ({ applied: [] }),
        },
        connection: { detect: async () => ({ snowluma: 'running', snowlumaWebui: { port: 5099 }, snowlumaAccounts: [] }), firstRunReadiness: async () => ({ checks: [], allOk: true, criticalOk: true }) },
        accounts: { list: async () => [], status: async () => ({}) },
        runtime: { resources: async () => ({ runningWorkers: 0, maxWorkers: 1 }), overview: async () => ({ inbox: { pending: 0 }, outbox: { states: {} }, worker: {}, recentErrors: [] }) },
        logs: { query: async () => [], stats: async () => ({}) },
        console: { info: async () => ({}) }, secrets: { set: async () => ({ ok: true }), list: async () => [] },
      }
      window.hdsiDesktop = new Proxy(api, { get: (target, key) => target[key] || (() => {}) })
      window.confirm = () => true
      window.open = () => null
    })
    await page.goto(pathToFileURL(path.resolve(process.env.UI_TEST_DIST ? 'dist/renderer/index.html' : 'src/renderer/index.html')).href, { waitUntil: 'load' })
    await page.waitForFunction(() => document.querySelector('#new-story') && document.querySelector('.browser-panel'))
    await page.evaluate(() => { state.storyId = 'fixture'; setSurface('studio'); setStudioView('timeline') })
    await page.waitForSelector('.workspace-panel')

    // Layout and More are native details menus. A real pointer click must land
    // on the menu item, not on the workspace below it.
    const layout = await page.$('details.layout-menu:not(#more-menu) summary')
    await layout.click()
    assert.equal(await page.$eval('details.layout-menu:not(#more-menu)', node => node.open), true)
    const menuHit = await page.evaluate(() => [...document.querySelectorAll('details.layout-menu:not(#more-menu) > div button')].map(button => {
      const r = button.getBoundingClientRect()
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
      return { label: button.textContent.trim(), hit: hit === button || button.contains(hit) }
    }))
    assert.deepEqual(menuHit.map(item => item.hit), [true, true, true, true, true, true])
    for (const panel of ['browser', 'inspector', 'detail']) {
      const menuOpen = await page.$eval('details.layout-menu:not(#more-menu)', node => node.open)
      if (!menuOpen) await page.$eval('details.layout-menu:not(#more-menu) summary', node => node.click())
      await page.waitForFunction(() => document.querySelector('details.layout-menu:not(#more-menu)')?.open === true)
      const button = await page.$(`[data-panel-toggle="${panel}"]`)
      const box = await button.boundingBox()
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
      assert.equal(await page.evaluate(panel => layoutFor().panels[panel], panel), false)
    }
    await page.evaluate(() => { for (const panel of ['browser', 'inspector', 'detail']) if (!layoutFor().panels[panel]) togglePanel(panel) })
    await layout.click()
    const more = await page.$('#more-menu summary')
    await more.click()
    assert.equal(await page.$eval('#more-menu', node => node.open), true)
    assert.equal(await page.$eval('details.layout-menu:not(#more-menu)', node => node.open), false)
    await more.click()
    assert.equal(await page.$eval('#more-menu', node => node.open), false)

    // Narrow windows must not lose the More entry point. The old responsive
    // selectors hid the whole .layout-menu (and referenced stale IDs), so
    // Help/Import became unreachable even though their handlers were bound.
    await page.evaluate(() => { window.prompt = () => null })
    for (const width of [1000, 760, 480]) {
      await page.setViewport({ width, height: 900 })
      await new Promise(resolve => setTimeout(resolve, 80))
      const moreSummary = await page.$('#more-menu summary')
      assert.ok(await moreSummary.isIntersectingViewport(), `More summary is not reachable at ${width}px`)
      await moreSummary.click()
      assert.equal(await page.$eval('#more-menu', node => node.open), true)
      const menuHit = await page.evaluate(() => {
        return [...document.querySelectorAll('#more-menu > div button')].filter(button => getComputedStyle(button).display !== 'none').map(button => {
          const r = button.getBoundingClientRect()
          const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
          return hit === button || button.contains(hit)
        })
      })
      assert.equal(menuHit.length > 0 && menuHit.every(Boolean), true, `More menu hit-test failed at ${width}px`)
      const expectedMoreIds = width >= 861
        ? ['responsive-theme-menu', 'open-help-menu', 'import-story-menu']
        : ['responsive-theme-menu', 'responsive-new-story', 'open-help-menu', 'import-story-menu']
      assert.deepEqual(await page.$$eval('#more-menu > div button', nodes => nodes.filter(node => getComputedStyle(node).display !== 'none').map(node => node.id)), expectedMoreIds)
      await page.click('#responsive-theme-menu')
      await page.waitForSelector('#theme-dialog[open]')
      await page.click('#theme-close')
      if (width < 861) {
        await moreSummary.click()
        await page.click('#responsive-new-story')
        assert.equal(await page.$eval('#story-dialog', node => node.open), true)
        await page.$eval('#story-dialog', node => node.close())
      }
      await moreSummary.click()
      await page.click('#open-help-menu')
      assert.equal(await page.$eval('#help-dialog', node => node.open), true)
      await page.click('#help-close')
      await moreSummary.click()
      await page.click('#import-story-menu')
      assert.equal(await page.$eval('#more-menu', node => node.open), false)

      // The responsive drawer/floating-panel entry point must also remain
      // physically clickable after the top bar is compacted.
      const fabId = width >= 861 ? '#inspector-fab' : '#browser-fab'
      const fab = await page.$(fabId)
      assert.ok(fab && await fab.isIntersectingViewport(), `Responsive panel button is not reachable at ${width}px`)
      const fabBox = await fab.boundingBox()
      const fabHit = await page.evaluate(({ id, box }) => {
        const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)
        return hit?.id === id || document.querySelector(id)?.contains(hit)
      }, { id: fabId.slice(1), box: fabBox })
      assert.equal(fabHit, true, `Responsive panel button hit-test failed at ${width}px`)
      await page.mouse.click(fabBox.x + fabBox.width / 2, fabBox.y + fabBox.height / 2)
      const panelId = width >= 861 ? '#inspector-panel' : '#browser-panel'
      assert.equal(await page.$eval(panelId, node => node.classList.contains('panel-open')), true)
      await page.mouse.click(fabBox.x + fabBox.width / 2, fabBox.y + fabBox.height / 2)
      assert.equal(await page.$eval(panelId, node => node.classList.contains('panel-open')), false)
    }
    await page.setViewport({ width: 1440, height: 900 })

    // Static top-level and Studio controls.
    for (const surface of ['logs', 'studio', 'connect']) {
      await page.click(`[data-surface="${surface}"]`)
      assert.equal(await page.evaluate(surface => state.surface, surface), surface)
    }
    // 回归（m3 清理误删基础规则）：页签切换必须改变真实可见内容，
    // 工作台骨架必须是 grid——此前只断言 state/aria，两条 CSS 回归全部漏网。
    assert.equal(await page.$eval('.studio-shell', node => getComputedStyle(node).display), 'grid', '.studio-shell must establish grid')
    await page.click('[data-surface="logs"]')
    assert.equal(await page.$eval('#logs-surface', node => getComputedStyle(node).display !== 'none' && node.getBoundingClientRect().height > 0), true, 'active surface must be visible in flow')
    assert.equal(await page.$eval('#studio-surface', node => getComputedStyle(node).display === 'none'), true, 'inactive surface must leave the flow')
    await page.click('[data-surface="studio"]')
    // 回归（向导隐式提交）：非末步按 Enter 不得创建剧本；末步正常提交仍创建。
    // 回归（P2 §1 根因）：.wizard-step{display:grid} 曾压过 [hidden] 的 UA 规则，
    // 六步全部同时渲染把提交按钮顶出视口——非当前步骤必须真实不可见。
    await page.evaluate(() => {
      window.__testWizardCreates = 0
      window.hdsiDesktop.stories.create = async payload => { window.__testWizardCreates++; return { id: 'wizard-created' } }
    })
    await page.click('#new-story')
    await page.waitForSelector('#story-dialog[open]')
    await page.type('#story-form [name=name]', '回车不应创建')
    await page.type('#story-form [name=characterName]', '回归主角')
    assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('.wizard-step')]
      .filter(s => s.getBoundingClientRect().height > 1).map(s => s.dataset.step)), ['1'],
      'only the current wizard step may render')
    await page.keyboard.press('Enter')
    await new Promise(resolve => setTimeout(resolve, 150))
    assert.equal(await page.evaluate(() => window.__testWizardCreates), 0, 'Enter at step 1 must not create the story')
    assert.equal(await page.evaluate(() => document.querySelector('#story-dialog').open), true, 'Enter at step 1 must not close the wizard')
    assert.equal(await page.$eval('#story-form-title', node => node.textContent.includes('1/6')), true, 'Enter at step 1 must stay on step 1')
    for (let step = 1; step < 6; step++) await page.click('#wizard-next')
    assert.deepEqual(await page.evaluate(() => [...document.querySelectorAll('.wizard-step')]
      .filter(s => s.getBoundingClientRect().height > 1).map(s => s.dataset.step)), ['6'],
      'stepping to 6/6 must hide the other steps')
    // 回归（P2 §1）：6/6 提交按钮必须落在视口内且真实坐标可点（此前 y≈1049 越界，
    // 只能靠 JS click 绕过）。
    const submitHit = await page.evaluate(() => {
      const btn = document.getElementById('wizard-submit')
      const r = btn.getBoundingClientRect()
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
      return { inViewport: r.top >= 0 && r.bottom <= window.innerHeight, hit: hit === btn || btn.contains(hit) }
    })
    assert.equal(submitHit.inViewport, true, 'wizard submit must be inside the viewport: ' + JSON.stringify(submitHit))
    assert.equal(submitHit.hit, true, 'wizard submit must hit-test at real coordinates')
    await page.click('#wizard-submit')
    await page.waitForFunction(() => window.__testWizardCreates === 1, { timeout: 5000 })
    assert.equal(await page.evaluate(() => document.querySelector('#story-dialog').open), false, 'final-step submit must close the wizard')

    // 回归（P2 §1 矮视口硬化）：600px 高度下走完 6 步，页脚按钮全程真实坐标可达。
    await page.setViewport({ width: 1440, height: 600 })
    await page.click('#new-story')
    await page.waitForSelector('#story-dialog[open]')
    // openWizard 会 reset 表单——必填项为空时提交按钮被禁用，先补填再走步骤。
    await page.type('#story-form [name=name]', '矮视口创建')
    await page.type('#story-form [name=characterName]', '矮视口主角')
    for (let step = 1; step < 6; step++) {
      const nextHit = await page.evaluate(() => {
        const btn = document.getElementById('wizard-next')
        const r = btn.getBoundingClientRect()
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
        return { inViewport: r.top >= 0 && r.bottom <= window.innerHeight, hit: hit === btn || btn.contains(hit) }
      })
      assert.equal(nextHit.inViewport && nextHit.hit, true, `wizard footer at step ${step}/6 under a 600px viewport`)
      await page.click('#wizard-next')
    }
    const shortSubmit = await page.evaluate(() => {
      const btn = document.getElementById('wizard-submit')
      const r = btn.getBoundingClientRect()
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
      return { inViewport: r.top >= 0 && r.bottom <= window.innerHeight, hit: hit === btn || btn.contains(hit) }
    })
    assert.equal(shortSubmit.inViewport && shortSubmit.hit, true, 'wizard submit under a 600px viewport: ' + JSON.stringify(shortSubmit))
    await page.click('#wizard-submit')
    await page.waitForFunction(() => window.__testWizardCreates === 2, { timeout: 5000 })
    await page.setViewport({ width: 1440, height: 900 })
    for (const view of ['timeline', 'mixer', 'stats', 'analysis', 'facts', 'schedule']) {
      if (view === 'facts') await page.evaluate(() => { const section = [...document.querySelectorAll('.browser-section')].find(node => node.textContent.includes('MORE VIEWS')); if (section) section.open = true })
      await page.click(`[data-browser-view="${view}"]`)
      assert.equal(await page.evaluate(view => state.browserView, view), view)
    }
    await page.click('[data-browser-view="overview"]')
    await page.evaluate(() => { const section = document.querySelector('#track-menu'); if (section) section.open = true })
    const track = await page.$('[data-track-toggle="receive"]')
    const beforeTrack = await track.evaluate(node => node.getAttribute('aria-pressed'))
    await track.click()
    assert.notEqual(await page.$eval('[data-track-toggle="receive"]', node => node.getAttribute('aria-pressed')), beforeTrack)
    // Overview deliberately starts without Detail; Timeline keeps the full workbench.
    await page.click('[data-browser-view="timeline"]')
    await page.click('[data-detail="script"]')
    assert.equal(await page.evaluate(() => state.detail), 'script')
    await page.click('[data-detail="events"]')
    assert.equal(await page.evaluate(() => state.detail), 'events')

    // 回归（P2 §2）：后台事件驱动的 refresh() 全量重建故事列表/下拉，
    // 不得销毁正在浏览的用户的焦点（消息到达时列表正在被聚焦/滚动）。
    const focusKeep = await page.evaluate(async () => {
      window.hdsiDesktop.stories.list = async () => [
        { meta: { id: 'fixture', name: '按钮回归剧本', characterName: '角色', phase: 'paused' }, running: false, bridgeReady: false },
        { meta: { id: 'second', name: '第二剧本', characterName: '乙', phase: 'paused' }, running: false, bridgeReady: false },
      ]
      await refresh()
      const first = document.querySelector('#story-list .story-strip')
      first.focus()
      const focusedId = document.activeElement.dataset.storyId
      await refresh()
      const keptId = document.activeElement?.dataset?.storyId ?? ''
      const selectedStill = document.querySelector('#story-list .story-strip.selected')?.dataset.storyId
      const select = document.getElementById('story-select')
      select.focus()
      await refresh()
      const selectKept = document.activeElement === select
      const selectValue = select.value
      return { focusedId, keptId, selectedStill, selectKept, selectValue }
    })
    assert.equal(focusKeep.focusedId, 'fixture')
    assert.equal(focusKeep.keptId, focusKeep.focusedId, 'story-list rebuild must restore focus on the same story button')
    assert.equal(focusKeep.selectedStill, 'fixture', 'rebuild must keep the selected marker')
    assert.equal(focusKeep.selectKept, true, 'story-select rebuild must keep focus')
    assert.equal(focusKeep.selectValue, 'fixture', 'story-select rebuild must keep the selection')

    // 回归（P2 §6）：搜索浮层对话框语义 + 焦点陷阱 + 焦点归还；
    // 右键菜单键盘可达（方向键/Esc/焦点归还）；toast err→alert。
    const a11y = await page.evaluate(() => {
      const out = {}
      // 1) 全局搜索
      const opener = document.getElementById('new-story')
      opener.focus()
      openGlobalSearch()
      const overlay = document.getElementById('global-search')
      out.searchRole = `${overlay.getAttribute('role')}/${overlay.getAttribute('aria-modal')}`
      out.searchFocusIn = overlay.contains(document.activeElement)
      const input = overlay.querySelector('#global-search-input')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      const focusables = [...overlay.querySelectorAll('input,button')].filter(el => el.getClientRects().length > 0)
      // 结果按钮存在时：焦点在最后一个上按 Tab 应回到输入框（陷阱循环）
      focusables[focusables.length - 1].focus()
      focusables[focusables.length - 1].dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }))
      out.tabWrapped = document.activeElement === focusables[0]
      document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
      out.searchClosed = !document.getElementById('global-search')
      out.searchFocusBack = document.activeElement === opener
      // 2) 右键菜单：键盘打开（contextmenu 事件）→ 方向键 → Esc 归还焦点
      const storyBtn = document.querySelector('#story-list .story-strip')
      storyBtn.focus()
      storyBtn.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 300, clientY: 300 }))
      const menu = document.querySelector('.context-menu')
      out.menuRole = menu?.getAttribute('role')
      out.menuItemRole = menu?.querySelector('button')?.getAttribute('role')
      out.hasPopup = storyBtn.getAttribute('aria-haspopup')
      out.menuFocusIn = menu?.contains(document.activeElement) === true
      const items = [...menu.querySelectorAll('button')]
      document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
      out.arrowMoved = document.activeElement === items[1]
      document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
      out.menuClosed = !document.querySelector('.context-menu')
      out.menuFocusBack = document.activeElement === storyBtn
      // 3) toast：err→alert（含挂入 dialog 的场景），info→status
      showToast('普通提示', 'info')
      const infoToast = [...document.querySelectorAll('.toast')].pop()
      out.infoRole = infoToast?.getAttribute('role')
      document.getElementById('help-dialog').showModal()
      showToast('模态内错误', 'err')
      const errToast = [...document.querySelectorAll('dialog[open] .toast')].pop()
      out.dialogErrRole = errToast?.getAttribute('role')
      document.getElementById('help-dialog').close()
      return out
    })
    assert.equal(a11y.searchRole, 'dialog/true', 'global search overlay must be an aria-modal dialog')
    assert.equal(a11y.searchFocusIn, true, 'search overlay must take focus on open')
    assert.equal(a11y.tabWrapped, true, 'Tab must wrap inside the search overlay')
    assert.equal(a11y.searchClosed, true, 'Escape must close the search overlay')
    assert.equal(a11y.searchFocusBack, true, 'search overlay must return focus on close')
    assert.equal(a11y.menuRole, 'menu', 'context menu must expose role=menu')
    assert.equal(a11y.menuItemRole, 'menuitem', 'context menu items must expose role=menuitem')
    assert.equal(a11y.hasPopup, 'menu', 'trigger must announce aria-haspopup')
    assert.equal(a11y.menuFocusIn, true, 'opening the menu must move focus into it')
    assert.equal(a11y.arrowMoved, true, 'ArrowDown must move to the next menu item')
    assert.equal(a11y.menuClosed, true, 'Escape must close the context menu')
    assert.equal(a11y.menuFocusBack, true, 'context menu must return focus to the trigger')
    assert.equal(a11y.infoRole, 'status', 'info toast must use role=status')
    assert.equal(a11y.dialogErrRole, 'alert', 'err toast inside a dialog must use role=alert')

    // The dynamic Connect page is mounted after an async render; its controls
    // must remain clickable after mount.
    await page.click('[data-surface="connect"]')
    await page.waitForSelector('#connect-open-wizard')
    await page.click('#connect-open-wizard')
    assert.equal(await page.$eval('#account-wizard', node => node.open), true)
    await page.$eval('#account-wizard', node => node.close())
    await page.click('.connect-platform:nth-child(2)')
    assert.equal(await page.$eval('.connect-platform:nth-child(2)', node => node.classList.contains('active')), true)

    // Theme dialog and its dynamically rendered cards.
    await page.click('#theme-menu-btn')
    await page.waitForSelector('#theme-dialog[open]')
    assert.ok(await page.$('[data-theme-id]'))
    await page.click('[data-theme-id="default"]')
    assert.equal(await page.$eval('#theme-dialog', node => node.open), true)
    await page.click('#theme-close')
    assert.equal(await page.$eval('#theme-dialog', node => node.open), false)

    assert.deepEqual(errors, [])
    console.log('Button interaction regression coverage: PASS')
  } finally {
    await browser.close()
  }
})().catch(error => { console.error(error); process.exitCode = 1 })













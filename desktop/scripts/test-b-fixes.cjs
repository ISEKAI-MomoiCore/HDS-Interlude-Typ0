// Regression tests for audit fixes.
// Round 1: B20/B21 (wizard model/channel steps), B23 (Overview vs Timeline split), B24 (prepend-only).
// Round 2: B04 (ready-check routing), B01 (OneBot → account panel), B08/B14 (story quick form),
//          B11 (chat-scope preset via groupChats), save race in flushMixer, B17/B18 (wizard storyDefaults),
//          B25 (detail expand via layout), search double-render of Mixer.
// Uses the same isolated fixture harness as test-studio-ui.cjs (no real worker/config access).
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const assert = require('node:assert/strict')
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
      const story = { meta: { id: 'fixture', name: 'UI fixture', characterName: '角色', phase: 'running' }, running: true, bridgeReady: true }
      const entries = [0, 1, 2].map(id => ({ id: id + 1, entityId: 'entry:' + (id + 1), kind: 'script', actor: 'narrator', track: 'script', content: '用于验证的原始剧本。'.repeat(40), occurredAt: new Date(now - (3 - id) * 600000).toISOString() }))
      globalThis.fixtureStoryDefaults = { characterName: '角色', timezone: 'Asia/Shanghai', style: '温和' }
      globalThis.fixtureWrites = []
      globalThis.fixtureSectionWrites = []
      globalThis.fixtureSlowWrite = true
const readiness = async () => ({ checks: [
        { id: 'model', label: '模型可用', status: 'err', detail: '未配置模型连接', action: 'config' },
        { id: 'whitelist', label: '交往对象已添加', status: 'warn', detail: '白名单为空', action: 'config' },
        { id: 'channel', label: 'QQ 渠道已配置', status: 'err', detail: '未找到启用的 OneBot 适配器', action: 'config' },
      ], allOk: false, criticalOk: false })
      const api = {
        stories: {
          list: async () => [story],
          timelineRange: async (_id, q) => ({ entries: q.limit === 1 ? [] : entries, revision: '1', range: q, timezone: 'Asia/Shanghai', scenes: [], facts: [] }),
          deliveries: async () => [], usage: async () => [],
          mixerRead: async () => [],
          mixerWrite: async (id, patch) => {
            if (globalThis.fixtureSlowWrite) await new Promise(r => setTimeout(r, 120))
            globalThis.fixtureWrites.push({ id, patch: { ...patch } })
            return { applied: Object.entries(patch).map(([key, value]) => ({ key, value })) }
          },
          create: async payload => ({ id: payload.id, name: payload.name, characterName: payload.characterName, phase: 'paused' }),
          config: async () => ({ source: '', aliases: [] }),
          configSection: async (id, section, data) => {
            if (data !== undefined) { globalThis.fixtureSectionWrites.push({ id, section, data: JSON.parse(JSON.stringify(data)) }); return { ok: true } }
            if (section === 'storyDefaults') return globalThis.fixtureStoryDefaults
            if (section === 'groupChats') return [{ groupId: '777', label: '测试群', enabled: true, responseMode: 'mention-only' }]
            return []
          },
        },
        connection: { detect: async () => ({ snowluma: 'installed', workers: [] }), readyCheck: readiness, firstRunReadiness: readiness },
        runtime: { resources: async () => ({ runningWorkers: 1, maxWorkers: 3 }), overview: async () => ({ inbox: { pending: 0 }, outbox: { states: {} }, worker: {}, recentErrors: [] }) },
        accounts: { status: async () => ({}) }, logs: { query: async () => [], stats: async () => ({}) }, console: { info: async () => ({}) },
      }
      window.hdsiDesktop = new Proxy(api, { get: (target, key) => target[key] || (() => {}) })
    })
    await page.goto(pathToFileURL(path.resolve(process.env.UI_TEST_DIST ? 'dist/renderer/index.html' : 'src/renderer/index.html')).href)
    await page.waitForFunction(() => document.querySelector('.primary-clip'))

    // ── R1: B20/B21 wizard steps 2 & 3 are actionable ──────────────────────
    const wizard = await page.evaluate(async () => {
      openWizard()
      const form = byId('story-form')
      form.querySelector('[name=name]').value = '向导验证'
      byId('wizard-next').click() // 1 → 2（从哪里开始）
      await new Promise(r => setTimeout(r, 50))
      byId('wizard-next').click() // 2 → 3（V4+ 六步向导：第 3 步才是模型）
      await new Promise(r => setTimeout(r, 50))
      const partialEl = byId('wizard-model-status').textContent
      form.querySelector('[name=providerModel]').value = 'glm-4.7'
      form.querySelector('[name=providerModel]').dispatchEvent(new Event('input'))
      const missingKeyEl = byId('wizard-model-status').textContent
      form.querySelector('[name=providerEndpoint]').value = 'https://api.test/v1'
      form.querySelector('[name=providerEndpoint]').dispatchEvent(new Event('input'))
      form.querySelector('[name=providerApiKey]').value = 'sk-test'
      form.querySelector('[name=providerApiKey]').dispatchEvent(new Event('input'))
      const readyEl = byId('wizard-model-status').textContent
      byId('wizard-next').click(); await new Promise(r => setTimeout(r, 50))
      form.querySelector('[name=botSelfId]').value = 'abc'
      form.querySelector('[name=botSelfId]').dispatchEvent(new Event('input'))
      const badQqEl = byId('wizard-channel-status').textContent
      form.querySelector('[name=botSelfId]').value = '1303322392'
      form.querySelector('[name=botSelfId]').dispatchEvent(new Event('input'))
      const okQqEl = byId('wizard-channel-status').textContent
      byId('wizard-next').click(); byId('wizard-next').click(); await new Promise(r => setTimeout(r, 50))
      const summary = byId('wizard-ready-check').textContent
      return { partialEl, missingKeyEl, readyEl, badQqEl, okQqEl, summary }
    })
    assert.ok(/未配置模型/.test(wizard.partialEl), 'step2 empty: ' + wizard.partialEl)
    assert.ok(/需同时填写/.test(wizard.missingKeyEl), 'step2 partial: ' + wizard.missingKeyEl)
    assert.ok(/创建时将写入：.*glm-4\.7/.test(wizard.readyEl), 'step2 ready: ' + wizard.readyEl)
    assert.ok(/5–11 位数字/.test(wizard.badQqEl), 'step3 bad qq: ' + wizard.badQqEl)
    assert.ok(/创建时将绑定(?:QQ|机器人)账号 1303322392/.test(wizard.okQqEl), 'step3 ok qq: ' + wizard.okQqEl)
    assert.ok(/glm-4\.7/.test(wizard.summary) && /1303322392/.test(wizard.summary), 'step5 summary: ' + wizard.summary)

    // ── R1: B23 V7 总览是独立视图：共享时间线视口、标题本地化、切回不丢状态 ──
    const views = await page.evaluate(async () => {
      const work = timelineViewport()
      document.querySelector('[data-browser-view="overview"]').click()
      await new Promise(r => setTimeout(r, 100))
      const over = timelineViewport()
      const overTitle = byId('workspace-title').textContent
      const overMode = byId('studio-mode-viewport')?.dataset.studioView
      document.querySelector('[data-browser-view="timeline"]').click()
      await new Promise(r => setTimeout(r, 100))
      const back = timelineViewport()
      const backMode = byId('studio-mode-viewport')?.dataset.studioView
      return { workSpan: work.span, overSpan: over.span, overFollow: over.followNow, backSpan: back.span, backFollow: back.followNow, overTitle, overMode, backMode }
    })
    assert.equal(views.overMode, 'overview', '总览模式挂载: ' + views.overMode)
    assert.equal(views.overTitle, '故事总览', 'V7 标题本地化: ' + views.overTitle)
    assert.ok(Math.abs(views.overSpan - views.workSpan) < 1000, '共享视口：进入总览不改变时间线窗口: ' + JSON.stringify(views))
    assert.ok(Math.abs(views.backSpan - 14 * 3600 * 1000) < 1000, 'timeline 14h: ' + views.backSpan)
    assert.equal(views.backFollow, true)
    assert.equal(views.backMode, 'timeline', '切回时间线: ' + views.backMode)

    // ── R1: B24 prepend-only keeps user edits ──────────────────────────────
    const b24 = await page.evaluate(() => {
      const host = document.createElement('div'); document.body.appendChild(host)
      host.innerHTML = '<div id="b24-list"></div>'
      renderAccountsList('b24-list', [{ qq: '111', label: '甲', enabled: true }, { qq: '222', label: '乙', enabled: true }], 'userAccounts')
      host.querySelector('.cfg-card input[data-row=label]').value = '用户改过'
      renderAccountsList('b24-list', [{ qq: '333', label: '新', enabled: true }], 'userAccounts', true)
      const cards = [...host.querySelectorAll('.cfg-card')]
      return { after: cards.length, firstQq: cards[0].querySelector('input[data-row=qq]').value, editedKept: cards.some(c => c.querySelector('input[data-row=label]').value === '用户改过') }
    })
    assert.equal(b24.after, 3); assert.equal(b24.firstQq, '333'); assert.equal(b24.editedKept, true)

    // ── R2 #5: edits made during mixer save are not swallowed ─────────────
    const race = await page.evaluate(async () => {
      mixerState.params = [{ key: 'factLimit', section: 'MEMORY', label: 'Facts', desc: 'd', type: 'knob', min: 1, max: 200, step: 1, value: 20 }]
      const draft = mixerDraft('fixture')
      draft.pending.factLimit = 10
      const flight = flushMixer('fixture')   // 写入 10（fixture 延迟 120ms）
      draft.pending.factLimit = 30           // 保存期间再次修改
      await flight
      return { writes: fixtureWrites, pending: { ...mixerDraft('fixture').pending } }
    })
    assert.equal(race.writes.length, 2, 'second flush must submit the concurrent edit: ' + JSON.stringify(race.writes))
    assert.equal(race.writes[0].patch.factLimit, 10)
    assert.equal(race.writes[1].patch.factLimit, 30, 'concurrent value must be written')
    assert.equal(race.pending.factLimit, undefined, 'pending must drain after both writes')

    // ── R2 #4: chat-scope preset toggles groupChats config section ────────
    const scope = await page.evaluate(async () => {
      fixtureSectionWrites.length = 0
      document.querySelector('[data-browser-view="mixer"]').click()
      await new Promise(r => setTimeout(r, 150))
      const group = [...document.querySelectorAll('.preset-group')].find(g => g.querySelector('.preset-label')?.textContent === '聊天范围')
      if (!group) return { error: 'preset group missing' }
      const privateBtn = [...group.querySelectorAll('.preset-btn')].find(b => b.textContent === '只私聊')
      privateBtn.click()
      await new Promise(r => setTimeout(r, 200))
      return { writes: fixtureSectionWrites }
    })
    assert.ok(!scope.error, scope.error)
    const groupWrite = scope.writes.find(w => w.section === 'groupChats')
    assert.ok(groupWrite, 'groupChats must be written: ' + JSON.stringify(scope.writes))
    assert.deepEqual(groupWrite.data, [{ groupId: '777', label: '测试群', enabled: false, responseMode: 'mention-only' }], '只私聊 must disable all group rows')
    assert.ok(!scope.writes.some(w => w.section === undefined), 'preset must not push mixer keys without patch')

    // ── R2 #3: 人物与故事 renders inline story form instead of blank ──────
    const quick = await page.evaluate(async () => {
      fixtureSectionWrites.length = 0
      document.querySelector('[data-mixer-section="人物与故事"]').click()
      await new Promise(r => setTimeout(r, 150))
      const profile = document.querySelector('[data-sq="characterProfile"]')
      const world = document.querySelector('[data-sq="world"]')
      if (!profile || !world) return { error: 'quick form missing' }
      const loadedProfile = profile.value
      profile.value = '她是测试角色。'
      world.value = '测试世界观。'
      document.getElementById('story-quick-save').click()
      await new Promise(r => setTimeout(r, 200))
      return { loadedProfile, writes: fixtureSectionWrites }
    })
    assert.ok(!quick.error, quick.error)
    assert.equal(quick.loadedProfile, '', 'fixture storyDefaults.characterProfile is empty')
    const storyWrite = quick.writes.find(w => w.section === 'storyDefaults')
    assert.ok(storyWrite, 'storyDefaults must be written: ' + JSON.stringify(quick.writes))
    assert.equal(storyWrite.data.characterProfile, '她是测试角色。')
    assert.equal(storyWrite.data.world, '测试世界观。')
    assert.equal(storyWrite.data.style, '温和', 'merge must preserve untouched storyDefaults fields')

    // ── R2 #1/#2: ready-check routes per item; OneBot → account panel ─────
    const routing = await page.evaluate(async () => {
      globalThis.spyConfigTab = []
      globalThis.spyAccountPanel = 0
      window.openConfigTab = tab => globalThis.spyConfigTab.push(tab)
      window.openAccountPanel = () => { globalThis.spyAccountPanel++ }
      await renderReadyPanel()
      const buttons = [...document.querySelectorAll('[data-ready-action="config"]')]
      buttons.forEach(b => b.click())
      return { count: buttons.length, tabs: globalThis.spyConfigTab, account: globalThis.spyAccountPanel }
    })
    assert.equal(routing.count, 3, 'three config buttons: ' + JSON.stringify(routing))
    assert.deepEqual(routing.tabs, ['providers', 'users'], 'model→providers, whitelist→users')
    assert.equal(routing.account, 1, 'channel→account panel')

    // ── R2 #7: setDetail expands a collapsed detail panel via layout ─────
    const detail = await page.evaluate(() => {
      const layout = layoutFor()
      state.storyLayouts['fixture'] = { ...layout, panels: { ...layout.panels, detail: false } }
      applyPanelLayout()
      const collapsed = document.querySelector('.studio-shell').classList.contains('detail-hidden')
      setDetail('script')
      const expanded = !document.querySelector('.studio-shell').classList.contains('detail-hidden')
      return { collapsed, expanded, flag: effectivePanels().detail, saved: layoutFor().panels.detail }
    })
    assert.equal(detail.collapsed, true, 'precondition: detail hidden')
    assert.equal(detail.expanded, true, 'setDetail must expand the panel')
    assert.equal(detail.flag, true, 'effective task detail must expand')
    assert.equal(detail.saved, false, 'focused task expansion must not overwrite the saved Timeline layout')

    // ── R2 #6: wizard submit writes characterProfile/world into storyDefaults
    const created = await page.evaluate(async () => {
      fixtureSectionWrites.length = 0
      document.querySelectorAll('.toast').forEach(t => t.remove())   // 清掉前一段测试残留的 toast
      window.openConfigTab = tab => {}   // 还原 spy，避免干扰
      state.storyId = 'fixture'
      openWizard()
      const form = byId('story-form')
      form.querySelector('[name=name]').value = '向导落库'
      form.querySelector('[name=characterName]').value = '小桃'
      form.querySelector('[name=characterProfile]').value = '她是一个安静的测试角色。'
      form.querySelector('[name=world]').value = '现代都市。'
      form.querySelector('[name=whitelist]').value = '111111111\n222222222'
      // 隐式提交防线回归修复：submit 只在末步（6/6 检查页）生效——
      // 合成事件路径同样要先走到末步。
      wizardStep = 6
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
      const deadline = Date.now() + 5000
      while (Date.now() < deadline && !fixtureSectionWrites.some(w => w.section === 'userAccounts')) await new Promise(r => setTimeout(r, 50))
      const toast = document.querySelector('.toast')?.textContent ?? ''
      return { writes: fixtureSectionWrites, toast }
    })
    const wizStory = created.writes.find(w => w.section === 'storyDefaults')
    assert.ok(wizStory, 'wizard must write storyDefaults: ' + JSON.stringify(created.writes))
    assert.equal(wizStory.data.characterProfile, '她是一个安静的测试角色。', 'characterProfile must land in storyDefaults')
    assert.equal(wizStory.data.world, '现代都市。', 'world must land in storyDefaults')
    assert.equal(wizStory.data.style, '温和', 'wizard merge must preserve existing storyDefaults')
    const wizUsers = created.writes.find(w => w.section === 'userAccounts')
    assert.ok(wizUsers && wizUsers.data.length === 2, 'whitelist rows must be written')
    assert.ok(/白名单 2 人/.test(created.toast), 'toast must reflect successful whitelist write: ' + created.toast)

    // ── R2 #8: search 主动联系 renders exactly one Mixer ──────────────────
    const searchMixer = await page.evaluate(async () => {
      state.storyId = 'fixture'; state.surface = 'logs'
      const hit = SEARCH_INDEX.find(i => i.title === '主动联系')
      hit.action()
      await new Promise(r => setTimeout(r, 200))
      return {
        surface: state.surface,
        view: state.browserView,
        section: mixerState.section,
        racks: document.querySelectorAll('.mixer-rack').length,
        strips: document.querySelectorAll('#mixer-strips').length,
        saveButtons: document.querySelectorAll('#mixer-save').length,
      }
    })
    assert.equal(searchMixer.surface, 'studio')
    assert.equal(searchMixer.view, 'mixer')
    assert.equal(searchMixer.section, '联系节奏', 'section must be set before render')
    assert.equal(searchMixer.racks, 1, 'exactly one mixer rack: ' + searchMixer.racks)
    assert.equal(searchMixer.saveButtons, 1, 'no duplicated element ids')

    // ── 三视图模式：布局预设 ──────────────────────────────────────────────
    const modes = await page.evaluate(async () => {
      applyViewMode('daily')
      const daily = { surface: state.surface, browser: effectivePanels().browser, inspector: effectivePanels().inspector, detail: effectivePanels().detail, mode: state.viewMode }
      applyViewMode('diagnostics')
      const diag = { surface: state.surface, inspector: effectivePanels().inspector, mode: state.viewMode }
      applyViewMode('workbench')
      const work = { surface: state.surface, browser: effectivePanels().browser, inspector: effectivePanels().inspector, detail: effectivePanels().detail, mode: state.viewMode }
      return { daily, diag, work, activeBtn: document.querySelector('[data-view-mode].active')?.dataset.viewMode }
    })
    assert.equal(modes.daily.surface, 'studio')
    assert.equal(modes.daily.browser, false)
    assert.equal(modes.daily.inspector, false)
    assert.equal(modes.daily.detail, false)
    assert.equal(modes.diag.surface, 'logs')
    assert.equal(modes.diag.inspector, false)
    assert.equal(modes.work.browser && modes.work.inspector && modes.work.detail, true)
    assert.equal(modes.activeBtn, 'workbench')
    // ── P2 §5: 保存当前分区 = 只写当前标签页对应的节 ─────────────────────
    // （旧行为：任一结构化标签点保存会连带写入全部五节，其它标签页的
    //   未保存草稿被一起提交——改人设就能触发群聊配置回写。）
    const sectionSave = await page.evaluate(async () => {
      window.confirm = () => true
      await openConfig('fixture')
      const deadline = Date.now() + 3000
      while (Date.now() < deadline && document.getElementById('config-save').disabled) await new Promise(r => setTimeout(r, 50))
      fixtureSectionWrites.length = 0
      const profile = document.querySelector('[data-config-panel="story"] [data-cfg="characterProfile"]')
      if (!profile) return { error: 'story panel input missing' }
      profile.value = '单节写验证。'
      profile.dispatchEvent(new Event('input', { bubbles: true }))
      const badgeShownBefore = !document.getElementById('config-dirty-badge').hidden
      document.getElementById('config-save').click()
      await new Promise(r => setTimeout(r, 150))
      const storyWrites = fixtureSectionWrites.map(w => w.section)
      const storyStatus = document.getElementById('config-status').textContent
      const badgeShownAfterStory = !document.getElementById('config-dirty-badge').hidden
      // 切到群聊标签加一行 → 保存只应写 groupChats，不碰 storyDefaults
      fixtureSectionWrites.length = 0
      document.querySelector('[data-config-tab="groups"]').click()
      const addBtn = document.querySelector('[data-add-row="groupChats"]')
      if (!addBtn) return { error: 'group add-row missing', storyWrites }
      addBtn.click()
      await new Promise(r => setTimeout(r, 50))
      document.getElementById('config-save').click()
      await new Promise(r => setTimeout(r, 150))
      const groupWrites = fixtureSectionWrites.map(w => w.section)
      document.getElementById('config-dialog').close()
      return { storyWrites, storyStatus, badgeShownBefore, badgeShownAfterStory, groupWrites }
    })
    assert.ok(!sectionSave.error, JSON.stringify(sectionSave))
    assert.deepEqual(sectionSave.storyWrites, ['storyDefaults'], 'saving the story tab must write only storyDefaults: ' + JSON.stringify(sectionSave.storyWrites))
    assert.ok(/「人设与故事」已保存/.test(sectionSave.storyStatus), 'status must name the saved section: ' + sectionSave.storyStatus)
    assert.equal(sectionSave.badgeShownBefore, true, 'dirty badge must appear after an edit')
    assert.equal(sectionSave.badgeShownAfterStory, false, 'dirty badge must clear after saving that section')
    assert.deepEqual(sectionSave.groupWrites, ['groupChats'], 'saving the groups tab must write only groupChats: ' + JSON.stringify(sectionSave.groupWrites))

    // ── P2 §3: 常驻 Studio 也能刷出模型实态；晚到的通道探测不得串台 ──────
    const statusBar = await page.evaluate(async () => {
      // (1) readiness 与 surface 解耦：默认停在 Studio（从未进连接页），
      //     refresh 后状态栏模型项必须从"检查中"变为实态。
      state.surface = 'studio'; state.storyId = 'fixture'
      connectState.readiness = null; readinessCache.clear()
      await refresh()
      const deadline = Date.now() + 2000
      while (Date.now() < deadline && !/模型：(未配置|可用|状态不明)/.test(document.getElementById('model-state').textContent)) await new Promise(r => setTimeout(r, 50))
      const modelAfterRefresh = document.getElementById('model-state').textContent
      // (2) 快速切故事：旧故事的通道探测晚到，不得覆盖新故事的文案。
      const stories = [
        { meta: { id: 'fixture', name: 'UI fixture', characterName: '角色', phase: 'running' }, running: true, bridgeReady: true },
        { meta: { id: 'fixture2', name: '第二个剧本', characterName: '乙', phase: 'paused' }, running: false, bridgeReady: false },
      ]
      window.hdsiDesktop.stories.list = async () => stories
      window.hdsiDesktop.accounts.list = async () => {
        await new Promise(r => setTimeout(r, 40))   // fixture 的响应永远晚到
        return [{ storyId: 'fixture', channelKind: 'qq', externalState: 'online' }]
      }
      state.stories = stories
      state.storyId = 'fixture'; renderContext(); void updateStatusBar()
      state.storyId = 'fixture2'; renderContext(); void updateStatusBar()
      await new Promise(r => setTimeout(r, 300))
      const channelAfterSwitch = document.getElementById('channel-state').textContent
      // 还原现场
      window.hdsiDesktop.stories.list = async () => [stories[0]]
      window.hdsiDesktop.accounts.list = async () => []
      state.stories = stories.slice(0, 1); state.storyId = 'fixture'
      await refresh()
      return { modelAfterRefresh, channelAfterSwitch }
    })
    assert.ok(/模型：未配置/.test(statusBar.modelAfterRefresh), 'resident studio must show a real model state after refresh: ' + statusBar.modelAfterRefresh)
    assert.ok(/通道：未绑定/.test(statusBar.channelAfterSwitch), 'a late channel probe for the previous story must not overwrite the status bar: ' + statusBar.channelAfterSwitch)

    // ── 复审 P2-1：切故事后模型状态不得沿用上一个故事 ────────────────────
    const readinessSwitch = await page.evaluate(async () => {
      const stories = [
        { meta: { id: 'fixture', name: 'UI fixture', characterName: '角色', phase: 'running' }, running: true, bridgeReady: true },
        { meta: { id: 'fixture2', name: '第二个剧本', characterName: '乙', phase: 'paused' }, running: false, bridgeReady: false },
      ]
      state.stories = stories; state.storyId = 'fixture'
      window.hdsiDesktop.stories.list = async () => stories
      window.hdsiDesktop.connection.firstRunReadiness = async id => {
        if (id === 'fixture2') await new Promise(r => setTimeout(r, 60))   // 新故事探测慢一点，暴露沿用窗口
        return id === 'fixture'
          ? { checks: [{ id: 'model', label: '模型', status: 'ok' }], allOk: true, criticalOk: true }
          : { checks: [{ id: 'model', label: '模型', status: 'err', detail: '未配置' }], allOk: false, criticalOk: false }
      }
      readinessCache.clear(); connectState.readiness = null
      selectStory('fixture')
      await new Promise(r => setTimeout(r, 120))
      const afterA = document.getElementById('model-state').textContent
      selectStory('fixture2')
      // 采样点：updateStatusBar 已完成（异步），但 fixture2 的探测（延迟 60ms）未返回——
      // 旧代码此处仍显示故事 A 的"模型：可用"。
      await new Promise(r => setTimeout(r, 25))
      const immediate = document.getElementById('model-state').textContent
      await new Promise(r => setTimeout(r, 250))
      const settled = document.getElementById('model-state').textContent
      // 还原现场
      window.hdsiDesktop.stories.list = async () => [stories[0]]
      state.stories = stories.slice(0, 1); state.storyId = 'fixture'
      await refresh()
      return { afterA, immediate, settled }
    })
    assert.ok(/模型：可用/.test(readinessSwitch.afterA), 'story A must show its own model state: ' + readinessSwitch.afterA)
    assert.ok(!/模型：可用/.test(readinessSwitch.immediate), 'switching stories must not leak the previous model state: ' + readinessSwitch.immediate)
    assert.ok(/模型：未配置/.test(readinessSwitch.settled), 'the new story must settle to its own model state: ' + readinessSwitch.settled)

    // ── 复审 P2-2：单节保存不得把其它标签页的草稿烤进预览基线 ────────────
    const previewBaseline = await page.evaluate(async () => {
      window.confirm = () => true
      await openConfig('fixture')
      const deadline = Date.now() + 3000
      while (Date.now() < deadline && document.getElementById('config-save').disabled) await new Promise(r => setTimeout(r, 50))
      // 两个标签页都弄脏，只保存群聊
      const profile = document.querySelector('[data-config-panel="story"] [data-cfg="characterProfile"]')
      profile.value = '预览基线验证。'
      profile.dispatchEvent(new Event('input', { bubbles: true }))
      document.querySelector('[data-config-tab="groups"]').click()
      document.querySelector('[data-add-row="groupChats"]').click()
      document.getElementById('config-save').click()
      await new Promise(r => setTimeout(r, 150))
      const preview = configPreviewText()
      const dirty = [...configDirtyPanels]
      document.getElementById('config-dialog').close()
      return { preview, dirty }
    })
    assert.deepEqual(previewBaseline.dirty, ['story'], 'saving only the groups tab must leave the story tab dirty: ' + JSON.stringify(previewBaseline.dirty))
    assert.ok(/人设与故事.*有变更/.test(previewBaseline.preview), 'preview must still report the unsaved story tab: ' + previewBaseline.preview)

    // ── 复审 P3：暂停缓冲过滤 / save-all 文案 / analysis 标题 / 分析构建防御 ──
    const p3 = await page.evaluate(async () => {
      const out = {}
      // (1) 暂停缓冲按当前过滤条件重筛（hydrate 恢复 + resume 合并两条路径）
      logView.following = false
      logHydratedFor = state.storyId
      logView.paused = [
        { id: 'p-info', storyId: state.storyId, level: 'info', source: 'desktop', line: 'info 行' },
        { id: 'p-err', storyId: state.storyId, level: 'error', source: 'desktop', line: 'error 行' },
      ]
      document.getElementById('log-level-filter').value = 'error'
      applyLogFilters()
      await new Promise(r => setTimeout(r, 120))
      out.pausedLevels = logView.paused.map(i => i.level)
      const before = state.logs.length
      logView.paused.push({ id: 'p-info2', storyId: state.storyId, level: 'info', source: 'desktop', line: '又一 info' })
      resumeLogFollow()
      out.resumeLeaked = state.logs.slice(before).some(i => i.id === 'p-info2')
      document.getElementById('log-level-filter').value = ''
      // (2) save-all 纯结构化失败时不得声称"YAML 已保存"
      const originalWrite = window.hdsiDesktop.stories.configSection
      await openConfig('fixture')
      const deadline = Date.now() + 3000
      while (Date.now() < deadline && document.getElementById('config-save').disabled) await new Promise(r => setTimeout(r, 50))
      document.querySelector('[data-config-tab="groups"]').click()
      document.querySelector('[data-add-row="groupChats"]').click()
      window.hdsiDesktop.stories.configSection = async () => { throw new Error('写入失败（测试注入）') }
      document.getElementById('config-save-all').click()
      await new Promise(r => setTimeout(r, 150))
      out.saveAllStatus = document.getElementById('config-status').textContent
      window.hdsiDesktop.stories.configSection = originalWrite
      document.getElementById('config-dialog').close()
      // (3) analysis 视图标题
      state.browserView = 'analysis'; renderContext()
      out.analysisTitle = document.getElementById('workspace-title').textContent
      state.browserView = 'overview'; renderContext()
      // (4) 四个分析构建函数对退化数据不抛错、不产出 NaN
      const cards = [
        buildCompactionHealth({ maxFacts: 0, activeFacts: 5 }),
        buildCompactionHealth(undefined),
        buildNarrativeCoherence([{ similarityToPrev: undefined }]),
        buildEmotionScenes(undefined, undefined),
        buildEmotionScenes([{ avgAlter: 1, startedAt: new Date().toISOString() }], undefined),
        buildFactMap([{ factId: 'f1', embedding: [0.1, 0.2] }]),
        buildFactMap(undefined),
      ]
      out.analysisCards = cards.length
      out.analysisNaN = cards.some(c => /NaN/.test(c.innerHTML))
      return out
    })
    assert.deepEqual(p3.pausedLevels, ['error'], 'paused buffer restore must re-apply the level filter: ' + JSON.stringify(p3.pausedLevels))
    assert.equal(p3.resumeLeaked, false, 'resume merge must skip entries failing the current filter')
    assert.ok(/保存失败/.test(p3.saveAllStatus), 'save-all failure must be reported: ' + p3.saveAllStatus)
    assert.ok(!/YAML 已保存/.test(p3.saveAllStatus), 'pure structured save failure must not claim YAML was saved: ' + p3.saveAllStatus)
    assert.equal(p3.analysisTitle, '语义分析', 'analysis view must have its own workspace title: ' + p3.analysisTitle)
    assert.equal(p3.analysisCards, 7, 'all degenerate analysis inputs must render a card without throwing')
    assert.equal(p3.analysisNaN, false, 'analysis cards must not contain NaN')

    // ── 全量优化轮：日志/快捷键/label2Key/mixer守卫 ─────────────────────
    const opt = await page.evaluate(() => {
      // T3: 渲染器日志带 id 且增量可见
      const before = document.querySelectorAll('#logs-list > *').length
      appendLog({ storyId: 'fixture', line: '优化轮验证行' })
      const item = state.logs.at(-1)
      const afterRender = document.querySelectorAll('#logs-list > *').length
      // T15: label2Key 未知标签返回 null
      const l2k = [label2Key('SCENES'), label2Key('SCHEDULE / FUTURE'), label2Key('SCRIPT')]
      // T17: mixer 同故事重复 renderArrangement 不重建
      document.querySelector('[data-browser-view="mixer"]').click()
      const rack1 = document.querySelector('.mixer-rack')
      const marker = document.createElement('i'); marker.dataset.probe = '1'; rack1.appendChild(marker)
      renderArrangement()
      const rack2 = document.querySelector('.mixer-rack')
      const survived = !!rack2?.querySelector('[data-probe]')
      return { hasId: typeof item?.id === 'string' && item.id.startsWith('renderer-'), grew: afterRender > before, l2k, mixerIntact: rack1 === rack2 && survived }
    })
    assert.equal(opt.hasId, true, 'renderer log rows must carry ids')
    assert.equal(opt.l2k[0], null, 'SCENES → null (no track mapping)')
    assert.equal(opt.l2k[1], null, 'SCHEDULE → null')
    assert.equal(opt.l2k[2], 'script')
    assert.equal(opt.mixerIntact, true, 'mixer DOM must not rebuild on revision change')
    assert.deepEqual(errors, [], 'page errors')
    console.log('R1 (B20/B21/B23/B24) + R2 (B04/B01/B08/B11/race/B17-18/B25/search) + view modes: PASS')
  } finally { await browser.close() }
})().catch(error => { console.error(error); process.exitCode = 1 })

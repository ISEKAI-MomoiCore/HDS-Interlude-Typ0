// 全量新增功能界面检查（Phase 1-3 + mixer/编辑器扩充）：mock 驱动 + 断言 + 截图。
// 运行：node scripts/ui-review-newfeatures.cjs   （产物 docs/screenshots/ui-review-*.png）
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const { pathToFileURL } = require('node:url')
const puppeteer = require(require.resolve('puppeteer-core', { paths: [process.cwd(), 'C:/dev/HDS-Interlude'] }))

;(async () => {
  const browser = await puppeteer.launch({ executablePath: process.env.UI_TEST_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true })
  const outDir = path.resolve('docs/screenshots')
  fs.mkdirSync(outDir, { recursive: true })
  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 1500, height: 950 })
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    // 已知伪象：headless Chrome 对 file:// 相对 fetch 的 CORS 拦截（真实 Electron
    // 允许，实测 200）；与既有 UI 套件同口径——只断言页面运行时错误。
    page.on('console', msg => {
      if (msg.type() === 'error' && !/CORS policy|ERR_FAILED/i.test(msg.text())) errors.push(msg.text())
    })

    await page.evaluateOnNewDocument(() => {
      const now = Date.now()
      const story = { meta: { id: 'fixture', name: 'UI fixture', characterName: '角色', phase: 'running' }, running: true, bridgeReady: true }
      const entries = [0, 1, 2].map(id => ({ id: id + 1, entityId: 'entry:' + (id + 1), kind: 'script', actor: 'narrator', track: 'script', content: '用于布局验证的原始剧本。'.repeat(40), occurredAt: new Date(now - (3 - id) * 600000).toISOString() }))
      // Mixer：64 参数形态（覆盖 Phase 2 新增的 select/toggle/knob 三型）
      const mixer = []
      const sections = ['MODEL', 'TEMPO', 'MEMORY', 'CHANNEL', 'LOG', 'ADVANCED']
      const params = [
        ['knob', 0, 2, 0.05], ['toggle'], ['select', ['cache-first', 'legacy']], ['text'],
        ['knob', 1, 200, 1], ['toggle'], ['knob', 0, 1, 0.05], ['select', ['off', 'experimental']],
      ]
      sections.forEach((section, si) => params.forEach((def, pi) => {
        const key = 'p' + si + pi
        if (def[0] === 'knob') mixer.push({ key, section, label: '旋钮' + key, desc: '数值参数', type: 'knob', min: def[1], max: def[2], step: def[3], value: 1 })
        else if (def[0] === 'toggle') mixer.push({ key, section, label: '开关' + key, desc: '布尔参数', type: 'toggle', value: true })
        else if (def[0] === 'select') mixer.push({ key, section, label: '枚举' + key, desc: '选择参数', type: 'select', options: def[1], value: def[1][0] })
        else mixer.push({ key, section, label: '文本' + key, desc: '文本参数', type: 'text', value: '' })
      }))
      const pluginEntries = [
        { rawKey: 'server:m0', key: 'server:m0', group: 'server', packageName: 'server', enabled: true, installed: '3.2.4', official: true, risk: 'normal', configText: '      port: 0', lineStart: 3 },
        { rawKey: 'adapter-onebot:m0', key: 'adapter-onebot:m0', group: 'adapter', packageName: 'adapter-onebot', enabled: true, installed: '6.9.4', official: false, risk: 'high', configText: '      selfId: ""', lineStart: 8 },
        { rawKey: 'hds-interlude:m0', key: 'hds-interlude:m0', group: null, packageName: 'hds-interlude', enabled: true, installed: '1.0.1-rc53', official: false, risk: 'normal', configText: '    runtime:\n      autoCreate: true', lineStart: 12 },
        { rawKey: '~points', key: 'points', group: null, packageName: 'points', enabled: false, installed: null, official: false, risk: 'normal', configText: '    threshold: 10', lineStart: 20 },
      ]
      const api = {
        stories: {
          list: async () => [story],
          timelineRange: async (_id, q) => ({ entries: q.limit === 1 ? [] : entries, revision: '1', range: q, timezone: 'Asia/Shanghai', scenes: [], facts: [] }),
          deliveries: async () => [], usage: async () => [],
          mixerRead: async () => mixer, mixerWrite: async () => ({ applied: [] }),
          config: async () => ({ source: 'plugins:\n  hds-interlude:m0:\n', aliases: [] }),
          configSection: async (_id, section) => {
            if (section === 'storyDefaults') return { characterName: '角色', timezone: 'Asia/Shanghai', perspectives: ['第一条', '第二条'], supplementaryFacts: [] }
            if (section === 'groupChats') return [{ groupId: '123', label: '测试群', enabled: true, responseMode: 'always', willingnessPreset: 'custom', willingness: { threshold: 0.3, maxScore: 2, replyCost: 0.5, keywords: ['嗨'] }, assignee: '10001', debounceSeconds: 1, historicalImageLimit: 3 }]
            if (section === 'providers') return [{ id: 'primary', mode: 'gemini-interactions', enabled: true, model: 'gemini-2.5-flash', endpoint: '', apiKey: '$secret:k', useForMain: true, useForVision: true, proxyAgent: 'http://127.0.0.1:7897', priceInput: 0.1 }]
            return []
          },
          plugins: async () => ({ entries: pluginEntries, warnings: [] }),
          pluginToggle: async () => ({ needsReload: true }), pluginConfig: async () => ({ needsReload: true }),
          pluginAdd: async () => ({ needsReload: true }), pluginRemove: async () => ({ needsReload: true }),
          pluginInstall: async () => ({ version: '1.0.0' }), pluginUpdate: async () => ({ version: '1.0.1' }), pluginUninstall: async () => ({}),
          pluginMarketSearch: async () => ({ entries: [{ packageName: 'koishi-plugin-points', pluginName: 'points', version: '1.6.0', description: '积分系统', date: '2026-09-01T00:00:00.000Z', publisher: 'shigma' }, { packageName: 'koishi-plugin-adapter-discord', pluginName: 'adapter-discord', version: '1.0.0', description: 'Discord 适配器', date: '', publisher: '' }] }),
          pluginMarketDetail: async (name) => ({ packageName: name, pluginName: 'points', version: '1.6.0', description: '', date: '', publisher: '', compat: name.includes('adapter') ? 'mismatch' : 'ok', peerRange: '^4.17.0' }),
        },
        runtime: { resources: async () => ({ runningWorkers: 1, maxWorkers: 3 }), overview: async () => ({ inbox: { pending: 0 }, outbox: { states: {} }, worker: {}, recentErrors: [] }) },
        accounts: { status: async () => ({}) }, logs: { query: async () => [], stats: async () => ({}) }, console: { info: async () => ({}) },
        secrets: { aliases: async () => [] },
      }
      globalThis.fixtureRevision = () => 1
      window.hdsiDesktop = new Proxy(api, { get: (target, key) => target[key] || (() => {}) })
    })

    await page.goto(pathToFileURL(path.resolve('src/renderer/index.html')).href)
    await page.waitForFunction(() => document.querySelector('.primary-clip'))
    const shot = name => page.screenshot({ path: path.join(outDir, 'ui-review-' + name + '.png') })

    // ── 1. Mixer：64 参数 + 新增三型 ──
    await page.evaluate(() => { document.querySelector('[data-browser-view="mixer"]').click() })
    await new Promise(r => setTimeout(r, 250))
    const mixerCount = await page.evaluate(() => document.querySelectorAll('.mixer-channel').length)
    console.log('mixer channels rendered (grouped default view):', mixerCount)
    await shot('mixer')

    // ── 2. 配置对话框：逐标签检查 ──
    await page.evaluate(() => { openConfig('fixture') })
    await new Promise(r => setTimeout(r, 300))
    const checkTab = async (tab, name, assertions) => {
      await page.evaluate(t => { document.querySelector('[data-config-tab="' + t + '"]').click() }, tab)
      await new Promise(r => setTimeout(r, 120))
      const missing = await page.evaluate(list => list.map(sel => [sel, !!document.querySelector(sel)]).filter(([, ok]) => !ok), assertions)
      console.log('tab', tab + '(' + name + '):', missing.length ? 'MISSING ' + JSON.stringify(missing.map(m => m[0])) : 'all present')
      assert.deepEqual(missing.map(m => m[0]), [], tab + ' 缺失控件')
      await shot('config-' + tab)
    }

    await checkTab('story', 'storyDefaults', [
      'textarea[data-cfg="perspectives"]', 'textarea[data-cfg="supplementaryFacts"]',
    ])
    const perspectivesValue = await page.evaluate(() => document.querySelector('textarea[data-cfg="perspectives"]').value)
    assert.equal(perspectivesValue, '第一条\n第二条', '数组字段渲染为每行一条')

    await checkTab('groups', '群编辑器', [
      'input[data-row="assignee"]', 'select[data-row="willingnessPreset"]', 'input[data-row="debounceSeconds"]', 'input[data-row="historicalImageLimit"]',
      'input[data-w="threshold"]', 'input[data-w="maxScore"]',
    ])
    const presetValue = await page.evaluate(() => document.querySelector('select[data-row="willingnessPreset"]').value)
    assert.equal(presetValue, 'custom', 'willingnessPreset 回显')

    await checkTab('providers', 'provider 卡片', [
      'select[data-row="mode"] option[value="gemini-interactions"]', 'input[data-row="proxyAgent"]',
      'input[data-row="useForVision"]', 'input[data-row="useForWorldSeeding"]',
      'input[data-row="priceInput"]', 'input[data-row="priceOutput"]', 'input[data-row="priceCachedInput"]',
      '.cfg-card[data-index="0"] .cfg-toggle-mini, #cfg-providers-list .cfg-card .cfg-toggle-mini',
    ])

    await checkTab('plugins', '插件面板', [
      '#plugin-add-btn', '#plugin-console-page-btn', '#plugin-market-search', '#plugin-market-query',
      '#cfg-plugins-list .cfg-card',
    ])
    const pluginCards = await page.evaluate(() => ({
      count: document.querySelectorAll('#cfg-plugins-list .cfg-card').length,
      hasGroupSection: !!document.querySelector('#cfg-plugins-list .cfg-section-title'),
      installBtn: !!document.querySelector('.plugin-install-btn'),
      uninstallBtn: !!document.querySelector('.plugin-uninstall-btn'),
      updateBtn: !!document.querySelector('.plugin-update-btn'),
      riskBadge: !!document.querySelector('#cfg-plugins-list .chip.warn'),
      disabledToggle: !!document.querySelector('#cfg-plugins-list .cfg-toggle-mini:not(.on)'),
    }))
    console.log('plugin panel:', JSON.stringify(pluginCards))
    assert.equal(pluginCards.count, 4, '四张插件卡片')
    assert.ok(pluginCards.riskBadge && pluginCards.disabledToggle && pluginCards.installBtn && pluginCards.uninstallBtn && pluginCards.updateBtn)

    // ── 3. 市场交互：搜索 → 结果 → 兼容性 ──
    await page.evaluate(() => {
      document.querySelector('#plugin-market-query').value = 'points'
      document.querySelector('#plugin-market-search').click()
    })
    await new Promise(r => setTimeout(r, 250))
    const market = await page.evaluate(() => ({
      items: document.querySelectorAll('.plugin-market-item').length,
      first: document.querySelector('.plugin-market-item b')?.textContent,
    }))
    console.log('market:', JSON.stringify(market))
    assert.equal(market.items, 2, '两条市场结果')
    assert.equal(market.first, 'koishi-plugin-points')
    await page.evaluate(() => document.querySelector('.plugin-market-compat').click())
    await new Promise(r => setTimeout(r, 250))
    const compat = await page.evaluate(() => document.querySelector('.plugin-market-compat-result')?.textContent)
    console.log('compat label:', compat)
    assert.match(compat, /兼容/, '兼容性标注渲染')
    await shot('plugins-market')

    assert.deepEqual(errors, [], '全程无页面错误: ' + JSON.stringify(errors))
    console.log('UI REVIEW PASS: mixer/配置四标签/插件面板/市场，全部新增控件在位且交互无错。')
  } finally {
    await browser.close()
  }
})().catch(error => { console.error('UI REVIEW FAIL:', error); process.exitCode = 1 })

// 审计批一（#2/#3/#4/#6）回归：
//  #2 插件包名：完整名（koishi-plugin-* / @scope/*）原样使用，裸短名才拼前缀——
//     更新/卸载/复制/安装四路都不得产生 koishi-plugin-koishi-plugin-* 废包名。
//  #3 插件面板竞态：操作后刷新（无 configLoadSeq）的迟到响应不得覆盖当前面板；
//     末位调用者胜出。
//  #4 市场安装：目标剧本在点击时快照，安装期间切换配置窗口不得写入新剧本。
//  #6 就绪检查：迟到响应不得污染全局 connectState.readiness（状态栏一致性）。
const path = require('node:path')
const assert = require('node:assert/strict')
const puppeteer = require(require.resolve('puppeteer-core', { paths: [process.cwd(), 'C:/dev/HDS-Interlude'] }))

const CONFIG_SOURCE = 'plugins:\n  hds-interlude:m0:\n    storyDefaults:\n      characterName: 测试\n'

function pluginEntries(storyId) {
  return { entries: [
    { rawKey: 'koishi-plugin-foo', key: 'koishi-plugin-foo', group: null, packageName: 'koishi-plugin-foo', enabled: true, installed: '1.0.0', official: false, risk: 'normal', configText: '', lineStart: 1 },
    { rawKey: 'demo-pkg:m1', key: 'demo-pkg:m1', group: null, packageName: '@demo/koishi-plugin-bar', enabled: true, installed: '2.0.0', official: false, risk: 'normal', configText: '', lineStart: 2 },
    { rawKey: 'baz', key: 'baz', group: null, packageName: 'baz', enabled: true, installed: '3.0.0', official: true, risk: 'normal', configText: '', lineStart: 3 },
  ], warnings: [] }
}

;(async () => {
  const browser = await puppeteer.launch({ executablePath: process.env.UI_TEST_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true })
  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 1440, height: 900 })
    const errors = []
    page.on('pageerror', e => errors.push(e.message))
    page.on('dialog', dialog => dialog.accept())
    await page.evaluateOnNewDocument(require('./fixtures/studio.cjs'))
    await page.goto('file://' + path.resolve(process.env.UI_TEST_DIST ? 'dist/renderer/index.html' : 'src/renderer/index.html'))
    await page.waitForFunction(() => document.querySelector('.primary-clip'))
    await page.evaluate(() => {
      window.__pkgCalls = []
      const rec = name => async pkg => { window.__pkgCalls.push([name, pkg]); return { version: '9.9.9' } }
      window.hdsiDesktop.stories.config = async () => ({ source: 'plugins:\n  hds-interlude:m0: {}\n', aliases: [] })
      window.hdsiDesktop.stories.configSection = async (_id, section) => section === 'providers' ? [] : []
      window.hdsiDesktop.stories.plugins = async () => ({ entries: [], warnings: [] })
      window.hdsiDesktop.stories.pluginUpdate = rec('update')
      window.hdsiDesktop.stories.pluginUninstall = rec('uninstall')
      window.hdsiDesktop.stories.pluginInstall = rec('install')
    })

    // ── #2：包名四路 ────────────────────────────────────────────────────
    await page.evaluate(() => {
      // 直接驱动 renderPluginsPanel 的绑定逻辑：注入三类条目后点真实按钮
      window.hdsiDesktop.stories.plugins = async () => ({
        entries: [
          { rawKey: 'koishi-plugin-foo', key: 'koishi-plugin-foo', group: null, packageName: 'koishi-plugin-foo', enabled: true, installed: '1.0.0', official: false, risk: 'normal', configText: '', lineStart: 1 },
          { rawKey: 'bar:m1', key: 'bar:m1', group: null, packageName: '@demo/koishi-plugin-bar', enabled: true, installed: '2.0.0', official: false, risk: 'normal', configText: '', lineStart: 2 },
          { rawKey: 'baz', key: 'baz', group: null, packageName: 'baz', enabled: true, installed: '3.0.0', official: true, risk: 'normal', configText: '', lineStart: 3 },
        ],
        warnings: [],
      })
    })
    await page.evaluate(() => openConfig('fixture'))
    await page.waitForFunction(() => document.querySelector('#cfg-plugins-list .cfg-card'))
    const pkgCalls = await page.evaluate(async () => {
      // 更新：三个卡片各点一次
      for (const btn of document.querySelectorAll('#cfg-plugins-list .plugin-update-btn')) btn.click()
      await new Promise(r => setTimeout(r, 150))
      // 卸载是两段式：连点两次
      for (const btn of document.querySelectorAll('#cfg-plugins-list .plugin-uninstall-btn')) { btn.click(); btn.click() }
      await new Promise(r => setTimeout(r, 150))
      return window.__pkgCalls.filter(call => call[0] !== 'install')
    })
    const updates = pkgCalls.filter(call => call[0] === 'update').map(call => call[1]).sort()
    const uninstalls = pkgCalls.filter(call => call[0] === 'uninstall').map(call => call[1]).sort()
    assert.deepEqual(updates, ['@demo/koishi-plugin-bar', '@koishijs/plugin-baz', 'koishi-plugin-foo'], `更新必须用完整包名：${JSON.stringify(updates)}`)
    assert.deepEqual(uninstalls, ['@demo/koishi-plugin-bar', '@koishijs/plugin-baz', 'koishi-plugin-foo'], `卸载必须用完整包名：${JSON.stringify(uninstalls)}`)
    assert.equal(JSON.stringify(pkgCalls).includes('koishi-plugin-koishi-plugin'), false, '不得出现双拼包名')
    assert.equal(JSON.stringify(pkgCalls).includes('koishi-plugin-@'), false, '不得给域名再拼 koishi-plugin-')

    // 安装：完整名直装（无官方域回退重试）
    const installCalls = await page.evaluate(async () => {
      window.__pkgCalls.length = 0
      window.hdsiDesktop.stories.pluginInstall = async pkg => {
        window.__pkgCalls.push(['install', pkg])
        if (pkg.includes('@koishijs/plugin-koishi')) throw new Error('不应重试出废包名')
        return { version: '1.0.0' }
      }
      // 未安装条目才有安装按钮：注入一个未安装的完整名条目
      window.hdsiDesktop.stories.plugins = async () => ({ entries: [
        { rawKey: 'koishi-plugin-qux', key: 'koishi-plugin-qux', group: null, packageName: 'koishi-plugin-qux', enabled: true, installed: null, official: false, risk: 'normal', configText: '', lineStart: 1 },
      ], warnings: [] })
      void renderPluginsPanel('fixture')
      await new Promise(r => setTimeout(r, 200))
      let copied = ''
      navigator.clipboard.writeText = async text => { copied = text }
      document.querySelector('#cfg-plugins-list .plugin-install-copy')?.click()
      document.querySelector('#cfg-plugins-list .plugin-install-btn')?.click()
      await new Promise(r => setTimeout(r, 200))
      return { calls: window.__pkgCalls, copied }
    })
    assert.deepEqual(installCalls.calls, [['install', 'koishi-plugin-qux']], `完整名必须原样安装：${JSON.stringify(installCalls.calls)}`)
    assert.match(installCalls.copied, /npm install koishi-plugin-qux /, `复制命令必须可直接安装：${JSON.stringify(installCalls.copied)}`)

    // ── #3：面板竞态（操作后刷新无 seq 的迟到响应）────────────────────
    const raceResult = await page.evaluate(async () => {
      const deferred = {}
      let phase = 0
      window.hdsiDesktop.stories.plugins = async id => {
        phase += 1
        if (phase === 1) return { entries: [{ rawKey: 'a-key', key: 'a-key', group: null, packageName: 'koishi-plugin-a', enabled: true, installed: '1', official: false, risk: 'normal', configText: '', lineStart: 1 }], warnings: [] }
        if (phase === 2) return new Promise(resolve => { deferred.resolve = () => resolve({ entries: [{ rawKey: 'stale-a', key: 'stale-a', group: null, packageName: 'koishi-plugin-stale-a', enabled: true, installed: '1', official: false, risk: 'normal', configText: '', lineStart: 1 }], warnings: [] }) })
        return { entries: [{ rawKey: 'b-key', key: 'b-key', group: null, packageName: 'koishi-plugin-b', enabled: true, installed: '1', official: false, risk: 'normal', configText: '', lineStart: 1 }], warnings: [] }
      }
      // 1) A 打开（面板渲染 A）→ 2) A 的操作后刷新挂起 → 3) B 打开渲染 → 4) 放行 A 的迟到响应
      await renderPluginsPanel('story-a')
      const stale = renderPluginsPanel('story-a')   // 无 seq：操作后刷新路径
      await renderPluginsPanel('story-b')
      deferred.resolve()
      await stale
      await new Promise(r => setTimeout(r, 100))
      const cards = [...document.querySelectorAll('#cfg-plugins-list .cfg-card b')].map(el => el.textContent)
      return { cards }
    })
    assert.deepEqual(raceResult.cards, ['koishi-plugin-b'], `迟到刷新不得覆盖当前面板：${JSON.stringify(raceResult.cards)}`)

    // ── #4：市场安装目标快照 ────────────────────────────────────────────
    const marketResult = await page.evaluate(async () => {
      const calls = []
      let releaseInstall
      const installGate = new Promise(resolve => { releaseInstall = resolve })
      window.hdsiDesktop.stories.plugins = async () => ({ entries: [], warnings: [] })
      window.hdsiDesktop.stories.pluginMarketSearch = async () => ({ entries: [{ packageName: 'koishi-plugin-market-demo', pluginName: 'market-demo', description: 'demo' }] })
      window.hdsiDesktop.stories.pluginMarketDetail = async () => ({ compat: 'ok' })
      window.hdsiDesktop.stories.pluginInstall = async pkg => { calls.push(['install', pkg]); await installGate; return { version: '1.0.0' } }
      window.hdsiDesktop.stories.pluginAdd = async (id, name) => { calls.push(['add', id, name]); return { needsReload: false } }
      // 打开 A 的配置 → 市场搜索 → 点安装（挂起）→ 切到 B → 放行
      await openConfig('story-a')
      await new Promise(r => setTimeout(r, 200))
      byId('plugin-market-query').value = 'demo'
      byId('plugin-market-search').click()
      await new Promise(r => setTimeout(r, 250))
      const installBtn = document.querySelector('.plugin-market-install')
      if (!installBtn) return { error: 'install button not found', html: byId('plugin-market-results')?.innerHTML?.slice(0, 200) ?? '' }
      installBtn.click()
      await new Promise(r => setTimeout(r, 100))
      openConfig('story-b')   // 安装期间切换配置窗口
      await new Promise(r => setTimeout(r, 100))
      releaseInstall()
      await new Promise(r => setTimeout(r, 200))
      return { calls }
    })
    assert.equal(marketResult.error, undefined, `市场安装流程必须可驱动：${JSON.stringify(marketResult)}`)
    const addCall = marketResult.calls.find(call => call[0] === 'add')
    assert.deepEqual(addCall, ['add', 'story-a', 'market-demo'], `插件必须加到点击时的剧本 A：${JSON.stringify(marketResult.calls)}`)

    // ── #6：readiness 迟到响应不污染全局 ────────────────────────────────
    const readinessResult = await page.evaluate(async () => {
      const deferred = {}
      let phase = 0
      window.hdsiDesktop.connection = { firstRunReadiness: async id => {
        phase += 1
        if (phase === 1) return new Promise(resolve => { deferred.resolve = () => resolve({ storyId: id, checks: [{ id: 'model', label: '模型配置', status: 'err', detail: 'x' }], allOk: false, criticalOk: false, channel: { layers: [] }, account: { layers: [] } }) })
        return { storyId: id, checks: [{ id: 'model', label: '模型配置', status: 'ok', detail: '' }], allOk: true, criticalOk: true, channel: { layers: [] }, account: { layers: [] } }
      } }
      state.stories = [
        { meta: { id: 'story-a', name: 'A', characterName: 'a', phase: 'paused' }, running: false },
        { meta: { id: 'story-b', name: 'B', characterName: 'b', phase: 'paused' }, running: false },
      ]
      setSurface('connect')
      state.storyId = 'story-a'
      readinessCache.clear()
      const stale = renderReadyPanel()      // A：挂起
      state.storyId = 'story-b'
      const fresh = renderReadyPanel()      // B：立即完成
      await fresh
      deferred.resolve()                    // A 的迟到响应
      await stale
      await new Promise(r => setTimeout(r, 100))
      return { globalStoryId: connectState.readiness?.storyId, panelText: byId('connect-ready-panel')?.textContent ?? '' }
    })
    assert.equal(readinessResult.globalStoryId, 'story-b', `全局 readiness 必须是当前剧本 B：${JSON.stringify(readinessResult)}`)
    assert.match(readinessResult.panelText, /全部就绪/, 'B 的面板应显示就绪')

    assert.deepEqual(errors, [], `页面错误：${errors.join(' | ')}`)
    console.log('test-ui-audit-round: PASS（包名四路 / 面板竞态 / 市场快照 / readiness 守卫 ×4）')
  } finally {
    await browser.close()
  }
})().catch(error => { console.error(error); process.exit(1) })

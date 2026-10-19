// 插件版配置导入向导 UI 回归：按钮 → 预览（模块勾选/默认项/警告/目标）→
// 执行（含删除现有剧本确认）→ 报告。importer IPC 以页内 mock 注入。
const path = require('node:path')
const assert = require('node:assert/strict')
const puppeteer = require(require.resolve('puppeteer-core', { paths: [process.cwd(), 'C:/dev/HDS-Interlude'] }))

const ANALYSIS = {
  file: 'koishi.yml',
  modules: {
    persona: { present: true, characterName: '迁移角色' },
    relations: { users: 2, groups: 1 },
    accounts: { bots: 1, adapters: [{ selfId: '10001', protocol: 'ws', endpoint: 'ws://127.0.0.1:3001/', reverse: false }, { selfId: '10002', protocol: 'ws-reverse', endpoint: '', reverse: true }], bindable: 1 },
    model: { providers: 2, modes: ['openai-compatible', 'deepseek-official'], plaintextKeys: 2, secretRefs: 0 },
    behavior: [{ key: 'urge', present: true, enabled: true }, { key: 'memory', present: true, enabled: true }],
    mainPrompt: { present: true },
    misc: { blindMode: true, logging: false },
  },
  warnings: ['检测到 2 个明文 API Key：导入时自动转入本机密钥库。'],
}
const RESULT = {
  storyId: 'import-test01', storyName: '迁移角色',
  report: [
    { module: '人设与故事', status: 'ok', detail: 'characterName=迁移角色' },
    { module: '账号', status: 'ok', detail: '已登记 10001 → ws://127.0.0.1:3001/' },
    { module: '主提示词覆盖', status: 'skipped', detail: '未选择（保持 typ0 默认）' },
  ],
  secrets: ['migrated-provider-1-key'],
  account: { selfId: '10001', endpoint: 'ws://127.0.0.1:3001/' },
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
    await page.evaluate(({ analysis, result }) => {
      globalThis.__importCalls = []
      window.hdsiDesktop.importer = {
        pickAnalyze: async () => { globalThis.__importCalls.push('analyze'); return { sessionId: 'sess-1', analysis } },
        execute: async (sessionId, options) => {
          globalThis.__importCalls.push(['execute', sessionId, options])
          return result
        },
      }
      window.hdsiDesktop.stories.delete = async id => { globalThis.__importCalls.push(['delete', id]) }
    }, { analysis: ANALYSIS, result: RESULT })

    // 连接页 → 显眼按钮 → 向导打开
    await page.evaluate(() => setSurface('connect'))
    await page.waitForSelector('#import-config-btn')
    await page.click('#import-config-btn')
    try {
      await page.waitForFunction(() => byId('import-dialog').open, { timeout: 8000 })
    } catch (error) {
      const diag = await page.evaluate(() => ({ open: byId('import-dialog')?.open, bodyLen: byId('import-body')?.innerHTML?.length ?? -1, surface: document.querySelector('#connect-surface')?.classList.contains('active') }))
      console.error('DIAG:', JSON.stringify(diag), 'errors:', JSON.stringify(errors))
      throw error
    }

    const preview = await page.evaluate(() => ({
      badge: byId('import-dialog-badge').textContent,
      modules: [...document.querySelectorAll('[data-module]')].map(el => ({ key: el.dataset.module, checked: el.checked })),
      warnings: [...document.querySelectorAll('.pack-diag-list .pack-diag-warn')].map(el => el.textContent),
      storyName: byId('import-story-name')?.value,
      deleteOptions: [...document.querySelectorAll('[data-delete-id]')].map(el => el.dataset.deleteId),
      runVisible: !byId('import-run').hidden,
    }))
    assert.equal(preview.badge, 'koishi.yml')
    const moduleMap = Object.fromEntries(preview.modules.map(item => [item.key, item.checked]))
    assert.deepEqual(moduleMap, { persona: true, relations: true, accounts: true, model: true, behavior: true, mainPrompt: false, misc: true }, '默认勾选：主提示词不动，其余全选')
    assert.equal(preview.storyName, '迁移角色', '剧本名默认取源角色名')
    assert.ok(preview.warnings.some(text => text.includes('明文')))
    assert.deepEqual(preview.deleteOptions, ['fixture'], '现有剧本列为可选删除项')

    // 勾选删除现有剧本 → 执行（confirm 由 dialog handler 自动接受）→ 报告 + 删除调用
    await page.click('[data-delete-id="fixture"]')
    await page.click('#import-run')
    await page.waitForFunction(() => byId('import-dialog-badge').textContent === '完成')
    const report = await page.evaluate(() => ({
      title: document.querySelector('.pack-preview-identity strong')?.textContent,
      secrets: [...document.querySelectorAll('.pack-preview-block code')].map(node => node.textContent),
      runHidden: byId('import-run').hidden,
      calls: globalThis.__importCalls,
      selectedStoryId: state.storyId,
    }))
    assert.match(report.title, /迁移角色/)
    assert.equal(report.selectedStoryId, 'import-test01', '导入成功后自动切换到新剧本')
    assert.deepEqual(report.secrets, ['migrated-provider-1-key'])
    assert.equal(report.runHidden, true)
    const executeCall = report.calls.find(item => Array.isArray(item) && item[0] === 'execute')
    assert.equal(executeCall[1], 'sess-1')
    assert.equal(executeCall[2].modules.mainPrompt, false)
    assert.equal(executeCall[2].storyName, '迁移角色')
    assert.deepEqual(report.calls.filter(item => Array.isArray(item) && item[0] === 'delete'), [['delete', 'fixture']], '删除现有剧本在导入成功后执行')

    assert.deepEqual(errors, [], 'page errors')
    console.log('Config import wizard UI: PASS')
  } finally { await browser.close() }
})().catch(error => { console.error(error); process.exit(1) })

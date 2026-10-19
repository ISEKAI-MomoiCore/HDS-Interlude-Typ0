// 模型提供商卡片的模式感知回归：字段随 mode 变化（Console Provider schema 同构）、
// 切换保留已填值、端点仅 openai-compatible 存在、向导端点口径一致。
const path = require('node:path')
const assert = require('node:assert/strict')
const puppeteer = require(require.resolve('puppeteer-core', { paths: [process.cwd(), 'C:/dev/HDS-Interlude'] }))

const PROVIDERS = [{ id: 'main', label: '主模型', enabled: true, mode: 'openai-compatible', protocol: 'chat-completions', model: '$secret:primary-model', endpoint: '$secret:primary-endpoint', apiKey: '$secret:primary-key', temperature: 0.8, useForMain: true }]

;(async () => {
  const browser = await puppeteer.launch({ executablePath: process.env.UI_TEST_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true })
  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 1440, height: 900 })
    const errors = []
    page.on('pageerror', e => errors.push(e.message))
    await page.evaluateOnNewDocument(require('./fixtures/studio.cjs'))
    await page.goto('file://' + path.resolve(process.env.UI_TEST_DIST ? 'dist/renderer/index.html' : 'src/renderer/index.html'))
    await page.waitForFunction(() => document.querySelector('.primary-clip'))
    await page.evaluate(providers => {
      window.hdsiDesktop.stories.config = async () => ({ source: 'plugins:\n', aliases: [] })
      window.hdsiDesktop.stories.configSection = async (_id, section) => section === 'providers' ? providers : []
      window.hdsiDesktop.stories.plugins = async () => ({ plugins: [] })
    }, PROVIDERS)
    await page.evaluate(() => openConfig('fixture'))
    await new Promise(r => setTimeout(r, 400))
    await page.click('[data-config-tab="providers"]')
    await new Promise(r => setTimeout(r, 150))
    await page.evaluate(() => { document.querySelector('#cfg-providers-list .cfg-card').classList.add('expanded') })

    // 1) 兼容模式：头部有端点；详细有请求协议 + DeepSeek 思考（inherit）
    const compat = await page.evaluate(() => ({
      headerEndpoint: !!document.querySelector('#cfg-providers-list [data-row="endpoint"]'),
      protocol: !!document.querySelector('#cfg-providers-list select[data-row="protocol"]'),
      dsThinking: !!document.querySelector('#cfg-providers-list select[data-row="deepseekThinking"]'),
      effortHidden: !document.querySelector('#cfg-providers-list select[data-row="deepseekReasoningEffort"]'),
    }))
    assert.equal(compat.headerEndpoint, true, '兼容模式头部显示端点')
    assert.equal(compat.protocol, true, '兼容模式提供请求协议（格式）')
    assert.equal(compat.dsThinking, true)
    assert.equal(compat.effortHidden, true, '思考=inherit 时不显示强度')

    // 2) 切 anthropic 协议 → 出现缓存标记；开思考 → 出现强度
    await page.select('#cfg-providers-list select[data-row="protocol"]', 'anthropic-messages')
    await new Promise(r => setTimeout(r, 80))
    assert.equal(await page.$eval('#cfg-providers-list [data-row="anthropicCache"]', n => n.type), 'checkbox', 'anthropic 协议显示缓存标记')
    await page.select('#cfg-providers-list select[data-row="deepseekThinking"]', 'enabled')
    await new Promise(r => setTimeout(r, 80))
    assert.ok(await page.$('#cfg-providers-list select[data-row="deepseekReasoningEffort"]'), '思考=enabled 显示强度')

    // 3) 改模型名 → 切 deepseek-official：值保留、端点/协议消失、出现官方思考模式
    await page.evaluate(() => { const input = document.querySelector('#cfg-providers-list input[data-row="model"]'); input.value = 'deepseek-chat' })
    await page.select('#cfg-providers-list select[data-row="mode"]', 'deepseek-official')
    await new Promise(r => setTimeout(r, 80))
    const official = await page.evaluate(() => ({
      headerEndpoint: !!document.querySelector('#cfg-providers-list [data-row="endpoint"]'),
      protocol: !!document.querySelector('#cfg-providers-list select[data-row="protocol"]'),
      model: document.querySelector('#cfg-providers-list input[data-row="model"]')?.value,
      apiKey: document.querySelector('#cfg-providers-list input[data-row="apiKey"]')?.value,
      dsThinking: [...document.querySelectorAll('#cfg-providers-list select[data-row="deepseekThinking"] option')].map(o => o.value),
    }))
    assert.equal(official.headerEndpoint, false, '官方模式不显示端点（自动使用官方端点）')
    assert.equal(official.protocol, false)
    assert.equal(official.model, 'deepseek-chat', '切换模式保留已填模型名')
    assert.equal(official.apiKey, '$secret:primary-key', '切换模式保留 API Key')
    assert.deepEqual(official.dsThinking, ['disabled', 'enabled'], 'deepseek-official 思考档为 disabled/enabled')

    // 4) 序列化：mode/思考档生效，未触碰字段保留
    const serialized = await page.evaluate(() => serializeConfigSections().providers[0])
    assert.equal(serialized.mode, 'deepseek-official')
    assert.equal(serialized.model, 'deepseek-chat')
    assert.equal(serialized.useForMain, true)
    assert.equal(serialized.id, 'main', '旧 id 保留（providerKey 匹配用）')

    // 5) 切回兼容模式：端点恢复显示且保留原值
    await page.select('#cfg-providers-list select[data-row="mode"]', 'openai-compatible')
    await new Promise(r => setTimeout(r, 80))
    const backCompat = await page.evaluate(() => document.querySelector('#cfg-providers-list input[data-row="endpoint"]')?.value)
    assert.equal(backCompat, '$secret:primary-endpoint', '切回兼容模式恢复原端点')

    // 6) 向导：官方模式隐藏端点输入；openrouter 不再要求端点
    await page.evaluate(() => byId('config-dialog').close())
    await page.evaluate(() => openWizard())
    await page.click('#wizard-next'); await page.click('#wizard-next')
    await new Promise(r => setTimeout(r, 150))
    const wizard = await page.evaluate(() => {
      const form = byId('story-form')
      const endpointLabel = form.querySelector('[name=providerEndpoint]').closest('label')
      form.querySelector('[name=providerModel]').value = 'deepseek-chat'
      form.querySelector('[name=providerApiKey]').value = 'sk-test'
      form.querySelector('[name=providerMode]').value = 'deepseek-official'
      form.querySelector('[name=providerMode]').dispatchEvent(new Event('change', { bubbles: true }))
      return { endpointHidden: endpointLabel.hidden }
    })
    await new Promise(r => setTimeout(r, 200))
    const wizardStatus = await page.evaluate(() => byId('wizard-model-status').textContent)
    assert.equal(wizard.endpointHidden, true, '向导官方模式隐藏端点输入')
    assert.match(wizardStatus, /OK/, `deepseek-official 无端点应通过（实际：${wizardStatus}）`)
    await page.evaluate(() => {
      const form = byId('story-form')
      form.querySelector('[name=providerMode]').value = 'openai-compatible'
      form.querySelector('[name=providerMode]').dispatchEvent(new Event('change', { bubbles: true }))
    })
    await new Promise(r => setTimeout(r, 200))
    const compatStatus = await page.evaluate(() => byId('wizard-model-status').textContent)
    assert.match(compatStatus, /WARNING.*端点/, '兼容模式无端点仍应警告')

    assert.deepEqual(errors, [], 'page errors')
    console.log('Providers mode-aware card / wizard: PASS')
  } finally { await browser.close() }
})().catch(error => { console.error(error); process.exit(1) })

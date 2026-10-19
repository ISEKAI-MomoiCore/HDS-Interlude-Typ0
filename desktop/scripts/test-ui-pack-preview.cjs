// 主题包导入预览/失效包处置的 UI 回归（第二批导入体验批次）。
// 复用 studio fixture；packs IPC 以页面内 mock 注入（只覆盖 packs 域，
// 其余仍走 fixture 的 hdsiDesktop Proxy），不触碰真实安装目录。
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const { pathToFileURL } = require('node:url')
const screenshotDir = process.env.UI_TEST_SCREENSHOT_DIR || require('node:os').tmpdir()
fs.mkdirSync(screenshotDir, { recursive: true })
const puppeteer = require(require.resolve('puppeteer-core', { paths: [process.cwd(), 'C:/dev/HDS-Interlude'] }))

const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="60"><rect width="240" height="60" fill="#1a1b26"/><rect x="8" y="18" width="44" height="24" fill="#7aa2f7"/><rect x="60" y="18" width="44" height="24" fill="#9ece6a"/></svg>'
const goodTheme = {
  id: 'community-preview-demo', version: '1.4.0', name: 'Preview Demo', displayName: '预览演示',
  author: { name: 'Fixture Author' }, license: 'CC-BY-4.0', preview: 'preview.svg',
  tokens: { 'color.canvas': '#1a1b26', 'color.text.primary': '#c0caf5', 'color.accent': '#7aa2f7' },
  overrides: { pages: ['connect-main'] },
}
const badTheme = { ...goodTheme, id: 'community-preview-bad', displayName: '对比度失败', tokens: { 'color.canvas': '#ffffff', 'color.text.primary': '#fdfdfd', 'color.accent': '#7aa2f7' } }
const pageDef = JSON.stringify({ page: { id: 'connect-main', route: 'connect', title: { fallback: '连接与账号' }, layout: { type: 'divider' } } })
const goodEntries = { 'theme.json': JSON.stringify(goodTheme), 'preview.svg': svg, 'pages/connect.json': pageDef }
const badEntries = { 'theme.json': JSON.stringify(badTheme), 'preview.svg': svg }

;(async () => {
  const browser = await puppeteer.launch({ executablePath: process.env.UI_TEST_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true })
  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 1280, height: 860 })
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.evaluateOnNewDocument(require('./fixtures/studio.cjs'))
    await page.goto(pathToFileURL(path.resolve(process.env.UI_TEST_DIST ? 'dist/renderer/index.html' : 'src/renderer/index.html')).href)
    await page.waitForFunction(() => document.querySelector('.primary-clip'))
    await page.evaluate((goodEntries, badEntries) => {
      globalThis.__packEvents = []
      window.hdsiDesktop.packs = {
        appVersion: async () => '0.0.1-m4',
        pickRead: async () => ({ path: 'demo.hdsitheme', entries: globalThis.__nextPack === 'bad' ? badEntries : goodEntries }),
        install: async (id) => { globalThis.__packEvents.push(['install', id]); return { ok: true, id } },
        listInstalled: async () => globalThis.__packList || [],
        write: async () => ({ ok: true, path: './demo.hdsitheme' }),
        uninstall: async (id) => { globalThis.__packEvents.push(['uninstall', id]); return { ok: true } },
      }
    }, goodEntries, badEntries)

    // 1) 通过验证的包：预览展示身份/判定/色板/预览图/页面清单 → 确认安装 → 社区区出现卡片
    await page.click('#theme-menu-btn')
    await page.waitForFunction(() => byId('theme-dialog').open)
    await page.click('#pack-import')
    await page.waitForFunction(() => byId('pack-preview-dialog').open)
    const preview = await page.evaluate(() => ({
      verdict: byId('pack-preview-verdict').textContent,
      name: document.querySelector('.pack-preview-identity strong')?.textContent,
      swatches: document.querySelectorAll('.pack-preview-body .theme-swatches i').length,
      pages: [...document.querySelectorAll('.pack-preview-block ul li')].map(li => li.textContent),
      confirmDisabled: byId('pack-preview-confirm').disabled,
      artSvg: !!document.querySelector('.pack-preview-art svg'),
    }))
    assert.match(preview.verdict, /通过/)
    assert.equal(preview.name, '预览演示')
    assert.equal(preview.swatches, 10)
    assert.ok(preview.pages.some(text => text.includes('connect.json')), JSON.stringify(preview.pages))
    assert.equal(preview.confirmDisabled, false)
    assert.equal(preview.artSvg, true, '预览图以内联 SVG 渲染（CSP 不允许 data: 图片）')
    await page.click('#pack-preview-confirm')
    await page.waitForFunction(() => !byId('pack-preview-dialog').open)
    await page.waitForFunction(() => document.querySelector('#theme-sections .theme-card[data-theme-id="community-preview-demo"]'))
    assert.deepEqual(await page.evaluate(() => globalThis.__packEvents), [['install', 'community-preview-demo']])

    // 2) 阻断的包：诊断逐条展示（code + 路径），安装按钮禁用，取消后不落盘
    await page.evaluate(() => { globalThis.__nextPack = 'bad' })
    await page.click('#pack-import')
    await page.waitForFunction(() => byId('pack-preview-dialog').open && byId('pack-preview-verdict').textContent.includes('阻断'))
    const blocked = await page.evaluate(() => ({
      confirmDisabled: byId('pack-preview-confirm').disabled,
      confirmLabel: byId('pack-preview-confirm').textContent,
      codes: [...document.querySelectorAll('.pack-diag-list code')].map(node => node.textContent),
      paths: [...document.querySelectorAll('.pack-diag-path')].map(node => node.textContent),
    }))
    assert.equal(blocked.confirmDisabled, true)
    assert.equal(blocked.confirmLabel, '不可安装')
    assert.ok(blocked.codes.includes('CONTRAST_BODY'), blocked.codes.join(','))
    assert.ok(blocked.paths.includes('theme.json#tokens'), blocked.paths.join(','))
    await page.click('#pack-preview-cancel')
    const afterBlocked = await page.evaluate(() => ({
      events: globalThis.__packEvents.length,
      cards: document.querySelectorAll('#theme-sections .theme-card[data-theme-id="community-preview-bad"]').length,
    }))
    assert.equal(afterBlocked.cards, 0)
    assert.equal(afterBlocked.events, 1, '阻断包不得触发安装')

    // 3) 恢复失败上报：损坏/失效包在外观页展示原因，可卸载
    await page.evaluate(badEntries => {
      globalThis.__packList = [
        { id: 'pack-corrupt', entries: {}, error: '主题包条目超过 2MB：big.png' },
        { id: 'pack-stale', entries: badEntries },
      ]
    }, badEntries)
    await page.evaluate(() => window.__reloadThemePacks())
    await page.waitForFunction(() => document.querySelectorAll('.pack-failed-card').length === 2)
    const failedView = await page.evaluate(() => [...document.querySelectorAll('.pack-failed-card')].map(card => ({ id: card.dataset.packId, text: card.textContent })))
    assert.deepEqual(failedView.map(item => item.id), ['pack-corrupt', 'pack-stale'])
    assert.match(failedView[0].text, /2MB/)
    assert.match(failedView[1].text, /正文对比度/)
    await page.click('.pack-failed-uninstall')
    await page.waitForFunction(() => document.querySelectorAll('.pack-failed-card').length === 1)
    assert.deepEqual(await page.evaluate(() => globalThis.__packEvents.filter(event => event[0] === 'uninstall')), [['uninstall', 'pack-corrupt']])

    assert.deepEqual(errors, [], 'page errors')
    await page.screenshot({ path: path.join(screenshotDir, 'ui-pack-preview.png') })
    console.log('Pack preview / failed-pack UI: PASS')
  } finally {
    await browser.close()
  }
})().catch(error => { console.error(error); process.exit(1) })

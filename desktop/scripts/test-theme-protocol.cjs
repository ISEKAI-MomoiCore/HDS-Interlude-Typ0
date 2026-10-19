const assert = require('node:assert/strict')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const themeDir = path.join(root, 'src', 'renderer', 'theme')

globalThis.HDSITokens = require(path.join(themeDir, 'tokens.js'))
globalThis.HDSIBuiltinThemes = require(path.join(themeDir, 'themes-builtin.js'))
globalThis.HDSIThemeCompat = { convert: () => null }

globalThis.localStorage = (() => {
  const data = new Map()
  return { getItem: key => data.get(key) || null, setItem: (key, value) => data.set(key, String(value)), removeItem: key => data.delete(key) }
})()
const styleValues = new Map()
const headChildren = []
globalThis.document = {
  createElement: tag => ({ tagName: tag.toUpperCase(), attrs: new Map(), setAttribute(name, value) { this.attrs.set(name, String(value)) }, remove() { const i = headChildren.indexOf(this); if (i >= 0) headChildren.splice(i, 1) } }),
  head: { appendChild(node) { headChildren.push(node); node.parentNode = this } },
  documentElement: {
    style: {
      colorScheme: '',
      setProperty: (name, value) => styleValues.set(name, String(value)),
      removeProperty: name => styleValues.delete(name),
    },
    attrs: new Map(),
    setAttribute(name, value) { this.attrs.set(name, String(value)) },
    getAttribute(name) { return this.attrs.get(name) || null },
    removeAttribute(name) { this.attrs.delete(name) },
  },
}
globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, addListener() {} })

const validator = require(path.join(themeDir, 'pack-validator.js'))
const runtime = require(path.join(themeDir, 'theme-runtime.js'))

const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><rect width="4" height="4" fill="#fff"/></svg>'
const theme = {
  id: 'community-test-pack', version: '1.0.0', name: 'Protocol test', displayName: 'Protocol test',
  preview: 'preview.svg',
  tokens: {
    'color.canvas': '#f3f1eb',
    'color.text.primary': '#1f2327',
    'color.accent': '#174a63',
  },
  surfaces: { hero: 'asset://hero.svg' },
  fonts: { ui: { src: 'asset://fonts/ui.woff2', weight: '400 700', style: 'normal' } },
  motion: { level: 'subtle', presets: { fade: { from: { opacity: 0 }, to: { opacity: 1 }, duration: 160, easing: 'ease-out', properties: ['opacity'] } } },
  interactions: { page: { enter: 'fade', exit: 'fade' }, panel: { expand: 'fade' } },
  overrides: { pages: ['connect-main'] },
}
const entries = {
  'theme.json': JSON.stringify(theme),
  'preview.svg': svg,
  'assets/hero.svg': svg,
  'assets/fonts/ui.woff2': 'b64:d09GMgABAAAAAA==',
  'pages/connect.json': JSON.stringify({ page: { id: 'connect-main', route: 'connect', background: 'asset://hero.svg', layout: { type: 'divider' } } }),
}

const report = validator.validateEntries(entries, '0.0.1')
assert.equal(report.verdict, 'pass', JSON.stringify(report))
assert.equal(report.pack.pages.length, 1)
const badPage = { ...entries, 'pages/connect.json': JSON.stringify({ page: { id: 'connect-main', background: 'https://example.invalid/x.png' } }) }
assert.equal(validator.validateEntries(badPage, '0.0.1').verdict, 'block')
const badMotion = { ...entries, 'theme.json': JSON.stringify({ ...theme, motion: { level: 'expressive', presets: { x: { properties: ['width'] } } } }) }
assert.equal(validator.validateEntries(badMotion, '0.0.1').verdict, 'block')
const badFont = { ...entries, 'theme.json': JSON.stringify({ ...theme, fonts: { ui: { src: 'https://fonts.example/ui.woff2' } } }) }
assert.equal(validator.validateEntries(badFont, '0.0.1').verdict, 'block')
const missingFont = { ...entries, 'theme.json': JSON.stringify({ ...theme, fonts: { ui: { src: 'asset://fonts/missing.woff2' } } }) }
assert.equal(validator.validateEntries(missingFont, '0.0.1').verdict, 'block')
const unsafeMotion = { ...entries, 'theme.json': JSON.stringify({ ...theme, motion: { presets: { fade: { from: { opacity: 0, width: '100px' }, to: { opacity: 1 }, duration: 100 } } } }) }
assert.equal(validator.validateEntries(unsafeMotion, '0.0.1').verdict, 'block')
const badInteraction = { ...entries, 'theme.json': JSON.stringify({ ...theme, interactions: { panel: { expand: 'missing' } } }) }
assert.equal(validator.validateEntries(badInteraction, '0.0.1').verdict, 'block')
const badPageMotion = { ...entries, 'pages/connect.json': JSON.stringify({ page: { id: 'connect-main', motion: { enter: 'missing' }, layout: { type: 'divider' } } }) }
assert.equal(validator.validateEntries(badPageMotion, '0.0.1').verdict, 'block')
// 兼容版本比较忽略预发布后缀：主进程真实版本号（如 0.0.1-m3）不得被误判
assert.equal(validator.versionAtLeast('0.0.1-m3', '0.0.1'), true)
assert.equal(validator.versionAtLeast('0.0.1-m3', '0.0.2'), false)
assert.equal(validator.versionAtLeast('0.1.0-rc.1', '0.0.9'), true)

runtime.registerTheme({
  id: theme.id, name: theme.name, colors: { canvas: '#f3f1eb', textPrimary: '#1f2327', accent: '#174a63' },
  assets: { 'asset://hero.svg': svg, 'asset://fonts/ui.woff2': 'b64:d09GMgABAAAAAA==' }, surfaces: theme.surfaces, fonts: theme.fonts, motionSpec: theme.motion, interactions: theme.interactions, colorScheme: 'light',
})
;(async () => {
  assert.equal(await runtime.apply(theme.id), true)
  assert.match(runtime.assetUrl('asset://hero.svg'), /^data:image\/svg\+xml;charset=utf-8,/)
  assert.match(styleValues.get('--hdsi-asset-hero-svg'), /^url\("data:image\/svg\+xml;charset=utf-8,/)
  assert.match(styleValues.get('--hdsi-surface-hero'), /^url\("data:image\/svg\+xml;charset=utf-8,/)
  assert.equal(styleValues.get('--hdsi-motion-preset-fade-duration'), '160ms')
  assert.equal(styleValues.get('--hdsi-motion-active-level'), 'subtle')
  assert.match(styleValues.get('--hdsi-font-ui'), /HDSI Theme ui/)
  assert.equal(headChildren.length, 1)
  assert.match(headChildren[0].textContent, /@font-face/)
  const animated = { style: { values: new Map(), setProperty(name, value) { this.values.set(name, value) } }, animate(frames, options) { this.frames = frames; this.options = options; return { finished: Promise.resolve() } } }
  assert.equal(await runtime.applyMotion(animated, 'fade'), true)
  assert.equal(await runtime.applyInteraction(animated, 'panel', 'expand'), true)
  assert.equal(animated.options.duration, 96)
  assert.equal(animated.style.values.get('opacity'), '1')
  await runtime.apply('default')
  assert.equal(headChildren.length, 0)
  assert.equal(styleValues.has('--hdsi-font-ui'), false)
  // 导出参考包：相对 $schema、随包附带 schema、不含已下线的 sandboxRuntime，
  // 且导出产物必须能重新通过自家验证器（round-trip，用带后缀的真实版本号）。
  const manager = require(path.join(themeDir, 'pack-manager.js'))
  const written = []
  globalThis.hdsiDesktop = { packs: { write: async (name, entries) => { written.push({ name, entries }); return { ok: true, path: `./${name}` } } } }
  const exported = await manager.exportTheme('hdsi-japanese-light')
  assert.equal(exported.ok, true, JSON.stringify(exported))
  const packEntries = written[0].entries
  const exportedTheme = JSON.parse(packEntries['theme.json'])
  assert.equal(exportedTheme.$schema, './theme.schema.v3.json')
  assert.equal(exportedTheme.overrides.sandboxRuntime, undefined)
  assert.ok(packEntries['theme.schema.v3.json'])
  assert.ok(JSON.parse(packEntries['theme.schema.v3.json']).definitions)
  assert.equal(Object.keys(packEntries).some(name => packEntries[name].includes('hdsi.local')), false)
  const roundTrip = validator.validateEntries(packEntries, '0.0.1-m3')
  assert.notEqual(roundTrip.verdict, 'block', JSON.stringify(roundTrip))

  // 结构化诊断（第二批导入体验批次）：diagnostics 与 errors 文本同源，带 code/path
  const diagReport = validator.validateEntries(badFont, '0.0.1')
  assert.ok(Array.isArray(diagReport.diagnostics))
  const fontDiag = diagReport.diagnostics.find(item => item.code === 'FONT_SRC')
  assert.ok(fontDiag, JSON.stringify(diagReport.diagnostics))
  assert.equal(fontDiag.level, 'error')
  assert.equal(fontDiag.path, 'theme.json#fonts.ui.src')

  // 两段式导入：pickAndValidate 只验证不落盘；installValidated 成功才登记，且不切换当前主题
  const installs = []
  globalThis.hdsiDesktop = { packs: {
    appVersion: async () => '0.0.1-m3',
    pickRead: async () => ({ path: 'fixture.hdsitheme', entries }),
    install: async (id, e) => { installs.push({ id, keys: Object.keys(e).length }); return { ok: true, id } },
    listInstalled: async () => [],
    write: async () => ({ ok: true, path: './x.hdsitheme' }),
    uninstall: async () => ({ ok: true }),
  } }
  const picked = await manager.pickAndValidate('0.0.1-m3')
  assert.equal(picked.report.verdict, 'pass', JSON.stringify(picked.report.errors))
  assert.equal(installs.length, 0, '验证阶段不得安装')
  assert.equal(runtime.current(), 'default')
  assert.equal((await manager.installValidated(picked.report, picked.entries)).ok, true)
  assert.equal(installs.length, 1)
  assert.ok(manager.list().some(pack => pack.id === theme.id))
  assert.equal(runtime.current(), 'default', '安装不得切换当前主题')

  // 页面结构非法：导入前阻断并给出 PAGE_LAYOUT 诊断（不再等到 registerPack 静默丢弃）
  globalThis.hdsiDesktop.packs.pickRead = async () => ({ path: 'broken.hdsitheme', entries: { ...entries, 'pages/connect.json': JSON.stringify({ page: { id: 'connect-main', layout: { type: 'nonsense' } } }) } })
  const brokenPick = await manager.pickAndValidate('0.0.1-m3')
  assert.equal(brokenPick.report.verdict, 'block')
  assert.ok(brokenPick.report.diagnostics.some(item => item.code === 'PAGE_LAYOUT' && item.path === 'pages/connect.json'))

  // 安装失败：不登记、不影响已登记条目
  globalThis.hdsiDesktop.packs.pickRead = async () => ({ path: 'fixture.hdsitheme', entries })
  globalThis.hdsiDesktop.packs.install = async () => ({ ok: false, error: 'disk full' })
  const failPick = await manager.pickAndValidate('0.0.1-m3')
  const failInstall = await manager.installValidated(failPick.report, failPick.entries)
  assert.equal(failInstall.ok, false)
  assert.equal(failInstall.error, '安装失败：disk full')
  assert.equal(manager.list().filter(pack => pack.id === theme.id).length, 1, '失败安装不得重复登记')

  // 恢复：损坏目录与失效包上报 failed（含诊断），有效包照常登记
  globalThis.hdsiDesktop.packs.listInstalled = async () => [
    { id: 'pack-corrupt', entries: {}, error: '主题包条目超过 2MB：big.png' },
    { id: 'pack-stale', entries: badFont },
    { id: theme.id, entries },
  ]
  const restored = await manager.loadInstalled('0.0.1-m3')
  assert.deepEqual(restored.failed.map(item => item.id), ['pack-corrupt', 'pack-stale'])
  assert.match(restored.failed[0].reason, /2MB/)
  assert.ok(restored.failed[1].diagnostics.some(item => item.code === 'FONT_SRC'))
  assert.ok(restored.ok.some(pack => pack.id === theme.id))

  // 摘要：阻断包仍给出身份（尽力解析）与诊断计数
  const summary = manager.summarize(diagReport, badFont)
  assert.equal(summary.identity.id, theme.id)
  assert.ok(summary.counts.errors >= 1)
  assert.ok(summary.diagnostics.some(item => item.code === 'FONT_SRC'))
  console.log('theme protocol tests passed')
})().catch(error => { console.error(error); process.exitCode = 1 })

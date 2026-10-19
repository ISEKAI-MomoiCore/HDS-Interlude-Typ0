const assert = require('node:assert/strict')
const path = require('node:path')

class FakeElement {
  constructor(tag) {
    this.tagName = tag.toUpperCase()
    this.children = []
    this.childNodes = this.children
    this.parentNode = null
    this.style = { values: new Map(), setProperty: (k, v) => this.style.values.set(k, String(v)) }
    this.attrs = new Map()
    this.listeners = new Map()
    this.textContent = ''
    this.className = ''
  }
  appendChild(child) { if (child) { this.children.push(child); child.parentNode = this } return child }
  append(...items) { items.forEach(item => this.appendChild(item)) }
  replaceChildren(...items) { this.children.length = 0; items.forEach(item => { if (item && typeof item === 'object') this.appendChild(item) }) }
  prepend(child) { if (child) { this.children.unshift(child); child.parentNode = this } }
  setAttribute(name, value) { this.attrs.set(name, String(value)) }
  getAttribute(name) { return this.attrs.get(name) || null }
  addEventListener(name, fn) { this.listeners.set(name, fn) }
  querySelectorAll() { return [] }
  get firstElementChild() { return this.children[0] || null }
}

globalThis.document = { createElement: tag => new FakeElement(tag), documentElement: new FakeElement('html') }
globalThis.localStorage = (() => { const data = new Map(); return { getItem: k => data.get(k) || null, setItem: (k, v) => data.set(k, String(v)), removeItem: k => data.delete(k) } })()
const calls = []
const registeredThemes = []
globalThis.HDSIThemeV3 = {
  applyMotion: async (element, preset) => { calls.push(['motion', preset, element]); return true },
  applyInteraction: async (element, kind, trigger) => { calls.push(['interaction', kind, trigger, element]); return true },
  registerTheme: theme => { registeredThemes.push(theme); return true },
}
globalThis.HDSIPackValidator = { luminance: () => 0.8 }
globalThis.HDSIViewModel = { get: () => undefined, subscribe: () => () => {} }
globalThis.HDSIActions = { dispatch: async () => ({ ok: true }) }

const dsl = require(path.join(__dirname, '..', 'src', 'renderer', 'semantics', 'layout-dsl.js'))
const runtime = require(path.join(__dirname, '..', 'src', 'renderer', 'semantics', 'page-runtime.js'))
const packManager = require(path.join(__dirname, '..', 'src', 'renderer', 'theme', 'pack-manager.js'))

const valid = { page: { id: 'custom', motion: { enter: 'fade', exit: 'fade' }, layout: { type: 'divider', motion: { expand: 'fade' } } } }
assert.equal(dsl.validatePage(valid).ok, true)
assert.equal(dsl.validatePage({ page: { id: 'bad', motion: { nope: 'fade' }, layout: { type: 'divider' } } }).ok, false)
const registered = packManager.__registerValidated({
  id: 'motion-spec-pack', name: 'Motion Spec Pack',
  tokens: { 'color.canvas': '#ffffff', 'color.text.primary': '#111111' },
  motionSpec: { level: 'subtle', presets: { fade: { from: { opacity: 0 }, to: { opacity: 1 } } } },
  interactions: { themePreview: { success: 'fade' } },
}, [], [], null, {})
assert.equal(registered.motionSpec.presets.fade.from.opacity, 0)
assert.equal(registered.interactions.themePreview.success, 'fade')
assert.equal(registeredThemes.at(-1).motionSpec.presets.fade.to.opacity, 1)
const rendered = dsl.render(valid.page.layout, { document: globalThis.document, deps: new Set(), vm: globalThis.HDSIViewModel, actions: globalThis.HDSIActions })
assert.equal(rendered.__hdsiMotion.expand, 'fade')
assert.equal(rendered.getAttribute('data-hdsi-motion-expand'), 'fade')

const official = { page: { id: 'demo', layout: { type: 'divider' } } }
const community = { page: { id: 'demo', motion: { enter: 'fade', exit: 'fade' }, layout: { type: 'divider' } } }
assert.equal(runtime.registerOfficial(official), true)
assert.equal(runtime.registerPack('pack-a', 'Pack A', [community], { motionPresets: ['fade'] }), true)
globalThis.localStorage.setItem('hdsi-page-pack', 'pack-a')
const container = new FakeElement('main')
;(async () => {
  const result = await runtime.mount('demo', container)
  assert.equal(result.ok, true)
  assert.equal(result.origin, 'pack:pack-a')
  assert.equal(calls.some(call => call[0] === 'motion' && call[1] === 'fade'), true)
  const panel = dsl.render({ type: 'divider', motion: { expand: 'fade' } }, { document: globalThis.document, deps: new Set(), vm: globalThis.HDSIViewModel, actions: globalThis.HDSIActions })
  assert.equal(await runtime.trigger(panel, 'expand'), true)
  const bad = { page: { id: 'bad-pack-page', motion: { enter: 'missing' }, layout: { type: 'divider' } } }
  assert.equal(runtime.registerPack('pack-b', 'Pack B', [bad], { motionPresets: ['fade'] }), true)
  assert.equal(runtime.listPacks().find(item => item.id === 'pack-b').pages.length, 0)
  await runtime.unmount('demo', { wait: true })
  console.log('theme interaction protocol tests passed')
})().catch(error => { console.error(error); process.exitCode = 1 })

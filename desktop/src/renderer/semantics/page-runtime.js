/**
 * V3 §34/§41：声明式页面运行时。页面解析顺序 = 社区覆盖 → 官方定义；挂载走
 * 固定生命周期，并由宿主统一协调受控页面动效。页面包只携带声明，永远不能
 * 注入事件监听器、脚本、选择器或 IPC。
 */
(function (root, factory) {
  const api = factory(root)
  if (typeof module !== 'undefined') module.exports = api
  else root.HDSIPageRuntime = api
})(typeof self !== 'undefined' ? self : globalThis, function (root) {
  'use strict'

  const DSL = root.HDSILayoutDSL || (typeof require !== 'undefined' ? require('./layout-dsl.js') : null)
  const VM = root.HDSIViewModel || (typeof require !== 'undefined' ? require('./view-model.js') : null)
  const STORAGE_PACK = 'hdsi-page-pack'
  const MOTION_TIMEOUT = 900

  const official = new Map()     // pageId → 页面定义
  const packs = new Map()        // packId → { label, pages, motionPresets }
  const active = new Map()       // pageId → { unsub, container, origin, timer, def }
  const generations = new Map()  // pageId → mount generation，防止异步过渡回写旧页面

  function registerOfficial(pageDef) {
    const report = DSL.validatePage(pageDef)
    if (!report.ok) { console.warn('[HDSIPageRuntime] 官方页定义非法:', pageDef?.page?.id, report.errors); return false }
    official.set(pageDef.page.id, pageDef)
    return true
  }

  /** 社区/主题包页面注册；motionPresets 用于二次校验页面引用。 */
  function registerPack(packId, label, pageDefs, options = {}) {
    if (!/^[\w.-]+$/.test(String(packId || '')) || !Array.isArray(pageDefs)) return false
    const pages = new Map()
    const motionPresets = new Set(Array.isArray(options.motionPresets) ? options.motionPresets : [])
    for (const def of pageDefs) {
      const report = DSL.validatePage(def)
      if (!report.ok) continue
      if (motionPresets.size && !pageMotionRefsExist(def, motionPresets)) continue
      pages.set(def.page.id, def)
    }
    packs.set(packId, { label: label || packId, pages, motionPresets })
    return true
  }

  function pageMotionRefsExist(def, presets) {
    const refs = []
    collectMotionRefs(def?.page?.motion, refs)
    walkLayout(def?.page?.layout, node => collectMotionRefs(node?.motion, refs))
    return refs.every(name => presets.has(name))
  }
  function collectMotionRefs(binding, refs) {
    if (typeof binding === 'string') refs.push(binding)
    else if (binding && typeof binding === 'object' && !Array.isArray(binding)) {
      for (const value of Object.values(binding)) if (typeof value === 'string') refs.push(value)
    }
  }
  function walkLayout(node, visitor) {
    if (!node || typeof node !== 'object') return
    visitor(node)
    if (node.type === 'scroll') walkLayout(node.child, visitor)
    else if (node.type === 'tabs') for (const item of node.items || []) walkLayout(item?.content, visitor)
    else if (node.type === 'when') { walkLayout(node.then, visitor); walkLayout(node.else, visitor) }
    else if (node.type === 'repeat') { walkLayout(node.item, visitor); walkLayout(node.empty, visitor) }
    else for (const child of node.children || []) walkLayout(child, visitor)
  }

  function activePack() {
    try { return root.localStorage?.getItem(STORAGE_PACK) || '' } catch { return '' }
  }
  function nextGeneration(pageId) {
    const next = (generations.get(pageId) || 0) + 1
    generations.set(pageId, next)
    return next
  }
  function setActivePack(packId) {
    try { packId ? root.localStorage.setItem(STORAGE_PACK, packId) : root.localStorage.removeItem(STORAGE_PACK) } catch { /* 存储不可用时仅本次会话生效 */ }
    // 切换包后立即按新解析结果重挂载。异步过渡若失败不会阻塞旧状态。
    for (const [pageId, entry] of [...active]) {
      const resolved = resolve(pageId)
      if (!resolved) continue
      void mountInto(pageId, entry.container, resolved.def, resolved.origin)
    }
  }

  function resolve(pageId) {
    const packId = activePack()
    const pack = packs.get(packId)
    if (pack?.pages.has(pageId)) return { def: pack.pages.get(pageId), origin: `pack:${packId}` }
    if (official.has(pageId)) return { def: official.get(pageId), origin: 'official' }
    return null
  }

  /** §33.4：页面声明的 requires 字段缺失时拒绝挂载社区页，回退官方页 */
  function requirementsMet(def) {
    const required = def.page.requires || []
    return required.every(path => VM?.get(path) !== undefined)
  }

  function bounded(task, timeout = MOTION_TIMEOUT) {
    return new Promise(resolve => {
      let settled = false
      let timer = null
      const clear = () => {
        if (timer === null) return
        try {
          if (typeof root.clearTimeout === 'function') root.clearTimeout(timer)
          else if (typeof clearTimeout === 'function') clearTimeout(timer)
        } catch { /* 测试环境或受限宿主没有 clearTimeout */ }
        timer = null
      }
      const finish = value => {
        if (settled) return
        settled = true
        clear()
        resolve(value)
      }
      try {
        if (typeof root.setTimeout === 'function') timer = root.setTimeout(() => finish(false), timeout)
        else if (typeof setTimeout === 'function') timer = setTimeout(() => finish(false), timeout)
        else { finish(false); return }
      } catch { finish(false); return }
      try { Promise.resolve(task).then(finish, () => finish(false)) } catch { finish(false) }
    })
  }


  function runMotion(element, binding, trigger, kind = 'page') {
    const explicit = typeof binding === 'string' ? (trigger === 'enter' ? binding : null) : binding?.[trigger]
    try {
      const theme = root.HDSIThemeV3
      if (explicit && typeof theme?.applyMotion === 'function') return bounded(theme.applyMotion(element, explicit))
      if (typeof theme?.applyInteraction === 'function') return bounded(theme.applyInteraction(element, kind, trigger))
    } catch { /* 动效属于视觉层，失败时继续页面生命周期 */ }
    return Promise.resolve(false)
  }

  function trigger(element, triggerName, kind = 'panel', presetName) {
    if (!element || typeof triggerName !== 'string') return Promise.resolve(false)
    const binding = presetName || element.__hdsiMotion
    return runMotion(element, binding, triggerName, kind)
  }

  function unmount(pageId, options = {}) {
    if (options.invalidate !== false) nextGeneration(pageId)
    const entry = active.get(pageId)
    if (!entry) return Promise.resolve(false)
    try { entry.unsub?.() } catch { /* 忽略 */ }
    if (entry.timer) root.clearTimeout?.(entry.timer)
    active.delete(pageId)
    if (options.animate === false) return Promise.resolve(true)
    const target = entry.container?.firstElementChild || entry.container
    const task = runMotion(target, entry.def?.page?.motion, 'exit', 'page')
    return options.wait ? bounded(task) : task.catch?.(() => false) || Promise.resolve(false)
  }

  async function mountInto(pageId, container, def, origin) {
    const generation = nextGeneration(pageId)
    await unmount(pageId, { wait: true, invalidate: false })
    if (generations.get(pageId) !== generation) return false
    const deps = new Set()
    const fragment = DSL.render(def.page.layout, {
      vm: VM, deps, actions: root.HDSIActions,
      document: root.document,
    })
    container.replaceChildren(fragment)
    const unsub = deps.size && VM
      ? [...deps].map(ns => VM.subscribe(`${ns}.*`, scheduleRerender))
      : []
    const entry = { container, origin, unsub: () => unsub.forEach(off => off()), timer: null, def, pageId }
    function scheduleRerender() {
      if (entry.timer || !active.has(pageId) || active.get(pageId) !== entry) return
      entry.timer = root.setTimeout?.(() => {
        entry.timer = null
        if (active.get(pageId) === entry) void mountInto(pageId, container, def, origin)
      }, 120) ?? null
    }
    active.set(pageId, entry)
    // 页面根动效由宿主统一触发；页面节点的声明保留给宿主动作 trigger() 使用。
    void runMotion(container, def.page.motion, 'enter', 'page')
    return origin
  }

  async function mount(pageId, container) {
    if (!container) return { ok: false, error: 'no-container' }
    const resolved = resolve(pageId)
    if (!resolved) return { ok: false, error: 'unknown-page' }
    // 社区覆盖页：要求满足 + 校验通过，否则回退官方页（§33.4/§34）
    if (resolved.origin !== 'official') {
      const report = DSL.validatePage(resolved.def)
      const packFailure = !report.ok || !requirementsMet(resolved.def)
        ? `pack(${resolved.origin.split(':')[1]}) 的 ${pageId} 页${!report.ok ? '校验失败' : '缺少所需数据'}，已回退官方页`
        : ''
      if (packFailure) {
        const fallbackDef = official.get(pageId)
        if (fallbackDef) {
          await mountInto(pageId, container, fallbackDef, 'official')
          const note = root.document?.createElement('div')
          if (note) { note.className = 'dsl-error'; note.textContent = packFailure; container.prepend(note) }
          return { ok: true, origin: 'official', fallbackReason: packFailure }
        }
      }
    }
    try {
      await mountInto(pageId, container, resolved.def, resolved.origin)
      return { ok: true, origin: resolved.origin }
    } catch (error) {
      // 官方页渲染失败：显式错误占位，不留空白
      container.replaceChildren(root.document?.createElement('div') || '')
      const note = container.firstChild
      if (note) { note.className = 'dsl-error'; note.textContent = `页面渲染失败：${pageId} — ${error}` }
      return { ok: false, error: String(error) }
    }
  }

  return {
    registerOfficial, registerPack, resolve, mount, unmount, trigger, runMotion,
    setActivePack, activePack,
    listPacks: () => [...packs.entries()].map(([id, pack]) => ({ id, label: pack.label, pages: [...pack.pages.keys()] })),
    listOfficial: () => [...official.keys()],
  }
})

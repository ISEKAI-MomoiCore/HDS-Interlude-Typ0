/**
 * V3 §3/§13：主题运行时。负责五层合成（defaults → theme → user →
 * accessibility → runtime 状态）、CSS 变量写入、密度/动效档位、回退链与
 * 持久化。app.js 只通过本模块的 API 操作外观，不直接拼变量。
 *
 * 回退链（§27.3）：当前主题 → 上一次可用主题 → hdsi-sumi → 清澄默认样式。
 * 任何一步失败都不改动正在使用的变量集之外的状态（不触碰 Worker/故事）。
 */
(function (root, factory) {
  const api = factory(root)
  if (typeof module !== 'undefined') module.exports = api
  else root.HDSIThemeV3 = api
})(typeof self !== 'undefined' ? self : globalThis, function (root) {
  'use strict'

  const TOKENS = root.HDSITokens || (typeof require !== 'undefined' ? require('./tokens.js') : null)
  const BUILTIN = root.HDSIBuiltinThemes || (typeof require !== 'undefined' ? require('./themes-builtin.js') : null)
  const COMPAT = root.HDSIThemeCompat || (typeof require !== 'undefined' ? require('./compat.js') : null)

  const STORAGE_THEME = 'hdsi-theme-current'
  const STORAGE_USER = 'hdsi-theme-user'
  const SAFE_THEME = 'hdsi-sumi'

  // The default is an internal V3 preset rather than the legacy dark core.
  // Keeping it outside the official five-theme list preserves their stable
  // IDs while making reset/first launch match the 清澄 reference interface.
  const DEFAULT_THEME = {
    id: 'default', name: '清澄', displayName: '清澄 · Kiyosumi', official: true,
    description: '和纸暖白、墨色文字、靛蓝与朱砂语义色的高密度故事工作台。',
    colorScheme: 'light', defaultDensity: 'workbench', motion: 'subtle', colors: {},
  }

  const state = {
    currentId: '', lastGoodId: '', appliedVars: null,
    community: new Map(),
    user: { density: '', motion: '' },
    compatIndex: [], compatCache: new Map(),
    status: 'idle', fallbackReason: '',
    appliedResourceVars: [],
    appliedFontVars: [],
    fontStyleNode: null,
    motionSessions: new WeakMap(),
  }

  // ── 合成 ───────────────────────────────────────────────
  function composeTheme(theme) {
    const palette = theme && theme.colors ? theme.colors : {}
    return TOKENS.completePalette(palette)
  }

  function densityOf(theme, user) {
    const requested = user.density || (theme && theme.defaultDensity) || ''
    return TOKENS.DENSITY_TIERS[requested] ? requested : TOKENS.DEFAULT_DENSITY
  }

  function motionOf(theme, user, forced) {
    if (forced) return 'off'
    const declared = theme && (theme.motionSpec || theme.motion)
    const declaredLevel = declared && typeof declared === 'object' ? (declared.level || declared.defaultLevel) : declared
    const requested = user.motion || declaredLevel || ''
    const normalized = requested === 'expressive' ? 'standard' : requested
    return TOKENS.MOTION_LEVELS[normalized] ? normalized : TOKENS.DEFAULT_MOTION
  }

  function buildCssVars(theme, user, forced) {
    const tokens = composeTheme(theme)
    const vars = {}
    for (const [key, value] of Object.entries(tokens)) vars[TOKENS.varName(key)] = value

    const density = TOKENS.DENSITY_TIERS[densityOf(theme, user)]
    vars['--hdsi-size-body'] = density.sizeBody + 'px'
    vars['--hdsi-size-small'] = density.sizeSmall + 'px'
    vars['--hdsi-size-label'] = density.sizeLabel + 'px'
    vars['--hdsi-control-height'] = density.controlHeight + 'px'
    vars['--hdsi-row-height'] = density.rowHeight + 'px'
    vars['--hdsi-space-1'] = density.space1 + 'px'
    vars['--hdsi-space-2'] = density.space2 + 'px'
    vars['--hdsi-space-3'] = density.space3 + 'px'
    vars['--hdsi-space-4'] = density.space4 + 'px'
    vars['--hdsi-radius-sm'] = '2px'
    vars['--hdsi-radius-md'] = '4px'

    const level = TOKENS.MOTION_LEVELS[motionOf(theme, user, forced)]
    for (const [name, base] of Object.entries(TOKENS.MOTION_BASE)) {
      vars[`--hdsi-motion-${name}`] = Math.round(base * level.factor) + 'ms'
    }
    return { vars, density: densityOf(theme, user), motion: motionOf(theme, user, forced) }
  }

  function writeVars(theme, composed) {
    const doc = root.document
    if (!doc || !doc.documentElement) return
    const el = doc.documentElement
    const previous = el.getAttribute('style') || ''
    try {
      for (const [name, value] of Object.entries(composed.vars)) el.style.setProperty(name, value)
    } catch (error) {
      el.setAttribute('style', previous)
      throw error
    }
    el.setAttribute('data-hdsi-theme', state.currentId || 'core-defaults')
    el.setAttribute('data-hdsi-density', composed.density)
    el.setAttribute('data-hdsi-motion', composed.motion)
    el.style.colorScheme = theme && theme.colorScheme === 'light' ? 'light' : 'dark'
    applyResourceVars(theme, composed.motion)
  }

  // 资源只来自已验证的主题包，运行时仍不允许网络 URL 或任意 CSS 注入。
  // `asset://foo.png` 会被转换成 data URL，并通过 CSS 变量交给主题样式消费。
  const MIME_TYPES = {
    avif: 'image/avif', gif: 'image/gif', jpeg: 'image/jpeg', jpg: 'image/jpeg',
    png: 'image/png', svg: 'image/svg+xml', webp: 'image/webp',
    ico: 'image/x-icon', woff: 'font/woff', woff2: 'font/woff2',
    css: 'text/css', txt: 'text/plain', json: 'application/json',
  }

  function assetKey(ref) {
    return String(ref || '').replace(/^asset:\/\//, '').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase()
  }

  function mimeFor(ref) {
    const ext = String(ref || '').split('?')[0].split('.').pop().toLowerCase()
    return MIME_TYPES[ext] || 'application/octet-stream'
  }

  function assetDataUrl(value, ref) {
    if (typeof value !== 'string') return null
    const mime = mimeFor(ref)
    if (value.startsWith('b64:')) return `data:${mime};base64,${value.slice(4)}`
    return `data:${mime};charset=utf-8,${encodeURIComponent(value)}`
  }

  function resolveAsset(ref, theme = resolveTheme(state.currentId)) {
    if (typeof ref !== 'string' || !ref.startsWith('asset://')) return null
    const value = theme?.assets?.[ref]
    return assetDataUrl(value, ref)
  }

  function cssUrl(url) {
    return url ? `url("${String(url).replace(/"/g, '%22')}")` : ''
  }

  const MOTION_PROPERTIES = new Set(['opacity', 'transform', 'clip-path', 'filter', 'background-color', 'color', 'border-color', 'box-shadow'])

  function applyResourceVars(theme, motionLevel) {
    const doc = root.document
    if (!doc?.documentElement) return
    const el = doc.documentElement
    for (const name of state.appliedResourceVars) el.style.removeProperty(name)
    for (const name of state.appliedFontVars) el.style.removeProperty(name)
    state.appliedResourceVars = []
    state.appliedFontVars = []
    if (state.fontStyleNode) {
      try { state.fontStyleNode.remove?.() || state.fontStyleNode.parentNode?.removeChild(state.fontStyleNode) } catch { /* DOM 已被销毁 */ }
      state.fontStyleNode = null
    }
    const set = (name, value, bucket = state.appliedResourceVars) => {
      if (value === undefined || value === null || value === '') return
      el.style.setProperty(name, String(value))
      bucket.push(name)
    }
    for (const [ref, value] of Object.entries(theme?.assets || {})) {
      const url = assetDataUrl(value, ref)
      const key = assetKey(ref)
      if (url && key) set(`--hdsi-asset-${key}`, cssUrl(url))
    }
    const visit = (value, path) => {
      if (typeof value === 'string' && value.startsWith('asset://')) {
        const url = resolveAsset(value, theme)
        const key = path.map(assetKey).filter(Boolean).join('-')
        if (url && key) set(`--hdsi-surface-${key}`, cssUrl(url))
        return
      }
      if (Array.isArray(value)) value.forEach((item, index) => visit(item, [...path, String(index)]))
      else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) visit(item, [...path, key])
    }
    visit(theme?.surfaces || {}, [])
    applyFonts(theme, set)
    const spec = theme?.motionSpec || theme?.motion
    for (const [name, preset] of Object.entries(spec?.presets || {})) {
      const key = assetKey(name)
      if (!key || !preset || typeof preset !== 'object') continue
      if (preset.duration !== undefined) set(`--hdsi-motion-preset-${key}-duration`, `${preset.duration}ms`)
      if (preset.easing) set(`--hdsi-motion-preset-${key}-easing`, preset.easing)
      if (preset.delay !== undefined) set(`--hdsi-motion-preset-${key}-delay`, `${preset.delay}ms`)
    }
    set('--hdsi-motion-active-level', motionLevel)
  }

  function applyFonts(theme, set) {
    const fonts = theme?.fonts
    if (!fonts || typeof fonts !== 'object') return
    const faces = []
    for (const [name, spec] of Object.entries(fonts)) {
      if (!spec || typeof spec !== 'object' || typeof spec.src !== 'string') continue
      const ref = spec.src
      const url = resolveAsset(ref, theme)
      if (!url || !/^asset:\/\/.+\.woff2?$/i.test(ref)) continue
      const key = assetKey(name)
      if (!key) continue
      const family = `HDSI Theme ${key}`
      const ext = /\.woff2$/i.test(ref) ? 'woff2' : 'woff'
      const weight = (typeof spec.weight === 'number' || typeof spec.weight === 'string') ? spec.weight : '400'
      const style = ['normal', 'italic', 'oblique'].includes(spec.style) ? spec.style : 'normal'
      const display = ['auto', 'block', 'swap', 'fallback', 'optional'].includes(spec.display) ? spec.display : 'swap'
      faces.push(`@font-face{font-family:"${family}";src:url("${url.replace(/"/g, '%22')}") format("${ext}");font-style:${style};font-weight:${weight};font-display:${display};}`)
      const fallback = name === 'mono' ? 'monospace' : 'system-ui, sans-serif'
      set(`--hdsi-font-${key}`, `"${family}", ${fallback}`, state.appliedFontVars)
      if (name === 'ui' || name === 'mono') set(`--hdsi-font-${name}`, `"${family}", ${fallback}`, state.appliedFontVars)
    }
    if (!faces.length || !root.document?.createElement) return
    const styleNode = root.document.createElement('style')
    styleNode.setAttribute('data-hdsi-theme-fonts', 'true')
    styleNode.textContent = faces.join('')
    ;(root.document.head || root.document.documentElement)?.appendChild?.(styleNode)
    state.fontStyleNode = styleNode
  }

  function sanitizeMotionFrame(frame) {
    const result = {}
    if (!frame || typeof frame !== 'object') return result
    for (const [prop, value] of Object.entries(frame)) {
      if (!MOTION_PROPERTIES.has(prop)) continue
      if ((typeof value !== 'string' && typeof value !== 'number') || (typeof value === 'string' && /[;{}]|url\s*\(|javascript:|expression\s*\(/i.test(value))) continue
      if (prop === 'opacity' && (typeof value !== 'number' || value < 0 || value > 1)) continue
      result[prop] = value
    }
    return result
  }

  function cancelMotion(element) {
    const session = state.motionSessions.get(element)
    if (!session) return false
    session.cancelled = true
    try { session.animation?.cancel?.() } catch { /* 某些 WebView 的 cancel 可能抛错 */ }
    state.motionSessions.delete(element)
    return true
  }

  function applyMotion(element, presetName) {
    if (!element || typeof element !== 'object') return Promise.resolve(false)
    const spec = motion(state.currentId)
    const preset = spec?.presets?.[presetName]
    if (!preset || typeof preset !== 'object') return Promise.resolve(false)
    cancelMotion(element)
    const from = sanitizeMotionFrame(preset.from)
    const to = sanitizeMotionFrame(preset.to)
    if (!Object.keys(from).length && !Object.keys(to).length) return Promise.resolve(false)
    const currentLevel = state.status === 'ok' ? (root.document?.documentElement?.getAttribute?.('data-hdsi-motion') || TOKENS.DEFAULT_MOTION) : TOKENS.DEFAULT_MOTION
    const factor = TOKENS.MOTION_LEVELS[currentLevel]?.factor ?? 1
    const session = { animation: null, cancelled: false }
    state.motionSessions.set(element, session)
    const finish = () => {
      if (state.motionSessions.get(element) !== session || session.cancelled) return false
      const style = element.style
      if (style?.setProperty) {
        for (const [property, value] of Object.entries(to)) style.setProperty(property, String(value))
      } else if (style) Object.assign(style, to)
      state.motionSessions.delete(element)
      return true
    }
    if (factor <= 0 || reducedMotionForced() || typeof element.animate !== 'function') return Promise.resolve(finish())
    const allowed = preset.properties && Array.isArray(preset.properties) ? new Set(preset.properties) : null
    const filter = frame => allowed ? Object.fromEntries(Object.entries(frame).filter(([key]) => allowed.has(key))) : frame
    const keyframes = [filter(from), filter(to)]
    const duration = Math.max(0, Math.round((Number(preset.duration) || 0) * factor))
    if (!duration) return Promise.resolve(finish())
    let animation
    try {
      animation = element.animate(keyframes, {
        duration, delay: Math.max(0, Number(preset.delay) || 0),
        easing: typeof preset.easing === 'string' ? preset.easing : 'ease-out',
        iterations: preset.iterationCount === 'infinite' ? Infinity : Math.max(1, Number(preset.iterationCount) || 1),
        fill: 'both', direction: preset.direction === 'reverse' ? 'reverse' : 'normal',
      })
      session.animation = animation
    } catch { return Promise.resolve(finish()) }
    return Promise.resolve(animation.finished).then(finish, finish)
  }

  function applyInteraction(element, kind, trigger = 'enter') {
    const theme = resolveTheme(state.currentId)
    const mapping = theme?.interactions?.[kind]
    const presetName = typeof mapping === 'object' ? mapping?.[trigger] : undefined
    if (typeof presetName !== 'string') return Promise.resolve(false)
    return applyMotion(element, presetName)
  }

  // ── 主题解析 ───────────────────────────────────────────
  function resolveTheme(id) {
    if (!id || id === 'default') return DEFAULT_THEME
    if (state.community.has(id)) return state.community.get(id)
    const official = BUILTIN.byId(id)
    if (official) return official
    if (COMPAT && state.compatCache.has(id)) return state.compatCache.get(id)
    return null
  }

  async function loadCompatTheme(id) {
    if (state.compatCache.has(id)) return state.compatCache.get(id)
    const entry = state.compatIndex.find(item => item.id === id)
    if (!entry || !COMPAT) return null
    const response = await fetch('./themes/builtin/' + entry.file)
    if (!response.ok) return null
    const data = await response.json()
    const theme = COMPAT.convert(entry, data)
    state.compatCache.set(id, theme)
    return theme
  }

  // ── 应用与回退 ─────────────────────────────────────────
  function reducedMotionForced() {
    if (root.matchMedia) return root.matchMedia('(prefers-reduced-motion: reduce)').matches
    return false
  }

  function applyResolved(theme) {
    const composed = buildCssVars(theme, state.user, reducedMotionForced())
    // 先更新状态再写 DOM：data-hdsi-theme 必须与本次应用同步，
    // 否则调试工具/主题选择器 CSS 会看到滞后一套的旧主题 ID（审计 P2）。
    state.currentId = theme.id
    state.lastGoodId = theme.id
    writeVars(theme, composed)
    state.appliedVars = composed.vars
    state.status = 'ok'
    state.fallbackReason = ''
  }

  async function apply(id) {
    try {
      let theme = resolveTheme(id)
      if (!theme) theme = await loadCompatTheme(id)
      if (!theme) throw new Error('theme not found: ' + id)
      applyResolved(theme)
      persist()
      return true
    } catch (error) {
      return fallback(String(error))
    }
  }

  function fallback(reason) {
    try {
      const safe = BUILTIN.byId(SAFE_THEME)
      if (safe && state.currentId !== SAFE_THEME) {
        applyResolved(safe)
        state.status = 'fallback'
        // applyResolved 会清空原因——安全主题生效后补写，供选择器显示回退详情
        state.fallbackReason = reason
        persist()
        return false
      }
    } catch { /* 安全主题也失败 → 清空全部变量，回落 CSS 核心默认值 */ }
    try {
      const doc = root.document
      if (doc && doc.documentElement) {
        doc.documentElement.removeAttribute('style')
        doc.documentElement.setAttribute('data-hdsi-theme', 'core-defaults')
      }
    } catch { /* 无 DOM（测试环境） */ }
    state.currentId = 'default'
    state.status = 'safe-defaults'
    persist()
    return false
  }

  function persist() {
    try {
      root.localStorage.setItem(STORAGE_THEME, state.currentId)
      root.localStorage.setItem(STORAGE_USER, JSON.stringify(state.user))
    } catch { /* 隐私模式等存储不可用：本次会话内仍可切换 */ }
  }

  async function restore() {
    readUserPrefs()
    let saved = ''
    try { saved = root.localStorage.getItem(STORAGE_THEME) || '' } catch { /* ignore */ }
    const ok = saved ? await apply(saved) : await apply('default')
    if (saved && !ok && state.status === 'fallback') {
      // V2 主题 ID 在兼容索引加载前恢复失败：等索引就绪后再试一次
      await loadCompatIndex()
      if (state.compatIndex.some(item => item.id === saved)) await apply(saved)
    }
    watchReducedMotion()
    return ok
  }

  function readUserPrefs() {
    try {
      const raw = root.localStorage.getItem(STORAGE_USER)
      if (raw) {
        const parsed = JSON.parse(raw)
        if (parsed && typeof parsed === 'object') {
          state.user.density = TOKENS.DENSITY_TIERS[parsed.density] ? parsed.density : ''
          const motion = parsed.motion === 'expressive' ? 'standard' : parsed.motion
          state.user.motion = TOKENS.MOTION_LEVELS[motion] ? motion : ''
        }
      }
    } catch { /* 忽略损坏的用户偏好 */ }
  }

  async function loadCompatIndex() {
    try {
      const response = await fetch('./themes/builtin/index.json')
      if (!response.ok) return []
      const index = await response.json()
      state.compatIndex = Array.isArray(index.themes) ? index.themes : []
    } catch { state.compatIndex = [] }
    return state.compatIndex
  }

  /** 用户层覆盖（§3.1 第 4 层）：密度与动效即时生效并持久化 */
  /** 用户层覆盖（§3.1 第 4 层）：密度与动效即时生效并持久化；非法档位保持原值 */
  function setUser(prefs) {
    if (prefs.density !== undefined && TOKENS.DENSITY_TIERS[prefs.density]) state.user.density = prefs.density
    if (prefs.motion !== undefined) {
      const motion = prefs.motion === 'expressive' ? 'standard' : prefs.motion
      if (TOKENS.MOTION_LEVELS[motion]) state.user.motion = motion
    }
    const theme = resolveTheme(state.currentId) || { id: state.currentId, colors: {}, colorScheme: 'dark' }
    try {
      const composed = buildCssVars(theme, state.user, reducedMotionForced())
      writeVars(theme, composed)
      state.appliedVars = composed.vars
      persist()
      return true
    } catch { return false }
  }

  function reset() {
    state.user = { density: '', motion: '' }
    return apply('default')
  }

  function watchReducedMotion() {
    if (!root.matchMedia) return
    const query = root.matchMedia('(prefers-reduced-motion: reduce)')
    const onChange = () => { if (state.currentId) apply(state.currentId) }
    if (query.addEventListener) query.addEventListener('change', onChange)
    else if (query.addListener) query.addListener(onChange)
  }

  function list() {
    return {
      official: BUILTIN.list(),
      compat: state.compatIndex,
    }
  }

  function meta(id) { return resolveTheme(id) }

  /** 取主题完整定义但不应用（主题卡片的色板预览用；兼容主题按需拉取并缓存） */
  async function preview(id) {
    let theme = resolveTheme(id)
    if (!theme) theme = await loadCompatTheme(id)
    return theme
  }

  /** 社区主题包登记（导入验证通过后调用；同 ID 新版本直接替换，§4.3） */
  function registerTheme(themeDef) {
    if (!themeDef || !themeDef.id || !themeDef.colors) return false
    state.community.set(themeDef.id, { ...themeDef, official: false, community: true })
    return true
  }

  function unregisterTheme(id) { return state.community.delete(id) }

  function assets(id = state.currentId) {
    const theme = resolveTheme(id)
    return theme?.assets ? { ...theme.assets } : {}
  }

  function motion(id = state.currentId) {
    const theme = resolveTheme(id)
    return theme?.motionSpec || theme?.motion || { level: 'subtle', presets: {} }
  }

  return {
    registerTheme, unregisterTheme, communityThemes: () => [...state.community.values()],
    assetUrl: resolveAsset, assets, motion, applyMotion, cancelMotion, applyInteraction,
    apply, restore, reset, setUser, loadCompatIndex, list, meta, preview,
    current: () => state.currentId,
    status: () => ({ status: state.status, reason: state.fallbackReason, user: { ...state.user } }),
    tokens: () => state.appliedVars,
    __state: state, __buildCssVars: buildCssVars, __composeTheme: composeTheme,
  }
})


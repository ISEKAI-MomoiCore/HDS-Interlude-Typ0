/**
 * V3 §8/§36：社区主题包管理。导入 = 选文件 → 解包（主进程）→ 验证器 →
 * 安装到 userData/theme-packs/<id>/ → 登记（主题运行时 + 页面运行时）；
 * 导出 = 官方主题 → theme.json(§4.2/§33.2 点名格式) + 自动预览 SVG + 官方
 * 页面定义 → .hdsitheme。验证不过不安装、不影响当前主题（§15.3）。
 */
(function (root, factory) {
  const api = factory(root)
  if (typeof module !== 'undefined') module.exports = api
  else root.HDSIPackManager = api
})(typeof self !== 'undefined' ? self : globalThis, function (root) {
  'use strict'

  const SCHEMA = root.HDSIThemeSchemaV3 || (typeof require !== 'undefined' ? require('./schema.js') : null)
  const DSL = root.HDSILayoutDSL || (typeof require !== 'undefined' ? require('../semantics/layout-dsl.js') : null)
  // UMD 在 Node 下只走 module.exports、不挂 root.*——同目录 require 回退供测试环境使用。
  const VALIDATOR = root.HDSIPackValidator || (typeof require !== 'undefined' ? require('./pack-validator.js') : null)
  const installed = new Map()   // id → { theme, pages, warnings }

  /** "color.track.script.bright" → trackScriptBright（限核心 token 名单内） */
  function dottedToCamel(key) {
    const segments = String(key).split('.')
    if (segments[0] !== 'color' || segments.length < 2) return null
    const family = segments[1]
    const rest = segments.slice(2)
    const camel = parts => parts.map((s, i) => i === 0 ? s : s[0].toUpperCase() + s.slice(1)).join('')
    if (family === 'state') return camel(rest)                 // color.state.success.bg → successBg
    if (family === 'track') return camel([family, ...rest])     // color.track.script → trackScript
    if (family === 'text') return camel([family, ...rest])      // color.text.primary → textPrimary
    return camel(segments.slice(1))                             // color.surface.raised → surfaceRaised
  }
  function camelToDotted(key) {
    const words = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(' ')
    const head = words[0]
    if (['success', 'warning', 'danger', 'info'].includes(head) && words.length > 1) return `color.state.${words.join('.')}`
    if (head === 'track' && words.length > 1) return `color.track.${words.slice(1).join('.')}`
    if (head === 'text' && words.length > 1) return `color.text.${words.slice(1).join('.')}`
    return `color.${words.join('.')}`
  }

  function themeColorsFromTokens(tokens) {
    const colors = {}
    for (const [key, spec] of Object.entries(tokens || {})) {
      const camel = dottedToCamel(key)
      const value = spec && typeof spec === 'object' ? spec.value : spec
      if (camel && value !== undefined) colors[camel] = value
    }
    return colors
  }
  function tokensFromColors(colors, id) {
    const tokens = {}
    for (const [key, value] of Object.entries(colors)) {
      if (key === 'fontUi' || key === 'fontMono') tokens[key === 'fontUi' ? 'font.ui' : 'font.mono'] = { value, type: 'font-family' }
      else if (key.startsWith('shadow')) continue
      else tokens[camelToDotted(key)] = { value, type: /^(#|rgb)/.test(String(value)) ? 'color' : 'string' }
    }
    return { $schema: './theme.schema.v3.json', schemaVersion: 3, ...metaFromId(id), tokens }
  }
  function metaFromId(id) {
    return { id: `community-${id}`, name: id, displayName: id, version: '1.0.0', author: { name: 'HDSI Community' }, license: 'CC-BY-4.0', description: '导出的参考主题包。', tags: ['community', 'exported'], base: 'hdsi-japanese-light', compatibility: { minAppVersion: '0.0.1', maxAppVersion: '*' }, preview: './preview.svg' }
  }

  function previewSvg(colors) {
    const keys = ['canvas', 'surface', 'surfaceRaised', 'accent', 'success', 'warning', 'danger', 'trackScript', 'trackReceive', 'trackSend']
    const swatches = keys.map((key, i) => `<rect x="${i * 36}" y="8" width="34" height="34" fill="${colors?.[key] || '#888'}"/>`).join('')
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${keys.length * 36 + 8}" height="50"><rect width="100%" height="50" fill="${colors?.canvas || '#fff'}"/>${swatches}</svg>`
  }

  /** 页面结构验证（layout-dsl.validatePage）：结构非法的页面在导入/恢复前阻断，
   *  不再等到 registerPack 被静默丢弃（审计 §3.3"安装成功但页面没有生效"）。 */
  function validatePageStructure(entries, report) {
    if (report.verdict === 'block' || !report.pack || !DSL?.validatePage) return report
    const diagnostics = report.diagnostics || (report.diagnostics = [])
    for (const name of Object.keys(entries)) {
      if (!/^pages\/[\w-]+\.json$/.test(name)) continue
      let page
      try { page = JSON.parse(entries[name]) } catch { continue } // JSON 语法错误已由 pack-validator 报告
      const structure = DSL.validatePage(page)
      if (structure && !structure.ok) {
        for (const message of structure.errors) {
          const detail = `${name}：${message}`
          report.errors.push(detail)
          diagnostics.push({ level: 'error', code: 'PAGE_LAYOUT', path: name, message: detail })
        }
      }
    }
    if (report.errors.length) { report.verdict = 'block'; report.pack = null }
    return report
  }

  /** 导入第一段：选文件 + 全量静态验证（不安装）。返回 { cancelled } 或 { report, entries }。 */
  async function pickAndValidate(appVersion) {
    const packs = root.hdsiDesktop?.packs
    const validator = VALIDATOR
    if (!packs || typeof packs.pickRead !== 'function' || !validator) {
      return { report: { verdict: 'block', errors: ['主进程包接口不可用'], warnings: [], diagnostics: [{ level: 'error', code: 'IPC_UNAVAILABLE', path: 'packs', message: '主进程包接口不可用' }], pack: null }, entries: {} }
    }
    const picked = await packs.pickRead()
    if (!picked) return { cancelled: true }
    const report = validatePageStructure(picked.entries, validator.validateEntries(picked.entries, appVersion))
    return { report, entries: picked.entries }
  }

  /** 导入第二段：安装 + 登记（仅在预览确认后调用）。 */
  async function installValidated(report, entries) {
    if (!report?.pack) return { ok: false, error: '包未通过验证' }
    const packs = root.hdsiDesktop?.packs
    const { theme, pages } = report.pack
    const install = await packs.install(theme.id, entries)
    if (!install?.ok) return { ok: false, error: `安装失败：${install?.error ?? '未知'}` }
    registerValidated(theme, pages, report.warnings, report.pack.manifest, entries)
    return { ok: true }
  }

  /** 预览摘要：身份、色板、页面清单、预览图（仅通过验证的包才携带 SVG，渲染侧只做内联注入）。 */
  function summarize(report, entries) {
    // 阻断包没有 report.pack：尽力从 theme.json 原文读身份，让预览仍能告诉作者"是谁没过"。
    let theme = report.pack?.theme
    if (!theme) { try { theme = JSON.parse(entries['theme.json']) || {} } catch { theme = {} } }
    const manifest = report.pack?.manifest || {}
    const colors = themeColorsFromTokens(theme.tokens || {})
    const pages = []
    for (const name of Object.keys(entries || {})) {
      if (!/^pages\/[\w-]+\.json$/.test(name)) continue
      try {
        const inner = JSON.parse(entries[name])?.page || {}
        pages.push({ file: name, id: inner.id || '', title: inner.title?.fallback || inner.title || '' })
      } catch { /* JSON 语法错误已在验证阶段报告 */ }
    }
    const previewName = String(theme.preview || 'preview.svg').replace(/^\.\//, '')
    const previewSvg = report.pack && typeof entries[previewName] === 'string' && /<svg[\s>]/i.test(entries[previewName]) ? entries[previewName] : ''
    return {
      identity: {
        id: theme.id || '',
        name: manifest.displayName || theme.displayName || theme.name || theme.id || '',
        version: theme.version || '',
        author: manifest.author?.name || theme.author?.name || '',
        license: manifest.license || theme.license || '',
        description: theme.description || manifest.description || '',
      },
      swatches: ['canvas', 'surface', 'surfaceRaised', 'accent', 'success', 'warning', 'danger', 'trackScript', 'trackReceive', 'trackSend'].map(key => colors[key] || ''),
      pages, previewSvg,
      diagnostics: report.diagnostics || [],
      counts: { errors: (report.errors || []).length, warnings: (report.warnings || []).length },
    }
  }

  /** 导入：验证 → 安装 → 登记。返回验证结果（verdict/错误/警告）；预览流程用
   *  pickAndValidate + installValidated 两段式（UI 在两段之间展示预览与诊断）。 */
  async function importFromDisk(appVersion) {
    const { cancelled, report, entries } = await pickAndValidate(appVersion)
    if (cancelled) return { cancelled: true }
    if (report.verdict === 'block') return report
    const install = await installValidated(report, entries)
    if (!install.ok) return { verdict: 'block', errors: [install.error], warnings: report.warnings, diagnostics: report.diagnostics, pack: null }
    return report
  }

  function registerValidated(theme, pages, warnings, manifest = null, entries = {}) {
    const colors = themeColorsFromTokens(theme.tokens)
    const assets = {}
    for (const [name, value] of Object.entries(entries || {})) {
      if (name.startsWith('assets/')) assets[`asset://${name.slice('assets/'.length)}`] = value
    }
    const declaredMotion = theme.motionSpec || theme.motion
    const motion = declaredMotion && typeof declaredMotion === 'object'
      ? declaredMotion
      : { level: declaredMotion || 'subtle' }
    const def = {
      id: theme.id, name: theme.displayName || theme.name, description: theme.description || '',
      tags: theme.tags || ['community'], official: false, community: true,
      kind: luminanceIsDark(colors.canvas) ? 'dark' : 'light',
      colorScheme: luminanceIsDark(colors.canvas) ? 'dark' : 'light',
      defaultDensity: theme.density || 'workbench', motion: motion.level || 'subtle', motionSpec: motion,
      surfaces: theme.surfaces || {}, fonts: theme.fonts || {}, interactions: theme.interactions || {}, assets, manifest, colors, pages: pages || [],
    }
    root.HDSIThemeV3?.registerTheme(def)
    if (pages?.length && root.HDSIPageRuntime) {
      root.HDSIPageRuntime.registerPack(theme.id, theme.displayName || theme.name, pages, {
        motionPresets: Object.keys(motion.presets || {}),
      })
    }
    installed.set(theme.id, { theme: def, pages: pages || [], warnings: warnings || [] })
    return def
  }
  function luminanceIsDark(hex) {
    const v = root.HDSIPackValidator?.luminance(hex)
    return v === null || v === undefined ? true : v < 0.35
  }

  /** 启动时从安装目录恢复（再次验证，损坏即跳过并上报给外观页展示）；返回 { ok, failed }。 */
  async function loadInstalled(appVersion) {
    const packs = root.hdsiDesktop?.packs
    const failed = []
    if (!packs || typeof packs.listInstalled !== 'function') return { ok: [], failed }
    for (const record of await packs.listInstalled()) {
      if (record?.error) {
        console.warn('[HDSIPack] 已安装包读取失败，跳过：', record.id, record.error)
        failed.push({ id: record.id || 'unknown', reason: record.error })
        continue
      }
      const report = validatePageStructure(record.entries, VALIDATOR.validateEntries(record.entries, appVersion))
      if (report.verdict === 'block') {
        console.warn('[HDSIPack] 已安装包失效，跳过：', record.id, report.errors)
        failed.push({ id: record.id, reason: report.errors[0] || '包未通过验证', errors: report.errors, diagnostics: report.diagnostics })
        continue
      }
      registerValidated(report.pack.theme, report.pack.pages, report.warnings, report.pack.manifest, record.entries)
    }
    return { ok: list(), failed }
  }

  /** 导出官方主题为参考 .hdsitheme（§40.4：白纸为首个参考包） */
  async function exportTheme(themeId) {
    const packs = root.hdsiDesktop?.packs
    const builtin = root.HDSIBuiltinThemes?.byId(themeId)
    if (!packs || typeof packs.write !== 'function' || !builtin) return { ok: false, error: 'unknown-theme' }
    const themeJson = tokensFromColors(builtin.colors, builtin.id.replace(/^hdsi-/, ''))
    themeJson.name = builtin.name
    themeJson.displayName = builtin.displayName
    themeJson.description = builtin.description
    themeJson.tags = [...(builtin.tags || []), 'reference-export']
    themeJson.base = builtin.id
    const entries = {
      'theme.json': JSON.stringify(themeJson, null, 2),
      // 参考包自带 schema：作者解包后 theme.json 的相对 $schema 引用即可解析。
      ...(SCHEMA ? { 'theme.schema.v3.json': JSON.stringify(SCHEMA, null, 2) } : {}),
      'preview.svg': previewSvg(builtin.colors),
      'README.md': `# ${builtin.name} 参考主题包\n\n由 typ·0 导出的官方主题完整 token 集，可作为社区主题的起点。包含 pages/connect.json 官方连接页声明式定义。\n\n- 基础主题：${builtin.id}\n- 密度：${builtin.defaultDensity}\n- 明暗：${builtin.kind}\n`,
      'license.txt': 'HDSI official theme — reference export. Follow the upstream license.',
      'pages/connect.json': JSON.stringify({ page: { id: 'connect-main', route: 'connect', title: { fallback: '连接与账号' }, viewModel: 'app', layout: { type: 'row', className: 'connect-layout', children: [{ type: 'component', component: 'ConnectSteps' }, { type: 'component', component: 'ConnectSidePanel' }] } } }, null, 2),
    }
    themeJson.overrides = { tokens: true, variants: false, layout: false, pages: ['connect-main'], shell: false }
    entries['theme.json'] = JSON.stringify(themeJson, null, 2)
    const written = await packs.write(`${builtin.id}-reference.hdsitheme`, entries)
    return written?.ok ? { ok: true, path: written.path } : { ok: false, error: written?.error ?? 'write-failed' }
  }

  async function uninstall(id) {
    installed.delete(id)
    root.HDSIThemeV3?.unregisterTheme?.(id)
    try { if ((root.localStorage.getItem('hdsi-page-pack') || '') === id) root.HDSIPageRuntime?.setActivePack('') } catch { /* 存储不可用 */ }
    const packs = root.hdsiDesktop?.packs
    const result = typeof packs?.uninstall === 'function' ? await packs.uninstall(id) : { ok: true }
    return !!result?.ok
  }
  function hDSI_active_safe() { try { return root.localStorage.getItem('hdsi-page-pack') || '' } catch { return '' } }

  function list() { return [...installed.values()].map(entry => ({ ...entry.theme, warnings: entry.warnings, pageCount: entry.pages.length })) }

  return { importFromDisk, pickAndValidate, installValidated, summarize, exportTheme, uninstall, loadInstalled, list, validatePageStructure, __dottedToCamel: dottedToCamel, __camelToDotted: camelToDotted, __themeColorsFromTokens: themeColorsFromTokens, __registerValidated: registerValidated, __assetsFromEntries: entries => Object.fromEntries(Object.entries(entries || {}).filter(([name]) => name.startsWith('assets/')).map(([name, value]) => [`asset://${name.slice(7)}`, value])) }
})

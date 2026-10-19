/**
 * V3 §8.4/§12/§32.3：社区主题包验证器（导入与安装前强制执行）。
 * 输入 = .hdsitheme 解包后的 entries（name → 文本）；输出 = 通过 / 通过但有
 * 警告 / 阻断导入 三态 + 结构化原因。渲染快照检查（第 10 项）需要真实渲染
 * 环境，留给安装后的预览流程；此处完成其余全部静态项。
 *
 * 诊断契约（第二批导入体验批次）：errors/warnings 保持纯字符串（toast 等
 * 旧消费方依赖首条文本）；diagnostics[] 提供结构化定位（level/code/path/
 * message/hint），供导入预览界面逐条展示。code 为稳定机器标识，path 指向
 * 包内条目或 theme.json 字段路径。
 */
(function (root, factory) {
  const api = factory(root)
  if (typeof module !== 'undefined') module.exports = api
  else root.HDSIPackValidator = api
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict'

  const ID_RE = /^[a-z0-9][a-z0-9-]{2,47}$/
  const SEMVER_RE = /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/
  const ALLOWED_EXT = /\.(json|md|txt|svg|png|webp|avif|jpg|jpeg|gif|woff|woff2)$/i
  const ID_PATH_RE = /^[A-Za-z0-9._/-]+$/
  const ASSET_REF_RE = /^asset:\/\/[A-Za-z0-9._/-]+$/
  // standard 是现有 token 基座的正式名称；expressive 作为 3.1 草案别名兼容读取。
  const MOTION_LEVELS = new Set(['off', 'subtle', 'standard', 'expressive'])
  const MOTION_PROPERTIES = new Set(['opacity', 'transform', 'clip-path', 'filter', 'background-color', 'color', 'border-color', 'box-shadow'])
  const FONT_KEY_RE = /^(?:ui|mono|[a-z][a-z0-9-]{0,31})$/
  const FONT_STYLES = new Set(['normal', 'italic', 'oblique'])
  const MOTION_TRIGGERS = new Set(['enter', 'exit', 'expand', 'collapse', 'switch', 'success', 'error'])
  const INTERACTION_KINDS = new Set(['page', 'panel', 'hudTimeline', 'wizard', 'mixer', 'themePreview'])
  const MOTION_NAME_RE = /^[a-z][a-z0-9-]{0,47}$/
  const SAFE_FONT_WEIGHT = /^(?:[1-9]00(?:\s+[1-9]00)?|normal|bold|lighter|bolder)$/
  const SAFE_EASING = /^(?:linear|ease(?:-in|-out|-in-out)?|step-(?:start|end)|steps\(\s*\d+\s*,\s*(?:start|end)\s*\)|cubic-bezier\(\s*(?:-?\d+(?:\.\d+)?)\s*,\s*(?:-?\d+(?:\.\d+)?)\s*,\s*(?:-?\d+(?:\.\d+)?)\s*,\s*(?:-?\d+(?:\.\d+)?)\s*\))$/i
  const MAX_TOTAL = 5 * 1024 * 1024
  const MAX_PREVIEW = 256 * 1024
  const DANGEROUS = [
    { re: /<script[\s>]/i, label: 'script 标签' },
    { re: /\bon\w+\s*=/i, label: '内联事件属性' },
    { re: /javascript:/i, label: 'javascript: URL' },
    { re: /https?:\/\//i, label: '远程链接' },
    { re: /@import/i, label: '@import' },
    { re: /url\(\s*['"]?(?!data:|#)/i, label: 'url() 外链' },
  ]

  function luminance(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''))
    if (!m) return null
    const [r, g, b] = [0, 2, 4].map(i => parseInt(m[1].slice(i, i + 2), 16) / 255)
      .map(v => v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
    return 0.2126 * r + 0.7152 * g + 0.0722 * b
  }
  function contrast(a, b) {
    const la = luminance(a), lb = luminance(b)
    if (la === null || lb === null) return null
    const [hi, lo] = la >= lb ? [la, lb] : [lb, la]
    return (hi + 0.05) / (lo + 0.05)
  }

  function entryBytes(value) {
    if (typeof value !== 'string') return null
    if (!value.startsWith('b64:')) return value.length
    const raw = value.slice(4)
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(raw) || raw.length % 4 === 1) return null
    if (raw.length % 4 === 1) return null
    const padding = raw.endsWith('==') ? 2 : raw.endsWith('=') ? 1 : 0
    return Math.max(0, Math.floor(raw.length * 3 / 4) - padding)
  }

  /** 诊断收集器：字符串数组（旧契约）+ 结构化 diagnostics（新契约）同源写入。 */
  function collector() {
    const errors = [], warnings = [], diagnostics = []
    return {
      errors, warnings, diagnostics,
      error(code, path, message, hint) { errors.push(message); diagnostics.push({ level: 'error', code, path, message, ...(hint ? { hint } : {}) }) },
      warn(code, path, message, hint) { warnings.push(message); diagnostics.push({ level: 'warning', code, path, message, ...(hint ? { hint } : {}) }) },
    }
  }

  function validateEntries(entries, appVersion) {
    const D = collector()
    const blocked = () => ({ verdict: 'block', errors: D.errors, warnings: D.warnings, diagnostics: D.diagnostics, pack: null })
    if (!entries || typeof entries !== 'object' || Array.isArray(entries)) {
      D.error('PACK_INVALID', 'entries', '主题包条目必须是对象')
      return blocked()
    }
    const names = Object.keys(entries)
    if (!names.length) { D.error('PACK_EMPTY', 'entries', '空包'); return blocked() }
    let total = 0
    const seenNames = new Set()
    for (const name of names) {
      const value = entries[name]
      const bytes = entryBytes(value)
      if (bytes === null) D.error('ENTRY_DECODE', name, `条目内容必须是合法文本或 b64 数据：${name}`)
      else total += bytes
      if (!ID_PATH_RE.test(name) || name.includes('..') || name.startsWith('/') || /^[a-z]:/i.test(name)) D.error('ENTRY_PATH', name, `资源路径越界：${name}`)
      if (!ALLOWED_EXT.test(name)) D.error('ENTRY_EXT', name, `不允许的文件类型：${name}`)
      if (/\.js$/i.test(name)) D.error('ENTRY_SCRIPT', name, `包含脚本文件：${name}`)
      const lower = name.toLowerCase()
      if (seenNames.has(lower)) D.error('ENTRY_DUPLICATE', name, `重复条目：${name}`)
      seenNames.add(lower)
    }
    if (total > MAX_TOTAL) D.error('PACK_TOO_LARGE', 'entries', `包体积 ${(total / 1024 / 1024).toFixed(1)}MB 超过 5MB 上限`, '按解压后字节数计')

    // 1) theme.json 必需
    if (!entries['theme.json']) { D.error('THEME_MISSING', 'theme.json', '缺少 theme.json'); return blocked() }
    let theme = null
    try { theme = JSON.parse(entries['theme.json']) } catch (error) { D.error('THEME_JSON', 'theme.json', `theme.json 不是合法 JSON：${error}`); return blocked() }
    if (!theme || typeof theme !== 'object') { D.error('THEME_ROOT', 'theme.json', 'theme.json 根必须是对象'); return blocked() }

    // 1.1) 3.1 manifest：旧包没有 manifest 时继续按 schema v3 兼容读取。
    let manifest = null
    if (entries['manifest.json'] !== undefined) {
      try { manifest = JSON.parse(entries['manifest.json']) } catch (error) { D.error('MANIFEST_JSON', 'manifest.json', `manifest.json 不是合法 JSON：${error}`) }
      if (manifest && typeof manifest !== 'object') { D.error('MANIFEST_ROOT', 'manifest.json', 'manifest.json 根必须是对象'); manifest = null }
      if (manifest) {
        if (manifest.id !== undefined && manifest.id !== theme.id) D.error('MANIFEST_ID', 'manifest.json#id', 'manifest.id 必须与 theme.json 的 id 一致')
        if (manifest.version !== undefined && manifest.version !== theme.version) D.error('MANIFEST_VERSION', 'manifest.json#version', 'manifest.version 必须与 theme.json 的 version 一致')
        if (manifest.entry !== undefined && manifest.entry !== 'theme.json') D.error('MANIFEST_ENTRY', 'manifest.json#entry', 'manifest.entry 必须指向 theme.json')
        if (manifest.capabilities !== undefined && (!Array.isArray(manifest.capabilities) || manifest.capabilities.some(item => typeof item !== 'string'))) D.error('MANIFEST_CAPABILITIES', 'manifest.json#capabilities', 'manifest.capabilities 必须是字符串数组')
        if (manifest.permissions !== undefined && (!Array.isArray(manifest.permissions) || manifest.permissions.length)) D.error('MANIFEST_PERMISSIONS', 'manifest.json#permissions', '主题包 permissions 必须为空数组')
      }
    }

    // 2) ID / 版本（§4.3：社区不得使用 hdsi- 保留前缀）
    const id = theme.id
    if (typeof id !== 'string' || !ID_RE.test(id)) D.error('THEME_ID', 'theme.json#id', `主题 ID 非法：${JSON.stringify(id)}`, '小写字母/数字/短横线，3–48 字符')
    else if (id.startsWith('hdsi-')) D.error('THEME_ID_RESERVED', 'theme.json#id', '社区主题不得使用 hdsi- 官方保留前缀')
    if (!SEMVER_RE.test(String(theme.version || ''))) D.error('THEME_VERSION', 'theme.json#version', `版本不是 SemVer：${theme.version}`)
    if (!theme.name || typeof theme.name !== 'string') D.error('THEME_NAME', 'theme.json#name', '缺少 name')
    if (theme.author && typeof theme.author !== 'object') D.error('THEME_AUTHOR', 'theme.json#author', 'author 必须是对象')

    // 3) token 约束（§33.2：值域与别名）
    const tokens = theme.tokens
    if (!tokens || typeof tokens !== 'object') D.error('TOKENS_MISSING', 'theme.json#tokens', '缺少 tokens')
    else {
      for (const [key, value] of Object.entries(tokens)) {
        if (!/^([\w-]+\.)*[\w-]+$/.test(key)) D.error('TOKEN_NAME', `theme.json#tokens.${key}`, `token 名非法：${key}`)
        const raw = value && typeof value === 'object' ? value.value : value
        if (typeof raw === 'string' && /^#/.test(raw) && !/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(raw)) D.error('TOKEN_COLOR', `theme.json#tokens.${key}`, `token ${key} 颜色值非法：${raw}`, '只接受 #rgb 或 #rrggbb')
        if (key.startsWith('x-community.')) D.warn('TOKEN_UNUSED', `theme.json#tokens.${key}`, `自定义 token ${key} 不会被核心组件消费`)
      }
    }
    if (theme.aliases) {
      const aliases = theme.aliases
      if (!aliases || typeof aliases !== 'object' || Array.isArray(aliases)) D.error('ALIASES_TYPE', 'theme.json#aliases', 'aliases 必须是对象')
      else for (const key of Object.keys(aliases)) {
        const seen = new Set([key])
        let cur = aliases[key]
        while (typeof cur === 'string' && aliases[cur] !== undefined) {
          if (seen.has(cur)) { D.warn('ALIAS_CYCLE', `theme.json#aliases.${key}`, `别名链成环：${key}`); break }
          seen.add(cur)
          cur = aliases[cur]
        }
      }
    }

    // 页面定义也属于主题包声明面，页面中的背景/图标引用同样必须经过检查。
    const pages = collectPages(entries, D)

    // 3.1) 图片、字体和动效声明：只接受包内 asset:// 引用和受控属性。
    for (const ref of collectAssetRefs({ theme, pages })) {
      if (!ASSET_REF_RE.test(ref)) { D.error('ASSET_REF', ref, `资源引用非法：${ref}`, '引用形如 asset://background/hero.webp，且文件位于包内 assets/ 目录'); continue }
      const assetName = `assets/${ref.slice('asset://'.length)}`
      if (!entries[assetName]) D.error('ASSET_MISSING', assetName, `资源引用不存在：${ref}`)
    }
    if (theme.fonts !== undefined) validateFonts(theme.fonts, entries, D)
    const motion = theme.motionSpec || theme.motion
    if (motion !== undefined) validateMotion(motion, D)
    validateInteractions(theme.interactions, motion, D)
    validatePageMotionDeclarations(pages, motion, D)

    // 4) 对比度（§12.1：正文 AA=4.5，关键状态 ≥3）
    const pick = key => theme.tokens?.[key]?.value ?? theme.tokens?.[key]
    const canvas = pick('color.canvas'), textPrimary = pick('color.text.primary')
    if (canvas && textPrimary) {
      const ratio = contrast(canvas, textPrimary)
      if (ratio === null) D.error('CONTRAST_COLOR', 'theme.json#tokens', '正文颜色不是合法色值')
      else if (ratio < 4.5) D.error('CONTRAST_BODY', 'theme.json#tokens', `正文对比度 ${ratio.toFixed(2)} 低于 AA（4.5）`, 'color.canvas × color.text.primary 需 ≥ 4.5')
      for (const state of ['color.state.success', 'color.state.warning', 'color.state.danger', 'color.state.info']) {
        const value = pick(state)
        const stateRatio = value ? contrast(canvas, value) : null
        if (stateRatio !== null && stateRatio < 3) D.warn('CONTRAST_STATE', `theme.json#tokens.${state}`, `${state} 对比度 ${stateRatio.toFixed(2)} 低于 3（UI 组件建议值）`)
      }
    }

    // 5) 字体回退（§5.5：字体栈必须以通用族结尾）
    for (const key of ['font.ui', 'font.mono']) {
      const stack = pick(key)
      if (typeof stack === 'string' && !/(serif|sans-serif|monospace|cursive|fantasy|system-ui)\s*$/.test(stack)) D.warn('FONT_STACK', `theme.json#tokens.${key}`, `${key} 字体栈缺少通用族回退`, '以 sans-serif / monospace 等通用族结尾')
    }

    // xmlns 命名空间声明是合法 SVG 必需项，扫描前剥离（不构成外链）
    const stripXmlns = text => String(text).replace(/xmlns(:\w+)?="[^"]*"/g, '').replace(/"\$schema"\s*:\s*"[^"]*"/g, '"$schema":""')
    // 6) 预览图安全（§8.4：禁止脚本与外链）
    const previewName = String(theme.preview || 'preview.svg').replace(/^\.\//, '')
    const preview = entries[previewName]
    if (!preview) D.warn('PREVIEW_MISSING', previewName, '缺少预览图（主题卡片将使用色板条代替）')
    else {
      if (preview.length > MAX_PREVIEW) D.error('PREVIEW_SIZE', previewName, '预览图超过 256KB')
      if (!/<svg[\s>]/i.test(preview)) D.error('PREVIEW_TYPE', previewName, '预览图必须是 SVG')
      for (const danger of DANGEROUS) if (danger.re.test(stripXmlns(preview))) D.error('PREVIEW_UNSAFE', previewName, `预览图含${danger.label}`)
    }

    // 7) 外链与脚本扫描（全部文本条目）
    for (const name of names) {
      if (/\.(png|webp|woff2)$/i.test(name)) continue
      for (const danger of DANGEROUS) if (danger.re.test(stripXmlns(entries[name]))) { D.error('ENTRY_UNSAFE', name, `${name} 含${danger.label}`); break }
    }

    // 8) 兼容版本
    const compat = theme.compatibility || {}
    if (compat.minAppVersion && !versionAtLeast(appVersion, compat.minAppVersion)) D.error('COMPAT_MIN', 'theme.json#compatibility.minAppVersion', `需要应用 ≥ ${compat.minAppVersion}（当前 ${appVersion}）`)
    if (compat.maxAppVersion && compat.maxAppVersion !== '*' && !versionAtLeast(compat.maxAppVersion, appVersion)) D.error('COMPAT_MAX', 'theme.json#compatibility.maxAppVersion', `仅支持 ≤ ${compat.maxAppVersion}`)

    // 9) UI 包覆盖声明（§32.3：带 pages 的包必须声明 overrides）
    if (pages.length) {
      const overrides = theme.overrides
      if (!overrides || typeof overrides !== 'object') D.error('OVERRIDES_MISSING', 'theme.json#overrides', 'UI 包缺少 overrides 声明')
      else if (!Array.isArray(overrides.pages)) D.error('OVERRIDES_PAGES', 'theme.json#overrides.pages', 'overrides.pages 必须是数组')
      else {
        const pageIds = new Set(pages.map(page => page?.page?.id || page?.id).filter(Boolean))
        for (const pageId of overrides.pages) if (typeof pageId !== 'string' || !pageIds.has(pageId)) D.error('OVERRIDES_PAGE', 'theme.json#overrides.pages', `overrides.pages 未找到页面：${pageId}`)
      }
    }

    const verdict = D.errors.length ? 'block' : D.warnings.length ? 'pass-with-warnings' : 'pass'
    return { verdict, errors: D.errors, warnings: D.warnings, diagnostics: D.diagnostics, pack: D.errors.length ? null : { theme, manifest, pages } }
  }


  function validateFonts(fonts, entries, D) {
    if (!fonts || typeof fonts !== 'object' || Array.isArray(fonts)) { D.error('FONTS_TYPE', 'theme.json#fonts', 'fonts 必须是对象'); return }
    for (const [name, spec] of Object.entries(fonts)) {
      if (!FONT_KEY_RE.test(name) || !spec || typeof spec !== 'object' || Array.isArray(spec)) { D.error('FONT_KEY', `theme.json#fonts.${name}`, `字体声明非法：${name}`); continue }
      if (typeof spec.src !== 'string' || !ASSET_REF_RE.test(spec.src)) D.error('FONT_SRC', `theme.json#fonts.${name}.src`, `字体 ${name} 的 src 必须是 asset:// 引用`)
      else if (!/\.woff2?$/i.test(spec.src)) D.error('FONT_EXT', `theme.json#fonts.${name}.src`, `字体 ${name} 只能使用 .woff 或 .woff2 资源`)
      if (spec.weight !== undefined && !((typeof spec.weight === 'number' && Number.isInteger(spec.weight) && spec.weight >= 100 && spec.weight <= 900) || (typeof spec.weight === 'string' && SAFE_FONT_WEIGHT.test(spec.weight)))) D.error('FONT_WEIGHT', `theme.json#fonts.${name}.weight`, `字体 ${name} 的 weight 非法`, '100–900 整数，或 "400 700" 组合')
      if (spec.style !== undefined && (typeof spec.style !== 'string' || !FONT_STYLES.has(spec.style))) D.error('FONT_STYLE', `theme.json#fonts.${name}.style`, `字体 ${name} 的 style 非法`)
      if (spec.display !== undefined && !['auto', 'block', 'swap', 'fallback', 'optional'].includes(spec.display)) D.error('FONT_DISPLAY', `theme.json#fonts.${name}.display`, `字体 ${name} 的 display 非法`)
    }
    for (const [name, spec] of Object.entries(fonts)) {
      if (spec && typeof spec.src === 'string' && ASSET_REF_RE.test(spec.src)) {
        const path = `assets/${spec.src.slice('asset://'.length)}`
        if (!entries[path]) D.error('FONT_MISSING', path, `字体 ${name} 引用不存在：${spec.src}`)
      }
    }
  }

  function validateMotion(motion, D) {
    if (!motion || typeof motion !== 'object' || Array.isArray(motion)) { D.error('MOTION_TYPE', 'theme.json#motion', 'motion 必须是对象'); return }
    const level = motion.level || motion.defaultLevel
    if (level !== undefined && !MOTION_LEVELS.has(level)) D.error('MOTION_LEVEL', 'theme.json#motion.level', `动效等级非法：${level}`, 'off / subtle / standard / expressive')
    const presets = motion.presets
    if (presets !== undefined && (!presets || typeof presets !== 'object' || Array.isArray(presets))) { D.error('MOTION_PRESETS_TYPE', 'theme.json#motion.presets', 'motion.presets 必须是对象'); return }
    for (const [name, preset] of Object.entries(presets || {})) {
      if (!MOTION_NAME_RE.test(name) || !preset || typeof preset !== 'object' || Array.isArray(preset)) { D.error('MOTION_PRESET', `theme.json#motion.presets.${name}`, `动效 preset 非法：${name}`); continue }
      if (preset.properties !== undefined && (!Array.isArray(preset.properties) || preset.properties.length === 0 || preset.properties.some(prop => !MOTION_PROPERTIES.has(prop)))) D.error('MOTION_PROPERTY', `theme.json#motion.presets.${name}.properties`, `动效 preset ${name} 含不允许的属性`)
      if (preset.duration !== undefined && (typeof preset.duration !== 'number' || !Number.isFinite(preset.duration) || preset.duration < 0 || preset.duration > 5000)) D.error('MOTION_DURATION', `theme.json#motion.presets.${name}.duration`, `动效 preset ${name} 的 duration 非法`, '0–5000ms')
      if (preset.delay !== undefined && (typeof preset.delay !== 'number' || !Number.isFinite(preset.delay) || preset.delay < 0 || preset.delay > 5000)) D.error('MOTION_DELAY', `theme.json#motion.presets.${name}.delay`, `动效 preset ${name} 的 delay 非法`, '0–5000ms')
      if (preset.easing !== undefined && (typeof preset.easing !== 'string' || !SAFE_EASING.test(preset.easing))) D.error('MOTION_EASING', `theme.json#motion.presets.${name}.easing`, `动效 preset ${name} 的 easing 非法`, '标准关键字 / steps() / cubic-bezier()')
      if (preset.iterationCount !== undefined && preset.iterationCount !== 'infinite' && (typeof preset.iterationCount !== 'number' || !Number.isInteger(preset.iterationCount) || preset.iterationCount < 1 || preset.iterationCount > 20)) D.error('MOTION_ITERATION', `theme.json#motion.presets.${name}.iterationCount`, `动效 preset ${name} 的 iterationCount 非法`, '1–20 或 "infinite"')
      if (preset.iterationCount === 'infinite') D.warn('MOTION_LOOP', `theme.json#motion.presets.${name}.iterationCount`, `动效 preset ${name} 使用持续循环，请确认 reduced-motion 降级`)
      for (const phase of ['from', 'to']) {
        if (preset[phase] === undefined) continue
        const frame = preset[phase]
        if (!frame || typeof frame !== 'object' || Array.isArray(frame)) { D.error('MOTION_FRAME', `theme.json#motion.presets.${name}.${phase}`, `动效 preset ${name} 的 ${phase} 必须是对象`); continue }
        for (const [prop, value] of Object.entries(frame)) {
          if (!MOTION_PROPERTIES.has(prop)) { D.error('MOTION_FRAME_PROP', `theme.json#motion.presets.${name}.${phase}.${prop}`, `动效 preset ${name} 的 ${phase}.${prop} 不允许`); continue }
          if ((typeof value !== 'string' && typeof value !== 'number') || (typeof value === 'string' && /[;{}]|url\s*\(|javascript:|expression\s*\(/i.test(value))) D.error('MOTION_FRAME_VALUE', `theme.json#motion.presets.${name}.${phase}.${prop}`, `动效 preset ${name} 的 ${phase}.${prop} 值非法`)
          if (prop === 'opacity' && (typeof value !== 'number' || value < 0 || value > 1)) D.error('MOTION_OPACITY', `theme.json#motion.presets.${name}.${phase}.opacity`, `动效 preset ${name} 的 ${phase}.opacity 必须是 0 到 1`)
        }
      }
    }
  }

  function validateInteractions(interactions, motion, D) {
    if (interactions === undefined) return
    if (!interactions || typeof interactions !== 'object' || Array.isArray(interactions)) { D.error('INTERACTIONS_TYPE', 'theme.json#interactions', 'interactions 必须是对象'); return }
    const presets = motion && typeof motion === 'object' && motion.presets && typeof motion.presets === 'object' ? motion.presets : {}
    for (const [kind, mapping] of Object.entries(interactions)) {
      if (!INTERACTION_KINDS.has(kind)) { D.error('INTERACTION_KIND', `theme.json#interactions.${kind}`, `未知交互意图：${kind}`); continue }
      if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) { D.error('INTERACTION_MAPPING', `theme.json#interactions.${kind}`, `interactions.${kind} 必须是对象`); continue }
      for (const [trigger, preset] of Object.entries(mapping)) {
        if (!MOTION_TRIGGERS.has(trigger)) D.error('INTERACTION_TRIGGER', `theme.json#interactions.${kind}.${trigger}`, `interactions.${kind}.${trigger} 触发名非法`)
        if (typeof preset !== 'string' || !MOTION_NAME_RE.test(preset)) D.error('INTERACTION_PRESET', `theme.json#interactions.${kind}.${trigger}`, `interactions.${kind}.${trigger} preset 名非法`)
        else if (!Object.prototype.hasOwnProperty.call(presets, preset)) D.error('INTERACTION_PRESET_MISSING', `theme.json#interactions.${kind}.${trigger}`, `interactions.${kind}.${trigger} 引用了不存在的 preset：${preset}`)
      }
    }
  }

  function validatePageMotionDeclarations(pages, motion, D) {
    const presets = motion && typeof motion === 'object' && motion.presets && typeof motion.presets === 'object' ? motion.presets : {}
    const hasPresets = motion && typeof motion === 'object' && motion.presets !== undefined
    const check = (binding, path) => {
      if (binding === undefined) return
      const values = typeof binding === 'string' ? [['enter', binding]] : binding && typeof binding === 'object' && !Array.isArray(binding) ? Object.entries(binding) : null
      if (!values) { D.error('PAGE_MOTION_BINDING', path, `${path} 必须是 preset 名或对象`); return }
      for (const [trigger, preset] of values) {
        if (!MOTION_TRIGGERS.has(trigger)) D.error('PAGE_MOTION_TRIGGER', `${path}.${trigger}`, `${path}.${trigger} 触发名非法`)
        if (typeof preset !== 'string' || !MOTION_NAME_RE.test(preset)) D.error('PAGE_MOTION_PRESET', `${path}.${trigger}`, `${path}.${trigger} preset 名非法`)
        else if (hasPresets && !Object.prototype.hasOwnProperty.call(presets, preset)) D.error('PAGE_MOTION_PRESET_MISSING', `${path}.${trigger}`, `${path}.${trigger} 引用了不存在的 preset：${preset}`)
        else if (!hasPresets) D.error('PAGE_MOTION_NO_PRESETS', `${path}.${trigger}`, `${path}.${trigger} 引用了 preset，但主题未声明 motion.presets`)
      }
    }
    const walk = (node, path) => {
      if (!node || typeof node !== 'object') return
      check(node.motion, `${path}.motion`)
      if (node.type === 'scroll') walk(node.child, `${path}.child`)
      else if (node.type === 'tabs') for (let i = 0; i < (node.items || []).length; i++) walk(node.items[i]?.content, `${path}.items[${i}].content`)
      else if (node.type === 'when') { walk(node.then, `${path}.then`); walk(node.else, `${path}.else`) }
      else if (node.type === 'repeat') { walk(node.item, `${path}.item`); walk(node.empty, `${path}.empty`) }
      else for (let i = 0; i < (node.children || []).length; i++) walk(node.children[i], `${path}.children[${i}]`)
    }
    for (const [index, page] of (pages || []).entries()) {
      const inner = page?.page || page
      if (!inner || typeof inner !== 'object') continue
      check(inner.motion, `pages[${index}].page.motion`)
      walk(inner.layout, `pages[${index}].page.layout`)
    }
  }

  function collectPages(entries, D) {
    const pages = []
    for (const name of Object.keys(entries)) {
      if (!/^pages\/[\w-]+\.json$/.test(name)) continue
      try {
        const page = JSON.parse(entries[name])
        if (!page || typeof page !== 'object') { D.error('PAGE_ROOT', name, `${name} 根必须是对象`); continue }
        pages.push(page)
      } catch (error) { D.error('PAGE_JSON', name, `${name} 不是合法 JSON：${error}`) }
    }
    return pages
  }

  function collectAssetRefs(value, refs = new Set()) {
    if (typeof value === 'string' && (value.startsWith('asset://') || value.startsWith('http://') || value.startsWith('https://'))) refs.add(value)
    else if (Array.isArray(value)) for (const item of value) collectAssetRefs(item, refs)
    else if (value && typeof value === 'object') for (const item of Object.values(value)) collectAssetRefs(item, refs)
    return refs
  }

  // 预发布后缀（如 0.0.1-m3）不参与比较：Number('1-m3')=NaN 会让任何
  // 比较静默判 false，主进程真实版本一旦带后缀就会全量误判兼容性。
  function versionTriple(value) {
    const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(String(value || '').trim())
    return [m ? Number(m[1]) : 0, m ? Number(m[2] || 0) : 0, m ? Number(m[3] || 0) : 0]
  }
  function versionAtLeast(current, minimum) {
    const a = versionTriple(current), b = versionTriple(minimum)
    for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i] > b[i]
    return true
  }

  return { validateEntries, contrast, luminance, versionAtLeast }
})

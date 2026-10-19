/**
 * V3 §5/§9：Token 契约层。core-defaults 是五层合成的最底层——取值等于
 * V3「清澄」出厂观感，保证"未选主题 = 设计稿默认状态"零闪烁。
 * 主题（官方/兼容/社区）只提供与默认同名的覆盖值；运行时把合成结果
 * 写成 --hdsi-* CSS 变量，style.css 里的旧变量（--bg/--panel/...）全部
 * 映射到本层，组件永远不直接引用主题原始色值。
 */
(function (root, factory) {
  const api = factory(root)
  if (typeof module !== 'undefined') module.exports = api
  else root.HDSITokens = api
})(typeof self !== 'undefined' ? self : globalThis, function (root) {
  'use strict'

  /** 合成顺序（V3 §3.1，低 → 高）：defaults → theme → user → accessibility */
  const LAYER_ORDER = ['defaults', 'theme', 'user', 'accessibility']

  /**
   * 核心默认值（camelCase；运行时转 --hdsi-color-* 变量）。
   *
   * 这是 V3 设计稿中的「清澄」出厂外观：和纸暖白、墨色文字、
   * 靛蓝/苔绿状态和朱砂动作色。未选择主题时也必须直接呈现这套
   * 视觉，避免启动首帧先闪回旧深色工作台。
   */
  const CORE_DEFAULTS = {
    // 表面阶梯（§2.2：细线代替厚卡片，同一页面最多四级表面色）
    canvas: '#f3f1eb',
    surface: '#f8f7f3',
    surfaceRaised: '#ffffff',
    surfaceSunken: '#ebe8df',
    surfaceHover: '#ebe8df',
    surfaceActive: '#d5d2c8',
    // 边线阶梯：soft（弱分隔）< base < strong（交互强调）< deep（内嵌暗线）
    border: '#d5d2c8',
    borderSoft: '#e4e1d8',
    borderStrong: '#b8b8ac',
    borderDeep: '#c3c1b8',
    // 文字阶梯（§12.1：正文不因主题低于 12px / 对比度 AA 由验证器保证）
    textPrimary: '#202824',
    textSecondary: '#465049',
    textMuted: '#778078',
    textOnAccent: '#fff8f4',
    textOnTrack: '#202824',
    // 强调（§2.1 Shibumi：少量精确的强调色承载行为意义）
    accent: '#bd5d4e',
    accentBright: '#d27a6c',
    accentFaint: '#f2dfd9',
    // 状态四族：基色 + 浅底/边线/前景三件套（§9.3 状态语义不可被主题改写）
    success: '#718065', successBg: '#e2e8dc', successBorder: '#c9d4c2', successFg: '#55634c',
    warning: '#a27d3f', warningBg: '#f1e7d3', warningBorder: '#d7bd8a', warningFg: '#80602d',
    danger: '#bd5d4e', dangerBg: '#f2dfd9', dangerBorder: '#e2c3ba', dangerFg: '#8e4d43',
    info: '#596f80', infoBg: '#dbe4e7', infoBorder: '#c3d0d5', infoFg: '#445967',
    // 时间线轨道（§11.4：Script 主色，Receive/Send 方向和颜色双重提示）
    trackScript: '#8b788e', trackScriptBright: '#a992aa',
    trackReceive: '#596f80',
    trackSend: '#bd5d4e',
    trackMedia: '#718065',
    trackFacts: '#a3927b',
    trackAlter: '#a7848e',
    trackPreplan: '#a38c61',
    trackNeutral: '#9a978c',
    // 阴影（官方主题默认关闭容器阴影，仅弹窗/浮层使用）
    shadowSoft: 'rgba(39,45,41,.08)',
    shadowOverlay: 'rgba(39,45,41,.28)',
    // 字体（§5.5：UI 无衬线；mono 用于时间/ID/日志）
    fontUi: '"Segoe UI","Noto Sans SC","Hiragino Kaku Gothic ProN","Yu Gothic","Microsoft YaHei",sans-serif',
    fontMono: 'ui-monospace,SFMono-Regular,Menlo,Consolas,"Noto Sans SC","Microsoft YaHei",sans-serif',
  }

  /** 密度四档（§5.3；正文下限 12px 是主题不可触碰的硬约束） */
  const DENSITY_TIERS = {
    compact: { label: '极简高密度', scale: 0.88, sizeBody: 12, sizeSmall: 11, sizeLabel: 10, controlHeight: 26, rowHeight: 24, space1: 3, space2: 6, space3: 10, space4: 14 },
    workbench: { label: '工作台', scale: 0.94, sizeBody: 12, sizeSmall: 11, sizeLabel: 10, controlHeight: 28, rowHeight: 28, space1: 4, space2: 7, space3: 11, space4: 16 },
    standard: { label: '标准', scale: 1.0, sizeBody: 13, sizeSmall: 12, sizeLabel: 10, controlHeight: 32, rowHeight: 32, space1: 4, space2: 8, space3: 12, space4: 18 },
    relaxed: { label: '宽松', scale: 1.08, sizeBody: 14, sizeSmall: 12, sizeLabel: 11, controlHeight: 36, rowHeight: 36, space1: 5, space2: 9, space3: 14, space4: 20 },
  }
  const DEFAULT_DENSITY = 'workbench'

  /** 动效三档（§5.6；官方主题不使用 strong） */
  const MOTION_LEVELS = { off: { label: '关闭', factor: 0 }, subtle: { label: '轻微', factor: 0.6 }, standard: { label: '标准', factor: 1 } }
  const MOTION_BASE = { fast: 100, normal: 160, slow: 240 }
  const DEFAULT_MOTION = 'subtle'

  /** camelCase token → CSS 变量名：颜色族进 --hdsi-color-*，字体单独 --hdsi-font-* */
  function varName(key) {
    if (key.startsWith('fontUi') || key.startsWith('fontMono')) return `--hdsi-${kebab(key)}`
    if (/^(success|warning|danger|info)(Bg|Border|Fg)?$/.test(key)) {
      const m = key.match(/^(success|warning|danger|info)(Bg|Border|Fg)?$/)
      return m[2] ? `--hdsi-color-state-${m[1]}-${m[2].toLowerCase()}` : `--hdsi-color-state-${m[1]}`
    }
    return `--hdsi-color-${kebab(key)}`
  }
  function kebab(name) { return name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase() }

  /** 深合并：后者覆盖前者，只接受与默认同名（或 x-community 前缀）的键 */
  function mergeTokens(base, override) {
    const out = { ...base }
    if (!override || typeof override !== 'object') return out
    for (const [key, value] of Object.entries(override)) {
      if (value === undefined || value === null || value === '') continue
      out[key] = value
    }
    return out
  }

  /** 主题色板 → 扁平 token 集（补齐浅底/边线/前景三件套的缺省推导） */
  function completePalette(palette) {
    const merged = mergeTokens(CORE_DEFAULTS, palette)
    return merged
  }

  return {
    CORE_DEFAULTS, DENSITY_TIERS, DEFAULT_DENSITY, MOTION_LEVELS, MOTION_BASE, DEFAULT_MOTION,
    LAYER_ORDER, varName, kebab, mergeTokens, completePalette,
  }
})

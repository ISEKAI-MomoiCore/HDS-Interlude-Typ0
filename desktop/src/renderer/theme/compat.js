/**
 * V3 L0 兼容层：把 V2 主题 JSON（16 套社区配色）转换为 V3 token 色板。
 * 转换是纯函数——运行时负责 fetch，测试可以直接对全部 JSON 跑。
 * 缺失键逐级回退；V2 没有的 token（边线阶梯、状态三件套、浅底、轨道亮色）
 * 由色值混合推导，保证任何一套 V2 主题在 V3 下都有完整、可用的 token 集。
 */
(function (root, factory) {
  const api = factory(root)
  if (typeof module !== 'undefined') module.exports = api
  else root.HDSIThemeCompat = api
})(typeof self !== 'undefined' ? self : globalThis, function (root) {
  'use strict'

  // ── 色值工具 ─────────────────────────────────────────────
  function hexToRgb(hex) {
    const value = String(hex || '').trim().replace(/^#/, '')
    const full = value.length === 3 ? value.split('').map(ch => ch + ch).join('') : value
    if (!/^[0-9a-fA-F]{6}$/.test(full)) return null
    return [parseInt(full.slice(0, 2), 16), parseInt(full.slice(2, 4), 16), parseInt(full.slice(4, 6), 16)]
  }
  function rgbToHex(rgb) {
    return '#' + rgb.map(ch => Math.max(0, Math.min(255, Math.round(ch))).toString(16).padStart(2, '0')).join('')
  }
  /** t=0 → a，t=1 → b */
  function mix(a, b, t) {
    const ra = hexToRgb(a), rb = hexToRgb(b)
    if (!ra) return b; if (!rb) return a
    return rgbToHex(ra.map((ch, i) => ch + (rb[i] - ch) * t))
  }
  /** amount>0 向白，<0 向黑（按比例） */
  function shade(hex, amount) { return amount >= 0 ? mix(hex, '#ffffff', amount) : mix(hex, '#000000', -amount) }
  function luminance(hex) {
    const rgb = hexToRgb(hex)
    if (!rgb) return 0.5
    const [r, g, b] = rgb.map(ch => { const v = ch / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 })
    return 0.2126 * r + 0.7152 * g + 0.0722 * b
  }
  function isDark(hex) { return luminance(hex) < 0.35 }
  /** 在深/浅两种前景里选与底色对比更高的一个 */
  function pickOn(bg, darkChoice, lightChoice) { return isDark(bg) ? lightChoice : darkChoice }

  // ── V2 → V3 ─────────────────────────────────────────────
  const DENSITIES = new Set(['compact', 'workbench', 'standard', 'relaxed'])
  const MOTIONS = new Set(['off', 'subtle', 'standard'])

  function profileFor(indexEntry, v2) {
    const declared = indexEntry && indexEntry.v3 && typeof indexEntry.v3 === 'object' ? indexEntry.v3 : {}
    const legacyDensity = v2 && v2.presets && v2.presets.densityPreset
    const density = DENSITIES.has(declared.density)
      ? declared.density
      : (DENSITIES.has(legacyDensity) ? legacyDensity : 'workbench')
    const motion = MOTIONS.has(declared.motion) ? declared.motion : 'subtle'
    const tags = Array.isArray(declared.tags)
      ? declared.tags.filter(tag => typeof tag === 'string' && /^[a-z0-9-]{1,32}$/.test(tag))
      : []
    return {
      density,
      motion,
      tags,
      description: typeof declared.description === 'string' && declared.description.trim()
        ? declared.description.trim()
        : (v2 && v2.description) || 'V2 社区配色（L0 兼容层自动转换）',
    }
  }

  function motionSpecFor(profile) {
    const duration = profile.motion === 'standard' ? 200 : 160
    const switchDuration = profile.motion === 'standard' ? 220 : 180
    return {
      level: profile.motion,
      presets: {
        'page-enter': {
          from: { opacity: 0, transform: 'translateY(3px)' },
          to: { opacity: 1, transform: 'translateY(0)' },
          properties: ['opacity', 'transform'], duration, easing: 'ease-out',
        },
        'panel-expand': {
          from: { opacity: 0.88, transform: 'translateY(3px)' },
          to: { opacity: 1, transform: 'translateY(0)' },
          properties: ['opacity', 'transform'], duration, easing: 'ease-out',
        },
        'panel-collapse': {
          from: { opacity: 1, transform: 'translateY(0)' },
          to: { opacity: 0.88, transform: 'translateY(3px)' },
          properties: ['opacity', 'transform'], duration, easing: 'ease-in',
        },
        'view-switch': {
          from: { opacity: 0.9, transform: 'translateY(4px)' },
          to: { opacity: 1, transform: 'translateY(0)' },
          properties: ['opacity', 'transform'], duration: switchDuration, easing: 'ease-out',
        },
      },
    }
  }

  function interactionsFor() {
    return {
      page: { enter: 'page-enter' },
      panel: { expand: 'panel-expand', collapse: 'panel-collapse' },
      hudTimeline: { switch: 'view-switch' },
      wizard: { switch: 'view-switch' },
      mixer: { enter: 'view-switch' },
    }
  }

  function convert(indexEntry, v2) {
    const colors = (v2 && v2.colors) || {}
    const bg = colors.background || {}
    const text = colors.text || {}
    const accent = colors.accent || {}
    const status = colors.status || {}
    const tracks = colors.tracks || {}
    const first = value => Array.isArray(value) ? value[0] : value
    const profile = profileFor(indexEntry, v2)

    const canvas = bg.canvas || bg.base || '#242424'
    const surface = bg.surface || bg.panel || canvas
    const raised = bg.elevated || bg.panel || surface
    const highlight = bg.highlight || raised
    const dark = isDark(canvas)
    const sunken = dark ? shade(canvas, -0.28) : shade(canvas, 0.55)
    const hover = dark ? shade(surface, 0.16) : shade(surface, -0.06)
    const active = dark ? shade(highlight, 0.05) : shade(highlight, -0.1)

    const textPrimary = text.primary || text.tertiary || (dark ? '#e4e4e4' : '#26241f')
    const textSecondary = text.secondary || mix(textPrimary, canvas, 0.35)
    const textMuted = text.muted || mix(textPrimary, canvas, 0.55)
    const lineBase = mix(textPrimary, canvas, 0.3)
    const border = lineBase
    const borderSoft = mix(textPrimary, canvas, 0.18)
    const borderStrong = mix(textPrimary, canvas, 0.42)
    const borderDeep = dark ? shade(canvas, -0.4) : shade(canvas, 0.3)

    const accentPrimary = accent.primary || accent.main || (dark ? '#ffc900' : '#b56a3c')
    const accentBright = accent.secondary || shade(accentPrimary, dark ? 0.18 : -0.12)
    const onAccent = pickOn(accentPrimary, '#1b1a17', '#fbf9f4')

    const stateTokens = {}
    for (const [name, v2Key, fallback] of [['success', 'success', '#8fcb58'], ['warning', 'warning', '#e0b341'], ['danger', 'error', '#df7777'], ['info', 'info', '#75aee8']]) {
      const base = status[v2Key] || fallback
      stateTokens[name] = base
      stateTokens[name + 'Bg'] = mix(base, canvas, dark ? 0.78 : 0.84)
      stateTokens[name + 'Border'] = mix(base, canvas, 0.45)
      stateTokens[name + 'Fg'] = dark ? shade(base, 0.24) : shade(base, -0.3)
    }

    const trackScript = first(tracks.script) || accentPrimary
    const preplanBase = mix(accentPrimary, canvas, 0.55)
    return {
      id: indexEntry.id,
      name: indexEntry.name || v2.name || indexEntry.id,
      description: profile.description,
      tags: [...new Set(['compat', 'v2', dark ? 'dark' : 'light', ...profile.tags])],
      official: false, compat: true,
      kind: dark ? 'dark' : 'light',
      colorScheme: v2.colorScheme === 'light' || v2.colorScheme === 'dark' ? v2.colorScheme : (dark ? 'dark' : 'light'),
      defaultDensity: profile.density, motion: profile.motion,
      motionSpec: motionSpecFor(profile),
      interactions: interactionsFor(),
      colors: {
        canvas, surface, surfaceRaised: raised, surfaceSunken: sunken,
        surfaceHover: hover, surfaceActive: active,
        border, borderSoft, borderStrong, borderDeep,
        textPrimary, textSecondary, textMuted,
        textOnAccent: onAccent, textOnTrack: pickOn(surface, '#1e1e1e', '#26241f'),
        accent: accentPrimary, accentBright,
        accentFaint: toAlpha(accentPrimary, 0.22),
        ...stateTokens,
        trackScript, trackScriptBright: (tracks.script && tracks.script[1]) || shade(trackScript, dark ? 0.22 : -0.14),
        trackReceive: first(tracks.receive) || '#75aee8',
        trackSend: first(tracks.send) || '#eaa363',
        trackMedia: first(tracks.media) || '#5a9e8f',
        trackFacts: first(tracks.state) || '#ad87d4',
        trackAlter: first(tracks.alter) || '#c78fd4',
        trackPreplan: preplanBase,
        trackNeutral: mix(textPrimary, canvas, 0.38),
      },
    }
  }

  function toAlpha(hex, alpha) {
    const rgb = hexToRgb(hex)
    if (!rgb) return `rgba(0,0,0,${alpha})`
    return `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${alpha})`
  }

  return { convert, mix, shade, luminance, isDark, pickOn, hexToRgb, rgbToHex }
})

/**
 * V3 §6/§25：五个官方出厂主题。每套主题解决一种真实工作场景，共享组件
 * 契约但不共享视觉层级；全部通过 AA 对比、reduced-motion 与高对比变体
 * （高对比提升由 accessibility 层与 CSS 媒体查询保证，不靠主题自查）。
 * 色板来源：规范 §6 各主题基调定义 + §25 页面级设计推导。
 */
(function (root, factory) {
  const api = factory(root)
  if (typeof module !== 'undefined') module.exports = api
  else root.HDSIBuiltinThemes = api
})(typeof self !== 'undefined' ? self : globalThis, function (root) {
  'use strict'

  const OFFICIAL_META = { author: 'HDSI 官方', official: true, schemaVersion: 3 }

  const THEMES = [
    {
      ...OFFICIAL_META,
      id: 'hdsi-japanese-light', name: '白纸', displayName: '白纸 · Hakushi',
      description: '和纸米白、墨色标题、柿色重点。默认日常配置工作台。',
      tags: ['light', 'japanese', 'paper', 'default'], kind: 'light', colorScheme: 'light',
      defaultDensity: 'standard', motion: 'subtle',
      colors: {
        canvas: '#f5f1e8', surface: '#fbf9f4', surfaceRaised: '#ffffff', surfaceSunken: '#ebe6da',
        surfaceHover: '#eae3d3', surfaceActive: '#ddd3bf',
        border: '#d8d0c2', borderSoft: '#e4ddce', borderStrong: '#b9ad9c', borderDeep: '#cfc6b5',
        textPrimary: '#292722', textSecondary: '#625d54', textMuted: '#8c8579',
        textOnAccent: '#fbf9f4', textOnTrack: '#2d2a24',
        accent: '#b56a3c', accentBright: '#cf8352', accentFaint: '#ead5c5',
        success: '#547a53', successBg: '#e7ece3', successBorder: '#b9c9b5', successFg: '#476a46',
        warning: '#a06b2c', warningBg: '#f2e6d2', warningBorder: '#d3b98a', warningFg: '#8a5c24',
        danger: '#a44c4c', dangerBg: '#f0dfdd', dangerBorder: '#d3a5a3', dangerFg: '#8d3f3f',
        info: '#536f85', infoBg: '#e2e9ee', infoBorder: '#aebfcb', infoFg: '#47627a',
        trackScript: '#9a7fa8', trackScriptBright: '#b9a3c4',
        trackReceive: '#7d97ad', trackSend: '#c08259', trackMedia: '#7a9a8c',
        trackFacts: '#a3927b', trackAlter: '#b593a0', trackPreplan: '#a3925f', trackNeutral: '#a8a296',
        shadowSoft: 'rgba(41,39,34,.08)', shadowOverlay: 'rgba(41,39,34,.28)',
      },
    },
    {
      ...OFFICIAL_META,
      id: 'hdsi-sumi', name: '墨', displayName: '墨 · Sumi',
      description: '墨色纸面、银灰文字、少量朱砂。高密度时间线与长时间运行。',
      tags: ['dark', 'japanese', 'high-density', 'sumi'], kind: 'dark', colorScheme: 'dark',
      defaultDensity: 'compact', motion: 'subtle',
      colors: {
        canvas: '#202120', surface: '#292a28', surfaceRaised: '#333532', surfaceSunken: '#1a1b1a',
        surfaceHover: '#3a3c39', surfaceActive: '#4a4d49',
        border: '#464943', borderSoft: '#353734', borderStrong: '#5c5f59', borderDeep: '#141514',
        textPrimary: '#e9e7e0', textSecondary: '#b0aea6', textMuted: '#807e77',
        textOnAccent: '#1c1b1a', textOnTrack: '#161615',
        accent: '#c97952', accentBright: '#dd9268', accentFaint: '#3d2f27',
        success: '#7fa87c', successBg: '#26322a', successBorder: '#45604a', successFg: '#9cc39a',
        warning: '#c99a4e', warningBg: '#332b1e', warningBorder: '#6a5630', warningFg: '#e0b46e',
        danger: '#e0776d', dangerBg: '#372424', dangerBorder: '#7a4540', dangerFg: '#eb9a93',
        info: '#7ca6b8', infoBg: '#22303a', infoBorder: '#42586a', infoFg: '#9cc3d4',
        trackScript: '#b98fa8', trackScriptBright: '#d0a9bd',
        trackReceive: '#7d9ab5', trackSend: '#c9a27a', trackMedia: '#7d9a8f',
        trackFacts: '#9a92b0', trackAlter: '#ab8fae', trackPreplan: '#96865e', trackNeutral: '#9b9a95',
        shadowSoft: 'rgba(0,0,0,.4)', shadowOverlay: 'rgba(0,0,0,.62)',
      },
    },
    {
      ...OFFICIAL_META,
      id: 'hdsi-aizome', name: '蓝染', displayName: '蓝染 · Aizome',
      description: '深靛蓝底、雾蓝文字、暖米操作色。Studio、时间线与多分支管理。',
      tags: ['dark', 'japanese', 'indigo', 'workbench'], kind: 'dark', colorScheme: 'dark',
      defaultDensity: 'workbench', motion: 'subtle',
      colors: {
        canvas: '#1d2730', surface: '#25343f', surfaceRaised: '#2d4050', surfaceSunken: '#172028',
        surfaceHover: '#33475a', surfaceActive: '#40566b',
        border: '#3d5265', borderSoft: '#33434f', borderStrong: '#55708a', borderDeep: '#121a21',
        textPrimary: '#e7ecec', textSecondary: '#aebfc4', textMuted: '#7f929a',
        textOnAccent: '#1d2730', textOnTrack: '#131c23',
        accent: '#d7a66a', accentBright: '#e6bd82', accentFaint: '#3a3a2e',
        success: '#7cab8e', successBg: '#22352c', successBorder: '#3f6650', successFg: '#9cc9ac',
        warning: '#cfa763', warningBg: '#353023', warningBorder: '#6d5f3a', warningFg: '#e3c383',
        danger: '#d98577', dangerBg: '#3a2825', dangerBorder: '#72453e', dangerFg: '#eba294',
        info: '#83b7c7', infoBg: '#1f3441', infoBorder: '#3f6a80', infoFg: '#a3cddc',
        trackScript: '#9b8fc0', trackScriptBright: '#b5a9d4',
        trackReceive: '#83b7c7', trackSend: '#d7c19a', trackMedia: '#7fa893',
        trackFacts: '#8fa3b8', trackAlter: '#a78fae', trackPreplan: '#9a8a5f', trackNeutral: '#93a5ad',
        shadowSoft: 'rgba(9,16,22,.42)', shadowOverlay: 'rgba(9,16,22,.64)',
      },
    },
    {
      ...OFFICIAL_META,
      id: 'hdsi-matcha', name: '抹茶', displayName: '抹茶 · Matcha',
      description: '低饱和茶绿、竹灰、米黄。轻量工作、首次配置与阅读回顾。',
      tags: ['light', 'japanese', 'green', 'relaxed'], kind: 'light', colorScheme: 'light',
      defaultDensity: 'relaxed', motion: 'subtle',
      colors: {
        canvas: '#eef0e8', surface: '#f8f8f1', surfaceRaised: '#ffffff', surfaceSunken: '#e3e6d9',
        surfaceHover: '#e8ead9', surfaceActive: '#d9ddc9',
        border: '#cdd2bd', borderSoft: '#dadec9', borderStrong: '#aab394', borderDeep: '#c2c8ae',
        textPrimary: '#2d332d', textSecondary: '#5f685c', textMuted: '#87907f',
        textOnAccent: '#f8f8f1', textOnTrack: '#2a302a',
        accent: '#6e8056', accentBright: '#84996a', accentFaint: '#dfe5d2',
        success: '#55793f', successBg: '#e4ead9', successBorder: '#b3c29c', successFg: '#48693a',
        warning: '#99742f', warningBg: '#efe5d0', warningBorder: '#d0b988', warningFg: '#84612a',
        danger: '#a35248', dangerBg: '#f0e0da', dangerBorder: '#d1a49b', dangerFg: '#8c453d',
        info: '#5d7a8a', infoBg: '#e0e8ea', infoBorder: '#a9bec8', infoFg: '#4f6a79',
        trackScript: '#9d86a8', trackScriptBright: '#b7a2c1',
        trackReceive: '#7b95a6', trackSend: '#b98d5f', trackMedia: '#74988a',
        trackFacts: '#a09478', trackAlter: '#b095a0', trackPreplan: '#a08f5f', trackNeutral: '#a3a896',
        shadowSoft: 'rgba(45,51,45,.08)', shadowOverlay: 'rgba(45,51,45,.28)',
      },
    },
    {
      ...OFFICIAL_META,
      id: 'hdsi-akari', name: '灯', displayName: '灯 · Akari',
      description: '夜间室内光、暖灰纸面、琥珀操作色。演示与夜间阅读。',
      tags: ['dark', 'japanese', 'warm', 'night'], kind: 'dark', colorScheme: 'dark',
      defaultDensity: 'standard', motion: 'subtle',
      colors: {
        canvas: '#282522', surface: '#332e29', surfaceRaised: '#3d372f', surfaceSunken: '#201d1a',
        surfaceHover: '#463f36', surfaceActive: '#554c40',
        border: '#4a4237', borderSoft: '#3b352c', borderStrong: '#665b4a', borderDeep: '#171513',
        textPrimary: '#eee4d7', textSecondary: '#b8ab99', textMuted: '#8a7f70',
        textOnAccent: '#221e19', textOnTrack: '#191612',
        accent: '#d39a54', accentBright: '#e4b26e', accentFaint: '#40311f',
        success: '#94ac7a', successBg: '#2a3226', successBorder: '#4e6242', successFg: '#b1c99b',
        warning: '#cfa15f', warningBg: '#362d1f', warningBorder: '#6d5b36', warningFg: '#e3bd7d',
        danger: '#d97f6d', dangerBg: '#3a2823', dangerBorder: '#734437', dangerFg: '#eb9c8a',
        info: '#8aabb5', infoBg: '#26333a', infoBorder: '#48606b', infoFg: '#a6c5cf',
        trackScript: '#b398a5', trackScriptBright: '#ccb0bc',
        trackReceive: '#8ba3b5', trackSend: '#cfa87c', trackMedia: '#8aa392',
        trackFacts: '#a89a80', trackAlter: '#b597a2', trackPreplan: '#a38f62', trackNeutral: '#a39d92',
        shadowSoft: 'rgba(20,17,14,.4)', shadowOverlay: 'rgba(20,17,14,.62)',
      },
    },
  ]

  function byId(id) { return THEMES.find(theme => theme.id === id) }
  function list() { return THEMES }

  return { THEMES, byId, list }
})

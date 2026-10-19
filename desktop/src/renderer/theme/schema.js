/**
 * theme.json 的 JSON Schema（draft-07）。导出参考包把它写为包内
 * theme.schema.v3.json，theme.json 以相对路径 "$schema": "./theme.schema.v3.json"
 * 引用——作者解包后编辑器即可获得结构提示。约束与 pack-validator.js 同源；
 * schema 只描述结构，安装时的完整验证以验证器为准。
 */
(function (root, factory) {
  const api = factory(root)
  if (typeof module !== 'undefined') module.exports = api
  else root.HDSIThemeSchemaV3 = api
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict'

  const MOTION_PROPERTIES = ['opacity', 'transform', 'clip-path', 'filter', 'background-color', 'color', 'border-color', 'box-shadow']
  const MOTION_TRIGGERS = ['enter', 'exit', 'expand', 'collapse', 'switch', 'success', 'error']
  const INTERACTION_KINDS = ['page', 'panel', 'hudTimeline', 'wizard', 'mixer', 'themePreview']
  // 验证器按 /i 执行；JSON Schema pattern 不支持标志位，此处列小写形式。
  const EASING_PATTERN = '^(?:linear|ease(?:-in|-out|-in-out)?|step-(?:start|end)|steps\\(\\s*\\d+\\s*,\\s*(?:start|end)\\s*\\)|cubic-bezier\\(\\s*(?:-?\\d+(?:\\.\\d+)?)\\s*,\\s*(?:-?\\d+(?:\\.\\d+)?)\\s*,\\s*(?:-?\\d+(?:\\.\\d+)?)\\s*,\\s*(?:-?\\d+(?:\\.\\d+)?)\\s*\\))$'

  return {
    $schema: 'http://json-schema.org/draft-07/schema#',
    title: 'HDSI theme.json（theme-protocol 3.x）',
    type: 'object',
    required: ['id', 'version', 'name', 'tokens'],
    properties: {
      $schema: { type: 'string' },
      schemaVersion: { type: 'number', description: '当前为 3' },
      id: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{2,47}$', description: '社区主题不得使用 hdsi- 官方保留前缀' },
      version: { type: 'string', pattern: '^\\d+\\.\\d+\\.\\d+(?:[-+][\\w.-]+)?$', description: 'SemVer' },
      name: { type: 'string' },
      displayName: { type: 'string' },
      description: { type: 'string' },
      author: { type: 'object', properties: { name: { type: 'string' } } },
      license: { type: 'string' },
      tags: { type: 'array', items: { type: 'string' } },
      base: { type: 'string', description: '参考基础主题 id，仅作展示' },
      preview: { type: 'string', description: '包内 SVG 路径（默认 preview.svg）；须为纯静态 SVG，不超过 256KB' },
      density: { enum: ['compact', 'workbench', 'standard', 'relaxed'] },
      colorScheme: { enum: ['light', 'dark'] },
      compatibility: {
        type: 'object',
        properties: {
          minAppVersion: { type: 'string', description: '形如 0.0.1；比较忽略预发布后缀' },
          maxAppVersion: { type: 'string', description: '形如 0.1.0，或 "*" 表示不限' },
        },
      },
      tokens: {
        type: 'object',
        propertyNames: { pattern: '^([\\w-]+\\.)*[\\w-]+$' },
        additionalProperties: {
          anyOf: [
            { type: 'string' },
            { type: 'number' },
            { type: 'object', required: ['value'], properties: { value: { anyOf: [{ type: 'string' }, { type: 'number' }] } } },
          ],
        },
        description: '以 # 开头的值必须是 #rgb 或 #rrggbb；核心 token 名见作者指南（color.canvas、color.text.primary 等）',
      },
      aliases: { type: 'object', additionalProperties: { type: 'string' }, description: 'token 别名，不得成环' },
      surfaces: {
        type: 'object',
        additionalProperties: true,
        description: '区域背景声明；标准 key：shell/topbar/browser/inspector/timeline/canvas/detail/dialog。图片引用一律 asset://',
      },
      fonts: {
        type: 'object',
        propertyNames: { pattern: '^(?:ui|mono|[a-z][a-z0-9-]{0,31})$' },
        additionalProperties: { $ref: '#/definitions/fontSpec' },
      },
      motion: { $ref: '#/definitions/motion' },
      motionSpec: { $ref: '#/definitions/motion', description: '兼容字段；新包请使用 motion' },
      interactions: {
        type: 'object',
        propertyNames: { enum: INTERACTION_KINDS },
        additionalProperties: {
          type: 'object',
          propertyNames: { enum: MOTION_TRIGGERS },
          additionalProperties: { type: 'string', pattern: '^[a-z][a-z0-9-]{0,47}$' },
        },
        description: '宿主意图 → preset 绑定；意图与触发器均为固定枚举，preset 必须在 motion.presets 中声明',
      },
      overrides: {
        type: 'object',
        description: '带 pages/ 的 UI 包必须声明；overrides.pages 须逐一对应 pages/*.json 中的 page.id',
        properties: {
          tokens: { type: 'boolean' },
          variants: { type: 'boolean' },
          layout: { type: 'boolean' },
          shell: { type: 'boolean' },
          pages: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    definitions: {
      fontSpec: {
        type: 'object',
        required: ['src'],
        properties: {
          src: { type: 'string', pattern: '^asset://[A-Za-z0-9._/-]+\\.woff2?$', description: '只允许包内 WOFF/WOFF2' },
          weight: { anyOf: [{ type: 'integer', minimum: 100, maximum: 900 }, { type: 'string', pattern: '^(?:[1-9]00(?:\\s+[1-9]00)?|normal|bold|lighter|bolder)$' }] },
          style: { enum: ['normal', 'italic', 'oblique'] },
          display: { enum: ['auto', 'block', 'swap', 'fallback', 'optional'] },
        },
      },
      motion: {
        type: 'object',
        properties: {
          level: { enum: ['off', 'subtle', 'standard', 'expressive'], description: 'expressive 为兼容别名，运行时按 standard 生效' },
          defaultLevel: { enum: ['off', 'subtle', 'standard', 'expressive'] },
          presets: {
            type: 'object',
            propertyNames: { pattern: '^[a-z][a-z0-9-]{0,47}$' },
            additionalProperties: { $ref: '#/definitions/motionPreset' },
          },
        },
      },
      motionPreset: {
        type: 'object',
        properties: {
          from: { $ref: '#/definitions/motionFrame' },
          to: { $ref: '#/definitions/motionFrame' },
          properties: { type: 'array', minItems: 1, items: { enum: MOTION_PROPERTIES } },
          duration: { type: 'number', minimum: 0, maximum: 5000 },
          delay: { type: 'number', minimum: 0, maximum: 5000 },
          easing: { type: 'string', pattern: EASING_PATTERN },
          iterationCount: { anyOf: [{ type: 'integer', minimum: 1, maximum: 20 }, { enum: ['infinite'] }], description: 'infinite 会产生安装警告，请确认 reduced-motion 降级' },
        },
      },
      motionFrame: {
        type: 'object',
        propertyNames: { enum: MOTION_PROPERTIES },
        additionalProperties: { anyOf: [{ type: 'string' }, { type: 'number' }] },
        description: 'opacity 取值须为 0–1 的数字；字符串值不得携带注入内容（验证器另行拒绝分号、大括号与函数式引用）',
      },
    },
  }
})

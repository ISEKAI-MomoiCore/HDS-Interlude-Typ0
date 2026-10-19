import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import path from 'node:path'

/**
 * 第三方 Koishi 插件面板（Phase 1「看得见」）。
 *
 * 纯文本手术而非 js-yaml dump：canonical koishi.yml 的注释、`$secret:` 别名
 * 与字段顺序在往返中逐一保留（loader 自身的 dump 会丢注释，这里不做 dump）。
 *
 * 启停采用 Koishi loader 的官方约定：实例键加 `~` 前缀 = 停用（loader 跳过
 * `~`/`$` 前缀键；启用即去掉前缀）。已在 @koishijs/loader 4.6.11 源码核实
 * （shared.js:65/71/94-98/376）。
 */

export interface PluginPanelEntry {
  /** 实例键（含 ~ 前缀时的原样形态，写入时用于定位行）。 */
  rawKey: string
  /** 不含 ~ 前缀的实例键（展示与逻辑判断用）。 */
  key: string
  /** 所属分组（group:server → 'server'）；顶层插件为 null。 */
  group: string | null
  /** 解析出的插件名（hds-interlude / server / assets-local…）。 */
  packageName: string
  enabled: boolean
  /** 已安装版本；null = 在 desktop 运行时解析不到（worker 将无法加载）。 */
  installed: string | null
  /** 是否官方域候选（@koishijs/plugin-*）。 */
  official: boolean
  /** 静态冲突分级：adapter-/database- 与 HDSI 桥接/存储正面冲突。 */
  risk: 'high' | 'normal'
  /** 该插件块的 YAML 配置原文（不含键行；含缩进）。 */
  configText: string
  /** 1 基行号（键行），诊断用。 */
  lineStart: number
}

export interface PluginPanelRead {
  entries: PluginPanelEntry[]
  /** plugins: 段缺失或为空等提示。 */
  warnings: string[]
}

/** 宿主注入的分组键（config-compiler 会补齐的运行段）。 */
const HOST_GROUPS = new Set(['group:server', 'group:console', 'group:adapter', 'group:basic', 'group:storage', 'group:entry'])

const NAMESPACE_PLUGIN = /^koishi-plugin-/
const OFFICIAL_PLUGIN = /^@koishijs\/plugin-/

/** 插件名 → npm 包候选（与 cordis ns-require 的解析顺序一致：官方域优先）。 */
export function packageCandidates(pluginName: string): { official: boolean, packageName: string }[] {
  if (NAMESPACE_PLUGIN.test(pluginName) || OFFICIAL_PLUGIN.test(pluginName) || pluginName.startsWith('@') && pluginName.includes('/')) {
    return [{ official: OFFICIAL_PLUGIN.test(pluginName), packageName: pluginName }]
  }
  return [
    { official: true, packageName: `@koishijs/plugin-${pluginName}` },
    { official: false, packageName: `koishi-plugin-${pluginName}` },
  ]
}

export type InstallProbe = ((pluginName: string) => { version: string, official: boolean } | null) & { invalidate?: () => void }

/** 探测插件在宿主运行时的安装状态（带缓存）。
 * 搜索顺序：desktop/node_modules → plugins-runtime/node_modules（Phase 2
 * 安装目标地）。探测根由参数给出，便于测试注入。 */
export function createInstallProbe(...roots: string[]): InstallProbe {
  const cache = new Map<string, { version: string, official: boolean } | null>()
  const searchRoots = roots.filter(root => existsSync(path.join(root, 'package.json')))
  const requires = searchRoots.map(root => createRequire(path.join(root, 'package.json')))
  const probe = ((pluginName: string) => {
    if (cache.has(pluginName)) return cache.get(pluginName) ?? null
    let hit: { version: string, official: boolean } | null = null
    for (const require of requires) {
      for (const candidate of packageCandidates(pluginName)) {
        try {
          const manifest = require(`${candidate.packageName}/package.json`) as { version?: string }
          hit = { version: String(manifest.version || '?'), official: candidate.official }
          break
        } catch { /* 尝试下一个候选 */ }
      }
      if (hit) break
    }
    cache.set(pluginName, hit)
    return hit
  }) as InstallProbe
  probe.invalidate = () => {
    cache.clear()
    // Node 的 require 缓存一并失效——否则安装/卸载后仍读到旧 manifest。
    for (let i = 0; i < requires.length; i++) {
      const nodeModulesPrefix = path.join(searchRoots[i], 'node_modules') + path.sep
      for (const key of Object.keys(requires[i].cache)) {
        if (key.startsWith(nodeModulesPrefix)) delete requires[i].cache[key]
      }
    }
  }
  return probe
}

/** Phase 2：worker 崩溃归因——把退出前的日志尾与剧本已声明的插件名交叉匹配。
 * loader 的典型错误形态：`cannot resolve plugin "xxx"`、
 * `Cannot find module 'koishi-plugin-xxx'`。返回命中的插件名与证据行。 */
export function attributePluginFailure(logLines: string[], pluginNames: string[]): { packageName: string, evidence: string } | null {
  const names = [...new Set(pluginNames)].filter(Boolean)
  for (const line of logLines) {
    for (const name of names) {
      const candidates = packageCandidates(name).map(item => item.packageName)
      if (candidates.some(candidate => line.includes(candidate)) || (line.includes('cannot resolve plugin') && line.includes(`"${name}"`))) {
        return { packageName: name, evidence: line.trim().slice(0, 300) }
      }
    }
  }
  return null
}

export function classifyPluginRisk(packageName: string): 'high' | 'normal' {
  // 适配器与 HDSI 的 OneBot 桥接正面竞争（selfId/事件流）；数据库驱动与
  // minato 多驱动约束冲突。其余插件一律按普通风险对待（无静态阻断）。
  if (/^adapter[-_/.]/.test(packageName) || /^database[-_/.]/.test(packageName)) return 'high'
  return 'normal'
}

interface Block {
  rawKey: string
  indent: number
  keyLine: number       // 0 基
  bodyStart: number     // 0 基（含）
  bodyEnd: number       // 0 基（含，可为 -1 表示无配置体）
}

function indentOf(line: string) {
  const match = /^[ \t]*/.exec(line)
  return match ? match[0].length : 0
}

const KEY_SEGMENT = /^[A-Za-z0-9_@~./-]+/

/** 解析插件键行：键可含多个冒号段（group:server / adapter-onebot:m0）。
 * 规则：首个冒号后的段若紧跟再一个冒号或行尾 → 属于键；冒号后是空格/值 →
 * 键到此为止。返回 null 表示不是键行。 */
export function parseKeyLine(line: string): { indent: number, rawKey: string, rest: string } | null {
  const indentMatch = /^([ \t]*)/.exec(line)
  const indent = indentMatch ? indentMatch[1].length : 0
  const rest = line.slice(indent)
  const head = /^~?[^#\s:][^:\s]*/.exec(rest)
  if (!head) return null
  let rawKey = head[0]
  let tail = rest.slice(rawKey.length)
  while (true) {
    if (!tail.startsWith(':')) break
    const segment = KEY_SEGMENT.exec(tail.slice(1))
    if (!segment) break
    const after = tail.slice(1 + segment[0].length)
    // 段之后必须还是冒号或行尾——否则该冒号是"键: 值"的分隔符
    if (after !== '' && !after.startsWith(':')) break
    rawKey += ':' + segment[0]
    tail = after
  }
  if (!tail.startsWith(':')) return null
  return { indent, rawKey, rest: tail }
}

/** 扫描 plugins: 段的顶层块与 group: 容器内的子块。 */
function scanBlocks(source: string): { pluginsLine: number, baseIndent: number, top: Block[], childrenOf: Map<Block, Block[]> } | null {
  const lines = source.split(/\r?\n/)
  const pluginsLine = lines.findIndex(line => /^plugins:\s*(#.*)?$/.test(line))
  if (pluginsLine < 0) return null
  let baseIndent = -1
  for (let i = pluginsLine + 1; i < lines.length; i++) {
    const line = lines[i]
    if (!line.trim() || line.trimStart().startsWith('#')) continue
    const indent = indentOf(line)
    if (indent === 0) break
    baseIndent = indent
    break
  }
  if (baseIndent < 0) return null

  const keyAt = (index: number, indent: number): Block | null => {
    const line = lines[index]
    const parsed = parseKeyLine(line)
    if (!parsed || parsed.indent !== indent) return null
    const rawKey = parsed.rawKey
    let bodyEnd = -1
    for (let j = index + 1; j < lines.length; j++) {
      const next = lines[j]
      if (!next.trim()) { bodyEnd = j; continue }
      if (indentOf(next) <= indent) break
      bodyEnd = j
    }
    // 尾部空行不属于配置体
    while (bodyEnd > index && !lines[bodyEnd].trim()) bodyEnd -= 1
    return { rawKey, indent, keyLine: index, bodyStart: index + 1, bodyEnd }
  }

  const top: Block[] = []
  for (let i = pluginsLine + 1; i < lines.length; i++) {
    const line = lines[i]
    if (!line.trim() || line.trimStart().startsWith('#')) continue
    const indent = indentOf(line)
    if (indent === 0) break
    if (indent !== baseIndent) continue
    const block = keyAt(i, baseIndent)
    if (block) { top.push(block); i = block.bodyEnd > 0 ? block.bodyEnd : i }
  }

  const childrenOf = new Map<Block, Block[]>()
  for (const block of top) {
    if (!block.rawKey.replace(/^~/, '').startsWith('group:')) continue
    const childIndent = (() => {
      for (let j = block.bodyStart; j <= block.bodyEnd; j++) {
        if (lines[j].trim() && !lines[j].trimStart().startsWith('#')) return indentOf(lines[j])
      }
      return -1
    })()
    if (childIndent < 0) continue
    const children: Block[] = []
    for (let j = block.bodyStart; j <= block.bodyEnd; j++) {
      const line = lines[j]
      if (!line.trim() || line.trimStart().startsWith('#')) continue
      if (indentOf(line) !== childIndent) continue
      const child = keyAt(j, childIndent)
      if (child) { children.push(child); j = child.bodyEnd > 0 ? child.bodyEnd : j }
    }
    childrenOf.set(block, children)
  }
  return { pluginsLine, baseIndent, top, childrenOf }
}

/** 实例键 → 插件名：`hds-interlude:m0` → hds-interlude；`server` → server。 */
function pluginNameOf(rawKey: string): string {
  const key = rawKey.replace(/^~/, '')
  const parts = key.split(':')
  if (parts.length >= 2) return parts[parts.length - 2]
  return key
}

function groupLabelOf(rawKey: string): string | null {
  const key = rawKey.replace(/^~/, '')
  if (!key.startsWith('group:')) return null
  const parts = key.split(':')
  return parts.length >= 2 ? parts[1] : key
}

/** 读取插件面板清单（纯函数；probe 由调用方注入便于测试）。 */
export function readPluginPanel(source: string, probe: (pluginName: string) => { version: string, official: boolean } | null): PluginPanelRead {
  const scan = scanBlocks(source)
  if (!scan) return { entries: [], warnings: ['koishi.yml 缺少 plugins: 段——先在 YAML 标签页补一个空的 plugins: 行。'] }
  const lines = source.split(/\r?\n/)
  const entries: PluginPanelEntry[] = []
  const warnings: string[] = []
  const configBody = (block: Block) => block.bodyEnd < block.bodyStart
    ? ''
    : lines.slice(block.bodyStart, block.bodyEnd + 1).join('\n').replace(/\s+$/, '')

  const pushEntry = (block: Block, group: string | null) => {
    if (group === null && groupLabelOf(block.rawKey) !== null) return // 顶层 group 容器本身不列为插件
    const packageName = pluginNameOf(block.rawKey)
    const installed = probe(packageName)
    entries.push({
      rawKey: block.rawKey,
      key: block.rawKey.replace(/^~/, ''),
      group,
      packageName,
      enabled: !block.rawKey.startsWith('~'),
      installed: installed?.version ?? null,
      official: installed?.official ?? packageCandidates(packageName)[0].official,
      risk: classifyPluginRisk(packageName),
      configText: configBody(block),
      lineStart: block.keyLine + 1,
    })
  }

  for (const block of scan.top) {
    if (groupLabelOf(block.rawKey) !== null) {
      const children = scan.childrenOf.get(block) ?? []
      if (block.rawKey.startsWith('~')) warnings.push(`分组 ${block.rawKey} 整组被停用（~ 前缀），组内 ${children.length} 个插件不会加载。`)
      for (const child of children) pushEntry(child, groupLabelOf(child.rawKey) ? null : groupLabelOf(block.rawKey))
    } else {
      pushEntry(block, null)
    }
  }
  if (!entries.length) warnings.push('plugins: 段为空。')
  return { entries, warnings }
}

/** 找到键行（rawKey 精确匹配优先；同键不同 ~ 形态兜底）。 */
function findKeyLine(source: string, rawKey: string): { line: number, indent: number } | null {
  const lines = source.split(/\r?\n/)
  const key = rawKey.replace(/^~/, '')
  let fallback: { line: number, indent: number } | null = null
  for (let i = 0; i < lines.length; i++) {
    const parsed = parseKeyLine(lines[i])
    if (!parsed) continue
    if (parsed.rawKey.replace(/^~/, '') !== key) continue
    if (parsed.rawKey === rawKey) return { line: i, indent: parsed.indent }
    // 同名键可能出现在多个层级（如 group 内与顶层）——精确原样匹配优先
    fallback ??= { line: i, indent: parsed.indent }
  }
  return fallback
}

/** 启停切换：实例键行加/去 `~` 前缀（Koishi loader 官方停用约定）。 */
export function togglePlugin(source: string, rawKey: string, enable: boolean): string {
  const lines = source.split(/\r?\n/)
  const target = findKeyLine(source, rawKey)
  if (!target) throw new Error(`未找到插件键：${rawKey}`)
  const parsed = parseKeyLine(lines[target.line])
  if (!parsed) throw new Error(`插件键行无法解析：${lines[target.line]}`)
  const currentTilde = parsed.rawKey.startsWith('~')
  const wantTilde = !enable
  if (currentTilde === wantTilde) return source
  const keyBody = parsed.rawKey.replace(/^~/, '')
  lines[target.line] = ' '.repeat(target.indent) + (wantTilde ? '~' : '') + keyBody + parsed.rest
  return lines.join('\n')
}

/** 替换插件配置体（fragment 为 YAML 原文，保留用户缩进；空串 = 清空配置）。 */
export function writePluginConfig(source: string, rawKey: string, fragment: string): string {
  const lines = source.split(/\r?\n/)
  const target = findKeyLine(source, rawKey)
  if (!target) throw new Error(`未找到插件键：${rawKey}`)
  let bodyEnd = -1
  // 复用块尾判定：从键行向下扫到缩进 <= 键缩进的非空行
  for (let j = target.line + 1; j < lines.length; j++) {
    if (!lines[j].trim()) { bodyEnd = j; continue }
    if (indentOf(lines[j]) <= target.indent) break
    bodyEnd = j
  }
  while (bodyEnd > target.line && !lines[bodyEnd].trim()) bodyEnd -= 1
  const fragmentLines = fragment ? fragment.replace(/\s+$/, '').split('\n') : []
  // 配置体每行必须比键行更深缩进，否则会破坏 YAML 结构
  for (const line of fragmentLines) {
    if (line.trim() && indentOf(line) <= target.indent) throw new Error('配置片段缩进必须深于插件键行（建议 4 空格起步）。')
  }
  const next = [...lines.slice(0, target.line + 1), ...fragmentLines, ...lines.slice(bodyEnd + 1)]
  return next.join('\n')
}

/** 在 plugins: 段末尾追加一个新插件（默认启用、空配置）。 */
export function appendPlugin(source: string, packageName: string, instanceSuffix = ''): string {
  if (!/^@?[A-Za-z0-9._/-]+$/.test(packageName)) throw new Error(`非法插件名：${packageName}`)
  const scan = scanBlocks(source)
  if (!scan) {
    // 无 plugins: 段——文件末尾补一段
    return `${source.trimEnd()}\nplugins:\n  ${packageName}${instanceSuffix ? ':' + instanceSuffix : ''}:\n`
  }
  const lines = source.split(/\r?\n/)
  const indent = ' '.repeat(scan.baseIndent)
  // 插入点 = plugins 段最后一个顶层块的块尾之后
  let last = scan.pluginsLine
  for (const block of scan.top) last = Math.max(last, block.bodyEnd > 0 ? block.bodyEnd : block.keyLine)
  const key = `${packageName}${instanceSuffix ? ':' + instanceSuffix : ''}`
  const next = [...lines.slice(0, last + 1), `${indent}${key}:`, ...lines.slice(last + 1)]
  return next.join('\n')
}

/** 删除插件块（键行 + 配置体）。 */
export function removePlugin(source: string, rawKey: string): string {
  const lines = source.split(/\r?\n/)
  const target = findKeyLine(source, rawKey)
  if (!target) throw new Error(`未找到插件键：${rawKey}`)
  let bodyEnd = target.line
  for (let j = target.line + 1; j < lines.length; j++) {
    if (!lines[j].trim()) { bodyEnd = j; continue }
    if (indentOf(lines[j]) <= target.indent) break
    bodyEnd = j
  }
  while (bodyEnd > target.line && !lines[bodyEnd].trim()) bodyEnd -= 1
  return [...lines.slice(0, target.line), ...lines.slice(bodyEnd + 1)].join('\n')
}

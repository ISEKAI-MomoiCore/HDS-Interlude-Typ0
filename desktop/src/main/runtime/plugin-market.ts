import { createRequire } from 'node:module'
import path from 'node:path'
import { validatePluginPackageName } from './plugin-installer'

/**
 * Phase 3「用得顺」：插件市场浏览（数据源 registry.npmmirror.com 的 npm search
 * API + 单包元数据）。只做浏览与兼容性标注；安装动作一律走 Phase 2 受控
 * 安装器（--ignore-scripts / --legacy-peer-deps），不引入官方 plugin-market
 * （其安装流会写 worker 临时工程的 package.json，与 typ0 的受控运行时冲突）。
 */

const SEARCH_ENDPOINT = 'https://registry.npmmirror.com/-/v1/search'
const REGISTRY_ENDPOINT = 'https://registry.npmmirror.com'
const FETCH_TIMEOUT_MS = 15_000

export interface MarketEntry {
  packageName: string
  /** yml 里使用的插件名（koishi-plugin-foo → foo；@scope 保持 @scope/foo）。 */
  pluginName: string
  version: string
  description: string
  date: string
  publisher: string
}

export interface MarketDetail extends MarketEntry {
  compat: 'ok' | 'mismatch' | 'undeclared'
  /** compat=mismatch 时的要求范围原文。 */
  peerRange?: string
}

/** 包名 → yml 插件名（loader ns-require 的反向映射）。 */
export function pluginNameFromPackage(packageName: string): string {
  if (packageName.startsWith('@koishijs/plugin-')) return packageName.slice('@koishijs/plugin-'.length)
  if (packageName.startsWith('@')) {
    const slash = packageName.indexOf('/')
    const scope = packageName.slice(0, slash + 1)
    const rest = packageName.slice(slash + 1)
    return scope + (rest.startsWith('koishi-plugin-') ? rest.slice('koishi-plugin-'.length) : rest)
  }
  return packageName.replace(/^koishi-plugin-/, '')
}

// ── 兼容性判定（只覆盖 npm range 语法的常见子集：^ ~ >= > < <= = 精确、
// 空格 AND、|| OR、* 任意。复杂写法返回 undeclared 交由用户判断）──

function compareVersions(left: string, right: string): number {
  const parse = (value: string) => value.split('.').map(part => Number(part.replace(/[^0-9].*$/, '')) || 0)
  const [a, b] = [parse(left), parse(right)]
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0) ? 1 : -1
  }
  return 0
}

function satisfiesSingle(condition: string, current: string): boolean | null {
  const match = /^(>=|<=|>|<|\^|~|=)?\s*v?([0-9][0-9.]*)/.exec(condition.trim())
  if (!match) return condition.trim() === '*' || condition.trim() === '' ? true : null
  const operator = match[1] ?? '='
  const target = match[2].replace(/\.$/, '')
  const order = compareVersions(current, target)
  switch (operator) {
    case '=': return order === 0
    case '>': return order > 0
    case '>=': return order >= 0
    case '<': return order < 0
    case '<=': return order <= 0
    case '^': {
      if (order < 0) return false
      const [major, minor] = target.split('.').map(Number)
      const [currentMajor, currentMinor] = current.split('.').map(Number)
      // npm 语义：^0.x.y 锁定 minor（0.4.2 不含 0.5.0）；≥1 才放开 minor。
      if (major === 0) return currentMajor === 0 && currentMinor === (minor ?? 0)
      return currentMajor === major
    }
    case '~': {
      if (order < 0) return false
      const parts = target.split('.').map(Number)
      const currentParts = current.split('.').map(Number)
      return currentParts[0] === parts[0] && currentParts[1] === (parts[1] ?? 0)
    }
    default: return null
  }
}

/** current 是否满足 npm range（常见子集）；无法解析返回 null。 */
export function satisfiesRange(range: string, current: string): boolean | null {
  const trimmed = range.trim()
  if (!trimmed || trimmed === '*') return true
  let anyParsed = false
  for (const alternative of trimmed.split('||')) {
    const parts = alternative.trim().split(/\s+/).filter(Boolean)
    let ok = true
    let parsed = false
    for (const part of parts) {
      const result = satisfiesSingle(part, current)
      if (result === null) { parsed = false; break }
      parsed = true
      if (!result) { ok = false }
    }
    if (parsed && parts.length) { anyParsed = true; if (ok) return true }
  }
  return anyParsed ? false : null
}

/** koishi peer 声明 → 兼容结论。 */
export function koishiPeerCompat(peerDependencies: Record<string, string> | undefined, currentKoishi: string): MarketDetail['compat'] {
  const range = peerDependencies?.koishi
  if (!range) return 'undeclared'
  const result = satisfiesRange(range, currentKoishi)
  if (result === null) return 'undeclared'
  return result ? 'ok' : 'mismatch'
}

async function fetchJson(url: string): Promise<unknown> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { Accept: 'application/json' } })
    if (!response.ok) throw new Error(`HTTP ${response.status}：${url}`)
    return await response.json()
  } finally { clearTimeout(timer) }
}

/** 市场搜索：npmmirror npm search API，过滤为合法 Koishi 插件包名。
 * 短查询（如 "points"）按相关度会被通用 npm 包挤窗口——发起原始查询 +
 * "koishi-plugin 前缀"两组（或三组）查询后按名称去重合并。 */
export async function searchMarket(query: string, limit = 30): Promise<MarketEntry[]> {
  // P2 输入边界：查询长度上限——超长串只会生成畸形 registry URL，提前截断。
  const text = String(query || '').trim().slice(0, 200)
  if (!text) return []
  const queries = text.includes('koishi-plugin')
    ? [text]
    : [text, `koishi-plugin ${text}`]
  const seen = new Set<string>()
  const entries: MarketEntry[] = []
  for (const q of queries) {
    if (entries.length >= limit) break
    const url = `${SEARCH_ENDPOINT}?size=${Math.min(limit * 2, 100)}&text=${encodeURIComponent(q)}`
    const payload = await fetchJson(url) as { objects?: Array<{ package?: { name?: string, version?: string, description?: string, date?: string, publisher?: { username?: string } } }> }
    for (const object of payload.objects ?? []) {
      const pkg = object.package ?? {}
      const name = String(pkg.name || '')
      if (seen.has(name)) continue
      try { validatePluginPackageName(name) } catch { continue }
      seen.add(name)
      entries.push({
        packageName: name,
        pluginName: pluginNameFromPackage(name),
        version: String(pkg.version || '?'),
        description: String(pkg.description || '').slice(0, 160),
        date: String(pkg.date || ''),
        publisher: String(pkg.publisher?.username || ''),
      })
      if (entries.length >= limit) break
    }
  }
  return entries
}

/** 单包详情：完整 manifest → peer 兼容性结论。 */
export async function marketDetail(packageName: string, currentKoishi: string): Promise<MarketDetail> {
  const name = validatePluginPackageName(packageName)
  const manifest = await fetchJson(`${REGISTRY_ENDPOINT}/${name}/latest`) as {
    name?: string, version?: string, description?: string,
    peerDependencies?: Record<string, string>, maintainers?: Array<{ username?: string }>,
  }
  return {
    packageName: name,
    pluginName: pluginNameFromPackage(name),
    version: String(manifest.version || '?'),
    description: String(manifest.description || '').slice(0, 300),
    date: '',
    publisher: String(manifest.maintainers?.[0]?.username || ''),
    compat: koishiPeerCompat(manifest.peerDependencies, currentKoishi),
    peerRange: manifest.peerDependencies?.koishi,
  }
}

/** 当前宿主 koishi 版本（desktop/node_modules，带缓存）。 */
export function readHostKoishiVersion(appRoot: string): string {
  const require = createRequire(path.join(appRoot, 'package.json'))
  try {
    return String((require('koishi/package.json') as { version?: string }).version || '')
  } catch { return '' }
}

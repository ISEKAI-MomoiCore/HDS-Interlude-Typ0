/**
 * D4-2：Console 配置捕获。Koishi Console 在 worker 里保存插件配置时，loader
 * 写的是 KOISHI_CONFIG_FILE——typ-0 的 resolved 临时文件：密钥已被解析成明文、
 * 实例键带随机后缀、宿主注入段混杂其中，worker 一退出即丢。此模块把其中
 * hds-interlude 的配置段捕获回 canonical koishi.yml：
 *
 *  1. 解析 resolved（js-yaml），收集所有 `hds-interlude:*` 实例（后缀随机）；
 *  2. 反向脱敏——providers 的密钥值与 SecretStore 别名值全等的，替换回
 *     `$secret:别名`（写回 canonical 的值永不落明文）；
 *  3. 与 canonical 现段做 deep-equal 比较，无实质变更不写（避免 watch 风暴
 *     与无谓备份）；
 *  4. 输出替换后的 canonical 文本由 ConfigMediator 保存（其自带备份与别名校验）。
 *
 * 宿主运行参数（adapter-onebot 的 selfId/endpoint、server/console 注入段）
 * 绝不经此路径回写——它们属于账号绑定事务，Console 不该碰。
 */
import yaml from 'js-yaml'

export type CaptureSecretIndex = Array<{ alias: string, value: string }>

export interface CaptureResult {
  changed: boolean
  /** 替换 hds-interlude 段后的完整 canonical 文本；changed=false 时为 undefined。 */
  canonical?: string
  /** 捕获到的实例数（正常为 1）。 */
  instances: number
  /** 脱敏替换计数。 */
  redactions: number
  error?: string
}

/** 宿主注入的运行段（config-compiler 补齐）：canonical 没有时视为注入产物，
 * 捕获时整段跳过——它们是账号绑定事务与 loopback Console，不该经 Console 回写。 */
const HOST_INJECTED_GROUPS = new Set(['group:server', 'group:console', 'group:adapter', 'group:basic', 'group:storage', 'group:entry'])
/** adapter-onebot 的宿主运行参数（M7-2）：canonical 自带 adapter 块时，捕获
 * 该块但剥掉这三个键——它们由账号登记/绑定事务维护，Console 不碰。 */
const HOST_RUNTIME_FIELDS = ['selfId', 'endpoint', 'token']

function stripHostRuntimeFields(value: unknown): [unknown, boolean] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [value, false]
  const out = { ...(value as Record<string, unknown>) }
  let stripped = false
  for (const field of HOST_RUNTIME_FIELDS) {
    if (field in out) { delete out[field]; stripped = true }
  }
  return [stripped ? out : value, stripped]
}

/** canonical 侧自带的运行参数字段值原样回填到捕获值——既保住 canonical 的
 * 占位值（如 selfId: ""），又避免 "有键空串 vs 无键" 每轮触发伪变更。 */
function restoreHostRuntimeFields(canonicalValue: unknown, capturedValue: unknown): unknown {
  if (!canonicalValue || typeof canonicalValue !== 'object' || Array.isArray(canonicalValue)) return capturedValue
  if (!capturedValue || typeof capturedValue !== 'object' || Array.isArray(capturedValue)) return capturedValue
  const out = { ...(capturedValue as Record<string, unknown>) }
  const source = canonicalValue as Record<string, unknown>
  for (const field of HOST_RUNTIME_FIELDS) if (field in source) out[field] = source[field]
  return out
}

/** 捕获单个 adapter-onebot 实例：剥宿主参数 + 实例键归一 + canonical 值回填。 */
function captureAdapterInstance(value: unknown, canonicalOwner: Record<string, unknown>, canonicalKey: string | undefined, resolvedKey: string): [string, unknown] {
  const [stripped] = stripHostRuntimeFields(value)
  const targetKey = canonicalKey && canonicalKey !== resolvedKey ? canonicalKey : resolvedKey
  const restored = restoreHostRuntimeFields(canonicalKey ? (canonicalOwner as any)[canonicalKey] : undefined, stripped)
  return [targetKey, restored]
}

/** Phase 1 插件兼容：捕获范围从"仅 hds-interlude"扩展到全部 plugins 键。
 * - canonical 缺失的宿主注入分组 → 跳过（保持 D4-2 语义反转）；
 * - adapter-onebot 实例 → 剥离宿主运行参数，且实例键归一到 canonical 既有
 *   adapter 键（Console 在 resolved 里可能生成随机后缀实例——照抄会写出
 *   重复的 adapter 块，下一次编译注入就会错位）；
 * - 其余任何插件（含第三方）→ 整块捕获回写（Console 内的配置编辑不再丢失）。
 * canonical 独有的键（~ 停用项、注入段）不经此路径，天然保留。 */
function collectCapturablePlugins(resolved: any, canonicalPlugins: Record<string, unknown>): Record<string, unknown> {
  const canonicalAdapterKey = Object.keys(canonicalPlugins).find(key => /^~?adapter-onebot:[A-Za-z0-9_-]+$/.test(key))
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(resolved?.plugins ?? {})) {
    if (HOST_INJECTED_GROUPS.has(key) && !(key in canonicalPlugins)) continue
    if (/^~?adapter-onebot:/.test(key)) {
      const [targetKey, restored] = captureAdapterInstance(value, canonicalPlugins, canonicalAdapterKey, key)
      out[targetKey] = restored
      continue
    }
    if (key.startsWith('group:')) {
      const canonicalChildren = (canonicalPlugins[key] && typeof canonicalPlugins[key] === 'object' ? canonicalPlugins[key] : {}) as Record<string, unknown>
      const canonicalAdapterChild = Object.keys(canonicalChildren).find(child => /^~?adapter-onebot:[A-Za-z0-9_-]+$/.test(child))
      const children: Record<string, unknown> = {}
      const sourceChildren = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
      for (const [childKey, childValue] of Object.entries(sourceChildren)) {
        if (/^~?adapter-onebot:/.test(childKey)) {
          const [targetKey, restored] = captureAdapterInstance(childValue, canonicalChildren, canonicalAdapterChild, childKey)
          children[targetKey] = restored
          continue
        }
        children[childKey] = childValue
      }
      out[key] = children
      continue
    }
    out[key] = value
  }
  return out
}

/** 值与已知密钥全等时替换为 $secret:别名；返回 [新值, 替换计数]。 */
function redact(value: unknown, secrets: CaptureSecretIndex): [unknown, number] {
  if (typeof value === 'string') {
    const hit = secrets.find(entry => entry.value === value && entry.value.length > 0)
    if (hit) return [`$secret:${hit.alias}`, 1]
    return [value, 0]
  }
  if (Array.isArray(value)) {
    let replaced = 0
    const out = value.map(item => {
      const [next, hit] = redact(item, secrets)
      replaced += hit
      return next
    })
    return [out, replaced]
  }
  if (value && typeof value === 'object') {
    let replaced = 0
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const [next, hit] = redact(item, secrets)
      replaced += hit
      out[key] = next
    }
    return [out, replaced]
  }
  return [value, 0]
}

export function deepEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((item, index) => deepEqual(item, right[index]))
  }
  if (left && right && typeof left === 'object' && typeof right === 'object') {
    const lk = Object.keys(left as object), rk = Object.keys(right as object)
    return lk.length === rk.length && lk.every(key => deepEqual((left as any)[key], (right as any)[key]))
  }
  return false
}

export function captureConsoleConfig(resolvedText: string, canonicalText: string, secrets: CaptureSecretIndex): CaptureResult {
  try {
    const resolvedDoc = yaml.load(resolvedText)
    const canonicalDoc = yaml.load(canonicalText)
    const canonicalPlugins = (canonicalDoc as any)?.plugins
    if (!canonicalPlugins || typeof canonicalPlugins !== 'object') {
      return { changed: false, instances: 0, redactions: 0, error: 'canonical 缺少 plugins 段，放弃捕获。' }
    }
    // Phase 1：捕获全部插件键（排除宿主注入段/运行参数），逐键与 canonical
    // deep-equal 比对，无实质变更不写（避免 watch 风暴与无谓备份）。
    const captured = collectCapturablePlugins(resolvedDoc as any, canonicalPlugins as Record<string, unknown>)
    const keys = Object.keys(captured)
    if (!keys.length) return { changed: false, instances: 0, redactions: 0 }
    let redactions = 0
    let changed = false
    // hdsi 实例键归一（resolved 随机后缀 → canonical 既有键）必须在比较前完成，
    // 否则 canonical[resolved键] 恒为 undefined → 每轮伪变更。
    const existingHdsiKey = Object.keys(canonicalPlugins).find(k => /^hds-interlude:[A-Za-z0-9_-]+$/.test(k))
    for (const rawKey of keys) {
      const [redacted, hits] = redact(captured[rawKey], secrets)
      redactions += hits
      const targetKey = /^hds-interlude:[A-Za-z0-9_-]+$/.test(rawKey) ? (existingHdsiKey ?? rawKey) : rawKey
      if (deepEqual((canonicalPlugins as any)[targetKey], redacted)) continue
      ;(canonicalPlugins as any)[targetKey] = redacted
      changed = true
    }
    if (!changed) return { changed: false, instances: keys.length, redactions }
    const nextCanonical = yaml.dump(canonicalDoc, { lineWidth: 160, noRefs: true })
    return { changed: true, canonical: nextCanonical, instances: keys.length, redactions }
  } catch (error) {
    return { changed: false, instances: 0, redactions: 0, error: String(error) }
  }
}

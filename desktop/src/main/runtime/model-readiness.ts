import yaml from 'js-yaml'
import { SecretStore } from './secrets'
import { FirstRunErrorCode, FIRST_RUN_ERROR_CODES } from './first-run-readiness'

const SECRET_REFERENCE = /\$secret:([A-Za-z0-9][A-Za-z0-9_.-]{0,127})/g
const OFFICIAL_MODES = new Set([
  'zhipu-official', 'openai-official', 'deepseek-official', 'moonshot-official',
  'dashscope-official', 'siliconflow-official', 'openrouter', 'gemini-openai', 'gemini-interactions',
])

type RecordLike = Record<string, unknown>
type SecretReason = 'missing' | 'undecryptable' | 'unavailable' | 'ok'

export interface SecretReferenceInspection {
  referenced: string[]
  reasons: Map<string, SecretReason>
  missing: string[]
  undecryptable: string[]
  unavailable: string[]
}

export interface ModelReadiness {
  status: 'ok' | 'warn' | 'err'
  detail: string
  providerCount: number
  candidateCount: number
  usableCount: number
  referencedAliases: string[]
  code?: FirstRunErrorCode
}

function isRecord(value: unknown): value is RecordLike {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function text(value: unknown) {
  return typeof value === 'string' ? value.trim() : ''
}

function secretAlias(value: unknown) {
  const match = /^\$secret:([A-Za-z0-9][A-Za-z0-9_.-]{0,127})$/.exec(text(value))
  return match?.[1]
}

function findHdsiConfig(document: unknown): RecordLike | undefined {
  const plugins = isRecord(document) && isRecord(document.plugins) ? document.plugins : undefined
  if (!plugins) return undefined
  const key = Object.keys(plugins).find(item => /^hds-interlude:/.test(item))
  return key && isRecord(plugins[key]) ? plugins[key] : undefined
}

export function inspectSecretReferences(source: string, secrets: SecretStore): SecretReferenceInspection {
  const referenced = [...new Set([...source.matchAll(SECRET_REFERENCE)].map(match => match[1]))].sort()
  const reasons = new Map<string, SecretReason>()
  for (const alias of referenced) {
    const result = secrets.tryGet(alias)
    reasons.set(alias, result.ok ? 'ok' : result.reason)
  }
  return {
    referenced,
    reasons,
    missing: referenced.filter(alias => reasons.get(alias) === 'missing'),
    undecryptable: referenced.filter(alias => reasons.get(alias) === 'undecryptable'),
    unavailable: referenced.filter(alias => reasons.get(alias) === 'unavailable'),
  }
}

function providerHasChatAssignment(provider: RecordLike) {
  return provider.useForMain === true || provider.useForCompaction === true || provider.useForAlter === true
}

function providerKey(provider: RecordLike) {
  return text(provider.id) || `${text(provider.label)}:${text(provider.model)}:${text(provider.endpoint)}`
}

function selectedProviderIds(model: RecordLike, providers: RecordLike[]) {
  const selected = text(model.mainModelId)
  const profiles = Array.isArray(model.models) ? model.models.filter(isRecord) : []
  const profile = selected
    ? profiles.find(item => text(item.id) === selected)
    : profiles.length === 1 ? profiles[0] : undefined
  const providerId = profile ? text(profile.providerId) : ''
  if (!providerId) return new Set<string>()
  return new Set(providers.filter(item => providerKey(item) === providerId || text(item.id) === providerId).map(providerKey))
}

function isPotentialMainProvider(provider: RecordLike, selectedIds: Set<string>) {
  if (provider.enabled === false) return false
  if (provider.useForMain === true) return true
  if (selectedIds.has(providerKey(provider))) return true
  // Match HDSI's resolveRoute fallback: legacy providers may omit useForMain,
  // and an explicitly false main flag is still usable unless the provider is
  // exclusively assigned to non-chat tasks.
  return providerHasChatAssignment(provider) || (
    provider.useForEmbedding !== true && provider.useForStickers !== true && provider.useForVision !== true
  )
}

function fieldState(value: unknown, secrets: SecretReferenceInspection) {
  const alias = secretAlias(value)
  if (alias) {
    const reason = secrets.reasons.get(alias) ?? 'missing'
    return { present: reason === 'ok', alias, reason }
  }
  return { present: !!text(value), alias: undefined, reason: undefined }
}

/**
 * Checks the canonical HDSI provider configuration without contacting a model
 * service. This deliberately answers "is the configuration runnable?", not
 * "will the provider accept a real request?".
 */
export function inspectModelReadiness(source: string, secrets: SecretReferenceInspection): ModelReadiness {
  let document: unknown
  try {
    document = yaml.load(source)
  } catch (error) {
    return { status: 'err', detail: `配置 YAML 无法解析：${String(error)}`, providerCount: 0, candidateCount: 0, usableCount: 0, referencedAliases: secrets.referenced, code: FIRST_RUN_ERROR_CODES.MODEL_CONFIG_INVALID }
  }
  const hdsi = findHdsiConfig(document)
  const model = hdsi && isRecord(hdsi.model) ? hdsi.model : undefined
  const providers = model && Array.isArray(model.providers) ? model.providers.filter(isRecord) : []
  if (!providers.length) {
    return { status: 'err', detail: '未配置模型提供商。请先添加一个用于主叙事的模型连接。', providerCount: 0, candidateCount: 0, usableCount: 0, referencedAliases: secrets.referenced, code: FIRST_RUN_ERROR_CODES.MODEL_NOT_CONFIGURED }
  }

  const selectedIds = model ? selectedProviderIds(model, providers) : new Set<string>()
  const candidates = providers.filter(provider => isPotentialMainProvider(provider, selectedIds))
  if (!candidates.length) {
    return { status: 'err', detail: '没有启用用于主叙事的模型提供商。请在模型配置中启用“用于主叙事”。', providerCount: providers.length, candidateCount: 0, usableCount: 0, referencedAliases: secrets.referenced, code: FIRST_RUN_ERROR_CODES.MODEL_NOT_ASSIGNED }
  }

  const unusable: string[] = []
  let warningCount = 0
  let usableCount = 0
  for (const provider of candidates) {
    const label = text(provider.label) || text(provider.id) || '未命名连接'
    const mode = text(provider.mode)
    const endpoint = fieldState(provider.endpoint, secrets)
    const modelName = fieldState(provider.model, secrets)
    const apiKey = fieldState(provider.apiKey, secrets)
    const missing: string[] = []
    if (!endpoint.present && !OFFICIAL_MODES.has(mode)) missing.push('endpoint')
    if (!modelName.present) missing.push('model')
    if (!apiKey.present) {
      if (apiKey.alias) missing.push(`${apiKey.alias}（API Key）`)
      else warningCount += 1
    }
    if (missing.length) unusable.push(`${label}：缺少 ${missing.join('、')}`)
    else {
      usableCount += 1
      if (!apiKey.present) warningCount += 1
    }
  }

  if (!usableCount) {
    const code = candidates.some(provider => {
      const endpoint = fieldState(provider.endpoint, secrets)
      return !endpoint.present && !OFFICIAL_MODES.has(text(provider.mode))
    })
      ? FIRST_RUN_ERROR_CODES.MODEL_ENDPOINT_INVALID
      : candidates.some(provider => !fieldState(provider.apiKey, secrets).present || !fieldState(provider.model, secrets).present)
        ? FIRST_RUN_ERROR_CODES.MODEL_SECRET_MISSING
        : FIRST_RUN_ERROR_CODES.MODEL_NOT_CONFIGURED
    return {
      status: 'err',
      detail: `主叙事模型配置不完整：${unusable.join('；')}`,
      providerCount: providers.length,
      candidateCount: candidates.length,
      usableCount,
      referencedAliases: secrets.referenced,
      code,
    }
  }
  if (warningCount) {
    return {
      status: 'warn',
      detail: `模型连接已配置，但有 ${warningCount} 个连接未填写 API Key；如果服务商需要鉴权，实际调用可能失败。`,
      providerCount: providers.length,
      candidateCount: candidates.length,
      usableCount,
      referencedAliases: secrets.referenced,
    }
  }
  return {
    status: 'ok',
    detail: `已配置 ${usableCount} 个可用于主叙事的模型连接。`,
    providerCount: providers.length,
    candidateCount: candidates.length,
    usableCount,
    referencedAliases: secrets.referenced,
  }
}

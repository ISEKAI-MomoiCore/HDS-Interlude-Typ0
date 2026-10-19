/**
 * Stable first-run readiness contract shared by Main and Renderer.
 *
 * The Main process is the source of truth. Renderer code may translate these
 * fields into visual labels, but must not infer operational state from logs or
 * from the presence of a config field.
 */

export const FIRST_RUN_ERROR_CODES = {
  MODEL_SECRET_MISSING: 'MODEL_SECRET_MISSING',
  MODEL_SECRET_UNDECRYPTABLE: 'MODEL_SECRET_UNDECRYPTABLE',
  MODEL_SECRET_STORE_UNAVAILABLE: 'MODEL_SECRET_STORE_UNAVAILABLE',
  MODEL_ENDPOINT_INVALID: 'MODEL_ENDPOINT_INVALID',
  MODEL_PROBE_FAILED: 'MODEL_PROBE_FAILED',
  MODEL_NOT_CONFIGURED: 'MODEL_NOT_CONFIGURED',
  MODEL_NOT_ASSIGNED: 'MODEL_NOT_ASSIGNED',
  MODEL_CONFIG_INVALID: 'MODEL_CONFIG_INVALID',
  WORKER_NOT_LOADED: 'WORKER_NOT_LOADED',
  BRIDGE_TIMEOUT: 'BRIDGE_TIMEOUT',
  SNOWLUMA_NOT_FOUND: 'SNOWLUMA_NOT_FOUND',
  SNOWLUMA_NOT_RUNNING: 'SNOWLUMA_NOT_RUNNING',
  ONEBOT_ENDPOINT_UNREACHABLE: 'ONEBOT_ENDPOINT_UNREACHABLE',
  ONEBOT_ADAPTER_NOT_CONFIGURED: 'ONEBOT_ADAPTER_NOT_CONFIGURED',
  ONEBOT_AUTH_FAILED: 'ONEBOT_AUTH_FAILED',
  SELF_ID_MISMATCH: 'SELF_ID_MISMATCH',
  ACCOUNT_NOT_BOUND: 'ACCOUNT_NOT_BOUND',
  PRIVATE_USER_NOT_ALLOWED: 'PRIVATE_USER_NOT_ALLOWED',
  STORY_PAUSED: 'STORY_PAUSED',
  DELIVERY_FAILED: 'DELIVERY_FAILED',
  CONFIG_NEEDS_RELOAD: 'CONFIG_NEEDS_RELOAD',
} as const

export type FirstRunErrorCode = typeof FIRST_RUN_ERROR_CODES[keyof typeof FIRST_RUN_ERROR_CODES]
export type ReadinessStatus = 'not-started' | 'checking' | 'ready' | 'blocked' | 'failed' | 'needs-reload' | 'degraded'
export type ReadinessAction = 'configure' | 'load' | 'reload' | 'retry' | 'replay' | 'run' | 'open-logs'

export interface ReadinessLayer {
  id: string
  label: string
  status: ReadinessStatus
  summary: string
  detail?: string
  checkedAt?: string
  code?: FirstRunErrorCode
}

export interface ReadinessItem {
  status: ReadinessStatus
  summary: string
  detail?: string
  actions: ReadinessAction[]
  checkedAt?: string
  code?: FirstRunErrorCode
  /** Optional diagnostic stages; each stage proves only its own layer. */
  layers?: ReadinessLayer[]
}

export interface FirstRunReadiness {
  schemaVersion: 1
  storyId: string
  overall: 'not-ready' | 'ready' | 'degraded' | 'running'
  worker: ReadinessItem
  model: ReadinessItem
  channel: ReadinessItem
  account: ReadinessItem
  permissions: ReadinessItem
  lastMessage?: unknown
  checkedAt: string
  /** Compatibility projection for the current connection panel. */
  checks: Array<{ id: string, label: string, status: 'ok' | 'err' | 'warn', detail: string, action?: string, code?: FirstRunErrorCode }>
  allOk: boolean
  criticalOk: boolean
}

export class FirstRunError extends Error {
  readonly code: FirstRunErrorCode

  constructor(code: FirstRunErrorCode, message: string) {
    super(message)
    this.name = 'FirstRunError'
    this.code = code
  }
}

export function readinessItem(input: Omit<ReadinessItem, 'actions'> & { actions?: ReadinessAction[] }): ReadinessItem {
  return { actions: [], ...input }
}

export function overallForReadiness(items: ReadinessItem[]): FirstRunReadiness['overall'] {
  if (items.some(item => item.status === 'blocked' || item.status === 'failed')) return 'not-ready'
  if (items.some(item => item.status === 'degraded' || item.status === 'needs-reload')) return 'degraded'
  if (items.some(item => item.status === 'checking' || item.status === 'not-started')) return 'ready'
  return items.some(item => item.status === 'ready') ? 'running' : 'not-ready'
}

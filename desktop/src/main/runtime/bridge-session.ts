/**
 * typ-0 桥会话状态机（P1 产品化：把协商结果从日志行变成可查询状态）。
 *
 * 设计约束：
 *  - 纯内存、无 Electron/fs 依赖——合同测试直接实例化（scripts/test-bridge.mjs）。
 *  - 只做观察与分类，不做门控执行：消息路径的放行仍由 StoryManager 既有逻辑
 *    （isBridgeReady / hasBridgeCapability）决定。本模块是它们的"可解释投影"，
 *    两边共用同一组常量（45s 心跳窗 / 30s 协商窗），漂移会被合同测试抓住。
 *  - 版本政策见根目录 BRIDGE_PROTOCOL.md。要点：宿主按 protocol 2..4 认证语义；
 *    高于宿主已认证版本的协议标 degraded（不阻断——沿用既有前向容忍行为，
 *    但必须在 UI 上可见，不再静默）。
 */

/** 与 stories.ts isBridgeReady 的 45s 心跳窗保持一致（单处定义，双向引用）。 */
export const BRIDGE_HEARTBEAT_TIMEOUT_MS = 45_000
/** 与 main.ts 加载流程的 bridge-ready 30s 等待一致；状态机自身也按此翻转 failed。 */
export const BRIDGE_NEGOTIATION_TIMEOUT_MS = 30_000

/** 宿主已认证语义的协议区间。min=2 沿用 stories.ts 对 bridge-ready 的历史门槛。 */
export const HOST_PROTOCOL_RANGE = { min: 2, max: 4 } as const

export type BridgeSessionState =
  | 'connecting'   // worker 已 fork，等待 bridge-ready
  | 'ready'        // 协商成功且全部声明功能可用
  | 'degraded'     // 协商成功但有功能缺失/协议超出已认证范围（清单见快照）
  | 'stale'        // 心跳超时——worker 可能存活但无响应（复用 45s 判定）
  | 'failed'       // 协商失败（协议不可读/过旧/协商超时）
  | 'closed'       // worker 已退出（exitKind 沿用 stories.ts 四分类）

export type BridgeExitKind = 'normal' | 'killed' | 'crash' | 'error'

export interface BridgeNegotiationFailure {
  kind: 'protocol-unreadable' | 'protocol-too-old' | 'negotiation-timeout'
  detail: string
}

export interface BridgeFeatureSpec {
  /** 稳定键（IPC/测试锚点，勿改）。 */
  key: string
  label: string
  /** Worker bridge-ready 需声明的 capability 位。 */
  capability: string
  /** 能力缺失时的既有降级路径（写入 UI 文案；无降级则功能直接禁用）。 */
  fallback?: string
}

/**
 * 功能 → 必需 capability 声明表（声明式，照 MIXER_PARAMS 的房子风格）。
 * 新增桥功能时在此补一行，并同步 BRIDGE_PROTOCOL.md 的帧清单。
 */
export const BRIDGE_FEATURES: BridgeFeatureSpec[] = [
  { key: 'phase', label: '运行状态切换', capability: 'phase' },
  { key: 'inbound', label: '实时入站', capability: 'inbound', fallback: '消息进收件箱，恢复后回放' },
  { key: 'replay-inbox', label: '收件箱回放', capability: 'replay-inbox' },
  { key: 'delivery', label: '宿主投递通道', capability: 'delivery' },
  { key: 'timeline-range', label: '时间线范围投影', capability: 'timeline-range', fallback: '兼容快照（snapshot）' },
  { key: 'purge-range', label: '选区删除', capability: 'purge-range' },
  { key: 'cursor-set', label: '叙事游标回拨', capability: 'cursor-set' },
  { key: 'endpoint-health', label: '端点健康面板', capability: 'endpoint-health' },
  { key: 'multi-account', label: '多账号入站', capability: 'multi-account' },
  { key: 'onebot-action', label: '动作代理（表情/Qzone）', capability: 'onebot-action' },
  { key: 'processing-context', label: '处理上下文关联', capability: 'processing-context' },
]

/** 截至 protocol 4 宿主认识的 capability 全集；清单外 = 前向兼容位（记录、不降级）。 */
export const KNOWN_BRIDGE_CAPABILITIES: readonly string[] = [
  'phase', 'inbound', 'replay-inbox', 'snapshot', 'timeline-range',
  'delivery', 'purge-range', 'cursor-set', 'endpoint-health',
  'multi-account', 'onebot-action', 'processing-context',
]

export interface BridgeSessionSnapshot {
  storyId: string
  state: BridgeSessionState
  pid?: number
  protocol?: number
  apiVersion?: number
  capabilities: string[]
  /** 清单外能力位——新插件前向兼容的可见性（不降级）。 */
  unknownCapabilities: string[]
  /** warnings 非空时 state 一定是 degraded。 */
  warnings: string[]
  failure?: BridgeNegotiationFailure
  closedAs?: { exitKind: BridgeExitKind }
  unavailableFeatures: Array<{ key: string, label: string, reason: string, fallback?: string }>
  lastSeenAt?: string
  negotiatedAt?: string
  stateChangedAt: string
}

/** 对 bridge-ready 载荷的纯分类。stories.ts 收到消息后先经此判定再入状态机。 */
export function classifyNegotiation(payload: unknown): {
  ok: boolean
  failure?: BridgeNegotiationFailure
  protocol?: number
  apiVersion?: number
  capabilities: string[]
  unknownCapabilities: string[]
  warnings: string[]
} {
  const source = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {}
  const protocol = Number.isInteger(source.protocol) ? source.protocol as number : undefined
  if (protocol === undefined) {
    return { ok: false, failure: { kind: 'protocol-unreadable', detail: 'bridge-ready 载荷缺少可解析的 protocol 字段。' }, capabilities: [], unknownCapabilities: [], warnings: [] }
  }
  if (protocol < HOST_PROTOCOL_RANGE.min) {
    return { ok: false, failure: { kind: 'protocol-too-old', detail: `Worker 声明 protocol ${protocol}，低于宿主已认证的最低版本 ${HOST_PROTOCOL_RANGE.min}。请升级 HDSI 插件。` }, protocol, capabilities: [], unknownCapabilities: [], warnings: [] }
  }
  const apiVersion = Number.isInteger(source.apiVersion) ? source.apiVersion as number : undefined
  // 净化规则与 stories.ts bridge-ready 处理一致（string ≤80、≤64 项）。
  const capabilities = Array.isArray(source.capabilities)
    ? source.capabilities.filter((item: unknown): item is string => typeof item === 'string' && item.length <= 80).slice(0, 64)
    : []
  const known = new Set(KNOWN_BRIDGE_CAPABILITIES)
  const unknownCapabilities = capabilities.filter(item => !known.has(item))
  const warnings: string[] = []
  if (protocol > HOST_PROTOCOL_RANGE.max) {
    warnings.push(`protocol-ahead-of-host: Worker 声明 protocol ${protocol}，宿主已认证到 ${HOST_PROTOCOL_RANGE.max}——语义未经本桌面验证，功能可能异常。`)
  }
  if (apiVersion === undefined) {
    warnings.push('missing-api-version: 旧版插件未上报 apiVersion（信息性，不影响判定）。')
  }
  return { ok: true, protocol, apiVersion, capabilities, unknownCapabilities, warnings }
}

interface SessionRecord {
  storyId: string
  pid?: number
  state: BridgeSessionState
  protocol?: number
  apiVersion?: number
  capabilities: string[]
  unknownCapabilities: string[]
  warnings: string[]
  failure?: BridgeNegotiationFailure
  closedAs?: { exitKind: BridgeExitKind }
  lastSeenAt?: number
  negotiatedAt?: number
  stateChangedAt: number
  /** publish() 的去重指纹（内容不变不触发 onChange）。 */
  lastFingerprint?: string
}

function featureAvailability(record: SessionRecord): BridgeSessionSnapshot['unavailableFeatures'] {
  if (record.state !== 'ready' && record.state !== 'degraded' && record.state !== 'stale') {
    const reason = record.state === 'connecting' ? '等待桥协商完成。'
      : record.state === 'failed' ? `桥协商失败：${record.failure?.detail ?? '原因未知'}`
        : record.state === 'closed' ? 'Worker 已退出。'
          : '心跳超时。'
    return BRIDGE_FEATURES.map(feature => ({ key: feature.key, label: feature.label, reason }))
  }
  return BRIDGE_FEATURES
    .filter(feature => !record.capabilities.includes(feature.capability))
    .map(feature => ({
      key: feature.key,
      label: feature.label,
      reason: `Worker 未声明 ${feature.capability}`,
      ...(feature.fallback ? { fallback: feature.fallback } : {}),
    }))
}

function snapshotOf(record: SessionRecord): BridgeSessionSnapshot {
  return {
    storyId: record.storyId,
    state: record.state,
    pid: record.pid,
    protocol: record.protocol,
    apiVersion: record.apiVersion,
    capabilities: record.capabilities.slice(),
    unknownCapabilities: record.unknownCapabilities.slice(),
    warnings: record.warnings.slice(),
    ...(record.failure ? { failure: { ...record.failure } } : {}),
    ...(record.closedAs ? { closedAs: { ...record.closedAs } } : {}),
    unavailableFeatures: featureAvailability(record),
    ...(record.lastSeenAt !== undefined ? { lastSeenAt: new Date(record.lastSeenAt).toISOString() } : {}),
    ...(record.negotiatedAt !== undefined ? { negotiatedAt: new Date(record.negotiatedAt).toISOString() } : {}),
    stateChangedAt: new Date(record.stateChangedAt).toISOString(),
  }
}

/** 除时间戳/活性遥测外的快照指纹——内容真正变化才触发 onChange（防心跳与
 *  重复 bridge-ready 刷屏；lastSeenAt 每条消息都变、negotiatedAt 每次协商都
 *  变，但 chip/日志只关心状态、能力与降级清单）。 */
function fingerprint(snapshot: BridgeSessionSnapshot): string {
  const { stateChangedAt: _time, lastSeenAt: _seen, negotiatedAt: _negotiated, ...rest } = snapshot
  return JSON.stringify(rest)
}

/** 状态栏/日志用的单行人类描述。 */
export function describeBridgeState(snapshot: BridgeSessionSnapshot): string {
  switch (snapshot.state) {
    case 'connecting': return `桥：协商中${snapshot.pid ? `（pid ${snapshot.pid}）` : ''}`
    case 'ready': return `桥：P${snapshot.protocol ?? '?'} 就绪`
    case 'degraded': {
      const missing = snapshot.unavailableFeatures.length
      return `桥：P${snapshot.protocol ?? '?'} 降级（${missing} 项功能受限）`
    }
    case 'stale': return `桥：失联（心跳超 45s，最后活跃 ${snapshot.lastSeenAt ?? '未知'}）`
    case 'failed': return `桥：协商失败（${snapshot.failure?.kind ?? '未知'}）`
    case 'closed': return `桥：已关闭（${snapshot.closedAs?.exitKind ?? 'unknown'}）`
  }
}

/**
 * 每故事一条会话记录。宿主在 fork/negotiate/心跳/退出四个时点喂数据；
 * sweep() 由 main.ts 的 15s 定时器驱动（时间可注入，测试不依赖真实时钟）。
 */
export class BridgeSessionTracker {
  private readonly records = new Map<string, SessionRecord>()

  constructor(private readonly onChange?: (snapshot: BridgeSessionSnapshot) => void) {}

  connecting(storyId: string, meta: { pid?: number } = {}, now = Date.now()): BridgeSessionSnapshot {
    const previous = this.records.get(storyId)
    const record: SessionRecord = {
      storyId,
      ...(meta.pid !== undefined ? { pid: meta.pid } : {}),
      // 崩溃自动重启场景：同一故事立刻重连时保留上次协议信息供对照。
      ...(previous?.protocol !== undefined ? { protocol: previous.protocol } : {}),
      state: 'connecting',
      capabilities: [],
      unknownCapabilities: [],
      warnings: [],
      stateChangedAt: now,
    }
    this.records.set(storyId, record)
    return this.publish(record, true)
  }

  /** bridge-ready 到达。分类失败也记录（failed 态可查询），不抛异常。 */
  negotiate(storyId: string, payload: unknown, now = Date.now()): BridgeSessionSnapshot {
    const record = this.records.get(storyId) ?? { storyId, state: 'connecting' as BridgeSessionState, capabilities: [], unknownCapabilities: [], warnings: [], stateChangedAt: now }
    const classified = classifyNegotiation(payload)
    record.lastSeenAt = now
    if (!classified.ok) {
      record.state = 'failed'
      record.failure = classified.failure
      record.stateChangedAt = now
      return this.publish(record)
    }
    record.protocol = classified.protocol
    if (classified.apiVersion !== undefined) record.apiVersion = classified.apiVersion
    else delete record.apiVersion
    record.capabilities = classified.capabilities
    record.unknownCapabilities = classified.unknownCapabilities
    record.warnings = classified.warnings
    record.negotiatedAt = now
    delete record.failure
    // 有任何声明功能缺失或协议超出已认证范围 → degraded；全部就绪 → ready。
    const missing = BRIDGE_FEATURES.filter(feature => !record.capabilities.includes(feature.capability))
    const nextState: BridgeSessionState = missing.length || record.warnings.some(warning => warning.startsWith('protocol-ahead-of-host')) ? 'degraded' : 'ready'
    if (record.state !== nextState) {
      record.state = nextState
      record.stateChangedAt = now
    }
    return this.publish(record)
  }

  /** 任何 hdsi-desktop 消息都算活性（与 stories.ts lastSeenAt 同义）。 */
  touch(storyId: string, now = Date.now()): void {
    const record = this.records.get(storyId)
    if (!record) return
    record.lastSeenAt = now
    if (record.state === 'stale') {
      // 心跳恢复：回到协商后语义（ready 或 degraded），不清空降级清单。
      const missing = BRIDGE_FEATURES.filter(feature => !record.capabilities.includes(feature.capability))
      record.state = missing.length ? 'degraded' : 'ready'
      record.stateChangedAt = now
      this.publish(record)
    }
  }

  /** 周期驱动：协商超时 → failed；心跳超时 → stale。返回发生翻转的快照（供测试断言）。 */
  sweep(now = Date.now()): BridgeSessionSnapshot[] {
    const flipped: BridgeSessionSnapshot[] = []
    for (const record of this.records.values()) {
      if (record.state === 'connecting' && now - record.stateChangedAt > BRIDGE_NEGOTIATION_TIMEOUT_MS) {
        record.state = 'failed'
        record.failure = { kind: 'negotiation-timeout', detail: `Worker 启动后 ${Math.round(BRIDGE_NEGOTIATION_TIMEOUT_MS / 1000)}s 内未收到 bridge-ready。` }
        record.stateChangedAt = now
        flipped.push(this.publish(record))
      } else if ((record.state === 'ready' || record.state === 'degraded') && record.lastSeenAt !== undefined && now - record.lastSeenAt > BRIDGE_HEARTBEAT_TIMEOUT_MS) {
        record.state = 'stale'
        record.stateChangedAt = now
        flipped.push(this.publish(record))
      }
    }
    return flipped
  }

  workerExited(storyId: string, exitKind: BridgeExitKind, now = Date.now()): BridgeSessionSnapshot | undefined {
    const record = this.records.get(storyId)
    if (!record) return undefined
    record.state = 'closed'
    record.closedAs = { exitKind }
    record.stateChangedAt = now
    return this.publish(record)
  }

  snapshot(storyId: string): BridgeSessionSnapshot | undefined {
    const record = this.records.get(storyId)
    return record ? snapshotOf(record) : undefined
  }

  private publish(record: SessionRecord, force = false): BridgeSessionSnapshot {
    const snapshot = snapshotOf(record)
    if (force || fingerprint(snapshot) !== record.lastFingerprint) {
      record.lastFingerprint = fingerprint(snapshot)
      this.onChange?.(snapshot)
    }
    return snapshot
  }
}

/** 在途桥请求被 worker 退出中止时抛出——调用方可按 code 分类（不再等同超时）。 */
export class BridgeRequestAbortedError extends Error {
  readonly code = 'bridge-worker-exited'
  constructor(storyId: string, exitKind: BridgeExitKind) {
    super(`Worker 已退出（${exitKind}），在途桥请求结果不可知（storyId=${storyId}）。`)
    this.name = 'BridgeRequestAbortedError'
  }
}

/** 桥请求回执超时——请求已写出、结果不可知（与投递层 ambiguous 同族语义）。
 *  消息文本必须保留"确认超时"：message-router 以 /超时/ 区分 worker-timeout
 *  与 worker-rejected（D2-3），改字会破坏收件箱归因。 */
export class BridgeRequestTimeoutError extends Error {
  readonly code = 'bridge-timeout'
  constructor(command: string, timeoutMs: number) {
    super(`等待 HDSI ${command} 确认超时。`)
    this.name = 'BridgeRequestTimeoutError'
    this.timeoutMs = timeoutMs
    this.command = command
  }
  readonly command: string
  readonly timeoutMs: number
}

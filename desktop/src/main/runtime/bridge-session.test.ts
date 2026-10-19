/**
 * 桥会话合同测试（P1）。
 *
 * fixture 全部取自真实发布包（release/*.tgz bundle 内的 DESKTOP_BRIDGE_*
 * 常量逐版提取）——不是手写的理想形态。任何一次插件升级同步（见 PROVENANCE
 * 再构建流程）若改变能力面/协议号，这里会先于"面板空白"报警。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  BRIDGE_FEATURES,
  BridgeRequestAbortedError,
  BridgeRequestTimeoutError,
  BridgeSessionTracker,
  classifyNegotiation,
  describeBridgeState,
  KNOWN_BRIDGE_CAPABILITIES,
} from './bridge-session'
import { StoryManager } from '../stories'

/** 从各版本 tgz 的 lib/index.js 提取（2026-10-18 核对）。 */
const HISTORICAL_FIXTURES = [
  { version: '1.0.0-beta10', payload: { protocol: 4, phase: 'running' } },
  { version: '1.0.1-rc25', payload: { protocol: 4, phase: 'running' } },
  {
    version: '1.0.1-rc33',
    payload: {
      protocol: 4,
      capabilities: ['phase', 'inbound', 'replay-inbox', 'snapshot', 'timeline-range', 'delivery', 'purge-range', 'cursor-set', 'endpoint-health', 'multi-account', 'onebot-action'],
    },
  },
  {
    version: '1.0.1-rc48',
    payload: {
      protocol: 4,
      capabilities: ['phase', 'inbound', 'replay-inbox', 'snapshot', 'timeline-range', 'delivery', 'purge-range', 'cursor-set', 'endpoint-health', 'multi-account', 'onebot-action', 'processing-context'],
    },
  },
  {
    version: '1.0.1-rc57',
    payload: {
      protocol: 4, apiVersion: 1,
      capabilities: ['phase', 'inbound', 'replay-inbox', 'snapshot', 'timeline-range', 'delivery', 'purge-range', 'cursor-set', 'endpoint-health', 'multi-account', 'onebot-action', 'processing-context'],
    },
  },
] as const

test('历史 fixture：能力面演变与降级判定（合同核心）', () => {
  let clock = 1_000_000
  const tracker = new BridgeSessionTracker()
  const expectations: Record<string, { state: string, unavailable: number }> = {
    // 无能力清单时代（beta10/rc25）：桥能连，全部声明功能受限——
    // 时间线走兼容快照、语义分析/选区删除/游标回拨直接不可用。
    '1.0.0-beta10': { state: 'degraded', unavailable: BRIDGE_FEATURES.length },
    '1.0.1-rc25': { state: 'degraded', unavailable: BRIDGE_FEATURES.length },
    // rc33：11/12 能力——仅缺 processing-context（traceId/processingId 关联）。
    '1.0.1-rc33': { state: 'degraded', unavailable: 1 },
    // rc48：能力齐但未上报 apiVersion（信息性 warning，不降级）。
    '1.0.1-rc48': { state: 'ready', unavailable: 0 },
    // rc57：当前锁定版本。
    '1.0.1-rc57': { state: 'ready', unavailable: 0 },
  }
  for (const fixture of HISTORICAL_FIXTURES) {
    const storyId = `story-${fixture.version}`
    tracker.connecting(storyId, { pid: 4242 }, clock)
    const snapshot = tracker.negotiate(storyId, fixture.payload, clock)
    const expected = expectations[fixture.version]
    assert.equal(snapshot.state, expected.state, `${fixture.version} 状态`)
    assert.equal(snapshot.unavailableFeatures.length, expected.unavailable, `${fixture.version} 受限功能数`)
    assert.equal(snapshot.pid, 4242)
  }
  // beta10 的降级明细必须点名降级路径（用户能看到"为什么面板受限"）。
  const beta = tracker.snapshot('story-1.0.0-beta10')!
  const timeline = beta.unavailableFeatures.find(item => item.key === 'timeline-range')
  assert.ok(timeline, '时间线受限条目在列')
  assert.equal(timeline.reason, 'Worker 未声明 timeline-range')
  assert.equal(timeline.fallback, '兼容快照（snapshot）')
})

test('协议分类：过旧拒绝、过新降级、不可读失败、2..4 通过', () => {
  const caps = KNOWN_BRIDGE_CAPABILITIES.slice()
  assert.equal(classifyNegotiation({ protocol: 1, capabilities: caps }).ok, false)
  assert.equal(classifyNegotiation({ protocol: 1, capabilities: caps }).failure?.kind, 'protocol-too-old')
  assert.equal(classifyNegotiation({ protocol: 0, capabilities: caps }).failure?.kind, 'protocol-too-old')
  assert.equal(classifyNegotiation({ capabilities: caps }).failure?.kind, 'protocol-unreadable')
  assert.equal(classifyNegotiation({ protocol: '4' }).failure?.kind, 'protocol-unreadable')
  for (const protocol of [2, 3, 4]) {
    const result = classifyNegotiation({ protocol, capabilities: caps })
    assert.equal(result.ok, true, `protocol ${protocol} 应通过`)
    assert.equal(result.capabilities.length, caps.length)
  }
  // 前向：未来 protocol 5——放行（沿用既有容忍）但必须可见。
  const ahead = classifyNegotiation({ protocol: 5, capabilities: caps })
  assert.equal(ahead.ok, true)
  assert.ok(ahead.warnings.some(warning => warning.startsWith('protocol-ahead-of-host')))
  const tracker = new BridgeSessionTracker()
  const snapshot = tracker.negotiate('s', { protocol: 5, capabilities: caps })
  assert.equal(snapshot.state, 'degraded', '超出宿主已认证协议 → 降级可见')
})

test('能力净化：非字符串/超长/超量条目被裁剪，未知位记录不降级', () => {
  const polluted = [...KNOWN_BRIDGE_CAPABILITIES, 'future-capability', 42 as unknown as string, 'x'.repeat(81)]
  const result = classifyNegotiation({ protocol: 4, capabilities: polluted })
  assert.equal(result.ok, true)
  assert.ok(result.capabilities.includes('future-capability'))
  assert.ok(!result.capabilities.includes('x'.repeat(81)), '超长条目被裁')
  assert.ok(!result.capabilities.includes('42'), '非字符串被裁')
  assert.deepEqual(result.unknownCapabilities, ['future-capability'])
  const tracker = new BridgeSessionTracker()
  const snapshot = tracker.negotiate('s', { protocol: 4, capabilities: polluted })
  assert.equal(snapshot.state, 'ready', '未知能力位是前向兼容路径，不降级')
  assert.deepEqual(snapshot.unknownCapabilities, ['future-capability'])
})

test('生命周期：协商超时 → failed；心跳超时 → stale；恢复回 ready；退出 → closed', () => {
  let clock = 1_000_000
  const events: string[] = []
  const tracker = new BridgeSessionTracker(snapshot => events.push(snapshot.state))
  tracker.connecting('s', {}, clock)
  // 30s 协商窗：31s 仍未 bridge-ready → failed(negotiation-timeout)。
  tracker.sweep(clock + 31_000)
  assert.equal(tracker.snapshot('s')?.state, 'failed')
  assert.equal(tracker.snapshot('s')?.failure?.kind, 'negotiation-timeout')
  // 重连：connecting → negotiate 成功。
  tracker.connecting('s', {}, clock + 32_000)
  tracker.negotiate('s', HISTORICAL_FIXTURES[4].payload, clock + 33_000)
  assert.equal(tracker.snapshot('s')?.state, 'ready')
  // 45s 心跳窗：46s 无消息 → stale；期间 sweep 无翻转时不产生事件。
  assert.deepEqual(tracker.sweep(clock + 40_000), [])
  const flipped = tracker.sweep(clock + 33_000 + 46_000)
  assert.equal(flipped.length, 1)
  assert.equal(tracker.snapshot('s')?.state, 'stale')
  assert.ok(describeBridgeState(tracker.snapshot('s')!).includes('失联'))
  // 心跳恢复 → 回到协商后语义（不清空能力清单）。
  tracker.touch('s', clock + 90_000)
  assert.equal(tracker.snapshot('s')?.state, 'ready')
  assert.equal(tracker.snapshot('s')?.capabilities.length, 12)
  // worker 退出 → closed（exitKind 保留供 UI/日志归因）。
  tracker.workerExited('s', 'crash', clock + 91_000)
  assert.equal(tracker.snapshot('s')?.state, 'closed')
  assert.equal(tracker.snapshot('s')?.closedAs?.exitKind, 'crash')
})

test('onChange 去重：内容不变不重复外送（防心跳刷屏）', () => {
  let clock = 1_000_000
  let count = 0
  const tracker = new BridgeSessionTracker(() => { count++ })
  tracker.connecting('s', {}, clock)
  const afterConnecting = count
  // 同一 bridge-ready 重放（worker 不重发，但 sweep/读路径可能重复触发）：
  tracker.negotiate('s', HISTORICAL_FIXTURES[4].payload, clock)
  tracker.negotiate('s', HISTORICAL_FIXTURES[4].payload, clock + 1)
  tracker.negotiate('s', HISTORICAL_FIXTURES[4].payload, clock + 2)
  assert.equal(count, afterConnecting + 1, '内容未变只发一次')
})

test('快照形状合同（渲染层消费面）：字段与 describeBridgeState 输出', () => {
  const tracker = new BridgeSessionTracker()
  tracker.connecting('s', { pid: 7 }, 1_000)
  const snapshot = tracker.negotiate('s', HISTORICAL_FIXTURES[4].payload, 2_000)
  for (const key of ['storyId', 'state', 'capabilities', 'unknownCapabilities', 'warnings', 'unavailableFeatures', 'stateChangedAt'] as const) {
    assert.ok(key in snapshot, `快照缺少 ${key}`)
  }
  assert.equal(snapshot.apiVersion, 1)
  assert.equal(snapshot.negotiatedAt, new Date(2_000).toISOString())
  for (const state of ['ready', 'degraded', 'stale', 'failed', 'closed'] as const) {
    // describeBridgeState 是日志/状态栏文案来源：各态都要有可读输出。
    const described = describeBridgeState({ ...snapshot, state })
    assert.ok(typeof described === 'string' && described.length > 0, `${state} 描述非空`)
  }
})

test('StoryManager 集成：worker 退出将在途请求按 worker-exited 结算（不再幽灵超时）', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'hdsi-bridge-contract-'))
  try {
    const manager = new StoryManager(root, root)
    // 模拟一条在途 requestDesktop：直接向私有登记表注入中止句柄
    // （fork 真实 worker 不进合同测试——此处只锁"退出 → 立即分类结算"契约）。
    let settled: Error | undefined
    const inFlight = new Set<(error: Error) => void>()
    inFlight.add(error => { settled = error })
    ;(manager as unknown as { pendingBridgeRequests: Map<string, Set<(error: Error) => void>> }).pendingBridgeRequests.set('story-x', inFlight)
    ;(manager as unknown as { abortPendingBridgeRequests: (id: string, kind: 'crash') => void }).abortPendingBridgeRequests('story-x', 'crash')
    assert.ok(settled instanceof BridgeRequestAbortedError)
    assert.equal((settled as BridgeRequestAbortedError).code, 'bridge-worker-exited')
    assert.ok(settled!.message.includes('crash'), '错误消息带退出分类')
    assert.equal(inFlight.size, 0, '结算后登记清空')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('超时错误合同：类型化抛出 + 消息保留"确认超时"（message-router 的 /超时/ 分类依赖）', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'hdsi-bridge-timeout-'))
  try {
    const manager = new StoryManager(root, root)
    // 伪造"桥就绪 + worker 在"的运行时态，让 requestDesktop 走到等待回执——
    // 无人应答，短超时后应得到类型化的 BridgeRequestTimeoutError。
    const forged = manager as unknown as {
      workers: Map<string, { connected: boolean, send: (message: unknown, callback: (error: Error | null) => void) => void }>
      bridgeReady: Set<string>
      lastSeenAt: Map<string, number>
      bridgeCapabilities: Map<string, string[]>
      requestDesktop: <T>(metaId: string, command: string, value: Record<string, unknown>, responseEvent: string, timeoutMs: number) => Promise<T>
    }
    forged.workers.set('story-x', { connected: true, send: (_message, callback) => callback(null) })
    forged.bridgeReady.add('story-x')
    forged.lastSeenAt.set('story-x', Date.now())
    forged.bridgeCapabilities.set('story-x', [...KNOWN_BRIDGE_CAPABILITIES])
    const error = await forged.requestDesktop('story-x', 'phase', { phase: 'paused' }, 'phase-result', 30).then(() => undefined, (reason: Error) => reason)
    assert.ok(error instanceof BridgeRequestTimeoutError, '超时必须是类型化错误')
    assert.equal(error.code, 'bridge-timeout')
    assert.ok(error.message.includes('确认超时'), 'message-router 以 /超时/ 归类 worker-timeout——字样不得丢失')
    assert.ok(error.message.includes('phase'), '消息带命令名便于排障')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('选区删除超时翻译：结果待核实语义；非超时错误原样透传', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'hdsi-bridge-purge-'))
  try {
    const manager = new StoryManager(root, root)
    const forged = manager as unknown as {
      bridgeCapabilities: Map<string, string[]>
      requestDesktop: (metaId: string, command: string, value: Record<string, unknown>, responseEvent: string, timeoutMs: number) => Promise<unknown>
    }
    forged.bridgeCapabilities.set('story-x', [...KNOWN_BRIDGE_CAPABILITIES])
    // 用实例方法替换模拟超时/失败两种底层错误（真实 60s 等待不进测试）。
    forged.requestDesktop = async () => { throw new BridgeRequestTimeoutError('purge-range', 60_000) }
    const timeoutError = await manager.requestPurgeRange('story-x', '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z').then(() => undefined, (reason: Error) => reason)
    assert.ok(timeoutError!.message.includes('结果不可知'), '超时翻译为结果待核实')
    assert.ok(timeoutError!.message.includes('刷新时间线'), '给出核对路径')
    assert.ok(!(timeoutError! instanceof BridgeRequestTimeoutError), '内部类型不外漏到 IPC 面')
    const definite = new Error('HDSI 拒绝。')
    forged.requestDesktop = async () => { throw definite }
    const passedThrough = await manager.requestPurgeRange('story-x', '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z').then(() => undefined, (reason: Error) => reason)
    assert.equal(passedThrough, definite, '非超时错误不翻译、不吞包')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

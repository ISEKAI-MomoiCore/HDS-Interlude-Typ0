import { EventEmitter } from 'node:events'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { BindingRegistry } from './bindings'
import { assertInboundEvent, DesktopInboundEvent, inboundIdempotencyKey, RouteResult, StoryPhase, WorkerIngress } from './contracts'
import { InboundReceiptLedger } from './inbound-ledger'
import { InboxRepository } from './inbox-replay'
import { readJsonFile, writeJsonAtomic } from './json-file'
import { ensureTraceId } from './trace'

export interface StoryPhaseResolver { getPhase(storyId: string): StoryPhase | undefined }

/**
 * 入口只做绑定、状态分流和可靠落盘；它永不解释角色语义。
 * It only suppresses exact transport-issued IDs after HDSI accepted them.
 */
export class MessageRouter extends EventEmitter {
  private readonly unassignedFile: string
  private readonly inFlight = new Set<string>()
  constructor(
    dataRoot: string,
    private readonly bindings: BindingRegistry,
    private readonly phases: StoryPhaseResolver,
    private readonly inbox: InboxRepository,
    private readonly workers: WorkerIngress,
    private readonly receipts: InboundReceiptLedger,
  ) {
    super()
    mkdirSync(dataRoot, { recursive: true })
    this.unassignedFile = path.join(dataRoot, 'unassigned-inbox.json')
  }

  /** 审计 M6：回放窗口与实时路由的去重窗口——回放在途期间（peek 之后、
   *  receipts.accept 之前），把待回放记录的幂等键登记进同一 inFlight 集：
   *  上游对同一 rawMessageId 的重投在此窗口内按 ignored-duplicate 拒收，
   *  回放失败（记录仍在收件箱、稍后重试）时由返回的释放函数归还窗口。 */
  holdForReplay(storyId: string, events: DesktopInboundEvent[]): () => void {
    const keys = events
      .map(event => inboundIdempotencyKey(event))
      .filter((key): key is string => !!key)
      .map(key => `${storyId}:${key}`)
    for (const key of keys) this.inFlight.add(key)
    return () => { for (const key of keys) this.inFlight.delete(key) }
  }

  async route(event: DesktopInboundEvent): Promise<RouteResult> {
    // The router is also used directly by tests, replay tools and older callers;
    // normalize here so no transport-specific entry point can lose correlation.
    const tracedEvent: DesktopInboundEvent = { ...event, traceId: ensureTraceId(event.traceId) }
    assertInboundEvent(tracedEvent)
    const traceId = tracedEvent.traceId
    const binding = this.bindings.find(tracedEvent.accountKey)
    if (!binding) {
      // 审计：未绑定账号的事件此前无上限累积且每条全文件重写（未路由流量下
      // O(n²) 放大）。保留最近 5000 条（诊断用途足够），旧条目滚动丢弃。
      const list = readJsonFile<DesktopInboundEvent[]>(this.unassignedFile, [])
      list.push(tracedEvent)
      if (list.length > 5_000) list.splice(0, list.length - 5_000)
      writeJsonAtomic(this.unassignedFile, list)
      this.emit('unassigned', tracedEvent)
      return { traceId, disposition: 'unassigned', reason: '账号尚未绑定剧本。' }
    }
    const key = inboundIdempotencyKey(tracedEvent)
    const flightKey = key ? `${binding.storyId}:${key}` : undefined
    if (this.receipts.has(binding.storyId, tracedEvent) || (flightKey && this.inFlight.has(flightKey))) {
      return { traceId, disposition: 'ignored-duplicate', storyId: binding.storyId, reason: '已接收相同渠道消息 ID。' }
    }
    const phase = this.phases.getPhase(binding.storyId)
    if (!phase || phase === 'paused' || phase === 'muted') {
      const reason = !phase || phase === 'paused' ? 'paused' : 'muted'
      const record = this.inbox.append(binding.storyId, tracedEvent, reason)
      const size = this.inbox.size(binding.storyId)
      this.emit('queued', { storyId: binding.storyId, record, size })
      return { traceId, disposition: 'queued', storyId: binding.storyId, inboxSize: size, reason }
    }
    if (!this.workers.isBridgeReady(binding.storyId)) {
      const record = this.inbox.append(binding.storyId, tracedEvent, 'worker-unavailable')
      const size = this.inbox.size(binding.storyId)
      this.emit('queued', { storyId: binding.storyId, record, size })
      return { traceId, disposition: 'queued', storyId: binding.storyId, inboxSize: size, reason: 'worker-unavailable' }
    }
    try {
      if (flightKey) this.inFlight.add(flightKey)
      await this.workers.deliverInbound(binding.storyId, tracedEvent)
      this.receipts.accept(binding.storyId, tracedEvent)
      this.emit('delivered', { storyId: binding.storyId, event: tracedEvent })
      return { traceId, disposition: 'delivered-to-worker', storyId: binding.storyId }
    } catch (error) {
      // D2-3：把粗粒度 worker-rejected 细分为三类，排障时可区分"worker 明确
      // 拒收"与"等待确认超时/IPC 断开"——真机验收时前者曾掩盖了后者。
      const message = String((error as Error)?.message || error)
      const reason = /超时/.test(message)
        ? 'worker-timeout' as const
        : /未接收|拒绝了入站|HDSI 拒绝/.test(message)
          ? 'worker-rejected' as const
          : 'worker-unavailable' as const
      const record = this.inbox.append(binding.storyId, tracedEvent, reason)
      const size = this.inbox.size(binding.storyId)
      this.emit('queued', { storyId: binding.storyId, record, size })
      return { traceId, disposition: 'queued', storyId: binding.storyId, inboxSize: size, reason }
    } finally {
      if (flightKey) this.inFlight.delete(flightKey)
    }
  }
}

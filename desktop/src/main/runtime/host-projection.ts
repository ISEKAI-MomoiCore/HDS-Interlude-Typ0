import type { StoryManager } from '../stories'
import { InboxRepository } from './inbox-replay'
import type { InboxRecord } from './contracts'
import { LogBroker } from './log-broker'
import { DeliveryOutbox } from './outbox'
import { UsageAggregator, UsageSeriesQuery } from './usage-aggregator'

/**
 * The single read-model boundary for typ-0-owned state. It deliberately knows
 * nothing about HDSI SQLite, provider keys, or arbitrary files.
 */
export class HostProjectionService {
  constructor(
    private readonly stories: StoryManager,
    private readonly inbox: InboxRepository,
    private readonly outbox: DeliveryOutbox,
    private readonly usage: UsageAggregator,
    private readonly logs: LogBroker,
  ) {}

  async overview(storyId: string) {
    const handle = this.stories.get(storyId)
    if (!handle) throw new Error('剧本不存在。')
    const queued = this.inbox.peek(storyId)
    // 审计：未知 reason（手工编辑/旧版本收件箱）不得让计数变 NaN——归入 other 桶。
    const reasons: Record<string, number> = { muted: 0, paused: 0, 'worker-unavailable': 0, 'worker-rejected': 0, 'worker-timeout': 0, other: 0 }
    for (const record of queued) {
      if (record.reason in reasons) reasons[record.reason] += 1
      else reasons.other += 1
    }
    const usage = this.usage.series(storyId, { limit: 2 })
    const currentUsage = usage.at(-1)
    const errors = await this.logs.query({ storyId, levels: ['error'], limit: 3 })
    return {
      storyId,
      phase: handle.meta.phase,
      worker: { running: handle.running, bridgeReady: !!handle.bridgeReady, bridgeProtocol: handle.bridgeProtocol,
        bridgeCapabilities: handle.bridgeCapabilities, runtimeCore: handle.runtimeCore, pid: handle.pid, lastSeenAt: handle.lastSeenAt },
      inbox: { pending: queued.length, reasons, oldestReceivedAt: queued.reduce<string | undefined>((oldest, record) => !oldest || record.receivedAt < oldest ? record.receivedAt : oldest, undefined) },
      outbox: this.outbox.summary(storyId),
      usage: currentUsage ? { day: currentUsage.day, calls: currentUsage.calls, inputTokens: currentUsage.inputTokens, outputTokens: currentUsage.outputTokens, cachedInputTokens: currentUsage.cachedInputTokens, estimatedCost: currentUsage.estimatedCost } : undefined,
      recentErrors: errors.map(record => ({ id: record.id, at: record.at, source: record.source, message: record.message, correlation: record.correlation })),
    }
  }

  deliveries(storyId: string, query?: { limit?: number, before?: string }) {
    if (!this.stories.get(storyId)) throw new Error('剧本不存在。')
    return this.outbox.history(storyId, query)
  }

  usageSeries(storyId: string, query?: UsageSeriesQuery) {
    if (!this.stories.get(storyId)) throw new Error('剧本不存在。')
    return this.usage.series(storyId, query)
  }
}

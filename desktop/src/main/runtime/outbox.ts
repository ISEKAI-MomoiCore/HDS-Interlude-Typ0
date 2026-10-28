import { existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { DeliveryReceipt, DeliveryRecord, DesktopDelivery } from './contracts'
import { readJsonFileOrQuarantine, writeJsonAtomic } from './json-file'

interface OutboxFile { version: 1, records: DeliveryRecord[] }
export interface DeliveryHistoryQuery { limit?: number, before?: string }

/** 审计：投递账本无界增长会让每次投递付出 O(文件) 的同步重写。终态/旧记录
 * 滚动裁剪；pending/sending 等未结记录永不裁掉（补偿依赖它们）。 */
const MAX_RECORDS = 5_000

/**
 * Durable delivery ledger owned by typ-0. HDSI asks for delivery; only the
 * transport receipt turns a record into `sent`. This prevents a generated
 * reply from being mistaken for a message that actually reached QQ/WeChat.
 */
export class DeliveryOutbox {
  constructor(private readonly storiesRoot: string) {}
  /** 性能审计：读侧内存化（load-once + 写穿）。写仍即时落盘——enqueue 的
   * 持久化是跨重启 intentKey 去重的前提，不能合并防抖。history 维护
   * updatedAt 降序索引，查询不再全量重排序。 */
  private readonly states = new Map<string, OutboxFile>()
  /** 审计 H3：剧本删除后重建同 ID 时读缓存必须失效——旧投递记录会以幽灵
   *  形态出现在新剧本的 UI 与统计里。 */
  invalidate(storyId: string) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(storyId)) return
    this.states.delete(storyId)
    this.sortedIndex.delete(storyId)
  }
  private readonly sortedIndex = new Map<string, DeliveryRecord[]>()

  enqueue(storyId: string, delivery: DesktopDelivery) {
    const state = this.read(storyId)
    const existing = state.records.find(record => record.deliveryId === delivery.deliveryId)
    if (existing) return existing
    const now = new Date().toISOString()
    const record: DeliveryRecord = {
      ...delivery,
      storyId,
      state: 'generated',
      attempts: 0,
      createdAt: now,
      updatedAt: now,
    }
    state.records.push(record)
    this.write(storyId, state)
    return record
  }

  markSending(storyId: string, deliveryId: string) {
    return this.update(storyId, deliveryId, record => {
      record.state = 'sending'
      record.attempts += 1
      record.lastError = undefined
    })
  }

  settle(storyId: string, deliveryId: string, receipt: DeliveryReceipt) {
    return this.update(storyId, deliveryId, record => {
      record.state = receipt.status
      record.lastError = receipt.error?.slice(0, 4_000)
      record.messageIds = receipt.messageIds?.slice(0, 32)
      // D2-2：confirmed/accepted/旧 sent 都表示消息已离开本机；unknown 不算。
      if (receipt.status === 'sent' || receipt.status === 'confirmed' || receipt.status === 'accepted') record.sentAt = new Date().toISOString()
    })
  }

  get(storyId: string, deliveryId: string) { return this.read(storyId).records.find(record => record.deliveryId === deliveryId) }

  /** P1-1：按业务幂等键查最近一条记录（取 updatedAt 最新）。跨 deliveryId 去重用。 */
  findByIntentKey(storyId: string, intentKey: string) {
    return this.sorted(storyId).find(record => record.intentKey === intentKey)
  }
  recent(storyId: string, limit = 100) { return this.read(storyId).records.slice(-Math.max(1, limit)) }

  /** Newest-first, read-only history for GUI projections; cursor is ID or ISO time. */
  history(storyId: string, query: DeliveryHistoryQuery = {}) {
    // P2 输入边界：NaN/非数值 limit 归默认（与 log-broker.query 同款防线）。
    const rawLimit = Number(query.limit)
    const limit = Math.max(1, Math.min(Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : 100, 500))
    let records = this.sorted(storyId).slice()
    if (query.before) {
      const cursor = records.findIndex(record => record.deliveryId === query.before)
      if (cursor >= 0) records = records.slice(cursor + 1)
      else if (!Number.isNaN(Date.parse(query.before))) records = records.filter(record => Date.parse(record.updatedAt) < Date.parse(query.before!))
    }
    return records.slice(0, limit).map(record => ({ ...record, messageIds: record.messageIds?.slice() }))
  }

  summary(storyId: string) {
    const records = this.sorted(storyId)
    const states = { generated: 0, sending: 0, sent: 0, confirmed: 0, accepted: 0, unknown: 0, 'retryable-failed': 0, 'permanent-failed': 0 } as Record<DeliveryRecord['state'], number>
    for (const record of records) states[record.state] += 1
    const latest = records[0]
    const latestFailure = records.find(record => record.state.endsWith('failed'))
    return {
      total: records.length, states, latestAt: latest?.updatedAt,
      latestFailure: latestFailure ? { deliveryId: latestFailure.deliveryId, at: latestFailure.updatedAt, error: latestFailure.lastError } : undefined,
    }
  }

  private update(storyId: string, deliveryId: string, change: (record: DeliveryRecord) => void) {
    const state = this.read(storyId)
    const record = state.records.find(item => item.deliveryId === deliveryId)
    if (!record) return undefined
    change(record)
    record.updatedAt = new Date().toISOString()
    this.write(storyId, state)
    return record
  }

  private file(storyId: string) { return path.join(this.storiesRoot, storyId, 'data', 'outbox.json') }
  private read(storyId: string): OutboxFile {
    const cached = this.states.get(storyId)
    if (cached) return cached
    const file = this.file(storyId)
    let state: OutboxFile = { version: 1, records: [] }
    if (existsSync(file)) {
      // 审计：损坏的 outbox.json 此前静默读作空表，下一次 write 把全部历史永久
      // 覆盖——改为隔离坏文件（人工可恢复）再返回空表。
      const raw = readJsonFileOrQuarantine<OutboxFile>(file, { version: 1, records: [] })
      state = raw.version === 1 && Array.isArray(raw.records) ? raw : { version: 1, records: [] }
    }
    this.states.set(storyId, state)
    return state
  }
  private write(storyId: string, state: OutboxFile) {
    if (state.records.length > MAX_RECORDS) {
      const active = state.records.filter(record => record.state === 'generated' || record.state === 'sending')
      const settled = state.records.filter(record => record.state !== 'generated' && record.state !== 'sending')
      state.records = [...active, ...settled.slice(Math.max(0, settled.length - (MAX_RECORDS - active.length)))]
    }
    this.states.set(storyId, state)
    this.sortedIndex.delete(storyId)
    mkdirSync(path.dirname(this.file(storyId)), { recursive: true })
    writeJsonAtomic(this.file(storyId), state)
  }

  /** updatedAt 降序索引（写入时失效，懒重建）——history/summary 不再每次全量排序。 */
  private sorted(storyId: string): DeliveryRecord[] {
    let index = this.sortedIndex.get(storyId)
    if (!index) {
      index = this.read(storyId).records.slice().sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.deliveryId.localeCompare(left.deliveryId))
      this.sortedIndex.set(storyId, index)
    }
    return index
  }
}

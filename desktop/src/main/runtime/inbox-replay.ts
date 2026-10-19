import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { DesktopInboundEvent, InboxRecord, inboundIdempotencyKey } from './contracts'
import { readJsonFileOrQuarantine, writeJsonAtomic } from './json-file'

interface InboxFile { version: 1, records: InboxRecord[] }

/** 持久化的离线收件箱；只在 worker 明确确认回放成功后删除记录。 */
export class InboxRepository {
  constructor(private readonly storiesRoot: string) {}

  append(storyId: string, event: DesktopInboundEvent, reason: InboxRecord['reason']) {
    const state = this.read(storyId)
    const key = inboundIdempotencyKey(event)
    // Only a transport-issued stable message ID can suppress a duplicate.
    // Identical text in two real user messages must remain two records.
    if (key) {
      const duplicate = state.records.find(record => inboundIdempotencyKey(record.event) === key)
      if (duplicate) return duplicate
    }
    const record: InboxRecord = {
      id: randomUUID(), traceId: event.traceId, event, reason, receivedAt: new Date().toISOString(), attempts: 0,
    }
    state.records.push(record)
    this.write(storyId, state)
    return record
  }

  peek(storyId: string) { return this.read(storyId).records }
  size(storyId: string) { return this.read(storyId).records.length }

  markAttempt(storyId: string, ids: string[], error?: string) {
    const state = this.read(storyId)
    const wanted = new Set(ids)
    for (const record of state.records) {
      if (!wanted.has(record.id)) continue
      record.attempts += 1
      record.lastAttemptAt = new Date().toISOString()
      record.lastError = error
    }
    this.write(storyId, state)
  }

  acknowledge(storyId: string, ids: string[]) {
    const state = this.read(storyId)
    const wanted = new Set(ids)
    const removed = state.records.filter(record => wanted.has(record.id)).length
    if (removed) {
      state.records = state.records.filter(record => !wanted.has(record.id))
      this.write(storyId, state)
    }
    return removed
  }

  private file(storyId: string) { return path.join(this.storiesRoot, storyId, 'data', 'inbox.json') }
  private read(storyId: string): InboxFile {
    const file = this.file(storyId)
    if (!existsSync(file)) return { version: 1, records: [] }
    // 审计：损坏文件静默空表会被下一次写覆盖（与 outbox 同病）——隔离坏文件。
    const raw = readJsonFileOrQuarantine<InboxFile | unknown[]>(file, { version: 1, records: [] })
    // 迁移旧版纯消息数组；只在此处兼容，之后统一为可确认的 record。
    if (Array.isArray(raw)) {
      return {
        version: 1,
        records: raw.map((legacy: any, index) => ({
          id: createHash('sha256').update(`${storyId}:${index}:${JSON.stringify(legacy)}`).digest('hex').slice(0, 32),
          traceId: typeof legacy.traceId === 'string' ? legacy.traceId : undefined,
          event: {
            transport: 'sandbox', accountKey: `legacy:${legacy.senderId || 'unknown'}`, platform: 'legacy', selfId: 'legacy',
            senderId: String(legacy.senderId || 'unknown'), senderName: legacy.senderName, channelId: legacy.groupId,
            kind: legacy.kind === 'group' ? 'group' : 'private', content: String(legacy.content || ''),
            occurredAt: legacy.occurredAt || new Date(0).toISOString(),
            ...(typeof legacy.traceId === 'string' ? { traceId: legacy.traceId } : {}),
          },
          receivedAt: legacy.occurredAt || new Date(0).toISOString(), reason: 'paused', attempts: 0,
        })),
      }
    }
    if (raw && (raw as InboxFile).version === 1 && Array.isArray((raw as InboxFile).records)) {
      const state = raw as InboxFile
      return {
        version: 1,
        records: state.records.map(record => ({
          ...record,
          traceId: record.traceId ?? record.event?.traceId,
        })),
      }
    }
    return { version: 1, records: [] }
  }
  private write(storyId: string, state: InboxFile) {
    const dir = path.dirname(this.file(storyId))
    mkdirSync(dir, { recursive: true })
    writeJsonAtomic(this.file(storyId), state)
  }
}

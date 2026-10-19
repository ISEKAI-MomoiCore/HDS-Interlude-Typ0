import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { DesktopInboundEvent, inboundIdempotencyKey } from './contracts'
import { readJsonFile, writeJsonAtomic } from './json-file'

interface LedgerFile { version: 1, keys: Array<{ key: string, acceptedAt: string }> }

/** Durable exact-ID receipt ledger. It never compares message text, so ordinary repeated sentences remain valid turns. */
export class InboundReceiptLedger {
  private readonly cache = new Map<string, LedgerFile>()
  private readonly limit = 5_000

  constructor(private readonly storiesRoot: string) {}

  has(storyId: string, event: DesktopInboundEvent) {
    const key = inboundIdempotencyKey(event)
    return !!key && this.read(storyId).keys.some(entry => entry.key === key)
  }

  accept(storyId: string, event: DesktopInboundEvent) {
    const key = inboundIdempotencyKey(event)
    if (!key) return false
    const state = this.read(storyId)
    if (state.keys.some(entry => entry.key === key)) return false
    state.keys.push({ key, acceptedAt: new Date().toISOString() })
    if (state.keys.length > this.limit) state.keys.splice(0, state.keys.length - this.limit)
    this.write(storyId, state)
    return true
  }

  private file(storyId: string) { return path.join(this.storiesRoot, storyId, 'data', 'inbound-receipts.json') }
  private read(storyId: string) {
    const cached = this.cache.get(storyId)
    if (cached) return cached
    const state = readJsonFile<LedgerFile>(this.file(storyId), { version: 1, keys: [] })
    const normalized: LedgerFile = state.version === 1 && Array.isArray(state.keys)
      ? { version: 1, keys: state.keys.filter(item => item && typeof item.key === 'string' && typeof item.acceptedAt === 'string').slice(-this.limit) }
      : { version: 1, keys: [] }
    this.cache.set(storyId, normalized)
    return normalized
  }
  private write(storyId: string, state: LedgerFile) {
    mkdirSync(path.dirname(this.file(storyId)), { recursive: true })
    writeJsonAtomic(this.file(storyId), state)
  }
}

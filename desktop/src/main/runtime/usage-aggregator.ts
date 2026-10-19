import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { readJsonFile, writeJsonAtomic } from './json-file'

export interface TokenUsageEvent {
  task: string
  providerLabel: string
  model: string
  inputTokens?: number
  outputTokens?: number
  cachedInputTokens?: number
  priceInput?: number
  priceOutput?: number
  priceCachedInput?: number
}

interface UsageDay {
  calls: number
  inputTokens: number
  outputTokens: number
  cachedInputTokens: number
  estimatedCost?: number
  tasks: Record<string, number>
}
interface UsageFile { version: 1, storyId: string, updatedAt: string, days: Record<string, UsageDay> }
export interface UsageSeriesQuery { from?: string, to?: string, limit?: number, granularity?: 'day' }
export interface UsageSeriesPoint extends UsageDay { day: string }

const cleanNumber = (value: unknown) => Math.max(0, Number.isFinite(Number(value)) ? Number(value) : 0)
const safeStoryId = (id: string) => /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(id)

/** Per-story, per-day token accounting; model payloads and API keys are never stored. */
export class UsageAggregator {
  private readonly dayFormatter: Intl.DateTimeFormat

  /**
   * Usage is a user-facing daily figure, so it follows the desktop host's
   * timezone instead of silently rolling over at UTC midnight.
   */
  constructor(private readonly dataRoot: string, timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC') {
    mkdirSync(path.join(dataRoot, 'usage'), { recursive: true })
    this.dayFormatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    })
  }

  record(storyId: string, event: TokenUsageEvent, now = new Date()) {
    if (!safeStoryId(storyId)) throw new Error('无效剧本 ID，拒绝写入用量文件。')
    const file = this.file(storyId)
    const state = readJsonFile<UsageFile>(file, { version: 1, storyId, updatedAt: '', days: {} })
    const pieces = this.dayFormatter.formatToParts(now)
    const part = (type: string) => pieces.find(item => item.type === type)?.value || '00'
    const dayKey = `${part('year')}-${part('month')}-${part('day')}`
    const day = state.days[dayKey] ?? { calls: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, tasks: {} }
    const input = cleanNumber(event.inputTokens)
    const output = cleanNumber(event.outputTokens)
    const cached = Math.min(input, cleanNumber(event.cachedInputTokens))
    day.calls += 1
    day.inputTokens += input
    day.outputTokens += output
    day.cachedInputTokens += cached
    day.tasks[String(event.task || 'unknown').slice(0, 64)] = (day.tasks[String(event.task || 'unknown').slice(0, 64)] ?? 0) + 1
    const cost = (input - cached) * cleanNumber(event.priceInput) / 1_000_000
      + cached * cleanNumber(event.priceCachedInput || event.priceInput) / 1_000_000
      + output * cleanNumber(event.priceOutput) / 1_000_000
    if (cost > 0 || day.estimatedCost != null) day.estimatedCost = (day.estimatedCost ?? 0) + cost
    state.days[dayKey] = day
    state.updatedAt = now.toISOString()
    writeJsonAtomic(file, state)
    return state
  }

  /** Read-only daily series. The stored day keys already follow the host timezone. */
  series(storyId: string, query: UsageSeriesQuery = {}) {
    if (!safeStoryId(storyId)) throw new Error('无效剧本 ID，拒绝读取用量文件。')
    const state = readJsonFile<UsageFile>(this.file(storyId), { version: 1, storyId, updatedAt: '', days: {} })
    const limit = Math.max(1, Math.min(query.limit ?? 90, 366))
    if (query.granularity && query.granularity !== 'day') throw new Error('当前仅支持按日聚合用量。')
    const from = query.from?.slice(0, 10); const to = query.to?.slice(0, 10)
    return Object.entries(state.days)
      .filter(([day]) => (!from || day >= from) && (!to || day <= to))
      .sort(([left], [right]) => left.localeCompare(right))
      .slice(-limit)
      .map(([day, value]) => ({ day, calls: value.calls, inputTokens: value.inputTokens, outputTokens: value.outputTokens, cachedInputTokens: value.cachedInputTokens, estimatedCost: value.estimatedCost, tasks: { ...value.tasks } }))
  }

  private file(storyId: string) { return path.join(this.dataRoot, 'usage', `${storyId}.json`) }
}

import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

/** A host-side record. `at` is when typ-0 observed the event, never story time. */
export type DesktopLogLevel = 'debug' | 'info' | 'warn' | 'error'
export type DesktopLogSource = 'desktop' | 'worker' | 'bridge' | 'router' | 'delivery' | 'channel' | 'koishi'

export interface DesktopLogRecord {
  id: string
  at: string
  storyId?: string
  level: DesktopLogLevel
  source: DesktopLogSource
  logger?: string
  message: string
  correlation?: {
    traceId?: string
    processingId?: string
    requestId?: string
    inboundId?: string
    deliveryId?: string
    entityId?: string
  }
}

export interface DesktopLogInput extends Omit<DesktopLogRecord, 'id' | 'at'> {
  at?: string
}

export interface DesktopLogQuery {
  storyId?: string
  from?: string
  to?: string
  levels?: DesktopLogLevel[]
  sources?: DesktopLogSource[]
  logger?: string
  search?: string
  /** Matches any request/inbound/delivery/entity correlation value. */
  correlationId?: string
  /** A prior record ID or ISO timestamp. Results before it are returned. */
  before?: string
  limit?: number
}

const levels = new Set<DesktopLogLevel>(['debug', 'info', 'warn', 'error'])
const sources = new Set<DesktopLogSource>(['desktop', 'worker', 'bridge', 'router', 'delivery', 'channel', 'koishi'])

/**
 * Blind/隐私规则：把消息正文替换为宿主摘要后返回。规则只在导出/查询边界生效，
 * 落盘原文保留（M5 边界：落盘加密留待后续），导出文件则绝不携带被屏蔽正文。
 */
export type BlindRule = (record: DesktopLogRecord) => string | undefined

export interface LogStorageStats {
  directories: number
  files: number
  bytes: number
  oldestDay?: string
  newestDay?: string
}

function validDate(value: string | undefined) {
  if (!value) return undefined
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) ? timestamp : undefined
}

function utcDay(at: string) {
  return at.slice(0, 10)
}

function storyDirectory(storyId?: string) {
  // Story IDs are locally generated, but do not let an imported malformed ID affect a path.
  return storyId && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(storyId) ? storyId : '_desktop'
}

function isRecord(value: unknown): value is DesktopLogRecord {
  if (!value || typeof value !== 'object') return false
  const item = value as Partial<DesktopLogRecord>
  return typeof item.id === 'string' && typeof item.at === 'string'
    && typeof item.message === 'string' && levels.has(item.level as DesktopLogLevel)
    && sources.has(item.source as DesktopLogSource)
}

/**
 * Batches host logs to NDJSON. `record()` never awaits filesystem work: router and
 * worker callbacks can continue immediately while a later micro-batch is appended.
 */
export class LogBroker {
  private readonly root: string
  private readonly memoryLimit: number
  private readonly flushDelayMs: number
  private readonly maxFileBytes: number
  private readonly retentionDays: number
  private readonly maxPartsPerDay: number
  private readonly maxTotalBytes: number
  private memory: DesktopLogRecord[] = []
  private pending: DesktopLogRecord[] = []
  private timer: NodeJS.Timeout | undefined
  private writing: Promise<void> | undefined
  private blind: BlindRule | undefined

  constructor(dataRoot: string, options: { memoryLimit?: number, flushDelayMs?: number, maxFileBytes?: number, retentionDays?: number, maxPartsPerDay?: number, maxTotalBytes?: number } = {}) {
    this.root = path.join(dataRoot, 'logs')
    this.memoryLimit = Math.max(1, options.memoryLimit ?? 2_000)
    this.flushDelayMs = Math.max(0, options.flushDelayMs ?? 250)
    this.maxFileBytes = Math.max(64 * 1024, options.maxFileBytes ?? 8 * 1024 * 1024)
    this.retentionDays = Math.max(1, options.retentionDays ?? 14)
    this.maxPartsPerDay = Math.max(1, Math.floor(options.maxPartsPerDay ?? 12))
    this.maxTotalBytes = Math.max(this.maxFileBytes, Math.floor(options.maxTotalBytes ?? 256 * 1024 * 1024))
  }

  /** 宿主进程在启用 Blind 模式时注入；查询/导出会隐藏命中规则的正文。 */
  setBlindRule(rule: BlindRule | undefined) { this.blind = rule }

  private applyBlind(record: DesktopLogRecord): DesktopLogRecord {
    if (!this.blind) return record
    const masked = this.blind(record)
    return masked === undefined ? record : { ...record, message: masked }
  }

  record(input: DesktopLogInput): DesktopLogRecord {
    const suppliedAt = validDate(input.at)
    const record: DesktopLogRecord = {
      id: randomUUID(),
      at: suppliedAt === undefined ? new Date().toISOString() : new Date(suppliedAt).toISOString(),
      storyId: input.storyId || undefined,
      level: levels.has(input.level) ? input.level : 'info',
      source: sources.has(input.source) ? input.source : 'desktop',
      logger: input.logger || undefined,
      // Preserve raw text: presentation truncation belongs exclusively to Renderer.
      message: String(input.message ?? ''),
      correlation: input.correlation && Object.keys(input.correlation).length ? { ...input.correlation } : undefined,
    }
    this.memory.push(record)
    if (this.memory.length > this.memoryLimit) this.memory.splice(0, this.memory.length - this.memoryLimit)
    this.pending.push(record)
    this.scheduleFlush()
    return record
  }

  /** Returns a copy so a caller cannot mutate the broker's ring buffer. */
  recent(limit = 200) {
    return this.memory.slice(-Math.max(1, Math.min(limit, this.memoryLimit))).map(record => ({ ...record, correlation: record.correlation && { ...record.correlation } }))
  }

  async drain() {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    // A record can arrive while an append is in progress. Keep draining until it
    // has been included in a batch; app shutdown must not depend on the timer.
    while (this.pending.length || this.writing) await this.flush()
  }

  async query(query: DesktopLogQuery = {}) {
    // P2 输入边界：NaN/非数值 limit 归默认（此前 NaN 会静默切片出空结果）。
    const rawLimit = Number(query.limit)
    const limit = Math.max(1, Math.min(Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : 500, 2_000))
    const disk = await this.readDisk(query)
    const combined = new Map<string, DesktopLogRecord>()
    for (const record of [...disk, ...this.memory]) combined.set(record.id, record)
    let records = [...combined.values()].filter(record => this.matches(record, query))
    records.sort((left, right) => right.at.localeCompare(left.at) || right.id.localeCompare(left.id))
    if (query.before) {
      const cursorIndex = records.findIndex(record => record.id === query.before)
      if (cursorIndex >= 0) records = records.slice(cursorIndex + 1)
      else {
        const beforeAt = validDate(query.before)
        if (beforeAt !== undefined) records = records.filter(record => Date.parse(record.at) < beforeAt)
      }
    }
    return records.slice(0, limit).map(record => this.applyBlind({ ...record, correlation: record.correlation && { ...record.correlation } }))
  }

  /**
   * 将某个故事（或全部）在时间范围内的日志导出为新文件。导出前应用 Blind 规则；
   * 永远写新文件，不修改原 NDJSON。
   */
  async exportLogs(options: { storyId?: string, from?: string, to?: string, target: string }) {
    const records = await this.query({ storyId: options.storyId, from: options.from, to: options.to, limit: 2_000 })
    const lines = records.map(record => JSON.stringify(this.applyBlind(record))).join('\n')
    const body = lines ? `${lines}\n` : ''
    await mkdir(path.dirname(options.target), { recursive: true })
    await writeFile(options.target, body, { encoding: 'utf8', flag: 'wx' })
    return { target: options.target, records: records.length, bytes: Buffer.byteLength(body) }
  }

  /** 按日保留策略清理旧日志；返回被移除的目录/文件数。只触碰本 broker 自己的根目录。 */
  /** 保留策略三件事：按天过期、单日 part 数量上限（防高频日志日无限轮转；
   * 上限按"目录 × 日"统计——跨目录合并会让两个各自合法的故事目录互相删文件）、
   * 全目录总容量预算（超限时从最旧的"天"开始整日删除，豁免当天正在写的文件）。
   * 返回值供接线方记诊断日志。 */
  async applyRetention(now = new Date()) {
    const today = now.toISOString().slice(0, 10)
    const cutoff = new Date(now.getTime() - this.retentionDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
    let removed = 0
    type Entry = { file: string, day: string, part?: number, size: number }
    const survivors: Entry[] = []
    for (const directory of await this.listStoryDirectories()) {
      const folder = path.join(this.root, directory)
      const files = (await readdir(folder).catch(() => [] as string[])).filter(file => file.endsWith('.ndjson'))
      const dirSurvivors: Entry[] = []
      for (const file of files) {
        const stem = file.slice(0, -'.ndjson'.length)
        const day = stem.slice(0, 10)
        if (day < cutoff) {
          await rm(path.join(folder, file), { force: true }).then(() => { removed += 1 }, () => undefined)
          continue
        }
        const part = stem.startsWith(`${day}.part`) ? Number(stem.slice(`${day}.part`.length)) : NaN
        const info = await stat(path.join(folder, file)).catch(() => undefined)
        dirSurvivors.push({ file: path.join(folder, file), day, part: Number.isFinite(part) ? part : undefined, size: info?.size ?? 0 })
      }
      // 单日 part 上限（目录内独立统计）：保留最新 N 个 part，更旧的删除。
      const partsByDay = new Map<string, number[]>()
      for (const entry of dirSurvivors) {
        if (entry.part === undefined) continue
        const parts = partsByDay.get(entry.day) ?? []
        parts.push(entry.part)
        partsByDay.set(entry.day, parts)
      }
      for (const [day, parts] of partsByDay) {
        if (parts.length <= this.maxPartsPerDay) continue
        const drop = new Set(parts.sort((a, b) => a - b).slice(0, parts.length - this.maxPartsPerDay))
        for (let index = dirSurvivors.length - 1; index >= 0; index -= 1) {
          const entry = dirSurvivors[index]
          if (entry.day !== day || entry.part === undefined || !drop.has(entry.part)) continue
          await rm(entry.file, { force: true }).then(() => { removed += 1 }, () => undefined)
          dirSurvivors.splice(index, 1)
        }
      }
      survivors.push(...dirSurvivors)
    }
    // 总容量预算：按天从旧到新整日删除，直到回到预算内；当天文件豁免。
    let totalBytes = survivors.reduce((sum, entry) => sum + entry.size, 0)
    if (totalBytes > this.maxTotalBytes) {
      const days = [...new Set(survivors.map(entry => entry.day))].sort()
      for (const day of days) {
        if (totalBytes <= this.maxTotalBytes) break
        if (day >= today) break
        for (let index = survivors.length - 1; index >= 0; index -= 1) {
          const entry = survivors[index]
          if (entry.day !== day) continue
          await rm(entry.file, { force: true }).then(() => { removed += 1 }, () => undefined)
          survivors.splice(index, 1)
          totalBytes -= entry.size
        }
      }
    }
    return { removed }
  }

  async storageStats(): Promise<LogStorageStats> {
    const stats: LogStorageStats = { directories: 0, files: 0, bytes: 0 }
    for (const directory of await this.listStoryDirectories()) {
      const folder = path.join(this.root, directory)
      const files = (await readdir(folder).catch(() => [] as string[])).filter(file => file.endsWith('.ndjson'))
      if (!files.length) continue
      stats.directories += 1
      for (const file of files) {
        stats.files += 1
        const info = await stat(path.join(folder, file)).catch(() => undefined)
        if (info) stats.bytes += info.size
        stats.oldestDay = !stats.oldestDay || file < stats.oldestDay ? file.slice(0, 10) : stats.oldestDay
        stats.newestDay = !stats.newestDay || file > stats.newestDay ? file.slice(0, 10) : stats.newestDay
      }
    }
    return stats
  }

  /**
   * 轮转当天已超过大小上限的 NDJSON：把当前文件改名为 <day>.partN，后续写入
   * 重新开始。查询仍会读取所有 part 文件，轮转不产生可读性断层。
   */
  private async rotateIfNeeded(directory: string, day: string) {
    const folder = path.join(this.root, directory)
    const current = path.join(folder, `${day}.ndjson`)
    const info = await stat(current).catch(() => undefined)
    if (!info || info.size < this.maxFileBytes) return
    const existing = await readdir(folder).catch(() => [] as string[])
    const part = existing.filter(file => file.startsWith(`${day}.part`) && file.endsWith('.ndjson'))
      .map(file => Number(file.slice(`${day}.part`.length, -'.ndjson'.length)))
      .filter(Number.isFinite)
    const next = (part.length ? Math.max(...part) : 0) + 1
    // Rename is atomic within a volume: no window where a record could be
    // appended twice or lost between copy and delete.
    await rename(current, path.join(folder, `${day}.part${next}.ndjson`)).catch(() => undefined)
  }

  private scheduleFlush() {
    if (this.timer || this.writing) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.flush()
    }, this.flushDelayMs)
  }

  private async flush() {
    if (this.writing) return this.writing
    this.writing = this.writePending().finally(() => {
      this.writing = undefined
      if (this.pending.length) this.scheduleFlush()
    })
    return this.writing
  }

  private async writePending() {
    // Take one batch. New records remain queued and are scheduled in finally().
    const batch = this.pending.splice(0)
    if (!batch.length) return
    const groups = new Map<string, DesktopLogRecord[]>()
    for (const record of batch) {
      const key = `${storyDirectory(record.storyId)}/${utcDay(record.at)}`
      const records = groups.get(key) || []
      records.push(record)
      groups.set(key, records)
    }
    await Promise.all([...groups.entries()].map(async ([key, records]) => {
      const [directory, day] = key.split('/')
      const folder = path.join(this.root, directory)
      await mkdir(folder, { recursive: true })
      await appendFile(path.join(folder, `${day}.ndjson`), `${records.map(record => JSON.stringify(record)).join('\n')}\n`, 'utf8')
      // A single micro-batch can push a file past the cap by itself, so the
      // rotation decision belongs after the append, not before it.
      await this.rotateIfNeeded(directory, day)
    }))
  }

  private async readDisk(query: DesktopLogQuery) {
    const requested = query.storyId ? [storyDirectory(query.storyId)] : await this.listStoryDirectories()
    const from = validDate(query.from)
    const to = validDate(query.to)
    const allowedDays = !query.from && !query.to ? new Set([utcDay(new Date().toISOString())]) : undefined
    const records: DesktopLogRecord[] = []
    await Promise.all(requested.map(async directory => {
      let files: string[]
      try { files = await readdir(path.join(this.root, directory)) } catch { return }
      await Promise.all(files.filter(file => file.endsWith('.ndjson')).map(async file => {
        const day = file.slice(0, -'.ndjson'.length).split('.part')[0]
        if (allowedDays && !allowedDays.has(day)) return
        let source: string
        try { source = await readFile(path.join(this.root, directory, file), 'utf8') } catch { return }
        for (const line of source.split('\n')) {
          if (!line.trim()) continue
          try {
            const record = JSON.parse(line)
            if (!isRecord(record)) continue
            const at = Date.parse(record.at)
            if ((from !== undefined && at < from) || (to !== undefined && at > to)) continue
            records.push(record)
          } catch {
            // A partial/corrupt trailing line must not make a historical log unreadable.
          }
        }
      }))
    }))
    return records
  }

  private async listStoryDirectories() {
    try {
      const entries = await readdir(this.root, { withFileTypes: true })
      return entries.filter(entry => entry.isDirectory()).map(entry => entry.name)
    } catch { return [] }
  }

  private matches(record: DesktopLogRecord, query: DesktopLogQuery) {
    if (query.storyId && record.storyId !== query.storyId) return false
    const from = validDate(query.from); const to = validDate(query.to); const at = Date.parse(record.at)
    if ((from !== undefined && at < from) || (to !== undefined && at > to)) return false
    if (query.levels?.length && !query.levels.includes(record.level)) return false
    if (query.sources?.length && !query.sources.includes(record.source)) return false
    if (query.logger && record.logger !== query.logger) return false
    if (query.search && !`${record.logger || ''}\n${record.message}`.toLowerCase().includes(query.search.toLowerCase())) return false
    if (query.correlationId && !Object.values(record.correlation || {}).includes(query.correlationId)) return false
    return true
  }
}

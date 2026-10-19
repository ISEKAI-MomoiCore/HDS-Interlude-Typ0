/**
 * typ-0's read model deliberately receives a projection from the HDSI worker
 * bridge. This is a read-only query of HDSI's live SQLite connection, so it
 * sees WAL state without a second native SQLite addon or a competing writer.
 *
 * The renderer never receives a database handle and the desktop main process
 * never performs SQL UPDATE/DELETE. A later offline inspector may implement a
 * separate read-only WAL backend behind this same normalizer.
 */
/** Protocol 4 投影注解：剧本行动身份与投递账本事实，全部只读。 */
export interface DeliveryActionSummary {
  eventId: string
  eventKind: string
  status: string
  segments: Array<{ kind: string, status: string, content: string }>
}

export interface SceneCheckpointView {
  sceneId: number
  startedAt: string
  endedAt?: string
  reason?: string
  firstEntryId?: number
  lastEntryId?: number
  boundarySourceEntryIds?: number[]
}

export interface TimelineEntryView {
  entityId: string
  id: number
  storyId: string
  participantId: string
  kind: string
  actor: string
  content: string
  occurredAt: string
  track: 'script' | 'messages' | 'system'
  startedAt?: string
  endedAt?: string
  commitId?: string
  deliveryActions?: DeliveryActionSummary[]
  sceneCheckpoint?: SceneCheckpointView
  imageCount?: number
  audioCount?: number
  alterValue?: number
  alterOffset?: string
}

export interface AlterDesktopView {
  value: number
  alterWeight: number
  emotionalOffset: { direction: string, intensity: number, description: string } | null
  lastUpdatedAt: string
  history: Array<{ value: number, alter: number, at: string }>
}

export interface CompactionDesktopView {
  activeSceneId: number
  sceneHook: string
  entryCount: number
  lastCompactionAt: string
  isDirty: boolean
}

export interface SceneView {
  id: number
  status: string
  startedAt: string
  endedAt?: string
  hook: string
  summary: string
  entryCount: number
}

export interface FactView {
  id: number
  scope: string
  content: string
  importance: number
  confidence: number
  unresolved: boolean
  updatedAt: string
}

export interface StoryTimelineSnapshot {
  desktopStoryId: string
  storyId: string
  cursorAt?: string
  updatedAt?: string
  timezone?: string
  phase?: string
  entries: TimelineEntryView[]
  scenes: SceneView[]
  facts: FactView[]
  preplan?: { revision: number, timezone: string, validFrom: string, validThrough: string, materializedDays: unknown }
  alter?: AlterDesktopView
  compaction?: CompactionDesktopView
}

export interface StoryTimelineRange extends StoryTimelineSnapshot {
  protocol: number
  revision: string
  range: { from: string, to: string }
  nextCursor?: string
}

function stringValue(value: unknown) { return typeof value === 'string' ? value : '' }
function numberValue(value: unknown) { return Number.isFinite(Number(value)) ? Number(value) : 0 }
function safeJson(value: unknown, depth = 0): unknown {
  if (depth > 5) return '[truncated]'
  if (typeof value === 'string') return value.slice(0, 2_000)
  if (typeof value === 'number' || typeof value === 'boolean' || value == null) return value
  if (Array.isArray(value)) return value.slice(0, 128).map(item => safeJson(item, depth + 1))
  if (typeof value === 'object') {
    const result: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 64)) result[String(key).slice(0, 128)] = safeJson(item, depth + 1)
    return result
  }
  return String(value).slice(0, 2_000)
}

function entryTrack(value: unknown): TimelineEntryView['track'] {
  const entry = value as { kind?: unknown, actor?: unknown }
  if (entry.kind === 'script' || entry.actor === 'narrator') return 'script'
  return /message|chat|reply/u.test(String(entry.kind || '')) ? 'messages' : 'system'
}

function normalizeDeliveryActions(value: unknown): DeliveryActionSummary[] | undefined {
  if (!Array.isArray(value)) return undefined
  const items = value
    .filter((item): item is Record<string, unknown> => !!item && typeof item === 'object' && typeof (item as any).eventId === 'string')
    .map(item => ({
      eventId: String(item.eventId),
      eventKind: typeof item.eventKind === 'string' ? item.eventKind : 'outgoing-message',
      status: typeof item.status === 'string' ? item.status : 'pending',
      segments: Array.isArray(item.segments)
        ? (item.segments as any[]).filter(seg => seg && typeof seg.content === 'string' && typeof seg.status === 'string')
          .map(seg => ({ kind: typeof seg.kind === 'string' ? seg.kind : 'message', status: String(seg.status), content: String(seg.content) }))
        : [],
    }))
    .filter(item => item.segments.length)
  return items.length ? items : undefined
}

function normalizeSceneCheckpoint(value: unknown): SceneCheckpointView | undefined {
  if (!value || typeof value !== 'object') return undefined
  const checkpoint = value as Record<string, unknown>
  const sceneId = Number(checkpoint.sceneId)
  if (!Number.isSafeInteger(sceneId) || typeof checkpoint.startedAt !== 'string') return undefined
  const startedAt = new Date(checkpoint.startedAt)
  if (Number.isNaN(startedAt.getTime())) return undefined
  const endedAt = typeof checkpoint.endedAt === 'string' && !Number.isNaN(Date.parse(checkpoint.endedAt)) ? new Date(checkpoint.endedAt).toISOString() : undefined
  const toInt = (input: unknown) => {
    const n = Number(input)
    return Number.isSafeInteger(n) ? n : undefined
  }
  return {
    sceneId,
    startedAt: startedAt.toISOString(),
    ...(endedAt ? { endedAt } : {}),
    ...(typeof checkpoint.reason === 'string' ? { reason: checkpoint.reason } : {}),
    ...(toInt(checkpoint.firstEntryId) !== undefined ? { firstEntryId: toInt(checkpoint.firstEntryId) } : {}),
    ...(toInt(checkpoint.lastEntryId) !== undefined ? { lastEntryId: toInt(checkpoint.lastEntryId) } : {}),
    ...(Array.isArray(checkpoint.boundarySourceEntryIds)
      ? { boundarySourceEntryIds: (checkpoint.boundarySourceEntryIds as unknown[]).map(toInt).filter((n): n is number => n !== undefined) } : {}),
  }
}

function normalizeEntry(entry: any): TimelineEntryView {
  const occurredAt = stringValue(entry?.occurredAt)
  return {
    entityId: stringValue(entry?.entityId) || `entry:${numberValue(entry?.id)}`,
    id: numberValue(entry?.id), storyId: stringValue(entry?.storyId), participantId: stringValue(entry?.participantId),
    kind: stringValue(entry?.kind), actor: stringValue(entry?.actor), content: stringValue(entry?.content), occurredAt,
    track: entryTrack(entry), startedAt: entry?.startedAt ? stringValue(entry.startedAt) : occurredAt || undefined,
    endedAt: entry?.endedAt ? stringValue(entry.endedAt) : undefined,
    ...(typeof entry?.commitId === 'string' && entry.commitId ? { commitId: entry.commitId } : {}),
    ...(normalizeDeliveryActions(entry?.deliveryActions) ? { deliveryActions: normalizeDeliveryActions(entry?.deliveryActions) } : {}),
    ...(normalizeSceneCheckpoint(entry?.sceneCheckpoint) ? { sceneCheckpoint: normalizeSceneCheckpoint(entry?.sceneCheckpoint) } : {}),
    ...(typeof entry?.imageCount === 'number' && entry.imageCount > 0 ? { imageCount: entry.imageCount } : {}),
    ...(typeof entry?.audioCount === 'number' && entry.audioCount > 0 ? { audioCount: entry.audioCount } : {}),
    ...(typeof entry?.alterValue === 'number' ? { alterValue: entry.alterValue } : {}),
    ...(typeof entry?.alterOffset === 'string' && entry.alterOffset ? { alterOffset: entry.alterOffset } : {}),
  }
}

/** Defensive boundary for untrusted child-process IPC. */
export function normalizeTimelineSnapshot(value: any): StoryTimelineSnapshot {
  return {
    desktopStoryId: stringValue(value?.desktopStoryId), storyId: stringValue(value?.storyId), cursorAt: value?.cursorAt ? stringValue(value.cursorAt) : undefined,
    updatedAt: value?.updatedAt ? stringValue(value.updatedAt) : undefined, timezone: value?.timezone ? stringValue(value.timezone) : undefined,
    phase: value?.phase ? stringValue(value.phase) : undefined,
    entries: Array.isArray(value?.entries) ? value.entries.slice(-500).map(normalizeEntry) : [],
    scenes: Array.isArray(value?.scenes) ? value.scenes.slice(0, 100).map((scene: any) => ({
      id: numberValue(scene.id), status: stringValue(scene.status), startedAt: stringValue(scene.startedAt),
      endedAt: scene.endedAt ? stringValue(scene.endedAt) : undefined, hook: stringValue(scene.hook),
      summary: stringValue(scene.summary), entryCount: numberValue(scene.entryCount),
    })) : [],
    facts: Array.isArray(value?.facts) ? value.facts.slice(0, 100).map((fact: any) => ({
      id: numberValue(fact.id), scope: stringValue(fact.scope), content: stringValue(fact.content),
      importance: numberValue(fact.importance), confidence: numberValue(fact.confidence), unresolved: Boolean(fact.unresolved),
      updatedAt: stringValue(fact.updatedAt),
    })) : [],
    preplan: value?.preplan && typeof value.preplan === 'object' ? {
      revision: numberValue(value.preplan.revision), timezone: stringValue(value.preplan.timezone),
      validFrom: stringValue(value.preplan.validFrom), validThrough: stringValue(value.preplan.validThrough),
      materializedDays: safeJson(value.preplan.materializedDays),
    } : undefined,
    alter: value?.alter && typeof value.alter === 'object' ? {
      value: numberValue(value.alter.value) || 0,
      alterWeight: numberValue(value.alter.alterWeight) || 1,
      emotionalOffset: value.alter.emotionalOffset && typeof value.alter.emotionalOffset === 'object' ? {
        direction: stringValue(value.alter.emotionalOffset.direction),
        intensity: numberValue(value.alter.emotionalOffset.intensity),
        description: stringValue(value.alter.emotionalOffset.description),
      } : null,
      lastUpdatedAt: stringValue(value.alter.lastUpdatedAt),
      history: Array.isArray(value.alter.history) ? value.alter.history.slice(0, 30).map((h: any) => ({
        value: numberValue(h.value) || 0, alter: numberValue(h.alter) || 0, at: stringValue(h.at),
      })) : [],
    } : undefined,
    compaction: value?.compaction && typeof value.compaction === 'object' ? {
      activeSceneId: numberValue(value.compaction.activeSceneId) || 0,
      sceneHook: stringValue(value.compaction.sceneHook),
      entryCount: numberValue(value.compaction.entryCount) || 0,
      lastCompactionAt: stringValue(value.compaction.lastCompactionAt),
      isDirty: Boolean(value.compaction.isDirty),
    } : undefined,
  }
}

/** Defensive boundary for the versioned, viewport-sized desktop range API. */
export function normalizeTimelineRange(value: any): StoryTimelineRange {
  const snapshot = normalizeTimelineSnapshot(value)
  const from = stringValue(value?.range?.from)
  const to = stringValue(value?.range?.to)
  return {
    ...snapshot,
    protocol: Math.max(1, numberValue(value?.protocol) || 1),
    revision: stringValue(value?.revision) || 'unknown',
    range: { from, to },
    nextCursor: value?.nextCursor ? stringValue(value.nextCursor) : undefined,
  }
}

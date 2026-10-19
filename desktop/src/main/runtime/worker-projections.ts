/**
 * worker 事件 → renderer IPC 的显式 DTO 投影（P1 保守批次）。
 *
 * 此前 story:runtime / story:token 广播是 `...message.payload` 直接展开 worker
 * 原始对象——worker 侧新增/改名字段会静默漏到渲染层（无类型 JS 无从发现）。
 * 本模块按 mixerRead / normalizeTimeline 的既有模式收口：
 *  - 字段白名单：未知字段丢弃，worker 原始对象不再直传 renderer；
 *  - 尺寸钳制：字符串/数组/数字均有界，畸形值降级为安全缺省；
 *  - 绝不拒绝：投影永不抛错（宁可降级，见 BRIDGE_PROTOCOL.md §6 的既有教训）——
 *    唯一例外是 projectAnalysisResult 的序列化边界（只读面板取数，超限即错误）。
 *
 * 字段清单与插件侧 TokenUsageRecord（narrator.ts）/ desktopRuntimeSnapshot
 * （service.ts）手工镜像；合同测试（worker-projections.test.ts）钉住两侧形状。
 */

const STRING_CAP_DEFAULT = 200

function safeString(value: unknown, cap = STRING_CAP_DEFAULT, fallback = ''): string {
  return typeof value === 'string' && value.length > 0 ? value.slice(0, cap) : fallback
}

function safeCount(value: unknown, max: number): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined
  return Math.min(value, max)
}

export interface RuntimeSnapshotStoryDto {
  id: string
  status: string
  cursorAt: string
  updatedAt: string
}

export interface RuntimeSnapshotDto {
  storyId: string
  phase: string
  stories: RuntimeSnapshotStoryDto[]
}

/** runtime-snapshot 事件投影。插件侧上限 20 条，这里同界钳制。 */
export function projectRuntimeSnapshot(storyId: string, payload: unknown): RuntimeSnapshotDto {
  const source = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {}
  const rawStories = Array.isArray(source.stories) ? source.stories : []
  const stories: RuntimeSnapshotStoryDto[] = []
  for (const entry of rawStories.slice(0, 20)) {
    if (!entry || typeof entry !== 'object') continue
    const record = entry as Record<string, unknown>
    const id = safeString(record.id, 128)
    if (!id) continue
    // 日期字段非法时置空串：渲染层今天只透传展示，不解析——保持"降级不抛错"。
    stories.push({
      id,
      status: safeString(record.status, 64, 'unknown'),
      cursorAt: safeString(record.cursorAt, 64),
      updatedAt: safeString(record.updatedAt, 64),
    })
  }
  return {
    storyId: safeString(storyId, 128),
    phase: safeString(source.phase, 32, 'updated'),
    stories,
  }
}

export interface TokenRecordDto {
  storyId: string
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

/** token 事件投影——同一 DTO 喂 UsageAggregator（主进程）与 story:token 广播
 *  （渲染层），单一边界两处消费。数字上限取宽松量级：token 数 ≤ 1e12（千亿
 *  级，远超任何单次调用），单价 ≤ 1e6（每百万 token 的美元价，防恶意大数）。 */
export function projectTokenRecord(storyId: string, payload: unknown): TokenRecordDto {
  const source = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {}
  return {
    storyId: safeString(storyId, 128),
    task: safeString(source.task, 64, 'unknown'),
    providerLabel: safeString(source.providerLabel),
    model: safeString(source.model),
    ...clampOptional(source.inputTokens, 1e12, 'inputTokens'),
    ...clampOptional(source.outputTokens, 1e12, 'outputTokens'),
    ...clampOptional(source.cachedInputTokens, 1e12, 'cachedInputTokens'),
    ...clampOptional(source.priceInput, 1e6, 'priceInput'),
    ...clampOptional(source.priceOutput, 1e6, 'priceOutput'),
    ...clampOptional(source.priceCachedInput, 1e6, 'priceCachedInput'),
  }
}

function clampOptional(value: unknown, max: number, key: string): Record<string, number> | Record<never, never> {
  const count = safeCount(value, max)
  return count === undefined ? {} : { [key]: count }
}

/** 序列化安全边界：语义分析结果是未来插件才提供的自由形状——只保证"可安全
 *  过 IPC"（可序列化、有尺寸上限、深拷贝隔离），不发明字段。 */
export function projectAnalysisResult(payload: unknown): unknown {
  if (payload === undefined) return undefined
  let json: string
  try {
    json = JSON.stringify(payload)
  } catch {
    throw new Error('语义分析结果包含不可序列化内容（如循环引用），无法传输。')
  }
  if (json === undefined) throw new Error('语义分析结果为空。')
  if (json.length > 2_000_000) throw new Error('语义分析结果超过 2MB 传输上限。')
  return JSON.parse(json)
}

export type StoryPhase = 'running' | 'muted' | 'paused'
export type DesktopTransport = 'snowluma' | 'onebot-external' | 'sandbox'
/**
 * D2-2 回执三态：confirmed = 平台 ok 且带 message_id；accepted = 上游受理
 * （async 或 ok 无 id，最终送达未确认）；unknown = 请求已写出但没有等到回执
 * （超时/连接崩溃），结果不可知——可见、可核对、绝不自动重发。
 * sent 为旧记录兼容值，语义等同 accepted。
 */
export type DeliveryState = 'generated' | 'sending' | 'sent' | 'confirmed' | 'accepted' | 'unknown' | 'retryable-failed' | 'permanent-failed'

/** 传输层进入 typ-0 的标准入站事件；保留原始时间和媒体引用，不能只降级成文本。 */
export interface DesktopInboundEvent {
  /** Host-owned correlation ID for the complete inbound → worker → delivery chain. */
  traceId?: string
  transport: DesktopTransport
  accountKey: string
  platform: string
  selfId: string
  senderId: string
  senderName?: string
  channelId?: string
  kind: 'private' | 'group'
  content: string
  occurredAt: string
  quote?: unknown
  imageSources?: string[]
  voice?: unknown
  rawMessageId?: string
}

/** HDSI asks the desktop host to deliver a visible message through its source transport. */
export interface DesktopDelivery {
  /** Inherits the inbound message trace; optional for older workers. */
  traceId?: string
  /** One Worker/HDSI processing round; optional while older workers are supported. */
  processingId?: string
  deliveryId: string
  accountKey: string
  transport: DesktopTransport
  platform: string
  selfId: string
  channelId: string
  kind: 'private' | 'group'
  replyTo?: string
  content: string
  occurredAt: string
  /** W2（B2-5）：worker 侧模型显式选择的目标端点（M3 语义）；缺省按 selfId 路由。 */
  endpointId?: string
  /** P1-1：业务幂等键（scriptEvent.eventId + bubbleIndex）。worker 的 split/delayed
   *  重试每次生成新 deliveryId，但 intentKey 稳定——outbox 据此跨 deliveryId 去重。 */
  intentKey?: string
}

export interface DeliveryReceipt {
  status: 'sent' | 'confirmed' | 'accepted' | 'unknown' | 'retryable-failed' | 'permanent-failed'
  messageIds?: string[]
  error?: string
}

export interface InboxRecord {
  id: string
  /** Denormalized for projections; event.traceId remains the source of truth. */
  traceId?: string
  event: DesktopInboundEvent
  receivedAt: string
  reason: 'muted' | 'paused' | 'worker-unavailable' | 'worker-rejected' | 'worker-timeout'
  attempts: number
  lastAttemptAt?: string
  lastError?: string
}

export interface DeliveryRecord extends DesktopDelivery {
  storyId: string
  state: DeliveryState
  attempts: number
  createdAt: string
  updatedAt: string
  sentAt?: string
  lastError?: string
  messageIds?: string[]
}

export interface AccountBinding {
  accountKey: string
  storyId: string
  transport: DesktopTransport
  updatedAt: string
}

export interface RouteResult {
  traceId?: string
  disposition: 'delivered-to-worker' | 'queued' | 'unassigned' | 'ignored-duplicate'
  storyId?: string
  inboxSize?: number
  reason?: string
}

export interface WorkerIngress {
  isBridgeReady(storyId: string): boolean
  deliverInbound(storyId: string, event: DesktopInboundEvent): Promise<void>
}

export function assertInboundEvent(event: DesktopInboundEvent) {
  if (!event.accountKey || !event.senderId || !event.platform || !event.selfId) {
    throw new Error('入站事件缺少 accountKey、platform、selfId 或 senderId。')
  }
  if (!['private', 'group'].includes(event.kind)) throw new Error('入站事件 kind 无效。')
  if (Number.isNaN(Date.parse(event.occurredAt))) throw new Error('入站事件 occurredAt 必须是 ISO 时间。')
  if (event.kind === 'group' && !event.channelId) throw new Error('群聊入站事件必须提供真实 channelId。')
  if (event.content.length > 128_000) throw new Error('入站文本过长。')
  if ((event.imageSources?.length ?? 0) > 32) throw new Error('入站图片数量过多。')
}

/** Only transport-issued IDs may be used for exact idempotency. Never dedupe by message text or time alone. */
export function inboundIdempotencyKey(event: DesktopInboundEvent) {
  return event.rawMessageId
    ? `${event.transport}:${event.accountKey}:${event.rawMessageId}`
    : undefined
}

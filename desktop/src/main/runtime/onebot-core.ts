import { DeliveryReceipt, DeliveryState, DesktopInboundEvent, DesktopTransport } from './contracts'

/**
 * M7-3：OneBot 11 协议核心——与传输方向无关的帧处理、事件转换、发送语义。
 * `OneBotServerAdapter`（worker 门面）与 `ExternalOneBotConnector`（真实上游）
 * 共用此核心，保证"谁是 OneBot API 服务端、谁是渠道实现"只体现在传输层。
 * 范围铁律同 M7-1：只处理私聊纯文本。
 */

export const ONEBOT_SEND_TIMEOUT_MS = 30_000
/**
 * Decide what a duplicate delivery request may do with a durable outbox row.
 * A `sending` row is only waitable while this process still owns its in-memory
 * flight; after restart its outcome is unknowable and must never be replayed.
 */
export type PersistedDeliveryAction = 'send' | 'wait' | 'reuse' | 'unknown' | 'terminal-failed'

export function persistedDeliveryAction(state: DeliveryState | undefined, hasActiveFlight: boolean): PersistedDeliveryAction {
  if (state === 'sent' || state === 'confirmed' || state === 'accepted') return 'reuse'
  if (state === 'unknown') return 'unknown'
  if (state === 'sending') return hasActiveFlight ? 'wait' : 'unknown'
  if (state === 'permanent-failed') return 'terminal-failed'
  // `generated` and `retryable-failed` are the only states that may be sent
  // again: neither one proves that the request left the host.
  return 'send'
}

/** 上行请求帧（桌面 → OneBot 实现）。 */
export interface OneBotPending {
  resolve: (value: { status: string, data: any }) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

/** A frame is either a usable user event, an explicitly ignored frame, or an
 * unsupported frame. Callers must never turn an absent event into an inbound. */
export interface InboundTransform {
  event?: DesktopInboundEvent
  drop?: string
  ignored?: string
}

/** OneBot message 帧 → DesktopInboundEvent；私聊与群聊（W2）入站，媒体/其它 post_type 丢弃。 */
export function transformPrivateMessage(frame: any, fallback: {
  transport: DesktopTransport
  accountKey: string
  selfId: string
}): InboundTransform {
  if (frame?.post_type === 'meta_event') return { ignored: '已忽略 OneBot meta_event（不是聊天消息）。' }
  // message_sent is the account's own echo. Its text may equal a prior
  // delivery but it is never evidence that the user said anything.
  if (frame?.post_type === 'message_sent') return { ignored: '已忽略账号自发消息回声（不作为用户入站）。' }
  if (frame?.post_type !== 'message') {
    return { drop: `忽略范围外事件：post_type=${frame.post_type}` }
  }
  if (frame.message_type !== 'private' && frame.message_type !== 'group') {
    return { drop: `已丢弃范围外消息：message_type=${frame.message_type}` }
  }
  // W2（B2-4）：群聊入站——真实群号即 channelId，插件侧群意愿门照常生效。
  const isGroup = frame.message_type === 'group'
  const groupId = isGroup ? String(frame.group_id ?? '').trim() : ''
  if (isGroup && !/^\d{5,12}$/.test(groupId)) {
    return { drop: '已丢弃缺少有效 group_id 的群消息。' }
  }
  // Some OneBot implementations label own echoes as ordinary `message`.
  // A message whose sender is the configured self account is still not user
  // evidence; this is identity-based, never content-based deduplication.
  if (String(frame.user_id ?? '') === String(fallback.selfId)) {
    return { ignored: '已忽略账号自身发送者回声（不作为用户入站）。' }
  }
  const content = extractPrivateText(frame)
  // W3（C3-3）：混合消息（文本+图片）取文本部分；extractPrivateText 对
  // 含非文本段的数组返回空——改用 extractTextAllowMixed 提取文字，
  // 图片经 extractImageSources 附带。纯图片（无文字）仍被范围外丢弃。
  const mixedContent = content || extractTextAllowMixed(frame)
  if (!mixedContent) {
    return { drop: '已丢弃无私聊文本的消息（图片/语音/表情-only 不在 M7 范围）。' }
  }
  const selfId = String(frame.self_id ?? fallback.selfId)
  if (frame.self_id != null && selfId !== String(fallback.selfId)) {
    return { drop: `已拒绝账号不一致事件：frame self_id=${selfId}，绑定账号=${fallback.selfId}。` }
  }
  return {
    event: {
      transport: fallback.transport,
      accountKey: fallback.accountKey,
      platform: 'onebot',
      selfId,
      senderId: String(frame.user_id),
      senderName: typeof frame.sender?.nickname === 'string' ? frame.sender.nickname : undefined,
      channelId: isGroup ? groupId : `private:${frame.user_id}`,
      kind: isGroup ? 'group' : 'private',
      content: mixedContent,
      ...(extractImageSources(frame).length ? { imageSources: extractImageSources(frame) } : {}),
      // OneBot 事件自带秒级 time；缺失时用宿主接收时间（保底，不伪造）。
      occurredAt: typeof frame.time === 'number' && frame.time > 0
        ? new Date(frame.time * 1000).toISOString()
        : new Date().toISOString(),
      rawMessageId: String(frame.message_id ?? ''),
    },
  }
}

/** OneBot message 数组/字符串段中提取纯文本；仅文本段返回内容，其余视为空。 */
export function extractPrivateText(frame: any): string {
  const message = frame?.message
  if (typeof message === 'string') {
    // CQ 码字符串格式：包含非文本段即视为范围外。
    return /\[CQ:[^\]]+\]/.test(message) ? '' : message
  }
  if (Array.isArray(message)) {
    if (!message.every(segment => segment && segment.type === 'text' && typeof segment.data?.text === 'string')) return ''
    return message.map(segment => segment.data.text).join('')
  }
  // raw_message 兜底（部分实现只给 raw）
  if (typeof frame?.raw_message === 'string' && !/\[CQ:[^\]]+\]/.test(frame.raw_message)) return frame.raw_message
  return ''
}

/** W3（C3-3）：从消息段中提取图片 URL（file:// / http:// / base64://）。
 *  仅在消息含纯文本时返回——纯图片（无文字）仍被 M7 范围外丢弃，
 *  不改变"只处理有文本的消息"的铁律；图片作为附属信息随文本入站，
 *  插件合成会话的 imageSources 字段消费它。 */
export function extractImageSources(frame: any): string[] {
  const message = frame?.message
  if (!Array.isArray(message)) return []
  const hasText = message.some(segment => segment && segment.type === 'text' && typeof segment.data?.text === 'string' && segment.data.text.trim())
  if (!hasText) return []
  const urls: string[] = []
  for (const segment of message) {
    if (!segment || segment.type !== 'image' || typeof segment.data?.url !== 'string') continue
    const url = segment.data.url
    if (/^(?:file:|https?:|base64:)/i.test(url)) urls.push(url)
  }
  return urls.slice(0, 9)
}

/** W3（C3-3）：混合消息提取文本——只取 text 段拼接（忽略 image/at 等），
 *  与 extractPrivateText 的区别是不因含非文本段就整体返回空。 */
export function extractTextAllowMixed(frame: any): string {
  const message = frame?.message
  if (!Array.isArray(message)) return ''
  return message
    .filter(segment => segment && segment.type === 'text' && typeof segment.data?.text === 'string')
    .map(segment => segment.data.text)
    .join('')
    .trim()
}

/**
 * 出站投递的公共校验与载荷构造。返回 `error` 表示永久失败（语义与 M7-1 一致）。
 */
/** 插件实时路径会把 [quote 元素, 零宽分隔] 序列化进 content 开头
 * （`<quote id="…"/>`）；后台路径则把引用消息 ID 放在 replyTo。这里统一
 * 剥掉开头的 quote 标记（含历史逗号拼接残留），并把引用 ID 透出。 */
export function stripLeadingQuoteMarkup(content: string): { content: string, quoteId?: string } {
  let rest = content
  let quoteId: string | undefined
  for (let guard = 0; guard < 4; guard++) {
    const match = /^<quote\b[^>]*?\/>/u.exec(rest)
    if (!match) break
    quoteId ??= /\bid="([^"]*)"/u.exec(match[0])?.[1]
    rest = rest.slice(match[0].length).replace(/^[,\u200b]+/u, '')
  }
  return { content: rest, quoteId }
}

export function buildSendPayload(delivery: {
  selfId: string
  channelId?: string
  kind: 'private' | 'group'
  content: string
  replyTo?: string
}, allowedSelfIds?: string[]): { payload?: { action: string, params: any, echo: string }, error?: string } {
  // W2（B2-3）：注册集校验取代旧的单账号硬校验——本连接（= 一个上游账号）
  // 只能以自己代表的 selfId 发送；多账号由多个连接器各管各的。
  if (allowedSelfIds?.length && !allowedSelfIds.some(id => String(id) === String(delivery.selfId))) {
    return { error: `投递 selfId（${delivery.selfId}）不属于本连接的注册账号（${allowedSelfIds.join('/')}）。` }
  }
  const { content: cleanContent, quoteId } = stripLeadingQuoteMarkup(delivery.content)
  const replyId = String(delivery.replyTo || quoteId || '').trim()
  // 引用消息：OneBot 11 段数组形态（auto_escape 只作用于字符串形态）。
  // 上游（SnowLuma/NapCat）对无法解析的 reply id 会优雅降级为普通文本发送。
  const message = replyId && /^\d+$/.test(replyId)
    ? [{ type: 'reply', data: { id: replyId } }, { type: 'text', data: { text: cleanContent } }]
    : cleanContent
  if (delivery.kind === 'private') {
    const target = Number(delivery.channelId?.startsWith('private:') ? delivery.channelId.slice('private:'.length) : delivery.channelId)
    if (!Number.isFinite(target)) {
      return { error: `无法解析私聊目标：${delivery.channelId}` }
    }
    return { payload: { action: 'send_private_msg', params: { user_id: target, message, ...(Array.isArray(message) ? {} : { auto_escape: true }) }, echo: '' } }
  }
  if (delivery.kind === 'group') {
    const group = Number(delivery.channelId?.replace(/^group:/, ''))
    if (!Number.isFinite(group)) {
      return { error: `无法解析群目标：${delivery.channelId}` }
    }
    return { payload: { action: 'send_group_msg', params: { group_id: group, message, ...(Array.isArray(message) ? {} : { auto_escape: true }) }, echo: '' } }
  }
  return { error: `未知投递类型：${(delivery as { kind?: string }).kind}` }
}

/**
 * echo 回执 → DeliveryReceipt 的公共映射。
 * `ok|async` → sent；显式 failed → permanent-failed；reject/超时 → retryable-failed。
 */
export function receiptFromEchoResponse(response: { status: string, data: any }): DeliveryReceipt {
  const messageId = response.data?.message_id
  if (response.status === 'ok') {
    // D2-2：ok 且带 message_id = 平台确认生成消息；ok 无 id = 受理但无凭据。
    return messageId != null
      ? { status: 'confirmed', messageIds: [String(messageId)] }
      : { status: 'accepted', messageIds: [] }
  }
  if (response.status === 'async') {
    // async = 上游受理，最终结果异步、无 message_id——与最终确认区分。
    return { status: 'accepted', messageIds: [] }
  }
  // OneBot 实现明确返回失败（如账号被封、非好友）——重试无意义。
  return { status: 'permanent-failed', error: `OneBot 返回失败：${response.status}` }
}

/**
 * OneBot 上行请求（实现侧主动发起的 action）的桌面应答策略。
 * 返回 null 表示该 action 无需应答内容之外的日志。
 */
export function replyToUpstreamAction(action: string, params: any, declared: { selfId: string, nickname: string }): { status: string, retcode: number, data: any } | { status: string, retcode: number, data: null } {
  if (action === 'get_login_info') {
    return { status: 'ok', retcode: 0, data: { user_id: Number(declared.selfId), nickname: declared.nickname } }
  }
  if (action === 'get_guild_service_profile') {
    // adapter-onebot initialize() 会探测 QQ 频道服务；tiny_id='0' 表示无频道能力。
    return { status: 'ok', retcode: 0, data: { tiny_id: '0' } }
  }
  // 范围外的 action 一律拒绝（M7 只承诺私聊纯文本所需的最小面）。
  return { status: 'failed', retcode: 1404, data: null }
}

/**
 * D2-2：worker（HDSI bridge）协议只知道 sent|失败。confirmed/accepted 都表示
 * 消息已离开本机，映射为 sent（messageIds 透传）；unknown 保持失败语义但错误
 * 文本明确"结果未知、不自动重发"。
 */
export function workerReceipt(receipt: DeliveryReceipt): DeliveryReceipt {
  if (receipt.status === 'confirmed' || receipt.status === 'accepted') return { ...receipt, status: 'sent' }
  if (receipt.status === 'unknown') return { ...receipt, error: receipt.error || '投递结果未知（请求已写出，无回执）——不自动重发。' }
  return receipt
}

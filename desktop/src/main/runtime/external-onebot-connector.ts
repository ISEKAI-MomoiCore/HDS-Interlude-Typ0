import { oneBotAuthHint } from './probe-upstream'
import { WebSocket } from 'ws'
import { DeliveryReceipt, DeliveryRecord, DesktopInboundEvent, DesktopTransport } from './contracts'
import type { ChannelAdapter } from './channel-adapter'
import {
  buildSendPayload,
  ONEBOT_SEND_TIMEOUT_MS,
  receiptFromEchoResponse,
  transformPrivateMessage,
} from './onebot-core'
import type { AccountRegistry } from './account-registry'

/**
 * M7-3：外部 OneBot 上游连接器——桌面作为 **WS 客户端** 连接真实 OneBot 实现
 * （SnowLuma / NapCat / Lagrange 的正向或反向 WS 端点）。与 `OneBotServerAdapter`
 * （worker 门面）共用 onebot-core 的协议核心，职责拆分：
 *
 *   外部 OneBot 实现 ↕ ExternalOneBotConnector（本类，真实渠道）
 *   MessageRouter + Inbox / Outbox
 *   Koishi Worker 内的 adapter-onebot ↕ OneBotServerAdapter（worker 门面）
 *
 * 范围铁律同 M7-1：只处理私聊纯文本；显式拒绝并记录其余类型。
 * worker 门面与外部连接器可并存：同一 DesktopInboundEvent 流，按绑定路由。
 */
export interface ExternalOneBotOptions {
  /** 上游 OneBot 实现（NapCat/Lagrange/SnowLuma）的正向 WS 端点。 */
  endpoint: string
  /** OneBot access token（上游配置的 access_token；Bearer 头）。 */
  token?: string
  /** 绑定的剧本：connector 只服务一个故事-账号对（一个账号=一个剧本）。 */
  storyId: string
  /** 该连接代表的 OneBot 账号（QQ 号）。 */
  selfId: string
  /** 重连间隔（默认 5s）；真实实现掉线后自动重连。 */
  retryIntervalMs?: number
}

/** P1-5：动作失败的结构化分类——宿主据此给出可靠的 errorCode/ambiguous，
 * 不再解析错误文本。kind 语义（宿主映射）：
 *  not-verified      账号未通过身份验证（未连上/验证中）→ account-offline
 *  upstream-rejected 上游明确返回失败 → upstream-failed
 *  receipt-timeout   请求已写出但回执超时 → transport-ambiguous（禁止重试）
 *  disconnected      回执等待中连接断开 → transport-ambiguous（禁止重试）
 *  send-failed       请求未写出（本地 send 异常）→ send-failed（可安全重试） */
export type ExternalConnectionErrorCode = 'SELF_ID_MISMATCH' | 'ONEBOT_ENDPOINT_UNREACHABLE' | 'ONEBOT_AUTH_FAILED'

export type OnebotActionFailureKind = 'not-verified' | 'upstream-rejected' | 'receipt-timeout' | 'disconnected' | 'send-failed'

export class OnebotActionError extends Error {
  constructor(message: string, readonly kind: OnebotActionFailureKind) {
    super(message)
    this.name = 'OnebotActionError'
  }
}

export class ExternalOneBotConnector implements ChannelAdapter {
  readonly transport: DesktopTransport = 'onebot-external'
  private socket: WebSocket | null = null
  private readonly pending = new Map<string, {
    resolve: (value: { status: string, data: any }) => void
    reject: (error: Error) => void
    timer: ReturnType<typeof setTimeout>
  }>()
  private echoCounter = 0
  private inboundListener: ((event: DesktopInboundEvent) => Promise<void>) | null = null
  private onlineListener: ((selfId: string) => void) | null = null
  private offlineListener: (() => void) | null = null
  private errorListener: ((code: ExternalConnectionErrorCode, message: string) => void) | null = null
  private stopped = false
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private verified = false
  private log: (line: string) => void = line => console.log('[onebot-ext]', line)

  constructor(
    private readonly options: ExternalOneBotOptions,
    private readonly accounts: AccountRegistry,
    /** 测试注入用：回执等待上限。生产保持 ONEBOT_SEND_TIMEOUT_MS。 */
    private readonly sendTimeoutMs = ONEBOT_SEND_TIMEOUT_MS,
  ) {}

  setLogger(log: (line: string) => void) { this.log = log }
  setInboundListener(listener: (event: DesktopInboundEvent) => Promise<void>) { this.inboundListener = listener }
  setOnlineListener(listener: (selfId: string) => void) { this.onlineListener = listener }
  setOfflineListener(listener: () => void) { this.offlineListener = listener }
  setErrorListener(listener: (code: ExternalConnectionErrorCode, message: string) => void) { this.errorListener = listener }

  /** 建立到上游的 WS 连接；断线自动重连（stopped 前一直尝试）。 */
  start(): void {
    this.stopped = false
    this.connect()
  }

  private connect() {
    if (this.stopped || this.socket) return
    const { endpoint } = this.options
    const token = this.options.token?.trim()
    let authFailed = false
    const headers: Record<string, string> = {}
    // OneBot 11 标准头 + NapCat/Lagrange 常见变体都带上，兼容面最宽。
    if (token) {
      headers.Authorization = `Bearer ${token}`
      headers['access-token'] = token
    }
    headers['x-client-role'] = 'Universal'
    headers['x-self-id'] = this.options.selfId
    let socket: WebSocket
    try { socket = new WebSocket(endpoint, { headers, followRedirects: false, handshakeTimeout: 8000 }) }
    catch (error) { this.errorListener?.('ONEBOT_ENDPOINT_UNREACHABLE', '无法建立 OneBot 连接，请检查地址与令牌格式。'); this.scheduleReconnect(); return }
    this.socket = socket
    socket.on('unexpected-response', (_req, response) => {
      response.resume()
      if (response.statusCode === 401 || response.statusCode === 403) {
        authFailed = true
        this.stopped = true // Invalid credentials cannot heal by retrying every five seconds.
        this.log(oneBotAuthHint)
        this.errorListener?.('ONEBOT_AUTH_FAILED', oneBotAuthHint)
      } else {
        this.errorListener?.('ONEBOT_ENDPOINT_UNREACHABLE', `上游拒绝 WebSocket 握手（HTTP ${response.statusCode}）。`)
      }
      socket.terminate()
    })
    socket.on('open', () => {
      this.log(`已连接外部 OneBot 上游，正在验证账号身份。`)
      void this.verifyIdentity(socket)
    })
    socket.on('message', data => this.handleFrame(String(data)))
    socket.on('close', code => {
      this.socket = null
      this.verified = false
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer)
        pending.reject(new Error('外部 OneBot 连接已断开。'))
      }
      this.pending.clear()
      if (!this.stopped) {
        this.log(`外部 OneBot 连接关闭（code=${code}），${this.options.retryIntervalMs ?? 5_000}ms 后重连。`)
        this.offlineListener?.()
        this.scheduleReconnect()
      }
    })
    socket.on('error', error => {
      if (authFailed || this.stopped) return
      this.log('外部 OneBot 连接错误，请检查服务、端口和 TLS 配置。')
      this.errorListener?.('ONEBOT_ENDPOINT_UNREACHABLE', '无法连接 OneBot 上游。')
    })
  }

  private scheduleReconnect() {
    if (this.stopped || this.reconnectTimer) return
    this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; this.connect() }, this.options.retryIntervalMs ?? 5_000)
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    const socket = this.socket
    if (!socket) return
    await new Promise<void>(resolve => {
      const done = () => { clearTimeout(fallback); resolve() }
      const fallback = setTimeout(done, 2_000)
      socket.once('close', done)
      try { socket.close(1001, 'desktop stopping') } catch { done() }
    })
    this.socket = null
    this.verified = false
  }

  /** A WebSocket open event only proves a socket. Do not route/send as the
   * configured QQ identity until the upstream's get_login_info agrees. */
  private async verifyIdentity(socket: WebSocket) {
    try {
      const response = await this.requestAction(socket, 'get_login_info', {}, 10_000)
      const upstreamSelfId = String(response.data?.user_id ?? '')
      if (response.status !== 'ok' || upstreamSelfId !== this.options.selfId) {
        const error = new Error(`上游账号不匹配（期望 ${this.options.selfId}，收到 ${upstreamSelfId || '无'}）。`)
        Object.assign(error, { code: 'SELF_ID_MISMATCH' })
        throw error
      }
      if (this.socket !== socket || socket.readyState !== WebSocket.OPEN) return
      this.verified = true
      this.log(`外部 OneBot 身份已验证：账号 ${upstreamSelfId}。`)
      this.onlineListener?.(upstreamSelfId)
    } catch (error) {
      this.log(`外部 OneBot 身份验证失败：${String(error)}`)
      const code: ExternalConnectionErrorCode = (error as NodeJS.ErrnoException)?.code === 'SELF_ID_MISMATCH' ? 'SELF_ID_MISMATCH' : 'ONEBOT_ENDPOINT_UNREACHABLE'
      this.errorListener?.(code, String(error).slice(0, 500))
      try { socket.close(1008, 'identity verification failed') } catch { /* close path reconnects */ }
    }
  }

  private requestAction(socket: WebSocket, action: string, params: Record<string, unknown>, timeoutMs: number) {
    const echo = String(++this.echoCounter)
    return new Promise<{ status: string, data: any }>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(echo); reject(new Error(`等待 ${action} 回执超时。`)) }, timeoutMs)
      this.pending.set(echo, { resolve, reject, timer })
      try { socket.send(JSON.stringify({ action, params, echo })) }
      catch (error) { clearTimeout(timer); this.pending.delete(echo); reject(error instanceof Error ? error : new Error(String(error))) }
    })
  }

  private handleFrame(raw: string) {
    let frame: any
    try { frame = JSON.parse(raw) } catch {
      this.log(`无法解析上游帧（非 JSON）。`)
      return
    }
    if (frame && typeof frame === 'object' && 'post_type' in frame) {
      const transform = transformPrivateMessage(frame, {
        transport: 'onebot-external',
        accountKey: `onebot:${this.options.selfId}`,
        selfId: this.options.selfId,
      })
      if (transform.drop) {
        this.log(transform.drop)
        return
      }
      if (!transform.event) {
        if (transform.ignored) this.log(transform.ignored)
        return
      }
      const event = transform.event
      void this.inboundListener?.(event).catch(error => this.log(`入站处理失败：${error}`))
      return
    }
    if (frame && typeof frame === 'object' && typeof frame.echo !== 'undefined') {
      const pending = this.pending.get(String(frame.echo))
      if (pending) {
        this.pending.delete(String(frame.echo))
        clearTimeout(pending.timer)
        pending.resolve({ status: String(frame.status ?? 'failed'), data: frame.data })
      }
    }
  }

  /** 本连接代表的账号（W2：连接器按账号一比一，多账号 = 多连接器）。 */
  get accountKey(): string { return `onebot:${this.options.selfId}` }
  get ownerStoryId(): string { return this.options.storyId }

  /** W3（C3-2）：动作代理通用调用口——宿主 onebot-action handler 经此透传
   *  任意白名单动作到上游。echo 匹配复用 send 的 pending map。 */
  async call(action: string, params: Record<string, unknown>, timeoutMs = 30_000): Promise<unknown> {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN || !this.verified) {
      throw new OnebotActionError('外部 OneBot 上游尚未完成账号验证。', 'not-verified')
    }
    const echo = `act-${++this.echoCounter}`
    let response: { status: string, data: any }
    try {
      response = await new Promise<{ status: string, data: any }>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pending.delete(echo)
          reject(new OnebotActionError(`动作 ${action} 回执等待超时——请求已写出，结果不可知。`, 'receipt-timeout'))
        }, timeoutMs)
        this.pending.set(echo, { resolve, reject, timer })
        try { this.socket!.send(JSON.stringify({ action, params, echo })) }
        catch (error) {
          clearTimeout(timer)
          this.pending.delete(echo)
          reject(error instanceof OnebotActionError ? error : new OnebotActionError(String(error instanceof Error ? error.message : error), 'send-failed'))
        }
      })
    } catch (error) {
      // 未经分类的拒绝只可能来自 close 事件对 pending 的统一清算——连接断开，
      // 请求可能已写出，保守归为 disconnected。
      throw error instanceof OnebotActionError ? error
        : new OnebotActionError(String((error as Error)?.message || error), 'disconnected')
    }
    if (response.status !== 'ok') {
      throw new OnebotActionError(`上游返回失败：${response.status}（动作 ${action}）`, 'upstream-rejected')
    }
    return response.data
  }

  /** Outbox → send_private_msg / send_group_msg（经外部上游）。 */
  async send(delivery: DeliveryRecord): Promise<DeliveryReceipt> {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN || !this.verified) {
      return { status: 'retryable-failed', error: '外部 OneBot 上游尚未完成账号验证。' }
    }
    const { payload, error } = buildSendPayload(delivery, [this.options.selfId])
    if (error || !payload) {
      return { status: 'permanent-failed', error: error ?? '无法构造投递载荷。' }
    }
    const echo = String(++this.echoCounter)
    payload.echo = echo
    return new Promise<DeliveryReceipt>(resolve => {
      const timer = setTimeout(() => {
        this.pending.delete(echo)
        resolve({ status: 'unknown', error: `等待外部 OneBot 回执超时（${Math.round(this.sendTimeoutMs / 1000)}s）——请求已写出，结果不可知，不自动重发。` })
      }, this.sendTimeoutMs)   // 审查T28: 用注入的超时而非模块常量，错误消息才不谎报
      this.pending.set(echo, {
        resolve: response => resolve(receiptFromEchoResponse(response)),
        reject: err => resolve({ status: 'unknown', error: `回执等待中断开连接：${String(err.message || err)}——结果不可知，不自动重发。` }),
        timer,
      })
      try { this.socket!.send(JSON.stringify(payload)) }
      catch (error) {
        clearTimeout(timer)
        this.pending.delete(echo)
        resolve({ status: 'retryable-failed', error: String(error) })
      }
    })
  }
}

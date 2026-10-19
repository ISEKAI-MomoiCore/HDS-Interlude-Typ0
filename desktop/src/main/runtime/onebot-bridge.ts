import { WebSocketServer, WebSocket } from 'ws'
import type { IncomingMessage } from 'node:http'
import { randomUUID } from 'node:crypto'
import { DeliveryReceipt, DeliveryRecord, DesktopInboundEvent } from './contracts'
import type { AccountRegistry, OneBotAccountEntry } from './account-registry'
import {
  buildSendPayload,
  extractPrivateText,
  receiptFromEchoResponse,
  replyToUpstreamAction,
  transformPrivateMessage,
  ONEBOT_SEND_TIMEOUT_MS,
} from './onebot-core'

/**
 * M7 OneBot 桥接：桌面主进程作为 OneBot 11 反向 WS 服务端。typ-0 worker 内的
 * adapter-onebot（protocol: ws）作为客户端连入，桌面把 OneBot 事件转换为统一
 * 入站事件（MessageRouter），把 Outbox 投递转换为 send_private_msg action 并
 * 以 echo 匹配等待回执。范围铁律：只处理私聊纯文本；群聊/其它帧打日志丢弃。
 */
interface EchoPending {
  resolve: (value: { status: string, data: any }) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

interface ClientSession {
  storyId: string
  socket: WebSocket
  /** 登记表中该剧本声明的账号；get_login_info 应答与出站 selfId 校验的数据源。 */
  account?: OneBotAccountEntry
  /** 与 adapter-onebot 的 echo 计数无关：桌面自己维护 echo 序列。 */
  pending: Map<string, EchoPending>
  online: boolean
}

const ECHO_COUNTER_START = 1_000_000

export class OneBotServerAdapter {
  readonly transport = 'onebot-external' as const
  private wss: WebSocketServer | null = null
  private readonly sessions = new Map<string, ClientSession>()
  private inboundListener: ((event: DesktopInboundEvent) => Promise<void>) | null = null
  private onlineListener: ((storyId: string, selfId: string) => void) | null = null
  private offlineListener: ((storyId: string) => void) | null = null
  private echoCounter = ECHO_COUNTER_START
  private log: (line: string, storyId?: string) => void = line => console.log('[onebot]', line)

  constructor(
    private readonly accounts: AccountRegistry,
    private readonly token = '',
    /** 测试注入用：回执等待上限。生产保持 ONEBOT_SEND_TIMEOUT_MS。 */
    private readonly sendTimeoutMs = ONEBOT_SEND_TIMEOUT_MS,
  ) {}

  setLogger(log: (line: string, storyId?: string) => void) { this.log = log }
  setInboundListener(listener: (event: DesktopInboundEvent) => Promise<void>) { this.inboundListener = listener }
  setOnlineListener(listener: (storyId: string, selfId: string) => void) { this.onlineListener = listener }
  setOfflineListener(listener: (storyId: string) => void) { this.offlineListener = listener }

  async start(port: number, host = '127.0.0.1'): Promise<void> {
    if (this.wss) return
    await new Promise<void>((resolve, reject) => {
      // ws 包的 path 不支持参数占位：直接监听根路径，URL 中的 /onebot/<storyId>
      // 在 handleConnection 里手动解析。
      const server = new WebSocketServer({ host, port })
      server.once('listening', () => resolve())
      server.once('error', error => reject(error))
      server.on('connection', (socket, request) => this.handleConnection(socket, request))
      this.wss = server
    })
    this.log(`OneBot 桥接服务端已启动 ws://${host}:${port}/onebot/<storyId>`)
  }

  async stop(): Promise<void> {
    if (!this.wss) return
    const closing = new Promise<void>(resolve => this.wss!.close(() => resolve()))
    for (const session of this.sessions.values()) {
      try { session.socket.close(1001, 'desktop stopping') } catch { /* already closed */ }
    }
    this.sessions.clear()
    await closing
    this.wss = null
  }

  /** 当前在线的剧本账号（storyId → selfId）。 */
  onlineAccounts(): Array<{ storyId: string, selfId: string }> {
    return [...this.sessions.values()]
      .filter(session => session.online && session.account)
      .map(session => ({ storyId: session.storyId, selfId: session.account!.selfId }))
  }

  private handleConnection(socket: WebSocket, request: IncomingMessage) {
    const storyId = decodeURIComponent(request.url?.match(/\/onebot\/([^/?]+)/)?.[1] ?? '')
    if (!storyId) {
      socket.close(1008, 'missing story id')
      return
    }
    const account = this.accounts.findByStory(storyId)
    if (!account) {
      this.log(`拒绝连接：剧本 ${storyId} 尚未登记 OneBot 账号。`, storyId)
      socket.close(1008, 'account not registered')
      return
    }
    if (this.token) {
      const auth = String(request.headers.authorization ?? '')
      if (auth !== `Bearer ${this.token}` && auth !== `Token ${this.token}`) {
        this.log(`拒绝连接：token 校验失败。`, storyId)
        socket.close(1008, 'invalid token')
        return
      }
    }
    // 同一剧本重复连接（worker 重启）：顶替旧连接。
    const previous = this.sessions.get(storyId)
    if (previous) {
      try { previous.socket.close(4000, 'replaced by new connection') } catch { /* stale */ }
    }
    const session: ClientSession = { storyId, socket, account, pending: new Map(), online: false }
    this.sessions.set(storyId, session)
    this.log(`OneBot 客户端已连接：剧本=${storyId} 账号=${account.selfId}`, storyId)

    socket.on('message', data => this.handleFrame(session, String(data)))
    socket.on('close', code => {
      if (this.sessions.get(storyId) === session) this.sessions.delete(storyId)
      for (const pending of session.pending.values()) {
        clearTimeout(pending.timer)
        pending.reject(new Error('OneBot 连接已断开。'))
      }
      session.pending.clear()
      if (session.online) {
        session.online = false
        this.offlineListener?.(storyId)
      }
      this.log(`OneBot 客户端断开：剧本=${storyId}`, storyId)
    })
    socket.on('error', () => { /* close will follow */ })
  }

  private handleFrame(session: ClientSession, raw: string) {
    let frame: any
    try { frame = JSON.parse(raw) } catch {
      this.log(`无法解析 OneBot 帧（非 JSON）。`, session.storyId)
      return
    }
    if (frame && typeof frame === 'object' && 'post_type' in frame) {
      this.handleEvent(session, frame)
      return
    }
    if (frame && typeof frame === 'object' && typeof frame.echo !== 'undefined') {
      // adapter-onebot 也会主动发 action（如 get_login_info）：桌面应答。
      if (typeof frame.action === 'string') {
        this.handleClientAction(session, frame)
        return
      }
      const pending = session.pending.get(String(frame.echo))
      if (pending) {
        session.pending.delete(String(frame.echo))
        clearTimeout(pending.timer)
        pending.resolve({ status: String(frame.status ?? 'failed'), data: frame.data })
      }
    }
  }

  /** adapter-onebot 连上后立刻 get_login_info；没有应答它就不会 online。 */
  private handleClientAction(session: ClientSession, frame: any) {
    const declared = { selfId: String(session.account!.selfId), nickname: session.account!.nickname }
    const reply = replyToUpstreamAction(frame.action, frame.params, declared)
    session.socket.send(JSON.stringify({ ...reply, echo: frame.echo }))
    if (reply.status === 'failed') {
      this.log(`已拒绝范围外 action：${frame.action}`, session.storyId)
      return
    }
    // get_login_info 应答完成 = 该剧本的 OneBot 账号已上线。
    if (frame.action === 'get_login_info' && !session.online) {
      session.online = true
      this.onlineListener?.(session.storyId, session.account!.selfId)
    }
  }

  private handleEvent(session: ClientSession, frame: any) {
    const transform = transformPrivateMessage(frame, {
      transport: 'onebot-external',
      accountKey: `onebot:${session.account!.selfId}`,
      selfId: String(session.account!.selfId),
    })
    if (transform.drop) {
      this.log(transform.drop, session.storyId)
      return
    }
    if (!transform.event) {
      if (transform.ignored) this.log(transform.ignored, session.storyId)
      return
    }
    const event = transform.event
    void this.inboundListener?.(event).catch(error => this.log(`入站处理失败：${error}`, session.storyId))
  }

  /** Outbox → send_private_msg。echo 匹配回执；无连接/超时/失败映射为对应失败状态。 */
  async send(delivery: DeliveryRecord): Promise<DeliveryReceipt> {
    const session = this.sessions.get(delivery.storyId ?? '')
    if (!session || !session.socket || session.socket.readyState !== WebSocket.OPEN) {
      return { status: 'retryable-failed', error: 'OneBot 客户端未连接（worker 离线或账号未登记）。' }
    }
    const { payload, error } = buildSendPayload(delivery, session.account?.selfId ? [String(session.account.selfId)] : undefined)
    if (error || !payload) {
      return { status: 'permanent-failed', error: error ?? '无法构造投递载荷。' }
    }
    const echo = String(this.echoCounter++)
    payload.echo = echo
    return new Promise<DeliveryReceipt>(resolve => {
      // 审计（对齐 external-onebot-connector T28）：定时器用注入值而非模块常量，
      // 错误文案才不谎报实际等待时长。
      const timer = setTimeout(() => {
        session.pending.delete(echo)
        resolve({ status: 'unknown', error: `等待 OneBot 回执超时（${Math.round(this.sendTimeoutMs / 1000)}s）——请求已写出，结果不可知，不自动重发。` })
      }, this.sendTimeoutMs)
      session.pending.set(echo, {
        resolve: response => resolve(receiptFromEchoResponse(response)),
        reject: err => resolve({ status: 'unknown', error: `回执等待中断开连接：${String(err.message || err)}——结果不可知，不自动重发。` }),
        timer,
      })
      session.socket.send(JSON.stringify(payload))
    })
  }

  _sessionsDebug() {
    return [...this.sessions.entries()].map(([id, sess]) => ({ storyId: id, online: sess.online, selfId: sess.account?.selfId }))
  }

  /** 供模拟 OneBot 客户端测试：直接访问某剧本 session（生产代码不用）。 */
  _sessionFor(storyId: string): ClientSession | undefined {
    return this.sessions.get(storyId)
  }
}


/** 测试与登记 UI 共用：生成一个 echo 值。 */
export function newEchoId(): string {
  return randomUUID()
}

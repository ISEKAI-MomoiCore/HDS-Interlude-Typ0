import { WebSocket } from 'ws'
export interface UpstreamProbeResult {
  ok: boolean; latencyMs?: number; selfId?: string; nickname?: string; error?: string
  code?: 'ONEBOT_AUTH_FAILED' | 'ONEBOT_ENDPOINT_UNREACHABLE' | 'SELF_ID_MISMATCH'
}
export function isValidUpstreamEndpoint(endpoint: string): boolean {
  try { const u = new URL(endpoint.trim()); return ['ws:', 'wss:'].includes(u.protocol) && !!u.hostname && !u.username && !u.password && !u.hash && ![...u.searchParams.keys()].some(k => /token|authorization/i.test(k)) } catch { return false }
}
export const oneBotAuthHint = 'OneBot 鉴权失败（401/403）：请填写该 WebSocket 服务的 access token，或明确选择使用本机 SnowLuma 令牌；它不是 WebUI 登录密码。'
/** A temporary read-only identity probe. Credentials never appear in errors or URL output. */
export async function probeUpstream(endpoint: string, token?: string, expectedSelfId?: string): Promise<UpstreamProbeResult> {
  if (!isValidUpstreamEndpoint(endpoint)) return { ok: false, error: '连接地址必须是有效 ws:// 或 wss:// 地址；不得包含账号密码、令牌或 fragment。' }
  const started = Date.now(), tokenText = token?.trim() ?? ''
  return new Promise(resolve => {
    let socket: WebSocket | undefined, done = false, opened = false
    const finish = (result: UpstreamProbeResult) => {
      if (done) return
      done = true; clearTimeout(timer)
      resolve(result)
      if (socket?.readyState === WebSocket.OPEN) socket.close(1000, 'probe done')
      else if (socket && socket.readyState !== WebSocket.CLOSED) socket.terminate()
    }
    const timer = setTimeout(() => finish({ ok: false, code: 'ONEBOT_ENDPOINT_UNREACHABLE', error: opened ? '等待 get_login_info 回执超时。' : '连接上游超时。' }), 8000)
    const headers: Record<string, string> = { 'x-client-role': 'Universal' }
    if (tokenText) { headers.Authorization = `Bearer ${tokenText}`; headers['access-token'] = tokenText }
    try { socket = new WebSocket(endpoint.trim(), { headers, followRedirects: false, handshakeTimeout: 8000 }) }
    catch { finish({ ok: false, code: 'ONEBOT_ENDPOINT_UNREACHABLE', error: '无法建立上游连接，请检查地址与令牌格式。' }); return }
    socket.once('unexpected-response', (_req, response) => {
      response.resume()
      const auth = response.statusCode === 401 || response.statusCode === 403
      finish({ ok: false, code: auth ? 'ONEBOT_AUTH_FAILED' : 'ONEBOT_ENDPOINT_UNREACHABLE', error: auth ? oneBotAuthHint : `上游拒绝 WebSocket 握手（HTTP ${response.statusCode}）。` })
    })
    socket.once('open', () => { opened = true; socket!.send(JSON.stringify({ action: 'get_login_info', params: {}, echo: 'probe' })) })
    socket.on('message', raw => {
      let frame: any
      try { frame = JSON.parse(String(raw)) } catch { return }
      if (frame.echo !== 'probe') return
      const selfId = String(frame.data?.user_id ?? '').trim()
      if (frame.status !== 'ok' || !selfId) { finish({ ok: false, error: '上游没有返回有效的登录账号，请先在 SnowLuma 中完成登录。' }); return }
      if (expectedSelfId && selfId !== expectedSelfId) { finish({ ok: false, code: 'SELF_ID_MISMATCH', error: '上游登录账号与当前选择的机器人账号不同，请核对账号和端点。' }); return }
      finish({ ok: true, selfId, nickname: String(frame.data?.nickname ?? ''), latencyMs: Date.now() - started })
    })
    socket.once('error', () => finish({ ok: false, code: 'ONEBOT_ENDPOINT_UNREACHABLE', error: '无法连接 OneBot 上游，请检查服务、端口与 TLS 配置。' }))
    socket.once('close', () => finish({ ok: false, code: 'ONEBOT_ENDPOINT_UNREACHABLE', error: '上游连接在等待回执期间关闭。' }))
  })
}

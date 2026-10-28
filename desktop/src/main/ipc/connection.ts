import { registerHandle } from './register'
/** 连接与首次运行就绪域：connection:* 三个通道（P2 结构批次，自 main.ts 逐字迁移）。 */
import { probeUpstream } from '../runtime/probe-upstream'
import { resolveUpstreamToken } from '../runtime/upstream-credentials'
import { detectSnowLuma, discoverSnowLumaAccounts } from '../runtime/snowluma-detection'
import type { IpcContext } from './context'

export function registerConnectionIpc(ctx: IpcContext) {
  const { stories, accountRegistry, externalAccountStates, buildFirstRunReadiness, setLastSnowLumaDetection } = ctx
  // P0: 连接与账号中心 — SnowLuma/上游检测
  registerHandle('connection:detect', async () => {
    const snow = await detectSnowLuma()
    // 探测结果写入宿主缓存：buildFirstRunReadiness（main.ts）读取同一份。
    setLastSnowLumaDetection(snow)
    const running: Array<{ storyId: string, phase: string, bridgeReady: boolean, consolePort?: number }> = []
    for (const handle of stories.list()) running.push({ storyId: handle.meta.id, phase: handle.meta?.phase ?? 'unknown', bridgeReady: handle.bridgeReady ?? false })
    return {
      snowluma: snow.status,
      ...(snow.path ? { snowlumaPath: snow.path } : {}),
      snowlumaCheckedAt: snow.checkedAt,
      snowlumaProcess: { status: snow.process },
      snowlumaWebui: snow.webui,
      // 保留 Renderer 旧字段；账号发现仍由 SnowLuma 管理界面负责，不能仅凭进程存在推断。
      snowlumaAccounts: snow.path ? discoverSnowLumaAccounts(snow.path) : [],
      onebot: accountRegistry.list().map(entry => {
        const state = externalAccountStates.get('onebot:' + entry.selfId)
        return { storyId: entry.storyId, selfId: entry.selfId, endpointConfigured: Boolean(entry.externalUpstream?.endpoint), state: state?.state ?? (entry.externalUpstream?.endpoint ? 'connecting' : 'not-configured'), loginVerified: state?.state === 'online', code: state?.code, updatedAt: state?.updatedAt ?? entry.updatedAt }
      }),
      workers: running,
      timestamp: new Date().toISOString(),
    }
  })
  // P0-3：账号向导"测试连接"——具体探测逻辑在 runtime/probe-upstream（可单测）。
  // P2 输入边界：入参长度钳制后再进探测（防渲染层 bug 传超长串进 URL 解析）。
  registerHandle('connection:probe-upstream', async (_event, endpoint: unknown, token: unknown, request?: { storyId?: string; selfId?: string; useLocalToken?: boolean; reuseSavedToken?: boolean }) => {
    const address = typeof endpoint === 'string' ? endpoint.slice(0, 2048) : ''
    const selfId = String(request?.selfId ?? '').slice(0, 64)
    try {
      const resolved = await resolveUpstreamToken({ endpoint: address, token: typeof token === 'string' ? token.slice(0, 512) : undefined, storyId: String(request?.storyId ?? ''), selfId, useLocalToken: request?.useLocalToken === true, reuseSavedToken: request?.reuseSavedToken !== false }, ctx.accountRegistry, ctx.secrets)
      return await probeUpstream(address, resolved, selfId || undefined)
    } catch (error) {
      // 审计 L9：令牌解析失败 ≠ 鉴权失败——别名丢失/密文不可解（换机迁移）与
      // SnowLuma 配置缺失是三种不同方向的排查，不再一律误导为 AUTH_FAILED。
      const message = String(error instanceof Error ? error.message : error)
      if (/别名|alias|解密|decrypt|undecrypt/i.test(message)) {
        return { ok: false, code: 'ONEBOT_AUTH_FAILED', error: `密钥库无法解析已保存令牌（${message}）——请在密钥面板重录后重试。` }
      }
      return { ok: false, code: 'ONEBOT_AUTH_FAILED', error: `无法读取与当前账号、端点匹配的访问令牌（${message}）；请重新填写或检查本机 SnowLuma 配置。` }
    }
  })
  // P0: 首次运行统一状态快照。readyCheck 保留为兼容别名，但两者均由
  // Main 侧同一份 FirstRunReadiness 生成，Renderer 不再自行推断状态。
  registerHandle('connection:firstRunReadiness', (_event, metaId: string) => buildFirstRunReadiness(String(metaId || '')))
}

import { randomUUID } from 'node:crypto'
import { resolveUpstreamToken } from '../runtime/upstream-credentials'
import { registerHandle } from './register'
/**
 * 账号域：accounts:* 四个通道（P2 结构批次，自 main.ts 逐字迁移）。
 * M7-2 原子绑定事务：账号登记（AccountRegistry）与路由绑定（BindingRegistry）
 * 必须同时成立——只有其一会让入站事件 unassigned 或出站无账号。任一步失败
 * 整体回滚，绝不留下半绑定状态。
 */
import { accountChannelKind } from '../runtime/account-registry'
import type { IpcContext } from './context'

export function registerAccountsIpc(ctx: IpcContext) {
  const { stories, bindings, secrets, accountRegistry, onebot, externalConnectionStates, externalAccountStates, broadcast, reconcileExternalConnector } = ctx
  registerHandle('accounts:list', () => accountRegistry.list().map(entry => {
    const status = externalAccountStates.get('onebot:' + entry.selfId)
    return { ...entry, externalState: status?.state ?? (entry.externalUpstream?.endpoint ? 'connecting' : 'not-configured'), externalCode: status?.code, externalMessage: status?.error }
  }))
  registerHandle('accounts:bind', async (_event, metaId: string, selfId: unknown, nickname: unknown, upstream?: unknown, channelKind?: unknown) => {
    let createdAlias: string | undefined
    let upstreamConfig: { endpoint: string, tokenAlias?: string } | undefined
    if (upstream && typeof upstream === 'object' && typeof (upstream as any).endpoint === 'string' && (upstream as any).endpoint.trim()) {
      const endpoint = String((upstream as any).endpoint).trim()
      let parsed: URL
      try { parsed = new URL(endpoint) } catch { throw new Error('外部 OneBot 地址必须是有效 ws:// 或 wss:// URL。') }
      if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') throw new Error('外部 OneBot 地址只允许 ws:// 或 wss://。')
      if (parsed.username || parsed.password || parsed.hash || [...parsed.searchParams.keys()].some(key => /token|authorization/i.test(key))) throw new Error('上游地址不得含账号、密码或 URL fragment；token 请使用密钥别名。')
      const tokenAlias = typeof (upstream as any).tokenAlias === 'string' ? String((upstream as any).tokenAlias).trim() : ''
      if (tokenAlias && !secrets.has(tokenAlias)) throw new Error(`上游 token 密钥别名尚未保存：${tokenAlias}`)
      upstreamConfig = { endpoint: parsed.toString(), ...(tokenAlias ? { tokenAlias } : {}) }
    }
    const handle = stories.get(String(metaId || ''))
    if (!handle) throw new Error('剧本不存在。')
    if (handle.running) throw new Error('请先卸载剧本再修改账号绑定（worker 的 OneBot selfId 在启动时读取）。')
    const normalizedKind = channelKind === 'wechat' || channelKind === 'other' ? channelKind : 'qq'
    const normalizedSelfId = String(selfId || '').trim()
    const accountKey = 'onebot:' + normalizedSelfId
    const validSelfId = normalizedKind === 'qq' ? /^\d{5,11}$/.test(normalizedSelfId) : /^[A-Za-z0-9_-]{4,64}$/.test(normalizedSelfId)
    if (!validSelfId) {
      throw new Error(normalizedKind === 'qq'
        ? 'QQ 通道的账号必须是 5–11 位数字。'
        : '该通道的账号只允许 4–64 位字母、数字、下划线或连字符。')
    }
    const previousEntry = accountRegistry.findBySelfId(normalizedSelfId)
    const sameAccount = previousEntry?.storyId === metaId ? previousEntry : undefined
    // Token import is explicit and main-only. A new alias makes failed writes safely reversible.
    if (upstreamConfig && upstream && typeof upstream === 'object') {
      const request = upstream as any
      const token = await resolveUpstreamToken({ endpoint: upstreamConfig.endpoint, selfId: normalizedSelfId, storyId: metaId, token: typeof request.tokenText === 'string' ? request.tokenText.slice(0, 512) : undefined, useLocalToken: normalizedKind === 'qq' && request.useLocalToken === true, reuseSavedToken: request.reuseSavedToken !== false }, accountRegistry, secrets)
      if (token && ((typeof request.tokenText === 'string' && request.tokenText.trim()) || request.useLocalToken === true)) {
        createdAlias = 'onebot-' + randomUUID()
        secrets.set(createdAlias, token)
        upstreamConfig.tokenAlias = createdAlias
      } else if (token && sameAccount?.externalUpstream?.tokenAlias) upstreamConfig.tokenAlias = sameAccount.externalUpstream.tokenAlias
    }
    let registered = false
    let bound = false
    try {
      // W2：register 是 (故事, 账号) 对的 upsert——同故事其它账号不受影响。
      accountRegistry.register(metaId, normalizedSelfId, String(nickname), upstreamConfig, normalizedKind)
      registered = true
      bindings.bind({ accountKey, storyId: metaId, transport: 'onebot-external' }, { replace: true })
      bound = true
    } catch (error) {
      // 回滚：只撤本次调用建立的东西（多账号下旧账号的绑定/登记不再被本次触碰）。
      if (bound && !bindings.find(accountKey)?.storyId) bindings.unbind(accountKey)
      if (registered) {
        if (sameAccount) accountRegistry.register(sameAccount.storyId, sameAccount.selfId, sameAccount.nickname, sameAccount.externalUpstream, sameAccount.channelKind)
        else accountRegistry.removeAccount(metaId, normalizedSelfId)
      }
      if (createdAlias) secrets.remove(createdAlias)
      throw error
    }
    broadcast('story:log', { storyId: metaId, line: '[onebot] 账号绑定完成：' + accountKey + ' → ' + metaId + (accountRegistry.listByStory(metaId).length > 1 ? `（该剧本共 ${accountRegistry.listByStory(metaId).length} 个账号）` : '') })
    // issue #2 边界：worker 在绑定前启动时，resolved 配置不含该账号的注入参数，
    // adapter 连内部桥会被拒——消息收发照常（走 IPC），但插件端点巡检会判离线、
    // 主动消息被拒。绑定不自动重载（避免打断运行中的叙事），在此留痕引导。
    if (handle.running) {
      broadcast('story:log', { storyId: metaId, line: '[onebot] 剧本正在运行：本次绑定在 Worker 重载后生效。若就绪检查提示「内部桥会话未建立」，请重载 Worker。' })
    }
    await reconcileExternalConnector(metaId)
    return { bindings: bindings.list(), accounts: accountRegistry.list() }
  })
  registerHandle('accounts:unbind', async (_event, metaId: string, selfId?: string) => {
    const handle = stories.get(String(metaId || ''))
    if (!handle) throw new Error('剧本不存在。')
    // W2：selfId 给定只解绑该账号（其它账号保留）；缺省解绑全部（旧语义）。
    const targets = selfId ? accountRegistry.listByStory(metaId).filter(entry => entry.selfId === String(selfId).trim()) : accountRegistry.listByStory(metaId)
    if (!targets.length) throw new Error(selfId ? `该剧本没有账号 ${selfId} 的绑定。` : '该剧本没有账号绑定。')
    if (handle.running) throw new Error('请先卸载剧本再解绑账号。')
    for (const entry of targets) {
      bindings.unbind('onebot:' + entry.selfId)
      accountRegistry.removeAccount(metaId, entry.selfId)
      broadcast('story:log', { storyId: metaId, line: '[onebot] 账号解绑：onebot:' + entry.selfId })
    }
    await reconcileExternalConnector(metaId)
    return { bindings: bindings.list(), accounts: accountRegistry.list() }
  })
  registerHandle('accounts:status', (_event, metaId: string) => {
    const entry = accountRegistry.findByStory(String(metaId || ''))
    const binding = entry ? bindings.find('onebot:' + entry.selfId) : undefined
    const workerBridge = onebot.onlineAccounts().find(item => item.storyId === metaId)
    const external = externalConnectionStates.get(String(metaId || '')) ?? { state: entry?.externalUpstream ? 'connecting' : 'not-configured', updatedAt: entry?.updatedAt ?? new Date(0).toISOString() }
    return {
      entry,
      binding: binding ?? undefined,
      // Kept as compatibility alias for existing renderer; it means a worker
      // loopback session, not a real account connection.
      online: workerBridge ?? undefined,
      workerBridge: workerBridge ?? undefined,
      external,
      configuredToStory: binding?.storyId === metaId,
      // W2（B2-5）：每账号登记与连接状态——纯数据暴露，渲染留到 E 阶段。
      accounts: accountRegistry.listByStory(String(metaId || '')).map(account => ({
        selfId: account.selfId,
        nickname: account.nickname,
        channelKind: accountChannelKind(account),
        hasUpstream: !!account.externalUpstream?.endpoint,
        state: externalAccountStates.get('onebot:' + account.selfId)?.state ?? (account.externalUpstream?.endpoint ? 'connecting' : 'not-configured'),
        updatedAt: externalAccountStates.get('onebot:' + account.selfId)?.updatedAt ?? account.updatedAt,
      })),
    }
  })
}

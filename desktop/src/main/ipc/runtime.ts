import { registerHandle } from './register'
/** 运行时资源域：runtime:overview / runtime:resources（P2 结构批次，自 main.ts 逐字迁移）。 */
import type { IpcContext } from './context'

/**
 * V7 状态机面板的 CHANNEL/MODEL 聚合（渲染层遗留修复，2026-10-19）：
 * renderV7Workbench 此前读 hostOverview.channel/model——但 overview() 原始
 * 返回没有这两个字段（恒显示"—"）。这里在 IPC 层聚合主进程现成状态源：
 *  - channel：故事级外部连接 rollup（setExternalConnectionState 维护）；
 *  - model：复用 buildFirstRunReadiness 的 model 检查（与 V4 状态栏同源同语义），
 *    带 15s 缓存——投影刷新是 token 事件 120ms 防抖的高频路径，模型配置只在
 *    保存/重载时变，没必要每次都读 koishi.yml+密钥库；
 *  - updatedAt：V7 渲染 key 的活性段（此前是不存在的死字段）。
 */
const modelStateCache = new Map<string, { at: number, state: 'ok' | 'warn' | 'err' }>()
const MODEL_STATE_TTL_MS = 15_000

function cachedModelState(ctx: IpcContext, storyId: string): 'ok' | 'warn' | 'err' {
  const hit = modelStateCache.get(storyId)
  if (hit && Date.now() - hit.at < MODEL_STATE_TTL_MS) return hit.state
  let state: 'ok' | 'warn' | 'err' = 'warn'
  try {
    const readiness = ctx.buildFirstRunReadiness(storyId)
    if (readiness && typeof readiness === 'object' && !('error' in readiness)) {
      const modelCheck = readiness.checks.find(check => check.id === 'model')
      state = modelCheck?.status === 'ok' ? 'ok' : modelCheck?.status === 'warn' ? 'warn' : 'err'
    }
  } catch { /* 就绪检查失败按状态不明处理 */ }
  modelStateCache.set(storyId, { at: Date.now(), state })
  return state
}

export function registerRuntimeIpc(ctx: IpcContext) {
  const { stories, projections, externalConnectionStates } = ctx
  registerHandle('runtime:overview', async (_event, storyId: unknown) => {
    const id = String(storyId || '')
    const overview = await projections.overview(id)
    return {
      ...overview,
      channel: { state: externalConnectionStates.get(id)?.state ?? 'not-configured' },
      model: { state: cachedModelState(ctx, id) },
      updatedAt: new Date().toISOString(),
    }
  })
  registerHandle('runtime:resources', () => stories.resourceStatus())
}

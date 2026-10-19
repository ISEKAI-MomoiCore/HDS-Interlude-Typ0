import { registerHandle } from './register'
/** Koishi Console 嵌入域：console:* 四个通道（P2 结构批次，自 main.ts 逐字迁移）。 */
import type { IpcContext } from './context'

export function registerConsoleIpc(ctx: IpcContext) {
  const { stories, consoleEmbed, getWindow, isBlindMode } = ctx
  // ── M6 Koishi Surface：endpoint 状态与受控嵌入 ──
  registerHandle('console:info', (_event, metaId: string) => {
    const descriptor = stories.consoles.get(String(metaId || ''))
    return { descriptor, embedded: descriptor ? consoleEmbed.revisionOf(metaId) === descriptor.revision : false }
  })
  registerHandle('console:attach', (_event, metaId: string, bounds: any) => {
    if (isBlindMode()) throw new Error('Blind 模式下不可嵌入 Koishi Console（消息与日志原文会绕过屏蔽）。')
    const handle = stories.get(String(metaId || ''))
    if (!handle) throw new Error('剧本不存在。')
    const descriptor = stories.consoles.get(metaId)
    if (!descriptor || !getWindow()) throw new Error('该故事的 Console endpoint 尚未就绪（Worker 未上报端口）。')
    const safeBounds = bounds && typeof bounds === 'object' ? {
      x: Math.max(0, Number(bounds.x) || 0), y: Math.max(0, Number(bounds.y) || 0),
      width: Math.max(50, Number(bounds.width) || 50), height: Math.max(50, Number(bounds.height) || 50),
    } : { x: 0, y: 0, width: 400, height: 300 }
    consoleEmbed.attach(getWindow()!, metaId, descriptor.endpoint, descriptor.revision, safeBounds)
    return { endpoint: descriptor.endpoint, revision: descriptor.revision }
  })
  registerHandle('console:detach', (_event, metaId: string) => {
    consoleEmbed.detach(String(metaId || ''))
    return true
  })
  registerHandle('console:resize', (_event, metaId: string, bounds: any) => {
    const safeBounds = bounds && typeof bounds === 'object' ? {
      x: Math.max(0, Number(bounds.x) || 0), y: Math.max(0, Number(bounds.y) || 0),
      width: Math.max(50, Number(bounds.width) || 50), height: Math.max(50, Number(bounds.height) || 50),
    } : undefined
    if (safeBounds) consoleEmbed.resize(String(metaId || ''), safeBounds)
    return true
  })
}

/** 日志域：logs:* 三个通道（P2 结构批次，自 main.ts 逐字迁移）。 */
import { dialog, session } from 'electron'
import { registerHandle } from './register'
import type { IpcContext } from './context'

export function registerLogsIpc(ctx: IpcContext) {
  const { logs, stories, consoleEmbed, getWindow, setBlindMode } = ctx
  registerHandle('logs:query', (_event, query) => logs.query(query && typeof query === 'object' ? query : {}))
  registerHandle('logs:export', async (_event, options) => {
    const safe = options && typeof options === 'object' ? options as Record<string, unknown> : {}
    const storyId = typeof safe.storyId === 'string' && safe.storyId ? safe.storyId : undefined
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const name = `logs-${storyId || 'desktop'}-${stamp}.ndjson`
    const chosen = await dialog.showSaveDialog({ title: '导出日志（应用 Blind 规则）', defaultPath: name })
    if (chosen.canceled || !chosen.filePath) return { canceled: true }
    return { canceled: false, ...await logs.exportLogs({ storyId, from: typeof safe.from === 'string' ? safe.from : undefined, to: typeof safe.to === 'string' ? safe.to : undefined, target: chosen.filePath }) }
  })
  // Blind/失明模式：宿主与 Renderer 同时生效；查询/导出屏蔽正文，视图清空缓冲。
  registerHandle('logs:setBlind', (_event, enabled: unknown) => {
    const on = Boolean(enabled)
    setBlindMode(on)
    if (on) for (const handle of stories.list()) consoleEmbed.dispose(handle.meta.id, partition => { try { session.fromPartition(partition).clearStorageData() } catch { /* best effort */ } })
    logs.setBlindRule(on ? record => `[blinded:${record.level}]` : undefined)
    if (on) logs.record({ level: 'info', source: 'desktop', logger: 'typ-0', message: 'Blind 模式已启用：日志正文在查询与导出中被屏蔽，Koishi Console 嵌入不可用。' })
    else logs.record({ level: 'info', source: 'desktop', logger: 'typ-0', message: 'Blind 模式已关闭。' })
    getWindow()?.webContents.send('logs:blind', on)
    return on
  })
}

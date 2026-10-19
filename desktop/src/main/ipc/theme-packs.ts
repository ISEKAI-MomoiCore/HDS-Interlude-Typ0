import { app } from 'electron'
import { registerHandle } from './register'
/** 主题包域：themePacks:* 通道（P2 结构批次，自 main.ts 逐字迁移）。 */
import type { IpcContext } from './context'

export function registerThemePacksIpc(ctx: IpcContext) {
  const { themePacks } = ctx
  // 主题包 compatibility 判定（min/maxAppVersion）需要真实应用版本；
  // 渲染层此前硬编码 '0.0.1'，应用升级后会静默误判。
  registerHandle('themePacks:appVersion', () => app.getVersion())
  registerHandle('themePacks:pickRead', () => themePacks.pickRead())
  registerHandle('themePacks:listInstalled', () => themePacks.listInstalled())
  registerHandle('themePacks:install', (_event, id: unknown, entries: unknown) => themePacks.install(String(id || ''), entries && typeof entries === 'object' ? entries as Record<string, string> : {}))
  registerHandle('themePacks:write', (_event, name: unknown, entries: unknown) => themePacks.write(String(name || 'theme.hdsitheme'), entries && typeof entries === 'object' ? entries as Record<string, string> : {}))
  registerHandle('themePacks:uninstall', (_event, id: unknown) => themePacks.uninstall(String(id || '')))
}

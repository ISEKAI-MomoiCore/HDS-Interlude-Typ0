import { registerHandle } from './register'
/** 密钥域：secrets:set（P2 结构批次，自 main.ts 逐字迁移）。 */
import type { IpcContext } from './context'

export function registerSecretsIpc(ctx: IpcContext) {
  const { secrets } = ctx
  registerHandle('secrets:set', (_event, alias: string, value: string) => {
    secrets.set(alias, value)
    return secrets.aliases()
  })
}

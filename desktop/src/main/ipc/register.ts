/**
 * IPC 注册包装：全部 ipcMain.handle 经此注册，统一施加调用方门控。
 *
 * P2 输入边界批次（2026-10-18）：域模块一律 `registerHandle(...)` 代替
 * `ipcMain.handle(...)`——channel/参数/行为不变，只在分派前校验
 * `event.sender` 是主窗口 webContents（绑定见 main.ts registerIpc）。
 */
import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { createSenderGuard } from './sender-guard'

let guard: ((sender: unknown) => boolean) | undefined

/** 已注册 channel 清单（自检冒烟用：与 preload invoke 面做程序化对照）。 */
const registeredChannels: string[] = []

/** main.ts 在 registerIpc 时绑定信任 sender 源（主窗口 webContents）。 */
export function bindTrustedSender(getTrusted: () => unknown) {
  guard = createSenderGuard(getTrusted)
}

export function registeredIpcChannels(): string[] {
  return registeredChannels.slice()
}

export function registerHandle<A extends unknown[]>(channel: string, handler: (event: IpcMainInvokeEvent, ...args: A) => unknown) {
  registeredChannels.push(channel)
  ipcMain.handle(channel, (event, ...args) => {
    if (guard && !guard(event.sender)) {
      // 安全拒绝不写日志（避免被噪声刷屏用于探测），错误消息不泄露门控细节。
      throw new Error('该调用方无权访问 typ-0 宿主 IPC。')
    }
    return handler(event, ...(args as A))
  })
}

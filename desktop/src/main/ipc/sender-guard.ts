/**
 * IPC 调用方门控谓词（纯函数，无 electron 依赖——合同测试直接实例化）。
 *
 * 语义：sender 与当前信任源（主窗口 webContents）为同一对象才放行；
 * 信任源不存在（窗口未建/已毁）时**一律拒绝**（fail-closed）。当前 Console
 * BrowserView 因 sandbox+无 preload "恰好打不进来"——本守卫把它升级为
 * "被拒绝"：即使未来某个视图意外获得桥接能力，也无法触达宿主 API。
 */
export function createSenderGuard(getTrusted: () => unknown): (sender: unknown) => boolean {
  return sender => {
    const trusted = getTrusted()
    return trusted !== undefined && trusted !== null && sender === trusted
  }
}

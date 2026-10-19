import { BrowserView } from 'electron'
import type { BrowserWindow } from 'electron'

/**
 * M6 Koishi Surface：隔离的 Console 嵌入容器。
 *
 * 安全边界（T3.7.2）：
 *  - 独立 session partition（每故事一份），不共享 typ-0 主窗口的会话与缓存；
 *  - 页面没有 Node / preload / typ-0 桥接能力，只有 Console 自身的静态资源；
 *  - 只允许导航到该故事已登记的 loopback endpoint（ConsoleRegistry 白名单），
 *    其余导航、新窗口、外链一律拦截；
 *  - Worker 重启后 revision 变化，旧视图必须销毁而非复用。
 */
export class ConsoleEmbedService {
  /** 每个故事同时至多一个嵌入视图；切换故事时销毁旧的。 */
  private readonly views = new Map<string, { view: BrowserView, revision: string }>()

  attach(window: BrowserWindow, storyId: string, endpoint: string, revision: string, bounds: { x: number, y: number, width: number, height: number }) {
    this.detach(storyId)
    const partition = `hdsi-console-${storyId}`
    const view = new BrowserView({
      webPreferences: {
        partition,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        // Console 是纯前端资源；不加载任何 typ-0 preload。
        preload: undefined,
      },
    })
    const webContents = view.webContents
    // 导航白名单：仅本故事的 endpoint 前缀。
    webContents.on('will-navigate', (event, url) => {
      if (!this.isAllowedNavigation(storyId, url)) event.preventDefault()
    })
    webContents.setWindowOpenHandler(({ url }) => ({ action: 'deny' }))
    webContents.on('will-attach-webview', event => event.preventDefault())
    // 权限请求（剪贴板、通知等）一律拒绝。
    webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    window.addBrowserView(view)
    view.setBounds(bounds)
    void webContents.loadURL(endpoint).catch(error => {
      // 加载失败不打断桌面端；Renderer 的状态投影会显示 endpoint 不可用。
      console.error('[console] 加载失败', error)
    })
    this.views.set(storyId, { view, revision })
    return view
  }

  detach(storyId: string) {
    const existing = this.views.get(storyId)
    if (!existing) return
    const { view } = existing
    try {
      view.setBounds({ x: 0, y: 0, width: 0, height: 0 })
      ;(view.webContents as unknown as { destroy?: () => void }).destroy?.()
    } catch { /* view may already be destroyed with its window */ }
    this.views.delete(storyId)
  }

  revisionOf(storyId: string) {
    return this.views.get(storyId)?.revision
  }

  resize(storyId: string, bounds: { x: number, y: number, width: number, height: number }) {
    const existing = this.views.get(storyId)
    if (existing) existing.view.setBounds(bounds)
  }

  /** worker 退出/卸载后销毁视图并清理对应 session（隐私与句柄双保险）。 */
  dispose(storyId: string, sessionCleanup?: (partition: string) => void) {
    this.detach(storyId)
    sessionCleanup?.(`hdsi-console-${storyId}`)
  }

  private isAllowedNavigation(storyId: string, url: string) {
    // Registry 校验逻辑在主进程内复用，防止容器被引导到任意地址。
    return this.allowed?.(storyId, url) ?? false
  }

  /** 由 main.ts 注入 ConsoleRegistry.isAllowedNavigation，保持模块无依赖。 */
  setNavigationGuard(allowed: (storyId: string, url: string) => boolean) {
    this.allowed = allowed
  }

  private allowed?: (storyId: string, url: string) => boolean
}

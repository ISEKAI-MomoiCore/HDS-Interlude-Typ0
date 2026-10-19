import { randomUUID } from 'node:crypto'

/**
 * M6 Koishi Surface：每故事 loopback Console endpoint 的宿主登记表。
 *
 * 端口事实来自 worker 自己的汇报（bridge-ready / console-ready 事件），宿主
 * 不猜测端口；worker 退出或重启后 descriptor 立即失效并更换 revision，旧页面
 * 不能继续控制新 worker。端点永远绑定 127.0.0.1，不对外网暴露。
 */
export interface ConsoleDescriptor {
  storyId: string
  /** 永远是 127.0.0.1；整条 URL 供隔离容器做导航白名单。 */
  origin: string
  uiPath: string
  endpoint: string
  revision: string
  reportedAt: string
}

export class ConsoleRegistry {
  private readonly descriptors = new Map<string, ConsoleDescriptor>()

  register(storyId: string, port: number, uiPath = '/console/'): ConsoleDescriptor {
    if (!Number.isInteger(port) || port <= 0 || port > 65_535) throw new Error(`无效 Console 端口：${port}`)
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(storyId)) throw new Error(`无效故事 ID：${storyId}`)
    const origin = `http://127.0.0.1:${port}`
    const descriptor: ConsoleDescriptor = {
      storyId, origin, uiPath,
      endpoint: `${origin}${uiPath.replace(/^\/?/, '/')}`,
      revision: randomUUID(),
      reportedAt: new Date().toISOString(),
    }
    this.descriptors.set(storyId, descriptor)
    return descriptor
  }

  get(storyId: string) {
    const descriptor = this.descriptors.get(storyId)
    return descriptor ? { ...descriptor } : undefined
  }

  /** Worker 退出/卸载/重启前调用：endpoint 失效，嵌入容器必须先销毁再重建。 */
  revoke(storyId: string) {
    this.descriptors.delete(storyId)
  }

  /** 一个 endpoint 只能属于一个故事；被其它故事占用时返回其 storyId。 */
  findOwner(origin: string) {
    for (const [storyId, descriptor] of this.descriptors) {
      if (descriptor.origin === origin) return storyId
    }
    return undefined
  }

  /** 校验 URL 是否是已登记 endpoint 的严格前缀导航（拦截任意网址/下载）。 */
  isAllowedNavigation(storyId: string, url: string) {
    const descriptor = this.descriptors.get(storyId)
    if (!descriptor) return false
    try {
      const target = new URL(url)
      const expected = new URL(descriptor.endpoint)
      if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1') return false
      if (target.port !== expected.port) return false
      return target.pathname === expected.pathname || target.pathname.startsWith(expected.pathname)
    } catch { return false }
  }
}

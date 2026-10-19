/**
 * V3 §22.3/§40.1 语义基础：View Model。社区界面（未来的 Layout DSL 与
 * 沙箱包）读取的是稳定的、经过脱敏的视图模型，而不是渲染层的散装状态。
 * 本模块是第一个增量：app.js 把各命名空间的数据源绑进来，UI 与未来的
 * 声明式页面通过 get/subscribe 消费，绝不直接摸内部 state 对象。
 */
(function (root, factory) {
  const api = factory(root)
  if (typeof module !== 'undefined') module.exports = api
  else root.HDSIViewModel = api
})(typeof self !== 'undefined' ? self : globalThis, function (root) {
  'use strict'

  const providers = new Map()   // namespace → () => snapshot
  const listeners = new Map()   // 订阅键（精确名或 ns.*）→ Set<fn>

  function bind(namespace, provider) {
    if (typeof provider !== 'function') return false
    providers.set(namespace, provider)
    return true
  }

  /** get('story.overview') → providers.story().overview；越界返回 undefined */
  function get(path) {
    const dot = String(path || '').indexOf('.')
    if (dot <= 0) return undefined
    const ns = path.slice(0, dot), key = path.slice(dot + 1)
    const provider = providers.get(ns)
    if (!provider) return undefined
    try { return provider()[key] } catch { return undefined }
  }

  function snapshot(namespace) {
    const provider = providers.get(namespace)
    if (!provider) return undefined
    try { return provider() } catch { return undefined }
  }

  function matches(pattern, path) {
    return pattern === path || pattern.endsWith('.*') && path.startsWith(pattern.slice(0, -1))
  }

  function subscribe(pattern, listener) {
    if (typeof listener !== 'function') return () => {}
    if (!listeners.has(pattern)) listeners.set(pattern, new Set())
    listeners.get(pattern).add(listener)
    return () => { listeners.get(pattern)?.delete(listener) }
  }

  /** app.js 在数据变化点调用；只通知相关命名空间的订阅者 */
  function notify(namespace) {
    const snap = snapshot(namespace)
    for (const [pattern, set] of listeners) {
      if (!matches(pattern, namespace) && !pattern.startsWith(namespace + '.')) continue
      for (const listener of set) {
        try { listener(snap) } catch { /* 单个订阅者出错不拖垮其他 */ }
      }
    }
  }

  function namespaces() { return [...providers.keys()] }

  return { bind, get, snapshot, subscribe, notify, namespaces }
})

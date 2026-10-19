/**
 * V3 §22.4/§40.1 语义基础：Action Registry。UI 与未来的声明式/沙箱界面
 * 只能通过官方动作 ID 触发行为，不能绕过注册表直接摸 desktop.* IPC。
 * 危险动作在注册时声明 confirm 策略，dispatch 强制走确认，主题/布局层
 * 无法关闭它（§32.1：核心安全约束永远压过社区定义）。
 */
(function (root, factory) {
  const api = factory(root)
  if (typeof module !== 'undefined') module.exports = api
  else root.HDSIActions = api
})(typeof self !== 'undefined' ? self : globalThis, function (root) {
  'use strict'

  const registry = new Map()    // actionId → { label, confirm, handler }
  const recent = []             // 最近一次动作记录（§34.4 故障隔离的种子）

  function register(id, definition) {
    if (!/^[a-z][a-zA-Z]*(\.[a-z][a-zA-Z]*)+$/.test(String(id || ''))) return false
    if (typeof definition?.handler !== 'function') return false
    // 审计：confirm === true 会把字符串自定义文案压成 false（"confirm 不可绕过"
    // 的安全合约失效，dispatch 的字符串分支成为死代码）。保留原值。
    registry.set(id, { label: definition.label || id, confirm: definition.confirm ?? false, handler: definition.handler })
    return true
  }

  async function dispatch(id, args) {
    const def = registry.get(id)
    if (!def) { console.warn('[HDSIActions] 未注册动作:', id); return { ok: false, error: 'unknown-action' } }
    if (def.confirm) {
      const message = typeof def.confirm === 'string' ? def.confirm : `确认执行「${def.label}」？`
      // 确认策略由注册表强制执行，调用方（含未来的主题包）无法跳过。
      if (typeof root.confirm === 'function' && !root.confirm(message)) {
        return { ok: false, error: 'cancelled' }
      }
    }
    recent.length = 0
    recent.push({ id, at: new Date().toISOString() })
    try {
      const result = await def.handler(args)
      return { ok: true, result }
    } catch (error) {
      console.warn('[HDSIActions] 动作失败:', id, error)
      return { ok: false, error: String(error) }
    }
  }

  function can(id) { return registry.has(id) }
  function list() { return [...registry.entries()].map(([id, def]) => ({ id, label: def.label, confirm: !!def.confirm })) }
  function lastAction() { return recent[0] || null }

  return { register, dispatch, can, list, lastAction }
})

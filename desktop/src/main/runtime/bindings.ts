import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { AccountBinding } from './contracts'
import { readJsonFileOrQuarantine, writeJsonAtomic } from './json-file'

interface BindingFile { version: 1, bindings: AccountBinding[] }

/** accountKey 到剧本的唯一绑定表。它只负责路由，不保存角色或模型状态。 */
export class BindingRegistry {
  private readonly file: string
  /** 性能审计：find() 在每条入站消息热路径上——载入一次 + 写穿缓存
   * （单写者进程，HostLock 保证无外部并发写；损坏文件隔离防静默清史）。 */
  private cache: BindingFile | undefined

  constructor(dataRoot: string) {
    mkdirSync(dataRoot, { recursive: true })
    this.file = path.join(dataRoot, 'bindings.json')
  }

  list(): AccountBinding[] { return this.read().bindings }
  find(accountKey: string): AccountBinding | undefined {
    return this.read().bindings.find(item => item.accountKey === accountKey)
  }

  bind(input: Omit<AccountBinding, 'updatedAt'>, options: { replace?: boolean } = {}) {
    if (!input.accountKey || !input.storyId) throw new Error('账号绑定缺少 accountKey 或 storyId。')
    const state = this.read()
    const existing = state.bindings.find(item => item.accountKey === input.accountKey)
    if (existing && existing.storyId !== input.storyId && !options.replace) {
      throw new Error(`账号 ${input.accountKey} 已绑定到剧本 ${existing.storyId}；请先明确解绑或替换。`)
    }
    const binding: AccountBinding = { ...input, updatedAt: new Date().toISOString() }
    state.bindings = state.bindings.filter(item => item.accountKey !== input.accountKey)
    state.bindings.push(binding)
    this.write(state)
    return binding
  }

  unbind(accountKey: string) {
    const state = this.read()
    const before = state.bindings.length
    state.bindings = state.bindings.filter(item => item.accountKey !== accountKey)
    if (state.bindings.length !== before) this.write(state)
    return before !== state.bindings.length
  }

  /** Story removal must not leave invisible bindings that capture future input. */
  unbindStory(storyId: string) {
    const state = this.read()
    const removed = state.bindings.filter(item => item.storyId === storyId)
    if (removed.length) {
      state.bindings = state.bindings.filter(item => item.storyId !== storyId)
      this.write(state)
    }
    return removed
  }

  private read(): BindingFile {
    if (this.cache) return this.cache
    const raw = readJsonFileOrQuarantine<BindingFile>(this.file, { version: 1, bindings: [] })
    this.cache = raw.version === 1 && Array.isArray(raw.bindings) ? raw : { version: 1, bindings: [] }
    return this.cache
  }

  private write(state: BindingFile) {
    writeJsonAtomic(this.file, state)
    this.cache = state
  }
}

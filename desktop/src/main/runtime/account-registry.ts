import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { mkdirSync } from 'node:fs'
import { writeJsonAtomic } from './json-file'

/**
 * 宿主侧 OneBot 账号登记表：剧本宣称自己使用的账号（selfId + nickname）。
 * 与 BindingRegistry 分工——登记表回答"这个剧本宣称自己是谁"（get_login_info
 * 应答的数据源、账号目录 UI），BindingRegistry 回答"哪个账号的事件路由给哪个剧本"。
 * 明文 JSON 是 M7 权益；此文件不含密钥（token 走密钥库/koishi.yml）。
 *
 * W2（B2-1）多账号化：一个剧本可登记多个账号（同一人格的多个端点）。
 * 不变量保持——同一 selfId 全局只能属于一个剧本（先到先得，显式覆盖需先移除）；
 * 兼容读取——旧单账号 JSON 原样读入，findByStory 返回首个（调用方逐步迁移 listByStory）。
 */
export type OneBotChannelKind = 'qq' | 'wechat' | 'other'

export interface OneBotAccountEntry {
  /** OneBot 账号标识；QQ 为数字 ID，其它通道可使用自身的字符串 ID。 */
  selfId: string
  nickname: string
  /** 拥有该账号登记的故事。 */
  storyId: string
  /** W2：通道类型；旧数据缺失时按 qq 兼容读取。 */
  channelKind?: OneBotChannelKind
  /**
   * M7-3：外部 OneBot 上游（真实实现 NapCat/Lagrange/SnowLuma 的 WS 端点）。
   * 未配置时没有真实渠道；内部 worker 门面只服务 adapter-onebot 协议，不会
   * 替代真实发送端。配置后 ExternalOneBotConnector 作为 WS 客户端连入上游。
   * token 用别名引用宿主密钥库，不落盘。
   */
  externalUpstream?: { endpoint: string, tokenAlias?: string }
  updatedAt: string
}

interface AccountFile { version: 1, accounts: OneBotAccountEntry[] }

/** 缺省通道：旧数据无 channelKind 字段按 qq 读。 */
export function accountChannelKind(entry: OneBotAccountEntry): OneBotChannelKind {
  return entry.channelKind === 'wechat' || entry.channelKind === 'other' ? entry.channelKind : 'qq'
}

export class AccountRegistry {
  private readonly file: string
  /** 性能审计：list/listByStory 在账号状态翻动与 UI 刷新上高频重读——
   * 载入一次 + 写穿缓存（单写者进程；损坏文件隔离防静默清史）。 */
  private cache: AccountFile | undefined

  constructor(dataRoot: string) {
    mkdirSync(dataRoot, { recursive: true })
    this.file = path.join(dataRoot, 'accounts.json')
  }

  private read(): AccountFile {
    if (this.cache) return this.cache
    if (!existsSync(this.file)) return { version: 1, accounts: [] }
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf-8')) as AccountFile
      this.cache = raw.version === 1 && Array.isArray(raw.accounts) ? raw : { version: 1, accounts: [] }
      return this.cache
    } catch (error) {
      // 审计：损坏文件静默回退空表 + 下一次 write 会把空状态写回磁盘 = 全部账号
      // 登记永久丢失。先把坏文件隔离（保留人工恢复机会），再以空表继续。
      try { renameSync(this.file, `${this.file}.corrupt-${Date.now()}`) } catch { /* 隔离失败时仍继续（原文件会被覆盖，与旧行为一致） */ }
      // eslint-disable-next-line no-console -- 登记表自举早期 LogBroker 可能未就绪
      console.error(`[account-registry] accounts.json 解析失败，已隔离损坏文件：${error}`)
      return { version: 1, accounts: [] }
    }
  }

  /** 审计：与兄弟登记表（bindings/secrets/usage）一致——tmp+rename 原子写，
   * 半写的文件不再可能被读侧判为损坏。写后同步缓存。 */
  private write(state: AccountFile) {
    writeJsonAtomic(this.file, state)
    this.cache = state
  }

  list(): OneBotAccountEntry[] {
    return this.read().accounts.map(item => ({ ...item }))
  }

  /** W2：故事的全部账号登记（多账号路径）。 */
  listByStory(storyId: string): OneBotAccountEntry[] {
    return this.read().accounts.filter(item => item.storyId === storyId).map(item => ({ ...item }))
  }

  findByStory(storyId: string): OneBotAccountEntry | undefined {
    const found = this.read().accounts.find(item => item.storyId === storyId)
    return found ? { ...found } : undefined
  }

  findBySelfId(selfId: string): OneBotAccountEntry | undefined {
    const trimmed = String(selfId || '').trim()
    const found = this.read().accounts.find(item => item.selfId === trimmed)
    return found ? { ...found } : undefined
  }

  /** 登记或更新一个 (故事, 账号) 对；同一 selfId 全局唯一（跨故事冲突拒绝）。
   * W2 语义：同故事其它账号不受影响——这是"加一个端点"而非"换绑"。 */
  register(storyId: string, selfId: string, nickname: string, externalUpstream?: { endpoint: string, tokenAlias?: string }, channelKind?: OneBotChannelKind): OneBotAccountEntry {
    const trimmedId = String(selfId || '').trim()
    const channelWasProvided = channelKind !== undefined
    const normalizedKind: OneBotChannelKind = channelKind === 'wechat' || channelKind === 'other' ? channelKind : 'qq'
    const validId = normalizedKind === 'qq' ? /^\d{5,11}$/.test(trimmedId) : /^[A-Za-z0-9_-]{4,64}$/.test(trimmedId)
    if (!validId) {
      throw new Error(normalizedKind === 'qq'
        ? 'QQ 通道的账号必须是 5–11 位数字。'
        : '该通道的账号只允许 4–64 位字母、数字、下划线或连字符。')
    }
    const state = this.read()
    const conflict = state.accounts.find(item => item.selfId === trimmedId && item.storyId !== storyId)
    if (conflict) throw new Error(`账号 ${trimmedId} 已被剧本 ${conflict.storyId} 声明。请先移除该登记。`)
    const now = new Date().toISOString()
    const existingIndex = state.accounts.findIndex(item => item.storyId === storyId && item.selfId === trimmedId)
    const entry: OneBotAccountEntry = {
      selfId: trimmedId, nickname: String(nickname || trimmedId).trim().slice(0, 64), storyId,
      ...(normalizedKind !== 'qq' ? { channelKind: normalizedKind } : {}),
      ...(externalUpstream?.endpoint ? { externalUpstream } : {}),
      updatedAt: now,
    }
    if (existingIndex >= 0) {
      // 更新既有 (故事, 账号) 对：未显式传入的可选字段沿用旧值，避免把
      // 已配置的外部上游/通道标签静默抹掉（对齐旧版 T24b 的教训）。
      const previous = state.accounts[existingIndex]
      const merged: OneBotAccountEntry = {
        ...entry,
        ...(entry.externalUpstream ? {} : previous.externalUpstream ? { externalUpstream: previous.externalUpstream } : {}),
        ...(channelWasProvided ? {} : previous.channelKind ? { channelKind: previous.channelKind } : {}),
      }
      state.accounts[existingIndex] = merged
      this.write(state)
      return { ...merged }
    }
    state.accounts.push(entry)
    this.write(state)
    return { ...entry }
  }

  /** W2：移除故事的单个账号登记（其它账号保留）。 */
  removeAccount(storyId: string, selfId: string): boolean {
    const trimmed = String(selfId || '').trim()
    const state = this.read()
    const next = state.accounts.filter(item => !(item.storyId === storyId && item.selfId === trimmed))
    if (next.length === state.accounts.length) return false
    this.write({ version: 1, accounts: next })
    return true
  }

  removeByStory(storyId: string): boolean {
    const state = this.read()
    const next = state.accounts.filter(item => item.storyId !== storyId)
    if (next.length === state.accounts.length) return false
    this.write({ version: 1, accounts: next })
    return true
  }
}

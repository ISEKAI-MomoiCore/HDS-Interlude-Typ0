/**
 * 插件版 Koishi 配置 → typ0 剧本配置的导入器（配置节级搬运 + 可选整库导入）。
 *
 * 源形态：插件版 koishi.yml 的 plugins 段（hds-interlude:* 配置节 + 真实
 * adapter-onebot:* 上游实例）。目标形态：typ0 三层——每故事 canonical
 * koishi.yml（adapter 固定连内部桥）、宿主账号登记表、$secret: 密钥库。
 *
 * 三处实质转换（其余为节级搬运）：
 *  1. 密钥：插件版明文 apiKey/token → SecretStore 别名 + `$secret:` 引用
 *     （mediator 硬拒绝明文敏感键，别名必须先落库再保存）。
 *  2. adapter：源 adapter 绝不写进剧本（编译期会被桥接注入覆盖）；正向 WS
 *     实例转成账号登记（externalUpstream），反向 WS 明确拒绝自动绑定。
 *  3. 数据库（m4 可选模块）：插件版 koishi.db 整库文件级替换为新剧本的
 *     data/hdsi.db——两边同为 rc57 插件 schema，无需转译（见 koishi-db-import.ts）。
 */
import { randomUUID } from 'node:crypto'
import { existsSync, rmSync } from 'node:fs'
import path from 'node:path'
import yaml from 'js-yaml'
import type { AccountRegistry } from './account-registry'
import type { BindingRegistry } from './bindings'
import type { SecretStore } from './secrets'
import type { StoryConfigMediator } from './config-mediator'
import { copyKoishiDb } from './koishi-db-import'

/** 状态机/运行行为节（【节奏/内在/表达/扩展】全家桶）。 */
export const BEHAVIOR_KEYS = [
  'runtime', 'urge', 'schedulePreplan', 'timelineDirector', 'agency', 'memory',
  'alterSystem', 'worldSeeder', 'weather', 'longHorizon', 'qzone', 'chatActions', 'stickers',
] as const
export type BehaviorKey = typeof BEHAVIOR_KEYS[number]

export interface ImportModules {
  persona: boolean
  relations: boolean
  accounts: boolean
  model: boolean
  behavior: boolean
  mainPrompt: boolean
  misc: boolean
  database: boolean
}

export interface ImportSource {
  file: string
  /** koishi.yml 所在目录（主进程内部；execute 时解析数据库绝对路径用）。 */
  ymlDir?: string
  /** 源 koishi.db（主进程内部；pickAnalyze 探测后由 IPC 层注入）。 */
  database?: {
    path: string
    selfIds: string[]
    counts: Record<string, number>
    walActive: boolean
  }
  hdsiKey: string
  hdsi: Record<string, unknown>
  adapters: Array<{ selfId: string, protocol: string, endpoint: string, token: string, reverse: boolean }>
}

export interface ImportAnalysis {
  file: string
  modules: {
    persona: { present: boolean, characterName: string }
    relations: { users: number, groups: number }
    accounts: { bots: number, adapters: Array<{ selfId: string, protocol: string, endpoint: string, reverse: boolean }>, bindable: number }
    model: { providers: number, modes: string[], plaintextKeys: number, secretRefs: number }
    behavior: Array<{ key: BehaviorKey, present: true, enabled: boolean | null }>
    mainPrompt: { present: boolean }
    misc: { blindMode: boolean, logging: boolean }
    /** 数据库模块：analyze 只填 configured/relativePath（纯函数无 IO），
     *  IPC 层探测磁盘后改写为完整形态（found/sizeBytes/counts/…）。 */
    database: {
      configured: boolean
      relativePath: string
      found?: boolean
      sizeBytes?: number
      interludeTables?: number
      counts?: Record<string, number>
      storySelfIds?: string[]
      walActive?: boolean
      error?: string
    }
  }
  warnings: string[]
}

export interface ImportExecuteResult {
  storyId: string
  storyName: string
  report: Array<{ module: string, status: 'ok' | 'skipped' | 'warning', detail: string }>
  secrets: string[]
  account?: { selfId: string, endpoint: string, tokenAlias?: string }
}

export interface ImporterDeps {
  storiesRoot: string
  createStory: (payload: { id: string, name: string, characterName: string, description: string }) => { dir: string }
  config: Pick<StoryConfigMediator, 'read' | 'save'>
  secrets: Pick<SecretStore, 'has' | 'set' | 'tryGet' | 'remove'>
  accountRegistry: AccountRegistry
  bindings: BindingRegistry
  syncExternalConnector: (storyId: string) => void
  broadcastStoriesChanged: () => void
  /** 账号转移用：占用剧本在跑时先卸载（worker 启动时读 selfId，热占会双端抢消息）。 */
  isStoryRunning?: (storyId: string) => boolean
  unloadStory?: (storyId: string) => Promise<void>
  /** 回滚恢复用：转移时被卸载的运行中剧本，导入失败后按原运行态重载。 */
  loadStory?: (storyId: string) => unknown
}

type RecordLike = Record<string, unknown>
const isRecord = (value: unknown): value is RecordLike => !!value && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown) => (typeof value === 'string' ? value : '')

/** Koishi 的插件可挂在 plugins 顶层，也可嵌在 group:* 分组下（真实插件版
 *  koishi.yml 的 hds-interlude 就在 group:adapter 里）——递归扫描两层结构。 */
const MAX_GROUP_DEPTH = 4
function findPluginConfigs(plugins: RecordLike, matcher: (key: string) => boolean, depth = 0, trail = 'plugins'): Array<{ key: string, path: string, config: RecordLike }> {
  const found: Array<{ key: string, path: string, config: RecordLike }> = []
  for (const key of Object.keys(plugins)) {
    const value = plugins[key]
    if (matcher(key) && isRecord(value)) found.push({ key, path: `${trail}.${key}`, config: value })
    else if (depth < MAX_GROUP_DEPTH && /^group:/.test(key) && isRecord(value)) found.push(...findPluginConfigs(value, matcher, depth + 1, `${trail}.${key}`))
  }
  return found
}

/** 解析插件版 koishi.yml。返回的 source 仅供主进程内部使用（含明文密钥），
 *  绝不整体下发渲染层；analysis 已脱敏（endpoint 去查询串、无密钥值）。 */
export function analyzeKoishiYml(source: string): { ok: true, analysis: ImportAnalysis, source: ImportSource } | { ok: false, error: string } {
  let doc: unknown
  try { doc = yaml.load(source) } catch (error) {
    return { ok: false, error: `koishi.yml 不是有效 YAML：${error instanceof Error ? error.message : String(error)}` }
  }
  const plugins = isRecord(doc) ? doc.plugins : undefined
  if (!isRecord(plugins)) return { ok: false, error: '文件缺少 plugins 段——请选择插件版 HDS-Interlude 的 koishi.yml。' }
  const hdsiEntries = findPluginConfigs(plugins, key => /^hds-interlude:/.test(key))
  if (!hdsiEntries.length) return { ok: false, error: '未找到 hds-interlude 插件配置（已扫描 plugins 顶层与各 group 分组）——请选择插件版 HDS-Interlude 的 koishi.yml。' }
  const hdsiEntry = hdsiEntries[0]
  const warnings: string[] = []
  if (hdsiEntries.length > 1) warnings.push(`检测到 ${hdsiEntries.length} 个 hds-interlude 实例（${hdsiEntries.map(entry => entry.path).join('、')}），导入第一个。`)
  const hdsiKey = hdsiEntry.key
  const hdsi = hdsiEntry.config

  const adapters: ImportSource['adapters'] = []
  for (const entry of findPluginConfigs(plugins, key => /^adapter-onebot:/.test(key))) {
    const adapter = entry.config
    const protocol = text(adapter.protocol) || 'ws'
    const endpoint = text(adapter.endpoint).trim()
    const reverse = protocol.includes('reverse')
    adapters.push({ selfId: text(adapter.selfId).trim(), protocol, endpoint, token: text(adapter.token), reverse })
  }
  const bindable = adapters.filter(adapter => !adapter.reverse && adapter.endpoint && adapter.selfId).length
  if (adapters.length > 1) warnings.push(`检测到 ${adapters.length} 个 adapter-onebot 实例；typ0 一个剧本绑定一个账号，将绑定第一个正向 WS 实例，其余需另建剧本。`)
  for (const adapter of adapters) {
    if (adapter.reverse) warnings.push(`账号 ${adapter.selfId || '?'} 使用反向 WS（${adapter.protocol}）：typ0 外部连接器仅支持正向 WS 客户端，不自动绑定——请在上游开启正向 WS 后到连接页补填。`)
    else if (!adapter.endpoint || !adapter.selfId) warnings.push(`adapter 实例 ${adapter.selfId || '?'} 缺少 selfId 或端点，跳过绑定。`)
  }

  // database-sqlite 的库文件相对路径（IPC 层据此探测磁盘上的 koishi.db）。
  const sqliteEntry = findPluginConfigs(plugins, key => /^database-sqlite:/.test(key))[0]
  const sqliteRelativePath = text(sqliteEntry?.config.path).trim() || 'data/koishi.db'

  const onebot = isRecord(hdsi.onebot) ? hdsi.onebot : {}
  const model = isRecord(hdsi.model) ? hdsi.model : {}
  const providers = Array.isArray(model.providers) ? model.providers.filter(isRecord) : []
  let plaintextKeys = 0, secretRefs = 0
  for (const provider of providers) {
    const apiKey = text(provider.apiKey).trim()
    if (apiKey.startsWith('$secret:')) secretRefs += 1
    else if (apiKey) plaintextKeys += 1
  }
  if (plaintextKeys) warnings.push(`检测到 ${plaintextKeys} 个明文 API Key：导入时自动转入本机密钥库并替换为 $secret: 别名（不写入剧本文件、不进日志）。`)
  // 审计 L12：providers[].apiKey 之外的明文敏感键（persona/qzone/weather 等
  // 节）不会被自动迁移，最终保存会被密钥边界硬拒——分析阶段前置警告，用户
  // 不必等到执行失败回滚才发现要改源 yml。结构性遍历而非行扫描：块标量里
  // 的示例文本（如主提示词中粘贴的 token: xxx）不误报。
  {
    const SENSITIVE_KEY = /^(?:api[-_]?key|access[-_]?token|refresh[-_]?token|auth[-_]?token|bot[-_]?token|client[-_]?secret|secret[-_]?key|authorization|password|passwd|token|secret)$/i
    const others: string[] = []
    const walk = (node: unknown, trail: string) => {
      if (!node || typeof node !== 'object' || Array.isArray(node)) {
        if (Array.isArray(node)) node.forEach((item, index) => walk(item, `${trail}[${index}]`))
        return
      }
      for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        if (typeof value === 'string' && SENSITIVE_KEY.test(key)) {
          const trimmed = value.trim()
          if (trimmed && trimmed !== 'null' && trimmed !== '~' && !trimmed.startsWith('$secret:')) others.push(`${trail ? trail + '.' : ''}${key}`)
          continue
        }
        // model.providers[].apiKey 走既有迁移路径，不计入
        if (trail === 'model' && key === 'providers') continue
        walk(value, trail ? `${trail}.${key}` : key)
      }
    }
    walk(hdsi, '')
    if (others.length) warnings.push(`检测到 ${others.length} 处不会被自动迁移的明文敏感键（${others.slice(0, 3).join('、')}${others.length > 3 ? ' 等' : ''}）——这些节会原样搬入新剧本并在保存时被密钥边界拒绝；请先在源 yml 改为 $secret: 别名或移除。`)
  }

  const storyDefaults = isRecord(hdsi.storyDefaults) ? hdsi.storyDefaults : {}
  const behavior = BEHAVIOR_KEYS
    .filter(key => hdsi[key] !== undefined)
    .map(key => {
      const node = hdsi[key]
      const enabled = isRecord(node) && typeof node.enabled === 'boolean' ? node.enabled : null
      return { key, present: true as const, enabled }
    })
  const mainPromptPresent = typeof hdsi.mainPrompt === 'string' && hdsi.mainPrompt.trim().length > 0

  return {
    ok: true,
    analysis: {
      file: '',
      modules: {
        persona: { present: Object.keys(storyDefaults).length > 0, characterName: text(storyDefaults.characterName) },
        relations: {
          users: Array.isArray(onebot.userAccounts) ? onebot.userAccounts.length : 0,
          groups: Array.isArray(onebot.groupChats) ? onebot.groupChats.length : 0,
        },
        accounts: {
          bots: Array.isArray(onebot.botAccounts) ? onebot.botAccounts.length : 0,
          adapters: adapters.map(adapter => ({ selfId: adapter.selfId, protocol: adapter.protocol, endpoint: sanitizeEndpoint(adapter.endpoint), reverse: adapter.reverse })),
          bindable,
        },
        model: { providers: providers.length, modes: providers.map(provider => text(provider.mode) || 'openai-compatible'), plaintextKeys, secretRefs },
        behavior,
        mainPrompt: { present: mainPromptPresent },
        misc: { blindMode: hdsi.blindMode !== undefined, logging: hdsi.logging !== undefined },
        database: { configured: sqliteEntry !== undefined, relativePath: sqliteRelativePath },
      },
      warnings,
    },
    source: { file: '', hdsiKey, hdsi, adapters },
  }
}

export function sanitizeEndpoint(endpoint: string) {
  try {
    const url = new URL(endpoint)
    url.search = ''
    url.hash = ''
    return url.toString()
  } catch { return endpoint ? '(无效地址)' : '' }
}

/** 生成或复用密钥别名：同别名同值复用；同别名异值加序号后缀。返回 [alias, created]。 */
function upsertSecret(deps: ImporterDeps, wanted: string, value: string): { alias: string, created: boolean } {
  const tryGet = deps.secrets.tryGet(wanted)
  if (deps.secrets.has(wanted) && tryGet.ok && tryGet.value === value) return { alias: wanted, created: false }
  let alias = wanted
  for (let index = 2; deps.secrets.has(alias); index += 1) alias = `${wanted}-${index}`
  deps.secrets.set(alias, value)
  return { alias, created: true }
}

function aliasSlug(part: string, fallback: string) {
  const slug = part.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32)
  return slug || fallback
}

export interface ImportOptions {
  modules: ImportModules
  storyName?: string
}

export async function executeImport(deps: ImporterDeps, source: ImportSource, options: ImportOptions): Promise<ImportExecuteResult> {
  const report: ImportExecuteResult['report'] = []
  const createdSecrets: string[] = []
  const hdsiSource = source.hdsi
  const storyDefaults = isRecord(hdsiSource.storyDefaults) ? hdsiSource.storyDefaults : {}
  const storyName = (options.storyName || text(storyDefaults.characterName) || '导入的剧本').slice(0, 64)
  const storyId = 'import-' + randomUUID().slice(0, 8)
  const meta = deps.createStory({ id: storyId, name: storyName, characterName: text(storyDefaults.characterName) || storyName, description: '从插件版 koishi.yml 导入' })
  const createdAccount: { registered: boolean, accountKey: string, selfId: string, transferredFrom?: { storyId: string, nickname: string, externalUpstream?: { endpoint: string, tokenAlias?: string }, channelKind?: string, wasRunning?: boolean } } = { registered: false, accountKey: '', selfId: '' }

  try {
    // 剧本 canonical：在模板 doc 上按模块落节，最后一次 mediator.save。
    const doc = yaml.load(deps.config.read(meta.dir)) as RecordLike
    const plugins = isRecord(doc.plugins) ? doc.plugins : undefined
    if (!plugins) throw new Error('剧本模板缺少 plugins 段。')
    const targetKey = Object.keys(plugins).find(key => /^hds-interlude:/.test(key)) ?? 'hds-interlude:m0'
    const target = (isRecord(plugins[targetKey]) ? plugins[targetKey] : {}) as RecordLike
    plugins[targetKey] = target
    const onebotTarget = (isRecord(target.onebot) ? target.onebot : {}) as RecordLike
    target.onebot = onebotTarget
    const onebotSource = isRecord(hdsiSource.onebot) ? hdsiSource.onebot : {}

    // ── 人设 ──
    if (options.modules.persona) {
      if (Object.keys(storyDefaults).length) {
        target.storyDefaults = { ...storyDefaults }
        report.push({ module: '人设与故事', status: 'ok', detail: `characterName=${text(storyDefaults.characterName) || '(未命名)'}` })
      } else report.push({ module: '人设与故事', status: 'skipped', detail: '源配置无 storyDefaults 节' })
    } else report.push({ module: '人设与故事', status: 'skipped', detail: '未选择' })

    // ── 关系 ──
    if (options.modules.relations) {
      const parts: string[] = []
      if (Array.isArray(onebotSource.userAccounts)) { onebotTarget.userAccounts = structuredClone(onebotSource.userAccounts); parts.push(`用户 ${onebotSource.userAccounts.length}`) }
      if (Array.isArray(onebotSource.groupChats)) { onebotTarget.groupChats = structuredClone(onebotSource.groupChats); parts.push(`群聊 ${onebotSource.groupChats.length}`) }
      report.push(parts.length ? { module: '关系（白名单）', status: 'ok', detail: parts.join(' · ') } : { module: '关系（白名单）', status: 'skipped', detail: '源配置无 userAccounts/groupChats' })
    } else report.push({ module: '关系（白名单）', status: 'skipped', detail: '未选择' })

    // ── 账号（botAccounts 节 + 首个正向 WS adapter → 宿主登记） ──
    let account: ImportExecuteResult['account']
    if (options.modules.accounts) {
      if (Array.isArray(onebotSource.botAccounts)) onebotTarget.botAccounts = structuredClone(onebotSource.botAccounts)
      const adapter = source.adapters.find(item => !item.reverse && item.endpoint && item.selfId)
      if (adapter) {
        let url: URL
        try { url = new URL(adapter.endpoint) } catch { throw new Error(`账号 ${adapter.selfId} 的上游地址无效：${sanitizeEndpoint(adapter.endpoint)}`) }
        if (url.protocol !== 'ws:' && url.protocol !== 'wss:') throw new Error(`账号 ${adapter.selfId} 的上游不是 ws:// 地址（${url.protocol}）；typ0 仅支持正向 WS。`)
        if (!/^\d{5,11}$/.test(adapter.selfId)) throw new Error(`账号 ${adapter.selfId} 不是有效的 QQ 号，无法登记。`)
        url.search = ''; url.hash = ''
        let tokenAlias: string | undefined
        if (adapter.token.trim()) {
          const { alias, created } = upsertSecret(deps, `migrated-onebot-${adapter.selfId}-token`, adapter.token.trim())
          tokenAlias = alias
          if (created) createdSecrets.push(alias)
        }
        // 账号全局唯一（先到先得）：被其它剧本占用时执行转移而非报错——
        // 占用剧本在跑则先卸载（worker 的 selfId 是启动时读取的，热占会双端抢消息）。
        const previous = deps.accountRegistry.findBySelfId(adapter.selfId)
        let transferredNote = ''
        if (previous && previous.storyId !== storyId) {
          // 记住是否真的卸载了占用剧本——回滚要按原运行态恢复（审计 H2）。
          let transferredWasRunning = false
          if (deps.isStoryRunning?.(previous.storyId) && deps.unloadStory) {
            await deps.unloadStory(previous.storyId)
            transferredWasRunning = true
          }
          deps.accountRegistry.removeAccount(previous.storyId, adapter.selfId)
          createdAccount.transferredFrom = { storyId: previous.storyId, nickname: previous.nickname, ...(previous.externalUpstream ? { externalUpstream: previous.externalUpstream } : {}), ...(previous.channelKind ? { channelKind: previous.channelKind } : {}), ...(transferredWasRunning ? { wasRunning: true } : {}) }
          transferredNote = `；账号已从剧本 ${previous.storyId} 转移`
        }
        deps.accountRegistry.register(storyId, adapter.selfId, storyName, { endpoint: url.toString(), ...(tokenAlias ? { tokenAlias } : {}) }, 'qq')
        createdAccount.registered = true
        createdAccount.accountKey = 'onebot:' + adapter.selfId
        createdAccount.selfId = adapter.selfId
        deps.bindings.bind({ accountKey: createdAccount.accountKey, storyId, transport: 'onebot-external' }, { replace: true })
        account = { selfId: adapter.selfId, endpoint: url.toString(), ...(tokenAlias ? { tokenAlias } : {}) }
        report.push({ module: '账号', status: 'ok', detail: `已登记 ${adapter.selfId} → ${sanitizeEndpoint(adapter.endpoint)}${tokenAlias ? '（token 已入密钥库）' : ''}${transferredNote}（原剧本账号位现为 Idle）` })
      } else report.push({ module: '账号', status: 'warning', detail: '无可自动绑定的正向 WS adapter（botAccounts 节已写入）；请到连接页补填上游' })
    } else report.push({ module: '账号', status: 'skipped', detail: '未选择' })

    // ── 模型（providers 明文 Key → $secret 别名） ──
    if (options.modules.model) {
      const modelSource = hdsiSource.model
      if (modelSource !== undefined) {
        const modelTarget = structuredClone(modelSource)
        const providers = isRecord(modelTarget) && Array.isArray(modelTarget.providers) ? modelTarget.providers.filter(isRecord) : []
        providers.forEach((provider, index) => {
          const apiKey = text(provider.apiKey).trim()
          if (!apiKey || apiKey.startsWith('$secret:')) return
          const label = aliasSlug(text(provider.label) || text(provider.id), `provider-${index + 1}`)
          const { alias, created } = upsertSecret(deps, `migrated-${label}-key`, apiKey)
          provider.apiKey = `$secret:${alias}`
          if (created) createdSecrets.push(alias)
        })
        // 旧版配置修复：旧版"第一个可用连接即主模型"的回退已被 rc57 收紧
        // （isExclusivelyNonChat：仅侧端标记、无聊天标记的连接不再回退为主）。
        // 导入时若无任何 useForMain:true 且无模型预设（models/mainModelId）指向，
        // 给第一个未显式排除主叙事、具备模型名与端点（或官方预设）的连接补标。
        let repaired = ''
        const modelRecord = isRecord(modelTarget) ? modelTarget : {}
        const hasProfileTarget = text(modelRecord.mainModelId).trim().length > 0 || (Array.isArray(modelRecord.models) && modelRecord.models.length > 0)
        if (!providers.some(provider => provider.useForMain === true) && !hasProfileTarget) {
          const candidate = providers.find(provider => provider.useForMain !== false
            && text(provider.model).trim().length > 0
            && (text(provider.endpoint).trim().length > 0 || (!!text(provider.mode).trim() && text(provider.mode) !== 'openai-compatible')))
          if (candidate) {
            candidate.useForMain = true
            repaired = `；旧配置未标注主叙事——已将「${text(candidate.label) || text(candidate.id) || '首连接'}」标记为用于主叙事`
          }
        }
        target.model = modelTarget
        report.push({ module: '模型配置', status: 'ok', detail: `${providers.length} 个连接；密钥 ${createdSecrets.length ? '已转入密钥库' : '无需转换'}${repaired}` })
        if (!repaired && !providers.some(provider => provider.useForMain === true)) {
          report.push({ module: '模型配置', status: 'warning', detail: '没有可用于主叙事的连接（均被显式排除）——请到「配置 → 模型提供商」勾选"主叙事"' })
        }
      } else report.push({ module: '模型配置', status: 'skipped', detail: '源配置无 model 节' })
    } else report.push({ module: '模型配置', status: 'skipped', detail: '未选择' })

    // ── 状态机/运行行为 ──
    if (options.modules.behavior) {
      const copied = BEHAVIOR_KEYS.filter(key => hdsiSource[key] !== undefined)
      for (const key of copied) target[key] = structuredClone(hdsiSource[key])
      report.push(copied.length
        ? { module: '状态机与运行行为', status: 'ok', detail: `已导入 ${copied.length} 节：${copied.join('、')}` }
        : { module: '状态机与运行行为', status: 'skipped', detail: '源配置无行为节' })
    } else report.push({ module: '状态机与运行行为', status: 'skipped', detail: '未选择' })

    // ── 主提示词（独立可选块，默认不动） ──
    if (options.modules.mainPrompt) {
      if (typeof hdsiSource.mainPrompt === 'string' && hdsiSource.mainPrompt.trim()) {
        target.mainPrompt = hdsiSource.mainPrompt
        report.push({ module: '主提示词覆盖', status: 'ok', detail: `已导入（${hdsiSource.mainPrompt.trim().length} 字）` })
      } else report.push({ module: '主提示词覆盖', status: 'skipped', detail: '源配置无 mainPrompt' })
    } else report.push({ module: '主提示词覆盖', status: 'skipped', detail: '未选择（保持 typ0 默认）' })

    // ── 其他（blindMode/logging；presetSync/sharedStory 属 Console 管理，恒跳过） ──
    if (options.modules.misc) {
      const copied: string[] = []
      if (hdsiSource.blindMode !== undefined) { target.blindMode = structuredClone(hdsiSource.blindMode); copied.push('blindMode') }
      if (hdsiSource.logging !== undefined) { target.logging = structuredClone(hdsiSource.logging); copied.push('logging') }
      report.push(copied.length ? { module: '其他（blindMode/logging）', status: 'ok', detail: copied.join('、') } : { module: '其他（blindMode/logging）', status: 'skipped', detail: '源配置无对应节' })
    } else report.push({ module: '其他（blindMode/logging）', status: 'skipped', detail: '未选择' })
    for (const skipped of ['presetSync', 'sharedStory'] as const) {
      if (hdsiSource[skipped] !== undefined) report.push({ module: skipped, status: 'skipped', detail: '经 Koishi Console 管理，不随导入' })
    }

    // ── 剧本数据库（文件级整库替换：两边同为 rc57 插件 schema，逐字节保真）──
    if (options.modules.database) {
      const dbPath = source.ymlDir ? path.resolve(source.ymlDir, source.database?.path ?? '') : source.database?.path
      if (dbPath && source.database && existsSync(dbPath)) {
        const { bytes } = copyKoishiDb(dbPath, meta.dir)
        const counts = source.database.counts ?? {}
        const dbSelfIds = source.database.selfIds ?? []
        const sizeLabel = bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`
        let dbStatus: 'ok' | 'warning' = 'ok'
        const notes: string[] = []
        if (dbSelfIds.length > 1) notes.push(`库内有 ${dbSelfIds.length} 个剧本（typ0 单剧本承载主剧本，其余仅随库存档）`)
        if (account?.selfId && dbSelfIds.length === 1 && dbSelfIds[0] !== account.selfId) {
          dbStatus = 'warning'
          notes.push(`库属于账号 ${dbSelfIds[0]}，本次绑定的账号是 ${account.selfId}——剧情与该账号的对话历史将不连续`)
        } else if (!account?.selfId && dbSelfIds.length >= 1 && !options.modules.accounts) {
          notes.push(`库属于账号 ${dbSelfIds[0]}（本次未导入账号模块，请确认目标剧本绑定同一账号）`)
        }
        if (source.database.walActive) notes.push('源库有未合并的 WAL——建议先关闭插件版实例再导入以保证快照一致')
        report.push({
          module: '剧本数据库',
          status: dbStatus,
          detail: `已整库替换到新剧本（${sizeLabel}）· 剧本 ${counts.story ?? '?'} · 剧本条目 ${counts.script_entry ?? '?'} · 事实 ${counts.fact ?? '?'} · 意图 ${counts.intent ?? '?'} · 场景 ${counts.scene ?? '?'} · 参与者 ${counts.participant ?? '?'} · 用户/绑定 ${counts.user ?? '?'}/${counts.binding ?? '?'}${notes.length ? '；' + notes.join('；') : ''}`,
        })
      } else {
        report.push({ module: '剧本数据库', status: 'skipped', detail: source.database ? '源数据库文件不存在（探测时可见，执行时缺失？）' : '未在 koishi.yml 同目录探测到数据库文件' })
      }
    } else report.push({ module: '剧本数据库', status: 'skipped', detail: '未选择' })

    deps.config.save(meta.dir, yaml.dump(doc, { lineWidth: 160, noRefs: true }))
    deps.broadcastStoriesChanged()
    if (createdAccount.registered) deps.syncExternalConnector(storyId)
    return { storyId, storyName, report, secrets: createdSecrets, ...(account ? { account } : {}) }
  } catch (error) {
    // 回滚：刚创建的空剧本直接删除；本次新建的密钥别名撤销；登记/绑定还原。
    rollback(deps, meta.dir, createdSecrets, createdAccount, storyId)
    throw error instanceof Error ? error : new Error(String(error))
  }
}

function rollback(deps: ImporterDeps, storyDir: string, createdSecrets: string[], account: { registered: boolean, accountKey: string, selfId: string, transferredFrom?: { storyId: string, nickname: string, externalUpstream?: { endpoint: string, tokenAlias?: string }, channelKind?: string, wasRunning?: boolean } }, storyId: string) {
  try {
    if (account.registered) {
      try { deps.bindings.unbind(account.accountKey) } catch { /* 回滚尽力而为 */ }
      try { deps.accountRegistry.removeAccount(storyId, account.selfId) } catch { /* 回滚尽力而为 */ }
    }
    // 转移还原：登记 + 绑定都回原剧本（审计 H2：此前只还原登记不还原绑定，
    // 被转移账号的消息会全部落入 unassigned 静默丢失）；被卸载的运行中剧本
    // 按原运行态重载，外部上游连接器同步回收。
    if (account.transferredFrom) {
      try { deps.accountRegistry.register(account.transferredFrom.storyId, account.selfId, account.transferredFrom.nickname, account.transferredFrom.externalUpstream, account.transferredFrom.channelKind as any) } catch { /* 回滚尽力而为 */ }
      try { deps.bindings.bind({ accountKey: account.accountKey, storyId: account.transferredFrom.storyId, transport: 'onebot-external' }, { replace: true }) } catch { /* 回滚尽力而为 */ }
      try { deps.syncExternalConnector(account.transferredFrom.storyId) } catch { /* 回滚尽力而为 */ }
      if (account.transferredFrom.wasRunning && deps.loadStory) {
        try { deps.loadStory(account.transferredFrom.storyId) } catch { /* 回滚尽力而为 */ }
      }
    }
    for (const alias of createdSecrets) { try { deps.secrets.remove(alias) } catch { /* 回滚尽力而为 */ } }
    try { rmSync(storyDir, { recursive: true, force: true }) } catch { /* 回滚尽力而为 */ }
    deps.broadcastStoriesChanged()
  } catch { /* 回滚不得遮蔽原始错误 */ }
}

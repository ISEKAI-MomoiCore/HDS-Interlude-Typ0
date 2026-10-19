import { app, BrowserWindow, dialog, safeStorage, session, shell } from 'electron'
import { existsSync, mkdirSync, mkdtempSync, readFileSync , writeFileSync } from 'node:fs'
import os from 'node:os'
import { createHash , randomBytes } from 'node:crypto'
import path from 'node:path'
import { BindingRegistry } from './runtime/bindings'
import { ChannelAdapterRegistry, SandboxChannelAdapter } from './runtime/channel-adapter'
import { OneBotServerAdapter } from './runtime/onebot-bridge'
import { ExternalOneBotConnector, OnebotActionError } from './runtime/external-onebot-connector'
import { persistedDeliveryAction, workerReceipt } from './runtime/onebot-core'
import { AccountRegistry } from './runtime/account-registry'
import { StoryConfigCompiler } from './runtime/config-compiler'
import { PluginInstaller, ensurePluginRuntimeFiles } from './runtime/plugin-installer'
import { StoryConfigMediator } from './runtime/config-mediator'
import { DeliveryReceipt, DesktopDelivery, DesktopInboundEvent } from './runtime/contracts'
import { InboxRepository } from './runtime/inbox-replay'
import { InboundReceiptLedger } from './runtime/inbound-ledger'
import { MessageRouter } from './runtime/message-router'
import { SecretStore } from './runtime/secrets'
import { WorkerControl } from './runtime/worker-control'
import { projectRuntimeSnapshot, projectTokenRecord } from './runtime/worker-projections'
import type { BridgeSessionSnapshot } from './runtime/bridge-session'
import { UsageAggregator } from './runtime/usage-aggregator'
import { selectResumableStories, WorkerRegistry } from './runtime/worker-registry'
import { HostLock } from './runtime/host-lock'
import { captureConsoleConfig } from './runtime/console-config-capture'
import { DeliveryOutbox } from './runtime/outbox'
import { StoryArchiveService } from './runtime/story-archive'
import { DesktopLogLevel, DesktopLogSource, LogBroker } from './runtime/log-broker'
import { HostProjectionService } from './runtime/host-projection'
import { ConsoleEmbedService } from './runtime/console-embed'
import { RuntimeCoreDescriptor, StoryManager } from './stories'
import { ThemePackStore } from './runtime/theme-packs'
import { inspectModelReadiness, inspectSecretReferences } from './runtime/model-readiness'
import { detectSnowLuma } from './runtime/snowluma-detection'
import { FIRST_RUN_ERROR_CODES, FirstRunError, FirstRunReadiness, ReadinessItem, overallForReadiness, readinessItem } from './runtime/first-run-readiness'
import { ensureTraceId } from './runtime/trace'
import type { IpcContext } from './ipc/context'
import { bindTrustedSender } from './ipc/register'
import { registerAccountsIpc } from './ipc/accounts'
import { registerConnectionIpc } from './ipc/connection'
import { registerConsoleIpc } from './ipc/console'
import { registerLogsIpc } from './ipc/logs'
import { registerMixerIpc } from './ipc/mixer'
import { registerPluginsIpc } from './ipc/plugins'
import { registerImporterIpc } from './ipc/import'
import { registeredIpcChannels } from './ipc/register'
import { registerRuntimeIpc } from './ipc/runtime'
import { registerSecretsIpc } from './ipc/secrets'
import { registerStoriesIpc } from './ipc/stories'
import { registerThemePacksIpc } from './ipc/theme-packs'

const ONEBOT_BRIDGE_PORT = 6709
const appRoot = path.resolve(__dirname, '..', '..')
let dataRoot = appRoot
// P2 测试批次 B 档：自检冒烟模式（scripts/test-smoke.mjs 以 electron . --
// typ0-self-test 启动）。隔离 userData/数据根到临时目录——绝不触碰真实剧本/
// 日志/锁文件；HostLock 同样走临时目录，避免与正在运行的 dev 实例互斥。
const SELF_TEST = process.argv.includes('--typ0-self-test')
let selfTestRoot: string | undefined
if (SELF_TEST) {
  selfTestRoot = mkdtempSync(path.join(os.tmpdir(), 'typ0-self-test-'))
  app.setPath('userData', selfTestRoot)
  dataRoot = selfTestRoot
}
// Portable 发行目标（electron-builder portable）：数据随 exe 目录走，保持真正
// 便携——同时把 Chromium userData 一并重定向，避免向 %APPDATA% 写缓存/配置，
// 让 typ0-data/ 成为唯一自包含目录（整体拷贝即备份）。只读介质等失败场景回
// 落默认 userData，不阻断启动。
const PORTABLE_DATA_DIR = app.isPackaged && process.env.PORTABLE_EXECUTABLE_DIR
  ? path.join(process.env.PORTABLE_EXECUTABLE_DIR, 'typ0-data')
  : ''
if (!SELF_TEST && PORTABLE_DATA_DIR) {
  try {
    mkdirSync(PORTABLE_DATA_DIR, { recursive: true })
    app.setPath('userData', PORTABLE_DATA_DIR)
    dataRoot = PORTABLE_DATA_DIR
  } catch { /* 回落默认 userData */ }
}
let hostLock: HostLock | undefined
/** D3-4：在途投递计数，关闭时排空等待。 */
let inFlightDeliveries = 0
/** D4：Blind 模式下 Console 嵌入是原文绕过口——禁止新附件并销毁现存视图。 */
let blindMode = false
let themePacks: ThemePackStore
let storiesRoot = path.join(dataRoot, 'stories')
let stories: StoryManager
let bindings: BindingRegistry
let inbox: InboxRepository
let receipts: InboundReceiptLedger
let router: MessageRouter
let secrets: SecretStore
let usage: UsageAggregator
let outbox: DeliveryOutbox
let channels: ChannelAdapterRegistry
let onebot: OneBotServerAdapter
/** W2（B2-3）：连接器按账号一比一（accountKey = onebot:<selfId>）。多账号剧本
 * = 多个连接器，各自身份验证、各自重连；出站按投递的 accountKey 精确路由。 */
const externalConnectors = new Map<string, ExternalOneBotConnector>()
type ExternalConnectionState = 'not-configured' | 'connecting' | 'online' | 'offline' | 'configuration-error'
const externalConnectionStates = new Map<string, { state: ExternalConnectionState, updatedAt: string, error?: string }>()
/** 每账号连接状态（W2）；故事级 rollup 供兼容渲染（accounts:connection 旧字段）。 */
const externalAccountStates = new Map<string, { state: ExternalConnectionState, updatedAt: string, error?: string, code?: 'SELF_ID_MISMATCH' | 'ONEBOT_ENDPOINT_UNREACHABLE' | 'ONEBOT_AUTH_FAILED' }>()
let lastSnowLumaDetection: Awaited<ReturnType<typeof detectSnowLuma>> | null = null
let accountRegistry: AccountRegistry
let config: StoryConfigMediator
let archives: StoryArchiveService
let logs: LogBroker
let projections: HostProjectionService
let consoleEmbed: ConsoleEmbedService
const deliveryFlights = new Map<string, Promise<void>>()
/** Phase 2：第三方插件运行时（安装目录 + 受控安装器）。 */
let pluginRuntimeDir: string
let pluginInstaller: PluginInstaller
/** Canonical config hash used to distinguish saved config from the config the
 * running Worker actually loaded. This is deliberately in-memory: a process
 * restart has no running Worker to compare against. */
const workerConfigHashes = new Map<string, string>()

let window: BrowserWindow | null = null

function setExternalConnectionState(storyId: string, state: ExternalConnectionState, error?: unknown) {
  const value = { state, updatedAt: new Date().toISOString(), ...(error ? { error: String(error).slice(0, 500) } : {}) }
  externalConnectionStates.set(storyId, value)
  window?.webContents.send('accounts:connection', { storyId, external: value })
}

function setExternalAccountState(storyId: string, accountKey: string, state: ExternalConnectionState, error?: unknown, code?: 'SELF_ID_MISMATCH' | 'ONEBOT_ENDPOINT_UNREACHABLE' | 'ONEBOT_AUTH_FAILED') {
  const previous = state === 'online' || state === 'connecting' ? undefined : externalAccountStates.get(accountKey)
  externalAccountStates.set(accountKey, { state, updatedAt: new Date().toISOString(), ...(error != null ? { error: String(error).slice(0, 500) } : previous?.error ? { error: previous.error } : {}), ...(code ? { code } : state === 'online' ? {} : previous?.code ? { code: previous.code } : {}) })
  rollupExternalConnectionState(storyId)
}

/** 故事级状态 = 各账号最优态（online > connecting > configuration-error > offline），无上游配置为 not-configured。 */
function rollupExternalConnectionState(storyId: string) {
  const entries = accountRegistry.listByStory(storyId)
  const states = entries.map(entry => externalAccountStates.get('onebot:' + entry.selfId)?.state)
  const rollup: ExternalConnectionState = states.includes('online') ? 'online'
    : states.includes('connecting') ? 'connecting'
    : states.includes('configuration-error') ? 'configuration-error'
    : entries.some(entry => entry.externalUpstream?.endpoint) ? 'offline' : 'not-configured'
  setExternalConnectionState(storyId, rollup)
}

/** D0: report the exact resolved runtime artifact; story.json records origin,
 * but does not prove which package a child process will load today. */
function resolveHdsiRuntime(): RuntimeCoreDescriptor {
  try {
    const manifestPath = path.join(appRoot, 'node_modules', 'koishi-plugin-hds-interlude', 'package.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { version?: unknown, main?: unknown }
    const artifact = path.resolve(path.dirname(manifestPath), typeof manifest.main === 'string' ? manifest.main : 'lib/index.js')
    return { version: typeof manifest.version === 'string' ? manifest.version : 'unknown', artifact,
      ...(existsSync(artifact) ? { artifactHash: createHash('sha256').update(readFileSync(artifact)).digest('hex').slice(0, 16) } : {}) }
  } catch { return { version: 'unknown', artifact: 'unresolved' } }
}

/**
 * 在真正 fork Worker 前复用 ready check，避免 UI 显示的是“配置有问题”，
 * 但用户点击加载后只看到 config-compiler 的底层异常。
 *
 * 这里只做本地配置/密钥检查，不发起供应商 API 请求，也不改变 canonical YAML。
 */
function assertStoryModelReady(metaId: string) {
  const handle = stories.get(metaId)
  if (!handle || handle.running) return
  const configFile = path.join(handle.dir, 'koishi.yml')
  if (!existsSync(configFile)) return // stories.load() 会返回更准确的“缺少 koishi.yml”错误。

  let source: string
  try {
    source = readFileSync(configFile, 'utf8')
  } catch {
    return // 保留 stories.load() 的文件错误，避免这里掩盖原始原因。
  }

  const secretInspection = inspectSecretReferences(source, secrets)
  if (secretInspection.undecryptable.length) {
    throw new FirstRunError(FIRST_RUN_ERROR_CODES.MODEL_SECRET_UNDECRYPTABLE, [
      'Worker 暂时不能加载。',
      '',
      `原因：以下密钥的密文无法解密：${secretInspection.undecryptable.join('、')}。`,
      '',
      '下一步：打开模型配置，重新录入这些密钥。',
    ].join('\n'))
  }
  if (secretInspection.missing.length) {
    throw new FirstRunError(FIRST_RUN_ERROR_CODES.MODEL_SECRET_MISSING, [
      'Worker 暂时不能加载。',
      '',
      `原因：配置引用了尚未录入的密钥：${secretInspection.missing.join('、')}。`,
      '',
      '下一步：打开模型配置，录入对应的 API Key、Endpoint 或模型名。',
    ].join('\n'))
  }
  if (secretInspection.unavailable.length) {
    throw new FirstRunError(FIRST_RUN_ERROR_CODES.MODEL_SECRET_STORE_UNAVAILABLE, [
      'Worker 暂时不能加载。',
      '',
      `原因：系统安全存储不可用，无法读取密钥：${secretInspection.unavailable.join('、')}。`,
      '',
      '下一步：恢复系统密钥库后重试。',
    ].join('\n'))
  }

  const readiness = inspectModelReadiness(source, secretInspection)
  if (readiness.status === 'err') {
    const code = readiness.code ?? FIRST_RUN_ERROR_CODES.MODEL_NOT_CONFIGURED
    throw new FirstRunError(code, [
      'Worker 暂时不能加载。',
      '',
      `原因：${readiness.detail}`,
      '',
      '下一步：打开模型配置，补全用于主叙事的模型连接后重试。',
    ].join('\n'))
  }
}

function canonicalConfigHash(metaId: string) {
  const handle = stories.get(metaId)
  if (!handle) return ''
  try { return createHash('sha256').update(readFileSync(path.join(handle.dir, 'koishi.yml'))).digest('hex').slice(0, 16) }
  catch { return '' }
}

function rememberWorkerConfig(metaId: string) {
  const hash = canonicalConfigHash(metaId)
  if (hash) workerConfigHashes.set(metaId, hash)
}


function itemToLegacyCheck(id: string, label: string, item: ReadinessItem, actionMap: Record<string, string> = {}) {
  const status = item.status === 'ready' ? 'ok' : item.status === 'degraded' || item.status === 'checking' || item.status === 'not-started' ? 'warn' : 'err'
  const action = item.actions[0] ? (actionMap[item.actions[0]] ?? item.actions[0]) : undefined
  return { id, label, status, detail: item.detail || item.summary, ...(action ? { action } : {}), ...(item.code ? { code: item.code } : {}) } as const
}

function buildFirstRunReadiness(metaId: string): FirstRunReadiness | { error: string } {
  const handle = stories.get(metaId)
  if (!handle) return { error: '剧本不存在' }
  const checkedAt = new Date().toISOString()
  let configSource = ''
  let configReadError = ''
  try { configSource = config.read(handle.dir) } catch (error) { configReadError = String(error) }

  const secretInspection = configReadError
    ? { referenced: [], reasons: new Map<string, 'missing' | 'undecryptable' | 'unavailable' | 'ok'>(), missing: [], undecryptable: [], unavailable: [] }
    : inspectSecretReferences(configSource, secrets)
  const configHash = configSource ? createHash('sha256').update(configSource).digest('hex').slice(0, 16) : ''
  const loadedHash = workerConfigHashes.get(metaId)

  let worker: ReadinessItem
  if (!handle.running) {
    worker = readinessItem({ status: 'blocked', summary: 'Worker 未加载', detail: '加载 Worker 后才能处理消息。', actions: ['load'], checkedAt, code: FIRST_RUN_ERROR_CODES.WORKER_NOT_LOADED })
  } else if (!handle.bridgeReady) {
    worker = readinessItem({ status: 'checking', summary: 'Worker 正在启动', detail: 'Worker 进程已启动，正在等待 bridge 就绪。', actions: ['retry', 'open-logs'], checkedAt, code: FIRST_RUN_ERROR_CODES.BRIDGE_TIMEOUT })
  } else if (configHash && loadedHash && configHash !== loadedHash) {
    worker = readinessItem({ status: 'needs-reload', summary: 'Worker 需要重载', detail: '配置已保存，但当前 Worker 仍使用旧配置。', actions: ['reload'], checkedAt, code: FIRST_RUN_ERROR_CODES.CONFIG_NEEDS_RELOAD })
  } else {
    worker = readinessItem({ status: 'ready', summary: 'Worker 已运行', detail: 'Worker 与 typ-0 bridge 均已就绪。', actions: [], checkedAt })
  }

  let model: ReadinessItem
  if (configReadError) {
    model = readinessItem({ status: 'failed', summary: '模型配置无法读取', detail: `无法读取剧本配置：${configReadError}`, actions: ['configure', 'open-logs'], checkedAt, code: FIRST_RUN_ERROR_CODES.MODEL_CONFIG_INVALID })
  } else if (secretInspection.undecryptable.length) {
    model = readinessItem({ status: 'blocked', summary: '模型密钥无法解密', detail: `请重新录入：${secretInspection.undecryptable.join('、')}。`, actions: ['configure'], checkedAt, code: FIRST_RUN_ERROR_CODES.MODEL_SECRET_UNDECRYPTABLE })
  } else if (secretInspection.missing.length) {
    model = readinessItem({ status: 'blocked', summary: '模型密钥尚未录入', detail: `缺少密钥别名：${secretInspection.missing.join('、')}。`, actions: ['configure'], checkedAt, code: FIRST_RUN_ERROR_CODES.MODEL_SECRET_MISSING })
  } else if (secretInspection.unavailable.length) {
    model = readinessItem({ status: 'blocked', summary: '系统密钥库不可用', detail: `无法读取：${secretInspection.unavailable.join('、')}。`, actions: ['retry', 'configure'], checkedAt, code: FIRST_RUN_ERROR_CODES.MODEL_SECRET_STORE_UNAVAILABLE })
  } else {
    const inspected = inspectModelReadiness(configSource, secretInspection)
    const code = inspected.code
    model = readinessItem({
      status: inspected.status === 'ok' ? 'ready' : inspected.status === 'warn' ? 'degraded' : 'blocked',
      summary: inspected.status === 'ok' ? '模型配置已就绪' : inspected.status === 'warn' ? '模型配置可用但有提醒' : '模型配置未就绪',
      detail: inspected.detail,
      actions: inspected.status === 'ok' ? [] : ['configure'],
      checkedAt,
      ...(code ? { code } : {}),
    })
  }

  const snow = lastSnowLumaDetection
  const hasOnebot = !configReadError && configSource.includes('adapter-onebot') && !configSource.includes('~adapter-onebot')
  const channelLayers = [
    { id: 'onebot-adapter', label: 'OneBot 适配器', status: hasOnebot ? 'ready' as const : 'blocked' as const,
      summary: hasOnebot ? '已启用' : '未启用', detail: hasOnebot ? '剧本配置中启用了 adapter-onebot。' : '在剧本配置中启用 OneBot 适配器。', checkedAt,
      ...(!hasOnebot ? { code: FIRST_RUN_ERROR_CODES.ONEBOT_ADAPTER_NOT_CONFIGURED } : {}) },
    { id: 'snowluma-installation', label: 'SnowLuma 安装', status: snow?.status === 'unknown' ? 'degraded' as const : snow?.path ? 'ready' as const : 'not-started' as const,
      summary: snow?.path ? '已找到安装目录' : snow?.status === 'unknown' ? '无法确认' : '未检测到', detail: snow?.path ?? (snow?.status === 'unknown' ? '本机进程检测不可用；可手动接入 OneBot 端点。' : 'SnowLuma 仅 QQ 通道需要。'), checkedAt: snow?.checkedAt ?? checkedAt },
    { id: 'snowluma-process', label: 'SnowLuma 进程', status: snow?.process === 'running' ? 'ready' as const : snow?.process === 'unknown' ? 'degraded' as const : 'not-started' as const,
      summary: snow?.process === 'running' ? '进程运行中' : snow?.process === 'unknown' ? '状态未知' : '未运行', detail: '进程运行不代表 QQ 已登录或 OneBot 已可用。', checkedAt: snow?.checkedAt ?? checkedAt },
    { id: 'snowluma-webui', label: 'SnowLuma 管理界面', status: snow?.webui.reachable ? 'ready' as const : snow?.webui.status === 'unknown' ? 'degraded' as const : 'not-started' as const,
      summary: snow?.webui.reachable ? `可访问（:${snow.webui.port}）` : snow?.webui.status === 'unknown' ? '状态未知' : '不可访问', detail: '管理界面可访问不代表 OneBot 连接或 QQ 登录成功。', checkedAt: snow?.checkedAt ?? checkedAt },
  ]
  let channel: ReadinessItem
  if (configReadError) channel = readinessItem({ status: 'failed', summary: '渠道配置无法读取', detail: '无法读取剧本配置。', actions: ['configure'], checkedAt, code: FIRST_RUN_ERROR_CODES.MODEL_CONFIG_INVALID, layers: channelLayers })
  else channel = hasOnebot
    ? readinessItem({ status: 'ready', summary: 'OneBot 适配器已配置', detail: '剧本已启用 OneBot 渠道。SnowLuma 状态仅作为独立诊断信息。', actions: [], checkedAt, layers: channelLayers })
    : readinessItem({ status: 'blocked', summary: 'OneBot 渠道未配置', detail: '首次使用需要在剧本中启用 OneBot 适配器。', actions: ['configure'], checkedAt, code: FIRST_RUN_ERROR_CODES.ONEBOT_ADAPTER_NOT_CONFIGURED, layers: channelLayers })

  const accounts = accountRegistry.listByStory(metaId)
  let account: ReadinessItem
  const accountLayers = accounts.flatMap(entry => {
    const key = 'onebot:' + entry.selfId
    const state = externalAccountStates.get(key)
    const bound = bindings.find(key)?.storyId === metaId
    const endpointConfigured = Boolean(entry.externalUpstream?.endpoint)
    const endpointStatus = !endpointConfigured ? 'blocked' as const : state?.state === 'online' ? 'ready' as const : state?.state === 'connecting' ? 'checking' as const : 'degraded' as const
    const identityStatus = state?.code === 'SELF_ID_MISMATCH' || state?.code === 'ONEBOT_AUTH_FAILED' ? 'failed' as const : state?.state === 'online' ? 'ready' as const : state?.state === 'connecting' ? 'checking' as const : 'not-started' as const
    return [
      { id: `onebot-endpoint:${entry.selfId}`, label: `${entry.nickname || entry.selfId} · 上游端点`, status: endpointStatus, summary: !endpointConfigured ? '未配置' : state?.code === 'ONEBOT_AUTH_FAILED' ? '鉴权失败（401/403）' : state?.state === 'online' ? '可达' : state?.state === 'connecting' ? '连接中' : '不可达', detail: endpointConfigured ? `已配置 OneBot WebSocket 地址；当前状态：${state?.state ?? '等待连接'}。` : '请为该账号配置 ws:// 或 wss:// 上游地址。', checkedAt: state?.updatedAt ?? checkedAt, ...(!endpointConfigured ? { code: FIRST_RUN_ERROR_CODES.ONEBOT_ENDPOINT_UNREACHABLE } : state?.code ? { code: FIRST_RUN_ERROR_CODES[state.code] } : {}) },
      { id: `onebot-login:${entry.selfId}`, label: `${entry.nickname || entry.selfId} · 登录验证`, status: identityStatus, summary: state?.state === 'online' ? '已验证在线' : state?.code === 'ONEBOT_AUTH_FAILED' ? '访问令牌无效或缺失' : state?.code === 'SELF_ID_MISMATCH' ? '账号不匹配' : state?.state === 'connecting' ? '验证中' : '未验证', detail: state?.error ?? '只有收到 get_login_info 且账号身份匹配后，才会标记为已验证。', checkedAt: state?.updatedAt ?? checkedAt, ...(state?.code ? { code: FIRST_RUN_ERROR_CODES[state.code] } : {}) },
      { id: `story-account-binding:${entry.selfId}`, label: `${entry.nickname || entry.selfId} · 剧本绑定`, status: bound ? 'ready' as const : 'blocked' as const, summary: bound ? '已绑定' : '未绑定', detail: bound ? `账号 ${entry.selfId} 的消息路由到当前剧本。` : '该账号尚未绑定到当前剧本。', checkedAt, ...(!bound ? { code: FIRST_RUN_ERROR_CODES.ACCOUNT_NOT_BOUND } : {}) },
    ]
  })
  if (!accounts.length) accountLayers.push({ id: 'story-account-binding', label: '剧本账号绑定', status: 'blocked', summary: '未绑定账号', detail: '绑定一个账号后才能收发消息。', checkedAt, code: FIRST_RUN_ERROR_CODES.ACCOUNT_NOT_BOUND })
  const authFailed = accounts.some(entry => externalAccountStates.get('onebot:' + entry.selfId)?.code === 'ONEBOT_AUTH_FAILED')
  const selfMismatch = accounts.some(entry => externalAccountStates.get('onebot:' + entry.selfId)?.code === 'SELF_ID_MISMATCH')
  const anyOnline = accounts.some(entry => externalAccountStates.get('onebot:' + entry.selfId)?.state === 'online')
  const anyConnecting = accounts.some(entry => externalAccountStates.get('onebot:' + entry.selfId)?.state === 'connecting')
  const anyEndpoint = accounts.some(entry => entry.externalUpstream?.endpoint)
  if (!accounts.length) account = readinessItem({ status: 'blocked', summary: '尚未绑定账号', detail: '绑定一个 QQ、微信或其他 OneBot 账号后才能接收和发送消息。', actions: ['configure'], checkedAt, code: FIRST_RUN_ERROR_CODES.ACCOUNT_NOT_BOUND, layers: accountLayers })
  else if (anyOnline) account = readinessItem({ status: 'ready', summary: '账号已验证在线', detail: `${accounts.length} 个账号中至少一个已通过 OneBot 登录身份校验。`, actions: [], checkedAt, layers: accountLayers })
  else if (authFailed) account = readinessItem({ status: 'degraded', summary: 'OneBot 访问令牌校验失败', detail: '请在账号端点配置中填写 access token 或使用本机 SnowLuma 令牌，保存后重新连接。WebUI 密码不是访问令牌。', actions: ['configure'], checkedAt, code: FIRST_RUN_ERROR_CODES.ONEBOT_AUTH_FAILED, layers: accountLayers })
  else if (selfMismatch) account = readinessItem({ status: 'degraded', summary: 'OneBot 登录账号不匹配', detail: '上游返回的 Self ID 与当前绑定账号不同，请核对账号和端点。', actions: ['configure', 'retry'], checkedAt, code: FIRST_RUN_ERROR_CODES.SELF_ID_MISMATCH, layers: accountLayers })
  else if (anyConnecting) account = readinessItem({ status: 'checking', summary: '账号连接中', detail: '账号已绑定，正在连接并验证上游身份。', actions: ['retry'], checkedAt, layers: accountLayers })
  else if (anyEndpoint) account = readinessItem({ status: 'degraded', summary: '账号已绑定但端点不可达', detail: '请检查 OneBot 服务是否运行、地址及访问令牌。', actions: ['configure', 'retry'], checkedAt, code: FIRST_RUN_ERROR_CODES.ONEBOT_ENDPOINT_UNREACHABLE, layers: accountLayers })
  else account = readinessItem({ status: 'blocked', summary: '账号尚未连接上游', detail: '账号已登记，但没有配置 OneBot WebSocket 端点。', actions: ['configure'], checkedAt, code: FIRST_RUN_ERROR_CODES.ONEBOT_ENDPOINT_UNREACHABLE, layers: accountLayers })

  const hasWhitelist = /userAccounts:/.test(configSource) && !/userAccounts:\s*\[\s*\]/.test(configSource)
  const permissions = hasWhitelist
    ? readinessItem({ status: 'ready', summary: '交往对象已配置', detail: '白名单中已有允许的交往对象。', actions: [], checkedAt })
    : readinessItem({ status: 'degraded', summary: '交往对象尚未限制', detail: '白名单为空，当前会接受所有匹配到的私聊对象。', actions: ['configure'], checkedAt })

  // 相位检查：paused/muted 不是装配缺陷，而是用户可一键切换的运行选择——
  // 因此不进 criticalItems（不把整体判成 ERROR），只以 warn 提示 + 一键切回运行。
  const storyPhase = handle.meta.phase
  const phase: ReadinessItem = !handle.running
    ? readinessItem({ status: 'not-started', summary: '未加载', detail: '加载 Worker 后按相位处理消息。', actions: [], checkedAt })
    : storyPhase === 'running'
      ? readinessItem({ status: 'ready', summary: '运行中', detail: '入站消息会正常触发叙事与投递。', actions: [], checkedAt })
      : readinessItem({
        status: 'degraded',
        summary: storyPhase === 'muted' ? '静音中' : '暂停中',
        detail: storyPhase === 'muted'
          ? '观察模式：消息会触发叙事但不发送回复。'
          : '入站消息只进入收件箱排队，不会触发回复；切回运行后可在收件箱回放。',
        actions: ['run'],
        checkedAt,
        ...(storyPhase === 'muted' ? {} : { code: FIRST_RUN_ERROR_CODES.STORY_PAUSED }),
      })

  const items = [worker, model, channel, account, permissions]
  const checks = [
    itemToLegacyCheck('worker', 'Worker 已加载', worker, { retry: 'load', reload: 'reload' }),
    itemToLegacyCheck('phase', '运行相位', phase, { run: 'run' }),
    ...(model.code === FIRST_RUN_ERROR_CODES.MODEL_SECRET_MISSING || model.code === FIRST_RUN_ERROR_CODES.MODEL_SECRET_UNDECRYPTABLE || model.code === FIRST_RUN_ERROR_CODES.MODEL_SECRET_STORE_UNAVAILABLE
      ? [itemToLegacyCheck('secrets', '模型密钥', model, { configure: 'models', retry: 'models' })] : []),
    itemToLegacyCheck('channel', 'QQ 渠道已配置', channel, { configure: 'config' }),
    itemToLegacyCheck('model', '模型配置', model, { configure: 'models', retry: 'models' }),
    itemToLegacyCheck('account', '账号已绑定', account, { configure: 'config', retry: 'config' }),
    itemToLegacyCheck('whitelist', '交往对象已添加', permissions, { configure: 'config' }),
  ]
  const criticalItems = [worker, model, channel, account]
  return {
    schemaVersion: 1,
    storyId: metaId,
    overall: overallForReadiness(items),
    worker, model, channel, account, permissions,
    checkedAt,
    checks,
    allOk: checks.every(item => item.status === 'ok'),
    criticalOk: criticalItems.every(item => item.status === 'ready'),
  }
}

function broadcast(event: string, payload: unknown) {
  // Keep `story:log` for older renderer code, while making the host-owned record
  // stream the canonical source for new surfaces and historical queries.
  if (event === 'story:log' && payload && typeof payload === 'object') {
    const item = payload as { storyId?: unknown, line?: unknown, correlation?: unknown }
    const line = String(item.line ?? '')
    const record = logs.record({
      storyId: typeof item.storyId === 'string' ? item.storyId : undefined,
      message: line,
      level: inferLogLevel(line),
      source: inferLogSource(line),
      logger: 'typ-0',
      correlation: item.correlation && typeof item.correlation === 'object' ? item.correlation as any : undefined,
    })
    // 三方审查P1: Blind 模式下实时推送也过同一脱敏规则——此前 query/export 有规则、
    // 实时事件直推，沉浸模式被后续日志击穿。
    window?.webContents.send('logs:record', blindMode ? { ...record, message: `[blinded:${record.level}]` } : record)
    // 审计收束：story:log 第二实时通道（preload.onStoryLog）零订阅者，已随
    // 死代码清理移除——logs:record 是唯一实时日志通道（Blind 掩码在此生效）。
    if (event !== 'story:log') window?.webContents.send(event, payload)
  } else if (event !== 'story:log') {
    window?.webContents.send(event, payload)
  }
}

function inferLogLevel(line: string): DesktopLogLevel {
  if (/\b(error|fatal|stderr)\b|失败|异常|无法|拒绝/u.test(line)) return 'error'
  if (/\bwarn(?:ing)?\b|警告|过期|重试/u.test(line)) return 'warn'
  if (/\bdebug\b/u.test(line)) return 'debug'
  return 'info'
}

function inferLogSource(line: string): DesktopLogSource {
  const prefix = line.match(/^\[([^\]]+)\]/u)?.[1]?.toLowerCase()
  if (prefix === 'bridge') return 'bridge'
  if (prefix === 'router') return 'router'
  if (prefix === 'delivery') return 'delivery'
  if (prefix === 'channel') return 'channel'
  if (prefix === 'koishi') return 'koishi'
  if (prefix === 'shell' || prefix === 'config' || prefix === 'backup' || prefix === 'usage') return 'desktop'
  return 'worker'
}

/** One canonical inbound boundary for the built-in bridge and external OneBot connectors. */
async function handleInboundEvent(event: DesktopInboundEvent) {
  const traced: DesktopInboundEvent = { ...event, traceId: ensureTraceId(event.traceId) }
  const correlation = { traceId: traced.traceId! }
  broadcast('story:log', { line: '[trace] 入站消息已接收', correlation })
  try {
    const result = await router.route(traced)
    // 审计：unassigned 双通道广播（这里 + router.on('unassigned')）会让渲染层
    // 每条未指派消息弹两次 toast——只保留事件监听一条路径。
    broadcast('story:log', {
      storyId: result.storyId,
      line: `[trace] 路由结果：${result.disposition}${result.reason ? `（${result.reason}）` : ''}`,
      correlation: { traceId: result.traceId || traced.traceId },
    })
    return result
  } catch (error) {
    broadcast('story:log', {
      line: '[trace] 入站路由失败：' + error,
      correlation,
    })
    throw error
  }
}

function formatProcessError(error: unknown): string {
  if (error instanceof Error) return error.stack || `${error.name}: ${error.message}`
  try { return JSON.stringify(error) } catch { return String(error) }
}

/** P0-2：主进程异常必须落盘——打包版没有 stderr 可看，LogBroker 是唯一现场。
 * 处理器内部再失败只能吞掉：诊断代码绝不能成为新的崩溃源。 */
function installProcessDiagnostics() {
  process.on('uncaughtException', error => {
    try {
      logs?.record({ level: 'error', source: 'desktop', logger: 'process', message: `uncaughtException: ${formatProcessError(error)}` })
      void logs?.drain()
    } catch { /* best effort */ }
    console.error('[typ-0] uncaughtException:', error)
  })
  process.on('unhandledRejection', reason => {
    try {
      logs?.record({ level: 'error', source: 'desktop', logger: 'process', message: `unhandledRejection: ${formatProcessError(reason)}` })
      void logs?.drain()
    } catch { /* best effort */ }
    console.error('[typ-0] unhandledRejection:', reason)
  })
  app.on('child-process-gone', (_event, details) => {
    try {
      logs?.record({ level: 'warn', source: 'desktop', logger: 'process', message: `child-process-gone type=${details.type} reason=${details.reason} exitCode=${details.exitCode ?? 'n/a'} name=${details.name ?? 'n/a'}` })
    } catch { /* best effort */ }
  })
}

/** P0-5：retention 接线——启动时与每日各执行一次；清理量与失败都留诊断日志。 */
function runLogRetention() {
  void logs.applyRetention()
    .then(result => {
      if (result.removed > 0) {
        logs.record({ level: 'info', source: 'desktop', logger: 'logs', message: `日志保留策略已执行：清理 ${result.removed} 个文件。` })
      }
    })
    .catch(error => {
      logs.record({ level: 'warn', source: 'desktop', logger: 'logs', message: `日志保留策略执行失败：${formatProcessError(error)}` })
    })
}

function createWindow() {
  window = new BrowserWindow({
    width: 1440,
    height: 860,
    backgroundColor: '#0f1216',
    title: 'HDS-Interlude Typ0',
    // ☕ 应用图标（Twemoji 2615，CC-BY 4.0）：开发态指 build/；打包态用 exe 内嵌图标
    ...(existsSync(path.join(appRoot, 'build', 'icon.ico')) ? { icon: path.join(appRoot, 'build', 'icon.ico') } : {}),
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  window.setMenuBarVisibility(false)
  window.loadFile(path.join(__dirname, '../renderer/index.html'))
  window.on('closed', () => { window = null })
  // window.open（SnowLuma 管理页/下载页等）默认会开一个不受控的 Electron
  // 窗口：http(s) 交给系统浏览器，其余一律拒绝。
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) {
      void shell.openExternal(url)
      return { action: 'deny' }
    }
    return { action: 'deny' }
  })
  // P0-2：渲染进程崩溃的诊断与受控恢复。60 秒内第 3 次崩溃起停止自动重载
  // （避免崩溃循环），只留 error 日志等用户手动重启。
  const rendererCrashTimes: number[] = []
  // 捕获本窗口的 webContents：重载出事的渲染进程，而不是全局 window——
  // 崩溃的可能是已关闭的旧窗口，reload 全局会误杀新建窗口（审计 L5）。
  const crashedContents = window.webContents
  crashedContents.on('render-process-gone', (_event, details) => {
    const at = Date.now()
    while (rendererCrashTimes.length && at - rendererCrashTimes[0] > 60_000) rendererCrashTimes.shift()
    rendererCrashTimes.push(at)
    logs?.record({
      level: rendererCrashTimes.length >= 3 ? 'error' : 'warn',
      source: 'desktop',
      logger: 'window',
      message: `渲染进程退出 reason=${details.reason} exitCode=${details.exitCode ?? 'n/a'}（60s 内第 ${rendererCrashTimes.length} 次）`,
    })
    void logs?.drain()
    if (details.reason === 'clean-exit' || rendererCrashTimes.length >= 3) return
    // 重载出事的 webContents，而不是全局 window——崩溃的可能是已关闭的旧窗口，
    // reload 全局会误杀新建窗口（审计 L5）。
    try { if (!crashedContents.isDestroyed()) crashedContents.reload() } catch { /* best effort */ }
  })
}

function initializeRuntime() {
  // 开发期沿用 desktop/stories；打包后迁移到 userData，绝不写入安装目录或 asar。
  // 自检冒烟模式：保持模块顶已指向的临时目录（隔离优先于开发期路径规则）。
  if (!selfTestRoot) dataRoot = PORTABLE_DATA_DIR || (app.isPackaged ? app.getPath('userData') : appRoot)
  storiesRoot = path.join(dataRoot, 'stories')
  themePacks = new ThemePackStore(dataRoot, () => window)
  // 本地开发/测试环境不依赖 Electron safeStorage：开发数据可能来自另一台机器，
  // 此时 Chromium 密钥环已经变化，旧密文会让 stories:load 在编译配置阶段直接失败。
  // 打包版本仍然强制使用 safeStorage；HDSI_TEST_MODE 只在未打包时生效（P2-6：
  // 发行版不允许环境变量重新打开明文密钥）。
  const plaintextSecretMode = !app.isPackaged && process.env.HDSI_TEST_MODE === '1'
  const protector = plaintextSecretMode
    ? {
        available: () => true,
        encrypt: (value: string) => value,
        decrypt: (value: string) => {
          // 兼容旧的 safeStorage 文件：能用当前系统密钥解开就解开；密钥失配时
          // 原样返回，保证测试环境可以继续启动和检查界面，不再被安全存储阻塞。
          try {
            const payload = Buffer.from(value, 'base64')
            const header = payload.subarray(0, 3).toString('ascii')
            if (/^v\d+$/.test(header) && safeStorage.isEncryptionAvailable()) {
              return safeStorage.decryptString(payload)
            }
          } catch { /* 测试模式下允许旧密文降级为原始值 */ }
          return value
        },
      }
    : {
        available: () => safeStorage.isEncryptionAvailable(),
        encrypt: (value: string) => safeStorage.encryptString(value).toString('base64'),
        decrypt: (value: string) => safeStorage.decryptString(Buffer.from(value, 'base64')),
      }
  secrets = new SecretStore(dataRoot, protector)
  // LogBroker 必须先于任何 logs.record 构造（审计 H1：此前的启动留痕在构造
  // 前调用，typ0 启动即 TypeError 且无窗口无 IPC）。
  logs = new LogBroker(dataRoot)
  // P2-6：启动即留痕——明文测试模式与 safeStorage 状态（不含任何密钥内容）。
  logs.record({
    level: 'info', source: 'desktop', logger: 'secrets',
    message: `密钥存储初始化：明文测试模式=${plaintextSecretMode ? '开' : '关'}，safeStorage 可用=${plaintextSecretMode ? '未启用（测试模式）' : String(safeStorage.isEncryptionAvailable())}`,
  })
  config = new StoryConfigMediator(secrets)
  archives = new StoryArchiveService(path.join(dataRoot, 'backups'))
  usage = new UsageAggregator(dataRoot)
  outbox = new DeliveryOutbox(storiesRoot)
  channels = new ChannelAdapterRegistry()
  accountRegistry = new AccountRegistry(dataRoot)
  // 三方审查P1: 本机回环服务端此前零鉴权（token 默认空串，this.token 跳过全部校验）——
  // 知道 storyId 即可伪造入站。生成一次随机 token 持久在数据根，worker 端经 env 共享。
  const onebotToken = (() => {
    try {
      const file = path.join(dataRoot, 'onebot-token')
      if (existsSync(file)) {
        const existing = readFileSync(file, 'utf8').trim()
        if (existing) return existing
        // 空文件继续走生成路径（旧行为）；生成失败才降级。
      }
      const token = randomBytes(24).toString('hex')
      writeFileSync(file, token, { encoding: 'utf8', mode: 0o600 })
      return token
    } catch (error) {
      // 审计：静默降级为空 token = 回环服务端回到零鉴权（知道 storyId 即可伪造
      // 入站）。必须留 error 级痕迹；继续运行属于显式取舍（拒绝启动会砸掉全部
      // 剧本的可用性），由用户依据日志处理数据目录权限。
      logs?.record?.({ level: 'error', source: 'desktop', logger: 'typ-0', message: `桥接鉴权 token 读/写失败，回环服务端将以零鉴权运行（本地任意进程可伪造入站）：${error}` })
      return ''
    }
  })()
  onebot = new OneBotServerAdapter(accountRegistry, onebotToken)
  process.env.HDSI_ONEBOT_TOKEN = onebotToken
  channels.register(new SandboxChannelAdapter())
  // The loopback server speaks to the worker's adapter-onebot. It must never
  // be selected as the real network sender. A configured external connector
  // is selected per story/account instead of clobbering a transport-wide map.
  channels.setResolver('onebot-external', delivery => externalConnectors.get(delivery.accountKey))
  // Phase 2：第三方插件运行时目录（<dataRoot>/plugins-runtime，打包版落在
  // userData 下可写）。自举 manifest + 宿主解析 hook（koishi/cordis 同实例）。
  pluginRuntimeDir = path.join(dataRoot, 'plugins-runtime')
  ensurePluginRuntimeFiles(pluginRuntimeDir, path.join(appRoot, 'node_modules'))
  pluginInstaller = new PluginInstaller(pluginRuntimeDir, line => {
    const record = logs.record({ level: 'info', source: 'desktop', logger: 'plugins', message: line })
    window?.webContents.send('logs:record', record)
  })
  stories = new StoryManager(storiesRoot, appRoot, new StoryConfigCompiler(secrets), 3, storyId => {
    // M7-2：账号登记+绑定事务后，worker 编译配置获得登记的 selfId 与内部端点。
    const entry = accountRegistry.findByStory(storyId)
    return entry
      ? { onebot: { selfId: entry.selfId, endpoint: `ws://127.0.0.1:${ONEBOT_BRIDGE_PORT}/onebot/${storyId}` } }
      : {}
  }, resolveHdsiRuntime(), undefined, (storyId, resolvedFile) => {
    // D4-2：Console 保存配置后捕获回 canonical（密钥反向脱敏为 $secret 别名）。
    try {
      const handle = stories.get(storyId)
      if (!handle) return
      const secretsIndex = secrets.aliases().map(alias => { const got = secrets.tryGet(alias); return { alias, value: got.ok ? got.value : '' } })
      const result = captureConsoleConfig(readFileSync(resolvedFile, 'utf8'), readFileSync(path.join(handle.dir, 'koishi.yml'), 'utf8'), secretsIndex)
      if (result.error) {
        broadcast('story:log', { storyId, line: `[console-config] 捕获失败（canonical 未改动）：${result.error}` })
        return
      }
      if (!result.changed) return
      config.save(handle.dir, result.canonical!)
      broadcast('story:log', { storyId, line: `[console-config] Console 配置已捕获回剧本配置（实例 ${result.instances}，脱敏 ${result.redactions} 处密钥为别名）。` })
    } catch (error) {
      broadcast('story:log', { storyId, line: `[console-config] 捕获异常（canonical 未改动）：${error}` })
    }
  }, pluginRuntimeDir)
  bindings = new BindingRegistry(dataRoot)
  inbox = new InboxRepository(storiesRoot)
  receipts = new InboundReceiptLedger(storiesRoot)
  router = new MessageRouter(dataRoot, bindings, stories, inbox, new WorkerControl(stories), receipts)
  onebot.setInboundListener(async event => {
    try { await handleInboundEvent(event) }
    catch (error) { broadcast('story:log', { line: '[onebot] 入站路由异常：' + error, correlation: { traceId: event.traceId } }) }
  })
  onebot.setOnlineListener((storyId, selfId) => {
    broadcast('story:log', { storyId, line: '[onebot] 账号 ' + selfId + ' 已上线' })
  })
  onebot.setOfflineListener(storyId => {
    broadcast('story:log', { storyId, line: '[onebot] 账号已离线' })
  })
  onebot.setLogger((line, storyId) => broadcast('story:log', { storyId, line: '[onebot] ' + line }))
  projections = new HostProjectionService(stories, inbox, outbox, usage, logs)
  consoleEmbed = new ConsoleEmbedService()
  consoleEmbed.setNavigationGuard((storyId, url) => stories.consoles.isAllowedNavigation(storyId, url))

  stories.on('log', ({ storyId, line }) => broadcast('story:log', { storyId, line }))
  stories.on('stories-changed', () => broadcast('stories:changed', stories.list()))
  stories.on('phase-changed', ({ storyId, phase }) => broadcast('story:phase', { storyId, phase }))
  // P0-4：worker 退出必须留痕并广播——此前崩溃零日志、零 UI 反馈，列表徽章
  // 还停留在旧 phase 上"说谎"。
  stories.on('story-exit', ({ storyId, exitKind, exitCode, signal }) => {
    const line = `[registry] worker 退出：${storyId} kind=${exitKind} code=${exitCode ?? 'n/a'}${signal ? ` signal=${signal}` : ''}`
    broadcast('story:log', { storyId, line })
    logs.record({
      storyId,
      level: exitKind === 'crash' || exitKind === 'error' ? 'error' : 'info',
      source: 'desktop',
      logger: 'registry',
      message: `worker 退出 kind=${exitKind} exitCode=${exitCode ?? 'n/a'} signal=${signal ?? 'none'}`,
    })
    broadcast('story:exit', { storyId, exitKind, exitCode, signal })
  })
  stories.on('bridge-ready', ({ storyId, protocol, capabilities }) => {
    broadcast('stories:changed', stories.list())
    broadcast('story:log', { storyId, line: `[bridge] Worker bridge ready: protocol ${protocol}${capabilities.length ? ` (${capabilities.join(', ')})` : ''}` })
  })
  // P1：桥会话状态流——协商/降级/失联/闭合成为可订阅事件（渲染层状态栏 chip）
  // 与可查询状态（stories:bridgeStatus）。关键转换各落一行日志：协商失败含
  // 修复指引；降级列出受限功能与既有降级路径；失联提醒 45s 判定来源。
  stories.on('bridge-session', (snapshot: BridgeSessionSnapshot) => {
    broadcast('story:bridge', snapshot)
    if (snapshot.state === 'failed') {
      broadcast('story:log', { storyId: snapshot.storyId, line: `[bridge] 会话协商失败：${snapshot.failure?.detail ?? '原因未知'}` })
    } else if (snapshot.state === 'degraded' && snapshot.negotiatedAt) {
      const missing = snapshot.unavailableFeatures.map(item => `${item.label}（${item.reason}${item.fallback ? `，${item.fallback}` : ''}）`).join('、')
      broadcast('story:log', { storyId: snapshot.storyId, line: `[bridge] 会话降级（protocol ${snapshot.protocol ?? '?'}）：${missing || '协议超出宿主已认证范围'}` })
    } else if (snapshot.state === 'stale') {
      broadcast('story:log', { storyId: snapshot.storyId, line: `[bridge] 会话失联警告：心跳超 45s（最后活跃 ${snapshot.lastSeenAt ?? '未知'}）——请求将按超时处理，恢复后自动继续。` })
    }
  })
  // M6：Console endpoint 生命周期 → 广播给 Renderer（嵌入容器据此挂载/销毁）。
  stories.on('console-ready', ({ storyId, descriptor }) => broadcast('console:ready', { storyId, descriptor }))
  stories.on('console-revoked', ({ storyId }) => {
    consoleEmbed.dispose(storyId, partition => { try { session.fromPartition(partition).clearStorageData() } catch { /* session may already be gone */ } })
    broadcast('console:revoked', { storyId })
  })
  router.on('queued', ({ storyId, size, record }) => {
    broadcast('story:inbox', { storyId, size, reason: record.reason, traceId: record.traceId })
    broadcast('story:log', {
      storyId,
      line: `[router] 入站消息已进入收件箱：${record.reason}`,
      correlation: { traceId: record.traceId },
    })
  })
  router.on('unassigned', event => broadcast('router:unassigned', event))
  stories.on('worker-message', ({ storyId, message }) => {
    if (message?.event === 'delivery') {
      void dispatchDelivery(storyId, message.payload)
        .catch(error => broadcast('story:log', { storyId, line: `[delivery] 主进程投递流水线异常：${error}`, correlation: { traceId: typeof message.payload?.traceId === 'string' ? message.payload.traceId : undefined } }))
    }
    if (message?.event === 'onebot-action-request') {
      void dispatchOnebotAction(storyId, message.payload)
        .catch(error => broadcast('story:log', { storyId, line: `[onebot-action] 代理调度异常：${error}` }))
    }
    if (message?.event === 'token') {
      // P1 收口：worker 原始对象不再直传——同一投影 DTO 喂聚合器与渲染层。
      const token = projectTokenRecord(storyId, message.payload)
      try { usage.record(storyId, token) }
      catch (error) { broadcast('story:log', { storyId, line: `[usage] 记录失败：${error}` }) }
      broadcast('story:token', token)
    }
    if (message?.event === 'runtime-snapshot') broadcast('story:runtime', projectRuntimeSnapshot(storyId, message.payload))
    if (message?.event === 'error') broadcast('story:log', { storyId, line: `[bridge] ${message.payload?.message || '未知 worker 错误'}` })
  })
}

// ── W3（C3-1）：动作代理白名单——宿主只透传显式允许的 OneBot 动作 ──────────
const ONEBOT_ACTION_ALLOWLIST = new Set([
  'send_private_msg', 'send_group_msg',
  'get_login_info', 'get_friend_list', 'get_group_list', 'get_group_info', 'get_group_member_list', 'get_group_member_info',
  'get_msg', 'get_forward_msg', 'get_image',
  'get_qzone_msg_list', 'get_qzone_feeds',
  'send_qzone_msg', 'delete_qzone_msg', 'comment_qzone', 'like_qzone', 'unlike_qzone',
  'set_msg_emoji_like', 'send_group_forward_msg', 'send_private_forward_msg',
  'get_stranger_info', 'get_version_info', 'get_status', 'can_send_image',
])
const ONEBOT_ACTION_PARAMS_LIMIT = 64 * 1024

async function dispatchOnebotAction(storyId: string, payload: any) {
  const requestId = String(payload?.requestId ?? '')
  const accountKey = String(payload?.accountKey ?? '')
  const action = String(payload?.action ?? '')
  const params = payload?.params && typeof payload.params === 'object' && !Array.isArray(payload.params) ? payload.params : {}
  const timeoutMs = Math.max(1_000, Math.min(Number(payload?.timeoutMs) || 30_000, 60_000))

  const reply = (body: { ok: boolean, data?: unknown, errorCode?: string, ambiguous?: boolean, error?: string }) => {
    try { stories.sendToWorker(storyId, { type: 'hdsi-desktop', event: 'onebot-action-result', payload: { requestId, ...body } }) }
    catch (error) { broadcast('story:log', { storyId, line: `[onebot-action] 回执发送失败：${error}` }) }
  }

  if (!requestId || !accountKey || !action) { reply({ ok: false, errorCode: 'invalid-request', error: '缺少 requestId/accountKey/action。' }); return }
  if (!ONEBOT_ACTION_ALLOWLIST.has(action)) {
    broadcast('story:log', { storyId, line: `[onebot-action] 白名单拒绝：${action}` })
    reply({ ok: false, errorCode: 'action-not-allowed', error: `动作 ${action} 不在白名单内。` })
    return
  }
  try {
    if (JSON.stringify(params).length > ONEBOT_ACTION_PARAMS_LIMIT) {
      reply({ ok: false, errorCode: 'params-too-large', error: '动作参数超过体积上限。' })
      return
    }
  } catch { reply({ ok: false, errorCode: 'params-invalid', error: '动作参数无法序列化。' }); return }

  const connector = externalConnectors.get(accountKey)
  if (!connector) {
    reply({ ok: false, errorCode: 'no-upstream', error: `账号 ${accountKey} 没有可用的上游连接器。` })
    return
  }
  try {
    const data = await connector.call(action, params, timeoutMs)
    reply({ ok: true, data })
  } catch (error) {
    const message = String((error as Error)?.message || error)
    // P1-5：优先用 connector 的结构化失败分类（OnebotActionError.kind）；
    // 正则仅兜底未分类错误。离线（not-verified）与上游失败不再共用一个码。
    if (error instanceof OnebotActionError) {
      if (error.kind === 'not-verified') { reply({ ok: false, errorCode: 'account-offline', error: message }); return }
      if (error.kind === 'receipt-timeout' || error.kind === 'disconnected') { reply({ ok: false, ambiguous: true, errorCode: 'transport-ambiguous', error: message }); return }
      if (error.kind === 'send-failed') { reply({ ok: false, errorCode: 'send-failed', error: message }); return }
      reply({ ok: false, errorCode: 'upstream-failed', error: message })
      return
    }
    const ambiguous = /超时|timeout|断开|closed/i.test(message)
    reply({ ok: false, ambiguous, errorCode: ambiguous ? 'transport-ambiguous' : 'upstream-failed', error: message })
  }
}

function isDesktopDelivery(value: any): value is DesktopDelivery {
  return !!value && typeof value === 'object'
    && typeof value.deliveryId === 'string' && typeof value.accountKey === 'string'
    && typeof value.transport === 'string' && typeof value.platform === 'string'
    && typeof value.selfId === 'string' && typeof value.channelId === 'string'
    && (value.kind === 'private' || value.kind === 'group')
    && typeof value.content === 'string' && typeof value.occurredAt === 'string'
    && (value.traceId === undefined || typeof value.traceId === 'string')
    && (value.processingId === undefined || typeof value.processingId === 'string')
    && (value.intentKey === undefined || typeof value.intentKey === 'string')
}

function deliveryIdOf(value: unknown) {
  return value && typeof value === 'object' && typeof (value as any).deliveryId === 'string'
    ? (value as any).deliveryId as string : undefined
}


/** The bridge only resolves HDSI's session.send after this durable host-side pipeline settles. */
async function dispatchDelivery(storyId: string, payload: unknown) {
  inFlightDeliveries += 1
  try {
  const deliveryId = deliveryIdOf(payload)
  if (!deliveryId) return dispatchDeliveryOnce(storyId, payload)
  const key = `${storyId}:${deliveryId}`
  const pending = deliveryFlights.get(key)
  if (pending) return pending
  const task = dispatchDeliveryOnce(storyId, payload)
  deliveryFlights.set(key, task)
  try { await task } finally { deliveryFlights.delete(key) }
  } finally { inFlightDeliveries -= 1 }
}

async function dispatchDeliveryOnce(storyId: string, payload: unknown) {
  if (!isDesktopDelivery(payload)) {
    const invalidTraceId = payload && typeof payload === 'object' && typeof (payload as any).traceId === 'string'
      ? String((payload as any).traceId) : undefined
    broadcast('story:log', { storyId, line: '[delivery] Worker 发出了无效投递请求。', correlation: { traceId: invalidTraceId } })
    // Do not leave the worker's session.send() hanging for its full timeout
    // when a malformed bridge payload still contains a correlation ID.
    const deliveryId = deliveryIdOf(payload)
    if (deliveryId) {
      await stories.settleDelivery(storyId, deliveryId, {
        status: 'permanent-failed', error: '桌面端拒绝了格式无效的投递请求。',
      }).catch(error => broadcast('story:log', { storyId, line: `[delivery] 无法回传无效投递结果：${error}` }))
    }
    return
  }
  // Old workers do not know traceId yet. Keep the delivery usable and make it
  // searchable without inventing an ID from message contents.
  const delivery: DesktopDelivery = payload.traceId ? payload : { ...payload, traceId: `delivery:${payload.deliveryId}` }
  const previous = outbox.get(storyId, delivery.deliveryId)
  const previousFlight = deliveryFlights.get(`${storyId}:${delivery.deliveryId}`)
  let previousAction = persistedDeliveryAction(previous?.state, !!previousFlight)
  if (previousAction === 'wait' && previousFlight) {
    // A duplicate request inside this process can safely wait for the owner
    // flight. Re-read the durable row afterwards; never infer success from
    // the fact that the promise merely finished.
    await previousFlight.catch(() => undefined)
    return dispatchDeliveryOnce(storyId, delivery)
  }

  if (previousAction === 'unknown' && previous?.state === 'sending') {
    // `sending` survives a process restart, but its in-memory flight does not.
    // Mark it unknown before replying so a later retry cannot send it again.
    const settled = outbox.settle(storyId, previous.deliveryId, {
      status: 'unknown',
      error: '主进程在等待渠道回执期间重启，投递结果未知；不会自动重发。',
    })
    if (settled) broadcast('story:delivery', settled)
    previousAction = 'unknown'
  }

  if (previousAction === 'reuse' || previousAction === 'unknown' || previousAction === 'terminal-failed') {
    const current = outbox.get(storyId, delivery.deliveryId)
    const receipt: DeliveryReceipt = previousAction === 'reuse'
      ? { status: 'sent', messageIds: current?.messageIds }
      : previousAction === 'unknown'
        ? { status: 'unknown', messageIds: current?.messageIds, error: current?.lastError || '投递结果未知（请求已写出，无回执）——不自动重发。' }
        : { status: 'permanent-failed', messageIds: current?.messageIds, error: current?.lastError || '该投递已被永久拒绝，不自动重发。' }
    await stories.settleDelivery(storyId, delivery.deliveryId, workerReceipt(receipt))
      .catch(error => broadcast('story:log', { storyId, line: `[delivery] 无法回传已有投递结果：${error}` }))
    return
  }

  // P1-1：跨 deliveryId 的业务幂等。worker 的 split/delayed 重试换新
  // deliveryId，但 intentKey 稳定。成功结果可以复用；unknown 或永久失败
  // 不能被伪装成 sent，也不能因为换了 deliveryId 而自动重发。
  if (delivery.intentKey) {
    let twin = outbox.findByIntentKey(storyId, delivery.intentKey)
    if (twin?.state === 'sending') {
      const flight = deliveryFlights.get(`${storyId}:${twin.deliveryId}`)
      if (flight) {
        await flight.catch(() => undefined)
        twin = outbox.findByIntentKey(storyId, delivery.intentKey)
      }
      if (twin?.state === 'sending') {
        const settled = outbox.settle(storyId, twin.deliveryId, {
          status: 'unknown',
          error: '主进程在等待渠道回执期间重启，投递结果未知；不会自动重发。',
        })
        if (settled) {
          twin = settled
          broadcast('story:delivery', settled)
        }
      }
    }
    if (twin && twin.deliveryId !== delivery.deliveryId) {
      const twinAction = persistedDeliveryAction(twin.state, false)
      if (twinAction === 'reuse' || twinAction === 'unknown' || twinAction === 'terminal-failed') {
        const receipt: DeliveryReceipt = twinAction === 'reuse'
          ? { status: 'sent', messageIds: twin.messageIds }
          : twinAction === 'unknown'
            ? { status: 'unknown', messageIds: twin.messageIds, error: twin.lastError || '同一业务消息已有未知投递结果；不会自动重发。' }
            : { status: 'permanent-failed', messageIds: twin.messageIds, error: twin.lastError || '同一业务消息已被永久拒绝；不会自动重发。' }
        broadcast('story:log', {
          storyId,
          line: `[delivery] 幂等命中：intentKey=${delivery.intentKey} 与 deliveryId=${twin.deliveryId}（${twin.state}），跳过重发。`,
          correlation: { traceId: delivery.traceId, deliveryId: delivery.deliveryId },
        })
        const alias = outbox.enqueue(storyId, delivery)
        broadcast('story:delivery', alias)
        const aliasSettled = outbox.settle(storyId, alias.deliveryId, receipt)
        if (aliasSettled) broadcast('story:delivery', aliasSettled)
        await stories.settleDelivery(storyId, delivery.deliveryId, workerReceipt(receipt))
          .catch(error => broadcast('story:log', { storyId, line: `[delivery] 无法回传幂等命中结果：${error}` }))
        return
      }
    }
  }
  const record = outbox.enqueue(storyId, delivery)
  broadcast('story:delivery', record)
  broadcast('story:log', {
    storyId,
    line: `[trace] 出站投递已创建：${record.deliveryId}`,
    correlation: { traceId: record.traceId, processingId: record.processingId, deliveryId: record.deliveryId },
  })
  let receipt: DeliveryReceipt
  const adapter = channels.get(record.transport, record)
  if (!adapter) {
    receipt = { status: 'permanent-failed', error: `未安装或未连接 ${record.transport} 渠道适配器。` }
  } else {
    outbox.markSending(storyId, record.deliveryId)
    broadcast('story:delivery', outbox.get(storyId, record.deliveryId))
    broadcast('story:log', {
      storyId,
      line: `[trace] 出站投递发送中：${record.deliveryId}`,
      correlation: { traceId: record.traceId, processingId: record.processingId, deliveryId: record.deliveryId },
    })
    try { receipt = await adapter.send(record) }
    catch (error) { receipt = { status: 'retryable-failed', error: String(error) } }
  }
  const settled = outbox.settle(storyId, record.deliveryId, receipt)
  broadcast('story:delivery', settled)
  broadcast('story:log', {
    storyId,
    line: `[delivery] ${settled?.state || receipt.status}${receipt.error ? `：${receipt.error}` : ''}`,
    correlation: { traceId: record.traceId, processingId: record.processingId, deliveryId: record.deliveryId },
  })
  try { await stories.settleDelivery(storyId, record.deliveryId, workerReceipt(receipt)) }
  catch (error) { broadcast('story:log', { storyId, line: `[delivery] 回传 HDSI 投递结果失败：${error}` }) }
}

function registerIpc() {
  // P2 结构批次第一步：IPC handler 已按域拆至 src/main/ipc/*（theme-packs/logs/
  // connection/runtime/stories/mixer/plugins/accounts/console/secrets）。行为保持
  // ——channel 名、参数校验、错误文案、广播与返回形状逐字迁移；此处只做依赖
  // 装配与注册编排。可变原语（window/blindMode/lastSnowLumaDetection）经访问器
  // 注入，避免按值捕获与模块级状态失同步（见 ipc/context.ts 头注）。
  const ctx: IpcContext = {
    appRoot, dataRoot, storiesRoot,
    stories, bindings, inbox, receipts, secrets, usage, onebot, accountRegistry,
    config, archives, logs, projections, consoleEmbed, themePacks, pluginInstaller,
    externalConnectionStates, externalAccountStates, workerConfigHashes,
    getWindow: () => window,
    isBlindMode: () => blindMode,
    setBlindMode: on => { blindMode = on },
    setLastSnowLumaDetection: value => { lastSnowLumaDetection = value },
    broadcast,
    buildFirstRunReadiness,
    assertStoryModelReady,
    rememberWorkerConfig,
    resolveHdsiVersion,
    buildStoryYml,
    syncExternalConnector,
    reconcileExternalConnector,
  }
  // P2 输入边界批次：全部 ipcMain.handle 经 ipc/register.ts 包装——分派前校验
  // event.sender 是主窗口 webContents（fail-closed：窗口不存在时一律拒绝）。
  // Console BrowserView 当前 sandbox+无 preload 打不进来，本守卫把"恰好打不
  // 进来"升级为"被拒绝"（防御纵深）。
  bindTrustedSender(() => window?.webContents)
  registerThemePacksIpc(ctx)
  registerLogsIpc(ctx)
  registerConnectionIpc(ctx)
  registerRuntimeIpc(ctx)
  registerStoriesIpc(ctx)
  registerMixerIpc(ctx)
  registerPluginsIpc(ctx)
  registerImporterIpc(ctx)
  registerAccountsIpc(ctx)
  registerConsoleIpc(ctx)
  registerSecretsIpc(ctx)

  // Channel adapters call MessageRouter directly inside the main process.
  // Do not expose generic inbound routing or account binding to Renderer;
  // the explicit config/secret operations above are the only narrow T5 UI API.
  // Existing bindings are authoritative after a desktop restart. Keeping the
  // external connector alive while a story is unloaded lets muted/paused input
  // enter the durable Inbox rather than silently disappearing.
  for (const entry of accountRegistry.list()) syncExternalConnector(entry.storyId)
}

/** W2（B2-3）：按剧本的全部账号登记同步外部上游连接器——每账号一个连接器。
 * 有 externalUpstream 且账号绑定存在的才连接；配置撤销/解绑即停对应连接器。
 * （P2 结构批次：原先嵌在 registerIpc 内声明，仅引用模块级状态——提升为顶层
 * 无行为差异；ipc/accounts 经 ctx 拿到的是同一函数实例。） */
function syncExternalConnector(storyId: string) {
  const entries = accountRegistry.listByStory(storyId)
  const wanted = new Map<string, { endpoint: string, selfId: string, tokenAlias?: string }>()
  for (const entry of entries) {
    if (!entry.externalUpstream?.endpoint) continue
    if (!bindings.find('onebot:' + entry.selfId)) continue
    wanted.set('onebot:' + entry.selfId, { selfId: entry.selfId, endpoint: entry.externalUpstream.endpoint, tokenAlias: entry.externalUpstream.tokenAlias })
  }
  // 停掉本故事已不需要的连接器（配置撤销 / 账号解绑）。
  for (const [accountKey, connector] of [...externalConnectors]) {
    if (connector.ownerStoryId !== storyId || wanted.has(accountKey)) continue
    externalConnectors.delete(accountKey)
    void connector.stop().catch(error => broadcast('story:log', { storyId, line: `[onebot-ext] 停止账号 ${accountKey} 的上游连接器失败：${error}` }))
    broadcast('story:log', { storyId, line: `[onebot-ext] 账号 ${accountKey} 的外部上游连接器已停止。` })
  }
  for (const [accountKey, want] of wanted) {
    if (externalConnectors.has(accountKey)) continue
    let token: string | undefined
    try {
      if (want.tokenAlias) token = secrets.get(want.tokenAlias)
    } catch (error) {
      setExternalAccountState(storyId, accountKey, 'configuration-error', '上游 token 别名无法解析。')
      broadcast('story:log', { storyId, line: `[onebot-ext] 账号 ${accountKey} 的上游 token 别名解析失败；未建立无 token 降级连接。` })
      continue
    }
    const connector = new ExternalOneBotConnector({ endpoint: want.endpoint, token, storyId, selfId: want.selfId }, accountRegistry)
    connector.setLogger(line => broadcast('story:log', { storyId, line: `[onebot-ext ${want.selfId}] ` + line }))
    connector.setInboundListener(async event => {
      try { await handleInboundEvent(event) }
      catch (error) {
        broadcast('story:log', {
          storyId,
          line: `[onebot-ext ${want.selfId}] 入站路由异常：` + error,
          correlation: { traceId: event.traceId },
        })
      }
    })
    connector.setOnlineListener(selfId => {
      setExternalAccountState(storyId, 'onebot:' + selfId, 'online')
      broadcast('story:log', { storyId, line: `[onebot-ext] 外部 OneBot 已验证连接：账号 ${selfId}。` })
    })
    connector.setOfflineListener(() => setExternalAccountState(storyId, accountKey, 'offline'))
    connector.setErrorListener((code, message) => setExternalAccountState(storyId, accountKey, 'configuration-error', message, code))
    externalConnectors.set(accountKey, connector)
    setExternalAccountState(storyId, accountKey, 'connecting')
    connector.start()
    broadcast('story:log', { storyId, line: `[onebot-ext] 账号 ${accountKey} 的外部上游连接器已启动。` })
  }
  rollupExternalConnectionState(storyId)
}

async function reconcileExternalConnector(storyId: string) {
  const mine = [...externalConnectors].filter(([, connector]) => connector.ownerStoryId === storyId)
  for (const [accountKey, connector] of mine) {
    externalConnectors.delete(accountKey)
    await connector.stop().catch(error => broadcast('story:log', { storyId, line: `[onebot-ext] 停止账号 ${accountKey} 的上游连接器失败：${error}` }))
  }
  syncExternalConnector(storyId)
}

function resolveHdsiVersion() {
  return resolveHdsiRuntime().version
}

function buildStoryYml(payload: { id?: string, characterName?: string }) {
  // 新剧本模板：密钥使用 $secret: 别名（不落盘），由宿主密钥库解析
  return [
    '# HDSI 剧本独立配置（typ-0 存档）',
    '# 密钥使用 $secret: 别名引用宿主密钥库，不会保存在剧本文件夹内。',
    'plugins:',
    '  group:server:',
    '    server:m0:',
    '      port: 0',
    '  group:basic:',
    '    http:m0:',
    '  group:storage:',
    '    database-sqlite:m0:',
    '      path: data/hdsi.db',
    '  group:adapter:',
    '    adapter-onebot:m0:',
    '      selfId: "" # 在桌面账号面板登记后填写（QQ号）',
    '      protocol: ws',
    '      endpoint: ws://127.0.0.1:' + ONEBOT_BRIDGE_PORT + '/onebot/' + payload.id,
    '      token: "" # 可选：桌面桥接 token',
    '  hds-interlude:m0:',
    '    model:',
    '      providers:',
    '        - id: primary',
    '          label: 主模型（待配置）',
    '          endpoint: $secret:primary-endpoint',
    '          apiKey: $secret:primary-key',
    '          model: $secret:primary-model',
    // 审计：模板原把 responseFormat 放在 provider 行、vision 放在顶层——
    // rc52 schema 里主叙事格式实际读取 model.mainResponseFormat（schema 默认
    // json-object 会遮蔽 provider 行），图片理解为 model.vision。新模板直接
    // 落在生效位置：小模型/新手默认 prompt-only 纯文本合约。
    '      mainResponseFormat: prompt-only',
    '      vision:',
    '        enabled: false',
    '    runtime:',
    '      autoCreate: true',
    '    storyDefaults:',
    `      characterName: ${payload.characterName || ''}`,
  ].join('\n')
}

/**
 * P2 测试批次 B 档：主进程自检冒烟。真 Electron、真窗口、真 IPC 分派——
 * 验证"装配"而非"语义"（语义由单元/合同测试钉住）：56 channel 注册齐全、
 * preload 真实加载、sender 守卫对真实窗口 invoke 放行（关闭此前 acknowledged
 * 的自动化缺口）、隔离数据根、干净退出。由 scripts/test-smoke.mjs 驱动，输出
 * `[self-test] PASS/FAIL <name>` 标记行，退出码汇总。
 */
async function runSelfTest() {
  const report = (ok: boolean, name: string, detail = '') => {
    console.log(`[self-test] ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`)
    if (!ok) process.exitCode = 1
  }
  try {
    // 1) IPC 注册面 ↔ preload invoke 面的程序化对照（dev 仓库内读 preload 源码）。
    const channels = registeredIpcChannels()
    const preloadFile = path.join(appRoot, 'src', 'preload', 'preload.ts')
    if (existsSync(preloadFile)) {
      const invoked = [...readFileSync(preloadFile, 'utf8').matchAll(/ipcRenderer\.invoke\('([^']+)'/g)].map(match => match[1])
      const missing = invoked.filter(channel => !channels.includes(channel))
      const orphan = channels.filter(channel => !invoked.includes(channel))
      report(missing.length === 0 && orphan.length === 0, 'ipc-registration-parity', `registered=${channels.length} invoked=${invoked.length} missing=[${missing.join(',') || '无'}] orphan=[${orphan.join(',') || '无'}]`)
    } else {
      report(channels.length >= 50, 'ipc-registration-count', `registered=${channels.length}（打包形态无 preload 源码，退化为计数断言）`)
    }
    // 2) renderer 就绪后经页面真实 invoke（preload 加载 + sender 守卫放行路径）。
    await new Promise(resolve => setTimeout(resolve, 2_000))
    const resources = await window?.webContents.executeJavaScript('window.hdsiDesktop ? window.hdsiDesktop.runtime.resources() : Promise.reject(new Error("preload api missing"))').catch(error => ({ error: String(error) }))
    report(resources && typeof (resources as any).maxWorkers === 'number', 'real-invoke-sender-guard', JSON.stringify(resources))
    // 3) 隔离数据根：临时目录内无剧本、无 worker 可恢复。
    const storiesInTemp = stories.list()
    report(storiesInTemp.length === 0, 'isolated-data-root', `stories=${storiesInTemp.length} root=${dataRoot}`)
    // 4) HostLock 确实持有（否则 whenReady 早退，走不到这里）。
    report(hostLock !== undefined, 'host-lock-held')
    console.log(`[self-test] DONE ${process.exitCode ? 'FAIL' : 'OK'}`)
    app.exit(typeof process.exitCode === 'number' ? process.exitCode : 0)
  } catch (error) {
    console.log(`[self-test] FAIL exception — ${error}`)
    app.exit(1)
  }
}

app.whenReady().then(async () => {
  // D3：单宿主锁先行——同一数据目录绝不允许两个主进程写 SQLite/登记簿。
  hostLock = new HostLock(SELF_TEST ? selfTestRoot! : (app.isPackaged ? app.getPath('userData') : appRoot))
  const lock = hostLock.acquire()
  if (!lock.acquired) {
    await dialog.showErrorBox('typ-0 已在运行', lock.reason + '。请使用已打开的窗口；若确认它是残留进程，可在任务管理器结束后重试。')
    app.quit()
    return
  }
  initializeRuntime()
  installProcessDiagnostics()
  registerIpc()
  // P0-5：retention 随启动执行一次，此后每日一次。
  runLogRetention()
  setInterval(runLogRetention, 24 * 60 * 60 * 1000)
  // P1：桥会话清扫——协商超时（30s）与心跳失联（45s）的状态翻转在此驱动；
  // 15s 周期让 stale 最多晚一个心跳周期被发现，与 worker 10s 心跳节奏匹配。
  setInterval(() => stories.sweepBridgeSessions(), 15_000)
  // 先起 OneBot 桥接服务端：自动恢复的 worker 会立刻连入。
  // 审计：await 而非 fire-and-forget——worker 的 adapter-onebot 启动即回连
  // ws://127.0.0.1:6709，未监听完成时首连失败，只能靠适配器退避重连，
  // 每次开机都白白拖慢 bridge-ready。
  try {
    await onebot.start(ONEBOT_BRIDGE_PORT)
  } catch (error) {
    broadcast('story:log', { line: '[onebot] 桥接服务端启动失败（私聊收发不可用）：' + error })
  }
  // 性能审计：窗口先建（IPC 已就绪，渲染层只依赖它）——此前窗口在孤儿扫描
  // （Windows 上每条记录 execSync('tasklist') 最多 3s）与逐个恢复之后才创建，
  // 用户对着空屏数秒。扫描与恢复转后台进行，恢复并行（maxWorkers 仍限并发）。
  createWindow()
  app.on('activate', () => { if (!window) createWindow() })
  if (SELF_TEST) void runSelfTest()
  void (async () => {
    // D2-1：先清孤儿 worker（上一代主进程崩溃/被杀时遗留），再自动恢复运行中的
    // 故事。扫描失败不阻塞启动；单个恢复失败不影响其余。
    try {
      for (const verdict of stories.workerRegistry.sweep()) {
        const line = `[registry] worker 记录处置：${verdict.storyId} pid=${verdict.pid} → ${verdict.action}${verdict.detail ? `（${verdict.detail}）` : ''}`
        broadcast('story:log', { storyId: verdict.storyId, line })
      }
    } catch (error) {
      broadcast('story:log', { line: '[registry] 孤儿 worker 扫描失败（不影响启动）：' + error })
    }
    // 恢复保持串行：load() 内的分支树门控（activeSiblingsInTree）依赖前一个
    // fork 完成登记——并行会让同树剧本同时通过"无活跃兄弟"检查。
    const resumable = selectResumableStories(stories.list())
    for (const storyId of resumable) {
      try {
        assertStoryModelReady(storyId)
        const handle = stories.load(storyId)
        if (handle?.running) rememberWorkerConfig(storyId)
        if (handle?.running) broadcast('story:log', { storyId, line: `[registry] 已自动恢复运行（pid ${handle.pid}）。` })
      } catch (error) {
        broadcast('story:log', { storyId, line: '[registry] 自动恢复失败，可手动加载：' + error })
      }
    }
  })()
})

app.on('window-all-closed', async () => {
  // typ-0：销毁 Console 嵌入视图、卸载全部剧本 worker（mute/pause 状态已写回各自 story.json）
  for (const handle of stories.list()) {
    consoleEmbed.dispose(handle.meta.id, partition => { try { session.fromPartition(partition).clearStorageData() } catch { /* best effort */ } })
  }
  for (const connector of externalConnectors.values()) {
    try { await connector.stop() } catch { /* best effort */ }
  }
  externalConnectors.clear()
    void (async () => {
      // D3-4：给在途投递一个有界排空窗口——sending 中的请求已写出，
      // 等它落账（成功/失败/unknown 都算落账）再停渠道。
      const drainStart = Date.now()
      while (inFlightDeliveries > 0 && Date.now() - drainStart < 8_000) {
        await new Promise(resolve => setTimeout(resolve, 200))
      }
      await Promise.allSettled(stories.list().map(handle => stories.unload(handle.meta.id)))
    })()
    .finally(() => channels.stopAll())
    // 审计：桥接服务端（ws server + 全部 worker socket）此前无人调用 stop，
    // 只能等进程死亡回收——排空后显式关闭。
    .finally(() => { void onebot.stop().catch(() => undefined) })
    .finally(() => logs.drain())
    .finally(() => { try { hostLock?.release() } catch { /* best effort */ } })
    .finally(() => app.quit())
})



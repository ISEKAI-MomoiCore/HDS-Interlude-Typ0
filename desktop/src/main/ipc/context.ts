/**
 * IPC 域模块的统一依赖注入上下文（P2 结构批次第一步：拆分 IPC 注册）。
 *
 * 约定：
 *  - main.ts 仍是全部模块级状态的唯一权威（initializeRuntime 构造、运行期变更）；
 *    域模块不新建状态、不反向 import main.ts，只经此上下文取依赖。
 *  - 服务与 Map 按引用共享（构造后引用稳定）；可变原语（window/blindMode/
 *    lastSnowLumaDetection）经访问器暴露——按值捕获会与 main.ts 失同步。
 *  - 跨域共享的宿主辅助函数（broadcast/readiness/连接器同步等）由 main.ts
 *    提供实现，经 ctx 注入；纯函数（yaml/normalize 等）各模块自行 import。
 *  - 行为边界：channel 名、参数校验、错误文案、广播时序与返回形状一律保持
 *    原样——本拆分是纯移动，评审按"逐字搬运 + 顶部解构"对照。
 */
import type { BrowserWindow } from 'electron'
import type { BindingRegistry } from '../runtime/bindings'
import type { OneBotServerAdapter } from '../runtime/onebot-bridge'
import type { AccountRegistry } from '../runtime/account-registry'
import type { InboxRepository } from '../runtime/inbox-replay'
import type { InboundReceiptLedger } from '../runtime/inbound-ledger'
import type { DeliveryOutbox } from '../runtime/outbox'
import type { MessageRouter } from '../runtime/message-router'
import type { SecretStore } from '../runtime/secrets'
import type { UsageAggregator } from '../runtime/usage-aggregator'
import type { StoryConfigMediator } from '../runtime/config-mediator'
import type { StoryArchiveService } from '../runtime/story-archive'
import type { LogBroker } from '../runtime/log-broker'
import type { HostProjectionService } from '../runtime/host-projection'
import type { ConsoleEmbedService } from '../runtime/console-embed'
import type { ThemePackStore } from '../runtime/theme-packs'
import type { PluginInstaller } from '../runtime/plugin-installer'
import type { detectSnowLuma } from '../runtime/snowluma-detection'
import type { FirstRunReadiness } from '../runtime/first-run-readiness'
import type { StoryManager } from '../stories'

export type ExternalConnectionState = 'not-configured' | 'connecting' | 'online' | 'offline' | 'configuration-error'

/** W2：每账号连接状态（含SELF_ID_MISMATCH等错误码）。 */
export type ExternalAccountStateEntry = { state: ExternalConnectionState, updatedAt: string, error?: string, code?: 'SELF_ID_MISMATCH' | 'ONEBOT_ENDPOINT_UNREACHABLE' | 'ONEBOT_AUTH_FAILED' }

export interface IpcContext {
  // ── 路径 ──
  appRoot: string
  dataRoot: string
  storiesRoot: string

  // ── 服务（initializeRuntime 构造后引用稳定） ──
  stories: StoryManager
  bindings: BindingRegistry
  inbox: InboxRepository
  receipts: InboundReceiptLedger
  outbox: DeliveryOutbox
  router: MessageRouter
  secrets: SecretStore
  usage: UsageAggregator
  onebot: OneBotServerAdapter
  accountRegistry: AccountRegistry
  config: StoryConfigMediator
  archives: StoryArchiveService
  logs: LogBroker
  projections: HostProjectionService
  consoleEmbed: ConsoleEmbedService
  themePacks: ThemePackStore
  pluginInstaller: PluginInstaller

  // ── 共享状态 Map（引用稳定，内容随运行变化） ──
  externalConnectionStates: Map<string, { state: ExternalConnectionState, updatedAt: string, error?: string }>
  externalAccountStates: Map<string, ExternalAccountStateEntry>
  /** 运行中 Worker 实际加载的 canonical 配置指纹（needsReload 判定）。 */
  workerConfigHashes: Map<string, string>

  // ── 可变原语访问器（按值捕获会与 main.ts 失同步） ──
  getWindow: () => BrowserWindow | null
  isBlindMode: () => boolean
  setBlindMode: (on: boolean) => void
  setLastSnowLumaDetection: (value: Awaited<ReturnType<typeof detectSnowLuma>> | null) => void

  // ── 宿主辅助函数（main.ts 提供） ──
  broadcast: (event: string, payload: unknown) => void
  buildFirstRunReadiness: (metaId: string) => FirstRunReadiness | { error: string }
  assertStoryModelReady: (metaId: string) => void
  rememberWorkerConfig: (metaId: string) => void
  resolveHdsiVersion: () => string
  buildStoryYml: (payload: { id?: string, characterName?: string }) => string
  syncExternalConnector: (storyId: string) => void
  reconcileExternalConnector: (storyId: string) => Promise<void>
}

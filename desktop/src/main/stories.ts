/**
 * typ-0 剧本文件夹规范与生命周期管理。
 *
 * 一个剧本 = 一个自包含文件夹（Minecraft 存档式）：
 *   stories/<id>/
 *   ├─ story.json      # 存档清单（元信息）
 *   ├─ 说明.md          # 剧本专属说明（加载时弹出；不含自动剧情回顾）
 *   ├─ koishi.yml      # 本剧本独立配置（密钥以 $secret: 别名引用，不落盘）
 *   └─ data/           # 本剧本专属 SQLite + inbox.json（后台收件箱）
 *
 * 运行状态机（phase）：running → muted → paused → running …
 *  - running: 消息正常处理，剧本全速写作
 *  - muted:   角色离线——用户消息进入后台收件箱，剧本依旧续写（worker 继续运行）
 *  - paused:  引擎断电——停止一切剧本写作；消息仍进收件箱（不丢失）
 */
import { ChildProcess, fork } from 'node:child_process'
import { EventEmitter, once } from 'node:events'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, watch, writeFileSync } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { CompiledStoryConfig, StoryConfigCompiler } from './runtime/config-compiler'
import { attributePluginFailure, readPluginPanel } from './runtime/plugin-panel'
import { activeSiblingsInTree } from './runtime/branch-registry'
import { BridgeRequestAbortedError, BridgeRequestTimeoutError, BridgeSessionTracker } from './runtime/bridge-session'
import { ConsoleRegistry } from './runtime/console-registry'
import { DeliveryReceipt, DesktopInboundEvent, StoryPhase } from './runtime/contracts'
import { WorkerRegistry } from './runtime/worker-registry'
import { writeJsonAtomic } from './runtime/json-file'

/** 分支谱系（schemaVersion 2 可选字段）。分支是完整剧本，谱系只声明派生关系。 */
export interface StoryParentRef {
  storyId: string
  forkedAt: string
  forkPoint?: { entryId?: number, occurredAt?: string }
}

export interface StoryMeta {
  schemaVersion: 1 | 2
  id: string
  name: string
  characterName: string
  hdsiVersion: string
  createdAt: string
  updatedAt: string
  lastOpenedAt: string
  description: string
  accounts: string[]
  phase: 'running' | 'muted' | 'paused'
  /** schemaVersion 2：仅分支携带；根剧本无此字段。 */
  parent?: StoryParentRef
}

export interface StoryHandle {
  meta: StoryMeta
  dir: string
  running: boolean
  pid?: number
  bridgeReady?: boolean
  bridgeProtocol?: number
  bridgeApiVersion?: number
  lastSeenAt?: string
  /** Actual package selected by the desktop resolver, not the manifest's
   * historical creation value. */
  runtimeCore?: { version: string, artifact: string, artifactHash?: string }
  bridgeCapabilities?: string[]
}

export interface RuntimeCoreDescriptor { version: string, artifact: string, artifactHash?: string }

function storyJsonPath(dir: string) { return path.join(dir, 'story.json') }
function inboxPath(dir: string) { return path.join(dir, 'data', 'inbox.json') }
function ymlPath(dir: string) { return path.join(dir, 'koishi.yml') }
function readmePath(dir: string) { return path.join(dir, '说明.md') }

function assertStoryId(id: string) {
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(id)) {
    throw new Error('剧本 ID 只能使用字母、数字、- 或 _，长度 1–64。')
  }
}

function parseParentRef(value: unknown): StoryParentRef | undefined {
  if (!value || typeof value !== 'object') return undefined
  const raw = value as Record<string, unknown>
  if (typeof raw.storyId !== 'string' || !raw.storyId || typeof raw.forkedAt !== 'string') return undefined
  const forkPointSource = raw.forkPoint
  let forkPoint: StoryParentRef['forkPoint']
  if (forkPointSource && typeof forkPointSource === 'object') {
    const point = forkPointSource as Record<string, unknown>
    forkPoint = {
      ...(Number.isSafeInteger(Number(point.entryId)) ? { entryId: Number(point.entryId) } : {}),
      ...(typeof point.occurredAt === 'string' ? { occurredAt: point.occurredAt } : {}),
    }
  }
  return {
    storyId: raw.storyId,
    forkedAt: raw.forkedAt,
    ...(forkPoint && (forkPoint.entryId !== undefined || forkPoint.occurredAt !== undefined) ? { forkPoint } : {}),
  }
}

export function readStoryMeta(dir: string): StoryMeta | undefined {
  const file = storyJsonPath(dir)
  if (!existsSync(file)) return undefined
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    const parent = parseParentRef(raw.parent)
    const meta: StoryMeta = {
      schemaVersion: parent ? 2 : 1,
      id: String(raw.id || ''), name: String(raw.name || ''), characterName: String(raw.characterName || raw.name || ''),
      hdsiVersion: String(raw.hdsiVersion || 'unknown'), createdAt: String(raw.createdAt || new Date(0).toISOString()),
      updatedAt: String(raw.updatedAt || raw.createdAt || new Date(0).toISOString()),
      lastOpenedAt: String(raw.lastOpenedAt || raw.createdAt || new Date(0).toISOString()),
      description: String(raw.description || ''), accounts: Array.isArray(raw.accounts) ? raw.accounts.filter(item => typeof item === 'string') : [],
      phase: raw.phase === 'running' || raw.phase === 'muted' || raw.phase === 'paused' ? raw.phase : 'paused',
      ...(parent ? { parent } : {}),
    }
    if (!meta.id || !meta.name) return undefined
    // Older typ-0 folders did not carry an explicit schema/version timestamp.
    // Persist the normalization once so every later process sees one manifest
    // shape, while a read-only or damaged folder remains readable. schemaVersion
    // is derived from the presence of a parent ref (v2 = v1 + branch lineage).
    const declaredVersion = Number(raw.schemaVersion)
    if (declaredVersion !== meta.schemaVersion || !raw.updatedAt || !raw.lastOpenedAt) {
      try { writeJsonAtomic(file, meta) } catch { /* keep the valid in-memory legacy manifest */ }
    }
    return meta
  } catch { return undefined }
}

export function writeStoryMeta(dir: string, meta: StoryMeta, options: { opened?: boolean } = {}) {
  const now = new Date().toISOString()
  meta.updatedAt = now
  if (options.opened) meta.lastOpenedAt = now
  writeJsonAtomic(storyJsonPath(dir), meta)
}

/** 创建一个新剧本文件夹（模板化 koishi.yml 由调用方注入）。 */
export function createStoryFolder(storiesRoot: string, meta: Omit<StoryMeta, 'lastOpenedAt' | 'updatedAt'>, yml: string, readme = '') {
  // 审查T25: undefined 经 String() 隐式转换后 "undefined" 能过正则——先挡类型；
  // 五步落盘任一失败要清理半成品目录，否则同 ID 永久报"已存在"且残留死条目。
  if (typeof meta?.id !== 'string' || !meta.id) throw new Error('剧本 ID 必须是非空字符串。')
  assertStoryId(meta.id)
  const dir = path.join(storiesRoot, meta.id)
  if (existsSync(dir)) throw new Error(`剧本已存在：${meta.id}`)
  try {
  mkdirSync(path.join(dir, 'data'), { recursive: true })
  const now = new Date().toISOString()
  writeJsonAtomic(storyJsonPath(dir), { ...meta, lastOpenedAt: now, updatedAt: now })
  writeFileSync(ymlPath(dir), yml)
  writeFileSync(readmePath(dir), readme || `# ${meta.name}\n\n${meta.description || '（剧本说明待补充）'}`)
  writeJsonAtomic(inboxPath(dir), { version: 1, records: [] })
  } catch (error) {
    rmSync(dir, { recursive: true, force: true })
    throw error
  }
  return dir
}

/**
 * 多剧本管理器：每个运行中的剧本一个 koishi worker（fork，cwd=剧本目录）。
 * 职责：
 *  - 生命周期：load（fork worker）/ unload（kill）/ 状态切换（running/muted/paused）
 *  - 控制通道：通过 IPC 向 worker 发送 { type: 'hdsi-desktop', command, value }
 *  - 后台收件箱：muted/paused 期间由宿主可靠落盘；HDSI 确认后才确认消费
 */
/** 能力位按清单声明判定（rc53 起 worker 永远使用宿主已装插件，清单恒非空；
 * rc25 及更早的"空清单隐含主线三命令"兼容已随死代码清理移除）。 */
export function bridgeCapabilityAllowed(declared: string[] | undefined, capability: string): boolean {
  if (!declared || !declared.length) return false
  return declared.includes(capability)
}

export class StoryManager extends EventEmitter {
  private workers = new Map<string, ChildProcess>()
  private phases = new Map<string, StoryPhase>()
  /** P0-4：unload 流程主动标记的 worker——exit handler 据此区分主动停止与崩溃。 */
  private readonly stoppingWorkers = new Set<string>()
  /** P0-4：收到 error 事件（如 spawn 失败）的 worker——exit 分类优先记 error。 */
  private readonly erroredWorkers = new Set<string>()
  /** 审计：被宿主 SIGKILL 的具体进程——exit 晚于 unload 的 2s 兜底窗到达时，
   * 仍按"主动停止"分类，不误报 crash（按进程而非故事键标记，不受槽位顶替影响）。 */
  private readonly killedChildren = new WeakSet<ChildProcess>()
  private bridgeReady = new Set<string>()
  private bridgeProtocols = new Map<string, number>()
  private bridgeApiVersions = new Map<string, number>()
  private bridgeCapabilities = new Map<string, string[]>()
  private lastSeenAt = new Map<string, number>()
  private compiledConfigs = new Map<string, CompiledStoryConfig>()
  /** P1：桥会话状态机——协商/心跳/退出的可查询投影（门控执行仍是下方既有方法）。
   *  onChange 经 'bridge-session' 事件外送，main.ts 负责 IPC 广播与日志。 */
  readonly bridgeSessions = new BridgeSessionTracker(snapshot => this.emit('bridge-session', snapshot))
  /** 在途 requestDesktop 的中止句柄——worker 退出时立即按"worker 已退出"分类
   *  结算，不再让请求干等到各自超时才报一个误导性的 timeout（幽灵超时）。 */
  private readonly pendingBridgeRequests = new Map<string, Set<(error: Error) => void>>()
  /** Phase 2：worker stdout/stderr 尾部环形缓冲（崩溃归因用，每故事最多 60 行）。 */
  private readonly workerLogTail = new Map<string, string[]>()
  /** 性能审计：list() 的 meta 指纹缓存（story.json 的 名字+mtime+size 指纹）。 */
  private listCache: { fingerprint: string, handles: Array<{ meta: StoryMeta, dir: string }> } | undefined
  /** D2-1：孤儿 worker 登记簿（fork 写入、exit 清除、主进程启动扫描）。 */
  readonly workerRegistry: WorkerRegistry
  /** M6：每故事 loopback Console descriptor（端口由 worker 上报，worker 退出即失效）。 */
  readonly consoles = new ConsoleRegistry()

  constructor(
    private readonly storiesRoot: string,
    private readonly appRoot: string,
    private readonly configCompiler?: StoryConfigCompiler,
    private readonly maxWorkers = 3,
    /** M7-2：账号绑定事务回调（main.ts 注入）。返回该剧本当前的宿主运行参数。 */
    private readonly runtimeOptionsResolver?: (storyId: string) => { onebot?: { selfId?: string, endpoint?: string } },
    private readonly runtimeCore?: RuntimeCoreDescriptor,
    workerRegistry?: WorkerRegistry,
    /** D4-2：Console 保存配置后 loader 会改写 resolved 文件；此回调在防抖后收到路径。 */
    private readonly resolvedConfigChangedListener?: (storyId: string, resolvedFile: string) => void,
    /** Phase 2：第三方插件运行时目录（<dataRoot>/plugins-runtime）。非空时
     * fork 注入 NODE_PATH 与宿主解析 hook，使 worker 能加载安装在该目录的
     * koishi 插件（koishi/cordis 系列仍强制解析到宿主副本，同实例）。 */
    private readonly pluginRuntimeDir?: string,
  ) {
    super()
    this.workerRegistry = workerRegistry ?? new WorkerRegistry(storiesRoot)
  }

  list(): StoryHandle[] {
    if (!existsSync(this.storiesRoot)) return []
    // 性能审计：list() 原先每次全量重扫（readdir + 每剧本 readFileSync + JSON.parse），
    // 而 get() = list().find()，main.ts 有 34 处调用——重启后每条入站消息都触发
    // 全目录扫描。改为指纹缓存：目录条目名集合 + 每个 story.json 的 mtime/size
    // 没变即复用已解析的 meta（单写者进程，HostLock 保证无外部并发写）。
    const dirEntries = readdirSync(this.storiesRoot, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
      .sort()
    let fingerprint = ''
    const stats = new Map<string, { mtimeMs: number, size: number }>()
    for (const name of dirEntries) {
      const file = storyJsonPath(path.join(this.storiesRoot, name))
      if (!existsSync(file)) continue
      const stat = statSync(file)
      stats.set(name, { mtimeMs: stat.mtimeMs, size: stat.size })
    }
    for (const [name, stat] of stats) fingerprint += `${name}:${stat.mtimeMs}:${stat.size};`
    if (this.listCache && this.listCache.fingerprint === fingerprint) {
      return this.listCache.handles.map(handle => this.decorateHandle(handle))
    }
    const metas = [...stats.keys()]
      .map(name => readStoryMeta(path.join(this.storiesRoot, name)))
      .filter((meta): meta is StoryMeta => !!meta)
    const handles = metas.map(meta => ({ meta, dir: path.join(this.storiesRoot, meta.id) }))
    const decorated = handles.map(handle => this.decorateHandle(handle))
    this.listCache = { fingerprint, handles }
    return decorated
  }

  /** 用当前运行时 map（worker/bridge/lastSeen）刷新一份缓存的 handle 投影。 */
  private decorateHandle(handle: { meta: StoryMeta, dir: string }): StoryHandle {
    const worker = this.workers.get(handle.meta.id)
    const seenAt = this.lastSeenAt.get(handle.meta.id)
    return { meta: handle.meta, dir: handle.dir, running: !!worker, pid: worker?.pid, bridgeReady: this.isBridgeReady(handle.meta.id), bridgeProtocol: this.bridgeProtocols.get(handle.meta.id), bridgeApiVersion: this.bridgeApiVersions.get(handle.meta.id),
      bridgeCapabilities: this.bridgeCapabilities.get(handle.meta.id)?.slice(), runtimeCore: this.runtimeCore && { ...this.runtimeCore },
      lastSeenAt: seenAt ? new Date(seenAt).toISOString() : undefined }
  }

  get(metaId: string) {
    // D4：统一身份校验——所有 IPC 面的 storyId 都经此过滤，杜绝路径拼接注入。
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(metaId)) return undefined

    return this.list().find(story => story.meta.id === metaId)
  }

  getPhase(metaId: string): StoryPhase | undefined {
    return this.phases.get(metaId) ?? this.get(metaId)?.meta.phase
  }

  /** 加载（fork worker）。phase 从 meta.phase 恢复（muted/paused 保持）。 */
  load(metaId: string): StoryHandle | undefined {
    const handle = this.get(metaId)
    if (!handle) throw new Error(`剧本不存在：${metaId}`)
    if (handle.running) return handle
    if (this.workers.size >= this.maxWorkers) {
      throw new Error(`同时运行的故事已达到上限（${this.maxWorkers}）。请先卸载一个故事，或稍后在资源设置中调整上限。`)
    }
    // 单分支运行门控：同一分支树内同时只允许一个活跃 worker。
    // 与全局上限正交——不同树的分支可以并行（仍受上限约束）。
    const activeSiblings = activeSiblingsInTree(this.list(), metaId)
    if (activeSiblings.length) {
      const names = activeSiblings
        .map(id => this.get(id)?.meta.name || id)
        .join('、')
      throw new Error(`同一分支树内已有运行中的剧本：${names}。同一剧情分支一次只能运行一个，请先卸载它（或使用「切换到此分支」）。`)
    }
    const dir = handle.dir
    if (!existsSync(ymlPath(dir))) throw new Error(`剧本缺少 koishi.yml：${dir}`)
    const entry = this.resolveKoishiWorker()
    const phase = this.getPhase(metaId) ?? 'running'
    // 性能审计：回填 phases map——此前重启后 map 为空，路由器每条入站消息都经
    // getPhase→get()→list() 全目录扫描；种子后 getPhase 纯内存命中。
    this.phases.set(metaId, phase)
    const runtimeOptions = this.runtimeOptionsResolver?.(metaId) ?? {}
    const compiled = this.configCompiler?.compile(dir, runtimeOptions)
    // Phase 2：插件运行时解析注入。NODE_PATH 让 loader 的裸 require.resolve
    // 能命中 plugins-runtime/node_modules（宿主 node_modules 优先，命中顺序与
    // 既有依赖不冲突）；--require hook 强制 koishi/cordis 系列解析到宿主副本，
    // 防止插件沿目录树向上命中任意其它 koishi 实例（Spike A 实测问题）。
    const hostNodeModules = path.join(this.appRoot, 'node_modules')
    const hookFile = this.pluginRuntimeDir ? path.join(this.pluginRuntimeDir, '.typ0-host-hook.js') : undefined
    const hookActive = hookFile && existsSync(hookFile) ? hookFile : undefined
    const nodePath = [
      hostNodeModules,
      this.pluginRuntimeDir ? path.join(this.pluginRuntimeDir, 'node_modules') : undefined,
      process.env.NODE_PATH,
    ].filter(Boolean).join(path.delimiter)
    let child: ChildProcess
    try {
      child = fork(entry, [], {
        cwd: dir,
        env: {
          ...process.env,
          KOISHI_CONFIG_FILE: compiled?.file ?? 'koishi.yml',
          KOISHI_SHARED: JSON.stringify({ startTime: Date.now() }),
          HDSI_STORY_ID: metaId,
          HDSI_PHASE: phase,
          HDSI_DESKTOP_BRIDGE: '1',
          HDSI_ONEBOT_TOKEN: process.env.HDSI_ONEBOT_TOKEN ?? '',   // 三方审查P1: worker 端 yml 注入用
          ...(nodePath ? { NODE_PATH: nodePath } : {}),
          ...(hookActive ? { TYP0_HOST_NODE_MODULES: hostNodeModules } : {}),
        },
        ...(hookActive ? { execArgv: [...process.execArgv, '--require', hookActive] } : {}),
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        silent: true,
      })
    } catch (error) {
      compiled?.cleanup()
      throw error
    }
    if (compiled) this.compiledConfigs.set(metaId, compiled)
    this.workers.set(metaId, child)
    this.workerRegistry.record(metaId, child.pid!)
    this.bridgeSessions.connecting(metaId, { pid: child.pid })
    // 审计：watcher/captureTimer 的关闭原先只挂在 exit 事件上——spawn 失败
    // （Node 不保证随后触发 exit）会泄漏 FSWatcher。提升到外层作用域统一清理。
    let configWatcher: ReturnType<typeof watch> | undefined
    let captureTimer: NodeJS.Timeout | undefined
    const disposeWatcher = () => { clearTimeout(captureTimer); configWatcher?.close(); configWatcher = undefined }
    if (compiled?.file && this.resolvedConfigChangedListener) {
      try {
        configWatcher = watch(compiled.file, { persistent: false }, () => {
          clearTimeout(captureTimer)
          captureTimer = setTimeout(() => this.resolvedConfigChangedListener?.(metaId, compiled.file), 1_200)
        })
      } catch { /* watch 失败只意味着 Console 配置不回写，不影响运行 */ }
    }
    child.once('exit', disposeWatcher)
    writeStoryMeta(dir, handle.meta, { opened: true })
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    // Phase 2：stdout/stderr 尾部环形缓冲（崩溃归因用，每故事最多 60 行）。
    const tailNote = (chunk: unknown) => {
      const tail = this.workerLogTail.get(metaId) ?? []
      for (const line of String(chunk).split(/\r?\n/)) if (line.trim()) tail.push(line.trim())
      while (tail.length > 60) tail.shift()
      this.workerLogTail.set(metaId, tail)
    }
    child.stdout?.on('data', chunk => { tailNote(chunk); this.emit('log', { storyId: metaId, line: String(chunk).replace(/\n+$/, '') }) })
    child.stderr?.on('data', chunk => { tailNote(chunk); this.emit('log', { storyId: metaId, line: String(chunk).replace(/\n+$/, '') }) })
    child.on('message', message => {
      // worker → 壳：收件箱计数 / 心跳 / 请求切换状态
      if (message && typeof message === 'object' && (message as any).type === 'hdsi-desktop') {
        this.lastSeenAt.set(metaId, Date.now())
        this.bridgeSessions.touch(metaId)
        const payload = (message as any).payload
        if ((message as any).event === 'bridge-ready') {
          // P1：先入状态机（不可读/过旧的协议在此成为可查询的 failed 态），
          // 再走既有放行门——门控语义保持不变。
          this.bridgeSessions.negotiate(metaId, payload)
          if (Number.isInteger(payload?.protocol) && payload.protocol >= 2) {
            this.bridgeReady.add(metaId)
            this.bridgeProtocols.set(metaId, payload.protocol)
            const apiVersion = Number.isInteger(payload?.apiVersion) ? payload.apiVersion : undefined
            if (apiVersion !== undefined) this.bridgeApiVersions.set(metaId, apiVersion)
            else this.bridgeApiVersions.delete(metaId)
            const capabilities = Array.isArray(payload?.capabilities)
              ? payload.capabilities.filter((item: unknown): item is string => typeof item === 'string' && item.length <= 80).slice(0, 64)
              : []
            this.bridgeCapabilities.set(metaId, capabilities)
            this.emit('bridge-ready', { storyId: metaId, protocol: payload.protocol, apiVersion, capabilities })
          }
        }
        if ((message as any).event === 'console-port' && Number.isInteger(payload?.port) && payload.port > 0) {
          // M6：worker 上报 loopback server 真实端口；注册表立即生成带新
          // revision 的 descriptor，旧嵌入页因此失效。
          try {
            const descriptor = this.consoles.register(metaId, payload.port, typeof payload.uiPath === 'string' ? payload.uiPath : '/console/')
            this.emit('console-ready', { storyId: metaId, descriptor })
          } catch (error) {
            this.emit('log', { storyId: metaId, line: `[console] 端口登记失败：${error}` })
          }
        }
        this.emit('worker-message', { storyId: metaId, message })
      }
    })
    child.on('exit', (code, signal) => {
      // 审计：身份守卫——spawn-error 清理后/新 worker 已顶替同槽位时，迟到的
      // exit 事件不得删除新 child 的登记（否则活进程失联：unload 失效、孤儿
      // 扫描看不到）。stale child 的退出直接忽略。
      if (this.workers.get(metaId) !== child && !this.stoppingWorkers.has(metaId) && !this.erroredWorkers.has(metaId)) return
      // 审计：unload 的 SIGKILL 后 exit 可能晚于 2s 兜底窗（事件循环停顿）——
      // per-child 标记保证"被宿主杀掉的进程"不会误分类为 crash。
      const killedByHost = this.killedChildren.has(child)
      const intentional = this.stoppingWorkers.delete(metaId) || killedByHost
      const spawnFailed = this.erroredWorkers.delete(metaId)
      // P0-4：退出分类——主动卸载（normal/killed）、worker 自行退出（code 0）、
      // 其余一律 crash。spawn 失败（error 事件先于 exit）记 error。
      const exitKind = spawnFailed ? 'error'
        : intentional ? (signal === 'SIGKILL' || killedByHost ? 'killed' : 'normal')
          : code === 0 ? 'normal'
            : 'crash'
      // P1：会话闭合 + 在途请求立即分类结算（worker-restarted 语义，不再幽灵超时）。
      this.bridgeSessions.workerExited(metaId, exitKind)
      this.abortPendingBridgeRequests(metaId, exitKind)
      // Phase 2：异常退出先取日志尾快照（下方清理会删除环形缓冲）。
      const crashTail = exitKind === 'crash' || exitKind === 'error' ? [...(this.workerLogTail.get(metaId) ?? [])] : []
      this.workers.delete(metaId)
      this.workerRegistry.clear(metaId)
      this.bridgeReady.delete(metaId)
      this.bridgeProtocols.delete(metaId)
      this.bridgeApiVersions.delete(metaId)
      this.bridgeCapabilities.delete(metaId)
      this.lastSeenAt.delete(metaId)
      this.workerLogTail.delete(metaId)
      this.consoles.revoke(metaId)
      this.compiledConfigs.get(metaId)?.cleanup()
      this.compiledConfigs.delete(metaId)
      // 异常退出后把持久化 phase 收敛到 paused，避免下次启动把已经崩溃的
      // worker 当作 running 自动恢复。主动 unload 保留原有 phase，仍可按旧语义恢复。
      if (exitKind === 'crash' || exitKind === 'error') {
        // Phase 2：崩溃归因——退出日志尾与剧本声明的插件名交叉匹配，命中则
        // 给出可操作的提示（未安装/加载失败的插件可在插件面板停用或安装）。
        try {
          const declared = readPluginPanel(readFileSync(ymlPath(dir), 'utf8'), () => null).entries.map(entry => entry.packageName)
          const blamed = attributePluginFailure(crashTail, declared)
          if (blamed) this.emit('log', { storyId: metaId, line: `[plugins] 疑似插件 ${blamed.packageName} 导致启动失败：${blamed.evidence}——可在配置·插件页停用（~ 前缀）或安装/修复后重载。` })
        } catch { /* 归因失败不影响退出流程 */ }
        const handle = this.get(metaId)
        if (handle) {
          try {
            this.phases.set(metaId, 'paused')
            handle.meta.phase = 'paused'
            writeStoryMeta(handle.dir, handle.meta)
            this.emit('phase-changed', { storyId: metaId, phase: 'paused' })
          } catch (error) {
            this.emit('log', { storyId: metaId, line: `[shell] worker 异常退出后写回 paused 状态失败：${error}` })
          }
        }
      }
      this.emit('console-revoked', { storyId: metaId })
      this.emit('story-exit', { storyId: metaId, exitKind, exitCode: code ?? null, signal: signal ?? undefined, recoverable: true })
      this.emit('stories-changed')
    })
    child.on('error', error => {
      this.erroredWorkers.add(metaId)
      this.emit('log', { storyId: metaId, line: `[shell] worker 进程错误：${error}` })
      // 审计 L4：spawn 失败（如 ENOENT）时 Node 不保证随后触发 exit——不等
      // exit 直接做清理，否则死 child 永久留在 workers（running 恒 true、
      // unload 挂 10s、erroredWorkers 残留误分类下次退出）。
      if (!child.pid) {
        if (this.workers.get(metaId) !== child) { this.erroredWorkers.delete(metaId); return }
        disposeWatcher()
        this.bridgeSessions.workerExited(metaId, 'error')
        this.abortPendingBridgeRequests(metaId, 'error')
        this.workers.delete(metaId)
        this.workerRegistry.clear(metaId)
        this.erroredWorkers.delete(metaId)
        this.compiledConfigs.get(metaId)?.cleanup()
        this.compiledConfigs.delete(metaId)
        this.emit('story-exit', { storyId: metaId, exitKind: 'error', exitCode: null, signal: undefined, recoverable: true })
        this.emit('stories-changed')
      }
    })
    this.emit('stories-changed')
    return this.get(metaId)
  }

  resourceStatus() {
    return { runningWorkers: this.workers.size, maxWorkers: this.maxWorkers, availableSlots: Math.max(0, this.maxWorkers - this.workers.size) }
  }

  /**
   * Ask a worker to leave first and wait for its exit handler to release the
   * compiled configuration.  A bounded forced kill prevents a stuck provider
   * connection from keeping Electron alive forever.
   */
  async unload(metaId: string) {
    const worker = this.workers.get(metaId)
    if (!worker) return this.get(metaId)
    const exited = once(worker, 'exit').then(() => undefined)
    // P0-4：标记主动停止，exit handler 据此把退出归类为 normal/killed 而非 crash。
    this.stoppingWorkers.add(metaId)
    this.killedChildren.add(worker)
    try {
      try { worker.kill('SIGTERM') } catch { /* child may have exited between lookup and kill */ }
      const graceful = await Promise.race([
        exited.then(() => true),
        new Promise<boolean>(resolve => setTimeout(() => resolve(false), 8_000)),
      ])
      if (!graceful && this.workers.get(metaId) === worker) {
        try { worker.kill('SIGKILL') } catch { /* best effort */ }
        await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 2_000))])
      }
    } finally {
      // exit handler 正常路径会消费标记；这里兜底，防止 kill 失败导致标记泄漏。
      this.stoppingWorkers.delete(metaId)
    }
    return this.get(metaId)
  }

  isBridgeReady(metaId: string) {
    const lastSeen = this.lastSeenAt.get(metaId)
    return this.workers.has(metaId) && this.bridgeReady.has(metaId) && !!lastSeen && Date.now() - lastSeen < 45_000
  }

  /** 仅在 worker 已声明 bridge 协议后允许实时入站；没有 bridge 时路由器必须入收件箱。 */
  sendDesktopCommand(metaId: string, command: 'phase' | 'inbound' | 'replay-inbox' | 'snapshot' | 'timeline-range' | 'delivery-result' | 'semantic-analysis' | 'purge-range' | 'cursor-set', value: unknown): Promise<void> {
    const worker = this.workers.get(metaId)
    if (!worker?.connected) return Promise.reject(new Error('目标 worker 未加载或 IPC 已断开。'))
    return new Promise((resolve, reject) => {
      worker.send({ type: 'hdsi-desktop', command, value }, error => error ? reject(error) : resolve())
    })
  }

  /** W3（C3-1）：宿主 → worker 的**事件**推送（非 command/request 模式）。
   *  动作代理回执经此发送；worker 侧由 event sink 的 settleAction 消费。 */
  sendToWorker(metaId: string, message: { type: string, event: string, payload: unknown }): void {
    const worker = this.workers.get(metaId)
    if (!worker?.connected) throw new Error('目标 worker 未加载或 IPC 已断开。')
    worker.send(message, error => { if (error) this.emit('log', { storyId: metaId, line: `[bridge] 事件推送失败：${error}` }) })
  }

  private async requestDesktop<T>(metaId: string, command: 'phase' | 'inbound' | 'replay-inbox' | 'snapshot' | 'timeline-range' | 'semantic-analysis' | 'purge-range' | 'cursor-set', value: Record<string, unknown>, responseEvent: string, timeoutMs: number) {
    if (!this.isBridgeReady(metaId)) throw new Error('目标 worker 尚未声明 typ-0 bridge 就绪或心跳已超时。')
    const requestId = randomUUID()
    const startedAt = Date.now()
    const protocol = this.bridgeProtocols.get(metaId)
    const traceId = value?.event && typeof value.event === 'object' && typeof (value.event as { traceId?: unknown }).traceId === 'string'
      ? (value.event as { traceId: string }).traceId : undefined
    // P4 结构化关联：每次桥请求的终态一行 key=value（requestId 为主键；inbound
    // 请求带 traceId，入站→请求→投递全链可在日志页串起）。经 'log' 事件走
    // log-broker 的 correlation 通道，不再只靠自由文本排查。
    const trace = (outcome: string, error?: unknown) => {
      const parts = [`command=${command}`, `outcome=${outcome}`, `requestId=${requestId}`, `durationMs=${Date.now() - startedAt}`]
      if (protocol !== undefined) parts.push(`protocol=${protocol}`)
      if (traceId) parts.push(`traceId=${traceId}`)
      if (error !== undefined) parts.push(`error=${String(error).slice(0, 200)}`)
      this.emit('log', {
        storyId: metaId,
        line: `[bridge] trace ${parts.join(' ')}`,
        correlation: { requestId, ...(traceId ? { traceId } : {}) },
      })
    }
    let abortInFlight: ((error: Error) => void) | undefined
    const pending = new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.off('worker-message', listener)
        trace('timeout')
        reject(new BridgeRequestTimeoutError(command, timeoutMs))
      }, timeoutMs)
      const listener = ({ storyId, message }: { storyId: string, message: any }) => {
        const payload = message?.payload
        if (storyId !== metaId || message?.event !== responseEvent || payload?.requestId !== requestId) return
        clearTimeout(timeout)
        this.off('worker-message', listener)
        if (payload?.ok === false) {
          trace('rejected', payload?.error)
          reject(new Error(String(payload.error || `HDSI ${command} 请求失败。`)))
          return
        }
        trace('ok')
        resolve(payload as T)
      }
      abortInFlight = error => {
        clearTimeout(timeout)
        this.off('worker-message', listener)
        trace('worker-exited')
        reject(error)
      }
      this.on('worker-message', listener)
    })
    // 在途登记：worker 退出时 abortPendingBridgeRequests 会立即调用并分类。
    let inFlight: Set<(error: Error) => void> | undefined
    if (abortInFlight) {
      inFlight = this.pendingBridgeRequests.get(metaId)
      if (!inFlight) { inFlight = new Set(); this.pendingBridgeRequests.set(metaId, inFlight) }
      inFlight.add(abortInFlight)
    }
    try {
      await this.sendDesktopCommand(metaId, command, { ...value, requestId })
    } catch (error) {
      trace('send-failed', error)
      if (abortInFlight && inFlight) inFlight.delete(abortInFlight)
      throw error
    }
    try {
      return await pending
    } finally {
      if (abortInFlight && inFlight) inFlight.delete(abortInFlight)
    }
  }

  /** worker 退出路径：在途请求按 exitKind 立即结算（分类信息进错误消息）。 */
  private abortPendingBridgeRequests(metaId: string, exitKind: 'normal' | 'killed' | 'crash' | 'error') {
    const inFlight = this.pendingBridgeRequests.get(metaId)
    if (!inFlight?.size) return
    const error = new BridgeRequestAbortedError(metaId, exitKind)
    for (const abort of inFlight) {
      try { abort(error) } catch { /* abort 不得因单个消费者异常中断其余结算 */ }
    }
    inFlight.clear()
  }

  /** P1：渲染层可查询的桥会话快照（协商分类/能力清单/降级明细）。 */
  bridgeSession(metaId: string) {
    return this.bridgeSessions.snapshot(metaId)
  }

  /** P1：main.ts 的 15s 定时器驱动——协商超时/心跳超时的状态翻转在此发生。 */
  sweepBridgeSessions() {
    this.bridgeSessions.sweep()
  }

  /** A real-time message is delivered only after HDSI confirms it accepted the event. */
  async deliverInbound(metaId: string, event: DesktopInboundEvent) {
    const result = await this.requestDesktop<{ accepted?: boolean, error?: string }>(metaId, 'inbound', { event }, 'inbound-result', 30_000)
    if (!result.accepted) throw new Error(result.error || 'HDSI 拒绝了入站消息。')
  }

  /** Wait for HDSI's explicit replay result before allowing the inbox to delete anything. */
  async replayInbox(metaId: string, records: Array<{ id: string, event: unknown }>) {
    if (!records.length) return [] as string[]
    const result = await this.requestDesktop<{ results?: Array<{ id?: string, accepted?: boolean }> }>(metaId, 'replay-inbox', { records }, 'replay-result', 60_000)
    return Array.isArray(result.results)
      ? result.results.filter(item => item?.accepted && typeof item.id === 'string').map(item => item.id!)
      : []
  }

  async requestTimelineSnapshot(metaId: string) {
    const result = await this.requestDesktop<{ snapshot?: unknown }>(metaId, 'snapshot', {}, 'snapshot-result', 8_000)
    return result.snapshot
  }

  hasBridgeCapability(metaId: string, capability: string) {
    return bridgeCapabilityAllowed(this.bridgeCapabilities.get(metaId), capability)
  }

  /** New bounded Arrangement projection. Snapshot remains available for an older worker bridge. */
  async requestTimelineRange(metaId: string, query: Record<string, unknown>) {
    if (!this.hasBridgeCapability(metaId, 'timeline-range')) throw new Error('当前 Worker bridge 未声明 timeline-range；将使用兼容快照。')
    const result = await this.requestDesktop<{ projection?: unknown }>(metaId, 'timeline-range', { query }, 'timeline-range-result', 10_000)
    return result.projection
  }

  /** 语义分析面板数据：必须由 Worker 明确声明 capability。 */
  async requestSemanticAnalysis(metaId: string) {
    // 审计：该 capability 任何已发布插件版本（含 rc53）都不会声明——语义分析
    // 主线未实现。错误文案不能引导用户"更新插件"，直接说明当前不支持。
    if (!this.hasBridgeCapability(metaId, 'semantic-analysis')) throw new Error('语义分析面板在当前 HDSI 插件中尚未提供（主线未实现）。')
    const result = await this.requestDesktop<{ analysis?: unknown }>(metaId, 'semantic-analysis', {}, 'semantic-analysis-result', 30_000)
    return result.analysis
  }

  /** 选区删除：由 Worker capability 声明支持；paused 门控由调用方（main.ts）负责。 */
  async requestPurgeRange(metaId: string, from: string, to: string) {
    if (!this.hasBridgeCapability(metaId, 'purge-range')) throw new Error('当前 Worker bridge 未声明 purge-range；请更新 HDSI 插件。')
    let result: { accepted?: boolean, storyId?: string }
    try {
      result = await this.requestDesktop<{ accepted?: boolean, storyId?: string }>(metaId, 'purge-range', { from, to }, 'purge-range-result', 60_000)
    } catch (error) {
      // 删除是破坏性动作：回执超时 ≠ 未删除——worker 可能已执行软删、只是
      // 确认迟到。按"结果待核实"上抛（与桥接层 ambiguous 语义同族），禁止
      // 暗示确定失败诱导盲目重试。
      if (error instanceof BridgeRequestTimeoutError) {
        throw new Error('请求已发出但 60s 内未收到确认——结果不可知（可能已删除）。请先刷新时间线核对实际删除范围；确认未删后再重试。')
      }
      throw error
    }
    if (!result.accepted) throw new Error('HDSI 未确认选区删除。')
    return result
  }

  /** 批次 4：设置叙事游标（分支截断后回拨）。 */
  async requestCursorSet(metaId: string, cursorAt: string) {
    if (!this.hasBridgeCapability(metaId, 'cursor-set')) throw new Error('当前 Worker bridge 未声明 cursor-set；请更新 HDSI 插件。')
    const result = await this.requestDesktop<{ accepted?: boolean }>(metaId, 'cursor-set', { requestId: `cursor-${Date.now()}`, cursorAt }, 'cursor-set-result', 30_000)
    if (!result.accepted) throw new Error('HDSI 拒绝了游标设置。')
  }

  /** 运行 / muted / paused 三态切换：通过 IPC 通知 worker 内的 HDSI 插件。 */
  async setPhase(metaId: string, phase: StoryPhase) {
    const handle = this.get(metaId)
    if (!handle) throw new Error(`剧本不存在：${metaId}`)
    if (this.workers.has(metaId)) {
      const result = await this.requestDesktop<{ phase?: StoryPhase, accepted?: boolean, error?: string }>(metaId, 'phase', { phase }, 'phase-result', 15_000)
      if (!result.accepted || result.phase !== phase) throw new Error(result.error || 'HDSI 未确认运行状态切换。')
    }
    this.phases.set(metaId, phase)
    handle.meta.phase = phase
    writeStoryMeta(handle.dir, handle.meta)
    this.emit('phase-changed', { storyId: metaId, phase })
    return this.get(metaId)
  }

  async settleDelivery(metaId: string, deliveryId: string, receipt: DeliveryReceipt) {
    if (!this.workers.has(metaId)) throw new Error('目标 worker 已退出，无法确认投递结果。')
    await this.sendDesktopCommand(metaId, 'delivery-result', { deliveryId, ...receipt })
  }

  private resolveKoishiWorker() {
    // koishi 包 exports 不暴露 worker 子路径，按物理路径定位（与官方 CLI 的 fork 一致）
    const require = createRequire(path.join(this.appRoot, 'package.json'))
    const mainEntry = require.resolve('koishi')
    const candidates = [
      path.resolve(path.dirname(mainEntry), 'worker/index.js'),
      path.resolve(path.dirname(mainEntry), '..', 'worker/index.js'),
    ]
    const entry = candidates.find(existsSync)
    if (!entry) throw new Error(`未找到 Koishi worker：${candidates.join('；')}`)
    return entry
  }
}





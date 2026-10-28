/**
 * 剧本生命周期域：stories:* 核心 channel（列表/创建/加载/卸载/状态切换/时间线/
 * 配置读写/收件箱回放/备份/分支/导入导出/选区删除/删除等）（P2 结构批次，自
 * main.ts 逐字迁移）。投递/用量投影（stories:deliveries / stories:usage）同属
 * stories:* 前缀，一并在此注册。
 */
import { dialog, shell } from 'electron'
import { registerHandle } from './register'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { createStoryFolder, readStoryMeta } from '../stories'
import { nextBranchId, rootIdOf } from '../runtime/branch-registry'
import { verifyStoryArchive } from '../runtime/story-archive'
import { normalizeTimelineRange, normalizeTimelineSnapshot } from '../runtime/story-repository'
import { projectAnalysisResult } from '../runtime/worker-projections'
import { FirstRunError } from '../runtime/first-run-readiness'
import type { StoryPhase } from '../runtime/contracts'
import type { IpcContext } from './context'

export function registerStoriesIpc(ctx: IpcContext) {
  const { stories, storiesRoot, dataRoot, config, secrets, inbox, receipts, projections, archives, bindings, accountRegistry, broadcast, assertStoryModelReady, rememberWorkerConfig, resolveHdsiVersion, buildStoryYml, syncExternalConnector, reconcileExternalConnector, workerConfigHashes } = ctx
  /** 审计：按故事串行化 inbox 回放——并发 peek 同一批记录会整批双发（worker 无消息 ID 去重）。 */
  const inboxReplays = new Map<string, Promise<{ consumed: number, pending: number }>>()
  registerHandle('stories:deliveries', (_event, storyId: unknown, query) => projections.deliveries(String(storyId || ''), query && typeof query === 'object' ? query : undefined))
  registerHandle('stories:usage', (_event, storyId: unknown, query) => projections.usageSeries(String(storyId || ''), query && typeof query === 'object' ? query : undefined))
  registerHandle('stories:list', () => stories.list())
  registerHandle('stories:create', (_event, payload: { id: string, name: string, characterName: string, description: string }) => {
    const dir = createStoryFolder(storiesRoot, {
      id: payload.id, name: payload.name, characterName: payload.characterName || payload.name,
      schemaVersion: 1, hdsiVersion: resolveHdsiVersion(), createdAt: new Date().toISOString(),
      description: payload.description || '', accounts: [], phase: 'paused',
    }, buildStoryYml({ id: payload.id, characterName: payload.characterName }), payload.description || '')
    const meta = readStoryMeta(dir)
    broadcast('stories:changed', stories.list())
    return meta
  })
  registerHandle('stories:replayInbox', async (_event, metaId: string) => {
    if (!stories.get(metaId)) throw new Error('剧本不存在。')
    // 审计：并发调用（双击/急切 UI）会 peek 到同一批记录并整批重复投递——
    // worker 侧无消息 ID 去重，必然双发。按故事串行化，复用在飞结果。
    const inFlight = inboxReplays.get(metaId)
    if (inFlight) return inFlight
    const attempt = (async () => {
      const records = inbox.peek(metaId)
      if (!records.length) return { consumed: 0, pending: 0 }
      inbox.markAttempt(metaId, records.map(record => record.id))
      // 审计 M6：回放窗口内占用这些消息的去重键——同一 rawMessageId 的实时
      // 重投按 duplicate 拒收（此前会与回放批次双发）；失败路径释放归还。
      const releaseHolds = ctx.router.holdForReplay(metaId, records.map(record => record.event))
      try {
        const consumedIds = await stories.replayInbox(metaId, records)
        const consumed = inbox.acknowledge(metaId, consumedIds)
        for (const record of records) if (consumedIds.includes(record.id)) receipts.accept(metaId, record.event)
        broadcast('story:inbox', { storyId: metaId, size: inbox.size(metaId), reason: 'replayed' })
        return { consumed, pending: inbox.size(metaId) }
      } catch (error) {
        inbox.markAttempt(metaId, records.map(record => record.id), String(error))
        throw error
      } finally {
        releaseHolds()
        inboxReplays.delete(metaId)
      }
    })()
    inboxReplays.set(metaId, attempt)
    return attempt
  })
  registerHandle('stories:semanticAnalysis', async (_event, metaId: string) => {
    if (!stories.get(metaId)) throw new Error('剧本不存在。')
    return projectAnalysisResult(await stories.requestSemanticAnalysis(metaId))
  })
  registerHandle('stories:timeline', async (_event, metaId: string) => {
    if (!stories.get(metaId)) throw new Error('剧本不存在。')
    // 审查T27: preload 签名带可选 limit 但此前被静默忽略——文档化为透传预留，
    // 快照本身有服务端上限，这里不做裁剪，只消除签名不匹配的误导。
    return { ...normalizeTimelineSnapshot(await stories.requestTimelineSnapshot(metaId)), desktopStoryId: metaId }
  })
  registerHandle('stories:timelineRange', async (_event, metaId: string, query) => {
    if (!stories.get(metaId)) throw new Error('剧本不存在。')
    const safeQuery = query && typeof query === 'object' ? query as Record<string, unknown> : {}
    return { ...normalizeTimelineRange(await stories.requestTimelineRange(metaId, safeQuery)), desktopStoryId: metaId }
  })
  // P1：渲染层拉取桥会话快照（协商分类/能力清单/降级明细；未加载返回 null）。
  registerHandle('stories:bridgeStatus', (_event, metaId: string) => {
    if (!stories.get(metaId)) throw new Error('剧本不存在。')
    return stories.bridgeSession(metaId) ?? null
  })
  registerHandle('stories:config', (_event, metaId: string) => {
    const handle = stories.get(metaId)
    if (!handle) throw new Error('剧本不存在。')
    return { source: config.read(handle.dir), aliases: secrets.aliases() }
  })
  registerHandle('stories:saveConfig', async (_event, metaId: string, source: string) => {
    const handle = stories.get(metaId)
    if (!handle) throw new Error('剧本不存在。')
    // 保存配置不再隐式卸载/重启 Worker。首次使用者需要一个明确的“重载 Worker”
    // 主动作；静默重载会中断正在生成的回复，也让“保存成功但到底何时生效”变得不透明。
    // config.save 仍会解析并校验 YAML，真正的运行时变更由用户在连接页确认后执行。
    const saved = config.save(handle.dir, source)
    const needsReload = Boolean(handle.running)
    broadcast('story:log', {
      storyId: metaId,
      line: needsReload
        ? '[config] 配置已保存；Worker 仍运行旧配置，等待用户确认重载。'
        : '[config] 配置已保存；Worker 当前未加载。',
    })
    return { ...saved, reloaded: false, needsReload }
  })
  registerHandle('stories:backup', async (_event, metaId: string) => {
    const handle = stories.get(metaId)
    if (!handle) throw new Error('剧本不存在。')
    // D3-1：一致性备份——worker 在跑时先卸载（SQLite 落盘且无并发写者），
    // 备份后校验可核对性，再按原 phase 自动恢复。
    const wasRunning = handle.running
    if (wasRunning) {
      broadcast('story:log', { storyId: metaId, line: '[backup] 备份前卸载 worker 以获得一致的数据库快照…' })
      await stories.unload(metaId)
    }
    // 审计 M2：恢复结果显式进返回契约（渲染层本就判读 restored 字段，此前
    // 主进程从不返回它）；恢复失败不得吞掉已成功的备份结果。
    const result: { archive: string, checks: string[], restored?: boolean, restoreError?: string } = { archive: '', checks: [] }
    try {
      const archive = archives.create(metaId, handle.dir)
      const verdict = verifyStoryArchive(archive)
      broadcast('story:log', { storyId: metaId, line: `[backup] 已创建并校验快照：${archive}（${verdict.checks.join('；')}）` })
      result.archive = archive
      result.checks = verdict.checks
    } finally {
      if (wasRunning) {
        try {
          const restored = stories.load(metaId)
          if (restored?.running) rememberWorkerConfig(metaId)
          broadcast('story:log', { storyId: metaId, line: '[backup] 备份完成，已恢复运行。' })
          result.restored = true
        } catch (error) {
          broadcast('story:log', { storyId: metaId, line: `[backup] 备份已完成，但恢复运行失败：${error}——剧本当前未加载，可手动加载。` })
          result.restored = false
          result.restoreError = String(error)
        }
      }
    }
    return result
  })
  registerHandle('stories:forkBranch', async (_event, metaId: string, payload: unknown) => {
    const handle = stories.get(String(metaId || ''))
    if (!handle) throw new Error('剧本不存在。')
    const input = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {}
    const name = String(input.name || '').trim()
    if (!name) throw new Error('分支名称不能为空。')
    const forkPoint = input.forkPoint && typeof input.forkPoint === 'object' ? input.forkPoint as { entryId?: unknown, occurredAt?: unknown } : {}
    if (!Number.isSafeInteger(Number(forkPoint.entryId)) && typeof forkPoint.occurredAt !== 'string') {
      throw new Error('forkPoint 无效：需要 entryId 或 occurredAt。')
    }
    if (handle.running) throw new Error('创建分支前需要先卸载当前剧本（避免复制到未落库的数据库状态）。')
    const rootId = rootIdOf(stories.list(), metaId)
    const slug = String(input.slug || 'branch')
    const branchId = nextBranchId(stories.list(), rootId, slug)
    const result = archives.forkBranch({
      sourceDir: handle.dir,
      storiesRoot,
      branchId,
      name,
      sourceStoryId: metaId,
      forkPoint: { entryId: Number(forkPoint.entryId) || undefined, occurredAt: typeof forkPoint.occurredAt === 'string' ? forkPoint.occurredAt : undefined },
    })
    broadcast('stories:changed', stories.list())
    broadcast('story:log', { storyId: metaId, line: `[branch] 分支已创建：${name}（${branchId}）。forkPoint: entry #${forkPoint.entryId ?? '?'} · ${forkPoint.occurredAt ?? '?'}。` })

    // 批次 4：forkPoint 之后的数据截断（在分支库内 purge + cursorAt 回拨）
    const branchForkAt = typeof forkPoint.occurredAt === 'string' ? forkPoint.occurredAt : undefined
    if (branchForkAt) {
      broadcast('story:log', { storyId: branchId, line: '[branch] 正在截断 forkPoint 之后的数据…' })
      try {
        await stories.load(branchId)
        rememberWorkerConfig(branchId)
        // 三方审查P1: interval/timer 提到 Promise 外，块级 finally 统一清理——
        // 超时 reject 路径此前不清 interval，泄漏 2Hz 轮询永不停止。
        {
          let checkReady: ReturnType<typeof setInterval> | undefined
          let timer: ReturnType<typeof setTimeout> | undefined
          try {
            await new Promise<void>((resolve, reject) => {
              timer = setTimeout(() => reject(new Error('bridge-ready 超时（30s）')), 30_000)
              checkReady = setInterval(() => {
                if (stories.get(branchId)?.bridgeReady) resolve()
              }, 500)
            })
          } finally {
            if (checkReady) clearInterval(checkReady)
            if (timer) clearTimeout(timer)
          }
        }
        const purgeFrom = new Date(new Date(branchForkAt).getTime() + 1).toISOString()
        const purgeTo = new Date(Date.now() + 365 * 24 * 3600_000).toISOString()
        await stories.requestPurgeRange(branchId, purgeFrom, purgeTo)
        await stories.requestCursorSet(branchId, branchForkAt)
        await stories.unload(branchId)
        broadcast('story:log', { storyId: branchId, line: '[branch] 截断完成：forkPoint 之后数据已清除，cursorAt 已回拨。分支 paused 就绪。' })
      } catch (error) {
        broadcast('story:log', { storyId: branchId, line: `[branch] 截断失败（分支仍可用但可能含 forkPoint 后数据）：${error}` })
        try { await stories.unload(branchId) } catch { /* best effort */ }
      }
    }

    broadcast('stories:changed', stories.list())
    return result
  })
  registerHandle('stories:export', async (_event, metaId: string) => {
    const handle = stories.get(metaId)
    if (!handle) throw new Error('剧本不存在。')
    const chosen = await dialog.showOpenDialog({ title: '选择导出位置', properties: ['openDirectory', 'createDirectory'] })
    if (chosen.canceled || !chosen.filePaths[0]) return { canceled: true }
    return { canceled: false, path: archives.export(metaId, handle.dir, chosen.filePaths[0]) }
  })
  registerHandle('stories:import', async (_event, targetId: string, name?: string) => {
    const chosen = await dialog.showOpenDialog({ title: '选择要导入的 typ-0 剧本文件夹', properties: ['openDirectory'] })
    if (chosen.canceled || !chosen.filePaths[0]) return { canceled: true }
    const result = archives.import(chosen.filePaths[0], storiesRoot, targetId, name)
    broadcast('stories:changed', stories.list())
    return { canceled: false, ...result }
  })
  registerHandle('stories:purgeRange', async (_event, metaId: string, from: unknown, to: unknown) => {
    const handle = stories.get(String(metaId || ''))
    if (!handle) throw new Error('剧本不存在。')
    if (handle.meta.phase !== 'paused') throw new Error('选区删除仅在剧本暂停（paused）时可用——请先暂停剧本。')
    if (typeof from !== 'string' || typeof to !== 'string' || Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to))) {
      throw new Error('时间范围无效。')
    }
    if (new Date(from) > new Date(to)) throw new Error('时间范围起止颠倒。')
    const confirmed = await dialog.showMessageBox({
      type: 'warning',
      title: '确认选区删除',
      message: '即将删除该时间区间内的剧本、记忆、事实与意图',
      detail: '范围：' + from + ' → ' + to + '\n\n该操作把区间内容标记为已删除（软删），角色身份（Canon）保留。此操作不可撤销。',
      buttons: ['取消', '确认删除'],
      defaultId: 0,
      cancelId: 0,
    })
    if (confirmed.response !== 1) return { canceled: true }
    const result = await stories.requestPurgeRange(metaId, from, to)
    broadcast('story:log', { storyId: metaId, line: '[purge] 选区删除完成：' + from + ' → ' + to })
    return { canceled: false, storyId: result.storyId }
  })
  registerHandle('stories:delete', async (_event, metaId: string) => {
    const handle = stories.get(metaId)
    if (!handle) throw new Error('剧本不存在。')
    // 审查T23: worker 在跑时先卸载再备份——SQLite 并发写者存在时拷贝可能撕裂
    // （与 stories:backup 的 D3-1 要求一致）；账号登记同步清理，否则 QQ 号被
    // 幽灵登记永久锁死（accounts:unbind 对已删剧本直接抛错，用户无解除路径）。
    if (handle.running) await stories.unload(metaId)
    // 审计 L8：删除前收集该剧本独占的密钥别名（账号 token 别名 + canonical
    // 里的 $secret: 引用），剧本删除后回收——其它剧本仍引用的保留。
    const doomedAliases = new Set<string>()
    for (const entry of accountRegistry.listByStory(metaId)) {
      if (entry.externalUpstream?.tokenAlias) doomedAliases.add(entry.externalUpstream.tokenAlias)
    }
    try {
      for (const match of config.read(handle.dir).matchAll(/\$secret:([A-Za-z0-9][A-Za-z0-9_.-]{0,127})/g)) doomedAliases.add(match[1])
    } catch { /* canonical 读失败只回收账号 token 别名 */ }
    const backup = archives.create(metaId, handle.dir)
    const trash = archives.trash(metaId, handle.dir)
    // 审计 H3：内存缓存随剧本一并遗忘——同 ID 重建时旧去重 key/投递记录/
    // 运行相位残留会把新剧本的消息误判重复、显示幽灵历史与旧相位。
    stories.forgetRuntimeState(metaId)
    receipts.invalidate(metaId)
    ctx.outbox.invalidate(metaId)
    workerConfigHashes.delete(metaId)
    // 其它剧本（canonical $secret: 引用 + 账号 token 别名）仍使用的别名不清除
    for (const other of stories.list()) {
      if (other.meta.id === metaId) continue
      try {
        for (const match of config.read(other.dir).matchAll(/\$secret:([A-Za-z0-9][A-Za-z0-9_.-]{0,127})/g)) doomedAliases.delete(match[1])
      } catch { /* 忽略不可读配置 */ }
      for (const entry of accountRegistry.listByStory(other.meta.id)) {
        if (entry.externalUpstream?.tokenAlias) doomedAliases.delete(entry.externalUpstream.tokenAlias)
      }
    }
    for (const alias of doomedAliases) {
      try { secrets.remove(alias) } catch { /* 别名可能已不存在 */ }
    }
    const removedBindings = bindings.unbindStory(metaId)
    accountRegistry.removeByStory(metaId)
    // 审计修复：同步回收该剧本的外部上游连接器——否则已删剧本的 WS 连接
    // 持续收消息（进 unassigned-inbox）并占用状态映射直到退出。
    await reconcileExternalConnector(metaId)
    broadcast('stories:changed', stories.list())
    return { backup, trash, removedBindings: removedBindings.length }
  })
  registerHandle('stories:openBackupFolder', async (_event, metaId: string) => {
    // 审计 M5：全部 stories:* 兄弟 handler 都经 stories.get() 做身份校验
    // （防路径拼接逃逸），此处不得例外——metaId 直接进 path.join 会把
    // `../..` 送到 shell.openPath 打开任意目录。
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(String(metaId || ''))) throw new Error('非法剧本 ID。')
    const folder = path.join(dataRoot, 'backups', metaId)
    if (!existsSync(folder)) throw new Error('当前剧本尚未创建备份。')
    await shell.openPath(folder)
    return folder
  })
  registerHandle('stories:load', (_event, metaId: string) => {
    try {
      assertStoryModelReady(metaId)
      // load() 对运行中的 worker 是幂等 no-op（直接返回既有 handle）——此时
      // 不能 rememberWorkerConfig：那会把"当前文件哈希"记成"worker 实际加载的
      // 哈希"，needsReload 被静默清掉而 worker 仍跑旧配置（就绪检查说谎）。
      // 只有真正新起的 worker 才记录指纹。
      const wasRunning = Boolean(stories.get(metaId)?.running)
      const handle = stories.load(metaId)
      if (handle?.running && !wasRunning) rememberWorkerConfig(metaId)
      if (handle) {
        syncExternalConnector(metaId)
      }
      return handle
    } catch (error) {
      const code = error instanceof FirstRunError ? ` [${error.code}]` : ''
      const message = `[shell] 加载失败${code} ${error}`
      broadcast('story:log', { storyId: metaId, line: message })
      throw new Error(message)
    }
  })
  registerHandle('stories:unload', async (_event, metaId: string) => {
    // Keep a configured real channel connected: router will persist incoming
    // messages into Inbox while the worker is unavailable.
    return stories.unload(metaId)
  })
  registerHandle('stories:phase', (_event, metaId: string, phase: StoryPhase) => {
    if (!['running', 'muted', 'paused'].includes(phase)) throw new Error('无效剧本状态。')
    return stories.setPhase(metaId, phase)
  })
}

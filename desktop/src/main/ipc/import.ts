import { dialog } from 'electron'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { createStoryFolder } from '../stories'
import { analyzeKoishiYml, executeImport, type ImportModules } from '../runtime/config-importer'
import { registerHandle } from './register'
import type { IpcContext } from './context'

/**
 * 配置导入域：importer:pickAnalyze / importer:execute。
 * 会话模型：pickAnalyze 把含明文密钥的解析结果留在主进程（单槽、10 分钟
 * 过期），渲染层只拿脱敏 analysis；execute 按会话执行，绝不二次读盘。
 */
const MAX_SOURCE_BYTES = 1_000_000
const SESSION_TTL_MS = 10 * 60 * 1000
type ImportSession = { id: string, at: number, parsed: Extract<ReturnType<typeof analyzeKoishiYml>, { ok: true }> }
let session: ImportSession | null = null

export function registerImporterIpc(ctx: IpcContext) {
  const { getWindow, storiesRoot, stories, config, secrets, accountRegistry, bindings, broadcast, buildStoryYml, resolveHdsiVersion, syncExternalConnector } = ctx

  registerHandle('importer:pickAnalyze', async () => {
    const options = {
      title: '选择插件版 HDS-Interlude 的 koishi.yml',
      properties: ['openFile'] as Array<'openFile'>,
      filters: [{ name: 'Koishi 配置', extensions: ['yml', 'yaml'] }],
    }
    const owner = getWindow()
    const picked = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options)
    if (picked.canceled || !picked.filePaths[0]) return { cancelled: true }
    const text = readFileSync(picked.filePaths[0], 'utf8')
    if (text.length > MAX_SOURCE_BYTES) throw new Error('koishi.yml 超过 1MB，拒绝读取。')
    const analyzed = analyzeKoishiYml(text)
    if (!analyzed.ok) throw new Error(analyzed.error)
    analyzed.analysis.file = path.basename(picked.filePaths[0])
    analyzed.source.file = analyzed.analysis.file
    session = { id: randomUUID(), at: Date.now(), parsed: analyzed }
    return { sessionId: session.id, analysis: analyzed.analysis }
  })

  registerHandle('importer:execute', async (_event, sessionId: unknown, options: unknown) => {
    if (!session || session.id !== String(sessionId || '')) throw new Error('导入会话已过期，请重新选择文件。')
    if (Date.now() - session.at > SESSION_TTL_MS) { session = null; throw new Error('导入会话已过期（超过 10 分钟），请重新选择文件。') }
    const request = (options && typeof options === 'object' ? options : {}) as { modules?: Partial<ImportModules>, storyName?: unknown }
    const modules: ImportModules = {
      persona: request.modules?.persona !== false,
      relations: request.modules?.relations !== false,
      accounts: request.modules?.accounts !== false,
      model: request.modules?.model !== false,
      behavior: request.modules?.behavior !== false,
      // 主提示词独立可选块：默认不动（保持 typ0 默认提示词）。
      mainPrompt: request.modules?.mainPrompt === true,
      misc: request.modules?.misc !== false,
    }
    const storyName = typeof request.storyName === 'string' ? request.storyName.trim().slice(0, 64) : ''
    const result = await executeImport({
      storiesRoot,
      createStory: payload => {
        const dir = createStoryFolder(storiesRoot, {
          id: payload.id, name: payload.name, characterName: payload.characterName || payload.name,
          schemaVersion: 1, hdsiVersion: resolveHdsiVersion(), createdAt: new Date().toISOString(),
          description: payload.description || '', accounts: [], phase: 'paused',
        }, buildStoryYml({ id: payload.id, characterName: payload.characterName }), payload.description || '')
        return { dir }
      },
      config,
      secrets,
      accountRegistry,
      bindings,
      syncExternalConnector,
      broadcastStoriesChanged: () => broadcast('stories:changed', stories.list()),
      isStoryRunning: id => Boolean(stories.get(id)?.running),
      unloadStory: async id => { await stories.unload(id) },
    }, session.parsed.source, { modules, ...(storyName ? { storyName } : {}) })
    session = null
    broadcast('story:log', { storyId: result.storyId, line: `[import] 已从插件版配置创建剧本「${result.storyName}」并导入所选模块。` })
    return result
  })
}

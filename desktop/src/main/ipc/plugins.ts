import { registerHandle } from './register'
/**
 * 插件域：plugins:*（安装/更新/卸载/市场）+ stories:plugin*（面板增删改）+
 * stories:configSection（结构化配置节读写）——配置节与插件面板共享 mediator
 * 写路径（saveCanonical/config.save），故同域（P2 结构批次，自 main.ts 逐字迁移）。
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import yaml from 'js-yaml'
import { appendPlugin, createInstallProbe, readPluginPanel, removePlugin, togglePlugin, writePluginConfig } from '../runtime/plugin-panel'
import { surgicalPluginUpdate } from '../runtime/config-surgery'
import { marketDetail, readHostKoishiVersion, searchMarket } from '../runtime/plugin-market'
import type { IpcContext } from './context'

export function registerPluginsIpc(ctx: IpcContext) {
  const { stories, config, broadcast, pluginInstaller, appRoot, dataRoot } = ctx
  // 配置分节读写：结构化局部写入（不碰 $secret 段，走 ConfigMediator 自动备份）
  const CONFIG_SECTIONS: Record<string, { read: (h: any) => unknown, write: (h: any, v: unknown) => void }> = {
    storyDefaults: {
      read: h => h?.storyDefaults ?? {},
      // 审查T22: 对象节合并写——UI 字段集外的键（perspectives/supplementaryFacts 等）
      // 不能在保存时被整段替换丢掉。数组节保持整段写（列表语义）。
      write: (h, v) => { h.storyDefaults = { ...(h?.storyDefaults ?? {}), ...(v && typeof v === 'object' ? v : {}) } },
    },
    userAccounts: {
      read: h => h?.onebot?.userAccounts ?? [],
      write: (h, v) => { ((h.onebot ??= {})).userAccounts = Array.isArray(v) ? v : [] },
    },
    groupChats: {
      read: h => h?.onebot?.groupChats ?? [],
      write: (h, v) => { ((h.onebot ??= {})).groupChats = Array.isArray(v) ? v : [] },
    },
    botAccounts: {
      read: h => h?.onebot?.botAccounts ?? [],
      write: (h, v) => { ((h.onebot ??= {})).botAccounts = Array.isArray(v) ? v : [] },
    },
    providers: {
      read: h => h?.model?.providers ?? [],
      write: (h, v) => { ((h.model ??= {})).providers = Array.isArray(v) ? v : [] },
    },
  }
  // ── 第三方 Koishi 插件面板（Phase 1）：读清单 / ~前缀启停 / 配置片段 / 增删。
  // 全部经 mediator 写 canonical（自动备份 + $secret/敏感键校验），并回报
  // needsReload（与 configSection 同一语义：Worker 在跑时提示重载）。
  // Phase 2：探测顺序 desktop/node_modules → plugins-runtime/node_modules；
  // 安装/卸载后由 IPC 处理器失效缓存。
  const pluginProbe = createInstallProbe(appRoot, path.join(dataRoot, 'plugins-runtime'))
  const refreshInstallState = () => { pluginProbe.invalidate?.() }
  const runInstaller = async (action: 'install' | 'update' | 'uninstall', packageName: unknown) => {
    if (!pluginInstaller) throw new Error('插件运行时未初始化。')
    const name = String(packageName || '').trim()
    broadcast('story:log', { line: `[plugins] ${action === 'uninstall' ? '卸载' : action === 'update' ? '更新' : '安装'} ${name}……（来源 registry.npmmirror.com；--ignore-scripts，不执行第三方安装脚本）` })
    try {
      const result = action === 'uninstall' ? await pluginInstaller.uninstall(name)
        : action === 'update' ? await pluginInstaller.update(name)
          : await pluginInstaller.install(name)
      refreshInstallState()
      broadcast('story:log', { line: `[plugins] ${name} ${action === 'uninstall' ? '已卸载' : `完成（v${result.version ?? '?'}）`}。` })
      return { package: result.package, version: result.version }
    } catch (error) {
      broadcast('story:log', { line: `[plugins] ${name} ${action === 'uninstall' ? '卸载' : action}失败：${error}` })
      throw error
    }
  }
  registerHandle('plugins:install', (_event, packageName: unknown) => runInstaller('install', packageName))
  registerHandle('plugins:update', (_event, packageName: unknown) => runInstaller('update', packageName))
  registerHandle('plugins:uninstall', (_event, packageName: unknown) => runInstaller('uninstall', packageName))
  // Phase 3：市场浏览（npmmirror search + 单包 peer 兼容性）。仅浏览；安装走受控安装器。
  registerHandle('plugins:marketSearch', async (_event, query: unknown) => {
    try { return { entries: await searchMarket(String(query ?? '')) } }
    catch (error) { throw new Error(`市场搜索失败（检查网络）：${error instanceof Error ? error.message : String(error)}`) }
  })
  registerHandle('plugins:marketDetail', async (_event, packageName: unknown) => {
    try { return await marketDetail(String(packageName ?? ''), readHostKoishiVersion(appRoot)) }
    catch (error) { throw new Error(`获取插件详情失败：${error instanceof Error ? error.message : String(error)}`) }
  })
  const saveCanonical = (metaId: string, next: string, note: string) => {
    const handle = stories.get(metaId)
    if (!handle) throw new Error('剧本不存在。')
    const parsed = yaml.load(next)
    if (!parsed || typeof parsed !== 'object') throw new Error('编辑后的 koishi.yml 不是有效的 YAML 对象。')
    config.save(handle.dir, next)
    const needsReload = Boolean(handle.running)
    broadcast('story:log', { storyId: metaId, line: `[plugins] ${note}（canonical 已备份；${needsReload ? 'Worker 仍运行旧配置，确认重载后生效' : 'Worker 当前未加载'}）。` })
    return { needsReload }
  }
  registerHandle('stories:plugins', (_event, metaId: string) => {
    const handle = stories.get(String(metaId || ''))
    if (!handle) throw new Error('剧本不存在。')
    return readPluginPanel(config.read(handle.dir), pluginProbe)
  })
  // 审计批#5：group 参数区分不同分组下的同名实例键（块级定位见 plugin-panel.ts）
  const groupArg = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim().slice(0, 64) : null
  registerHandle('stories:pluginToggle', (_event, metaId: string, rawKey: unknown, enable: unknown, group: unknown) => {
    const handle = stories.get(String(metaId || ''))
    if (!handle) throw new Error('剧本不存在。')
    const groupLabel = groupArg(group)
    const next = togglePlugin(config.read(handle.dir), String(rawKey || ''), enable === true, groupLabel)
    return saveCanonical(String(metaId), next, `${enable === true ? '启用' : '停用'}插件 ${String(rawKey)}${groupLabel ? `（分组 ${groupLabel}）` : ''}`)
  })
  registerHandle('stories:pluginConfig', (_event, metaId: string, rawKey: unknown, fragment: unknown, group: unknown) => {
    const handle = stories.get(String(metaId || ''))
    if (!handle) throw new Error('剧本不存在。')
    if (typeof fragment !== 'string') throw new Error('配置片段必须是字符串。')
    const groupLabel = groupArg(group)
    const next = writePluginConfig(config.read(handle.dir), String(rawKey || ''), fragment, groupLabel)
    return saveCanonical(String(metaId), next, `更新插件配置 ${String(rawKey)}${groupLabel ? `（分组 ${groupLabel}）` : ''}`)
  })
  registerHandle('stories:pluginAdd', (_event, metaId: string, packageName: unknown) => {
    const handle = stories.get(String(metaId || ''))
    if (!handle) throw new Error('剧本不存在。')
    const name = String(packageName || '').trim()
    const next = appendPlugin(config.read(handle.dir), name)
    return saveCanonical(String(metaId), next, `添加插件 ${name}（默认启用）`)
  })
  registerHandle('stories:pluginRemove', (_event, metaId: string, rawKey: unknown, group: unknown) => {
    const handle = stories.get(String(metaId || ''))
    if (!handle) throw new Error('剧本不存在。')
    const groupLabel = groupArg(group)
    const next = removePlugin(config.read(handle.dir), String(rawKey || ''), groupLabel)
    return saveCanonical(String(metaId), next, `移除插件 ${String(rawKey)}${groupLabel ? `（分组 ${groupLabel}）` : ''}`)
  })
  registerHandle('stories:configSection', (_event, metaId: string, section: string, data?: unknown) => {
    const handle = stories.get(String(metaId || ''))
    if (!handle) throw new Error('剧本不存在。')
    const def = CONFIG_SECTIONS[section]
    if (!def) throw new Error(`未知配置节：${section}。`)
    const file = path.join(handle.dir, 'koishi.yml')
    const source = readFileSync(file, 'utf8')
    const doc = yaml.load(source) as any
    if (!doc?.plugins) throw new Error('剧本配置缺少 plugins 段。')
    const hdsiKey = Object.keys(doc.plugins).find(key => /^hds-interlude:/.test(key)) ?? 'hds-interlude:m0'
    const before = (doc.plugins[hdsiKey] && typeof doc.plugins[hdsiKey] === 'object') ? JSON.parse(JSON.stringify(doc.plugins[hdsiKey])) : {}
    const hdsi = JSON.parse(JSON.stringify(before))
    // 读模式
    if (data === undefined) return def.read(hdsi)
    // 写模式。P2 输入边界：yaml.dump 之前的尺寸门——渲染层 bug 传超大对象时
    // 在序列化放大前拦截（mediator 的 1MB 检查作用在 dump 后的字符串上）。
    try {
      if (JSON.stringify(data)?.length > 1_000_000) throw new Error('配置节数据超过 1MB 上限，拒绝写入。')
    } catch (error) {
      if (error instanceof TypeError) throw new Error('配置节数据包含无法序列化的内容（如循环引用）。')
      throw error
    }
    def.write(hdsi, data)
    // 审计 M4：同 mixer——键行级手术，不再整档 dump 丢注释。
    config.save(handle.dir, surgicalPluginUpdate(source, hdsiKey, before, hdsi))
    const needsReload = Boolean(handle.running)
    broadcast('story:log', { storyId: metaId, line: `[config] 已写入配置节 ${section}（canonical 已备份；${needsReload ? 'Worker 仍运行旧配置，等待用户确认重载' : 'Worker 当前未加载'}）。` })
    return { section, written: true, needsReload }
  })
}

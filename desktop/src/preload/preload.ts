import { contextBridge, ipcRenderer } from 'electron'

type StoryPhase = 'running' | 'muted' | 'paused'
type StoryCreateInput = { id: string, name: string, characterName: string, description: string }
type OneBotChannelKind = 'qq' | 'wechat' | 'other'
type OneBotUpstreamInput = { endpoint: string, tokenAlias?: string, tokenText?: string, useLocalToken?: boolean, reuseSavedToken?: boolean }

contextBridge.exposeInMainWorld('hdsiDesktop', {
  packs: {
    appVersion: () => ipcRenderer.invoke('themePacks:appVersion'),
    pickRead: () => ipcRenderer.invoke('themePacks:pickRead'),
    listInstalled: () => ipcRenderer.invoke('themePacks:listInstalled'),
    install: (id: string, entries: Record<string, string>) => ipcRenderer.invoke('themePacks:install', id, entries),
    write: (name: string, entries: Record<string, string>) => ipcRenderer.invoke('themePacks:write', name, entries),
    uninstall: (id: string) => ipcRenderer.invoke('themePacks:uninstall', id),
  },
  stories: {
    list: () => ipcRenderer.invoke('stories:list'),
    create: (input: StoryCreateInput) => ipcRenderer.invoke('stories:create', input),
    load: (id: string) => ipcRenderer.invoke('stories:load', id),
    unload: (id: string) => ipcRenderer.invoke('stories:unload', id),
    setPhase: (id: string, phase: StoryPhase) => ipcRenderer.invoke('stories:phase', id, phase),
    replayInbox: (id: string) => ipcRenderer.invoke('stories:replayInbox', id),
    timeline: (id: string, limit?: number) => ipcRenderer.invoke('stories:timeline', id, limit),
    semanticAnalysis: (id: string) => ipcRenderer.invoke('stories:semanticAnalysis', id),
    timelineRange: (id: string, query: unknown = {}) => ipcRenderer.invoke('stories:timelineRange', id, query),
    config: (id: string) => ipcRenderer.invoke('stories:config', id),
    saveConfig: (id: string, source: string) => ipcRenderer.invoke('stories:saveConfig', id, source),
    backup: (id: string) => ipcRenderer.invoke('stories:backup', id),
    export: (id: string) => ipcRenderer.invoke('stories:export', id),
    import: (targetId: string, name?: string) => ipcRenderer.invoke('stories:import', targetId, name),
    delete: (id: string) => ipcRenderer.invoke('stories:delete', id),
    purgeRange: (id: string, from: string, to: string) => ipcRenderer.invoke('stories:purgeRange', id, from, to),
    forkBranch: (id: string, payload: { name: string, slug?: string, forkPoint: { entryId?: number, occurredAt?: string } }) => ipcRenderer.invoke('stories:forkBranch', id, payload),
    mixerRead: (id: string) => ipcRenderer.invoke('stories:mixerRead', id),
    bridgeStatus: (id: string) => ipcRenderer.invoke('stories:bridgeStatus', id),
    configSection: (id: string, section: string, data?: unknown) => ipcRenderer.invoke('stories:configSection', id, section, data),
    plugins: (id: string) => ipcRenderer.invoke('stories:plugins', id),
    pluginToggle: (id: string, rawKey: string, enable: boolean, group?: string | null) => ipcRenderer.invoke('stories:pluginToggle', id, rawKey, enable, group ?? null),
    pluginConfig: (id: string, rawKey: string, fragment: string, group?: string | null) => ipcRenderer.invoke('stories:pluginConfig', id, rawKey, fragment, group ?? null),
    pluginAdd: (id: string, packageName: string) => ipcRenderer.invoke('stories:pluginAdd', id, packageName),
    pluginRemove: (id: string, rawKey: string, group?: string | null) => ipcRenderer.invoke('stories:pluginRemove', id, rawKey, group ?? null),
    pluginInstall: (packageName: string) => ipcRenderer.invoke('plugins:install', packageName),
    pluginUpdate: (packageName: string) => ipcRenderer.invoke('plugins:update', packageName),
    pluginUninstall: (packageName: string) => ipcRenderer.invoke('plugins:uninstall', packageName),
    pluginMarketSearch: (query: string) => ipcRenderer.invoke('plugins:marketSearch', query),
    pluginMarketDetail: (packageName: string) => ipcRenderer.invoke('plugins:marketDetail', packageName),
    mixerWrite: (id: string, patch: Record<string, number>) => ipcRenderer.invoke('stories:mixerWrite', id, patch),
    openBackupFolder: (id: string) => ipcRenderer.invoke('stories:openBackupFolder', id),
    deliveries: (id: string, query: unknown = {}) => ipcRenderer.invoke('stories:deliveries', id, query),
    usage: (id: string, query: unknown = {}) => ipcRenderer.invoke('stories:usage', id, query),
  },
  secrets: {
    set: (alias: string, value: string) => ipcRenderer.invoke('secrets:set', alias, value),
  },
  importer: {
    pickAnalyze: () => ipcRenderer.invoke('importer:pickAnalyze'),
    execute: (sessionId: string, options: unknown) => ipcRenderer.invoke('importer:execute', sessionId, options),
  },
  runtime: { resources: () => ipcRenderer.invoke('runtime:resources'), overview: (storyId: string) => ipcRenderer.invoke('runtime:overview', storyId) },
  connection: {
    detect: () => ipcRenderer.invoke('connection:detect'),
    firstRunReadiness: (storyId: string) => ipcRenderer.invoke('connection:firstRunReadiness', storyId),
    probeUpstream: (endpoint: string, token?: string, options?: { storyId?: string; selfId?: string; useLocalToken?: boolean; reuseSavedToken?: boolean }) => ipcRenderer.invoke('connection:probe-upstream', endpoint, token, options),
  },
  accounts: {
    list: () => ipcRenderer.invoke('accounts:list'),
    bind: (storyId: string, selfId: string, nickname: string, upstream?: OneBotUpstreamInput, channelKind?: OneBotChannelKind) => ipcRenderer.invoke('accounts:bind', storyId, selfId, nickname, upstream, channelKind),
    unbind: (storyId: string, selfId?: string) => ipcRenderer.invoke('accounts:unbind', storyId, selfId),
    status: (storyId: string) => ipcRenderer.invoke('accounts:status', storyId),
  },
  console: {
    info: (storyId: string) => ipcRenderer.invoke('console:info', storyId),
    attach: (storyId: string, bounds: { x: number, y: number, width: number, height: number }) => ipcRenderer.invoke('console:attach', storyId, bounds),
    detach: (storyId: string) => ipcRenderer.invoke('console:detach', storyId),
    resize: (storyId: string, bounds: { x: number, y: number, width: number, height: number }) => ipcRenderer.invoke('console:resize', storyId, bounds),
  },
  logs: {
    query: (query: unknown = {}) => ipcRenderer.invoke('logs:query', query),
    export: (options: unknown = {}) => ipcRenderer.invoke('logs:export', options),
    setBlind: (enabled: boolean) => ipcRenderer.invoke('logs:setBlind', enabled),
  },
  onStoriesChanged: (callback: (stories: unknown) => void) => {
    const wrapped = (_event: unknown, stories: unknown) => callback(stories)
    ipcRenderer.on('stories:changed', wrapped)
    return () => ipcRenderer.removeListener('stories:changed', wrapped)
  },
  onStoryPhase: (callback: (change: unknown) => void) => {
    const wrapped = (_event: unknown, change: unknown) => callback(change)
    ipcRenderer.on('story:phase', wrapped)
    return () => ipcRenderer.removeListener('story:phase', wrapped)
  },
  onStoryExit: (callback: (detail: { storyId: string, exitKind: string, exitCode: number | null, signal?: string }) => void) => {
    const wrapped = (_event: unknown, detail: { storyId: string, exitKind: string, exitCode: number | null, signal?: string }) => callback(detail)
    ipcRenderer.on('story:exit', wrapped)
    return () => ipcRenderer.removeListener('story:exit', wrapped)
  },
  onRouterUnassigned: (callback: (event: unknown) => void) => {
    const wrapped = (_event: unknown, event: unknown) => callback(event)
    ipcRenderer.on('router:unassigned', wrapped)
    return () => ipcRenderer.removeListener('router:unassigned', wrapped)
  },
  onLogRecord: (callback: (record: unknown) => void) => {
    const wrapped = (_event: unknown, record: unknown) => callback(record)
    ipcRenderer.on('logs:record', wrapped)
    return () => ipcRenderer.removeListener('logs:record', wrapped)
  },
  onLogBlind: (callback: (enabled: unknown) => void) => {
    const wrapped = (_event: unknown, enabled: unknown) => callback(enabled)
    ipcRenderer.on('logs:blind', wrapped)
    return () => ipcRenderer.removeListener('logs:blind', wrapped)
  },
  onStoryInbox: (callback: (event: unknown) => void) => {
    const wrapped = (_event: unknown, event: unknown) => callback(event)
    ipcRenderer.on('story:inbox', wrapped)
    return () => ipcRenderer.removeListener('story:inbox', wrapped)
  },
  onStoryDelivery: (callback: (event: unknown) => void) => {
    const wrapped = (_event: unknown, event: unknown) => callback(event)
    ipcRenderer.on('story:delivery', wrapped)
    return () => ipcRenderer.removeListener('story:delivery', wrapped)
  },
  onStoryToken: (callback: (event: unknown) => void) => {
    const wrapped = (_event: unknown, event: unknown) => callback(event)
    ipcRenderer.on('story:token', wrapped)
    return () => ipcRenderer.removeListener('story:token', wrapped)
  },
  onAccountConnection: (callback: (event: unknown) => void) => {
    const wrapped = (_event: unknown, status: unknown) => callback(status)
    ipcRenderer.on('accounts:connection', wrapped)
    return () => ipcRenderer.removeListener('accounts:connection', wrapped)
  },
  onStoryRuntime: (callback: (event: unknown) => void) => {
    const wrapped = (_event: unknown, event: unknown) => callback(event)
    ipcRenderer.on('story:runtime', wrapped)
    return () => ipcRenderer.removeListener('story:runtime', wrapped)
  },
  onStoryBridge: (callback: (snapshot: unknown) => void) => {
    const wrapped = (_event: unknown, snapshot: unknown) => callback(snapshot)
    ipcRenderer.on('story:bridge', wrapped)
    return () => ipcRenderer.removeListener('story:bridge', wrapped)
  },
  onConsoleReady: (callback: (event: unknown) => void) => {
    const wrapped = (_event: unknown, event: unknown) => callback(event)
    ipcRenderer.on('console:ready', wrapped)
    return () => ipcRenderer.removeListener('console:ready', wrapped)
  },
  onConsoleRevoked: (callback: (event: unknown) => void) => {
    const wrapped = (_event: unknown, event: unknown) => callback(event)
    ipcRenderer.on('console:revoked', wrapped)
    return () => ipcRenderer.removeListener('console:revoked', wrapped)
  },
})


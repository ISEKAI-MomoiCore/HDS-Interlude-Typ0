// Browser preload fixture only: no real workers, accounts, config or databases.
module.exports = function installStudioFixture() {
  const now = Date.now()
  const story = { meta: { id: 'fixture', name: 'UI fixture', characterName: '角色', phase: 'running' }, running: true, bridgeReady: true }
  const entries = [0, 1, 2].map(id => ({ id: id + 1, entityId: 'entry:' + (id + 1), kind: 'script', actor: 'narrator', track: 'script', content: '用于阅读与轨道布局验证的原始剧本。'.repeat(80), occurredAt: new Date(now - (3 - id) * 600000).toISOString(), metadata: { channel: { channelKind: id === 1 ? 'wechat' : 'qq', conversationKind: id === 1 ? 'group' : 'private', selfId: id === 1 ? 'wx-fixture' : 'qq-fixture' } } }))
  // Include both message directions; default range projection omits metadata in RC57.
  entries.forEach((entry, index) => { entry.startedAt = entry.occurredAt = new Date(now - (3 - index) * 2 * 3600000).toISOString() })
  entries.push(...[0, 1, 2, 3].map(index => ({ id: 100 + index, entityId: 'entry:' + (100 + index), kind: index % 2 ? 'character-message' : 'user-message', track: 'messages', actor: index % 2 ? 'character' : 'user', content: index % 2 ? '好，等雨停了一起回去。' : '那把黑伞还在你那里吗？', occurredAt: new Date(now - (4 - index) * 90 * 60000).toISOString() })))
  globalThis.fixtureChannels = false
  const scenes = [{ id: 4, status: 'active', startedAt: new Date(now - 3600000).toISOString(), hook: '雨声把两个窗口叠在了一起', summary: '角色在私聊与群聊之间延续同一段日常。', entryCount: 8 }]
  const facts = [{ id: 12, scope: '关系细节', content: '她记得那把还没有归还的黑伞。', importance: 0.82, confidence: 0.94, unresolved: false, updatedAt: new Date(now - 1800000).toISOString() }]
  facts.push(...Array.from({ length: 5 }, (_, index) => ({ id: 20 + index, scope: '日常记忆', content: '连续性事实 ' + (index + 1), importance: 0.6, confidence: 0.9, unresolved: false, updatedAt: new Date(now - (index + 2) * 3600000).toISOString() })))
  const preplan = { revision: 3, timezone: 'Asia/Shanghai', validFrom: new Date(now + 3600000).toISOString(), validThrough: new Date(now + 86400000).toISOString() }
  const deliveries = [{ deliveryId: 'delivery-fixture', state: 'retryable-failed', updatedAt: new Date(now - 60000).toISOString(), createdAt: new Date(now - 120000).toISOString(), platform: 'qq', selfId: 'qq-fixture', kind: 'private', lastError: '测试投递失败记录' }]
  const overview = { inbox: { pending: 2 }, outbox: { states: { generated: 1, sending: 0, sent: 0, accepted: 0, confirmed: 2, unknown: 0, 'retryable-failed': 1, 'permanent-failed': 0 } }, worker: { bridgeProtocol: 4, runtimeCore: { version: 'rc57' } }, usage: { day: '2026-10-17', calls: 9, inputTokens: 3000, outputTokens: 1000 }, recentErrors: [{ id: 'host-error-fixture', at: new Date(now - 30000).toISOString(), source: 'fixture', message: '测试宿主错误记录' }] }
  globalThis.fixtureHostChange = () => { overview.outbox.states.generated = 7; overview.outbox.states.unknown = 1; overview.outbox.states['retryable-failed'] = 0; deliveries[0].state = 'unknown'; deliveries[0].lastError = '测试投递结果未知'; deliveries[0].updatedAt = new Date().toISOString() }
  let revision = 1
  globalThis.fixtureRevision = () => revision++
  globalThis.fixtureWrites = []
  const api = {
    stories: { list: async () => [story], timelineRange: async (_id, q) => ({ entries: q.limit === 1 ? [] : entries.map(entry => globalThis.fixtureChannels ? entry : Object.fromEntries(Object.entries(entry).filter(([key]) => key !== 'metadata'))), revision: String(revision), range: q, timezone: 'Asia/Shanghai', cursorAt: new Date(now).toISOString(), scenes, facts, preplan }), deliveries: async () => deliveries, usage: async () => [],
      mixerRead: async () => [{key:'a',section:'MODEL',label:'数字参数',desc:'可精确输入',type:'knob',min:0,max:2,step:0.1,value:0.8},{key:'b',section:'TEMPO',label:'启用',desc:'开关',type:'toggle',value:true},{key:'c',section:'MODEL',label:'格式',desc:'枚举',type:'select',options:['x','y'],value:'x'}],
      mixerWrite: async (id, patch) => { globalThis.fixtureWrites.push({id,patch}); return {applied:Object.entries(patch).map(([key,value])=>({key,value}))} },
    },
    runtime: { resources: async () => ({runningWorkers:1,maxWorkers:3}), overview: async () => structuredClone(overview) },
    accounts: { status: async () => ({}) }, logs: { query: async () => [], stats: async () => ({}) }, console: { info: async () => ({}) },
  }
  window.hdsiDesktop = new Proxy(api, { get: (target,key) => target[key] || (() => {}) })
}

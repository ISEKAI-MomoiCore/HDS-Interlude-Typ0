/**
 * 配置导入器合同测试：插件版 koishi.yml → typ0 剧本。
 * 用脱敏的插件版形态 fixture 覆盖：模块检测、明文密钥→$secret 转换、
 * adapter→账号登记（正向绑定/反向拒绝）、节级搬运、主提示词默认不动、
 * 别名复用/冲突、失败回滚。依赖全部为内存/临时目录假件。
 */
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { analyzeKoishiYml, executeImport, type ImporterDeps, type ImportSource } from './config-importer'
import type { AccountRegistry } from './account-registry'
import type { BindingRegistry } from './bindings'

const SOURCE_YML = `plugins:
  group:server:
    server:x:
      port: 5140
  adapter-onebot:abc123:
    selfId: '10001'
    protocol: ws
    endpoint: ws://127.0.0.1:3001?token=leak
    token: plain-token-1
  adapter-onebot:def456:
    selfId: '10002'
    protocol: ws-reverse
    endpoint: ''
    token: ''
  hds-interlude:legacy1:
    storyDefaults:
      characterName: 测试角色
      characterProfile: 人设文本
      world: 现实
    onebot:
      userAccounts:
        - { qq: '20001', label: 用户甲, personId: p1 }
      groupChats:
        - { groupId: '70001', label: 群A, enabled: true, responseMode: mention-only, contextLimit: 20, cooldownSeconds: 60 }
      botAccounts:
        - { qq: '10001', label: 主号, enabled: true }
    model:
      providers:
        - id: main
          label: 主连接
          mode: openai-compatible
          endpoint: https://api.example.com/v1/chat/completions
          apiKey: sk-plain-111
          model: test-model
          useForMain: true
        - id: side
          mode: deepseek-official
          apiKey: sk-plain-222
          model: deepseek-chat
      mainResponseFormat: prompt-only
    runtime:
      autoCreate: false
    urge:
      enabled: true
      frequency: medium
    memory:
      enabled: true
    mainPrompt: 顶层提示词覆盖
    blindMode:
      enabled: false
    logging:
      verbosity: standard
    presetSync:
      sections: []
`

const STORY_TEMPLATE_YML = `plugins:
  group:server:
    server:m0:
      port: 0
  group:adapter:
    adapter-onebot:m0:
      selfId: ""
      protocol: ws
      endpoint: ws://127.0.0.1:6709/onebot/tpl
      token: ""
  hds-interlude:m0:
    model:
      providers:
        - id: primary
          label: 占位
          endpoint: $secret:primary-endpoint
          apiKey: $secret:primary-key
          model: $secret:primary-model
    storyDefaults:
      characterName: ''
`

interface Harness {
  deps: ImporterDeps
  storyDir: string
  secretsStore: Map<string, string>
  savedYml: () => string
  registered: Array<{ storyId: string, selfId: string, endpoint: string, tokenAlias?: string }>
  bound: string[]
  boundEntries: Array<{ accountKey: string, storyId: string }>
  unbound: string[]
  loaded: string[]
  removedAccounts: unknown[]
  synced: string[]
  broadcasts: number
  failSave: boolean
  registryAccounts: Array<{ storyId: string, selfId: string, nickname: string, externalUpstream?: { endpoint: string, tokenAlias?: string }, channelKind?: string }>
  runningStories: Set<string>
  unloaded: string[]
}

function makeHarness(): Harness {
  const root = mkdtempSync(path.join(tmpdir(), 'hdsi-import-test-'))
  const storiesRoot = path.join(root, 'stories')
  const secretsStore = new Map<string, string>()
  const registered: Harness['registered'] = []
  const bound: string[] = []
  const boundEntries: Harness['boundEntries'] = []
  const unbound: string[] = []
  const loaded: string[] = []
  const removedAccounts: unknown[] = []
  const synced: string[] = []
  const registryAccounts: Harness['registryAccounts'] = []
  const runningStories = new Set<string>()
  const unloaded: string[] = []
  const state: Harness = {
    storyDir: '',
    secretsStore, registered, bound, boundEntries, unbound, removedAccounts, synced, loaded,
    broadcasts: 0,
    failSave: false,
    registryAccounts, runningStories, unloaded,
    savedYml: () => readFileSync(state.storyDir + '/koishi.yml', 'utf8'),
    deps: {
      storiesRoot,
      createStory: payload => {
        const dir = path.join(storiesRoot, payload.id)
        mkdirSync(dir, { recursive: true })
        writeFileSync(path.join(dir, 'koishi.yml'), STORY_TEMPLATE_YML)
        state.storyDir = dir
        return { dir }
      },
      config: {
        read: (dir: string) => readFileSync(path.join(dir, 'koishi.yml'), 'utf8'),
        save: (dir: string, text: string) => {
          if (state.failSave) throw new Error('模拟保存失败')
          writeFileSync(path.join(dir, 'koishi.yml'), text)
          return { backup: '', aliases: [], warnings: [] }
        },
      },
      secrets: {
        has: (alias: string) => secretsStore.has(alias),
        set: (alias: string, value: string) => { secretsStore.set(alias, value); return true },
        tryGet: alias => (secretsStore.has(alias) ? { ok: true as const, value: secretsStore.get(alias)! } : { ok: false as const, reason: 'missing' as const, message: 'missing' }),
        remove: (alias: string) => { secretsStore.delete(alias); return true },
      },
      accountRegistry: {
        register: (storyId: string, selfId: string, nickname: string, upstream?: { endpoint?: string, tokenAlias?: string }) => {
          registered.push({ storyId, selfId, endpoint: upstream?.endpoint ?? '', tokenAlias: upstream?.tokenAlias })
          registryAccounts.push({ storyId, selfId, nickname, ...(upstream?.endpoint ? { externalUpstream: upstream as { endpoint: string, tokenAlias?: string } } : {}) })
        },
        removeAccount: (storyId: string, selfId: string) => {
          removedAccounts.push({ storyId, selfId })
          const index = registryAccounts.findIndex(entry => entry.storyId === storyId && entry.selfId === selfId)
          if (index >= 0) registryAccounts.splice(index, 1)
        },
        findBySelfId: (selfId: string) => registryAccounts.find(entry => entry.selfId === selfId),
      } as unknown as AccountRegistry,
      bindings: {
        bind: (entry: { accountKey: string, storyId: string }) => { bound.push(entry.accountKey); boundEntries.push({ accountKey: entry.accountKey, storyId: entry.storyId }) },
        unbind: (accountKey: string) => { unbound.push(accountKey) },
      } as unknown as BindingRegistry,
      syncExternalConnector: storyId => { synced.push(storyId) },
      broadcastStoriesChanged: () => { state.broadcasts += 1 },
      isStoryRunning: id => runningStories.has(id),
      unloadStory: async id => { unloaded.push(id); runningStories.delete(id) },
      loadStory: id => { loaded.push(id) },
    },
  }
  return state
}

const allModules = { persona: true, relations: true, accounts: true, model: true, behavior: true, mainPrompt: false, misc: true, database: false }

test('analyze：模块检测/脱敏/警告', () => {
  const result = analyzeKoishiYml(SOURCE_YML)
  assert.equal(result.ok, true)
  if (!result.ok) return
  const { analysis, source } = result
  assert.equal(analysis.modules.persona.characterName, '测试角色')
  assert.equal(analysis.modules.relations.users, 1)
  assert.equal(analysis.modules.relations.groups, 1)
  assert.equal(analysis.modules.accounts.bots, 1)
  assert.equal(analysis.modules.accounts.adapters.length, 2)
  assert.equal(analysis.modules.accounts.adapters[0].reverse, false)
  assert.equal(analysis.modules.accounts.adapters[1].reverse, true)
  // endpoint 脱敏：去掉查询串（源里带了 ?token=leak）
  assert.equal(analysis.modules.accounts.adapters[0].endpoint.includes('leak'), false)
  assert.equal(analysis.modules.model.providers, 2)
  assert.equal(analysis.modules.model.plaintextKeys, 2)
  assert.deepEqual(analysis.modules.behavior.map(item => item.key).sort(), ['memory', 'runtime', 'urge'])
  assert.equal(analysis.modules.mainPrompt.present, true)
  assert.equal(analysis.modules.misc.blindMode, true)
  assert.ok(analysis.warnings.some(line => line.includes('反向')))
  assert.ok(analysis.warnings.some(line => line.includes('明文')))
  // analysis 不得携带任何明文密钥
  assert.equal(JSON.stringify(analysis).includes('sk-plain'), false)
  assert.equal(JSON.stringify(analysis).includes('plain-token'), false)
  // 源保留在主进程侧（含明文）
  assert.equal(source.adapters[0].token, 'plain-token-1')
})

test('execute：全模块导入（mainPrompt 默认不动）', async () => {
  const harness = makeHarness()
  const analyzed = analyzeKoishiYml(SOURCE_YML)
  if (!analyzed.ok) assert.fail('analyze 应成功')
  const result = await executeImport(harness.deps, analyzed.source, { modules: allModules })
  assert.match(result.storyId, /^import-/)
  assert.equal(result.storyName, '测试角色')
  const saved = harness.savedYml()
  // 人设/关系/账号节写入目标 hds-interlude 节
  assert.match(saved, /characterName: 测试角色/)
  assert.match(saved, /用户甲/)
  assert.match(saved, /群A/)
  assert.match(saved, /主号/)
  // 模型：明文 → $secret 别名；别名已入密钥库
  assert.match(saved, /\$secret:migrated-provider-1-key/)
  assert.match(saved, /\$secret:migrated-side-key/)
  assert.equal(harness.secretsStore.get('migrated-provider-1-key'), 'sk-plain-111')
  assert.equal(harness.secretsStore.get('migrated-side-key'), 'sk-plain-222')
  assert.equal(saved.includes('sk-plain'), false, '落盘文本不得含明文密钥')
  // 行为节 + 其他
  assert.match(saved, /autoCreate: false/)
  assert.match(saved, /frequency: medium/)
  assert.match(saved, /verbosity: standard/)
  // 主提示词默认不动；presetSync 恒不搬
  assert.equal(saved.includes('顶层提示词覆盖'), false)
  assert.equal(saved.includes('presetSync'), false)
  // 源 adapter 不进剧本（模板 adapter 原样保留，无 abc123/def456）
  assert.equal(saved.includes('abc123'), false)
  assert.match(saved, /adapter-onebot:m0/)
  // 账号登记：正向 WS 绑定，token 别名入密钥库；endpoint 去查询串
  assert.deepEqual(harness.registered, [{ storyId: result.storyId, selfId: '10001', endpoint: 'ws://127.0.0.1:3001/', tokenAlias: 'migrated-onebot-10001-token' }])
  assert.equal(harness.secretsStore.get('migrated-onebot-10001-token'), 'plain-token-1')
  assert.deepEqual(harness.bound, ['onebot:10001'])
  assert.deepEqual(harness.synced, [result.storyId])
  assert.equal(result.account?.selfId, '10001')
  // 报告：全部模块有结论
  assert.ok(result.report.every(item => ['ok', 'skipped', 'warning'].includes(item.status)))
  assert.equal(result.secrets.length, 3)
})

test('execute：mainPrompt 勾选后导入', async () => {
  const harness = makeHarness()
  const analyzed = analyzeKoishiYml(SOURCE_YML)
  if (!analyzed.ok) assert.fail()
  await executeImport(harness.deps, analyzed.source, { modules: { ...allModules, mainPrompt: true } })
  assert.match(harness.savedYml(), /顶层提示词覆盖/)
})

test('execute：同别名同值复用、异值加后缀', async () => {
  const reuse = makeHarness()
  reuse.secretsStore.set('migrated-provider-1-key', 'sk-plain-111')
  const analyzed = analyzeKoishiYml(SOURCE_YML)
  if (!analyzed.ok) assert.fail()
  const resultReuse = await executeImport(reuse.deps, analyzed.source, { modules: allModules })
  assert.equal(resultReuse.secrets.includes('migrated-provider-1-key'), false, '同值复用不新建')
  assert.match(reuse.savedYml(), /\$secret:migrated-provider-1-key/)

  const conflict = makeHarness()
  conflict.secretsStore.set('migrated-provider-1-key', 'different-value')
  const analyzed2 = analyzeKoishiYml(SOURCE_YML)
  if (!analyzed2.ok) assert.fail()
  await executeImport(conflict.deps, analyzed2.source, { modules: allModules })
  assert.equal(conflict.secretsStore.get('migrated-provider-1-key-2'), 'sk-plain-111')
  assert.match(conflict.savedYml(), /\$secret:migrated-provider-1-key-2/)
})

test('execute：仅反向 WS adapter 时不绑定，给出警告', async () => {
  const harness = makeHarness()
  const analyzed = analyzeKoishiYml(SOURCE_YML)
  if (!analyzed.ok) assert.fail()
  const source: ImportSource = { ...analyzed.source, adapters: analyzed.source.adapters.filter(adapter => adapter.reverse) }
  const result = await executeImport(harness.deps, source, { modules: allModules })
  assert.equal(result.account, undefined)
  assert.deepEqual(harness.registered, [])
  assert.deepEqual(harness.bound, [])
  assert.ok(result.report.some(item => item.module === '账号' && item.status === 'warning'))
})

test('execute：保存失败回滚（删剧本/撤密钥/撤登记）', async () => {
  const harness = makeHarness()
  const analyzed = analyzeKoishiYml(SOURCE_YML)
  if (!analyzed.ok) assert.fail()
  harness.failSave = true
  await assert.rejects(executeImport(harness.deps, analyzed.source, { modules: allModules }), /模拟保存失败/)
  assert.equal(existsSync(harness.storyDir), false, '剧本目录应回滚删除')
  assert.equal(harness.secretsStore.size, 0, '新建密钥别名应撤销')
  assert.deepEqual(harness.unbound, ['onebot:10001'])
  assert.equal(harness.removedAccounts.length, 1)
})

test('execute：账号被其它剧本占用时自动转移（运行中先卸载，失败回滚还原）', async () => {
  const harness = makeHarness()
  harness.registryAccounts.push({ storyId: 'old-story', selfId: '10001', nickname: '旧名', externalUpstream: { endpoint: 'ws://127.0.0.1:3001/' }, channelKind: 'qq' })
  harness.runningStories.add('old-story')
  const analyzed = analyzeKoishiYml(SOURCE_YML)
  if (!analyzed.ok) assert.fail()
  const result = await executeImport(harness.deps, analyzed.source, { modules: allModules })
  // 占用剧本在跑 → 先卸载；登记从旧剧本转移到新剧本
  assert.deepEqual(harness.unloaded, ['old-story'])
  assert.deepEqual(harness.removedAccounts, [{ storyId: 'old-story', selfId: '10001' }])
  assert.ok(harness.registryAccounts.some(entry => entry.storyId === result.storyId && entry.selfId === '10001'), '新剧本获得账号')
  assert.ok(!harness.registryAccounts.some(entry => entry.storyId === 'old-story'), '旧剧本账号位空缺（Idle）')
  assert.ok(result.report.some(item => item.module === '账号' && item.detail.includes('old-story') && item.detail.includes('转移')), '报告注明转移')

  // 失败路径：转移（含卸载运行中的旧剧本）后保存失败 → 登记/绑定/连接器/运行态全还原
  const harness2 = makeHarness()
  harness2.registryAccounts.push({ storyId: 'old-story', selfId: '10001', nickname: '旧名', externalUpstream: { endpoint: 'ws://127.0.0.1:3001/' }, channelKind: 'qq' })
  harness2.runningStories.add('old-story')
  const analyzed2 = analyzeKoishiYml(SOURCE_YML)
  if (!analyzed2.ok) assert.fail()
  harness2.failSave = true
  await assert.rejects(executeImport(harness2.deps, analyzed2.source, { modules: allModules }), /模拟保存失败/)
  const restored = harness2.registryAccounts.find(entry => entry.selfId === '10001')
  assert.equal(restored?.storyId, 'old-story', '回滚应把账号登记还原给原剧本')
  assert.equal(restored?.externalUpstream?.endpoint, 'ws://127.0.0.1:3001/')
  // 审计 H2 回归：绑定必须重指回旧剧本（此前被整体 unbind，消息全部落入 unassigned）
  const rebind = harness2.boundEntries.filter(entry => entry.accountKey === 'onebot:10001').pop()
  assert.equal(rebind?.storyId, 'old-story', '回滚应把绑定还原给原剧本')
  assert.ok(harness2.synced.includes('old-story'), '回滚应同步回收旧剧本的外部连接器')
  assert.deepEqual(harness2.loaded, ['old-story'], '转移时被卸载的运行中剧本应按原运行态重载')
})

test('analyze：hds-interlude/adapter 嵌套在 group 分组下也能找到（真实插件版形态）', () => {
  const nested = `plugins:
  group:adapter:
    hds-interlude:qmcus2:
      storyDefaults:
        characterName: 嵌套角色
      model:
        providers:
          - { id: main, apiKey: sk-nested, model: m1 }
    adapter-onebot:bzukwy:
      selfId: '10001'
      protocol: ws
      endpoint: ws://127.0.0.1:3001
      token: tok
  group:develop:
    puppeteer:x: {}
`
  const result = analyzeKoishiYml(nested)
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.analysis.modules.persona.characterName, '嵌套角色')
  assert.equal(result.analysis.modules.model.providers, 1)
  assert.equal(result.analysis.modules.accounts.adapters.length, 1)
  assert.equal(result.analysis.modules.accounts.adapters[0].selfId, '10001')
  assert.equal(result.source.adapters[0].token, 'tok')
})

test('execute：旧配置无 useForMain 时自动补标主叙事（贴纸侧端连接不回退的 rc57 语义）', async () => {
  const legacy = `plugins:
  hds-interlude:x:
    storyDefaults:
      characterName: 旧版角色
    model:
      providers:
        - label: ruoli
          useForStickers: true
          endpoint: https://ruoli.dev/v1/chat/completions
          apiKey: sk-legacy-1
          model: gemini-3.8-flash
        - label: embed-only
          endpoint: https://e.example/v1
          apiKey: sk-legacy-2
          model: text-embedding-3-small
          useForMain: false
          useForEmbedding: true
`
  const harness = makeHarness()
  const analyzed = analyzeKoishiYml(legacy)
  if (!analyzed.ok) assert.fail()
  const result = await executeImport(harness.deps, analyzed.source, { modules: allModules })
  const saved = harness.savedYml()
  // ruoli 被补标 useForMain: true；embed-only 保持显式排除
  assert.match(saved, /label: ruoli[\s\S]*?useForMain: true/)
  assert.doesNotMatch(saved, /label: embed-only[\s\S]*?useForMain: true/)
  const modelReport = result.report.find(item => item.module === '模型配置')
  assert.match(modelReport?.detail ?? '', /ruoli.*主叙事|主叙事.*ruoli/)
  assert.equal(result.report.some(item => item.module === '模型配置' && item.status === 'warning'), false)

  // 全部被显式排除 → 不补标，报告给警告
  const allExcluded = legacy.replace(/        - label: ruoli[\s\S]*?model: gemini-3\.8-flash/, '        - label: ruoli\n          useForMain: false\n          endpoint: https://ruoli.dev/v1/chat/completions\n          apiKey: sk-legacy-1\n          model: gemini-3.8-flash')
  const harness2 = makeHarness()
  const analyzed2 = analyzeKoishiYml(allExcluded)
  if (!analyzed2.ok) assert.fail()
  const result2 = await executeImport(harness2.deps, analyzed2.source, { modules: allModules })
  assert.equal(result2.report.some(item => item.module === '模型配置' && item.status === 'warning'), true)
})

test('analyze：非插件版文件明确报错', () => {
  assert.equal(analyzeKoishiYml('foo: bar').ok, false)
  const missing = analyzeKoishiYml('plugins:\n  puppeteer:x: {}\n')
  assert.equal(missing.ok, false)
  if (!missing.ok) assert.match(missing.error, /hds-interlude/)
})


// ── 剧本数据库模块（m4：文件级整库替换） ─────────────────────────────────

function makeSourceDb(root: string, selfIds: string[]): { ymlDir: string, dbPath: string } {
  const ymlDir = path.join(root, 'source-instance')
  mkdirSync(path.join(ymlDir, 'data'), { recursive: true })
  const dbPath = path.join(ymlDir, 'data', 'koishi.db')
  writeFileSync(dbPath, Buffer.from('SQLite-format-sample-' + Date.now()))
  writeFileSync(dbPath + '-wal', Buffer.from('wal-bytes'))
  writeFileSync(dbPath + '-shm', Buffer.from('shm-bytes'))
  return { ymlDir, dbPath }
}

test('execute：数据库整库替换（db+wal+shm 三件套 + 报告）', async () => {
  const harness = makeHarness()
  const analyzed = analyzeKoishiYml(SOURCE_YML)
  if (!analyzed.ok) assert.fail()
  const { ymlDir, dbPath } = makeSourceDb(path.dirname(harness.deps.storiesRoot), ['10001'])
  analyzed.source.ymlDir = ymlDir
  analyzed.source.database = { path: dbPath, selfIds: ['10001'], counts: { story: 1, script_entry: 6, fact: 1, intent: 1, scene: 1, participant: 1, user: 281, binding: 281 }, walActive: false }
  const result = await executeImport(harness.deps, analyzed.source, { modules: { ...allModules, database: true } })
  const data = path.join(harness.storyDir, 'data', 'hdsi.db')
  assert.equal(existsSync(data), true, '目标剧本必须有 data/hdsi.db')
  assert.equal(existsSync(data + '-wal'), true, 'WAL 必须随库复制')
  assert.equal(existsSync(data + '-shm'), true, 'SHM 必须随库复制')
  assert.deepEqual(readFileSync(data), readFileSync(dbPath), '主库文件必须逐字节一致')
  const dbReport = result.report.find(item => item.module === '剧本数据库')
  assert.equal(dbReport?.status, 'ok')
  assert.match(dbReport?.detail ?? '', /剧本 1/)
  assert.match(dbReport?.detail ?? '', /281\/281/)
  // selfId 一致（10001）不得触发不连续警告
  assert.doesNotMatch(dbReport?.detail ?? '', /不连续/)
})

test('execute：数据库身份不匹配 → 报告警告（不中断）', async () => {
  const harness = makeHarness()
  const analyzed = analyzeKoishiYml(SOURCE_YML)
  if (!analyzed.ok) assert.fail()
  const { ymlDir, dbPath } = makeSourceDb(path.dirname(harness.deps.storiesRoot), ['99999'])
  analyzed.source.ymlDir = ymlDir
  analyzed.source.database = { path: dbPath, selfIds: ['99999'], counts: { story: 1 }, walActive: false }
  const result = await executeImport(harness.deps, analyzed.source, { modules: { ...allModules, database: true } })
  const dbReport = result.report.find(item => item.module === '剧本数据库')
  assert.equal(dbReport?.status, 'warning')
  assert.match(dbReport?.detail ?? '', /99999.*不连续|不连续.*99999/)
  assert.equal(existsSync(path.join(harness.storyDir, 'data', 'hdsi.db')), true, '警告不阻断复制')
})

test('execute：未探测到数据库 → 模块跳过', async () => {
  const harness = makeHarness()
  const analyzed = analyzeKoishiYml(SOURCE_YML)
  if (!analyzed.ok) assert.fail()
  const result = await executeImport(harness.deps, analyzed.source, { modules: { ...allModules, database: true } })
  const dbReport = result.report.find(item => item.module === '剧本数据库')
  assert.equal(dbReport?.status, 'skipped')
  assert.equal(existsSync(path.join(harness.storyDir, 'data')), false)
})

test('execute：数据库复制失败 → 整剧本回滚', async () => {
  const harness = makeHarness()
  const analyzed = analyzeKoishiYml(SOURCE_YML)
  if (!analyzed.ok) assert.fail()
  const root = path.dirname(harness.deps.storiesRoot)
  // path 指向目录：existsSync 为真但 copyFileSync 抛错 → 走既有回滚链
  const trap = path.join(root, 'dir-trap')
  mkdirSync(trap, { recursive: true })
  analyzed.source.ymlDir = root
  analyzed.source.database = { path: trap, selfIds: ['10001'], counts: {}, walActive: false }
  await assert.rejects(() => executeImport(harness.deps, analyzed.source, { modules: { ...allModules, database: true } }))
  assert.equal(existsSync(harness.storyDir), false, '回滚必须删除刚创建的剧本目录')
})

test('analyze：database-sqlite 相对路径解析（含默认值）', () => {
  const withSqlite = SOURCE_YML.replace('plugins:', 'plugins:\n  database-sqlite:t1:\n    path: custom/dir/my.db')
  const parsed = analyzeKoishiYml(withSqlite)
  assert.equal(parsed.ok, true)
  if (parsed.ok) assert.equal(parsed.analysis.modules.database.relativePath, 'custom/dir/my.db')
  const base = analyzeKoishiYml(SOURCE_YML)
  if (!base.ok) assert.fail()
  assert.equal(base.analysis.modules.database.configured, false)
  assert.equal(base.analysis.modules.database.relativePath, 'data/koishi.db')
})

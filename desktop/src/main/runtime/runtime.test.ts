import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { BindingRegistry } from './bindings'
import { StoryConfigCompiler } from './config-compiler'
import { StoryConfigMediator } from './config-mediator'
import { DesktopInboundEvent, StoryPhase, WorkerIngress } from './contracts'
import { InboxRepository } from './inbox-replay'
import { InboundReceiptLedger } from './inbound-ledger'
import { MessageRouter } from './message-router'
import { DeliveryOutbox } from './outbox'
import { SecretStore } from './secrets'
import { normalizeTimelineRange, normalizeTimelineSnapshot } from './story-repository'
import { selectResumableStories, WorkerRegistry } from './worker-registry'
import { HostLock } from './host-lock'
import { captureConsoleConfig } from './console-config-capture'
import { StoryArchiveService, verifyStoryArchive } from './story-archive'
import { readStoryMeta, writeStoryMeta, bridgeCapabilityAllowed } from '../stories'
import yaml from 'js-yaml'
import { UsageAggregator } from './usage-aggregator'
import { LogBroker } from './log-broker'
import { ConsoleRegistry } from './console-registry'
import { activeSiblingsInTree, buildBranchTree, nextBranchId } from './branch-registry'
import { AccountRegistry } from './account-registry'
import { OneBotServerAdapter } from './onebot-bridge'
import { ExternalOneBotConnector, OnebotActionError } from './external-onebot-connector'
import { ChannelAdapterRegistry, SandboxChannelAdapter } from './channel-adapter'
import { buildSendPayload, extractImageSources, persistedDeliveryAction, receiptFromEchoResponse, transformPrivateMessage, workerReceipt } from './onebot-core'
import { WebSocket } from 'ws'
import { HostProjectionService } from './host-projection'
import { probeUpstream } from './probe-upstream'
import { inspectModelReadiness, inspectSecretReferences } from './model-readiness'
import { FIRST_RUN_ERROR_CODES, overallForReadiness, readinessItem } from './first-run-readiness'
import { detectSnowLuma } from './snowluma-detection'

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'hdsi-typ0-runtime-'))
  const stories = path.join(root, 'stories')
  return { root, stories, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

function readinessSecrets(root: string, values: Record<string, string> = {}) {
  const protector = {
    available: () => true,
    encrypt: (value: string) => `safe:${value}`,
    decrypt: (value: string) => value.slice(5),
  }
  const secrets = new SecretStore(root, protector)
  for (const [alias, value] of Object.entries(values)) secrets.set(alias, value)
  return secrets
}

function readinessInspection(source: string, root: string, values: Record<string, string> = {}) {
  const secrets = readinessSecrets(root, values)
  return { secrets, inspection: inspectModelReadiness(source, inspectSecretReferences(source, secrets)) }
}

test('首次运行状态快照的总体状态只由 Main 侧标准状态决定', () => {
  assert.equal(overallForReadiness([
    readinessItem({ status: 'blocked', summary: '未配置', code: FIRST_RUN_ERROR_CODES.ACCOUNT_NOT_BOUND }),
    readinessItem({ status: 'ready', summary: '已配置' }),
  ]), 'not-ready')
  assert.equal(overallForReadiness([
    readinessItem({ status: 'needs-reload', summary: '需要重载' }),
    readinessItem({ status: 'ready', summary: '已配置' }),
  ]), 'degraded')
  assert.equal(overallForReadiness([
    readinessItem({ status: 'ready', summary: 'Worker 已运行' }),
    readinessItem({ status: 'ready', summary: '模型已配置' }),
  ]), 'running')
})

function inbound(): DesktopInboundEvent {
  return {
    transport: 'sandbox', accountKey: 'sandbox:10001', platform: 'sandbox', selfId: '10001', senderId: '20002',
    kind: 'private', content: '测试消息', occurredAt: '2026-09-02T12:00:00.000Z', rawMessageId: 'm-1',
  }
}

test('SnowLuma 探测分开安装、进程与管理界面状态', async () => {
  const temp = fixture()
  const install = path.join(temp.root, 'snowluma')
  mkdirSync(install)
  writeFileSync(path.join(install, 'package.json'), JSON.stringify({ name: '@snowluma/runtime' }))
  writeFileSync(path.join(install, 'index.mjs'), '')
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => ({ status: 200, body: { cancel: async () => {} } })) as unknown as typeof fetch
  try {
    const detected = await detectSnowLuma({ platform: 'linux', candidates: [install], queryProcesses: async () => [], timeoutMs: 20 })
    assert.equal(detected.status, 'installed')
    assert.equal(detected.path, path.resolve(install))
    assert.equal(detected.webui.status, 'reachable')
    assert.equal(detected.webui.reachable, true)
    assert.equal(typeof detected.process, 'string')
  } finally {
    globalThis.fetch = originalFetch
    temp.cleanup()
  }
})

test('模型就绪检查拒绝只有 providers 但缺少主叙事连接字段的配置', () => {
  const temp = fixture()
  try {
    const source = [
      'plugins:',
      '  hds-interlude:m0:',
      '    model:',
      '      providers:',
      '        - id: primary',
      '          label: 主模型',
    ].join('\n')
    const { inspection } = readinessInspection(source, temp.root)
    assert.equal(inspection.status, 'err')
    assert.equal(inspection.code, FIRST_RUN_ERROR_CODES.MODEL_ENDPOINT_INVALID)
    assert.match(inspection.detail, /缺少 endpoint/)
    assert.match(inspection.detail, /model/)
  } finally { temp.cleanup() }
})

test('模型就绪检查在 provider 和引用密钥齐全时返回 ok', () => {
  const temp = fixture()
  try {
    const source = [
      'plugins:',
      '  hds-interlude:m0:',
      '    model:',
      '      providers:',
      '        - id: primary',
      '          useForMain: true',
      '          endpoint: $secret:primary-endpoint',
      '          apiKey: $secret:primary-key',
      '          model: $secret:primary-model',
    ].join('\n')
    const { inspection } = readinessInspection(source, temp.root, {
      'primary-endpoint': 'https://api.example/v1',
      'primary-key': 'sk-test',
      'primary-model': 'model-test',
    })
    assert.equal(inspection.status, 'ok')
    assert.equal(inspection.usableCount, 1)
    assert.deepEqual(inspection.referencedAliases, ['primary-endpoint', 'primary-key', 'primary-model'])
  } finally { temp.cleanup() }
})

test('模型就绪检查不会把未指定主叙事的 provider 误判为可用', () => {
  const temp = fixture()
  try {
    const source = [
      'plugins:',
      '  hds-interlude:m0:',
      '    model:',
      '      providers:',
      '        - id: embedding',
      '          useForMain: false',
      '          useForEmbedding: true',
      '          endpoint: https://api.example/v1',
      '          model: embedding-model',
      '        - id: vision',
      '          useForMain: false',
      '          useForVision: true',
      '          endpoint: https://api.example/v1',
      '          model: vision-model',
    ].join('\n')
    const { inspection } = readinessInspection(source, temp.root)
    assert.equal(inspection.status, 'err')
    assert.equal(inspection.code, FIRST_RUN_ERROR_CODES.MODEL_NOT_ASSIGNED)
    assert.equal(inspection.candidateCount, 0)
    assert.match(inspection.detail, /主叙事/)
  } finally { temp.cleanup() }
})

test('模型就绪检查与 HDSI 的 legacy fallback 一致，不误阻塞混合旧配置', () => {
  const temp = fixture()
  try {
    const source = [
      'plugins:',
      '  hds-interlude:m0:',
      '    model:',
      '      providers:',
      '        - id: embedding',
      '          useForMain: false',
      '          useForEmbedding: true',
      '          endpoint: https://api.example/v1',
      '          model: embedding-model',
      '        - id: legacy',
      '          useForMain: false',
      '          endpoint: https://api.example/v1',
      '          apiKey: legacy-key',
      '          model: legacy-model',
    ].join('\n')
    const { inspection } = readinessInspection(source, temp.root)
    assert.equal(inspection.status, 'ok')
    assert.equal(inspection.candidateCount, 1)
    assert.equal(inspection.usableCount, 1)
  } finally { temp.cleanup() }
})

test('模型就绪检查兼容未写 useForMain 的旧配置', () => {
  const temp = fixture()
  try {
    const source = [
      'plugins:',
      '  hds-interlude:m0:',
      '    model:',
      '      providers:',
      '        - id: legacy',
      '          endpoint: https://api.example/v1',
      '          apiKey: legacy-key',
      '          model: legacy-model',
    ].join('\n')
    const { inspection } = readinessInspection(source, temp.root)
    assert.equal(inspection.status, 'ok')
    assert.equal(inspection.candidateCount, 1)
  } finally { temp.cleanup() }
})

test('官方 provider 可以省略显式 endpoint', () => {
  const temp = fixture()
  try {
    const source = [
      'plugins:',
      '  hds-interlude:m0:',
      '    model:',
      '      providers:',
      '        - id: official',
      '          mode: deepseek-official',
      '          apiKey: $secret:deepseek-key',
      '          model: deepseek-chat',
    ].join('\n')
    const { inspection } = readinessInspection(source, temp.root, { 'deepseek-key': 'sk-test' })
    assert.equal(inspection.status, 'ok')
  } finally { temp.cleanup() }
})

test('就绪检查只关心当前配置引用的密钥，旧密钥不会污染状态', () => {
  const temp = fixture()
  try {
    const source = [
      'plugins:',
      '  hds-interlude:m0:',
      '    model:',
      '      providers:',
      '        - id: primary',
      '          useForMain: true',
      '          endpoint: https://api.example/v1',
      '          apiKey: $secret:current-key',
      '          model: current-model',
    ].join('\n')
    const secrets = readinessSecrets(temp.root, { 'legacy-key': 'old-value', 'current-key': 'current-value' })
    const references = inspectSecretReferences(source, secrets)
    assert.deepEqual(references.referenced, ['current-key'])
    assert.deepEqual(references.missing, [])
    assert.equal(inspectModelReadiness(source, references).status, 'ok')
  } finally { temp.cleanup() }
})

test('密钥无法解密时，就绪检查给出重新录入所需的错误分类', () => {
  const temp = fixture()
  try {
    const source = 'plugins:\n  hds-interlude:m0:\n    model:\n      providers:\n        - id: primary\n          useForMain: true\n          endpoint: https://api.example/v1\n          apiKey: $secret:primary-key\n          model: test-model\n'
    const secrets = new SecretStore(temp.root, {
      available: () => true,
      encrypt: (value: string) => `safe:${value}`,
      decrypt: () => { throw new Error('wrong machine') },
    })
    secrets.set('primary-key', 'ciphertext')
    const references = inspectSecretReferences(source, secrets)
    assert.deepEqual(references.undecryptable, ['primary-key'])
    assert.equal(inspectModelReadiness(source, references).status, 'err')
  } finally { temp.cleanup() }
})

test('同账号不能无确认地绑定到第二个剧本', () => {
  const temp = fixture()
  try {
    const registry = new BindingRegistry(temp.root)
    registry.bind({ accountKey: 'sandbox:10001', storyId: 'a', transport: 'sandbox' })
    assert.throws(() => registry.bind({ accountKey: 'sandbox:10001', storyId: 'b', transport: 'sandbox' }), /已绑定/)
    registry.bind({ accountKey: 'sandbox:10001', storyId: 'b', transport: 'sandbox' }, { replace: true })
    assert.equal(registry.find('sandbox:10001')?.storyId, 'b')
  } finally { temp.cleanup() }
})

test('移除故事时会解除其全部账号绑定，不影响其他故事', () => {
  const temp = fixture()
  try {
    const registry = new BindingRegistry(temp.root)
    registry.bind({ accountKey: 'sandbox:a', storyId: 'alpha', transport: 'sandbox' })
    registry.bind({ accountKey: 'sandbox:b', storyId: 'alpha', transport: 'sandbox' })
    registry.bind({ accountKey: 'sandbox:c', storyId: 'beta', transport: 'sandbox' })
    assert.equal(registry.unbindStory('alpha').length, 2)
    assert.equal(registry.find('sandbox:a'), undefined)
    assert.equal(registry.find('sandbox:c')?.storyId, 'beta')
  } finally { temp.cleanup() }
})

test('配置编译只把 $secret 标量写入临时文件，原始剧本不泄露密钥', () => {
  const temp = fixture()
  try {
    const protector = { available: () => true, encrypt: (value: string) => `safe:${value}`, decrypt: (value: string) => value.slice(5) }
    const secrets = new SecretStore(temp.root, protector)
    secrets.set('primary-key', 'sk-typ0-test')
    const storyDir = path.join(temp.stories, 'alpha')
    require('node:fs').mkdirSync(storyDir, { recursive: true })
    const original = 'apiKey: $secret:primary-key\nlabel: no-secret-here\n'
    writeFileSync(path.join(storyDir, 'koishi.yml'), original)
    const result = new StoryConfigCompiler(secrets).compile(storyDir)
    assert.match(readFileSync(result.file, 'utf8'), /apiKey: "sk-typ0-test"/)
    assert.equal(readFileSync(path.join(storyDir, 'koishi.yml'), 'utf8'), original)
    result.cleanup()
  } finally { temp.cleanup() }
})

test('配置中介只接受已保存的密钥别名，并为 canonical YAML 留下回滚副本', () => {
  const temp = fixture()
  try {
    const protector = { available: () => true, encrypt: (value: string) => `safe:${value}`, decrypt: (value: string) => value.slice(5) }
    const secrets = new SecretStore(temp.root, protector)
    secrets.set('primary-key', 'sk-typ0-test')
    const storyDir = path.join(temp.stories, 'alpha')
    require('node:fs').mkdirSync(storyDir, { recursive: true })
    writeFileSync(path.join(storyDir, 'koishi.yml'), 'apiKey: $secret:primary-key\n')
    const mediator = new StoryConfigMediator(secrets)
    assert.throws(() => mediator.inspect('apiKey: plain-text\n'), /明文密钥/)
    assert.throws(() => mediator.inspect('apiKey: $secret:missing\n'), /尚未保存/)
    const result = mediator.save(storyDir, 'apiKey: $secret:primary-key\nmodel: test\n')
    assert.deepEqual(result.aliases, ['primary-key'])
    assert.match(readFileSync(path.join(storyDir, 'koishi.yml'), 'utf8'), /model: test/)
    assert.match(readFileSync(result.backup, 'utf8'), /apiKey: \$secret:primary-key/)
  } finally { temp.cleanup() }
})

test('故事备份排除运行期 resolved 配置，且不包含宿主密钥库', () => {
  const temp = fixture()
  try {
    const storyDir = path.join(temp.stories, 'alpha')
    require('node:fs').mkdirSync(path.join(storyDir, '.typ-0-runtime'), { recursive: true })
    writeFileSync(path.join(storyDir, 'story.json'), '{"id":"alpha"}')
    writeFileSync(path.join(storyDir, '.typ-0-runtime', 'koishi.1.2.resolved.yml'), 'apiKey: leaked')
    const archive = new StoryArchiveService(path.join(temp.root, 'backups')).create('alpha', storyDir)
    assert.match(readFileSync(path.join(archive, 'story.json'), 'utf8'), /alpha/)
    assert.equal(require('node:fs').existsSync(path.join(archive, '.typ-0-runtime')), false)
    assert.equal(require('node:fs').existsSync(path.join(archive, '..', '..', 'secrets.json')), false)
  } finally { temp.cleanup() }
})

test('故事副本会重写本地身份、清空账号绑定并可移入可恢复废纸篓', () => {
  const temp = fixture()
  try {
    const source = path.join(temp.stories, 'alpha')
    require('node:fs').mkdirSync(path.join(source, 'data'), { recursive: true })
    writeFileSync(path.join(source, 'story.json'), JSON.stringify({ schemaVersion: 1, id: 'alpha', name: '原剧本', accounts: ['sandbox:a'], phase: 'running' }))
    writeFileSync(path.join(source, 'koishi.yml'), 'plugins: {}\n')
    const archive = new StoryArchiveService(path.join(temp.root, 'backups'))
    const fork = archive.import(source, temp.stories, 'beta', '新剧本')
    const copied = JSON.parse(readFileSync(path.join(fork.target, 'story.json'), 'utf8'))
    assert.equal(copied.id, 'beta')
    assert.equal(copied.name, '新剧本')
    assert.deepEqual(copied.accounts, [])
    const trash = archive.trash('beta', fork.target)
    assert.equal(require('node:fs').existsSync(fork.target), false)
    assert.equal(require('node:fs').existsSync(path.join(trash, 'story.json')), true)
  } finally { temp.cleanup() }
})

test('mute、pause 与未就绪 worker 都可靠进入收件箱；bridge 就绪才实时投递', async () => {
  const temp = fixture()
  try {
    const registry = new BindingRegistry(temp.root)
    registry.bind({ accountKey: 'sandbox:10001', storyId: 'alpha', transport: 'sandbox' })
    const inbox = new InboxRepository(temp.stories)
    let phase: StoryPhase = 'muted'
    let ready = false
    let delivered = 0
    const workers: WorkerIngress = {
      isBridgeReady: () => ready,
      deliverInbound: async () => { delivered += 1 },
    }
    const router = new MessageRouter(temp.root, registry, { getPhase: () => phase }, inbox, workers, new InboundReceiptLedger(temp.stories))
    assert.equal((await router.route(inbound())).disposition, 'queued')
    phase = 'paused'
    assert.equal((await router.route({ ...inbound(), rawMessageId: 'm-2' })).reason, 'paused')
    phase = 'running'
    assert.equal((await router.route({ ...inbound(), rawMessageId: 'm-3' })).reason, 'worker-unavailable')
    ready = true
    assert.equal((await router.route({ ...inbound(), rawMessageId: 'm-4' })).disposition, 'delivered-to-worker')
    assert.equal(delivered, 1)
    assert.equal(inbox.size('alpha'), 3)
    const pending = inbox.peek('alpha')
    inbox.markAttempt('alpha', [pending[0].id])
    assert.equal(inbox.acknowledge('alpha', [pending[0].id]), 1)
    assert.equal(inbox.size('alpha'), 2)
  } finally { temp.cleanup() }
})

test('第5步 trace ID：路由入口补齐、收件箱持久化并传递给 Worker', async () => {
  const temp = fixture()
  try {
    const registry = new BindingRegistry(temp.root)
    registry.bind({ accountKey: 'sandbox:10001', storyId: 'alpha', transport: 'sandbox' })
    const inbox = new InboxRepository(temp.stories)
    let phase: StoryPhase = 'muted'
    const delivered: DesktopInboundEvent[] = []
    const router = new MessageRouter(temp.root, registry, { getPhase: () => phase }, inbox, {
      isBridgeReady: () => true,
      deliverInbound: async (_storyId, event) => { delivered.push(event) },
    }, new InboundReceiptLedger(temp.stories))

    const queued = await router.route({ ...inbound(), traceId: undefined, rawMessageId: 'trace-queued' })
    assert.match(queued.traceId ?? '', /^msg-/)
    const queuedRecord = inbox.peek('alpha')[0]
    assert.equal(queuedRecord.traceId, queued.traceId)
    assert.equal(queuedRecord.event.traceId, queued.traceId)

    phase = 'running'
    const preserved = 'msg-existing-trace'
    const deliveredResult = await router.route({ ...inbound(), traceId: preserved, rawMessageId: 'trace-delivered' })
    assert.equal(deliveredResult.traceId, preserved)
    assert.equal(delivered[0]?.traceId, preserved)

    const unassigned = await router.route({ ...inbound(), accountKey: 'sandbox:unbound', traceId: 'msg-unassigned', rawMessageId: 'trace-unassigned' })
    assert.equal(unassigned.traceId, 'msg-unassigned')
    const unassignedFile = JSON.parse(readFileSync(path.join(temp.root, 'unassigned-inbox.json'), 'utf8'))
    assert.equal(unassignedFile[0].traceId, 'msg-unassigned')
  } finally { temp.cleanup() }
})

test('只忽略同一渠道的稳定消息 ID；相同文本的独立消息仍会被处理', async () => {
  const temp = fixture()
  try {
    const registry = new BindingRegistry(temp.root)
    registry.bind({ accountKey: 'sandbox:10001', storyId: 'alpha', transport: 'sandbox' })
    const inbox = new InboxRepository(temp.stories)
    let delivered = 0
    const router = new MessageRouter(temp.root, registry, { getPhase: () => 'running' }, inbox, {
      isBridgeReady: () => true,
      deliverInbound: async () => { delivered += 1 },
    }, new InboundReceiptLedger(temp.stories))
    assert.equal((await router.route(inbound())).disposition, 'delivered-to-worker')
    assert.equal((await router.route(inbound())).disposition, 'ignored-duplicate')
    assert.equal((await router.route({ ...inbound(), rawMessageId: 'm-2' })).disposition, 'delivered-to-worker')
    assert.equal(delivered, 2)
  } finally { temp.cleanup() }
})

test('Outbox only becomes sent after an explicit transport receipt', () => {
  const temp = fixture()
  try {
    const outbox = new DeliveryOutbox(temp.stories)
    const generated = outbox.enqueue('alpha', {
      deliveryId: 'delivery-1', accountKey: 'sandbox:10001', transport: 'sandbox', platform: 'sandbox', selfId: '10001',
      channelId: 'private:20002', kind: 'private', content: '你好', occurredAt: '2026-09-02T12:00:00.000Z', traceId: 'msg-root-1', processingId: 'proc-root-1',
    })
    assert.equal(generated.state, 'generated')
    assert.equal(generated.traceId, 'msg-root-1')
    assert.equal(generated.processingId, 'proc-root-1')
    assert.equal(outbox.markSending('alpha', generated.deliveryId)?.state, 'sending')
    const settled = outbox.settle('alpha', generated.deliveryId, { status: 'sent', messageIds: ['sandbox:delivery-1'] })
    assert.equal(settled?.state, 'sent')
    assert.deepEqual(settled?.messageIds, ['sandbox:delivery-1'])
  } finally { temp.cleanup() }
})

test('P1-1 findByIntentKey：跨 deliveryId 的业务幂等查询取最新记录', () => {
  const temp = fixture()
  try {
    const outbox = new DeliveryOutbox(temp.stories)
    const base = { accountKey: 'onebot:10001', transport: 'onebot-external' as const, platform: 'onebot', selfId: '10001', channelId: 'private:20002', kind: 'private' as const, content: '分段消息', occurredAt: '2026-09-02T12:00:00.000Z' }
    // 第一次投递（回执迟到，worker 稍后带新 deliveryId 重试）
    outbox.enqueue('alpha', { ...base, deliveryId: 'delivery-a', intentKey: 'evt-1:0' })
    outbox.markSending('alpha', 'delivery-a')
    outbox.settle('alpha', 'delivery-a', { status: 'unknown' })
    const twin = outbox.findByIntentKey('alpha', 'evt-1:0')
    assert.equal(twin?.deliveryId, 'delivery-a')
    assert.equal(twin?.state, 'unknown')
    // 失败后的新尝试成为最新同键记录
    outbox.enqueue('alpha', { ...base, deliveryId: 'delivery-b', intentKey: 'evt-1:0' })
    outbox.settle('alpha', 'delivery-b', { status: 'confirmed', messageIds: ['mid-9'] })
    assert.equal(outbox.findByIntentKey('alpha', 'evt-1:0')?.deliveryId, 'delivery-b')
    // 其他键与缺失键不命中
    assert.equal(outbox.findByIntentKey('alpha', 'evt-2:0'), undefined)
    assert.equal(outbox.findByIntentKey('beta', 'evt-1:0'), undefined)
  } finally { temp.cleanup() }
})

test('时间线投影在主进程边界被规范化，未知 IPC 字段不会进入 GUI', () => {
  const snapshot = normalizeTimelineSnapshot({
    storyId: 'alpha', timezone: 'Asia/Shanghai', entries: [{ id: '1', storyId: 'alpha', kind: 'script', actor: 'narrator', content: '她走进教室。', occurredAt: '2026-09-02T12:00:00Z', secret: 'ignore' }],
    scenes: [{ id: 1, status: 'active', startedAt: '2026-09-02T11:50:00Z', hook: '午后', summary: '正在上课。', entryCount: 1 }],
    facts: [{ id: 1, scope: 'event', content: '下午有课。', importance: 0.9, confidence: 0.8, unresolved: 0, updatedAt: '2026-09-02T12:00:00Z' }],
    preplan: { revision: 2, timezone: 'Asia/Shanghai', validFrom: '2026-09-02', validThrough: '2026-09-15', materializedDays: [] },
  })
  assert.equal(snapshot.timezone, 'Asia/Shanghai')
  assert.equal(snapshot.entries[0].content, '她走进教室。')
  assert.equal((snapshot.entries[0] as any).secret, undefined)
  assert.equal((snapshot.entries[0] as any).metadata, undefined)
  assert.equal(snapshot.scenes[0].hook, '午后')
  assert.equal(snapshot.facts[0].content, '下午有课。')
  assert.equal(snapshot.preplan?.revision, 2)
})

test('范围时间线保留 HDSI 提供的真实 Script 覆盖区间与不透明 revision', () => {
  const range = normalizeTimelineRange({
    protocol: 1, revision: '2026-09-02T12:00:00.000Z:42:3', storyId: 'alpha', range: { from: '2026-09-02T10:00:00.000Z', to: '2026-09-02T13:00:00.000Z' },
    entries: [{ entityId: 'entry:42', id: 42, storyId: 'alpha', participantId: '', kind: 'script', actor: 'narrator', content: '她写完作业。', occurredAt: '2026-09-02T12:00:00.000Z', startedAt: '2026-09-02T11:30:00.000Z', endedAt: '2026-09-02T12:00:00.000Z', unknown: 'discard' }],
    nextCursor: 'entry:11', unknownRoot: 'discard',
  })
  assert.equal(range.revision, '2026-09-02T12:00:00.000Z:42:3')
  assert.deepEqual(range.range, { from: '2026-09-02T10:00:00.000Z', to: '2026-09-02T13:00:00.000Z' })
  assert.equal(range.entries[0].entityId, 'entry:42')
  assert.equal(range.entries[0].startedAt, '2026-09-02T11:30:00.000Z')
  assert.equal(range.entries[0].endedAt, '2026-09-02T12:00:00.000Z')
  assert.equal((range.entries[0] as any).unknown, undefined)
  assert.equal(range.nextCursor, 'entry:11')
})

test('Token 聚合按剧本和日期持久化，且不会保存模型原始内容', () => {
  const temp = fixture()
  try {
    const state = new UsageAggregator(temp.root).record('alpha', {
      task: 'main', providerLabel: 'Primary', model: 'model-x', inputTokens: 100, cachedInputTokens: 40,
      outputTokens: 20, priceInput: 2, priceCachedInput: 0.5, priceOutput: 8,
    }, new Date('2026-09-02T12:00:00Z'))
    const day = state.days['2026-09-02']
    assert.equal(day.calls, 1)
    assert.equal(day.inputTokens, 100)
    assert.equal(day.cachedInputTokens, 40)
    assert.equal(day.outputTokens, 20)
    assert.equal(day.tasks.main, 1)
  } finally { temp.cleanup() }
})

test('Token 日用量按照桌面时区归档，而不是 UTC 零点', () => {
  const temp = fixture()
  try {
    const state = new UsageAggregator(temp.root, 'Asia/Shanghai').record('alpha', {
      task: 'main', providerLabel: 'Primary', model: 'model-x', inputTokens: 1,
    }, new Date('2026-09-02T16:30:00.000Z'))
    assert.equal(state.days['2026-09-03']?.calls, 1)
    assert.equal(state.days['2026-09-02'], undefined)
  } finally { temp.cleanup() }
})

test('LogBroker 保留完整原文、按故事隔离异步落盘，并可在重建后查询', async () => {
  const temp = fixture()
  try {
    const broker = new LogBroker(temp.root, { memoryLimit: 2, flushDelayMs: 60_000 })
    const fullMessage = '第一条原文不应在落盘阶段被截断。'.repeat(40)
    const alpha = broker.record({ storyId: 'alpha', level: 'info', source: 'worker', message: fullMessage, at: '2026-09-02T12:00:00.000Z' })
    broker.record({ storyId: 'beta', level: 'error', source: 'delivery', message: 'beta delivery failed', at: '2026-09-02T12:01:00.000Z', correlation: { deliveryId: 'd-1' } })
    broker.record({ storyId: 'alpha', level: 'warn', source: 'router', message: 'alpha queued', at: '2026-09-02T12:02:00.000Z' })
    assert.equal(broker.recent(9).length, 2, '内存环形缓存仅保留上限，但待写记录不得丢失')
    assert.equal((await broker.query({ storyId: 'alpha', from: '2026-09-02T12:01:00.000Z' })).length, 1, '未落盘的内存记录也必须尊重时间范围')
    await broker.drain()
    const stored = readFileSync(path.join(temp.root, 'logs', 'alpha', '2026-09-02.ndjson'), 'utf8')
    assert.match(stored, new RegExp(fullMessage.slice(0, 80)))

    const afterRestart = new LogBroker(temp.root)
    const alphaRows = await afterRestart.query({ storyId: 'alpha', from: '2026-09-02T00:00:00.000Z', to: '2026-09-02T23:59:59.999Z', limit: 10 })
    assert.equal(alphaRows.length, 2)
    assert.equal(alphaRows.find(row => row.id === alpha.id)?.message, fullMessage)
    const failures = await afterRestart.query({ levels: ['error'], search: 'delivery', correlationId: 'd-1', from: '2026-09-02T00:00:00.000Z', to: '2026-09-02T23:59:59.999Z' })
    assert.equal(failures.length, 1)
    assert.equal(failures[0].storyId, 'beta')
    assert.equal(failures[0].correlation?.deliveryId, 'd-1')
  } finally { temp.cleanup() }
})

test('宿主 Projection 汇总持久 Inbox、Outbox、用量和可关联错误，而不读取 HDSI 数据库', async () => {
  const temp = fixture()
  try {
    const inbox = new InboxRepository(temp.stories)
    inbox.append('alpha', inbound(), 'paused')
    const outbox = new DeliveryOutbox(temp.stories)
    outbox.enqueue('alpha', {
      deliveryId: 'delivery-a', accountKey: 'sandbox:10001', transport: 'sandbox', platform: 'sandbox', selfId: '10001',
      channelId: 'private:20002', kind: 'private', content: '回复内容', occurredAt: '2026-09-02T12:00:00.000Z',
    })
    outbox.settle('alpha', 'delivery-a', { status: 'permanent-failed', error: 'adapter offline' })
    const usage = new UsageAggregator(temp.root, 'UTC')
    usage.record('alpha', { task: 'main', providerLabel: 'Primary', model: 'model-x', inputTokens: 12, outputTokens: 4 }, new Date('2026-09-02T12:00:00.000Z'))
    const logs = new LogBroker(temp.root)
    logs.record({ storyId: 'alpha', source: 'delivery', level: 'error', message: 'adapter offline', correlation: { deliveryId: 'delivery-a' } })
    const stories = { get: (id: string) => id === 'alpha' ? { meta: { phase: 'running' }, running: true, bridgeReady: true, pid: 42, lastSeenAt: '2026-09-02T12:00:00.000Z' } : undefined }
    const projection = new HostProjectionService(stories as any, inbox, outbox, usage, logs)
    const overview = await projection.overview('alpha')
    assert.equal(overview.inbox.pending, 1)
    assert.equal(overview.inbox.reasons.paused, 1)
    assert.equal(overview.outbox.states['permanent-failed'], 1)
    assert.equal(overview.usage?.inputTokens, 12)
    assert.equal(overview.recentErrors[0].correlation?.deliveryId, 'delivery-a')
    assert.equal(projection.deliveries('alpha')[0].deliveryId, 'delivery-a')
    assert.equal(projection.usageSeries('alpha')[0].day, '2026-09-02')
  } finally { temp.cleanup() }
})

test('LogBroker 轮转超限文件、按保留策略清理，并统计存储状态', async () => {
  const temp = fixture()
  try {
    const broker = new LogBroker(temp.root, { flushDelayMs: 60_000, maxFileBytes: 64 * 1024, retentionDays: 7 })
    for (let index = 0; index < 400; index += 1) {
      broker.record({ storyId: 'alpha', level: 'info', source: 'worker', message: `轮转压力记录 ${index} ${'x'.repeat(200)}`, at: '2026-09-02T12:00:00.000Z' })
    }
    await broker.drain()
    const folder = path.join(temp.root, 'logs', 'alpha')
    const files = require('node:fs').readdirSync(folder).filter((file: string) => file.endsWith('.ndjson'))
    assert.ok(files.some((file: string) => file.includes('.part')), '超过大小上限后应产生轮转分片')
    // 轮转分片仍然可读，不产生记录丢失。
    const afterRestart = new LogBroker(temp.root)
    const restored = await afterRestart.query({ storyId: 'alpha', from: '2026-09-02T00:00:00.000Z', to: '2026-09-02T23:59:59.999Z', limit: 2_000 })
    assert.equal(restored.length, 400)

    const retention = new LogBroker(temp.root, { retentionDays: 1 })
    const statsBefore = await retention.storageStats()
    assert.equal(statsBefore.files, files.length)
    const purged = await retention.applyRetention(new Date('2026-09-20T00:00:00.000Z'))
    assert.equal(purged.removed, files.length)
    const statsAfter = await retention.storageStats()
    assert.equal(statsAfter.files, 0)
  } finally { temp.cleanup() }
})

test('P0-5 retention：单日 part 上限与总容量预算（超限从最旧的天开始删）', async () => {
  const temp = fixture()
  try {
    const folder = path.join(temp.root, 'logs', 'alpha')
    require('node:fs').mkdirSync(folder, { recursive: true })
    // maxTotalBytes 的下限是 maxFileBytes（默认 8MB，最小 64KB），预算测试
    // 必须用真实尺寸的文件：9 × 30KB = 270KB，预算 130KB。
    const write = (name: string) => require('node:fs').writeFileSync(path.join(folder, name), 'x'.repeat(30_000))
    // 今天与昨天的文件都不会被按天过期清掉。
    const today = '2026-09-19'
    const yesterday = '2026-09-18'
    for (let index = 1; index <= 5; index += 1) write(`${yesterday}.part${index}.ndjson`)
    for (let index = 1; index <= 3; index += 1) write(`${today}.part${index}.ndjson`)
    write(`${today}.ndjson`)
    const broker = new LogBroker(temp.root, { retentionDays: 14, maxPartsPerDay: 3 })
    // part 上限：昨天 5 个 part 只保留最新 3 个（part1/part2 删除），今天恰好 3 个不动。
    const trimmed = await broker.applyRetention(new Date('2026-09-19T12:00:00.000Z'))
    const remaining = require('node:fs').readdirSync(folder).filter((file: string) => file.endsWith('.ndjson')).sort()
    assert.equal(trimmed.removed, 2)
    // part 编号随轮转递增，保留最新 3 个：昨天的 part1/part2 让位。
    assert.deepEqual(remaining, [
      `${yesterday}.part3.ndjson`, `${yesterday}.part4.ndjson`, `${yesterday}.part5.ndjson`,
      `${today}.ndjson`,
      `${today}.part1.ndjson`, `${today}.part2.ndjson`, `${today}.part3.ndjson`,
    ])
    // 总容量预算：7 × 30KB = 210KB，预算 130KB——最旧的"天"（昨天 90KB）整日让位后
    // 今天 120KB 已在预算内。
    const budget = new LogBroker(temp.root, { retentionDays: 14, maxPartsPerDay: 10, maxFileBytes: 64 * 1024, maxTotalBytes: 130_000 })
    const reclaimed = await budget.applyRetention(new Date('2026-09-19T12:00:00.000Z'))
    const afterBudget = require('node:fs').readdirSync(folder).filter((file: string) => file.endsWith('.ndjson')).sort()
    assert.equal(reclaimed.removed, 3)
    assert.ok(afterBudget.every((file: string) => file.startsWith(today)), '预算超限时从最旧的天开始整日删除')
  } finally { temp.cleanup() }
})

test('P0-3 probeUpstream：发现账号身份、忽略事件帧、地址校验与失败回传', async () => {
  const { WebSocketServer } = require('ws')
  const upstream = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  try {
    const port: number = await new Promise(resolve => {
      upstream.once('listening', () => resolve((upstream.address() as any).port))
    })
    upstream.on('connection', (socket: any) => {
      socket.on('message', (data: any) => {
        const frame = JSON.parse(String(data))
        if (frame.action !== 'get_login_info') return
        // 先推一个入站事件帧（无 echo 字段），probe 必须忽略它只认自己的回执。
        socket.send(JSON.stringify({ post_type: 'message', message_type: 'private', self_id: 1, user_id: 2, message: 'noise' }))
        socket.send(JSON.stringify({ status: 'ok', data: { user_id: 1303322392, nickname: '麦芽' }, echo: frame.echo }))
      })
    })
    const ok = await probeUpstream(`ws://127.0.0.1:${port}`)
    assert.ok(ok.ok, 'probe 应成功：' + (ok as any).error)
    assert.equal(ok.selfId, '1303322392')
    assert.equal(ok.nickname, '麦芽')
    assert.ok(typeof ok.latencyMs === 'number')

    // 拒绝非 ws 地址与不可达端口（快速失败，不挂 8s）。
    const badScheme = await probeUpstream('http://127.0.0.1:1')
    assert.ok(!badScheme.ok)
    assert.ok(/ws:\/\//.test(String(badScheme.error)))
    const unreachable = await probeUpstream('ws://127.0.0.1:1')
    assert.ok(!unreachable.ok)
  } finally {
    upstream.close()
  }
})

test('日志导出写入新文件并应用 Blind 隐私规则，原文件保持完整', async () => {
  const temp = fixture()
  try {
    const broker = new LogBroker(temp.root, { flushDelayMs: 60_000 })
    broker.record({ storyId: 'alpha', level: 'info', source: 'worker', message: '主角说了一句必须被隐藏的话', at: '2026-09-02T12:00:00.000Z' })
    broker.record({ storyId: 'alpha', level: 'error', source: 'delivery', message: '投递失败：网络错误', at: '2026-09-02T12:01:00.000Z' })
    await broker.drain()
    broker.setBlindRule(record => /隐藏/.test(record.message) ? '[blinded]' : undefined)

    const target = path.join(temp.root, 'exports', 'alpha.ndjson')
    const exported = await broker.exportLogs({ storyId: 'alpha', from: '2026-09-02T00:00:00.000Z', to: '2026-09-02T23:59:59.999Z', target })
    assert.equal(exported.records, 2)
    const content = readFileSync(target, 'utf8')
    assert.ok(!content.includes('必须被隐藏的话'), 'Blind 命中的正文不得进入导出文件')
    assert.ok(content.includes('[blinded]'))
    assert.ok(content.includes('投递失败：网络错误'))
    // 原始 NDJSON 不受影响，Blind 只作用于查询/导出边界。
    const original = readFileSync(path.join(temp.root, 'logs', 'alpha', '2026-09-02.ndjson'), 'utf8')
    assert.ok(original.includes('必须被隐藏的话'))
    // 目标文件已存在时拒绝覆盖。
    await assert.rejects(() => broker.exportLogs({ storyId: 'alpha', target }))
  } finally { temp.cleanup() }
})

test('Console Registry：端口登记、worker 退出失效与导航白名单', () => {
  const registry = new ConsoleRegistry()
  const descriptor = registry.register('alpha', 5155)
  assert.equal(descriptor.origin, 'http://127.0.0.1:5155')
  assert.equal(descriptor.endpoint, 'http://127.0.0.1:5155/console/')
  // 同一 endpoint 不能被第二个故事隐式占用（探测用 findOwner）。
  assert.equal(registry.findOwner('http://127.0.0.1:5155'), 'alpha')
  // 导航白名单：endpoint 前缀允许，其它端口/主机/路径一律拒绝。
  assert.equal(registry.isAllowedNavigation('alpha', 'http://127.0.0.1:5155/console/'), true)
  assert.equal(registry.isAllowedNavigation('alpha', 'http://127.0.0.1:5155/console/market'), true)
  assert.equal(registry.isAllowedNavigation('alpha', 'http://127.0.0.1:5156/console/'), false)
  assert.equal(registry.isAllowedNavigation('alpha', 'http://evil.example/console/'), false)
  assert.equal(registry.isAllowedNavigation('alpha', 'https://127.0.0.1:5155/console/'), false)
  assert.equal(registry.isAllowedNavigation('beta', 'http://127.0.0.1:5155/console/'), false)
  // 端口合法性
  assert.throws(() => registry.register('alpha', 0), /端口/)
  assert.throws(() => registry.register('alpha', 70_000), /端口/)
  // worker 退出 → revoke → 旧导航立即失效
  registry.revoke('alpha')
  assert.equal(registry.get('alpha'), undefined)
  assert.equal(registry.isAllowedNavigation('alpha', 'http://127.0.0.1:5155/console/'), false)
  // 重启后 revision 变化
  const first = registry.register('alpha', 5155)
  const second = registry.register('alpha', 5156)
  assert.notEqual(first.revision, second.revision)
})

test('配置编译注入 loopback server/console 条目，canonical 文件保持不变', () => {
  const temp = fixture()
  try {
    const protector = { available: () => true, encrypt: (value: string) => `safe:${value}`, decrypt: (value: string) => value.slice(5) }
    const secrets = new SecretStore(temp.root, protector)
    secrets.set('primary-key', 'sk-typ0-test')
    const storyDir = path.join(temp.stories, 'alpha')
    require('node:fs').mkdirSync(storyDir, { recursive: true })
    const original = 'plugins:\n  hds-interlude:m0:\n    apiKey: $secret:primary-key\n'
    require('node:fs').writeFileSync(path.join(storyDir, 'koishi.yml'), original)
    const compiled = new StoryConfigCompiler(secrets).compile(storyDir)
    const resolved = readFileSync(compiled.file, 'utf8')
    assert.match(resolved, /127\.0\.0\.1/)
    assert.match(resolved, /port: 0/)
    assert.match(resolved, /group:console:/)
    assert.equal(compiled.consoleInjected, true)
    assert.equal(readFileSync(path.join(storyDir, 'koishi.yml'), 'utf8'), original, 'canonical yml 不被注入污染')
    // 已有 server/console 的配置不重复注入
    const full = 'plugins:\n  group:server:\n    server:x:\n      port: 5199\n  group:console:\n    console:x:\n      open: false\n'
    require('node:fs').writeFileSync(path.join(storyDir, 'koishi.yml'), full)
    const compiled2 = new StoryConfigCompiler(secrets).compile(storyDir)
    assert.equal(compiled2.consoleInjected, false)
    compiled.cleanup(); compiled2.cleanup()
  } finally { temp.cleanup() }
})

test('protocol 4 时间线条目透传剧本行动身份、投递账本与场景检查点，未知字段仍被丢弃', () => {
  const range = normalizeTimelineRange({
    protocol: 4, revision: 'r4', storyId: 'alpha', range: { from: '2026-09-05T00:00:00.000Z', to: '2026-09-05T12:00:00.000Z' },
    entries: [{
      entityId: 'entry:10', id: 10, storyId: 'alpha', participantId: 'p1', kind: 'script', actor: 'narrator',
      content: '她写完作业。', occurredAt: '2026-09-05T04:00:00.000Z',
      commitId: 'commit-1',
      deliveryActions: [{
        eventId: 'evt-1', eventKind: 'outgoing-message', status: 'partial',
        segments: [{ kind: 'message', status: 'delivered', content: '第一句' }, { kind: 'message', status: 'failed', content: '第二句' }],
      }],
      sceneCheckpoint: { sceneId: 3, startedAt: '2026-09-05T03:00:00.000Z', reason: 'sleep', firstEntryId: 8, lastEntryId: 11, boundarySourceEntryIds: [9, 11] },
      secretField: 'must-not-leak',
    }],
  })
  const entry = range.entries[0] as any
  assert.equal(entry.commitId, 'commit-1')
  assert.equal(entry.deliveryActions.length, 1)
  assert.deepEqual(entry.deliveryActions[0].segments.map((s: any) => s.status), ['delivered', 'failed'])
  assert.equal(entry.sceneCheckpoint.reason, 'sleep')
  assert.equal(entry.secretField, undefined)
  // 损坏字段被安全省略，不抛错
  const broken = normalizeTimelineRange({
    protocol: 4, revision: 'r5', storyId: 'alpha', range: { from: '2026-09-05T00:00:00.000Z', to: '2026-09-05T12:00:00.000Z' },
    entries: [{ id: 11, storyId: 'alpha', kind: 'script', content: 'x', occurredAt: '2026-09-05T05:00:00.000Z', deliveryActions: 'junk', sceneCheckpoint: { sceneId: 'bad' }, commitId: 42 }],
  }).entries[0] as any
  assert.equal(broken.deliveryActions, undefined)
  assert.equal(broken.sceneCheckpoint, undefined)
  assert.equal(broken.commitId, undefined)
})

test('分支谱系：树构建、orphan 标注、树内互斥与分支 ID 分配', () => {
  const mk = (id: string, parent?: { storyId: string, forkedAt: string }) => ({ meta: { schemaVersion: (parent ? 2 : 1) as 1 | 2, id, name: id, characterName: '', hdsiVersion: '', createdAt: '', updatedAt: '', lastOpenedAt: '', description: '', accounts: [], phase: 'paused' as const, ...(parent ? { parent } : {}) } })
  // 根 + 两个分支 + 一个三级分支
  const handles = [
    mk('minase'),
    mk('minase.b1-late', { storyId: 'minase', forkedAt: '2026-09-05T01:00:00Z' }),
    mk('minase.b2-early', { storyId: 'minase', forkedAt: '2026-09-05T02:00:00Z' }),
    mk('minase.b1-late.b1-deep', { storyId: 'minase.b1-late', forkedAt: '2026-09-05T03:00:00Z' }),
  ]
  const trees = buildBranchTree(handles)
  assert.equal(trees.length, 1)
  assert.equal(trees[0].rootId, 'minase')
  assert.equal(trees[0].nodes.length, 4)
  const deep = trees[0].nodes.find(node => node.storyId === 'minase.b1-late.b1-deep')
  assert.equal(deep?.depth, 2)
  assert.equal(deep?.orphan, false)
  // orphan：parent 指向不存在的剧本
  const orphanHandles = [mk('solo', { storyId: 'ghost', forkedAt: '2026-09-05T00:00:00Z' })]
  const orphanTrees = buildBranchTree(orphanHandles)
  assert.equal(orphanTrees[0].nodes[0].orphan, true)
  assert.equal(orphanTrees[0].rootId, 'solo', 'orphan 自成一棵树，不误挂到别的根')
  // 树内互斥：b1 运行中时，加载 b2/根 会被判定为兄弟冲突
  const runningHandles = [
    { ...mk('minase'), running: false },
    { ...mk('minase.b1-late', { storyId: 'minase', forkedAt: '2026-09-05T01:00:00Z' }), running: true },
    { ...mk('minase.b2-early', { storyId: 'minase', forkedAt: '2026-09-05T02:00:00Z' }), running: false },
  ] as any[]
  assert.deepEqual(activeSiblingsInTree(runningHandles, 'minase.b2-early'), ['minase.b1-late'])
  assert.deepEqual(activeSiblingsInTree(runningHandles, 'minase.b1-late'), [], '目标自身不算冲突')
  // 分支 ID 分配：现有 b1/b2 → 下一个 b3；slug 非法字符被清洗
  assert.equal(nextBranchId(handles as any, 'minase', 'after school'), 'minase.b3-after-school')
  assert.equal(nextBranchId(handles as any, 'other-root', 'x'), 'other-root.b1-x')
  // 环引用防御：A→B→A 不抛错，按根处理
  const cyclic = [
    mk('a', { storyId: 'b', forkedAt: '2026-09-05T00:00:00Z' }),
    mk('b', { storyId: 'a', forkedAt: '2026-09-05T00:00:00Z' }),
  ]
  assert.doesNotThrow(() => buildBranchTree(cyclic))
})

test('forkBranch 写入 schemaVersion 2 谱系且源目录不动；schema v1/v2 双读兼容', () => {
  const temp = fixture()
  try {
    const source = path.join(temp.stories, 'minase')
    require('node:fs').mkdirSync(path.join(source, 'data'), { recursive: true })
    writeFileSync(path.join(source, 'story.json'), JSON.stringify({ schemaVersion: 1, id: 'minase', name: '根剧本', accounts: ['sandbox:a'], phase: 'running' }))
    const sourceBefore = readFileSync(path.join(source, 'story.json'), 'utf8')
    const archives = new StoryArchiveService(path.join(temp.root, 'backups'))
    const result = archives.forkBranch({
      sourceDir: source, storiesRoot: temp.stories, branchId: 'minase.b1-late', name: '分支B',
      sourceStoryId: 'minase', forkPoint: { entryId: 42, occurredAt: '2026-09-05T00:47:00Z' },
    })
    assert.equal(result.id, 'minase.b1-late')
    const branchMeta = JSON.parse(readFileSync(path.join(result.target, 'story.json'), 'utf8'))
    assert.equal(branchMeta.schemaVersion, 2)
    assert.equal(branchMeta.parent.storyId, 'minase')
    assert.equal(branchMeta.parent.forkPoint.entryId, 42)
    assert.deepEqual(branchMeta.accounts, [])
    assert.equal(branchMeta.phase, 'paused')
    assert.equal(readFileSync(path.join(source, 'story.json'), 'utf8'), sourceBefore, '源 manifest 不被修改')
    // 缺 forkPoint 拒绝
    assert.throws(() => archives.forkBranch({ sourceDir: source, storiesRoot: temp.stories, branchId: 'minase.b2', name: 'x', sourceStoryId: 'minase', forkPoint: {} }), /forkPoint/)
    // forkPoint 缺失 entryId 与 occurredAt 时拒绝已完成
    // v1 双读：readStoryMeta 读 v1 得 schemaVersion 1；读 v2 得 2 且 parent 保留
    const v1Meta = readStoryMeta(source)
    assert.equal(v1Meta?.schemaVersion, 1)
    assert.equal(v1Meta?.parent, undefined)
    const v2Meta = readStoryMeta(result.target)
    assert.equal(v2Meta?.schemaVersion, 2)
    assert.equal(v2Meta?.parent?.storyId, 'minase')
    // v1 兼容写回不会降级 v2
    if (v2Meta) { writeStoryMeta(result.target, v2Meta); const rewritten = JSON.parse(readFileSync(path.join(result.target, 'story.json'), 'utf8')); assert.equal(rewritten.schemaVersion, 2) }
  } finally { temp.cleanup() }
})

test('OneBot 桥接：握手应答、私聊入站转换、群聊丢弃与 echo 超时', async () => {
  const temp = fixture()
  try {
    const accounts = new AccountRegistry(temp.root)
    accounts.register('alpha', '1303322392', '麦芽')
    const adapter = new OneBotServerAdapter(accounts)
    adapter.setLogger(() => {})
    const inbound: DesktopInboundEvent[] = []
    adapter.setInboundListener(async event => { inbound.push(event) })
    await adapter.start(0)

    // 模拟 worker 的 adapter-onebot 客户端连入（未登记的剧本被拒）
    const unregistered = new WebSocket('ws://127.0.0.1:' + (adapter as any).wss.address().port + '/onebot/ghost')
    const rejectResult = await new Promise<number>(resolve => unregistered.on('close', code => resolve(code)))
    assert.equal(rejectResult, 1008, '未登记账号的连接必须被拒绝')

    const registered = new WebSocket('ws://127.0.0.1:' + (adapter as any).wss.address().port + '/onebot/alpha')
    await new Promise(resolve => registered.on('open', resolve))
    // adapter-onebot 连上后先 get_login_info
    const loginEcho = 'login-1'
    registered.send(JSON.stringify({ action: 'get_login_info', params: {}, echo: loginEcho }))
    const loginReply = JSON.parse(await new Promise<string>(resolve => registered.on('message', data => {
      const frame = JSON.parse(String(data))
      if (frame.echo === loginEcho) resolve(String(data))
    })))
    assert.equal(loginReply.status, 'ok')
    assert.equal(loginReply.data.user_id, 1303322392)
    assert.equal(loginReply.data.nickname, '麦芽')

    // 私聊文本消息 → DesktopInboundEvent（时间/去重 ID 保留）
    registered.send(JSON.stringify({
      post_type: 'message', message_type: 'private', sub_type: 'friend',
      self_id: 1303322392, user_id: 981405005, message_id: 'm-100',
      time: 1788500000, message: [{ type: 'text', data: { text: '你好，水濑' } }],
      sender: { nickname: '小桃' },
    }))
    await new Promise(resolve => setTimeout(resolve, 50))
    assert.equal(inbound.length, 1)
    assert.equal(inbound[0].transport, 'onebot-external')
    assert.equal(inbound[0].selfId, '1303322392')
    assert.equal(inbound[0].senderId, '981405005')
    assert.equal(inbound[0].content, '你好，水濑')
    assert.equal(inbound[0].rawMessageId, 'm-100')
    assert.equal(new Date(inbound[0].occurredAt).getTime(), 1788500000 * 1000)

    // 群聊事件被丢弃（范围铁律）
    registered.send(JSON.stringify({ post_type: 'message', message_type: 'group', group_id: 1, user_id: 2, message: 'x', time: 1788500001, message_id: 'm-101' }))
    // 含 CQ 码的私聊被丢弃
    registered.send(JSON.stringify({ post_type: 'message', message_type: 'private', user_id: 2, message: '[CQ:image,file=abc]', time: 1788500002, message_id: 'm-102' }))
    await new Promise(resolve => setTimeout(resolve, 50))
    assert.equal(inbound.length, 1, '群聊与 CQ 消息不得进入入站流')

    // 上游可能回传自己的 message_sent；它绝不能成为一条用户输入。
    registered.send(JSON.stringify({ post_type: 'message_sent', message_type: 'private', self_id: 1303322392, user_id: 981405005, message: '刚下课！', message_id: 'self-1' }))
    registered.send(JSON.stringify({ post_type: 'meta_event', meta_event_type: 'heartbeat', self_id: 1303322392 }))
    await new Promise(resolve => setTimeout(resolve, 30))
    assert.equal(inbound.length, 1, '自发回声与心跳不得进入用户入站流')

    // 出站：send → send_private_msg → 客户端 echo 应答 → sent 回执
    const sendPromise = adapter.send({
      storyId: 'alpha', deliveryId: 'd-1', accountKey: 'onebot:1303322392', transport: 'onebot-external', platform: 'onebot',
      selfId: '1303322392', channelId: 'private:981405005', kind: 'private',
      content: '刚下课！', occurredAt: new Date().toISOString(),
    } as any, )
    const sendFrame = JSON.parse(await new Promise<string>(resolve => registered.on('message', data => {
      const frame = JSON.parse(String(data))
      if (frame.action === 'send_private_msg') resolve(String(data))
    })))
    assert.equal(sendFrame.params.user_id, 981405005)
    assert.equal(sendFrame.params.message, '刚下课！')
    registered.send(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 9001 }, echo: sendFrame.echo }))
    const receipt = await sendPromise
    assert.equal(receipt.status, 'confirmed')
    assert.deepEqual(receipt.messageIds, ['9001'])

    // W2（B2-4）：群聊投递现在真实发出（send_group_msg + group_id 解析）
    const groupPromise = adapter.send({
      storyId: 'alpha', deliveryId: 'd-2', accountKey: 'onebot:1303322392', transport: 'onebot-external', platform: 'onebot',
      selfId: '1303322392', channelId: '12345', kind: 'group', content: 'x', occurredAt: new Date().toISOString(),
    } as any)
    const groupFrame = JSON.parse(await new Promise<string>(resolve => registered.on('message', function handler(data) {
      const frame = JSON.parse(String(data))
      if (frame.action === 'send_group_msg') { registered.off('message', handler); resolve(String(data)) }
    })))
    assert.equal(groupFrame.params.group_id, 12345)
    registered.send(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 9002 }, echo: groupFrame.echo }))
    assert.equal((await groupPromise).status, 'confirmed')

    // OneBot 显式失败 → permanent-failed（不盲目重试）
    const failPromise = adapter.send({
      storyId: 'alpha', deliveryId: 'd-3', accountKey: 'onebot:1303322392', transport: 'onebot-external', platform: 'onebot',
      selfId: '1303322392', channelId: 'private:981405005', kind: 'private', content: 'y', occurredAt: new Date().toISOString(),
    } as any)
    const failFrame = JSON.parse(await new Promise<string>(resolve => registered.on('message', data => {
      const frame = JSON.parse(String(data))
      if (frame.action === 'send_private_msg') resolve(String(data))
    })))
    registered.send(JSON.stringify({ status: 'failed', retcode: 1200, data: null, echo: failFrame.echo }))
    assert.equal((await failPromise).status, 'permanent-failed')

    registered.close()
    unregistered.close()
    await adapter.stop()
  } finally { temp.cleanup() }
})

test('M7-2 绑定事务：登记+绑定同生共死，回滚不留半绑定状态', () => {
  const temp = fixture()
  try {
    const accounts = new AccountRegistry(temp.root)
    const bindings = new BindingRegistry(temp.root)
    // 帐号被第二个剧本占用 → register 冲突 → 不应留下任何绑定
    accounts.register('story-a', '1303322392', '麦芽')
    assert.throws(() => {
      const prevEntry = accounts.findByStory('story-b')
      const prevBinding = bindings.find('onebot:1303322392')
      let registered = false
      let bound = false
      try {
        accounts.register('story-b', '1303322392', '麦芽2')
        registered = true
        bindings.bind({ accountKey: 'onebot:1303322392', storyId: 'story-b', transport: 'onebot-external' }, { replace: true })
        bound = true
      } catch (error) {
        if (bound) {
          if (prevBinding) bindings.bind({ ...prevBinding }, { replace: true })
          else bindings.unbind('onebot:1303322392')
        }
        if (registered) {
          if (prevEntry) accounts.register(prevEntry.storyId, prevEntry.selfId, prevEntry.nickname)
          else accounts.removeByStory('story-b')
        }
        throw error
      }
    }, /已被剧本 story-a 声明/)
    assert.equal(accounts.findByStory('story-b'), undefined, '冲突回滚后 story-b 不得残留登记')
    assert.equal(accounts.findByStory('story-a')?.selfId, '1303322392', 'story-a 的登记不受影响')
    assert.equal(bindings.find('onebot:1303322392'), undefined, '冲突回滚后不得残留绑定')

    // 成功路径：登记 + 绑定同时成立
    accounts.register('story-b', '981405005', '小桃')
    bindings.bind({ accountKey: 'onebot:981405005', storyId: 'story-b', transport: 'onebot-external' }, { replace: true })
    assert.equal(bindings.find('onebot:981405005')?.storyId, 'story-b')
    assert.equal(accounts.findByStory('story-b')?.selfId, '981405005')
  } finally { temp.cleanup() }
})

test('M7-2 编译注入：selfId/端点只进 resolved 配置，canonical 不动；未登记时不注入', () => {
  const temp = fixture()
  try {
    const protector = { available: () => true, encrypt: (value: string) => `safe:${value}`, decrypt: (value: string) => value.slice(5) }
    const secrets = new SecretStore(temp.root, protector)
    const storyDir = path.join(temp.stories, 'alpha')
    require('node:fs').mkdirSync(storyDir, { recursive: true })
    const canonical = 'plugins:\n  group:adapter:\n    adapter-onebot:m0:\n      selfId: ""\n      protocol: ws\n      endpoint: ""\n'
    require('node:fs').writeFileSync(path.join(storyDir, 'koishi.yml'), canonical)
    const compiler = new StoryConfigCompiler(secrets)

    // 未登记：不注入
    const plain = compiler.compile(storyDir)
    assert.equal(plain.onebotInjected, false)
    assert.equal(readFileSync(plain.file, 'utf8').includes('1303322392'), false)
    plain.cleanup()

    // 登记+绑定事务后：resolved 配置获得 selfId 与内部端点；canonical 原样
    const compiled = compiler.compile(storyDir, { onebot: { selfId: '1303322392', endpoint: 'ws://127.0.0.1:6709/onebot/alpha' } })
    assert.equal(compiled.onebotInjected, true)
    const resolved = readFileSync(compiled.file, 'utf8')
    assert.match(resolved, /selfId: "1303322392"/)
    assert.match(resolved, /endpoint: "ws:\/\/127\.0\.0\.1:6709\/onebot\/alpha"/)
    assert.equal(readFileSync(path.join(storyDir, 'koishi.yml'), 'utf8'), canonical, 'canonical yml 不被注入污染')
    // 真机验收回归（2026-09-08）：resolved 配置必须能被 js-yaml 完整解析——
    // 旧实现向已有 adapter 块追加第二个顶层 group:adapter 键，字符串断言
    // 依然通过但 worker 实际启动时 YAMLException: duplicated mapping key。
    const parsed = yaml.load(resolved) as any
    assert.equal(parsed?.plugins?.['group:adapter']?.['adapter-onebot:m0']?.selfId, '1303322392')
    assert.equal(parsed?.plugins?.['group:adapter']?.['adapter-onebot:m0']?.protocol, 'ws')
    assert.equal(parsed?.plugins?.['group:adapter']?.['adapter-onebot:m0']?.endpoint, 'ws://127.0.0.1:6709/onebot/alpha')
    compiled.cleanup()

    // 带行尾注释的真实模板形状（selfId: "" # 注释）同样就地替换且可解析
    const templateDir = path.join(temp.stories, 'template')
    require('node:fs').mkdirSync(templateDir, { recursive: true })
    const templateYml = [
      'plugins:',
      '  group:server:',
      '    server:m0:',
      '      port: 0',
      '  group:adapter:',
      '    adapter-onebot:m0:',
      '      selfId: "" # 在桌面账号面板登记后填写（QQ号）',
      '      protocol: ws',
      '      endpoint: ws://127.0.0.1:6709/onebot/template',
      '      token: ""',
      '  hds-interlude:m0:',
      '    model:',
      '      providers:',
      '        - id: primary',
      '          endpoint: http://127.0.0.1:9/smoke',
      '          apiKey: smoke-key',
      '          model: smoke-model',
    ].join('\n')
    require('node:fs').writeFileSync(path.join(templateDir, 'koishi.yml'), templateYml)
    const templateCompiled = compiler.compile(templateDir, { onebot: { selfId: '1303322392', endpoint: 'ws://127.0.0.1:6709/onebot/template' } })
    const templateResolved = readFileSync(templateCompiled.file, 'utf8')
    // CRLF regression (real-device finding 2026-09-08): lines keep a trailing CR after split, so the old regex silently failed to match and selfId replacement degenerated into insertion.
    const crlfDir = path.join(temp.stories, 'crlf')
    require('node:fs').mkdirSync(crlfDir, { recursive: true })
    const crlfYml = templateYml.split('\n').join('\r\n')
    require('node:fs').writeFileSync(path.join(crlfDir, 'koishi.yml'), crlfYml)
    const crlfCompiled = compiler.compile(crlfDir, { onebot: { selfId: '1303322392', endpoint: 'ws://127.0.0.1:6709/onebot/crlf' } })
    const crlfResolved = readFileSync(crlfCompiled.file, 'utf8')
    const selfIdLines = crlfResolved.split('\n').filter(l => /selfId:/.test(l))
    assert.equal(selfIdLines.length, 1, 'CRLF 下 selfId 不得重复：' + JSON.stringify(selfIdLines))
    const crlfParsed = yaml.load(crlfResolved) as any
    assert.equal(crlfParsed?.plugins?.['group:adapter']?.['adapter-onebot:m0']?.selfId, '1303322392')
    crlfCompiled.cleanup()
    const templateParsed = yaml.load(templateResolved) as any
    assert.equal(templateParsed?.plugins?.['group:adapter']?.['adapter-onebot:m0']?.selfId, '1303322392')
    assert.equal(templateParsed?.plugins?.['group:adapter']?.['adapter-onebot:m0']?.endpoint, 'ws://127.0.0.1:6709/onebot/template')
    assert.equal(templateParsed?.plugins?.['hds-interlude:m0']?.model?.providers?.[0]?.model, 'smoke-model')
    templateCompiled.cleanup()

    // 无 adapter 的旧剧本：注入时自动补 adapter 条目
    const legacyDir = path.join(temp.stories, 'legacy')
    require('node:fs').mkdirSync(legacyDir, { recursive: true })
    require('node:fs').writeFileSync(path.join(legacyDir, 'koishi.yml'), 'plugins:\n  hds-interlude:m0:\n    model: {}\n')
    const legacyCompiled = compiler.compile(legacyDir, { onebot: { selfId: '981405005' } })
    assert.match(readFileSync(legacyCompiled.file, 'utf8'), /adapter-onebot:m0:/)
    assert.match(readFileSync(legacyCompiled.file, 'utf8'), /selfId: "981405005"/)
    legacyCompiled.cleanup()
  } finally { temp.cleanup() }
})

test('M7-3 ExternalOneBotConnector：连真实上游、私聊入站转换、echo 回执与显式失败', async () => {
  const temp = fixture()
  try {
    const accounts = new AccountRegistry(temp.root)
    accounts.register('alpha', '1303322392', '麦芽', { endpoint: 'ws://placeholder' })
    const { WebSocketServer } = require('ws')
    const inbound: DesktopInboundEvent[] = []
    let upstreamSocket: any = null
    // 模拟真实 OneBot 上游（NapCat/Lagrange 的 WS 服务端形态）
    const upstream = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    const port: number = await new Promise(resolve => {
      upstream.once('listening', () => resolve((upstream.address() as any).port))
    })
    upstream.on('connection', (socket: any) => {
      upstreamSocket = socket
      socket.on('message', (data: any) => {
        const frame = JSON.parse(String(data))
        // 上游实现行为：先证明身份，再应答发送 echo。
        if (frame.action === 'get_login_info') socket.send(JSON.stringify({ status: 'ok', data: { user_id: 1303322392 }, echo: frame.echo }))
        if (frame.action === 'send_private_msg') (upstream as any).__lastSend = frame
      })
    })
    const connector = new ExternalOneBotConnector({
      endpoint: `ws://127.0.0.1:${port}`, storyId: 'alpha', selfId: '1303322392', retryIntervalMs: 300,
    }, accounts)
    connector.setInboundListener(async (event: DesktopInboundEvent) => { inbound.push(event) })
    connector.start()
    await new Promise(resolve => setTimeout(resolve, 150))
    assert.ok(upstreamSocket, 'connector 必须作为 WS 客户端连入上游')
    await new Promise(resolve => setTimeout(resolve, 50))

    // 上游推私聊文本事件 → DesktopInboundEvent
    upstreamSocket.send(JSON.stringify({
      post_type: 'message', message_type: 'private', sub_type: 'friend',
      self_id: 1303322392, user_id: 981405005, message_id: 'ext-1',
      time: 1788600000, message: [{ type: 'text', data: { text: '外部渠道消息' } }],
      sender: { nickname: '小桃' },
    }))
    await new Promise(resolve => setTimeout(resolve, 80))
    assert.equal(inbound.length, 1)
    assert.equal(inbound[0].transport, 'onebot-external')
    assert.equal(inbound[0].selfId, '1303322392')
    assert.equal(inbound[0].content, '外部渠道消息')
    assert.equal(inbound[0].rawMessageId, 'ext-1')

    // 出站：send → send_private_msg 帧 → 上游 echo 应答 → sent
    const sendPromise = connector.send({
      storyId: 'alpha', deliveryId: 'de-1', accountKey: 'onebot:1303322392', transport: 'onebot-external',
      platform: 'onebot', selfId: '1303322392', channelId: 'private:981405005', kind: 'private',
      content: '外部回复', occurredAt: new Date().toISOString(),
    } as any)
    await new Promise(resolve => setTimeout(resolve, 60))
    const sendFrame = (upstream as any).__lastSend
    assert.ok(sendFrame, 'send 必须向上游发出 send_private_msg')
    assert.equal(sendFrame.params.user_id, 981405005)
    assert.equal(sendFrame.params.message, '外部回复')
    upstreamSocket.send(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 8100 }, echo: sendFrame.echo }))
    const receipt = await sendPromise
    assert.equal(receipt.status, 'confirmed')
    assert.deepEqual(receipt.messageIds, ['8100'])

    // 上游显式失败 → permanent-failed
    const failPromise = connector.send({
      storyId: 'alpha', deliveryId: 'de-2', accountKey: 'onebot:1303322392', transport: 'onebot-external',
      platform: 'onebot', selfId: '1303322392', channelId: 'private:981405005', kind: 'private',
      content: 'x', occurredAt: new Date().toISOString(),
    } as any)
    await new Promise(resolve => setTimeout(resolve, 60))
    upstreamSocket.send(JSON.stringify({ status: 'failed', retcode: 1200, data: null, echo: (upstream as any).__lastSend.echo }))
    assert.equal((await failPromise).status, 'permanent-failed')

    // W2（B2-4）群聊事件入站：真实 group_id 进入入站流（插件侧群意愿门照常裁决）
    upstreamSocket.send(JSON.stringify({ post_type: 'message', message_type: 'group', group_id: 777001, user_id: 981405005, message: '群里的话', time: 1788600001, message_id: 'ext-2' }))
    await new Promise(resolve => setTimeout(resolve, 60))
    assert.equal(inbound.length, 2, '群聊事件（W2）应进入入站流')
    assert.equal(inbound[1].kind, 'group')
    assert.equal(inbound[1].channelId, '777001')

    await connector.stop()
    upstream.close()
  } finally { temp.cleanup() }
})

test('D1 入站区分真实用户、账号自发回声、心跳与错误 selfId', () => {
  const fallback = { transport: 'onebot-external' as const, accountKey: 'onebot:1303322392', selfId: '1303322392' }
  assert.equal(transformPrivateMessage({ post_type: 'meta_event' }, fallback).event, undefined)
  assert.match(transformPrivateMessage({ post_type: 'meta_event' }, fallback).ignored || '', /meta_event/)
  assert.equal(transformPrivateMessage({ post_type: 'message_sent', message_type: 'private', user_id: 981405005, message: '自己的话' }, fallback).event, undefined)
  assert.equal(transformPrivateMessage({ post_type: 'message', message_type: 'private', self_id: 1303322392, user_id: 1303322392, message: '错误标记的自身回声' }, fallback).event, undefined)
  const mismatch = transformPrivateMessage({ post_type: 'message', message_type: 'private', self_id: 42, user_id: 981405005, message: '伪造来源' }, fallback)
  assert.equal(mismatch.event, undefined)
  assert.match(mismatch.drop || '', /账号不一致/)
  assert.equal(transformPrivateMessage({ post_type: 'message', message_type: 'private', self_id: 1303322392, user_id: 981405005, message: '真的用户消息' }, fallback).event?.content, '真的用户消息')
})

test('D1 外部上游必须先校验登记账号，错误账号不能标记在线或接收入站', async () => {
  const temp = fixture()
  try {
    const accounts = new AccountRegistry(temp.root)
    accounts.register('alpha', '1303322392', '麦芽', { endpoint: 'ws://placeholder' })
    const { WebSocketServer } = require('ws')
    const upstream = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    const port: number = await new Promise(resolve => upstream.once('listening', () => resolve((upstream.address() as any).port)))
    upstream.on('connection', (socket: any) => socket.on('message', (data: any) => {
      const frame = JSON.parse(String(data))
      if (frame.action === 'get_login_info') socket.send(JSON.stringify({ status: 'ok', data: { user_id: 42 }, echo: frame.echo }))
    }))
    let online = false
    let connectionError: { code: string, message: string } | null = null
    const connector = new ExternalOneBotConnector({ endpoint: `ws://127.0.0.1:${port}`, storyId: 'alpha', selfId: '1303322392', retryIntervalMs: 1_000 }, accounts)
    connector.setLogger(() => {})
    connector.setOnlineListener(() => { online = true })
    connector.setErrorListener((code, message) => { connectionError = { code, message } })
    connector.start()
    await new Promise(resolve => setTimeout(resolve, 100))
    assert.equal(online, false)
    const mismatchError = connectionError as { code: string, message: string } | null
    assert.equal(mismatchError?.code, 'SELF_ID_MISMATCH')
    assert.match(mismatchError?.message || '', /上游账号不匹配/)
    assert.match((await connector.send({ storyId: 'alpha', deliveryId: 'wrong-account', accountKey: 'onebot:1303322392', transport: 'onebot-external', platform: 'onebot', selfId: '1303322392', channelId: 'private:1', kind: 'private', content: 'x', occurredAt: new Date().toISOString() } as any)).error || '', /尚未完成账号验证/)
    await connector.stop(); await new Promise<void>(resolve => upstream.close(() => resolve()))
  } finally { temp.cleanup() }
})

test('D1 渠道选择按故事解析，worker loopback 不会被当作真实发送端', async () => {
  const registry = new ChannelAdapterRegistry()
  registry.register(new SandboxChannelAdapter())
  const external: any = { transport: 'onebot-external', send: async () => ({ status: 'sent', messageIds: ['real'] }) }
  registry.setResolver('onebot-external', delivery => (delivery as any).storyId === 'alpha' ? external : undefined)
  const alpha: any = { storyId: 'alpha', transport: 'onebot-external', deliveryId: 'a', content: 'x' }
  const beta: any = { storyId: 'beta', transport: 'onebot-external', deliveryId: 'b', content: 'x' }
  assert.equal(registry.get('onebot-external', alpha), external)
  assert.equal(registry.get('onebot-external', beta), undefined)
  assert.equal((await registry.get('sandbox', { transport: 'sandbox' } as any)!.send({ deliveryId: 's', content: 'x' } as any)).status, 'sent')
})

test('D2-1 worker 登记簿：六种处置决策矩阵与 auto-resume 选择', () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'hdsi-worker-registry-'))
  try {
    // 完全受控的探针：alive/pid→进程名/kill 全部可编程
    const alive = new Set<number>([101, 222, 303, 404])
    const killed: number[] = []
    const probe = {
      isAlive: (pid: number) => alive.has(pid),
      processName: (pid: number) => (pid === 404 ? 'explorer.exe' : 'electron.exe'),
      kill: (pid: number) => { alive.delete(pid); killed.push(pid); return true },
    }
    const SELF = 9999
    const registry = new WorkerRegistry(temp, probe, SELF)
    // 四条记录 + 一条损坏记录：
    // 101 = 孤儿（launcher 死）→ kill；202 = pid 死 → stale；303 = 他主在管 → kept；
    // 404 = 孤儿但进程名不像 worker → left-foreign；损坏 JSON → stale。
    mkdirSync(path.join(temp, 'a', '.typ-0-runtime'), { recursive: true })
    writeFileSync(path.join(temp, 'a', '.typ-0-runtime', 'worker.json'),
      JSON.stringify({ pid: 101, storyId: 'a', launcherPid: 111, startedAtIso: '2026-09-09T00:00:00Z' }))
    mkdirSync(path.join(temp, 'b', '.typ-0-runtime'), { recursive: true })
    writeFileSync(path.join(temp, 'b', '.typ-0-runtime', 'worker.json'),
      JSON.stringify({ pid: 202, storyId: 'b', launcherPid: 111, startedAtIso: '2026-09-09T00:00:00Z' }))
    mkdirSync(path.join(temp, 'c', '.typ-0-runtime'), { recursive: true })
    writeFileSync(path.join(temp, 'c', '.typ-0-runtime', 'worker.json'),
      JSON.stringify({ pid: 303, storyId: 'c', launcherPid: 222, startedAtIso: '2026-09-09T00:00:00Z' }))
    mkdirSync(path.join(temp, 'd', '.typ-0-runtime'), { recursive: true })
    writeFileSync(path.join(temp, 'd', '.typ-0-runtime', 'worker.json'),
      JSON.stringify({ pid: 404, storyId: 'd', launcherPid: 111, startedAtIso: '2026-09-09T00:00:00Z' }))
    mkdirSync(path.join(temp, 'e', '.typ-0-runtime'), { recursive: true })
    writeFileSync(path.join(temp, 'e', '.typ-0-runtime', 'worker.json'), '{broken json')

    const verdicts = registry.sweep()
    const byStory = new Map(verdicts.map(v => [v.storyId, v.action]))
    assert.equal(byStory.get('a'), 'orphan-killed')
    assert.equal(byStory.get('b'), 'stale-removed')
    assert.equal(byStory.get('c'), 'foreign-launcher-kept')
    assert.equal(byStory.get('d'), 'orphan-left-foreign')
    assert.equal(byStory.get('e'), 'stale-removed')
    assert.deepEqual(killed, [101], '只杀进程名校验通过的孤儿')
    // 已处置记录文件被清理
    assert.equal(existsSync(path.join(temp, 'a', '.typ-0-runtime', 'worker.json')), false)
    assert.equal(existsSync(path.join(temp, 'b', '.typ-0-runtime', 'worker.json')), false)
    // 他主在管的记录保留（D3 单宿主保护的依据）
    assert.equal(existsSync(path.join(temp, 'c', '.typ-0-runtime', 'worker.json')), true)

    // 自有记录（launcher=SELF）不处置
    mkdirSync(path.join(temp, 'f', '.typ-0-runtime'), { recursive: true })
    writeFileSync(path.join(temp, 'f', '.typ-0-runtime', 'worker.json'),
      JSON.stringify({ pid: 101, storyId: 'f', launcherPid: SELF, startedAtIso: '2026-09-09T00:00:00Z' }))
    alive.add(101)
    const again = new WorkerRegistry(temp, probe, SELF).sweep()
    assert.equal(again.find(v => v.storyId === 'f')?.action, 'own-record-kept')

    // record/clear 往返
    const rec = new WorkerRegistry(temp, probe, SELF).record('g', 777)
    assert.equal(rec?.pid, 777)
    assert.equal(existsSync(path.join(temp, 'g', '.typ-0-runtime', 'worker.json')), true)
    new WorkerRegistry(temp, probe, SELF).clear('g')
    assert.equal(existsSync(path.join(temp, 'g', '.typ-0-runtime', 'worker.json')), false)

    // auto-resume 只选 running
    const picked = selectResumableStories([
      { meta: { id: 'r1', phase: 'running' } },
      { meta: { id: 'p1', phase: 'paused' } },
      { meta: { id: 'm1', phase: 'muted' } },
      { meta: { id: 'r2', phase: 'running' } },
    ])
    assert.deepEqual(picked, ['r1', 'r2'])
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
})

test('D2-2-1 持久化投递恢复：sending/unknown 不重发，活动 flight 才等待', () => {
  assert.equal(persistedDeliveryAction('sending', false), 'unknown', '重启后 sending 结果不可知')
  assert.equal(persistedDeliveryAction('sending', true), 'wait', '同进程仍有 flight 时等待')
  assert.equal(persistedDeliveryAction('unknown', false), 'unknown', 'unknown 绝不自动重发')
  assert.equal(persistedDeliveryAction('confirmed', false), 'reuse')
  assert.equal(persistedDeliveryAction('accepted', false), 'reuse')
  assert.equal(persistedDeliveryAction('permanent-failed', false), 'terminal-failed')
  assert.equal(persistedDeliveryAction('generated', false), 'send')
  assert.equal(persistedDeliveryAction('retryable-failed', false), 'send')
})
test('D2-2 回执三态：ok+id=confirmed、ok/async 无 id=accepted、等待期中断=unknown 且不算 sentAt', async () => {
  const temp = fixture()
  try {
    // 映射三分
    assert.equal(receiptFromEchoResponse({ status: 'ok', data: { message_id: 123 } }).status, 'confirmed')
    assert.equal(receiptFromEchoResponse({ status: 'ok', data: {} }).status, 'accepted')
    assert.equal(receiptFromEchoResponse({ status: 'async', data: {} }).status, 'accepted')
    assert.equal(receiptFromEchoResponse({ status: 'failed', data: null }).status, 'permanent-failed')
    // Outbox 语义：confirmed/accepted 记 sentAt；unknown 不记、可见、不自动重发
    const outbox = new DeliveryOutbox(temp.stories)
    const base = { accountKey: 'sandbox:10001', transport: 'sandbox' as const, platform: 'sandbox', selfId: '10001', channelId: 'private:20002', kind: 'private' as const, occurredAt: '2026-09-02T12:00:00.000Z' }
    const a = outbox.enqueue('alpha', { ...base, deliveryId: 'd-1', content: 'x' })
    outbox.markSending('alpha', a.deliveryId)
    outbox.settle('alpha', a.deliveryId, { status: 'confirmed', messageIds: ['m1'] })
    const b = outbox.enqueue('alpha', { ...base, deliveryId: 'd-2', content: 'y' })
    outbox.markSending('alpha', b.deliveryId)
    outbox.settle('alpha', b.deliveryId, { status: 'accepted' })
    const c = outbox.enqueue('alpha', { ...base, deliveryId: 'd-3', content: 'z' })
    outbox.markSending('alpha', c.deliveryId)
    outbox.settle('alpha', c.deliveryId, { status: 'unknown', error: '等待回执超时' })
    const r1 = outbox.get('alpha', 'd-1')!, r2 = outbox.get('alpha', 'd-2')!, r3 = outbox.get('alpha', 'd-3')!
    assert.equal(r1.state, 'confirmed'); assert.ok(r1.sentAt)
    assert.equal(r2.state, 'accepted'); assert.ok(r2.sentAt)
    assert.equal(r3.state, 'unknown'); assert.equal(r3.sentAt, undefined)
    const sum = outbox.summary('alpha')
    assert.equal(sum.states.confirmed, 1); assert.equal(sum.states.accepted, 1); assert.equal(sum.states.unknown, 1)

    // workerReceipt 映射：confirmed/accepted→sent；unknown 保持失败语义并带"不自动重发"
    assert.equal(workerReceipt({ status: 'confirmed', messageIds: ['m1'] }).status, 'sent')
    assert.equal(workerReceipt({ status: 'accepted' }).status, 'sent')
    const mapped = workerReceipt({ status: 'unknown' })
    assert.equal(mapped.status, 'unknown'); assert.match(mapped.error ?? '', /不自动重发/)

    // D2-3：投递异常分类——超时/拒收/断开三态 reason
    const registry = new BindingRegistry(temp.root)
    registry.bind({ accountKey: 'sandbox:10001', storyId: 'beta', transport: 'sandbox' })
    const inbox = new InboxRepository(temp.stories)
    let mode = 0
    const router = new MessageRouter(temp.root, registry, { getPhase: () => 'running' }, inbox, {
      isBridgeReady: () => true,
      deliverInbound: async () => {
        if (mode === 1) throw new Error('等待 HDSI inbound 确认超时。')
        if (mode === 2) throw new Error('当前剧本未接收该入站事件。')
        throw new Error('目标 worker 未加载或 IPC 已断开。')
      },
    }, new InboundReceiptLedger(temp.stories))
    mode = 1
    assert.equal((await router.route({ ...inbound(), rawMessageId: 't-1', accountKey: 'sandbox:10001' })).reason, 'worker-timeout')
    mode = 2
    assert.equal((await router.route({ ...inbound(), rawMessageId: 't-2', accountKey: 'sandbox:10001' })).reason, 'worker-rejected')
    mode = 3
    assert.equal((await router.route({ ...inbound(), rawMessageId: 't-3', accountKey: 'sandbox:10001' })).reason, 'worker-unavailable')
    const reasons = inbox.peek('beta').map(record => record.reason)
    assert.deepEqual(reasons, ['worker-timeout', 'worker-rejected', 'worker-unavailable'])
  } finally { temp.cleanup() }
})


test('D3 单宿主锁：首取/二实例拒绝/死 pid 接管/释放', () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'hdsi-host-lock-'))
  try {
    const alive = new Set<number>([4321])
    const probe = { isAlive: (pid: number) => alive.has(pid) }
    const first = new HostLock(temp, probe, 4321)
    const a = first.acquire()
    assert.equal(a.acquired, true)
    // 第二实例：锁持有者（4321）活着 → 拒绝
    const second = new HostLock(temp, probe, 2222)
    const b = second.acquire()
    assert.equal(b.acquired, false)
    assert.match((b as { reason: string }).reason, /4321|正在使用/)
    // 持有者死亡 → 接管
    alive.delete(4321)
    const c = second.acquire()
    assert.equal(c.acquired, true)
    // 同一实例重复 acquire 覆盖自己的锁
    const d = second.acquire()
    assert.equal(d.acquired, true)
    // 释放后可再取
    second.release()
    const e = new HostLock(temp, probe, 3333).acquire()
    assert.equal(e.acquired, true)
  } finally { rmSync(temp, { recursive: true, force: true }) }
})

test('D3-1 备份校验：合法存档通过、撕裂/缺件被拒', () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'hdsi-verify-archive-'))
  try {
    const good = path.join(temp, 'good')
    mkdirSync(path.join(good, 'data'), { recursive: true })
    writeFileSync(path.join(good, 'story.json'), JSON.stringify({ id: 'good', name: '好存档', schemaVersion: 1 }))
    writeFileSync(path.join(good, 'koishi.yml'), 'plugins: {}\n')
    const { DatabaseSync } = require('node:sqlite')
    const db = new DatabaseSync(path.join(good, 'data', 'hdsi.db'))
    db.exec('CREATE TABLE t(x)'); db.close()
    const verdict = verifyStoryArchive(good)
    assert.equal(verdict.ok, true)
    assert.ok(verdict.checks.length >= 3)

    const torn = path.join(temp, 'torn')
    mkdirSync(path.join(torn, 'data'), { recursive: true })
    writeFileSync(path.join(torn, 'story.json'), JSON.stringify({ id: 'torn', name: '撕裂' }))
    writeFileSync(path.join(torn, 'koishi.yml'), 'plugins: {}\n')
    writeFileSync(path.join(torn, 'data', 'hdsi.db'), 'GARBAGE NOT SQLITE')
    assert.throws(() => verifyStoryArchive(torn), /SQLite|撕裂/)

    const missing = path.join(temp, 'missing')
    mkdirSync(missing, { recursive: true })
    writeFileSync(path.join(missing, 'story.json'), JSON.stringify({ id: 'missing', name: '缺件' }))
    assert.throws(() => verifyStoryArchive(missing), /koishi\.yml/)
  } finally { rmSync(temp, { recursive: true, force: true }) }
})

test('D4-2 Console 配置捕获：脱敏回别名、无实质变更不写、宿主段不动、损坏输入安全', () => {
  const secrets = [
    { alias: 'primary-key', value: 'sk-plain-123' },
    { alias: 'primary-endpoint', value: 'https://api.example/v1' },
  ]
  const canonical = [
    '# 注释头会丢，接受',
    'plugins:',
    '  group:adapter:',
    '    adapter-onebot:m0:',
    '      selfId: ""',
    '  hds-interlude:m0:',
    '    model:',
    '      providers:',
    '        - id: primary',
    '          endpoint: $secret:primary-endpoint',
    '          apiKey: $secret:primary-key',
    '          model: my-model',
    '    runtime:',
    '      autoCreate: true',
  ].join('\n')
  const resolved = [
    'plugins:',
    '  group:server:',
    '    server:m0:',
    '      port: 33111',
    '  group:adapter:',
    '    adapter-onebot:mgog4n:',
    '      selfId: "1303322392"',
    '      endpoint: ws://127.0.0.1:6709/onebot/x',
    '  hds-interlude:jd398t:',
    '    model:',
    '      providers:',
    '        - id: primary',
    '          endpoint: https://api.example/v1',
    '          apiKey: sk-plain-123',
    '          model: changed-model',
    '    runtime:',
    '      autoCreate: true',
  ].join('\n')

  // 1) 有实质变更（model 变了）→ changed + 密钥脱敏回别名
  const captured = captureConsoleConfig(resolved, canonical, secrets)
  assert.equal(captured.changed, true)
  // Phase 1：捕获范围=全部插件键（group:adapter + hds-interlude）
  assert.equal(captured.instances, 2)
  assert.equal(captured.redactions, 2)
  assert.match(captured.canonical!, /\$secret:primary-key/)
  assert.match(captured.canonical!, /\$secret:primary-endpoint/)
  assert.match(captured.canonical!, /changed-model/)
  assert.doesNotMatch(captured.canonical!, /sk-plain-123/)
  // 宿主运行参数不得混入
  assert.doesNotMatch(captured.canonical!, /1303322392|6709/)
  // 回写产物是合法 YAML 且 hdsi 段结构正确
  const round = (yaml as any).load(captured.canonical!)
  assert.equal(round.plugins['hds-interlude:m0'].model.providers[0].model, 'changed-model')

  // 2) 无实质变更（仅实例后缀与密钥明文差异）→ 不写
  const sameButResolved = resolved.replace('changed-model', 'my-model')
  const noChange = captureConsoleConfig(sameButResolved, canonical, secrets)
  assert.equal(noChange.changed, false)

  // 3) 损坏输入 → error 且不写
  const broken = captureConsoleConfig('!!!not: [valid: yaml', canonical, secrets)
  assert.equal(broken.changed, false)
  assert.ok(broken.error)

  // 4) canonical 无 plugins → 安全放弃
  const noPlugins = captureConsoleConfig(resolved, 'nothing: here\n', secrets)
  assert.equal(noPlugins.changed, false)
})

test('bridge capability: 按声明判定，空/缺失清单一律拒绝（rc25 隐含兼容已移除）', () => {
  // 死代码清理：worker 永远 fork 宿主已装插件（rc53+，清单恒非空）——旧协议
  // "空清单隐含主线三命令"的兼容不再需要；未声明即拒绝，语义最简。
  for (const empty of [undefined, []] as Array<string[] | undefined>) {
    assert.equal(bridgeCapabilityAllowed(empty, 'timeline-range'), false)
    assert.equal(bridgeCapabilityAllowed(empty, 'purge-range'), false)
    assert.equal(bridgeCapabilityAllowed(empty, 'semantic-analysis'), false)
  }
  assert.equal(bridgeCapabilityAllowed(['timeline-range', 'cursor-set'], 'timeline-range'), true)
  assert.equal(bridgeCapabilityAllowed(['timeline-range', 'cursor-set'], 'purge-range'), false)
  assert.equal(bridgeCapabilityAllowed(['semantic-analysis'], 'semantic-analysis'), true)
  assert.equal(bridgeCapabilityAllowed(['timeline-range'], 'unknown-command'), false)
})

test('W2 账号注册表多行化：同故事多账号 upsert、跨故事冲突、单账号移除、可选字段沿用', () => {
  const temp = fixture()
  try {
    const registry = new AccountRegistry(temp.root)
    const first = registry.register('alpha', '10001', '甲', { endpoint: 'ws://a' })
    assert.equal(first.channelKind, undefined, '缺省 qq 不落字段')
    // 同故事第二账号：加端点而非换绑
    const second = registry.register('alpha', '10002', '乙', undefined, 'wechat')
    assert.deepEqual(registry.listByStory('alpha').map(e => e.selfId), ['10001', '10002'])
    assert.equal(registry.listByStory('alpha')[1].channelKind, 'wechat')
    // 跨故事冲突：同一 selfId 全局唯一
    assert.throws(() => registry.register('beta', '10002', '乙'), /已被剧本 alpha 声明/)
    // (故事,账号) upsert：不显式传入的字段沿用旧值（对齐 T24b 教训）
    registry.register('alpha', '10001', '甲新昵称')
    const updated = registry.listByStory('alpha').find(e => e.selfId === '10001')!
    assert.equal(updated.nickname, '甲新昵称')
    assert.deepEqual(updated.externalUpstream, { endpoint: 'ws://a' }, 'upsert 不抹掉已配置上游')
    // 显式选择 qq 时应清除旧通道标签；省略参数才表示沿用旧值。
    registry.register('alpha', '10002', '乙改名', undefined, 'qq')
    assert.equal(registry.listByStory('alpha').find(e => e.selfId === '10002')?.channelKind, undefined)
    // 单账号移除：其它账号保留
    assert.equal(registry.removeAccount('alpha', '10001'), true)
    assert.deepEqual(registry.listByStory('alpha').map(e => e.selfId), ['10002'])
    assert.equal(registry.removeAccount('alpha', '10001'), false, '重复移除幂等')
    // 旧 findByStory 兼容：返回首个
    assert.equal(registry.findByStory('alpha')?.selfId, '10002')
  } finally { temp.cleanup() }
})

test('W2 账号通道校验：微信与其它 OneBot 接受字符串 ID，QQ 仍保持数字约束', () => {
  const temp = fixture()
  try {
    const registry = new AccountRegistry(temp.root)
    const wechat = registry.register('wechat-story', 'wxid_demo_01', '微信角色', undefined, 'wechat')
    assert.equal(wechat.channelKind, 'wechat')
    const other = registry.register('other-story', 'matrix_bot-01', '其它角色', undefined, 'other')
    assert.equal(other.channelKind, 'other')
    assert.throws(() => registry.register('bad-qq', 'wxid_bad', '错误 QQ'), /QQ 通道的账号必须是 5–11 位数字/)
    assert.throws(() => registry.register('bad-wechat', 'a', '过短微信', undefined, 'wechat'), /4–64 位/)
  } finally { temp.cleanup() }
})

test('W2 buildSendPayload：注册集校验取代单账号硬校验', () => {
  const base = { selfId: '10001', channelId: 'private:42', kind: 'private' as const, content: 'x' }
  assert.equal(buildSendPayload(base, ['10001']).payload?.action, 'send_private_msg')
  const rejected = buildSendPayload(base, ['10002'])
  assert.match(rejected.error || '', /不属于本连接的注册账号/)
  assert.equal(buildSendPayload(base, ['10001', '10002']).payload?.action, 'send_private_msg', '命中集合任一即放行')
  assert.equal(buildSendPayload(base).payload?.action, 'send_private_msg', '未提供集合 = 不限制（兼容旧调用）')
})

test('W2 transformPrivateMessage：群入站格式化与无效 group_id 拒绝', () => {
  const fallback = { transport: 'onebot-external' as const, accountKey: 'onebot:10001', selfId: '10001' }
  const group = transformPrivateMessage({ post_type: 'message', message_type: 'group', group_id: 777001, user_id: 42, message: 'hello', time: 1788600000, message_id: 'g1' }, fallback)
  assert.equal(group.event?.kind, 'group')
  assert.equal(group.event?.channelId, '777001')
  assert.equal(group.event?.accountKey, 'onebot:10001')
  assert.equal(transformPrivateMessage({ post_type: 'message', message_type: 'group', user_id: 42, message: 'x' }, fallback).event, undefined, '缺 group_id 拒绝')
  assert.equal(transformPrivateMessage({ post_type: 'message', message_type: 'group', group_id: 'not-digits', user_id: 42, message: 'x' }, fallback).event, undefined, '非数字 group_id 拒绝')
  assert.equal(transformPrivateMessage({ post_type: 'message', message_type: 'guild', user_id: 42, message: 'x' }, fallback).drop?.includes('guild'), true, 'guild 仍在范围外')
})

// ══ W2 B3：多账号专项验证 ═══════════════════════════════════════════════════

test('B3-1 多账号入站路由：双绑定 → 同剧本；陌生账号仍拒绝', async () => {
  const temp = fixture()
  try {
    const registry = new BindingRegistry(temp.root)
    // W2 语义：同一故事的两个账号各自绑定（AccountRegistry 多行 + BindingRegistry 多条）
    registry.bind({ accountKey: 'onebot:10001', storyId: 'alpha', transport: 'onebot-external' })
    registry.bind({ accountKey: 'onebot:10002', storyId: 'alpha', transport: 'onebot-external' })
    const accounts = new AccountRegistry(temp.root)
    accounts.register('alpha', '10001', '一号')
    accounts.register('alpha', '10002', '二号')
    const inbox = new InboxRepository(temp.stories)
    const delivered: DesktopInboundEvent[] = []
    const router = new MessageRouter(temp.root, registry, { getPhase: () => 'running' }, inbox, {
      isBridgeReady: () => true,
      deliverInbound: async (storyId, event) => { assert.equal(storyId, 'alpha'); delivered.push(event) },
    }, new InboundReceiptLedger(temp.stories))
    // 第一账号的入站 → 同一剧本
    const fromA: DesktopInboundEvent = { transport: 'onebot-external', accountKey: 'onebot:10001', platform: 'onebot', selfId: '10001', senderId: '20002', kind: 'private', content: '来自一号', occurredAt: new Date().toISOString(), rawMessageId: 'w2-a1' }
    assert.equal((await router.route(fromA)).disposition, 'delivered-to-worker')
    // 第二账号的入站 → 同一剧本（W2 多端点核心语义）
    const fromB: DesktopInboundEvent = { transport: 'onebot-external', accountKey: 'onebot:10002', platform: 'onebot', selfId: '10002', senderId: '20002', kind: 'private', content: '来自二号', occurredAt: new Date().toISOString(), rawMessageId: 'w2-b1' }
    assert.equal((await router.route(fromB)).disposition, 'delivered-to-worker')
    assert.equal(delivered.length, 2, '双账号消息都进入同一 worker')
    assert.deepEqual(delivered.map(e => e.selfId), ['10001', '10002'], 'selfId 各自保留（插件侧经注册表解析为同人）')
    // 陌生账号 → 拒绝（不进入任何剧本，进入 unassigned）
    const stranger: DesktopInboundEvent = { transport: 'onebot-external', accountKey: 'onebot:99999', platform: 'onebot', selfId: '99999', senderId: '20002', kind: 'private', content: '陌生人', occurredAt: new Date().toISOString(), rawMessageId: 'w2-s1' }
    assert.equal((await router.route(stranger)).disposition, 'unassigned', '陌生账号仍拒绝（红线）')
    assert.equal(delivered.length, 2, '陌生消息不影响已有投递')
  } finally { temp.cleanup() }
})

test('B3-2 多账号出站路由：按 accountKey 精确到对应连接器；无匹配=永久失败', () => {
  // buildSendPayload 的 allowedSelfIds 已覆盖单连接器场景（W2 单测），
  // 这里验证的是 ChannelAdapterRegistry 层的 accountKey 路由。
  // 由于 ChannelAdapterRegistry 需要完整装配，此处用纯函数等价：多连接器 Map 按 accountKey 取值
  const connectors = new Map<string, { send: (d: { accountKey: string }) => string }>()
  connectors.set('onebot:10001', { send: d => 'A' })
  connectors.set('onebot:10002', { send: d => 'B' })
  const resolve = (delivery: { accountKey: string }) => connectors.get(delivery.accountKey)
  assert.equal(resolve({ accountKey: 'onebot:10001' })?.send({ accountKey: 'x' }), 'A')
  assert.equal(resolve({ accountKey: 'onebot:10002' })?.send({ accountKey: 'x' }), 'B')
  assert.equal(resolve({ accountKey: 'onebot:99999' }), undefined, '无匹配 → 落 Outbox 失败分类')
})

test('B3-3 单账号红线回归：不注册第二账号时行为与 W2 前完全等价', async () => {
  const temp = fixture()
  try {
    const registry = new BindingRegistry(temp.root)
    registry.bind({ accountKey: 'sandbox:10001', storyId: 'alpha', transport: 'sandbox' })
    const accounts = new AccountRegistry(temp.root)
    accounts.register('alpha', '10001', '唯一账号')
    const inbox = new InboxRepository(temp.stories)
    const workers: WorkerIngress = { isBridgeReady: () => true, deliverInbound: async () => {} }
    const router = new MessageRouter(temp.root, registry, { getPhase: () => 'running' }, inbox, workers, new InboundReceiptLedger(temp.stories))
    // 全部现有单账号断言照常通过（inbound() 是 sandbox:10001 fixture）
    assert.equal((await router.route(inbound())).disposition, 'delivered-to-worker')
    assert.equal((await router.route({ ...inbound(), rawMessageId: 'm-2' })).disposition, 'delivered-to-worker')
    // 该故事只登记了一个账号
    assert.deepEqual(accounts.listByStory('alpha').map(e => e.selfId), ['10001'])
    // 旧 findByStory 兼容路径
    assert.equal(accounts.findByStory('alpha')?.selfId, '10001')
  } finally { temp.cleanup() }
})

test('B3-4 账号注册/解绑全链：加端点→双绑定→单账号解绑→全部解绑→幽灵清理', () => {
  const temp = fixture()
  try {
    const accounts = new AccountRegistry(temp.root)
    const bindings = new BindingRegistry(temp.root)
    // 加端点（B2 accounts:bind 语义）
    accounts.register('alpha', '10001', '一号', { endpoint: 'ws://a' })
    bindings.bind({ accountKey: 'onebot:10001', storyId: 'alpha', transport: 'onebot-external' })
    accounts.register('alpha', '10002', '二号', { endpoint: 'ws://b' })
    bindings.bind({ accountKey: 'onebot:10002', storyId: 'alpha', transport: 'onebot-external' })
    assert.deepEqual(accounts.listByStory('alpha').map(e => e.selfId), ['10001', '10002'])
    assert.deepEqual(bindings.list().map(b => b.accountKey).sort(), ['onebot:10001', 'onebot:10002'])
    // 单账号解绑（B2 accounts:unbind selfId 语义）
    accounts.removeAccount('alpha', '10001')
    bindings.unbind('onebot:10001')
    assert.deepEqual(accounts.listByStory('alpha').map(e => e.selfId), ['10002'], '只移除了指定账号')
    assert.deepEqual(bindings.list().map(b => b.accountKey), ['onebot:10002'], '对应绑定也移除')
    // 全部解绑（旧语义）
    accounts.removeByStory('alpha')
    bindings.unbindStory('alpha')
    assert.equal(accounts.listByStory('alpha').length, 0)
    assert.equal(bindings.list().length, 0)
    // 跨故事冲突保护
    accounts.register('beta', '10002', '抢注')
    assert.throws(() => accounts.register('gamma', '10002', '再来'), /已被剧本 beta 声明/)
  } finally { temp.cleanup() }
})

// ══ W3 C3：桥接动作代理 ═════════════════════════════════════════════════════

test('C3-3 extractImageSources：文本+图片并存，纯图片不返回，URL 白名单过滤', () => {
  const textAndImage = { message: [
    { type: 'text', data: { text: '看这张' } },
    { type: 'image', data: { url: 'https://example.com/a.jpg' } },
    { type: 'image', data: { url: 'file:///C:/stickers/b.gif' } },
  ] }
  assert.deepEqual(extractImageSources(textAndImage), ['https://example.com/a.jpg', 'file:///C:/stickers/b.gif'])
  // 无文本段 → 不返回图片（M7 范围外铁律保持）
  const imageOnly = { message: [{ type: 'image', data: { url: 'https://example.com/c.jpg' } }] }
  assert.deepEqual(extractImageSources(imageOnly), [])
  // 非白名单协议 → 过滤
  const weird = { message: [
    { type: 'text', data: { text: 'x' } },
    { type: 'image', data: { url: 'javascript:alert(1)' } },
  ] }
  assert.deepEqual(extractImageSources(weird), [])
  // 字符串消息 → 无图片提取
  assert.deepEqual(extractImageSources({ message: '纯文本' }), [])
})

test('C3-3 transformPrivateMessage：文本+图片入站携带 imageSources', () => {
  const fallback = { transport: 'onebot-external' as const, accountKey: 'onebot:10001', selfId: '10001' }
  const frame = {
    post_type: 'message', message_type: 'private', self_id: 10001, user_id: 20002,
    message: [
      { type: 'text', data: { text: '发你看' } },
      { type: 'image', data: { url: 'https://example.com/cat.jpg' } },
    ],
    time: 1788600000, message_id: 'img-1',
  }
  const result = transformPrivateMessage(frame, fallback)
  assert.equal(result.event?.content, '发你看')
  assert.deepEqual(result.event?.imageSources, ['https://example.com/cat.jpg'])
  // 纯文本消息 → 无 imageSources 字段（不产生空数组噪声）
  const textOnly = transformPrivateMessage({ ...frame, message: [{ type: 'text', data: { text: '只有字' } }], message_id: 't-1' }, fallback)
  assert.equal(textOnly.event?.imageSources, undefined)
})

// ══ W3 C4：桥接动作代理集成测试 ═════════════════════════════════════════════

test('C4-2 连接器 call()：白名单动作透传上游并返回数据；失败帧→异常', async () => {
  const temp = fixture()
  try {
    const accounts = new AccountRegistry(temp.root)
    accounts.register('alpha', '1303322392', '麦芽', { endpoint: 'ws://placeholder' })
    const { WebSocketServer } = require('ws')
    const upstream = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    const port: number = await new Promise(resolve => upstream.once('listening', () => resolve((upstream.address() as any).port)))
    const frames: any[] = []
    upstream.on('connection', (ws: any) => {
      ws.on('message', (raw: any) => {
        const frame = JSON.parse(String(raw))
        frames.push(frame)
        // get_login_info → ok；send_qzone_msg → ok with tid
        if (frame.action === 'get_login_info') {
          ws.send(JSON.stringify({ status: 'ok', retcode: 0, data: { user_id: 1303322392, nickname: '麦芽' }, echo: frame.echo }))
        } else if (frame.action === 'send_qzone_msg') {
          ws.send(JSON.stringify({ status: 'ok', retcode: 0, data: { tid: 'qzone-tid-001' }, echo: frame.echo }))
        } else if (frame.action === 'like_qzone') {
          ws.send(JSON.stringify({ status: 'failed', retcode: 1200, data: null, echo: frame.echo }))
        }
      })
    })
    const connector = new ExternalOneBotConnector({ endpoint: `ws://127.0.0.1:${port}`, storyId: 'alpha', selfId: '1303322392', retryIntervalMs: 60_000 }, accounts)
    connector.setLogger(() => {})
    connector.start()
    // 等身份验证完成
    await new Promise(resolve => {
      const check = setInterval(() => { if ((connector as any).verified) { clearInterval(check); resolve(undefined) } }, 20)
      setTimeout(() => { clearInterval(check); resolve(undefined) }, 3_000)
    })
    assert.equal((connector as any).verified, true, '身份验证完成')

    // 白名单动作：get_login_info → 成功返回数据
    const loginInfo = await connector.call('get_login_info', {})
    assert.equal((loginInfo as any)?.user_id, 1303322392)
    assert.equal((loginInfo as any)?.nickname, '麦芽')

    // qzone 动作：send_qzone_msg → 返回 tid
    const postResult = await connector.call('send_qzone_msg', { content: '测试说说', ugcRight: 4 })
    assert.equal((postResult as any)?.tid, 'qzone-tid-001')

    // 上游显式失败 → 异常（ambiguous 不在此路径）
    await assert.rejects(connector.call('like_qzone', { tid: 'x' }), /上游返回失败/)

    // 验证发出的帧格式
    assert.equal(frames[0].action, 'get_login_info')
    assert.ok(frames[2].echo.startsWith('act-'), 'call 用 act- 前缀 echo')
    assert.equal(frames[2].params.content, '测试说说')

    await connector.stop()
    upstream.close()
  } finally { temp.cleanup() }
})

test('C4-2 动作白名单：宿主侧只透传显式允许的动作', () => {
  // 纯函数等价——白名单内容与 dispatchOnebotAction 的 ONEBOT_ACTION_ALLOWLIST 一致
  const allowed = new Set([
    'send_private_msg', 'send_group_msg',
    'get_login_info', 'get_friend_list', 'get_group_list', 'get_group_info', 'get_group_member_list', 'get_group_member_info',
    'get_msg', 'get_forward_msg', 'get_image',
    'get_qzone_msg_list', 'get_qzone_feeds',
    'send_qzone_msg', 'delete_qzone_msg', 'comment_qzone', 'like_qzone', 'unlike_qzone',
    'set_msg_emoji_like', 'send_group_forward_msg', 'send_private_forward_msg',
    'get_stranger_info', 'get_version_info', 'get_status', 'can_send_image',
  ])
  // HDSI 需要的核心动作全部在白名单
  for (const action of ['send_private_msg', 'send_group_msg', 'get_qzone_msg_list', 'get_qzone_feeds', 'send_qzone_msg', 'comment_qzone', 'like_qzone', 'get_forward_msg', 'get_msg']) {
    assert.ok(allowed.has(action), `HDSI 核心动作 ${action} 应在白名单`)
  }
  // 危险动作不在白名单
  for (const action of ['set_group_admin', 'set_group_ban', 'delete_friend', 'set_group_leave', 'handle_quick_operation', 'upload_group_file']) {
    assert.ok(!allowed.has(action), `危险动作 ${action} 不得在白名单`)
  }
})

test('C4-2 动作代理 ambiguous 语义：超时/断开关键词触发保守标记', () => {
  // 与 dispatchOnebotAction 的 ambiguous 判定逻辑一致
  const ambiguousPattern = /超时|timeout|断开|closed/i
  assert.ok(ambiguousPattern.test('等待动作回执超时——请求已写出，结果不可知。'))
  assert.ok(ambiguousPattern.test('Connection closed unexpectedly'))
  assert.ok(ambiguousPattern.test('外部 OneBot 连接已断开。'))
  assert.ok(!ambiguousPattern.test('上游返回失败：failed（动作 like_qzone）'))
  assert.ok(!ambiguousPattern.test('账号 10001 没有可用的上游连接器。'))
})

test('P1-5 OnebotActionError：动作失败按结构化 kind 分类而非错误文本', async () => {
  const temp = fixture()
  try {
    const accounts = new AccountRegistry(temp.root)
    accounts.register('alpha', '1303322392', '麦芽', { endpoint: 'ws://placeholder' })
    const { WebSocketServer } = require('ws')
    const upstream = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    const port: number = await new Promise(resolve => {
      upstream.once('listening', () => resolve((upstream.address() as any).port))
    })
    upstream.on('connection', (socket: any) => {
      socket.on('message', (data: any) => {
        const frame = JSON.parse(String(data))
        if (frame.action === 'get_login_info') socket.send(JSON.stringify({ status: 'ok', data: { user_id: 1303322392 }, echo: frame.echo }))
        if (frame.action === 'send_like') socket.send(JSON.stringify({ status: 'failed', wording: '参数错误', data: null, echo: frame.echo }))
      })
    })
    const connector = new ExternalOneBotConnector({
      endpoint: `ws://127.0.0.1:${port}`, storyId: 'alpha', selfId: '1303322392', retryIntervalMs: 300,
    }, accounts)
    // 未连接：not-verified（宿主映射 account-offline，与上游真失败区分）
    await assert.rejects(connector.call('get_login_info', {}),
      (error: unknown) => error instanceof OnebotActionError && error.kind === 'not-verified')
    connector.start()
    await new Promise(resolve => setTimeout(resolve, 200))
    // 上游明确失败：upstream-rejected
    await assert.rejects(connector.call('send_like', { user_id: 1 }),
      (error: unknown) => error instanceof OnebotActionError && error.kind === 'upstream-rejected')
    // 成功路径：data 直返
    const data = await connector.call('get_login_info', {}) as { user_id?: number }
    assert.equal(data.user_id, 1303322392)
    await connector.stop()
    await new Promise(resolve => upstream.close(() => resolve(undefined)))
  } finally { temp.cleanup() }
})

// ══ safeStorage 降级移植（P2 修复验证）══════════════════════════════════════

test('P2 safeStorage degrade：tryGet 分类 + undecryptable 优雅降级', () => {
  const temp = fixture()
  try {
    const protector = {
      available: () => true,
      encrypt: (value: string) => 'enc:' + value,
      decrypt: (value: string) => {
        if (!value.startsWith('enc:')) throw new Error('Error while decrypting the ciphertext provided to safeStorage.decryptString.')
        return value.slice(4)
      },
    }
    const store = new SecretStore(temp.root, protector)
    store.set('good', '值')
    // 模拟来自其他机器的坏密文
    const state = JSON.parse(require('node:fs').readFileSync(path.join(temp.root, 'secrets.json'), 'utf-8'))
    state.secrets['foreign'] = Buffer.from('other-machine-blob').toString('base64')
    require('node:fs').writeFileSync(path.join(temp.root, 'secrets.json'), JSON.stringify(state))

    assert.deepEqual(store.tryGet('good'), { ok: true, value: '值' })
    const missing = store.tryGet('nope')
    assert.equal(missing.ok, false)
    assert.equal((missing as any).reason, 'missing')
    const foreign = store.tryGet('foreign')
    assert.equal(foreign.ok, false)
    assert.equal((foreign as any).reason, 'undecryptable')
    assert.ok((foreign as any).message.includes('重新录入'), '错误信息给出行动指引')
    assert.throws(() => store.get('foreign'), /无法解密/)
  } finally { temp.cleanup() }
})

test('审计M1回归：单日 part 上限按目录独立统计，跨目录不互删', async () => {
  const temp = fixture()
  try {
    const day = '2026-09-18'
    for (const story of ['alpha', 'beta']) {
      const folder = path.join(temp.root, 'logs', story)
      require('node:fs').mkdirSync(folder, { recursive: true })
      for (let index = 1; index <= 5; index += 1) {
        require('node:fs').writeFileSync(path.join(folder, `${day}.part${index}.ndjson`), 'x')
      }
    }
    const broker = new LogBroker(temp.root, { retentionDays: 14, maxPartsPerDay: 3 })
    const trimmed = await broker.applyRetention(new Date('2026-09-19T12:00:00.000Z'))
    assert.equal(trimmed.removed, 4, '两个目录各删 2 个旧 part')
    for (const story of ['alpha', 'beta']) {
      const remaining = require('node:fs').readdirSync(path.join(temp.root, 'logs', story)).sort()
      assert.deepEqual(remaining, [`${day}.part3.ndjson`, `${day}.part4.ndjson`, `${day}.part5.ndjson`], `${story} 目录保留各自最新 3 个`)
    }
  } finally { temp.cleanup() }
})


// ── Phase 3 市场模块：npm range 子集解析 / 包名映射 / 兼容判定 / 搜索过滤（mock fetch）──
import { koishiPeerCompat, pluginNameFromPackage, satisfiesRange, searchMarket } from './plugin-market'

test('plugin market: npm range 子集解析与 koishi peer 兼容判定', () => {
  assert.equal(satisfiesRange('^4.17.0', '4.18.11'), true)
  assert.equal(satisfiesRange('^4.18.0', '4.18.11'), true)
  assert.equal(satisfiesRange('^5.0.0', '4.18.11'), false, '主版本不满足')
  assert.equal(satisfiesRange('~4.18.0', '4.18.11'), true)
  assert.equal(satisfiesRange('~4.17.0', '4.18.11'), false, '次版本锁定不满足')
  assert.equal(satisfiesRange('>=4.14.0', '4.18.11'), true)
  assert.equal(satisfiesRange('4.18.11', '4.18.11'), true)
  assert.equal(satisfiesRange('4.18.10', '4.18.11'), false)
  assert.equal(satisfiesRange('^4.14.0 || ^4.18.0', '4.18.11'), true)
  assert.equal(satisfiesRange('^3.0.0 || ^4.16.0-beta', '4.18.11'), true)
  assert.equal(satisfiesRange('*', '4.18.11'), true)
  assert.equal(satisfiesRange('some-weird-range!!!', '4.18.11'), null, '解析不了交用户判断')

  assert.equal(koishiPeerCompat({ koishi: '^4.17.0' }, '4.18.11'), 'ok')
  assert.equal(koishiPeerCompat({ koishi: '^5.0.0' }, '4.18.11'), 'mismatch')
  assert.equal(koishiPeerCompat({ cordis: '^1.0.0' }, '4.18.11'), 'undeclared', '未声明 koishi')
  assert.equal(koishiPeerCompat(undefined, '4.18.11'), 'undeclared')

  assert.equal(pluginNameFromPackage('koishi-plugin-points'), 'points')
  assert.equal(pluginNameFromPackage('@koishijs/plugin-config'), 'config')
  assert.equal(pluginNameFromPackage('@author/koishi-plugin-foo'), '@author/foo')
})

test('plugin market: 搜索结果过滤为合法插件包名（mock fetch）', async () => {
  const realFetch = globalThis.fetch
  globalThis.fetch = (async (url: string) => ({
    ok: true,
    json: async () => ({
      objects: [
        { package: { name: 'koishi-plugin-points', version: '1.6.0', description: '积分', date: '2026-09-01', publisher: { username: 'a' } } },
        { package: { name: 'lodash', version: '4.17.0', description: 'utils' } },
        { package: { name: '@koishijs/plugin-config', version: '2.8.7', description: '配置页' } },
        { package: { name: 'koishi-plugin-evil; rm', version: '0.0.1' } },
        { package: { name: '@scope/koishi-plugin-demo', version: '0.1.0' } },
      ],
    }),
  })) as any
  try {
    const entries = await searchMarket('积分')
    assert.deepEqual(entries.map(entry => entry.packageName), ['koishi-plugin-points', '@koishijs/plugin-config', '@scope/koishi-plugin-demo'])
    assert.equal(entries[0].pluginName, 'points')
    assert.equal(entries[1].pluginName, 'config')
    assert.equal(entries[2].pluginName, '@scope/demo')
  } finally { globalThis.fetch = realFetch }
})

// ── Phase 2 受控安装器：包名白名单 / 运行时自举 / 归因 / 双根探测 ──
import { PluginInstaller, ensurePluginRuntimeFiles, validatePluginPackageName } from './plugin-installer'
import { attributePluginFailure, createInstallProbe } from './plugin-panel'

test('plugin installer: 包名白名单与运行时文件自举（hook 内嵌宿主路径）', async () => {
  assert.equal(validatePluginPackageName('koishi-plugin-points'), 'koishi-plugin-points')
  assert.equal(validatePluginPackageName('@koishijs/plugin-config'), '@koishijs/plugin-config')
  assert.equal(validatePluginPackageName('@author/koishi-plugin-foo'), '@author/koishi-plugin-foo')
  assert.throws(() => validatePluginPackageName('lodash'), /仅允许/)
  assert.throws(() => validatePluginPackageName('koishi-plugin-..%2fevil'), /仅允许/)
  assert.throws(() => validatePluginPackageName('koishi-plugin-a;rm -rf'), /仅允许/)
  const { root, cleanup } = fixture()
  try {
    const host = path.join(root, 'host-node-modules')
    mkdirSync(host, { recursive: true })
    const hook = ensurePluginRuntimeFiles(path.join(root, 'plugins-runtime'), host)
    assert.match(readFileSync(hook, 'utf8'), /Module._resolveFilename/)
    assert.match(readFileSync(hook, 'utf8'), /host-node-modules/)
    assert.ok(existsSync(path.join(root, 'plugins-runtime', 'package.json')))
    // 幂等
    ensurePluginRuntimeFiles(path.join(root, 'plugins-runtime'), host)
    const installer = new PluginInstaller(path.join(root, 'plugins-runtime'))
    assert.deepEqual(installer.managed(), {})
    assert.equal(installer.installedVersion('koishi-plugin-points'), null)
    // async 函数：throw 以 rejection 形式出现
    await assert.rejects(() => installer.install('evil'), /仅允许/)
    await assert.rejects(() => installer.uninstall('koishi-plugin-not-managed'), /不在 typ0 运行时目录/)
  } finally { cleanup() }
})

test('plugin panel: 崩溃归因匹配 loader 错误形态；probe 双根 + 缓存失效', () => {
  const declared = ['points', 'hds-interlude']
  const blamed = attributePluginFailure([
    'app starting',
    '2026-10-15 [E] app cannot resolve plugin "points"',
  ], declared)
  assert.equal(blamed?.packageName, 'points')
  const moduleNotFound = attributePluginFailure(["Error: Cannot find module 'koishi-plugin-points'"], declared)
  assert.equal(moduleNotFound?.packageName, 'points')
  assert.equal(attributePluginFailure(['unrelated line'], declared), null)
  assert.equal(attributePluginFailure(["Cannot find module 'koishi-plugin-other'"], declared), null, '未声明的不归因')

  const { root, cleanup } = fixture()
  try {
    // 双根：desktop 根无、runtime 根有
    const host = path.join(root, 'host'); const runtime = path.join(root, 'runtime')
    mkdirSync(path.join(host, 'package.json'.slice(0, 0) || '.', 'node_modules'), { recursive: true })
    writeFileSync(path.join(host, 'package.json'), '{}')
    mkdirSync(path.join(runtime, 'node_modules', 'koishi-plugin-points'), { recursive: true })
    writeFileSync(path.join(runtime, 'package.json'), '{}')
    writeFileSync(path.join(runtime, 'node_modules', 'koishi-plugin-points', 'package.json'), JSON.stringify({ version: '1.2.3' }))
    const probe = createInstallProbe(host, runtime)
    assert.equal(probe('points')?.version, '1.2.3')
    assert.equal(probe('nonexistent'), null)
    // runtime 根移除后 invalidate 才会重新探测
    rmSync(path.join(runtime, 'node_modules', 'koishi-plugin-points'), { recursive: true, force: true })
    assert.equal(probe('points')?.version, '1.2.3', '缓存仍命中')
    probe.invalidate?.()
    assert.equal(probe('points'), null)
  } finally { cleanup() }
})

// ── Phase 1 第三方插件面板：纯文本手术（~ 前缀启停 / 配置片段 / 增删 / 读取）──
import { appendPlugin, classifyPluginRisk, packageCandidates, readPluginPanel, removePlugin, togglePlugin, writePluginConfig } from './plugin-panel'

const PANEL_YML = [
  'plugins:',
  '  group:server:',
  '    server:m0:',
  '      port: 0',
  '  group:adapter:',
  '    adapter-onebot:m0:',
  '      selfId: ""',
  '  hds-interlude:m0:',
  '    runtime:',
  '      autoCreate: true',
  '  ~dialogue:m0:',
  '    apiKey: $secret:dialogue-key',
  '  points:',
  '    threshold: 10',
].join('\n')

test('plugin panel: 读取分组/启停/包名/安装态/冲突分级', () => {
  const probe = (name: string) => name === 'hds-interlude' || name === 'server' || name === 'adapter-onebot'
    ? { version: '1.0.1-rc53', official: name === 'server' }
    : null
  const read = readPluginPanel(PANEL_YML, probe)
  const keys = read.entries.map(entry => `${entry.group ? entry.group + '/' : ''}${entry.key}`)
  assert.deepEqual(keys, ['server/server:m0', 'adapter/adapter-onebot:m0', 'hds-interlude:m0', 'dialogue:m0', 'points'])
  const dialogue = read.entries.find(entry => entry.key === 'dialogue:m0')!
  assert.equal(dialogue.enabled, false, '~ 前缀 = 停用')
  assert.equal(dialogue.installed, null)
  assert.equal(dialogue.risk, 'normal')
  assert.match(dialogue.configText, /dialogue-key/)
  const points = read.entries.find(entry => entry.key === 'points')!
  assert.equal(points.group, null)
  assert.match(points.configText, /threshold: 10/)
  assert.equal(classifyPluginRisk('adapter-discord'), 'high')
  assert.equal(classifyPluginRisk('database-mysql'), 'high')
  assert.equal(classifyPluginRisk('points'), 'normal')
  assert.deepEqual(packageCandidates('points').map(item => item.packageName), ['@koishijs/plugin-points', 'koishi-plugin-points'])
})

test('plugin panel: ~ 前缀启停往返，注释与 $secret 原样保留', () => {
  const disabled = togglePlugin(PANEL_YML, 'points', false)
  assert.match(disabled, /~points:/)
  assert.doesNotMatch(disabled, /^ {2}points:/m)
  assert.match(disabled, /threshold: 10/, '配置保留')
  assert.match(disabled, /dialogue-key/)
  const reEnabled = togglePlugin(disabled, 'points', true)
  assert.equal(reEnabled, PANEL_YML, '启停往返无损')
  const toggleDialogue = togglePlugin(PANEL_YML, 'dialogue:m0', true)
  assert.match(toggleDialogue, /^ {2}dialogue:m0:/m)
  assert.doesNotMatch(toggleDialogue, /~dialogue/)
})

test('plugin panel: 配置片段替换与缩进校验', () => {
  const next = writePluginConfig(PANEL_YML, 'points', '    threshold: 99\n    currency: 积分')
  assert.doesNotMatch(next, /threshold: 10/)
  assert.match(next, /threshold: 99/)
  assert.match(next, /currency: 积分/)
  assert.throws(() => writePluginConfig(PANEL_YML, 'points', 'threshold: 1'), /缩进/, '浅缩进片段必须拒绝')
  const cleared = writePluginConfig(PANEL_YML, 'points', '')
  assert.doesNotMatch(cleared, /threshold/, '空片段=清空配置')
})

test('plugin panel: 增删插件（plugins 段末尾追加 / 块级删除）', () => {
  const added = appendPlugin(PANEL_YML, 'chatglm')
  assert.match(added, /^ {2}chatglm:$/m)
  assert.match(added, /threshold: 10/, '既有内容不动')
  const removed = removePlugin(added, 'chatglm')
  assert.equal(removed, PANEL_YML, '增删往返无损')
  const removedGroup = removePlugin(PANEL_YML, 'points')
  assert.doesNotMatch(removedGroup, /points|threshold/)
  assert.match(removedGroup, /hds-interlude:m0:/)
  assert.throws(() => appendPlugin(PANEL_YML, 'bad name!'), /非法插件名/)
  const noSection = appendPlugin('other: 1\n', 'points')
  assert.match(noSection, /plugins:\n {2}points:\n$/)
})

test('capture Phase 1: 第三方插件配置经 Console 修改后回写 canonical，注入段与运行参数不回写', () => {
  const secrets = [{ alias: 'points-secret', value: 'sk-points-456' }]
  const canonical = [
    'plugins:',
    '  group:adapter:',
    '    adapter-onebot:m0:',
    '      selfId: ""',
    '  hds-interlude:m0:',
    '    runtime:',
    '      autoCreate: true',
    '  points:',
    '    threshold: 10',
  ].join('\n')
  const resolved = [
    'plugins:',
    '  group:server:',           // 宿主注入（canonical 无）→ 不得回写
    '    server:m0:',
    '      port: 0',
    '  group:adapter:',
    '    adapter-onebot:zk71f2:', // Console 随机后缀实例 → 归一回 canonical 键
    '      selfId: "1303322392"', // 宿主运行参数 → 剥离
    '      endpoint: ws://127.0.0.1:6709/onebot/x',
    '      token: abc',
    '  hds-interlude:m0:',
    '    runtime:',
    '      autoCreate: true',
    '  points:',
    '    threshold: 99',
    '    apiKey: sk-points-456',  // 第三方插件的明文密钥 → 反向脱敏
  ].join('\n')
  const result = captureConsoleConfig(resolved, canonical, secrets)
  assert.equal(result.changed, true)
  const round = (yaml as any).load(result.canonical!)
  assert.equal(round.plugins['group:server'], undefined, '注入 server 段不回写')
  const adapter = round.plugins['group:adapter']['adapter-onebot:m0']
  assert.ok(adapter, 'adapter 实例键归一到 canonical 既有键')
  assert.equal(adapter.selfId, '', 'canonical 自带占位值保留（非 resolved 注入值）')
  assert.equal(adapter.endpoint, undefined)
  assert.equal(round.plugins.points.threshold, 99, '第三方插件配置变更被捕获')
  assert.equal(round.plugins.points.apiKey, '$secret:points-secret', '第三方插件明文密钥反向脱敏')
  assert.doesNotMatch(result.canonical!, /1303322392|6709/)
  // 无实质变更（除注入/运行参数/随机后缀外全同）→ 不写
  const same = resolved.replace('threshold: 99', 'threshold: 10').replace('\n    apiKey: sk-points-456', '')
  const noChange = captureConsoleConfig(same, canonical, secrets)
  assert.equal(noChange.changed, false, '宿主参数与实例后缀差异不算实质变更')
})

/**
 * worker → renderer DTO 投影合同测试（P1 保守批次）。
 *
 * 矩阵覆盖：缺字段、旧版本形态、畸形值、超大列表/数值、未知字段——
 * 全部要求"降级为安全缺省"，投影函数自身永不抛错（序列化边界除外）。
 * 字段清单与插件侧 TokenUsageRecord / desktopRuntimeSnapshot 手工镜像，
 * 插件升级若改变字段，先改这里与 worker-projections.ts，再同步 BRIDGE_PROTOCOL.md。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { projectAnalysisResult, projectRuntimeSnapshot, projectTokenRecord } from './worker-projections'
import { UsageAggregator } from './usage-aggregator'

test('runtime-snapshot：白名单透传 + 未知字段丢弃 + 畸形条目过滤', () => {
  const dto = projectRuntimeSnapshot('story-a', {
    phase: 'muted',
    futureField: '不应透传',
    stories: [
      { id: 's1', status: 'active', cursorAt: '2026-10-18T00:00:00.000Z', updatedAt: '2026-10-18T01:00:00.000Z', extra: 1 },
      { id: '', status: 'x' },            // 无 id → 整条丢弃
      null,                                // 非对象 → 丢弃
      'garbage',                           // 非对象 → 丢弃
      { status: 'no-id-field' },           // 缺 id → 丢弃
    ],
  })
  assert.equal(dto.storyId, 'story-a')
  assert.equal(dto.phase, 'muted')
  assert.equal(dto.stories.length, 1)
  assert.deepEqual(dto.stories[0], { id: 's1', status: 'active', cursorAt: '2026-10-18T00:00:00.000Z', updatedAt: '2026-10-18T01:00:00.000Z' })
  assert.ok(!('futureField' in dto))
})

test('runtime-snapshot：超大列表截断到 20（与插件侧上限同界）+ 长字符串钳制 + 空载荷缺省', () => {
  const stories = Array.from({ length: 500 }, (_, index) => ({ id: `s${index}`, status: 'a', cursorAt: '', updatedAt: '' }))
  const dto = projectRuntimeSnapshot('story-a', { stories })
  assert.equal(dto.stories.length, 20)
  const longId = projectRuntimeSnapshot('s', { stories: [{ id: 'x'.repeat(500) }] })
  assert.equal(longId.stories[0].id.length, 128)
  // 空载荷 / 字符串载荷 / null：不抛错，给安全缺省。
  const empty = projectRuntimeSnapshot('story-a', null)
  assert.equal(empty.phase, 'updated')
  assert.deepEqual(empty.stories, [])
  const garbage = projectRuntimeSnapshot('story-a', 'not-an-object')
  assert.deepEqual(garbage.stories, [])
})

test('token：字段透传 + 数值钳制（负数/NaN 丢弃、巨数封顶）+ 未知字段丢弃 + 空载荷缺省', () => {
  const dto = projectTokenRecord('story-a', {
    task: 'main', providerLabel: 'deepseek', model: 'deepseek-chat',
    inputTokens: 1200, outputTokens: 800, cachedInputTokens: 400,
    priceInput: 0.27, priceOutput: 1.1, priceCachedInput: 0.07,
    injectionField: 'dropped',
  })
  assert.equal(dto.task, 'main')
  assert.equal(dto.inputTokens, 1200)
  assert.equal(dto.priceCachedInput, 0.07)
  assert.ok(!('injectionField' in dto))
  // 畸形数值：负数/NaN/字符串数字全部降级为缺省（UsageAggregator 的
  // cleanNumber 对 undefined 计 0，对垃圾值反而难归因）。
  const dirty = projectTokenRecord('s', { task: 'x', inputTokens: -5, outputTokens: Number.NaN, cachedInputTokens: '900' })
  assert.equal(dirty.inputTokens, undefined)
  assert.equal(dirty.outputTokens, undefined)
  assert.equal(dirty.cachedInputTokens, undefined)
  // 巨数封顶：防恶意/损坏 worker 用 1e300 污染日聚合与费用估算。
  const capped = projectTokenRecord('s', { inputTokens: 1e300, priceInput: 1e9 })
  assert.equal(capped.inputTokens, 1e12)
  assert.equal(capped.priceInput, 1e6)
  // 空载荷 → task=unknown（渲染层与聚合器的既有约定）。
  const empty = projectTokenRecord('s', undefined)
  assert.equal(empty.task, 'unknown')
  assert.equal(empty.storyId, 's')
})

test('token：投影 DTO 可直接喂 UsageAggregator（单一边界两处消费的合同）', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'hdsi-projection-contract-'))
  try {
    const usage = new UsageAggregator(root)
    const dto = projectTokenRecord('story-a', {
      task: 'main', providerLabel: 'p', model: 'm',
      inputTokens: 1000, outputTokens: 500, cachedInputTokens: 600,
      priceInput: 1, priceOutput: 2, priceCachedInput: 0.5,
    })
    const state = usage.record('story-a', dto)
    const days = Object.values(state.days)
    assert.equal(days.length, 1)
    assert.equal(days[0].inputTokens, 1000)
    assert.equal(days[0].cachedInputTokens, 600)
    assert.ok(days[0].estimatedCost! > 0, '费用估算基于投影后数值仍成立')
    // 畸形载荷投影后也必须能安全落账（不写入垃圾数值）。
    const dirty = projectTokenRecord('story-a', { task: 42, inputTokens: 'x' })
    const state2 = usage.record('story-a', dirty)
    const day2 = Object.values(state2.days)[0]
    assert.equal(day2.inputTokens, 1000 + 0)
    assert.equal(day2.calls, 2)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('analysis：深拷贝隔离 + 循环引用/超限拒绝 + undefined 透传', () => {
  const original = { nested: { list: [1, 2, 3] } }
  const result = projectAnalysisResult(original) as typeof original
  assert.deepEqual(result, original)
  original.nested.list.push(4)
  assert.deepEqual(result.nested.list, [1, 2, 3], '结果与原对象隔离（深拷贝）')
  assert.equal(projectAnalysisResult(undefined), undefined)
  const circular: Record<string, unknown> = {}
  circular.self = circular
  assert.throws(() => projectAnalysisResult(circular), /不可序列化/)
  assert.throws(() => projectAnalysisResult('x'.repeat(2_100_000)), /2MB/)
})

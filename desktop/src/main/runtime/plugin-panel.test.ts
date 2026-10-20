/**
 * 审计批#5 回归：同名实例键在不同分组合法共存（group:first/foo 与
 * group:second/foo）。操作必须按 (rawKey, group) 块级定位——旧行级
 * first-match 会把对第二个分组的操作落到第一个分组上。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readPluginPanel, togglePlugin, writePluginConfig, removePlugin } from './plugin-panel'

const SOURCE = `plugins:
  group:first:
    foo:
      tag: first
  group:second:
    foo:
      tag: second
  top:
    tag: top
`

const probe = () => null

test('readPluginPanel：同名键按分组产出两个条目', () => {
  const panel = readPluginPanel(SOURCE, probe)
  const foos = panel.entries.filter(entry => entry.key === 'foo')
  assert.equal(foos.length, 2)
  assert.deepEqual(foos.map(entry => entry.group).sort(), ['first', 'second'])
  assert.equal(panel.entries.filter(entry => entry.key === 'top')[0].group, null)
})

test('togglePlugin：分组维度定位——操作 second 不动 first', () => {
  const next = togglePlugin(SOURCE, 'foo', false, 'second')
  const panel = readPluginPanel(next, probe)
  const first = panel.entries.find(entry => entry.key === 'foo' && entry.group === 'first')
  const second = panel.entries.find(entry => entry.key === 'foo' && entry.group === 'second')
  assert.equal(first?.enabled, true, 'first 分组不受影响')
  assert.equal(second?.enabled, false, 'second 分组被停用')
})

test('togglePlugin：无 group 时仍定位顶层键（不落进分组）', () => {
  const next = togglePlugin(SOURCE, 'top', false, null)
  const panel = readPluginPanel(next, probe)
  assert.equal(panel.entries.find(entry => entry.key === 'top')?.enabled, false)
  assert.equal(panel.entries.find(entry => entry.key === 'foo' && entry.group === 'first')?.enabled, true)
})

test('writePluginConfig：配置写入正确的分组实例', () => {
  const next = writePluginConfig(SOURCE, 'foo', '      tag: rewritten', 'second')
  const panel = readPluginPanel(next, probe)
  assert.equal(panel.entries.find(entry => entry.key === 'foo' && entry.group === 'first')?.configText, '      tag: first')
  assert.equal(panel.entries.find(entry => entry.key === 'foo' && entry.group === 'second')?.configText, '      tag: rewritten')
})

test('removePlugin：删除正确的分组实例', () => {
  const next = removePlugin(SOURCE, 'foo', 'second')
  const panel = readPluginPanel(next, probe)
  const foos = panel.entries.filter(entry => entry.key === 'foo')
  assert.equal(foos.length, 1)
  assert.equal(foos[0].group, 'first')
  assert.equal(panel.entries.find(entry => entry.key === 'top')?.key, 'top')
})

test('旧调用形态兼容：无 group 参数保持既有行为（first-match 兜底）', () => {
  const next = togglePlugin(SOURCE, 'foo', false)
  const panel = readPluginPanel(next, probe)
  assert.equal(panel.entries.find(entry => entry.key === 'foo' && entry.group === 'first')?.enabled, false)
})

const WITHOUT_SECOND = [
  'plugins:',
  '  group:first:',
  '    foo:',
  '      tag: first',
  '  top:',
  '    tag: top',
  '',
].join('\n')

const WITHOUT_TOP = [
  'plugins:',
  '  group:first:',
  '    foo:',
  '      tag: first',
  '  group:second:',
  '    foo:',
  '      tag: second',
  '',
].join('\n')

test('边界：显式 group 未命中且异处有同名键 → 必须报错，不得模糊命中', () => {
  assert.throws(() => togglePlugin(WITHOUT_SECOND, 'foo', false, 'second'), /未找到插件 foo（分组 second）/)
  assert.throws(() => removePlugin(WITHOUT_SECOND, 'foo', 'second'), /未找到插件 foo（分组 second）/)
  assert.throws(() => writePluginConfig(WITHOUT_SECOND, 'foo', '      x: 1', 'second'), /未找到插件 foo（分组 second）/)
  // first 分组的同名键必须原样保留（未发生任何误改写）
  const panel = readPluginPanel(WITHOUT_SECOND, probe)
  assert.equal(panel.entries.find(entry => entry.key === 'foo' && entry.group === 'first')?.enabled, true)
})

test('边界：显式 null（顶层）未命中而同名键在分组内 → 同样报错', () => {
  assert.throws(() => togglePlugin(WITHOUT_TOP, 'top', false, null), /未找到插件 top/)
})

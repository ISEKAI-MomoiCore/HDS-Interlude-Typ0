/**
 * IPC 调用方门控合同测试（P2 输入边界批次）。
 * 纯谓词测试——register.ts 的 electron 依赖不进 node 测试；这里锁的是
 * 门控语义本身：同一性放行、非信任源拒绝、信任源缺失 fail-closed、
 * 信任源切换后旧引用失效（窗口重建场景）。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createSenderGuard } from './sender-guard'

test('sender 门控：同一性放行 + 非信任源拒绝', () => {
  const mainWebContents = { id: 1 }
  const guard = createSenderGuard(() => mainWebContents)
  assert.equal(guard(mainWebContents), true, '主窗口 webContents 放行')
  assert.equal(guard({ id: 1 }), false, '结构相同的其它对象不放行（同一性而非深比较）')
  assert.equal(guard(undefined), false)
  assert.equal(guard(null), false)
})

test('sender 门控：信任源缺失时一律拒绝（fail-closed）', () => {
  const guard = createSenderGuard(() => undefined)
  assert.equal(guard({ id: 1 }), false, '窗口未建/已毁时不放行任何调用')
  const nullGuard = createSenderGuard(() => null)
  assert.equal(nullGuard({ id: 1 }), false)
})

test('sender 门控：窗口重建后旧 webContents 失效、新引用放行', () => {
  let current: unknown = { id: 1 }
  const guard = createSenderGuard(() => current)
  const old = { id: 1 }
  assert.equal(guard(old), false, '不是当前窗口的引用不放行')
  current = old
  assert.equal(guard(old), true)
  const recreated = { id: 2 }
  current = recreated
  assert.equal(guard(old), false, '窗口重建后旧引用立即失效')
  assert.equal(guard(recreated), true, '新窗口引用放行')
})

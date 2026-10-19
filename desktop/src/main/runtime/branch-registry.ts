import type { StoryHandle, StoryMeta } from '../stories'

/**
 * 分支谱系纯函数层：从 manifest 集合构建分支树。分支 = 带 `parent` 的完整剧本，
 * 谱系权威来自 `parent.storyId`；目录名不参与解析。无 IO、无副作用，直接可测。
 */
export interface BranchNode {
  storyId: string
  name: string
  parent?: { storyId: string, forkedAt: string, forkPoint?: { entryId?: number, occurredAt?: string } }
  /** parent.storyId 不在当前故事集合中（被删除/导入自外部）——功能不受限，仅标注。 */
  orphan: boolean
  /** 深度：根=0；用于 Browser 树形缩进。环引用防御：按祖先链计算，异常深度假定为孤儿。 */
  depth: number
}

export interface BranchTree {
  rootId: string
  nodes: BranchNode[]
}

function parentOf(meta: StoryMeta): StoryMeta['parent'] {
  return meta.parent
}

export function buildBranchTree(handles: Array<Pick<StoryHandle, 'meta'>>): BranchTree[] {
  const byId = new Map(handles.map(handle => [handle.meta.id, handle.meta] as const))
  const memo = new Map<string, { rootId: string, depth: number, orphan: boolean } | undefined>()

  // 解析某个故事的根与深度；检测环（parent 链不应成环，但导入可能构造出）。
  const resolve = (id: string, seen: Set<string>): { rootId: string, depth: number, orphan: boolean } | undefined => {
    if (memo.has(id)) return memo.get(id)
    const meta = byId.get(id)
    if (!meta) return undefined
    const parent = parentOf(meta)
    if (!parent) {
      const result = { rootId: id, depth: 0, orphan: false }
      memo.set(id, result)
      return result
    }
    if (seen.has(id) || seen.size > 32) {
      // 环引用或异常深链：按根处理，不再向上解析。
      const result = { rootId: id, depth: 0, orphan: false }
      memo.set(id, result)
      return result
    }
    seen.add(id)
    const parentResolved = byId.has(parent.storyId) ? resolve(parent.storyId, seen) : undefined
    const result = parentResolved
      ? { rootId: parentResolved.rootId, depth: parentResolved.depth + 1, orphan: parentResolved.orphan }
      : { rootId: id, depth: 0, orphan: true }
    memo.set(id, result)
    return result
  }

  const trees = new Map<string, BranchTree>()
  for (const handle of handles) {
    const meta = handle.meta
    const resolved = resolve(meta.id, new Set())
    if (!resolved) continue
    const rootId = resolved.orphan ? meta.id : resolved.rootId
    let tree = trees.get(rootId)
    if (!tree) { tree = { rootId, nodes: [] }; trees.set(rootId, tree) }
    tree.nodes.push({
      storyId: meta.id,
      name: meta.name,
      ...(parentOf(meta) ? { parent: parentOf(meta) } : {}),
      orphan: resolved.orphan || !byId.has(parentOf(meta)?.storyId ?? meta.id) && !!parentOf(meta),
      depth: resolved.depth,
    })
  }
  // 树内按深度+名字稳定排序，Renderer 无需再排。
  for (const tree of trees.values()) {
    tree.nodes.sort((left, right) => left.depth - right.depth || left.name.localeCompare(right.name, 'zh-CN'))
  }
  return [...trees.values()].sort((left, right) => left.rootId.localeCompare(right.rootId))
}

/** 树内互斥：返回与 targetId 同根、且当前有 worker 运行的其它故事 ID 列表。 */
export function activeSiblingsInTree(handles: StoryHandle[], targetId: string): string[] {
  const target = handles.find(handle => handle.meta.id === targetId)
  if (!target) return []
  const trees = buildBranchTree(handles)
  const tree = trees.find(item => item.nodes.some(node => node.storyId === targetId))
  if (!tree) return []
  return handles
    .filter(handle => handle.meta.id !== targetId
      && handle.running
      && tree.nodes.some(node => node.storyId === handle.meta.id))
    .map(handle => handle.meta.id)
}

/** 下一个分支 ID：<rootId>.b<序号>-<slug>；序号取现有最大 +1。 */
export function nextBranchId(handles: Array<Pick<StoryHandle, 'meta'>>, rootId: string, slug: string): string {
  const prefix = `${rootId}.b`
  let max = 0
  for (const handle of handles) {
    const id = handle.meta.id
    if (!id.startsWith(prefix)) continue
    const rest = id.slice(prefix.length)
    const match = rest.match(/^(\d+)(?:[-_.]|$)/)
    if (match) max = Math.max(max, Number(match[1]))
  }
  const safeSlug = slug.replace(/[^a-z0-9_-]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'branch'
  const candidate = `${prefix}${max + 1}-${safeSlug}`
  const taken = new Set(handles.map(handle => handle.meta.id))
  if (!taken.has(candidate)) return candidate
  let suffix = 2
  while (taken.has(`${candidate}-${suffix}`)) suffix += 1
  return `${candidate}-${suffix}`
}

/** 根 ID：分支取其 parent 链的根；根剧本取自身 ID。（供目录命名与互斥判定） */
export function rootIdOf(handles: Array<Pick<StoryHandle, 'meta'>>, storyId: string): string {
  const trees = buildBranchTree(handles)
  const tree = trees.find(item => item.nodes.some(node => node.storyId === storyId))
  return tree?.rootId ?? storyId
}

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'
import { assertChildPath, writeJsonAtomic } from './json-file'

interface PortableMeta { schemaVersion?: number, id?: string, name?: string, createdAt?: string, updatedAt?: string, lastOpenedAt?: string, [key: string]: unknown }

function assertStoryId(value: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value)) throw new Error('剧本 ID 只能使用字母、数字、.、- 或 _，长度 1–64。')
}

function readPortableMeta(storyDir: string): PortableMeta {
  const manifest = path.join(storyDir, 'story.json')
  if (!existsSync(manifest)) throw new Error('所选目录不是 typ-0 剧本：缺少 story.json。')
  try {
    const raw = JSON.parse(readFileSync(manifest, 'utf8')) as PortableMeta
    if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || typeof raw.name !== 'string') throw new Error()
    return raw
  } catch { throw new Error('剧本 story.json 无法读取或格式无效。') }
}

/**
 * Creates a portable, recoverable story-folder snapshot. Secrets are not in a
 * story folder by design; volatile resolved worker configuration is excluded.
 */
export class StoryArchiveService {
  constructor(private readonly backupRoot: string, private readonly trashRoot = path.join(backupRoot, '..', 'trash')) {}

  create(storyId: string, storyDir: string) {
    assertStoryId(storyId)
    if (!existsSync(storyDir) || !statSync(storyDir).isDirectory()) throw new Error('剧本目录不存在。')
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const storyRoot = assertChildPath(this.backupRoot, path.join(this.backupRoot, storyId))
    const target = assertChildPath(storyRoot, path.join(storyRoot, stamp))
    mkdirSync(storyRoot, { recursive: true })
    cpSync(storyDir, target, {
      recursive: true,
      filter: source => !source.split(path.sep).includes('.typ-0-runtime'),
    })
    this.trim(storyRoot)
    return target
  }

  /** Copies a portable story directory into another location; secrets are never story-owned. */
  export(storyId: string, storyDir: string, destinationRoot: string) {
    assertStoryId(storyId)
    readPortableMeta(storyDir)
    const root = path.resolve(destinationRoot)
    mkdirSync(root, { recursive: true })
    const target = assertChildPath(root, path.join(root, storyId))
    if (existsSync(target)) throw new Error(`导出目标已存在同名目录：${target}`)
    this.copyPortable(storyDir, target)
    return target
  }

  /** Imports or forks a portable story using a new local ID; source is never modified. */
  import(sourceDir: string, storiesRoot: string, targetId: string, name?: string) {
    assertStoryId(targetId)
    const source = path.resolve(sourceDir)
    const original = readPortableMeta(source)
    mkdirSync(storiesRoot, { recursive: true })
    const target = assertChildPath(storiesRoot, path.join(storiesRoot, targetId))
    if (existsSync(target)) throw new Error(`目标剧本 ID 已存在：${targetId}`)
    this.copyPortable(source, target)
    const now = new Date().toISOString()
    const meta: PortableMeta = {
      ...original,
      schemaVersion: 1,
      id: targetId,
      name: name?.trim() || `${String(original.name)}（副本）`,
      createdAt: now,
      updatedAt: now,
      lastOpenedAt: now,
      // Bindings belong to the host, not to an imported/forked story.
      accounts: [],
      phase: 'paused',
    }
    writeJsonAtomic(path.join(target, 'story.json'), meta)
    return { target, originalId: original.id, id: targetId, name: meta.name }
  }

  /**
   * 从现有剧本创建分支（选点重启）：完整复制目录（含独立数据库副本），manifest
   * 升为 schemaVersion 2 并写入 parent 谱系。源剧本不被修改；新分支默认 paused、
   * 无账号绑定。forkPoint 必填——它标记选点重启的位置（批次 4 才消费其语义）。
   */
  forkBranch(options: {
    sourceDir: string
    storiesRoot: string
    branchId: string
    name: string
    sourceStoryId: string
    forkPoint: { entryId?: number, occurredAt?: string }
  }) {
    assertStoryId(options.branchId)
    if (!Number.isSafeInteger(Number(options.forkPoint.entryId)) && !options.forkPoint.occurredAt) {
      throw new Error('forkPoint 必须提供 entryId 或 occurredAt 之一。')
    }
    const source = path.resolve(options.sourceDir)
    const original = readPortableMeta(source)
    mkdirSync(options.storiesRoot, { recursive: true })
    const target = assertChildPath(options.storiesRoot, path.join(options.storiesRoot, options.branchId))
    if (existsSync(target)) throw new Error(`目标剧本 ID 已存在：${options.branchId}`)
    this.copyPortable(source, target)
    const now = new Date().toISOString()
    const meta: PortableMeta = {
      ...original,
      schemaVersion: 2,
      id: options.branchId,
      name: options.name,
      createdAt: now,
      updatedAt: now,
      lastOpenedAt: now,
      // 分支不继承账号绑定（同一账号不能同时属于运行中的两个剧本）。
      accounts: [],
      phase: 'paused',
      parent: {
        storyId: options.sourceStoryId,
        forkedAt: now,
        forkPoint: {
          ...(Number.isSafeInteger(Number(options.forkPoint.entryId)) ? { entryId: Number(options.forkPoint.entryId) } : {}),
          ...(options.forkPoint.occurredAt ? { occurredAt: options.forkPoint.occurredAt } : {}),
        },
      },
    }
    writeJsonAtomic(path.join(target, 'story.json'), meta)
    return { target, id: options.branchId, name: options.name, sourceId: original.id }
  }

  /** Soft deletion: move the complete story directory into typ-0 trash after a backup. */
  trash(storyId: string, storyDir: string) {
    assertStoryId(storyId)
    readPortableMeta(storyDir)
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const root = assertChildPath(this.trashRoot, path.join(this.trashRoot, storyId))
    const target = assertChildPath(root, path.join(root, stamp))
    mkdirSync(root, { recursive: true })
    renameSync(storyDir, target)
    this.trim(root)
    return target
  }

  private copyPortable(source: string, target: string) {
    cpSync(source, target, {
      recursive: true,
      filter: entry => {
        const parts = entry.split(path.sep)
        return !parts.includes('.typ-0-runtime') && !parts.includes('.typ-0-backups')
      },
    })
  }

  private trim(storyRoot: string) {
    const archives = readdirSync(storyRoot).filter(name => {
      try { return statSync(path.join(storyRoot, name)).isDirectory() } catch { return false }
    }).sort()
    for (const stale of archives.slice(0, Math.max(0, archives.length - 10))) {
      try { rmSync(path.join(storyRoot, stale), { recursive: true, force: true }) } catch { /* best effort */ }
    }
  }
}

/**
 * D3-1：备份可核对性校验——story.json 可读、koishi.yml 存在、SQLite 头合法且
 * quick_check 通过（worker 已 unload，无并发写者，检查结果是权威的）。
 * 任何一项失败都让备份流程抛错，调用方不得把撕裂的快照当作可用存档。
 */
export function verifyStoryArchive(archiveDir: string): { ok: true, checks: string[] } {
  const checks: string[] = []
  const meta = readPortableMeta(archiveDir)
  checks.push(`story.json ok（${meta.id}）`)
  if (!existsSync(path.join(archiveDir, 'koishi.yml'))) throw new Error('备份缺少 koishi.yml。')
  checks.push('koishi.yml ok')
  const dataDir = path.join(archiveDir, 'data')
  if (!existsSync(dataDir)) throw new Error('备份缺少 data 目录。')
  const dbs = readdirSync(dataDir).filter(name => name.endsWith('.db'))
  if (!dbs.length) throw new Error('备份缺少 SQLite 数据库。')
  for (const name of dbs) {
    const file = path.join(dataDir, name)
    const head = readFileSync(file).subarray(0, 16).toString('utf8')
    if (head !== 'SQLite format 3 ') throw new Error(`${name} 不是有效的 SQLite 文件（复制可能撕裂）。`)
    // Electron 主进程（内嵌 Node 20）没有 node:sqlite；魔数校验已是撕裂的
    // 强信号，quick_check 在具备该内建模块的运行时（测试/工具进程）追加执行。
    let DatabaseSync: (new (file: string, options?: { readOnly?: boolean }) => { prepare: (sql: string) => { get(): unknown }, close(): void }) | undefined
    try { DatabaseSync = require('node:sqlite').DatabaseSync } catch { DatabaseSync = undefined }
    if (!DatabaseSync) { checks.push(`${name} SQLite 魔数 ok（运行时无 node:sqlite，跳过 quick_check）`); continue }
    const db = new DatabaseSync(file, { readOnly: true })
    try {
      const row = db.prepare('PRAGMA quick_check').get() as { quick_check?: string } | undefined
      if (row?.quick_check !== 'ok') throw new Error(`${name} quick_check 未通过：${row?.quick_check}`)
      checks.push(`${name} quick_check ok`)
    } finally { db.close() }
  }
  return { ok: true, checks }
}

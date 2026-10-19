/**
 * 插件版 koishi.db → typ0 剧本库的导入支撑（m4 数据库模块）。
 *
 * 事实基线（2026-10-19 实测对照）：两边跑的是同一个哈希锁定的 rc57 插件，
 * 21 张 interlude_* 表同名同语义；插件版只多 koishi-plugin-analytics 的两张
 * 表和 user 表的 usage/timers 两列（Koishi 启动自动迁移会补列）。因此不做
 * 逐表转译——直接整库文件级替换最保真（AUTOINCREMENT 游标、行 id、JSON 列
 * 原样保留）。
 *
 * 隐私边界：探测只产出表级计数与 story selfId（与配置导入的账号标识同级别，
 * 不含任何人设/消息内容）；明文数据永不进入日志与渲染层。
 */
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const nodeRequire = createRequire(__filename)

/** typ0 剧本 worker 的 SQLite 文件名（模板 yml 的 database-sqlite 路径）。 */
export const STORY_DB_NAME = 'hdsi.db'

/** 报告中展示的计数表（脱敏：只取 COUNT(*)，不读内容）。 */
export const REPORT_TABLES = ['story', 'script_entry', 'fact', 'intent', 'scene', 'participant', 'user', 'binding'] as const

export interface KoishiDbStats {
  interludeTables: number
  counts: Record<string, number>
  storySelfIds: string[]
}

export interface KoishiDbProbe extends Partial<KoishiDbStats> {
  found: boolean
  path?: string
  sizeBytes?: number
  /** -wal 非空：源实例可能仍在运行，提示用户先关闭（照拷三件套仍可恢复）。 */
  walActive?: boolean
  error?: string
}

let sqlJsPromise: Promise<any> | undefined

/** 懒加载 @minatojs/sql.js（WASM，无原生依赖；dist 外置 wasm 用 locateFile 指路）。 */
function loadSqlJs(): Promise<any> {
  if (!sqlJsPromise) {
    sqlJsPromise = (async () => {
      const mod: any = await import('@minatojs/sql.js')
      const initSqlJs: (config?: any) => Promise<any> = mod.default ?? mod
      const distDir = path.dirname(nodeRequire.resolve('@minatojs/sql.js'))
      return initSqlJs({ locateFile: (file: string) => path.join(distDir, file) })
    })().catch(error => { sqlJsPromise = undefined; throw error })
  }
  return sqlJsPromise
}

/** 只读探测源库：表级计数 + story 身份。任何失败都降级为 error 字段，不阻断导入流程。 */
export async function probeKoishiDb(dbPath: string): Promise<KoishiDbProbe> {
  if (!existsSync(dbPath)) return { found: false }
  const probe: KoishiDbProbe = { found: true, path: dbPath }
  try { probe.sizeBytes = statSync(dbPath).size } catch { /* 大小仅展示用 */ }
  const walPath = dbPath + '-wal'
  try { probe.walActive = existsSync(walPath) && statSync(walPath).size > 0 } catch { probe.walActive = false }
  let db: any
  try {
    const SQL = await loadSqlJs()
    db = new SQL.Database(dbPath)
    const scalar = (sql: string): number | undefined => {
      try { const result = db.exec(sql); const value = result[0]?.values?.[0]?.[0]; return typeof value === 'number' ? value : undefined } catch { return undefined }
    }
    probe.interludeTables = scalar("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name LIKE 'interlude_%'")
    const counts: Record<string, number> = {}
    for (const table of REPORT_TABLES) {
      const count = scalar(`SELECT COUNT(*) FROM interlude_${table}`)
      if (count !== undefined) counts[table] = count
    }
    probe.counts = counts
    try {
      const rows = db.exec('SELECT selfId FROM interlude_story ORDER BY id LIMIT 3')
      probe.storySelfIds = (rows[0]?.values ?? []).map((row: any[]) => String(row[0] ?? '')).filter(Boolean)
    } catch { probe.storySelfIds = [] }
  } catch (error) {
    probe.error = error instanceof Error ? error.message : String(error)
  } finally {
    try { db?.close() } catch { /* best effort */ }
  }
  return probe
}

/** 整库复制（db + -wal + -shm 三件套）。源库缺主文件时抛错（executeImport 捕获后整体回滚）。 */
export function copyKoishiDb(sourceDbPath: string, storyDir: string): { bytes: number, files: string[] } {
  if (!existsSync(sourceDbPath)) throw new Error(`源数据库不存在：${sourceDbPath}`)
  const dataDir = path.join(storyDir, 'data')
  mkdirSync(dataDir, { recursive: true })
  const target = path.join(dataDir, STORY_DB_NAME)
  let bytes = 0
  const files: string[] = []
  for (const suffix of ['', '-wal', '-shm']) {
    const src = sourceDbPath + suffix
    if (!existsSync(src)) continue
    copyFileSync(src, target + suffix)
    bytes += statSync(target + suffix).size
    files.push(STORY_DB_NAME + suffix)
  }
  return { bytes, files }
}

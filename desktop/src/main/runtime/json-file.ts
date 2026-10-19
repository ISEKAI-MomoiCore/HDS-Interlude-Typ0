import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/** 原子替换小型运行时元数据，避免 Electron 崩溃时留下半份 JSON。 */
export function writeJsonAtomic(file: string, value: unknown) {
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  renameSync(temporary, file)
}

export function readJsonFile<T>(file: string, fallback: T): T {
  if (!existsSync(file)) return fallback
  try { return JSON.parse(readFileSync(file, 'utf8')) as T } catch { return fallback }
}

/** 审计：损坏的账本/登记文件不能静默回退——fallback 会在下一次原子写时把
 * 历史永久覆盖。解析失败先把坏文件改名隔离（保留人工恢复机会），再返回
 * fallback。隔离失败（如文件被锁）保留原文件，行为退回 readJsonFile。 */
export function readJsonFileOrQuarantine<T>(file: string, fallback: T): T {
  if (!existsSync(file)) return fallback
  try { return JSON.parse(readFileSync(file, 'utf8')) as T }
  catch (error) {
    try { renameSync(file, `${file}.corrupt-${Date.now()}`) } catch { /* 锁定中：不隔离，保留原文件 */ }
    // eslint-disable-next-line no-console -- 运行时元数据层可能早于 LogBroker 就绪
    console.error(`[json-file] 解析失败，已尝试隔离损坏文件 ${path.basename(file)}：${error}`)
    return fallback
  }
}

export function assertChildPath(root: string, child: string) {
  const resolvedRoot = path.resolve(root)
  const resolvedChild = path.resolve(child)
  if (resolvedChild !== resolvedRoot && !resolvedChild.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error('运行时文件路径越出了允许的目录。')
  }
  return resolvedChild
}

/**
 * D2-1 孤儿 worker 治理：PID 登记簿 + 主进程启动扫描。
 *
 * Electron fork 出的 Koishi worker 不会随主进程退出（验收实测：主进程被杀后
 * worker 存活，新主进程对它一无所知，同一 SQLite 面临双写、6709 内桥出现无主
 * 连接）。每次 fork 把 {pid, launcherPid} 写入剧本的 .typ-0-runtime/worker.json；
 * 主进程启动时扫描全部记录，按归属处置：
 *
 *  - pid 已死             → 陈旧记录，删除；
 *  - pid 活 & launcher 死 → 孤儿，校验进程名后终止并删除（安全前提：worker 的
 *                           状态可由 story phase + inbox 恢复，收编在 Electron
 *                           中无法实现——IPC 通道不能复活）；
 *  - pid 活 & launcher 活 → 属于另一个存活的主进程实例（单数据目录双开），
 *                           不动它——这是 D3 单宿主保护的第一块基石。
 *
 * 进程名校验防 PID 复用误杀：只有 electron/node 名下的 pid 才会被告终，其余
 * 仅告警。所有进程操作依赖注入，纯逻辑可在单测中覆盖完整决策矩阵。
 */
import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export interface WorkerRegistryRecord {
  pid: number
  storyId: string
  launcherPid: number
  startedAtIso: string
}

export interface SweepVerdict {
  storyId: string
  pid: number
  action: 'orphan-killed' | 'orphan-left-foreign' | 'stale-removed' | 'foreign-launcher-kept' | 'own-record-kept' | 'record-write-error'
  detail?: string
}

export interface ProcessProbe {
  isAlive(pid: number): boolean
  processName(pid: number): string | undefined
  kill(pid: number): boolean
}

/** Node 默认探针：signal 0 探活；进程名经 tasklist（Windows）或 ps（其余平台）。 */
export const nodeProcessProbe: ProcessProbe = {
  isAlive(pid: number) {
    if (!Number.isInteger(pid) || pid <= 0) return false
    try { process.kill(pid, 0); return true } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'EPERM'
    }
  },
  processName(pid: number) {
    try {
      // 同步读子进程输出在主进程里可接受（启动期一次性、每故事一条）。
      const cmd = process.platform === 'win32'
        ? `tasklist /FI "PID eq ${pid}" /FO CSV /NH`
        : `ps -o comm= -p ${pid}`
      const out = execSync(cmd, { timeout: 3_000, stdio: ['ignore', 'pipe', 'ignore'] }).toString('utf8')
      const firstCell = out.split(',')[0] ?? out.trim()
      return firstCell.replace(/"/g, '').trim() || undefined
    } catch { return undefined }
  },
  kill(pid: number) {
    try { process.kill(pid, 'SIGKILL'); return true } catch { return false }
  },
}

const WORKER_PROCESS_HINTS = ['electron', 'node', 'typ-0', 'hdsi']

function looksLikeWorkerProcess(name: string | undefined) {
  if (!name) return false
  const lower = name.toLowerCase()
  return WORKER_PROCESS_HINTS.some(hint => lower.includes(hint))
}

export class WorkerRegistry {
  constructor(
    private readonly storiesRoot: string,
    private readonly probe: ProcessProbe = nodeProcessProbe,
    private readonly selfPid: number = process.pid,
  ) {}

  private fileFor(storyId: string) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(storyId)) throw new Error('非法剧本 ID。')
    return path.join(this.storiesRoot, storyId, '.typ-0-runtime', 'worker.json')
  }

  /** fork 成功后登记；写失败不阻塞加载（登记簿是安全网而非前置条件）。 */
  record(storyId: string, pid: number, launcherPid: number = this.selfPid): WorkerRegistryRecord | undefined {
    const record: WorkerRegistryRecord = { pid, storyId, launcherPid, startedAtIso: new Date().toISOString() }
    try {
      const file = this.fileFor(storyId)
      mkdirSync(path.dirname(file), { recursive: true })
      writeFileSync(file, JSON.stringify(record), 'utf8')
      return record
    } catch { return undefined }
  }

  /** worker 正常退出时由 exit handler 调用；文件不存在是常态。 */
  clear(storyId: string) {
    try { rmSync(this.fileFor(storyId), { force: true }) } catch { /* 尽力而为 */ }
  }

  /** 就绪检查用：该剧本当前登记 worker 的启动时间（毫秒 epoch）；无有效登记
   *  返回 undefined。读单文件、不抛——登记簿是安全网，缺档按"未知"处理。 */
  startedAt(storyId: string): number | undefined {
    try {
      const file = this.fileFor(storyId)
      if (!existsSync(file)) return undefined
      const record = JSON.parse(readFileSync(file, 'utf8')) as WorkerRegistryRecord
      if (!Number.isInteger(record?.pid) || record.pid <= 0) return undefined
      const at = Date.parse(record.startedAtIso ?? '')
      return Number.isNaN(at) ? undefined : at
    } catch { return undefined }
  }

  private readRecords(): Array<{ record: WorkerRegistryRecord, file: string }> {
    const out: Array<{ record: WorkerRegistryRecord, file: string }> = []
    let storyDirs: string[] = []
    try { storyDirs = readdirSync(this.storiesRoot) } catch { return out }
    for (const storyId of storyDirs) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(storyId)) continue
      const file = path.join(this.storiesRoot, storyId, '.typ-0-runtime', 'worker.json')
      if (!existsSync(file)) continue
      try {
        const record = JSON.parse(readFileSync(file, 'utf8')) as WorkerRegistryRecord
        if (Number.isInteger(record?.pid) && record.pid > 0 && typeof record.storyId === 'string') {
          out.push({ record: { ...record, storyId }, file })
        }
      } catch { /* 损坏记录按陈旧处理：直接删除 */ out.push({ record: { pid: 0, storyId, launcherPid: 0, startedAtIso: '' }, file }) }
    }
    return out
  }

  /**
   * 主进程启动期执行一次。返回处置清单供日志/广播；绝不抛出——扫描失败
   * 不能阻止应用启动，最坏情况回到修复前的孤儿现状。
   */
  sweep(): SweepVerdict[] {
    const verdicts: SweepVerdict[] = []
    for (const { record, file } of this.readRecords()) {
      const base = { storyId: record.storyId, pid: record.pid }
      try {
        if (!this.probe.isAlive(record.pid)) {
          // 审计 L14：快照与 rmSync 之间用户可能已 load 同 ID 剧本（新 pid 写
          // 同一文件）——删除前重读核对 pid，不一致说明登记已被新 worker 取代。
          try {
            const fresh = JSON.parse(readFileSync(file, 'utf8')) as { pid?: number }
            if (Number.isInteger(fresh?.pid) && fresh.pid !== record.pid) {
              verdicts.push({ ...base, action: 'own-record-kept', detail: `登记已被新 pid=${fresh.pid} 取代，跳过清理` })
              continue
            }
          } catch { /* 读失败按快照处置 */ }
          try { rmSync(file, { force: true }) } catch { /* 已被清走 */ }
          verdicts.push({ ...base, action: 'stale-removed' })
          continue
        }
        if (record.launcherPid === this.selfPid) {
          verdicts.push({ ...base, action: 'own-record-kept' })
          continue
        }
        if (this.probe.isAlive(record.launcherPid)) {
          verdicts.push({ ...base, action: 'foreign-launcher-kept', detail: `launcher ${record.launcherPid} 仍在运行` })
          continue
        }
        // launcher 已死而 worker 活着：孤儿。进程名校验通过才终止。
        const name = this.probe.processName(record.pid)
        if (looksLikeWorkerProcess(name)) {
          const killed = this.probe.kill(record.pid)
          try { rmSync(file, { force: true }) } catch { /* 尽力而为 */ }
          verdicts.push({ ...base, action: killed ? 'orphan-killed' : 'orphan-left-foreign', detail: `process=${name}` })
        } else {
          verdicts.push({ ...base, action: 'orphan-left-foreign', detail: `进程名 ${name ?? '未知'} 不像 typ-0 worker，已跳过` })
        }
      } catch (error) {
        verdicts.push({ ...base, action: 'record-write-error', detail: String(error) })
      }
    }
    return verdicts
  }
}

/** auto-resume 的选择逻辑：仅恢复 phase=running 的故事（paused/muted 不启 worker）。 */
export function selectResumableStories(list: Array<{ meta: { id: string, phase: string } }>): string[] {
  return list.filter(item => item.meta.phase === 'running').map(item => item.meta.id)
}

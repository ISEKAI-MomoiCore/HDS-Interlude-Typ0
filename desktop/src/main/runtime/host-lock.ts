/**
 * D3 单宿主实例保护：同一数据目录只允许一个 typ-0 主进程写入。
 *
 * 主进程 ready 时在 dataRoot 放 .typ-0-host.lock（pid + bootId + startedAt）。
 * 已存在且其中的 pid 仍活着（且不是自己）→ 判定第二实例，调用方应拒绝启动。
 * 崩溃残留由 pid 探活兜底（死 pid 的锁会被接管）；正常退出由调用方释放。
 * 探针可注入，与 worker-registry 共用同一套测试策略。
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type { ProcessProbe } from './worker-registry'

export interface HostLockFile { pid: number, bootId: string, startedAtIso: string }

export type HostLockOutcome =
  | { acquired: true, file: string, bootId: string }
  | { acquired: false, file: string, holder: HostLockFile, reason: string }

export class HostLock {
  readonly bootId = randomUUID()
  private file: string | null = null

  constructor(
    private readonly dataRoot: string,
    private readonly probe: Pick<ProcessProbe, 'isAlive'> = { isAlive: (pid: number) => { try { process.kill(pid, 0); return true } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM' } } },
    private readonly selfPid: number = process.pid,
  ) {}

  /** 尝试取得数据目录锁。成功后持有至 release；第二实例得到 acquired:false。 */
  acquire(): HostLockOutcome {
    const file = path.join(this.dataRoot, '.typ-0-host.lock')
    if (existsSync(file)) {
      try {
        const holder = JSON.parse(readFileSync(file, 'utf8')) as HostLockFile
        if (Number.isInteger(holder?.pid) && holder.pid > 0 && holder.pid !== this.selfPid && this.probe.isAlive(holder.pid)) {
          return { acquired: false, file, holder, reason: `另一个 typ-0 主进程（pid ${holder.pid}，bootId ${String(holder.bootId).slice(0, 8)}）正在使用此数据目录。` }
        }
      } catch { /* 损坏的锁文件按残留处理，直接接管 */ }
    }
    const content: HostLockFile = { pid: this.selfPid, bootId: this.bootId, startedAtIso: new Date().toISOString() }
    writeFileSync(file, JSON.stringify(content), 'utf8')
    this.file = file
    return { acquired: true, file, bootId: this.bootId }
  }

  /** 正常退出时释放；未持有或已被清理都是常态。 */
  release() {
    if (!this.file) return
    try { rmSync(this.file, { force: true }) } catch { /* 尽力而为 */ }
    this.file = null
  }
}

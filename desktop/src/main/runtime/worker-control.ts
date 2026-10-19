import { DesktopInboundEvent, StoryPhase, WorkerIngress } from './contracts'

/** StoryManager 的窄适配层，避免 MessageRouter 知道 child_process 或 Koishi worker 细节。 */
export interface StoryWorkerHost {
  isBridgeReady(storyId: string): boolean
  deliverInbound(storyId: string, event: DesktopInboundEvent): Promise<void>
  setPhase(storyId: string, phase: StoryPhase): Promise<unknown>
  sendDesktopCommand(storyId: string, command: 'phase' | 'inbound' | 'replay-inbox' | 'snapshot' | 'delivery-result', value: unknown): Promise<void>
}

export class WorkerControl implements WorkerIngress {
  constructor(private readonly host: StoryWorkerHost) {}
  isBridgeReady(storyId: string) { return this.host.isBridgeReady(storyId) }
  async deliverInbound(storyId: string, event: DesktopInboundEvent) {
    if (!this.host.isBridgeReady(storyId)) throw new Error('目标 worker 尚未声明 typ-0 bridge 就绪。')
    await this.host.deliverInbound(storyId, event)
  }
  setPhase(storyId: string, phase: StoryPhase) { return this.host.setPhase(storyId, phase) }
}

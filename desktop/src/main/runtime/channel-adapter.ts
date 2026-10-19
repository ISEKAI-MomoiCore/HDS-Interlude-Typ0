import { DeliveryReceipt, DesktopDelivery, DesktopInboundEvent, DesktopTransport } from './contracts'

/** Minimal host-side transport boundary. Real SnowLuma/OneBot adapters plug in here later. */
export interface ChannelAdapter {
  transport: DesktopTransport
  send(delivery: DesktopDelivery): Promise<DeliveryReceipt>
  onInbound?(listener: (event: DesktopInboundEvent) => Promise<void>): () => void
  stop?(): Promise<void>
}

export class ChannelAdapterRegistry {
  private readonly adapters = new Map<DesktopTransport, ChannelAdapter>()
  private readonly resolvers = new Map<DesktopTransport, (delivery: DesktopDelivery) => ChannelAdapter | undefined>()

  register(adapter: ChannelAdapter) { this.adapters.set(adapter.transport, adapter) }
  setResolver(transport: DesktopTransport, resolver: ((delivery: DesktopDelivery) => ChannelAdapter | undefined) | undefined) {
    if (resolver) this.resolvers.set(transport, resolver)
    else this.resolvers.delete(transport)
  }
  get(transport: DesktopTransport, delivery?: DesktopDelivery) {
    return delivery ? this.resolvers.get(transport)?.(delivery) ?? this.adapters.get(transport) : this.adapters.get(transport)
  }
  async stopAll() { await Promise.allSettled([...this.adapters.values()].map(adapter => adapter.stop?.())) }
}

/** A deterministic local transport for bridge and outbox integration tests. */
export class SandboxChannelAdapter implements ChannelAdapter {
  readonly transport = 'sandbox' as const
  async send(delivery: DesktopDelivery): Promise<DeliveryReceipt> {
    return { status: 'sent', messageIds: [`sandbox:${delivery.deliveryId}`] }
  }
}

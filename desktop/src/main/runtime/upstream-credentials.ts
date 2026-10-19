import { detectSnowLuma, readLocalSnowLumaToken } from './snowluma-detection'
import type { AccountRegistry } from './account-registry'
import type { SecretStore } from './secrets'
export function sameUpstreamEndpoint(a: string, b: string): boolean {
  try { return new URL(a).href === new URL(b).href } catch { return false }
}
export async function resolveUpstreamToken(options: { endpoint: string; selfId: string; storyId: string; token?: string; useLocalToken?: boolean; reuseSavedToken?: boolean }, registry: AccountRegistry, secrets: SecretStore): Promise<string | undefined> {
  if (options.token?.trim()) return options.token.trim()
  if (options.useLocalToken) {
    const snow = await detectSnowLuma()
    const token = snow.path ? readLocalSnowLumaToken(snow.path, options.selfId, options.endpoint) : undefined
    if (token === undefined) throw new Error('本机 SnowLuma 配置中没有与此账号、端口和路径完全匹配的令牌；请核对或手动填写。')
    return token || undefined
  }
  if (options.reuseSavedToken !== false) {
    const entry = registry.findBySelfId(options.selfId)
    if (entry?.storyId === options.storyId && entry.externalUpstream?.tokenAlias && sameUpstreamEndpoint(options.endpoint, entry.externalUpstream.endpoint)) return secrets.get(entry.externalUpstream.tokenAlias)
  }
  return undefined
}

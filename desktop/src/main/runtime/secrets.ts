import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { readJsonFile, writeJsonAtomic } from './json-file'

interface SecretFile { version: 1, secrets: Record<string, string> }
export interface SecretProtector {
  available(): boolean
  encrypt(value: string): string
  decrypt(value: string): string
}

function assertAlias(alias: string) {
  if (!/^[a-z0-9][a-z0-9_.-]{0,127}$/i.test(alias)) throw new Error('密钥别名只能使用字母、数字、.、- 或 _。')
}

/**
 * 本机密钥别名库。文件只保存保护后的 payload；剧本目录永远只保存 $secret:alias。
 * 保护实现由 Electron safeStorage 注入，便于无 Electron 的单元测试替换。
 */
export class SecretStore {
  private readonly file: string
  /** 性能审计：tryGet 明文缓存（按别名），set/remove 失效。 */
  private readonly plaintextCache = new Map<string, string>()

  constructor(dataRoot: string, private readonly protector: SecretProtector) {
    mkdirSync(dataRoot, { recursive: true })
    this.file = path.join(dataRoot, 'secrets.json')
  }

  aliases() { return Object.keys(this.read().secrets).sort() }
  has(alias: string) { return Object.hasOwn(this.read().secrets, alias) }

  set(alias: string, value: string) {
    assertAlias(alias)
    if (!value) throw new Error(`密钥 ${alias} 不能为空。`)
    // P2 输入边界：API key/token 类凭据远小于此上限——超长值只可能是渲染层
    // bug 或异常粘贴，在加密落盘前拦截。
    if (value.length > 16 * 1024) throw new Error(`密钥 ${alias} 超过 16KB 上限，拒绝保存。`)
    if (!this.protector.available()) throw new Error('当前系统安全存储不可用，拒绝以明文保存密钥。')
    const state = this.read()
    state.secrets[alias] = this.protector.encrypt(value)
    this.write(state)
    this.plaintextCache.delete(alias)
  }

  get(alias: string) {
    assertAlias(alias)
    const result = this.tryGet(alias)
    if (result.ok) return result.value
    throw new Error(result.message)
  }

  /** 读取不抛异常：missing = 从未录入；undecryptable = 密文来自其他用户/机器（重录即愈）。
   * 加载链用它做优雅降级——单个坏密钥不得阻塞整个剧本加载。 */
  tryGet(alias: string): { ok: true, value: string } | { ok: false, reason: 'missing' | 'undecryptable' | 'unavailable', message: string } {
    assertAlias(alias)
    // 性能审计：readyCheck/剧本加载对每个引用别名调用一次 safeStorage 解密——
    // 明文按别名缓存，set/remove 时失效（单写者进程内一致）。
    const cached = this.plaintextCache.get(alias)
    if (cached) return { ok: true, value: cached }
    const encrypted = this.read().secrets[alias]
    if (!encrypted) return { ok: false, reason: 'missing', message: `未配置密钥别名：${alias}` }
    if (!this.protector.available()) return { ok: false, reason: 'unavailable', message: '当前系统安全存储不可用，无法读取密钥。' }
    try {
      const value = this.protector.decrypt(encrypted)
      this.plaintextCache.set(alias, value)
      return { ok: true, value }
    } catch {
      return { ok: false, reason: 'undecryptable', message: `密钥 ${alias} 无法解密（密文可能来自其他用户或机器的加密数据）——请在配置中重新录入该密钥。` }
    }
  }

  remove(alias: string) {
    const state = this.read()
    if (!Object.hasOwn(state.secrets, alias)) return false
    delete state.secrets[alias]
    this.write(state)
    this.plaintextCache.delete(alias)
    return true
  }

  private read(): SecretFile {
    const state = readJsonFile<SecretFile>(this.file, { version: 1, secrets: {} })
    return state.version === 1 && state.secrets && typeof state.secrets === 'object'
      ? state : { version: 1, secrets: {} }
  }

  private write(state: SecretFile) { writeJsonAtomic(this.file, state) }
}

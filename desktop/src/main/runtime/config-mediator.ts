import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { assertChildPath } from './json-file'
import { SecretStore } from './secrets'

export interface ConfigInspection {
  aliases: string[]
  warnings: string[]
}

const SECRET_REFERENCE = /\$secret:([A-Za-z0-9][A-Za-z0-9_.-]{0,127})/g
// 审计：原精确键名单漏掉 access_token/secretKey/bot_token/apiKey 等常见变体，
// 明文凭据会绕过 canonical 唯一的防线。仍保持"精确键"语义（扩展变体表）而非
// 子串包含——maxTokens/tokenAlias 这类合法键不能被误伤（tokenAlias 的值是
// 别名本身，不是 $secret: 引用）。
const SENSITIVE_SETTING = /^[ \t]*(?:-[ \t]+)?(?:api[-_]?key|access[-_]?token|refresh[-_]?token|auth[-_]?token|bot[-_]?token|client[-_]?secret|secret[-_]?key|authorization|password|passwd|token|secret)[ \t]*:[ \t]*([^#\r\n]*)/gim

/**
 * The only canonical-config write boundary used by typ-0's own UI.  It keeps
 * YAML textual (so Koishi remains the schema authority), rejects accidental
 * plaintext credentials, validates secret aliases, and leaves a bounded local
 * rollback copy before every save.
 */
export class StoryConfigMediator {
  constructor(private readonly secrets: SecretStore) {}

  read(storyDir: string) {
    const file = this.configPath(storyDir)
    if (!existsSync(file)) throw new Error('剧本缺少 koishi.yml。')
    return readFileSync(file, 'utf8')
  }

  inspect(source: string): ConfigInspection {
    this.assertSource(source)
    const aliases = [...new Set([...source.matchAll(SECRET_REFERENCE)].map(match => match[1]))].sort()
    const missing = aliases.filter(alias => !this.secrets.has(alias))
    if (missing.length) throw new Error(`以下密钥别名尚未保存到本机安全存储：${missing.join('、')}。`)
    const warnings: string[] = []
    if (!aliases.length) warnings.push('此配置没有引用任何 $secret: 别名。')
    return { aliases, warnings }
  }

  save(storyDir: string, source: string) {
    const inspection = this.inspect(source)
    const file = this.configPath(storyDir)
    const previous = this.read(storyDir)
    const backupDir = path.join(storyDir, '.typ-0-backups', 'config')
    mkdirSync(backupDir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const backup = path.join(backupDir, `koishi.${stamp}.yml`)
    writeFileSync(backup, previous, { encoding: 'utf8', mode: 0o600 })
    this.trimBackups(backupDir)
    const temporary = `${file}.${process.pid}.${Date.now()}.tmp`
    writeFileSync(temporary, source, { encoding: 'utf8', mode: 0o600 })
    renameSync(temporary, file)
    return { ...inspection, backup }
  }

  /** Used only for transactional rollback after a Worker reload rejects a saved file. */
  restore(storyDir: string, source: string) {
    const file = this.configPath(storyDir)
    const temporary = `${file}.${process.pid}.${Date.now()}.rollback.tmp`
    writeFileSync(temporary, source, { encoding: 'utf8', mode: 0o600 })
    renameSync(temporary, file)
  }

  private configPath(storyDir: string) { return assertChildPath(storyDir, path.join(storyDir, 'koishi.yml')) }

  private assertSource(source: string) {
    if (typeof source !== 'string' || !source.trim()) throw new Error('配置内容不能为空。')
    if (source.length > 1_000_000) throw new Error('配置文件超过 1 MB，拒绝写入。')
    if (/\0/.test(source)) throw new Error('配置中包含非法 NUL 字符。')
    // 审计 L10：块标量（mainPrompt: | 之类）正文里粘贴的「token: xxx」是普通
    // 文案不是配置键——逐行扫描并跳过块标量区域，否则一次误报会把用户的所有
    // 保存（YAML/结构化/mixer）完全堵死。SENSITIVE_LINE 为非全局实例，避开
    // SENSITIVE_SETTING 的 lastIndex 共享状态。
    const SENSITIVE_LINE = /^[ \t]*(?:-[ \t]+)?(?:api[-_]?key|access[-_]?token|refresh[-_]?token|auth[-_]?token|bot[-_]?token|client[-_]?secret|secret[-_]?key|authorization|password|passwd|token|secret)[ \t]*:[ \t]*([^#\r\n]*)/i
    let inBlock = false
    let blockIndent = 0
    for (const line of source.split(/\r?\n/)) {
      if (line.trim()) {
        const indent = /^[ \t]*/.exec(line)![0].length
        if (inBlock && indent > blockIndent) continue
        inBlock = false
        const sensitive = SENSITIVE_LINE.exec(line)
        if (sensitive) {
          const value = sensitive[1].trim()
          const allowedEmpty = value === '' || value === "''" || value === '""' || value === 'null' || value === '~'
          if (!allowedEmpty && !/^\$secret:[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value)) {
            throw new Error('敏感配置值必须使用 $secret:别名，不能把明文密钥写入 koishi.yml。')
          }
        }
        if (/:[ \t]*(?:[|>][+-]?[0-9]*)(?:[ \t]+#.*)?$/.test(line)) {
          inBlock = true
          blockIndent = indent
        }
      }
    }
  }

  private trimBackups(backupDir: string) {
    const files = readdirSync(backupDir).filter(name => /^koishi\..+\.yml$/.test(name)).sort()
    for (const stale of files.slice(0, Math.max(0, files.length - 20))) {
      try { rmSync(path.join(backupDir, stale), { force: true }) } catch { /* backup trimming is best-effort */ }
    }
  }
}

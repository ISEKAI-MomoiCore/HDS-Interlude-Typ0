import { dialog, BrowserWindow } from 'electron'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { Unzip, zipSync } from 'fflate'

export type ThemePackEntries = Record<string, string>

const MAX_PACK_BYTES = 5 * 1024 * 1024
const MAX_ENTRY_BYTES = 2 * 1024 * 1024
/** 审计：条目数是 zip 炸弹的放大器——流式解压途中即拒绝。 */
const MAX_ENTRY_COUNT = 256
const TEXT_EXTENSIONS = /\.(json|md|txt|svg|css|yaml|yml)$/i
const BINARY_EXTENSIONS = /\.(png|webp|avif|jpg|jpeg|gif|woff2|woff|ico)$/i

function safeEntryName(input: string): string {
  const name = String(input || '').replaceAll('\\', '/')
  if (!name || name.startsWith('/') || /^[A-Za-z]:\//.test(name) || name.includes('\0')) throw new Error(`主题包条目路径非法：${input}`)
  const segments = name.split('/')
  if (segments.some(segment => segment === '.' || segment === '..' || !segment)) throw new Error(`主题包条目路径非法：${input}`)
  const normalized = path.posix.normalize(name)
  if (normalized === '.' || normalized.startsWith('../') || normalized.includes('/../') || normalized.endsWith('/')) throw new Error(`主题包条目路径非法：${input}`)
  if (!/^[A-Za-z0-9._/-]+$/.test(normalized)) throw new Error(`主题包条目名称含不支持字符：${input}`)
  return normalized
}

function safePackId(input: string): string {
  const id = String(input || '')
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(id)) throw new Error('主题包 ID 非法。')
  return id
}

function isBinary(name: string): boolean {
  return BINARY_EXTENSIONS.test(name) && !TEXT_EXTENSIONS.test(name)
}

function encodeEntry(name: string, bytes: Uint8Array): string {
  return isBinary(name) ? `b64:${Buffer.from(bytes).toString('base64')}` : Buffer.from(bytes).toString('utf8')
}

function decodeEntry(name: string, value: string): Uint8Array {
  if (typeof value !== 'string') throw new Error(`主题包条目必须是字符串：${name}`)
  if (value.startsWith('b64:')) {
    const raw = value.slice(4)
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(raw) || raw.length % 4 === 1) throw new Error(`主题包二进制条目不是合法 base64：${name}`)
    return new Uint8Array(Buffer.from(raw, 'base64'))
  }
  return new Uint8Array(Buffer.from(value, 'utf8'))
}

function entriesFromZip(buffer: Buffer): ThemePackEntries {
  if (buffer.length > MAX_PACK_BYTES) throw new Error('主题包超过 5MB 限制。')
  // 审计：unzipSync 会先把全部条目完整解压进内存，条目/大小上限全部迟到——
  // 一个 ≤5MB 的恶意 zip 可膨胀出 GB 级内存。改用 fflate 流式 Unzip：条目数、
  // 单条目大小、解压总量都在解压进行中检查，超限立即抛出（同步传播出 push）。
  const entries: ThemePackEntries = {}
  let total = 0
  let entryCount = 0
  const unzip = new Unzip()
  unzip.onfile = file => {
    if (file.name.endsWith('/')) return // 目录占位条目
    const name = safeEntryName(file.name)
    entryCount += 1
    if (entryCount > MAX_ENTRY_COUNT) throw new Error(`主题包条目数超过 ${MAX_ENTRY_COUNT}。`)
    const chunks: Uint8Array[] = []
    let entrySize = 0
    file.ondata = (data, final) => {
      // fflate 出错时以 FlateError 代替数据帧——统一转成异常抛出。
      if (!(data instanceof Uint8Array)) throw new Error(`主题包条目解压失败：${name}`)
      entrySize += data.length
      total += data.length
      if (entrySize > MAX_ENTRY_BYTES) throw new Error(`主题包条目超过 2MB：${name}`)
      if (total > MAX_PACK_BYTES) throw new Error('主题包解压后超过 5MB 限制。')
      chunks.push(data)
      if (final) {
        const bytes = new Uint8Array(entrySize)
        let offset = 0
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
        if (entrySize) entries[name] = encodeEntry(name, bytes)
      }
    }
    file.start()
  }
  unzip.push(new Uint8Array(buffer), true)
  if (!entries['theme.json']) throw new Error('主题包缺少 theme.json。')
  return entries
}

function entriesFromDirectory(dir: string): ThemePackEntries {
  const entries: ThemePackEntries = {}
  let total = 0
  const walk = (current: string, prefix: string) => {
    for (const item of readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, item.name)
      const name = safeEntryName(prefix ? `${prefix}/${item.name}` : item.name)
      if (item.isDirectory()) walk(absolute, name)
      else if (item.isFile()) {
        const bytes = readFileSync(absolute)
        if (bytes.length > MAX_ENTRY_BYTES) throw new Error(`主题包条目超过 2MB：${name}`)
        total += bytes.length
        if (total > MAX_PACK_BYTES) throw new Error('主题包解压后超过 5MB 限制。')
        entries[name] = encodeEntry(name, bytes)
      }
    }
  }
  walk(dir, '')
  return entries
}

export class ThemePackStore {
  readonly root: string

  constructor(private readonly dataRoot: string, private readonly getWindow: () => BrowserWindow | null) {
    this.root = path.join(dataRoot, 'theme-packs')
    mkdirSync(this.root, { recursive: true })
  }

  async pickRead(): Promise<{ path: string, entries: ThemePackEntries } | null> {
    const options = {
      title: '导入 HDSI 主题包',
      properties: ['openFile'] as Array<'openFile'>,
      filters: [{ name: 'HDSI Theme Pack', extensions: ['hdsitheme', 'zip'] }],
    }
    const owner = this.getWindow()
    const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options)
    if (result.canceled || !result.filePaths[0]) return null
    const selected = result.filePaths[0]
    return { path: selected, entries: entriesFromZip(readFileSync(selected)) }
  }

  listInstalled(): Array<{ id: string, entries: ThemePackEntries, error?: string }> {
    if (!existsSync(this.root)) return []
    return readdirSync(this.root, { withFileTypes: true })
      .filter(item => item.isDirectory() && /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(item.name))
      .map(item => {
        try {
          return { id: item.name, entries: entriesFromDirectory(path.join(this.root, item.name)) }
        } catch (error) {
          return { id: item.name, entries: {}, error: error instanceof Error ? error.message : String(error) }
        }
      })
  }

  install(idInput: string, entries: ThemePackEntries): { ok: true, id: string } | { ok: false, error: string } {
    try {
      const id = safePackId(idInput)
      const normalized: ThemePackEntries = {}
      let total = 0
      for (const [rawName, value] of Object.entries(entries || {})) {
        const name = safeEntryName(rawName)
        const bytes = decodeEntry(name, value)
        if (bytes.length > MAX_ENTRY_BYTES) throw new Error(`主题包条目超过 2MB：${name}`)
        total += bytes.length
        if (total > MAX_PACK_BYTES) throw new Error('主题包超过 5MB 限制。')
        normalized[name] = value
      }
      if (!normalized['theme.json']) throw new Error('主题包缺少 theme.json。')

      const temp = mkdtempSync(path.join(this.root, `.install-${id}-`))
      try {
        for (const [name, value] of Object.entries(normalized)) {
          const target = path.join(temp, name)
          mkdirSync(path.dirname(target), { recursive: true })
          writeFileSync(target, decodeEntry(name, value), { mode: 0o600 })
        }
        const target = path.join(this.root, id)
        const backup = path.join(this.root, `.previous-${id}-${Date.now()}`)
        const hadTarget = existsSync(target)
        if (hadTarget) renameSync(target, backup)
        try {
          renameSync(temp, target)
          if (hadTarget) rmSync(backup, { recursive: true, force: true })
        } catch (error) {
          if (existsSync(target)) rmSync(target, { recursive: true, force: true })
          if (hadTarget && existsSync(backup)) renameSync(backup, target)
          throw error
        }
      } finally {
        if (existsSync(temp)) rmSync(temp, { recursive: true, force: true })
      }
      return { ok: true, id }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  async write(nameInput: string, entries: ThemePackEntries): Promise<{ ok: true, path: string } | { ok: false, error: string }> {
    try {
      const name = path.basename(String(nameInput || 'theme.hdsitheme')).replace(/[^A-Za-z0-9._-]/g, '_') || 'theme.hdsitheme'
      const options = {
        title: '导出 HDSI 主题包',
        defaultPath: name.endsWith('.hdsitheme') ? name : `${name}.hdsitheme`,
        filters: [{ name: 'HDSI Theme Pack', extensions: ['hdsitheme'] }],
      }
      const owner = this.getWindow()
      const result = owner ? await dialog.showSaveDialog(owner, options) : await dialog.showSaveDialog(options)
      if (result.canceled || !result.filePath) return { ok: false, error: 'cancelled' }
      const normalized: Record<string, Uint8Array> = {}
      let total = 0
      for (const [rawName, value] of Object.entries(entries || {})) {
        const entry = safeEntryName(rawName)
        const bytes = decodeEntry(entry, value)
        total += bytes.length
        if (bytes.length > MAX_ENTRY_BYTES || total > MAX_PACK_BYTES) throw new Error('主题包超过大小限制。')
        normalized[entry] = bytes
      }
      const zipped = zipSync(normalized, { level: 6 })
      if (zipped.length > MAX_PACK_BYTES) throw new Error('压缩后的主题包超过 5MB 限制。')
      writeFileSync(result.filePath, Buffer.from(zipped), { mode: 0o600 })
      return { ok: true, path: result.filePath }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }

  uninstall(idInput: string): { ok: true } | { ok: false, error: string } {
    try {
      const id = safePackId(idInput)
      const target = path.join(this.root, id)
      if (existsSync(target)) rmSync(target, { recursive: true, force: true })
      return { ok: true }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  }
}



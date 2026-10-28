import yaml from 'js-yaml'
import { appendPlugin, locatePluginKey } from './plugin-panel'

/**
 * 审计 M4：结构化保存的纯文本手术——mixer 旋钮与配置节写入此前是
 * `yaml.load → 改对象 → yaml.dump 整档`，js-yaml dump 不保留注释/锚点，
 * 模板头说明与用户手写注释在第一次结构化保存时全部无声丢失（plugin-panel
 * 的整块替换手术是既有标准，本模块把它细化到"键行级"：只重写受影响的键行，
 * 其余文本逐字保留）。块级手术（整段替换）仍归 plugin-panel.writePluginConfig。
 */

export interface ConfigKeyOp {
  /** 相对插件键的嵌套路径，如 ['urge','threshold']。 */
  path: string[]
  /** 新值；remove=true 时忽略。 */
  value?: unknown
  /** 删除该键（叶子删除；所在节因此变空时节行一并删除）。 */
  remove?: boolean
}

function indentWidth(line: string) {
  const match = /^[ \t]*/.exec(line)
  return match ? match[0].length : 0
}

/** 序列化叶子值。字符串用 JSON 双引号（YAML 1.2 合法且转义安全）；复合值
 *  整体 yaml.dump 后按子缩进重排（此类行本身的行内注释无法保留，可接受）。 */
function serializeValue(value: unknown, childIndent: number): string {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (typeof value === 'string') return JSON.stringify(value)
  const dumped = yaml.dump({ v: value }, { indent: 2, lineWidth: 160, noRefs: true })
  const lines = dumped.replace(/\n$/, '').split('\n')
  // 首行 "v: ..." → 取值部分；后续行整体补 childIndent
  const first = lines[0].slice(lines[0].indexOf(':') + 2)
  if (lines.length === 1) return first
  const rest = lines.slice(1).map(line => line.trim() ? ' '.repeat(childIndent) + line : line)
  return [first, ...rest].join('\n')
}

/** 在 [start,end) 行范围内找直接子键行（缩进恰为 indent、键名匹配）。 */
function findChildKeyLine(lines: string[], start: number, end: number, indent: number, key: string): number {
  for (let i = start; i < end; i++) {
    const line = lines[i]
    if (!line.trim()) continue
    const at = indentWidth(line)
    if (at < indent) break
    if (at > indent) continue
    const match = new RegExp(`^${' '.repeat(indent)}${key}:`).exec(line)
    if (match) return i
  }
  return -1
}

/** 键行的块体范围：返回 [bodyStart, bodyEnd) 行号区间，空体时两者相等。 */
function blockRange(lines: string[], keyLine: number, keyIndent: number): [number, number] {
  let end = keyLine + 1
  for (let i = keyLine + 1; i < lines.length; i++) {
    if (!lines[i].trim()) { end = i + 1; continue }
    if (indentWidth(lines[i]) > keyIndent) { end = i + 1; continue }
    break
  }
  return [keyLine + 1, end]
}

/** 计算插件子树的前后差异 → 叶子级 ops。数组按整体值比较（整行替换）。 */
export function diffConfigOps(before: unknown, after: unknown, prefix: string[] = []): ConfigKeyOp[] {
  const ops: ConfigKeyOp[] = []
  const beforeRecord = (before && typeof before === 'object' && !Array.isArray(before)) ? before as Record<string, unknown> : null
  const afterRecord = (after && typeof after === 'object' && !Array.isArray(after)) ? after as Record<string, unknown> : null
  if (!beforeRecord || !afterRecord) {
    if (JSON.stringify(before) !== JSON.stringify(after)) ops.push({ path: prefix, value: after })
    return ops
  }
  const keys = [...new Set([...Object.keys(beforeRecord), ...Object.keys(afterRecord)])]
  for (const key of keys) {
    const inBefore = Object.hasOwn(beforeRecord, key)
    const inAfter = Object.hasOwn(afterRecord, key)
    const path = [...prefix, key]
    if (!inAfter) { ops.push({ path, remove: true }); continue }
    if (!inBefore) { ops.push({ path, value: afterRecord[key] }); continue }
    ops.push(...diffConfigOps(beforeRecord[key], afterRecord[key], path))
  }
  return ops
}

/** 对 YAML 文本中指定插件块执行键行级手术。块不存在时先追加空块。 */
export function patchPluginKeys(source: string, rawKey: string, ops: ConfigKeyOp[], group?: string | null): string {
  let text = source
  if (!locatePluginKey(text, rawKey, group)) {
    const packageName = rawKey.includes(':') ? rawKey.slice(0, rawKey.indexOf(':')) : rawKey
    const suffix = rawKey.includes(':') ? rawKey.slice(rawKey.indexOf(':') + 1) : ''
    text = appendPlugin(text, packageName, suffix)
  }
  const target = locatePluginKey(text, rawKey, group)
  if (!target) throw new Error(`未找到插件键：${rawKey}`)
  const lines = text.split(/\r?\n/)
  const STEP = 2

  const applyOps = (opsList: ConfigKeyOp[]) => {
    for (const op of opsList) {
      if (!op.path.length) continue
      let parentLine = target!.line
      let indent = target!.indent
      // 逐级导航/创建中间节
      for (let depth = 0; depth < op.path.length - 1; depth++) {
        const [, parentEnd] = blockRange(lines, parentLine, indent)
        let child = findChildKeyLine(lines, parentLine + 1, parentEnd, indent + STEP, op.path[depth])
        if (child < 0) {
          // 节不存在：插到父体末尾（保持同层顺序追加）
          const insertAt = parentEnd
          lines.splice(insertAt, 0, `${' '.repeat(indent + STEP)}${op.path[depth]}:`)
          child = insertAt
        }
        parentLine = child
        indent += STEP
      }
      const leaf = op.path[op.path.length - 1]
      const [, parentEnd] = blockRange(lines, parentLine, indent)
      const childIndent = indent + STEP
      const existing = findChildKeyLine(lines, parentLine + 1, parentEnd, childIndent, leaf)
      if (op.remove) {
        if (existing >= 0) {
          // 叶子可能是多行值（复合）：删除整块
          const [leafStart, leafEnd] = blockRange(lines, existing, childIndent)
          lines.splice(existing, Math.max(1, leafEnd - existing))
          // 节因此变空 → 节行一并删除（YAML 空节是 null，会覆盖插件默认值）
          const [sectionStart, sectionEnd] = blockRange(lines, parentLine, indent)
          const hasChildren = lines.slice(sectionStart, sectionEnd).some(line => line.trim())
          if (!hasChildren && parentLine !== target!.line) lines.splice(parentLine, 1)
        }
        continue
      }
      const serialized = `${' '.repeat(childIndent)}${leaf}: ${serializeValue(op.value, childIndent)}`
      if (existing >= 0) {
        // 保留被替换行的行尾注释（用户写在键行上的说明）
        const comment = /\s+(#.*)$/.exec(lines[existing])
        lines[existing] = comment ? serialized + comment[0] : serialized
        // 旧值是多行块 → 删除其残留体
        const [, leafEnd] = blockRange(lines, existing, childIndent)
        if (leafEnd > existing + 1) lines.splice(existing + 1, leafEnd - existing - 1)
      } else {
        lines.splice(parentEnd, 0, serialized)
      }
    }
  }
  applyOps(ops)
  return lines.join('\n')
}

/** 便利封装：diff before/after → 键行手术（mixer/configSection 的主路径）。 */
export function surgicalPluginUpdate(source: string, rawKey: string, before: unknown, after: unknown, group?: string | null): string {
  return patchPluginKeys(source, rawKey, diffConfigOps(before, after), group)
}

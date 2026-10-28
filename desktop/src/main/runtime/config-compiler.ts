import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { SecretStore } from './secrets'

export interface CompiledStoryConfig {
  file: string
  aliases: string[]
  /** true 表示注入了 M6 loopback console/server 条目（canonical yml 本身没有时）。 */
  consoleInjected: boolean
  /** true 表示本轮注入了 OneBot 账号运行参数（selfId/端点）。 */
  onebotInjected: boolean
  cleanup(): void
}

/**
 * 编译 koishi.yml 中独占一整个 YAML 标量的 $secret:alias。
 * 不重排 YAML、不解析插件 schema，避免宿主在配置层复制 Koishi loader 的工作。
 */
export class StoryConfigCompiler {
  constructor(private readonly secrets: SecretStore) {}

  /**
   * M7-2：宿主运行参数（OneBot selfId/端点）只在 resolved 临时配置里注入——
   * canonical koishi.yml 保持用户可手编、可备份、可迁移；分支复制不带宿主状态。
   * options.onebot.selfId 为空时不注入（adapter 以空 selfId 加载，连接被桌面门控拒绝）。
   */
  compile(storyDir: string, options: { onebot?: { selfId?: string, endpoint?: string } } = {}): CompiledStoryConfig {
    const sourceFile = path.join(storyDir, 'koishi.yml')
    if (!existsSync(sourceFile)) throw new Error(`剧本缺少 koishi.yml：${storyDir}`)
    const source = readFileSync(sourceFile, 'utf8')
    const aliases = new Set<string>()
    const scalar = /^(\s*(?:-\s+)?[A-Za-z0-9_.-]+\s*:\s*)\$secret:([A-Za-z0-9][A-Za-z0-9_.-]{0,127})(\s*(?:#.*)?)$/gm
    const compiled = source.replace(scalar, (_all, prefix: string, alias: string, suffix: string) => {
      aliases.add(alias)
      // 优雅降级：密文不可解（跨用户/机器复制）时注入空值而非让整个剧本无法加载；
      // 就绪检查会把这些别名标红，用户重录后自动恢复。
      const secret = this.secrets.tryGet(alias)
      if (!secret.ok && secret.reason !== 'undecryptable') throw new Error(secret.message)
      const value = secret.ok ? secret.value : ''
      // JSON string 是 YAML 1.2 的合法双引号标量，同时会安全转义 key 中的 \n、:、#。
      return `${prefix}${JSON.stringify(value)}${suffix}`
    })
    const unsupported = compiled.split(/\r?\n/).some(line => {
      const withoutComment = line.trimStart().startsWith('#') ? '' : line.replace(/\s+#.*$/, '')
      return /\$secret:[A-Za-z0-9]/.test(withoutComment)
    })
    if (unsupported) throw new Error('每个 $secret: 别名必须独占一个 YAML 配置值，且不能加引号或拼接文本。')

    const runtimeDir = path.join(storyDir, '.typ-0-runtime')
    mkdirSync(runtimeDir, { recursive: true })
    // A crash can leave a resolved file containing secrets behind. A story has
    // at most one typ-0 worker, so clear only our own stale filename pattern
    // before creating the next runtime copy.
    for (const name of readdirSync(runtimeDir)) {
      if (/^koishi\.\d+\.\d+\.resolved\.yml$/.test(name)) {
        try { rmSync(path.join(runtimeDir, name), { force: true }) } catch { /* best-effort cleanup */ }
      }
    }
    // M6：为 worker 注入每剧本 loopback Console。端口 0 = 由 OS 分配，worker
    // 启动后把实际端口回传宿主登记；canonical koishi.yml 不含密钥也不含端点。
    // 审计：手编 canonical 允许 4 空格/其它层级缩进——精确空格检测会漏判既有
    // 键、追加注入重复键（js-yaml 拒绝重复映射键，worker 直接启动失败，见
    // 2026-09-08 实录）。改为缩进无关检测；过宽的检测只导致跳过注入（降级），
    // 不会崩溃。
    const hasServer = /^[ \t]*(?:group:server:|server:)/m.test(compiled)
    const hasConsole = /^[ \t]*(?:group:console:|console:)/m.test(compiled)
    const consoleInjected = !hasServer || !hasConsole
    const injected = consoleInjected ? [
      '',
      '  # typ-0 M6 注入：每剧本隔离的 loopback Console（仅 127.0.0.1，端口由 OS 分配）。',
      '  # 保存配置后随 Worker 重载重新注入，不需要写进本文件。',
      ...(hasServer ? [] : [
        '  group:server:',
        '    server:m0:',
        '      host: 127.0.0.1',
        '      port: 0',
      ]),
      ...(hasConsole ? [] : [
        '  group:console:',
        '    console:m0:',
        '      open: false',
      ]),
    ].join('\n') : ''
    // M7-2：OneBot 账号注入。selfId 与内部端点是宿主运行参数：账号登记+绑定
    // 事务确认后写在这里，worker 的 adapter-onebot 以登记身份连入桌面桥接。
    const onebotSelfId = options.onebot?.selfId?.trim()
    const onebotEndpoint = options.onebot?.endpoint?.trim()
    const hasOnebotAdapter = /^[ \t]*adapter-onebot:/m.test(compiled)
    const onebotInjected = !!(onebotSelfId || onebotEndpoint)
    let onebotBlock = ''
    let resolvedText = compiled
    if (onebotInjected) {
      const yamlScalar = (value: string) => JSON.stringify(value)
      const selfIdLine = onebotSelfId ? `      selfId: ${yamlScalar(onebotSelfId)}` : ''
      const endpointLine = onebotEndpoint ? `      endpoint: ${yamlScalar(onebotEndpoint)}` : ''
      if (hasOnebotAdapter) {
        // 已有 adapter 块：就地替换/插入 selfId 与 endpoint。绝不能追加第二个
        // 顶层 group:adapter 键——js-yaml 拒绝重复映射键，worker 会直接启动失败
        // （真机验收 2026-09-08 实测抓到：模板 yml 自带 adapter 块 + 追加注入 =
        // YAMLException: duplicated mapping key）。
        const lines = compiled.split('\n')
        // 审计：head 检测同样缩进无关（实例后缀不限定 m0）；块尾判定放宽到
        // "缩进少于该块的任意非空行"，兼容 4 空格层级的手编文件。
        const head = lines.findIndex(line => /^[ \t]*adapter-onebot:[A-Za-z0-9_-]*:/.test(line))
        if (head < 0) throw new Error('检测到 adapter-onebot 但无法定位其块首——请检查 koishi.yml 缩进后重试。')
        const headIndent = lines[head].match(/^[ \t]*/)![0]
        let tail = lines.length
        for (let i = head + 1; i < lines.length; i++) {
          const line = lines[i]
          if (line.trim() && !line.startsWith(headIndent + ' ')) { tail = i; break }
        }
        const childIndent = headIndent + '  '
        const setKey = (key: 'selfId' | 'endpoint' | 'token', value: string) => {
          // CRLF 文件 split('\n') 后行尾残留 \r；JS 的 . 不匹配 \r 且无 m 标志的
          // $ 不把 \r 当行尾，`.*$` 会整体失配（真机验收实测：selfId 替换静默
          // 退化为插入，产生重复键）。用 [^\r\n]* 精确到行内容。
          const pattern = new RegExp(`^(${childIndent}${key}:)[^\\r\\n]*`)
          const offset = lines.slice(head + 1, tail).findIndex(line => pattern.test(line))
          if (offset >= 0) {
            const at = head + 1 + offset
            lines[at] = lines[at].replace(pattern, (_match, indent: string) => `${indent} ${yamlScalar(value)}`)
          } else {
            lines.splice(head + 1, 0, `${childIndent}${key}: ${yamlScalar(value)}`)
          }
        }
        if (onebotSelfId) setKey('selfId', onebotSelfId)
        // 三方审查P1: 已有 adapter 块的配置也注入宿主 token（与注入块同源）。
        // 审计：探测范围限定在 adapter 块内——全文件扫描会把其它插件任何层级的
        // token: 键误判为 adapter 已有 token，导致鉴权缺失、worker 连接被桥拒绝。
        // 空值注入（issue #2 根因）：向导/导入模板自带 `token: ''`，若把"键存在"
        // 当作"已配置"跳过注入，worker 会以无鉴权连桥被 1008 拒绝且 adapter
        // 重连死锁（getActive=false 永不再试）——插件 5 分钟巡检随即把端点写成
        // 离线，主动消息在每次入站后的下一个巡检周期必失败。因此键缺失或值为
        // 空（裸空 / '' / "" / 行尾注释 / CRLF）都注入；用户手写的非空 token 保留，
        // 若与桥 token 不符由就绪检查的内部桥会话项暴露。
        const adapterLines = lines.slice(head + 1, tail)
        const tokenLine = adapterLines.find(l => /^\s+token:/.test(l))
        const tokenValueEmpty = !tokenLine || /^\s+token:\s*(?:["']{2})?\s*(?:#[^\r\n]*)?\s*$/.test(tokenLine)
        if (process.env.HDSI_ONEBOT_TOKEN && tokenValueEmpty) setKey('token', process.env.HDSI_ONEBOT_TOKEN)
        if (onebotEndpoint) setKey('endpoint', onebotEndpoint)
        resolvedText = lines.join('\n')
      } else {
        onebotBlock = [
          '',
          '  # typ-0 M7 注入：账号登记+绑定事务确认的宿主运行参数（不回写本文件）。',
          '  group:adapter:',
          '    adapter-onebot:m0:',
          ...(selfIdLine ? [selfIdLine] : []),
          ...(endpointLine ? [endpointLine] : []),
          ...(process.env.HDSI_ONEBOT_TOKEN ? [`      token: ${yamlScalar(process.env.HDSI_ONEBOT_TOKEN)}`] : []),
        ].join('\n')
      }
    }
    const file = path.join(runtimeDir, `koishi.${process.pid}.${Date.now()}.resolved.yml`)
    writeFileSync(file, resolvedText + injected + onebotBlock, { encoding: 'utf8', mode: 0o600 })
    try { chmodSync(file, 0o600) } catch { /* Windows 不支持 Unix mode，仍保留最小权限意图。 */ }
    return {
      file,
      aliases: [...aliases],
      consoleInjected,
      /** true 表示本轮注入了 OneBot 账号运行参数（selfId/端点）。 */
      onebotInjected,
      cleanup: () => { try { rmSync(file, { force: true }) } catch { /* 退出清理不得遮蔽 worker 退出。 */ } },
    }
  }
}

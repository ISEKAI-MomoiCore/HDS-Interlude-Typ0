import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/**
 * Phase 2「装得上」：第三方 Koishi 插件的受控安装器。
 *
 * 插件落在 <dataRoot>/plugins-runtime（打包版 userData 下可写；dev 模式为
 * appRoot），worker 经 NODE_PATH 解析到该目录，koishi/cordis 系列由
 * .typ0-host-hook.js 强制重定向到宿主副本（同实例，Spike A 已验证）。
 *
 * 安全姿态：
 *  - 包名白名单：仅 koishi-plugin-* 与 @koishijs/plugin-*（含 @scope/koishi-plugin-*）；
 *  - --ignore-scripts：第三方 install/postinstall 脚本一律不执行（原生依赖
 *    类插件会因此不可用——安全优先，属预期边界）；
 *  - --legacy-peer-deps：不把 koishi/cordis 复制进运行时目录（双实例灾难），
 *    宿主副本经解析 hook 提供给插件；
 *  - registry 固定 npmmirror（.npmrc 同源），超时 5 分钟。
 */

const REGISTRY = 'https://registry.npmmirror.com'
const NPM_TIMEOUT_MS = 300_000
const NAME_ALLOW = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?koishi-plugin-[a-z0-9-._~]+$|^@koishijs\/plugin-[a-z0-9-._~]+$/

export function validatePluginPackageName(name: string): string {
  const trimmed = String(name || '').trim()
  if (!NAME_ALLOW.test(trimmed)) {
    throw new Error(`仅允许安装 koishi-plugin-* 或 @koishijs/plugin-* 包名（可带 @scope/ 前缀）：${name}`)
  }
  return trimmed
}

/** 运行时目录自举：node_modules + package.json + 宿主解析 hook。幂等。 */
export function ensurePluginRuntimeFiles(runtimeDir: string, hostNodeModules: string): string {
  mkdirSync(path.join(runtimeDir, 'node_modules'), { recursive: true })
  const manifest = path.join(runtimeDir, 'package.json')
  if (!existsSync(manifest)) {
    writeFileSync(manifest, JSON.stringify({ name: 'typ0-plugins', private: true }, null, 2) + '\n', 'utf8')
  }
  // 解析 hook：fork 时 --require 注入。koishi/cordis/schemastery 系列的裸
  // require 一律从宿主 node_modules 解析——无论插件目录树向上走到哪里，
  // 插件拿到的都是与宿主同一个实例（Spike A 实测：否则会命中任意祖先
  // 目录里的另一份 koishi，instanceof 全部失效）。
  const hookPath = path.join(runtimeDir, '.typ0-host-hook.js')
  const hook = [
    '// typ0 host resolve hook — fork 注入（--require），勿手改；删除后由宿主重建。',
    'const Module = require("module")',
    'const path = require("path")',
    `const HOST = ${JSON.stringify(hostNodeModules)}`,
    'const REDIRECT = /^(koishi|cordis|schemastery|cosmokit|@cordisjs\\u002f|@satorijs\\u002f|@minatojs\\u002f)/',
    'const original = Module._resolveFilename',
    'Module._resolveFilename = function (request, parent) {',
    '  if (HOST && REDIRECT.test(request) && !request.startsWith(".") && !path.isAbsolute(request)) {',
    '    try { return original.call(this, request, Object.assign({}, parent, { paths: [HOST] })) } catch (error) { /* 回退原解析 */ }',
    '  }',
    '  return original.apply(this, arguments)',
    '}',
    '',
  ].join('\n')
  writeFileSync(hookPath, hook, 'utf8')
  return hookPath
}

export interface InstallerResult { package: string, version: string | null, output: string }

export class PluginInstaller {
  constructor(
    private readonly runtimeDir: string,
    /** npm 输出逐行回传（进度/诊断日志）。 */
    private readonly onLog?: (line: string) => void,
  ) {}

  /** 运行时目录里已管理的插件（package.json dependencies）。 */
  managed(): Record<string, string> {
    const manifest = path.join(this.runtimeDir, 'package.json')
    if (!existsSync(manifest)) return {}
    try {
      const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as { dependencies?: Record<string, string> }
      return parsed.dependencies ?? {}
    } catch { return {} }
  }

  installedVersion(packageName: string): string | null {
    const manifest = path.join(this.runtimeDir, 'node_modules', packageName, 'package.json')
    if (!existsSync(manifest)) return null
    try {
      return String((JSON.parse(readFileSync(manifest, 'utf8')) as { version?: string }).version || '?')
    } catch { return null }
  }

  private npm(args: string[]): Promise<{ code: number, output: string }> {
    const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm'
    // Node ≥18.20/20.12 禁止无 shell 直接 spawn .cmd/.bat。shell 模式下参数
    // 逐一加引号，但程序名保持裸名——给 "npm.cmd" 加引号会破坏其 %~dp0
    // 内部路径解析（实测退化为 CWD 相对寻径 npm-cli.js → MODULE_NOT_FOUND）。
    // 包名已过白名单校验（无空格/引号/分号），其余参数为常量。
    const commandLine = process.platform === 'win32'
      ? [npmCommand, ...args.map(arg => `"${arg.replace(/"/g, '')}"`)].join(' ')
      : undefined
    return new Promise((resolve, reject) => {
      let child: ReturnType<typeof spawn>
      try {
        child = process.platform === 'win32'
          ? spawn(commandLine!, { cwd: this.runtimeDir, windowsHide: true, shell: true })
          : spawn(npmCommand, args, { cwd: this.runtimeDir, windowsHide: true })
      } catch (error) { reject(error); return }
      let output = ''
      const timer = setTimeout(() => {
        child.kill()
        // 超时被杀 ≠ 未安装：npm 可能已部分写入 node_modules（结果不可知）。
        // 重试对 install/update/uninstall 都安全（npm 幂等收敛），但先核对
        // 已装版本能避免"其实已装好却报失败"的误判。
        reject(new Error(`npm 超时（${Math.round(NPM_TIMEOUT_MS / 60000)} 分钟）进程已终止——本次操作结果不可知（依赖可能已部分写入）。重试安全；重试前可先在插件面板核对已装版本。`))
      }, NPM_TIMEOUT_MS)
      child.stdout?.on('data', chunk => { const text = String(chunk); output += text; for (const line of text.split(/\r?\n/)) if (line.trim()) this.onLog?.(line.trim()) })
      child.stderr?.on('data', chunk => { const text = String(chunk); output += text; for (const line of text.split(/\r?\n/)) if (line.trim()) this.onLog?.(line.trim()) })
      child.on('error', error => { clearTimeout(timer); reject(new Error(`无法启动 npm（${error}）——打包版环境可能未内置 npm，属已知边界。`)) })
      child.on('exit', code => { clearTimeout(timer); resolve({ code: code ?? -1, output }) })
    })
  }

  private async runNpm(args: string[], packageName: string): Promise<InstallerResult> {
    // 只自举 manifest/node_modules；宿主解析 hook 由宿主侧用真实 host 路径生成。
    mkdirSync(path.join(this.runtimeDir, 'node_modules'), { recursive: true })
    const manifest = path.join(this.runtimeDir, 'package.json')
    if (!existsSync(manifest)) {
      writeFileSync(manifest, JSON.stringify({ name: 'typ0-plugins', private: true }, null, 2) + '\n', 'utf8')
    }
    const { code, output } = await this.npm([...args, '--legacy-peer-deps', '--ignore-scripts', '--no-audit', '--no-fund', `--registry=${REGISTRY}`])
    if (code !== 0) throw new Error(`npm ${args[0]} 失败（exit ${code}）：${output.slice(-1_500).trim()}`)
    return { package: packageName, version: this.installedVersion(packageName), output }
  }

  async install(packageName: string, version?: string): Promise<InstallerResult> {
    const name = validatePluginPackageName(packageName)
    return this.runNpm(['install', version ? `${name}@${version}` : name, '--save'], name)
  }

  async update(packageName: string): Promise<InstallerResult> {
    const name = validatePluginPackageName(packageName)
    return this.runNpm(['install', `${name}@latest`, '--save'], name)
  }

  async uninstall(packageName: string): Promise<InstallerResult> {
    const name = validatePluginPackageName(packageName)
    if (!(name in this.managed())) throw new Error(`插件不在 typ0 运行时目录中：${name}`)
    return this.runNpm(['uninstall', name, '--save'], name)
  }
}

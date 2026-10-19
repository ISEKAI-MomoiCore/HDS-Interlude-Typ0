import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
export type SnowLumaStatus = 'not-found' | 'installed' | 'running' | 'unknown'
export interface SnowLumaDetection {
  status: SnowLumaStatus
  path?: string
  checkedAt: string
  process: 'running' | 'not-running' | 'unknown'
  webui: { status: 'reachable' | 'unreachable' | 'unknown'; reachable: boolean; port: number; statusCode?: number }
}
export interface LocalSnowAccount { uin: string; hasToken: boolean; wsEndpoints: Array<{ port: number; path: string; host: string }> }
export interface SnowProcess { ExecutablePath?: string; CommandLine?: string }
function readJson(file: string): any {
  try { if (statSync(file).size > 1024 * 1024) return undefined; return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) } catch { return undefined }
}
export function isSnowLumaInstallation(root: string): boolean {
  const pkg = readJson(path.join(root, 'package.json'))
  try { return /^@snowluma\//i.test(String(pkg?.name ?? '')) && statSync(path.join(root, 'index.mjs')).isFile() } catch { return false }
}
function processRoot(proc: SnowProcess): string | undefined {
  // Bundled Node must actually execute the entry point, not merely live in a similarly named directory.
  const exe = proc.ExecutablePath ?? ''
  if (!/^(node|snowluma)(\.exe)?$/i.test(path.basename(exe))) return
  const tokens = (proc.CommandLine ?? '').match(/"[^"\r\n]*"|'[^'\r\n]*'|[^\s"']+/g)?.map(token => token.replace(/^["']|["']$/g, '')) ?? []
  const entry = tokens.slice(1).find(token => /(?:^|[\\/])index\.mjs$/i.test(token))
  if (entry && path.isAbsolute(entry)) {
    const root = path.dirname(entry)
    return isSnowLumaInstallation(root) ? root : undefined
  }
  const root = path.dirname(exe)
  if (/^snowluma(\.exe)?$/i.test(path.basename(exe)) || (entry && /^(?:\.[\\/])?index\.mjs$/i.test(entry))) return isSnowLumaInstallation(root) ? root : undefined
  return undefined
}
async function queryProcesses(platform: string): Promise<SnowProcess[]> {
  if (platform !== 'win32') throw new Error('Process inspection is unavailable on this platform')
  const script = "$ErrorActionPreference='Stop'; [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false); @(Get-CimInstance Win32_Process -Filter \"Name = 'node.exe' OR Name LIKE 'SnowLuma%'\" | Select-Object ExecutablePath,CommandLine) | ConvertTo-Json -Compress"
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 5000, windowsHide: true, maxBuffer: 1024 * 1024 })
  const rows = JSON.parse(String(stdout).trim() || '[]')
  return Array.isArray(rows) ? rows : [rows]
}
export async function detectSnowLuma(options: { platform?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; candidates?: string[]; queryProcesses?: () => Promise<SnowProcess[]> } = {}): Promise<SnowLumaDetection> {
  const platform = options.platform ?? process.platform, env = options.env ?? process.env
  let processState: SnowLumaDetection['process'] = 'unknown', runningRoot: string | undefined
  try {
    const rows = await (options.queryProcesses ? options.queryProcesses() : queryProcesses(platform))
    runningRoot = rows.map(processRoot).find(Boolean)
    processState = runningRoot ? 'running' : rows.some(row => !row.ExecutablePath) ? 'unknown' : 'not-running'
  } catch { /* Timeout/access denied is not evidence that the process stopped. */ }
  let dynamic: string[] = []
  if (!options.candidates && platform === 'win32') {
    try { dynamic = readdirSync('C:/', { withFileTypes: true }).filter(e => e.isDirectory() && /^snowluma(?:-|$)/i.test(e.name)).map(e => path.join('C:/', e.name)).sort().reverse() } catch { /* inaccessible root */ }
  }
  const candidates = options.candidates ?? [env.SNOWLUMA_PATH, ...dynamic, 'C:/Program Files/SnowLuma', 'C:/dev/SnowLuma-main'].filter((v): v is string => !!v?.trim())
  const installationPath = runningRoot ?? candidates.find(isSnowLumaInstallation)
  const runtime = installationPath ? readJson(path.join(installationPath, 'config/runtime.json')) : undefined
  const port = Number.isInteger(runtime?.webuiPort) && runtime.webuiPort > 0 && runtime.webuiPort < 65536 ? runtime.webuiPort : 5099
  let webui: SnowLumaDetection['webui'] = { status: 'unknown', reachable: false, port }
  try {
    // Never follow redirects or contact a configured remote host. HTTP 401 still proves WebUI reachability, not login.
    const response = await fetch(`${runtime?.webuiTls?.enabled ? 'https' : 'http'}://127.0.0.1:${port}`, { signal: AbortSignal.timeout(options.timeoutMs ?? 700), redirect: 'manual' })
    webui = { status: 'reachable', reachable: true, port, statusCode: response.status }
    void response.body?.cancel().catch(() => {})
  } catch { webui = { status: 'unreachable', reachable: false, port } }
  return { status: processState === 'running' ? 'running' : installationPath ? 'installed' : processState === 'unknown' ? 'unknown' : 'not-found', ...(installationPath ? { path: path.resolve(installationPath) } : {}), checkedAt: new Date().toISOString(), process: processState, webui }
}
function localServers(root: string) {
  if (!isSnowLumaInstallation(root)) return []
  try {
    return readdirSync(path.join(root, 'config')).filter(f => /^onebot_\d+\.json$/.test(f)).flatMap(file => {
      const uin = file.slice(7, -5), doc = readJson(path.join(root, 'config', file))
      return (Array.isArray(doc?.networks?.wsServers) ? doc.networks.wsServers : []).filter((s: any) => s.enable !== false && s.enabled !== false && Number.isInteger(s.port) && s.port > 0 && s.port < 65536 && ['127.0.0.1', 'localhost', '0.0.0.0', '::', '::1'].includes(s.host)).map((s: any) => ({ uin, port: s.port as number, path: typeof s.path === 'string' && s.path.startsWith('/') && !/[?#]/.test(s.path) ? s.path : '/', token: typeof s.accessToken === 'string' ? s.accessToken.trim() : '' }))
    }) as Array<{ uin: string; port: number; path: string; token: string }>
  } catch { return [] }
}
/** Metadata only: config presence does not assert that the account is logged in. */
export function discoverSnowLumaAccounts(root: string): LocalSnowAccount[] {
  const accounts = new Map<string, LocalSnowAccount>()
  for (const server of localServers(root)) {
    const account = accounts.get(server.uin) ?? { uin: server.uin, hasToken: false, wsEndpoints: [] }
    account.hasToken ||= !!server.token
    account.wsEndpoints.push({ port: server.port, path: server.path, host: '127.0.0.1' })
    accounts.set(server.uin, account)
  }
  return [...accounts.values()]
}
/** Only main may read this; never return the result through IPC. Exact identity + endpoint matching prevents token exfiltration. */
export function readLocalSnowLumaToken(root: string, selfId: string, endpoint: string): string | undefined {
  let url: URL
  try { url = new URL(endpoint) } catch { return }
  if (url.protocol !== 'ws:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash) return
  const matches = localServers(root).filter(s => s.uin === selfId && String(s.port) === url.port && s.path === url.pathname)
  return matches.length === 1 ? matches[0].token : undefined
}

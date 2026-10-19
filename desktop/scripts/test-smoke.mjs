/**
 * P2 测试批次 B 档：Electron 主进程自检冒烟驱动器。
 * 以 `electron . --typ0-self-test` 启动真实应用（自检模式内隔离 userData/
 * 数据根/HostLock 到临时目录），收集 [self-test] 标记行，超时击杀即失败。
 * 会短暂弹出一个真实窗口——刻意不进默认 npm test 循环，单独 `test:smoke`。
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const require = createRequire(import.meta.url)
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
// 普通 Node 上下文里 require('electron') 返回二进制路径字符串。
const electronPath = require('electron')

const TIMEOUT_MS = 90_000
const child = spawn(electronPath, ['.', '--typ0-self-test'], { cwd: appRoot, stdio: ['ignore', 'pipe', 'pipe'] })
let output = ''
child.stdout.on('data', chunk => { output += chunk; process.stdout.write(chunk) })
child.stderr.on('data', chunk => { output += chunk; process.stderr.write(chunk) })

const timer = setTimeout(() => {
  console.error('[smoke] 超时击杀（%ds）— 未见 DONE 标记', TIMEOUT_MS / 1000)
  child.kill('SIGKILL')
  process.exitCode = 1
}, TIMEOUT_MS)

const exitCode = await new Promise(resolve => child.once('exit', code => resolve(code ?? -1)))
clearTimeout(timer)

const done = output.includes('[self-test] DONE OK')
const failed = /\[self-test\] FAIL/.test(output)
if (!done || failed || exitCode !== 0) {
  console.error(`[smoke] 冒烟失败（exit=${exitCode} done=${done} failMark=${failed}）`)
  process.exit(1)
}
console.log('[smoke] 主进程自检冒烟通过')

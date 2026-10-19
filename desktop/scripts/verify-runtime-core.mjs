/**
 * runtime-core 校验（P2 测试批次 A 档）：把 PROVENANCE"再构建流程"里的手工
 * 哈希校验变成一条命令。三重检查：
 *   1. release tgz 的 SHA256 与同目录 .sha256 sidecar 一致（若存在）；
 *   2. tgz 内 package/lib/index.js 的 SHA256 == node_modules 内安装产物（防
 *      "package.json 指向新包但 node_modules 还是旧的"）；
 *   3. 安装产物 package.json 版本号出现在依赖文件名中（防锁错版本）。
 * 退出码非 0 即失配——可直接挂进任何升级同步流程。
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sha256 = data => createHash('sha256').update(data).digest('hex')

/** 极简 tar 读取：只取指定路径条目的内容（512 字节头 + 八进制 size）。 */
function tarEntry(tarBuffer, entryName) {
  for (let offset = 0; offset + 512 <= tarBuffer.length; ) {
    const rawName = tarBuffer.toString('utf8', offset, offset + 100).replace(/\0.*$/, '')
    const prefix = tarBuffer.toString('utf8', offset + 345, offset + 500).replace(/\0.*$/, '')
    const name = prefix ? `${prefix}/${rawName}` : rawName
    const size = parseInt(tarBuffer.toString('ascii', offset + 124, offset + 136).replace(/[^0-7]/g, ''), 8) || 0
    // typeflag：'0' 或 NUL = 普通文件；'5' 目录；'x'/'g' pax 头（跳过其数据块）。
    const type = tarBuffer[offset + 156]
    const dataStart = offset + 512
    if ((type === 0x30 || type === 0x00) && name === entryName) return tarBuffer.subarray(dataStart, dataStart + size)
    offset = dataStart + Math.ceil(size / 512) * 512
  }
  return undefined
}

const failures = []
const note = (ok, label, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ' — ' + detail : ''}`)
  if (!ok) failures.push(label)
}

const pkg = JSON.parse(readFileSync(path.join(desktopRoot, 'package.json'), 'utf8'))
const dep = pkg.dependencies['koishi-plugin-hds-interlude']
if (!dep?.startsWith('file:')) {
  console.error(`FAIL 依赖形态 — koishi-plugin-hds-interlude 必须是 file: tgz 锁定（当前：${dep}）`)
  process.exit(1)
}
const tgzPath = path.resolve(desktopRoot, dep.slice('file:'.length).replace(/\\/g, '/'))
note(existsSync(tgzPath), 'tgz-exists', tgzPath)
if (!existsSync(tgzPath)) process.exit(1)
const tgzBytes = readFileSync(tgzPath)

// 1. sidecar（存在才校验——早期构建没有 sidecar）
const sidecar = tgzPath + '.sha256'
if (existsSync(sidecar)) {
  const expected = readFileSync(sidecar, 'utf8').trim().split(/\s+/)[0]
  note(sha256(tgzBytes) === expected, 'tgz-sha256-sidecar', sha256(tgzBytes))
} else {
  console.log('SKIP tgz-sha256-sidecar — 无 sidecar 文件')
}

// 2. tgz 内 bundle ↔ 安装产物
const inner = tarEntry(gunzipSync(tgzBytes), 'package/lib/index.js')
const installedPath = path.join(desktopRoot, 'node_modules', 'koishi-plugin-hds-interlude', 'lib', 'index.js')
note(!!inner, 'tgz-inner-bundle-present')
note(existsSync(installedPath), 'installed-bundle-present', installedPath)
if (inner && existsSync(installedPath)) {
  const innerHash = sha256(inner)
  const installedHash = sha256(readFileSync(installedPath))
  note(innerHash === installedHash, 'bundle-hash-match', `tgz=${innerHash} installed=${installedHash}`)
}

// 3. 版本一致性：安装产物版本号出现在依赖文件名中
const installedPkgPath = path.join(desktopRoot, 'node_modules', 'koishi-plugin-hds-interlude', 'package.json')
if (existsSync(installedPkgPath)) {
  const version = JSON.parse(readFileSync(installedPkgPath, 'utf8')).version
  note(path.basename(tgzPath).includes(version), 'version-consistency', `installed=${version} file=${path.basename(tgzPath)}`)
}

if (failures.length) {
  console.error(`runtime-core 校验失败：${failures.join('、')}`)
  process.exit(1)
}
console.log('runtime-core 校验通过。')

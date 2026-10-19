import esbuild from 'esbuild'
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(fileURLToPath(new URL('.', import.meta.url)))
const dist = path.join(root, 'dist')

mkdirSync(path.join(dist, 'main'), { recursive: true })
mkdirSync(path.join(dist, 'preload'), { recursive: true })
mkdirSync(path.join(dist, 'renderer'), { recursive: true })
// Remove the obsolete generated artifact left by pre-consolidation builds.
const staleHostBundle = path.join(dist, 'main', 'host.js')
if (existsSync(staleHostBundle)) rmSync(staleHostBundle, { force: true })

// host.ts was removed when the desktop shell was consolidated into main.ts.
// Keep one authoritative main-process entry so a clean checkout can build.
for (const entry of ['src/main/main.ts']) {
  await esbuild.build({
    entryPoints: [path.join(root, entry)],
    outfile: path.join(dist, entry.replace(/^src\//, '').replace(/\.ts$/, '.js')),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['electron', 'koishi', 'koishi-plugin-*'],
    // 性能审计：inline sourcemap 占 dist/main/main.js 的 73%（1.5MB base64）——
    // 外置 .map 文件（主进程加载不受影响，排障时同目录可查）。
    sourcemap: true,
  })
}

await esbuild.build({
  entryPoints: [path.join(root, 'src/preload/preload.ts')],
  outfile: path.join(dist, 'preload/preload.js'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['electron'],
})

// renderer 整目录复制前先清掉旧产物——cpSync 只覆盖同名文件，已删除的源文件
// 会以幽灵形态留在 dist 里被 Electron 加载。
rmSync(path.join(dist, 'renderer'), { recursive: true, force: true })
cpSync(path.join(root, 'src/renderer'), path.join(dist, 'renderer'), { recursive: true })
console.log('build ok')

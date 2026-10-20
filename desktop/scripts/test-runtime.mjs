import { build } from 'esbuild'
import { rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

// 只收录可在纯 node 下运行的套件：connection-repair 依赖 electron（走
// test:connection-repair），config-importer 走 test:importer。
const entries = [
  'src/main/runtime/runtime.test.ts',
  'src/main/runtime/plugin-panel.test.ts',
]
const outputs = entries.map(entry => entry.replace('src/main/runtime/', '.typ-0-rt-').replace('.ts', '.cjs'))
try {
  for (let i = 0; i < entries.length; i++) {
    await build({ entryPoints: [entries[i]], bundle: true, platform: 'node', format: 'cjs', outfile: outputs[i], external: ['ws'] })
  }
  const result = spawnSync(process.execPath, ['--test', ...outputs], { stdio: 'inherit' })
  process.exitCode = result.status ?? 1
} finally {
  for (const file of outputs) rmSync(file, { force: true })
}

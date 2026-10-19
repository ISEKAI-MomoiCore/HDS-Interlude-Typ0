import { build } from 'esbuild'
import { rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const output = '.typ-0-runtime-tests.cjs'
try {
  await build({ entryPoints: ['src/main/runtime/runtime.test.ts'], bundle: true, platform: 'node', format: 'cjs', outfile: output, external: ['ws'] })
  const result = spawnSync(process.execPath, ['--test', output], { stdio: 'inherit' })
  process.exitCode = result.status ?? 1
} finally {
  rmSync(output, { force: true })
}

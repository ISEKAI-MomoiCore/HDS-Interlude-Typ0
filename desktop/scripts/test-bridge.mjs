import { build } from 'esbuild'
import { rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

// 桥/边界合同测试：bundle 纯 TS 测试后以 node --test 运行（与 test-runtime.mjs
// 同一模式）。两组：bridge-session.test.ts（协商/能力面合同，fixture 取自真实
// 历史发布包）；worker-projections.test.ts（worker→renderer DTO 投影的畸形值
// 矩阵）。规则见根目录 BRIDGE_PROTOCOL.md。
const outputs = []
try {
  for (const [source, output] of [
    ['src/main/runtime/bridge-session.test.ts', '.typ-0-bridge-contracts.cjs'],
    ['src/main/runtime/worker-projections.test.ts', '.typ-0-projection-contracts.cjs'],
    ['src/main/ipc/sender-guard.test.ts', '.typ-0-sender-guard-contracts.cjs'],
  ]) {
    outputs.push(output)
    await build({ entryPoints: [source], bundle: true, platform: 'node', format: 'cjs', outfile: output, external: ['ws'] })
  }
  const result = spawnSync(process.execPath, ['--test', ...outputs], { stdio: 'inherit' })
  process.exitCode = result.status ?? 1
} finally {
  for (const output of outputs) rmSync(output, { force: true })
}

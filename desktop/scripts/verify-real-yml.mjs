// 一次性验证：用真实插件版 koishi.yml 跑 analyze（只读；只输出脱敏统计，不打印任何值）。
import { build } from 'esbuild'
import { readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)

const output = '.typ-0-verify-real.cjs'
try {
  await build({ entryPoints: ['src/main/runtime/config-importer.ts'], bundle: true, platform: 'node', format: 'cjs', outfile: output })
  const { analyzeKoishiYml } = require(process.cwd() + '/' + output)
  const text = readFileSync(process.argv[2] || 'C:/dev/HDS-Interlude/koishi.yml', 'utf8')
  const result = analyzeKoishiYml(text)
  if (!result.ok) { console.log('ANALYZE FAILED:', result.error); process.exit(1) }
  const { analysis } = result
  const safe = {
    ok: true,
    file: analysis.file,
    personaPresent: analysis.modules.persona.present,
    personaNamePresent: !!analysis.modules.persona.characterName,
    users: analysis.modules.relations.users,
    groups: analysis.modules.relations.groups,
    bots: analysis.modules.accounts.bots,
    adapters: analysis.modules.accounts.adapters.map(a => ({ selfIdLen: a.selfId.length, protocol: a.protocol, reverse: a.reverse, endpointHost: (() => { try { return new URL(a.endpoint).host } catch { return '' } })() })),
    bindable: analysis.modules.accounts.bindable,
    providers: analysis.modules.model.providers,
    plaintextKeys: analysis.modules.model.plaintextKeys,
    secretRefs: analysis.modules.model.secretRefs,
    behaviorSections: analysis.modules.behavior.map(b => b.key),
    mainPrompt: analysis.modules.mainPrompt.present,
    misc: analysis.modules.misc,
    warnings: analysis.warnings.length,
    plaintextLeakInAnalysis: JSON.stringify(analysis).includes('sk-') || /token=[^'"]+/.test(JSON.stringify(analysis)),
  }
  console.log(JSON.stringify(safe, null, 2))
} finally {
  rmSync(output, { force: true })
}

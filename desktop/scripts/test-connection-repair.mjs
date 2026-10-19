import { build } from 'esbuild'
import { spawnSync } from 'node:child_process'
import { unlinkSync } from 'node:fs'
const outfile = '.typ-0-connection-repair-tests.cjs'
try {
  await build({entryPoints:['src/main/runtime/connection-repair.test.ts'],outfile,bundle:true,platform:'node',format:'cjs',external:['ws'],plugins:[{name:'isolated-electron-ipc',setup(b){b.onResolve({filter:/^electron$/},()=>({path:'electron',namespace:'test'}));b.onLoad({filter:/.*/,namespace:'test'},()=>({contents:'export const ipcMain = {handle(name, handler) {globalThis.repairHandlers ??= new Map();globalThis.repairHandlers.set(name,handler)}}',loader:'js'}))}}]})
  const result=spawnSync(process.execPath,['--test',outfile],{stdio:'inherit'});process.exitCode=result.status??1
} finally { try{unlinkSync(outfile)}catch{} }

import { build } from 'esbuild'
import { writeFileSync, unlinkSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createRequire } from 'node:module'
const out='.typ-0-local-snow-check.cjs'
try{
 await build({stdin:{contents:"export { detectSnowLuma, discoverSnowLumaAccounts, readLocalSnowLumaToken } from './src/main/runtime/snowluma-detection'; export {probeUpstream} from './src/main/runtime/probe-upstream'",resolveDir:process.cwd(),loader:'ts'},outfile:out,bundle:true,platform:'node',format:'cjs',external:['ws']})
 const api=createRequire(import.meta.url)('../'+out)
 const snow=await api.detectSnowLuma();const accounts=snow.path?api.discoverSnowLumaAccounts(snow.path):[]
 const unique=new Set(),checks=[]
 for(const a of accounts)for(const ep of a.wsEndpoints){
  const endpoint=`ws://127.0.0.1:${ep.port}${ep.path}`
  if(unique.has(endpoint))continue
  const token=api.readLocalSnowLumaToken(snow.path,a.uin,endpoint)
  const r=await api.probeUpstream(endpoint,token,a.uin)
  checks.push({port:ep.port,authenticated:r.ok,code:r.code??(r.ok?'IDENTITY_VERIFIED':'NOT_VERIFIED')})
  if(r.ok)unique.add(endpoint)
 }
 const report={checkedAt:new Date().toISOString(),snowluma:snow.status,path:snow.path,process:snow.process,webui:snow.webui,configuredAccounts:accounts.length,onebot:checks,readOnly:true,actions:['get_login_info only; no messages sent; no config or credentials changed']}
 const dest=process.env.SNOWLUMA_VERIFICATION_OUTPUT||path.join(os.tmpdir(),'hdsi-local-snowluma-verification.json');mkdirSync(path.dirname(dest),{recursive:true});writeFileSync(dest,JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2))
}finally{try{unlinkSync(out)}catch{}}

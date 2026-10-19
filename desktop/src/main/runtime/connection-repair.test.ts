import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'
import yaml from 'js-yaml'
import { WebSocketServer } from 'ws'
import { detectSnowLuma, discoverSnowLumaAccounts, readLocalSnowLumaToken } from './snowluma-detection'
import { probeUpstream, isValidUpstreamEndpoint } from './probe-upstream'
import { resolveUpstreamToken } from './upstream-credentials'
import { ExternalOneBotConnector } from './external-onebot-connector'
import { registerMixerIpc } from '../ipc/mixer'
import { registerAccountsIpc } from '../ipc/accounts'
function fixture() {
 const root=mkdtempSync(path.join(os.tmpdir(),'hdsi-connection-repair-'))
 mkdirSync(path.join(root,'config'));writeFileSync(path.join(root,'package.json'),JSON.stringify({name:'@snowluma/runtime'}));writeFileSync(path.join(root,'index.mjs'),'')
 writeFileSync(path.join(root,'config/runtime.json'),JSON.stringify({webuiPort:5234}))
 return {root, cleanup:()=>rmSync(root,{recursive:true,force:true})}
}
const delay=(ms:number)=>new Promise(r=>setTimeout(r,ms))
test('bundled Node and system Node identify only a validated SnowLuma entry; running root wins',async()=>{
 const f=fixture(), original=globalThis.fetch; const probes:string[]=[]
 globalThis.fetch=(async(input:any)=>{probes.push(String(input));return {status:401,body:{cancel:async()=>{}}}}) as any
 try {
  for(const exe of [path.join(f.root,'node.exe'),path.join(os.tmpdir(),'node.exe')]){
   const result=await detectSnowLuma({candidates:[],queryProcesses:async()=>[{ExecutablePath:exe,CommandLine:`"${exe}" "${path.join(f.root,'index.mjs')}"`}]})
   assert.equal(result.status,'running');assert.equal(result.path,f.root);assert.equal(result.webui.port,5234);assert.equal(result.webui.reachable,true)
  }
  const other=await detectSnowLuma({candidates:[],queryProcesses:async()=>[{ExecutablePath:path.join(f.root,'node.exe'),CommandLine:'node.exe C:/other/index.mjs'}]})
  assert.equal(other.process,'not-running');assert.equal(other.status,'not-found')
  const inaccessible=await detectSnowLuma({candidates:[f.root],queryProcesses:async()=>{throw Error('timeout')}})
  assert.equal(inaccessible.process,'unknown');assert.equal(inaccessible.status,'installed')
  assert.ok(probes.every(s=>s.startsWith('http://127.0.0.1:')))
 }finally{globalThis.fetch=original;f.cleanup()}
})
test('local discovery exposes metadata, and credentials require exact loopback identity/port/path',()=>{
 const f=fixture();try{
  writeFileSync(path.join(f.root,'config/onebot_123456.json'),JSON.stringify({networks:{wsServers:[{host:'0.0.0.0',port:3001,path:'/onebot',accessToken:'fixture-private-token'},{host:'127.0.0.1',port:3002,path:'/',enabled:false,accessToken:'disabled'}]}}))
  const meta=discoverSnowLumaAccounts(f.root);assert.equal(meta.length,1);assert.equal(meta[0].wsEndpoints.length,1);assert.equal(meta[0].hasToken,true);assert.ok(!JSON.stringify(meta).includes('fixture-private-token'))
  assert.equal(readLocalSnowLumaToken(f.root,'123456','ws://127.0.0.1:3001/onebot'),'fixture-private-token')
  for(const url of ['ws://example.com:3001/onebot','ws://127.0.0.1:3002/onebot','ws://127.0.0.1:3001/other','ws://127.0.0.1:3001/onebot?redirect=x','ws://user@127.0.0.1:3001/onebot']) assert.equal(readLocalSnowLumaToken(f.root,'123456',url),undefined)
  assert.equal(readLocalSnowLumaToken(f.root,'654321','ws://127.0.0.1:3001/onebot'),undefined)
 }finally{f.cleanup()}
})
test('saved token reuse is scoped to story + identity + exact endpoint and can be disabled',async()=>{
 let reads=0
 const registry={findBySelfId:(id:string)=>id==='123456'?{storyId:'a',externalUpstream:{endpoint:'ws://127.0.0.1:3001/',tokenAlias:'alias'}}:undefined} as any
 const secrets={get:()=>{reads++;return 'saved-fixture-token'}} as any
 const base={endpoint:'ws://127.0.0.1:3001',selfId:'123456',storyId:'a'}
 assert.equal(await resolveUpstreamToken(base,registry,secrets),'saved-fixture-token')
 for(const patch of [{storyId:'b'},{selfId:'654321'},{endpoint:'ws://example.com:3001'},{endpoint:'ws://127.0.0.1:3002'},{reuseSavedToken:false}]) assert.equal(await resolveUpstreamToken({...base,...patch},registry,secrets),undefined)
 assert.equal(reads,1);assert.equal(await resolveUpstreamToken({...base,token:' new-token '},registry,secrets),'new-token')
})
test('WS probe classifies 401, checks identity, rejects unsafe endpoints, and closes sockets',async()=>{
 const server=http.createServer(), ws=new WebSocketServer({noServer:true});let active=0,upgrades=0
 server.on('upgrade',(req,socket,head)=>{upgrades++;if(req.headers.authorization!=='Bearer fixture-token'){socket.end('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n');return}ws.handleUpgrade(req,socket,head,client=>ws.emit('connection',client))})
 ws.on('connection',s=>{active++;s.on('close',()=>active--);s.on('message',raw=>{const f=JSON.parse(String(raw));s.send(JSON.stringify({status:'ok',data:{user_id:'123456',nickname:'fixture'},echo:f.echo}))})})
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const endpoint=`ws://127.0.0.1:${(server.address() as any).port}`
 try{
  const no=await probeUpstream(endpoint);assert.equal(no.code,'ONEBOT_AUTH_FAILED');assert.match(no.error!,/WebUI/)
  assert.equal((await probeUpstream(endpoint,'fixture-token','123456')).ok,true)
  assert.equal((await probeUpstream(endpoint,'fixture-token','654321')).code,'SELF_ID_MISMATCH')
  for(const url of ['http://localhost','ws://','ws://u:p@localhost','ws://localhost/#x','ws://localhost/?access_token=secret'])assert.equal(isValidUpstreamEndpoint(url),false)
  await delay(50);assert.equal(active,0)
  const errors:any[]=[],offline:any[]=[];const connector=new ExternalOneBotConnector({endpoint,storyId:'a',selfId:'123456',retryIntervalMs:10},{} as any)
  connector.setLogger(()=>{});connector.setErrorListener((code,message)=>errors.push({code,message}));connector.setOfflineListener(()=>offline.push(1))
  const start=upgrades;connector.start();await delay(150);await connector.stop();assert.equal(upgrades-start,1);assert.equal(errors.length,1);assert.equal(errors[0].code,'ONEBOT_AUTH_FAILED');assert.equal(offline.length,0)
 }finally{for(const s of ws.clients)s.terminate();ws.close();await new Promise<void>(r=>server.close(()=>r()))}
})
test('Mixer inheritance deletes persisted overrides, including scaled timeout; other config survives',async()=>{
 const f=fixture();try{
  const file=path.join(f.root,'koishi.yml');writeFileSync(file,yaml.dump({plugins:{'hds-interlude:test':{model:{mainResponseFormat:'prompt-only',mainTimeout:50000,specializationAutoTrim:false,providers:[{enabled:true,useForMain:true,temperature:0.8,token:{$secret:'keep'}}]},runtime:{splitReplyMessages:true},unrelated:'keep'}}}))
  const ctx={stories:{get:()=>({dir:f.root,running:false})},config:{save:(_dir:string,source:string)=>writeFileSync(file,source)},broadcast:()=>{}} as any
  registerMixerIpc(ctx);const handlers=(globalThis as any).repairHandlers
  const write=handlers.get('stories:mixerWrite'),read=handlers.get('stories:mixerRead')
  const result=await write({},'a',{mainResponseFormat:null,mainTimeout:null,specializationAutoTrim:null,temperature:null,splitMessages:null})
  assert.equal(result.applied.length,5)
  const h=(yaml.load(readFileSync(file,'utf8')) as any).plugins['hds-interlude:test'];assert.equal(Object.hasOwn(h.model,'mainResponseFormat'),false);assert.equal(Object.hasOwn(h.model,'mainTimeout'),false);assert.equal(Object.hasOwn(h.model.providers[0],'temperature'),false);assert.equal(h.unrelated,'keep');assert.deepEqual(h.model.providers[0].token,{$secret:'keep'})
  const values=await read({},'a');assert.equal(values.find((p:any)=>p.key==='mainResponseFormat').value,undefined)
  await assert.rejects(write({},'a',{mainResponseFormat:'invalid'}));assert.equal((yaml.load(readFileSync(file,'utf8')) as any).plugins['hds-interlude:test'].unrelated,'keep')
 }finally{f.cleanup()}
})
test('account IPC keeps credentials in main, creates unique aliases, exposes status, and unbinds one identity',async()=>{
 const records:any[]=[{storyId:'a',selfId:'123456',nickname:'one',externalUpstream:{endpoint:'ws://127.0.0.1:3001/',tokenAlias:'saved'}},{storyId:'a',selfId:'654321',nickname:'two'}]
 const secret=new Map([['saved','old-fixture-token']]);let fail=false
 const registry={list:()=>records,listByStory:(id:string)=>records.filter(e=>e.storyId===id),findBySelfId:(id:string)=>records.find(e=>e.selfId===id),register:(storyId:string,selfId:string,nickname:string,externalUpstream:any)=>{if(fail)throw Error('fixture failure');const i=records.findIndex(e=>e.selfId===selfId);const e={storyId,selfId,nickname,externalUpstream};if(i>=0)records[i]=e;else records.push(e)},removeAccount:(_s:string,id:string)=>records.splice(records.findIndex(e=>e.selfId===id),1)}
 const ctx={stories:{get:()=>({running:false})},accountRegistry:registry,secrets:{get:(a:string)=>secret.get(a),set:(a:string,v:string)=>secret.set(a,v),has:(a:string)=>secret.has(a),remove:(a:string)=>secret.delete(a)},bindings:{bind:()=>{},unbind:()=>{},find:()=>({storyId:'a'}),list:()=>[]},onebot:{},externalConnectionStates:new Map(),externalAccountStates:new Map([['onebot:123456',{state:'configuration-error',code:'ONEBOT_AUTH_FAILED',error:'fixture auth'}]]),broadcast:()=>{},reconcileExternalConnector:async()=>{}} as any
 registerAccountsIpc(ctx);const handlers=(globalThis as any).repairHandlers,bind=handlers.get('accounts:bind')
 assert.equal(handlers.get('accounts:list')({})[0].externalCode,'ONEBOT_AUTH_FAILED')
 await bind({},'a','123456','one',{endpoint:'ws://127.0.0.1:3001',reuseSavedToken:true},'qq');assert.equal(records[0].externalUpstream.tokenAlias,'saved')
 await bind({},'a','123456','one',{endpoint:'ws://127.0.0.1:3001',tokenText:'new-fixture-token'},'qq');const alias=records[0].externalUpstream.tokenAlias;assert.notEqual(alias,'saved');assert.equal(secret.get(alias),'new-fixture-token');assert.ok(!JSON.stringify(handlers.get('accounts:list')({})).includes('new-fixture-token'))
 const count=secret.size;fail=true;await assert.rejects(bind({},'a','777777','bad',{endpoint:'ws://127.0.0.1:3001',tokenText:'failed-token'},'qq'));assert.equal(secret.size,count);fail=false
 await handlers.get('accounts:unbind')({},'a','654321');assert.equal(records.length,1);assert.equal(records[0].selfId,'123456')
})

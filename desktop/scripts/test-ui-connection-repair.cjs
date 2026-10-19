const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{pathToFileURL}=require('node:url')
const puppeteer=require(require.resolve('puppeteer-core',{paths:[process.cwd(),'C:/dev/HDS-Interlude']}))
const output=process.env.UI_TEST_SCREENSHOT_DIR||path.join(os.tmpdir(),'hdsi-ui-connection-repair');fs.mkdirSync(output,{recursive:true})
;(async()=>{
 const browser=await puppeteer.launch({executablePath:process.env.UI_TEST_BROWSER||'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true})
 try{
  const page=await browser.newPage(),errors=[],evidence=[];page.on('pageerror',e=>errors.push(e.message))
  await page.setViewport({width:1440,height:900})
  // Serve actual shipped theme JSON in file:// fixtures, where browser fetch is otherwise restricted.
  const rendererRoot=path.resolve(process.env.UI_TEST_DIST?'dist/renderer':'src/renderer')
  const themeRoot=path.join(rendererRoot,'themes/builtin')
  const themeDocs=Object.fromEntries(fs.readdirSync(themeRoot).filter(n=>n.endsWith('.json')).map(n=>[n,JSON.parse(fs.readFileSync(path.join(themeRoot,n),'utf8'))]))
  await page.evaluateOnNewDocument(docs=>{const original=globalThis.fetch;globalThis.fetch=(input,init)=>{const match=String(input?.url||input).match(/(?:^|\/)themes\/builtin\/([^/?#]+\.json)$/);return match&&Object.hasOwn(docs,match[1])?Promise.resolve(new Response(JSON.stringify(docs[match[1]]),{headers:{'Content-Type':'application/json'}})):original(input,init)}},themeDocs)
  await page.evaluateOnNewDocument(require('./fixtures/studio.cjs'));await page.evaluateOnNewDocument(require('./fixtures/ui-hierarchy.cjs'),[
   {key:'mainResponseFormat',section:'MODEL',label:'输出格式',desc:'select fixture',type:'select',options:['json-object','prompt-only'],value:'prompt-only'},
   {key:'temperature',section:'MODEL',label:'温度',desc:'number fixture',type:'knob',min:0,max:2,step:0.05,value:0.8},
   {key:'failoverEnabled',section:'MODEL',label:'故障转移',desc:'toggle fixture',type:'toggle',value:true}
  ])
  await page.evaluateOnNewDocument(()=>{
   globalThis.repairUI={probes:[],writes:[],unbound:[],accounts:[],held:false,snow:'installed'}
   const api=window.hdsiDesktop
   api.stories.mixerRead=async()=>[{key:'mainResponseFormat',section:'MODEL',label:'输出格式',desc:'select fixture',type:'select',options:['json-object','prompt-only'],value:'prompt-only'},{key:'temperature',section:'MODEL',label:'温度',desc:'number fixture',type:'knob',min:0,max:2,step:0.05,value:0.8},{key:'failoverEnabled',section:'MODEL',label:'故障转移',desc:'toggle fixture',type:'toggle',value:true}]
   api.connection.detect=async()=>({snowluma:repairUI.snow,snowlumaProcess:{status:'not-running'},snowlumaAccounts:[],snowlumaWebui:{port:5099}})
   api.connection.probeUpstream=async(endpoint,token,options)=>{repairUI.probes.push({endpoint,token,options});if(repairUI.held)return await new Promise(r=>repairUI.release=r);return {ok:true,selfId:options.selfId,latencyMs:1}}
   api.accounts.list=async()=>repairUI.accounts
   api.accounts.bind=async(...args)=>{if(repairUI.failSave)throw new Error("fixture save failed");repairUI.writes.push(args);if(repairUI.held)await new Promise(r=>repairUI.release=r)}
   api.accounts.unbind=async(...args)=>{repairUI.unbound.push(args)}
  })
  await page.goto(pathToFileURL(path.resolve(process.env.UI_TEST_DIST?'dist/renderer/index.html':'src/renderer/index.html')).href);await page.waitForSelector('.hud-scene-copy strong')
  const wait=()=>page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))))
  const capture=async n=>{await wait();await page.screenshot({path:path.join(output,n+'.png')})}
  const closedBorders=async(name,selector)=>{
   const rows=await page.$$eval(selector,ns=>ns.filter(n=>n.getClientRects().length).map(n=>{const s=getComputedStyle(n);return{cls:n.className,borders:['Top','Right','Bottom','Left'].map(edge=>({width:parseFloat(s['border'+edge+'Width']),style:s['border'+edge+'Style'],color:s['border'+edge+'Color']}))}}))
   assert.ok(rows.length,name+' exercised');for(const row of rows)for(const border of row.borders){assert.ok(border.width>0&&border.style!=='none'&&border.color!=='rgba(0, 0, 0, 0)',name+JSON.stringify(row))}evidence.push({name,rows})
  }
  await page.evaluate(async()=>{await setSurface('connect');await renderConnectView()})
  for(const width of [1440,1280,760,480]){
   await page.setViewport({width,height:900})
   for(const status of ['installed','running','not-found','unknown']){
    await page.evaluate(async status=>{repairUI.snow=status;await renderConnectView()},status)
    await closedBorders('connect '+status+' '+width,'.connect-card,.connect-config-card,.account-registry,.ready-panel')
    if(width===1440&&status==='installed')await capture('connect-border-warning')
   }
  }
  await page.setViewport({width:1440,height:900})
  await page.click('.connect-platform[data-channel="wechat"]');await page.click('#connect-open-wizard');assert.equal(await page.$eval('#wiz-channel',n=>n.value),'wechat');await page.click('#wiz-cancel')
  const accounts=[{uin:123456,hasToken:true,wsEndpoints:[{port:3001,path:'/'}]},{uin:'654321',hasToken:true,wsEndpoints:[{port:3002,path:'/onebot'}]}]
  await page.evaluate(accounts=>openAccountWizard(accounts,{selfId:'777777',channelKind:'qq',externalUpstream:{endpoint:'ws://127.0.0.1:3003/',tokenAlias:'saved'}}),accounts)
  assert.equal(await page.$eval('#wiz-uin',n=>n.value),'__manual');assert.equal(await page.$eval('#wiz-uin-manual',n=>n.value),'777777')
  await page.select('#wiz-uin','654321');assert.equal(await page.$eval('#wiz-endpoint',n=>n.value),'ws://127.0.0.1:3002/onebot')
  await page.select('#wiz-uin','__manual');await page.select('#wiz-channel','wechat');await page.select('#wiz-channel','qq');assert.equal(await page.$eval('#wiz-uin',n=>getComputedStyle(n).display),'block')
  await page.select('#wiz-uin','123456');assert.equal(await page.$eval('#wiz-uin-manual',n=>getComputedStyle(n).display),'none');await page.click('#wiz-cancel')
  await page.evaluate(accounts=>openAccountWizard(accounts,{selfId:'654321',channelKind:'qq',externalUpstream:{endpoint:'ws://127.0.0.1:3002/onebot',tokenAlias:'saved'}}),accounts)
  assert.equal(await page.$eval('#wiz-uin',n=>n.value),'654321');assert.match(await page.$eval('#wiz-token',n=>n.placeholder),/沿用/)
  await page.click('#wiz-probe-btn');await page.waitForFunction(()=>document.querySelector('#wiz-probe-result').classList.contains('probe-ok'))
  assert.equal(await page.evaluate(()=>repairUI.probes.at(-1).options.reuseSavedToken),true)
  await page.click('#wiz-local-token');await page.click('#wiz-probe-btn');await page.waitForFunction(()=>repairUI.probes.at(-1).options.useLocalToken);await page.waitForFunction(()=>!document.querySelector('#wiz-probe-btn').disabled)
  await page.evaluate(()=>{repairUI.held=true});await page.click('#wiz-probe-btn');await page.click('#wiz-probe-btn');assert.equal(await page.evaluate(()=>repairUI.probes.length),3)
  await page.$eval('#wiz-endpoint',n=>{n.value='ws://127.0.0.1:3999/';n.dispatchEvent(new Event('input',{bubbles:true}))});await page.evaluate(()=>{repairUI.release({ok:true,selfId:'654321',latencyMs:1});repairUI.held=false})
  await wait();assert.equal(await page.$eval('#wiz-probe-result',n=>n.textContent),'');assert.equal(await page.$eval('#wiz-reuse-token',n=>n.disabled),true)
  await capture('account-token-source')
  for(const width of [760,480]){
   await page.setViewport({width,height:600});await page.$eval('#wiz-bind',n=>n.scrollIntoView({block:'nearest'}));await wait()
   const bounds=await page.$eval('#account-wizard',n=>{const r=n.getBoundingClientRect(),b=n.querySelector('#wiz-bind').getBoundingClientRect();return{left:r.left,right:r.right,top:r.top,bottom:r.bottom,buttonTop:b.top,buttonBottom:b.bottom,overflow:n.scrollWidth>n.clientWidth+1}})
   assert.ok(bounds.left>=0&&bounds.right<=width+1&&bounds.top>=0&&bounds.bottom<=601,JSON.stringify(bounds));assert.ok(bounds.buttonTop>=0&&bounds.buttonBottom<=601,JSON.stringify(bounds));assert.equal(bounds.overflow,false);evidence.push({name:'account wizard reachable '+width,bounds});if(width===760)await capture('account-compact-scroll')
  }
  await page.setViewport({width:1440,height:900})
  await page.$eval('#wiz-endpoint',n=>{n.value='';n.dispatchEvent(new Event('input',{bubbles:true}))});await page.click('#wiz-bind');assert.equal(await page.evaluate(()=>repairUI.writes.length),0);assert.equal(await page.$eval('#account-wizard',n=>n.open),true)
  await page.click('#wiz-cancel')
  await page.evaluate(accounts=>openAccountWizard(accounts),accounts);await page.evaluate(()=>{repairUI.held=true});await page.click('#wiz-bind');await page.click('#wiz-bind');assert.equal(await page.evaluate(()=>repairUI.writes.length),1);await page.evaluate(()=>{repairUI.release();repairUI.held=false});await page.waitForFunction(()=>!document.querySelector('#account-wizard'))
  // Saving while an old probe is pending must not leave the probe disabled after a failed save.
  await page.evaluate(accounts=>openAccountWizard(accounts),accounts);await page.evaluate(()=>{repairUI.held=true;repairUI.failSave=true});await page.click('#wiz-probe-btn');await page.click('#wiz-bind');await page.waitForFunction(()=>!document.querySelector('#wiz-bind').disabled);assert.equal(await page.$eval('#wiz-probe-btn',n=>n.disabled),false)
  const notification=await page.$eval('#account-wizard',n=>{const toast=n.querySelector('.toast'),t=toast.getBoundingClientRect(),buttons=n.querySelector('.wiz-actions').getBoundingClientRect();return{pointerEvents:getComputedStyle(toast).pointerEvents,top:t.top,actionsBottom:buttons.bottom}});assert.equal(notification.pointerEvents,'none');assert.ok(notification.top>=notification.actionsBottom,JSON.stringify(notification));evidence.push({name:'failure notification does not obscure actions',notification});await capture('account-failed-save-recovery')
  await page.evaluate(()=>{repairUI.release({ok:true,selfId:'123456',latencyMs:1});repairUI.held=false;repairUI.failSave=false});await wait();assert.equal(await page.$eval('#wiz-probe-result',n=>n.textContent),'');await page.click('#wiz-cancel')
  await page.evaluate(async()=>{repairUI.accounts=[{storyId:'fixture',selfId:'123456',nickname:'first',externalState:'online'},{storyId:'fixture',selfId:'654321',nickname:'second',externalState:'configuration-error',externalCode:'ONEBOT_AUTH_FAILED',externalUpstream:{endpoint:'ws://127.0.0.1:3002/',tokenAlias:'saved'}}];await renderConnectView()})
  await page.click('[data-self-id="654321"] [data-acct-action="edit"]');await capture('multi-account-edit');assert.equal(await page.$eval('#wiz-uin-manual',n=>n.value),'654321');await page.click('#wiz-cancel')
  await page.click('[data-self-id="654321"] [data-acct-action="unbind"]');await page.waitForFunction(()=>repairUI.unbound.length===1);assert.deepEqual(await page.evaluate(()=>repairUI.unbound[0]),['fixture','654321'])
  await page.evaluate(()=>{setSurface('studio');setStudioView('mixer')});await page.waitForSelector('[data-mixer-section="模型与费用"]');await page.click('[data-mixer-section="模型与费用"]');await page.waitForSelector('.mixer-select')
  const select='[data-param-key="mainResponseFormat"] .mixer-select'
  await page.focus(select);await page.evaluate(()=>globalThis.originalMixerSelect=document.querySelector('[data-param-key="mainResponseFormat"] .mixer-select'));await page.keyboard.press('ArrowUp');await page.keyboard.press('ArrowUp');await page.keyboard.press('Enter')
  assert.equal(await page.evaluate(()=>document.activeElement===originalMixerSelect&&originalMixerSelect.isConnected),true)
  await page.select(select,'');assert.equal(await page.evaluate(()=>mixerDraft('fixture').pending.mainResponseFormat),null)
  const number='[data-param-key="temperature"] .mixer-number';await page.$eval(number,n=>{n.focus();n.value='';n.dispatchEvent(new Event('change',{bubbles:true}))});assert.equal(await page.evaluate(()=>mixerDraft('fixture').pending.temperature),null);assert.equal(await page.$eval(number,n=>document.activeElement===n),true)
  const toggle='[data-param-key="failoverEnabled"] .mixer-toggle';await page.click(toggle);assert.equal(await page.$eval(toggle,n=>n.textContent),'OFF');await page.click(toggle);assert.equal(await page.$eval(toggle,n=>n.textContent),'继承');assert.equal(await page.evaluate(()=>mixerDraft('fixture').pending.failoverEnabled),null)
  await capture('mixer-inheritance-focus');await page.evaluate(()=>flushMixer('fixture'));assert.equal(await page.$$eval('.pending-state',ns=>ns.length),0)
  await page.evaluate(()=>{setStudioView('overview');choosePanel('inspector',true)})
  const grid=await page.$$eval('.inspect-grid',ns=>ns.map(n=>({border:getComputedStyle(n).borderTopWidth,gap:getComputedStyle(n).gap,background:getComputedStyle(n).backgroundColor,line:getComputedStyle(n).borderTopColor,children:[...n.children].map(c=>getComputedStyle(c).borderWidth)})));assert.ok(grid.length);for(const row of grid){assert.equal(row.border,'1px');assert.equal(row.gap,'1px');assert.equal(row.background,row.line);assert.ok(row.children.every(v=>v==='0px'))}evidence.push({name:'inspector single-owner seams',grid});await capture('inspector-single-seams')
  const layout='details.layout-menu:not(#more-menu)';await page.focus(layout+' summary');await page.keyboard.press('ArrowDown');await wait();assert.equal(await page.$eval(layout,n=>n.open&&n.contains(document.activeElement)&&document.activeElement.tagName==='BUTTON'),true);await page.keyboard.press('Escape');assert.equal(await page.$eval(layout,n=>!n.open&&document.activeElement===n.querySelector('summary')),true)
  const themes=await page.evaluate(async()=>{await HDSIThemeV3.loadCompatIndex();const list=HDSIThemeV3.list();return ['default',...list.official.map(t=>t.id),...list.compat.map(t=>t.id)]})
  for(const theme of themes){
   assert.equal(await page.evaluate(id=>HDSIThemeV3.apply(id),theme),true,theme+' applied')
   await page.evaluate(async()=>{repairUI.snow='installed';await setSurface('connect');await renderConnectView()});await wait()
   await closedBorders('theme '+theme,'.connect-card,.connect-config-card,.account-registry,.ready-panel')
   await page.evaluate(()=>{setSurface('studio');setStudioView('overview');choosePanel('inspector',true)});await wait()
   const seams=await page.$$eval('.inspect-grid',ns=>ns.map(n=>({gap:getComputedStyle(n).gap,border:getComputedStyle(n).borderTopWidth,background:getComputedStyle(n).backgroundColor,line:getComputedStyle(n).borderTopColor,children:[...n.children].map(c=>getComputedStyle(c).borderWidth)})))
   assert.ok(seams.length,theme+' inspector');for(const row of seams){assert.equal(row.gap,'1px',theme);assert.equal(row.border,'1px',theme);assert.equal(row.background,row.line,theme);assert.ok(row.children.every(v=>v==='0px'),theme)}
  }
  await page.evaluate(()=>HDSIThemeV3.reset());evidence.push({name:'shipped theme frame/seam sweep',themes})
  assert.deepEqual(errors,[]);fs.writeFileSync(path.join(output,'repair-evidence.json'),JSON.stringify(evidence,null,2));console.log('PASS: all SnowLuma card states x 4 widths, platform/account dropdowns, saved/local credentials, stale probes, duplicate saves, exact multi-account actions, keyboard focus, failed-save recovery, persisted inheritance, compact dialogs and all 22 shipped theme/frame combinations. '+output)
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1})

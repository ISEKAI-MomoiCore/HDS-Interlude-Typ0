const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os')
const {pathToFileURL}=require('node:url')
const puppeteer=require(require.resolve('puppeteer-core',{paths:[process.cwd(),'C:/dev/HDS-Interlude']}))
const output=process.env.UI_TEST_SCREENSHOT_DIR||path.join(os.tmpdir(),'hdsi-ui-refinement');fs.mkdirSync(output,{recursive:true})
;(async()=>{
 const browser=await puppeteer.launch({executablePath:process.env.UI_TEST_BROWSER||'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true})
 try {
  const page=await browser.newPage(),errors=[],metrics=[]
  page.on('pageerror',e=>errors.push(e.message))
  await page.setViewport({width:1440,height:900})
  await page.evaluateOnNewDocument(require('./fixtures/studio.cjs'))
  await page.evaluateOnNewDocument(require('./fixtures/ui-hierarchy.cjs'),[])
  await page.evaluateOnNewDocument(require('./fixtures/ui-refinement.cjs'))
  await page.goto(pathToFileURL(path.resolve(process.env.UI_TEST_DIST?'dist/renderer/index.html':'src/renderer/index.html')).href)
  await page.waitForSelector('.hud-scene-copy strong')
  const cdp=await page.createCDPSession();await cdp.send('DOM.enable');await cdp.send('CSS.enable')
  const {root}=await cdp.send('DOM.getDocument');const fonts=[]
  for(const selector of ['.workspace-header strong','.hud-scene-copy em','.hud-item-body strong']) {
   const {nodeId}=await cdp.send('DOM.querySelector',{nodeId:root.nodeId,selector})
   fonts.push({selector,computed:await page.$eval(selector,n=>getComputedStyle(n).font),actual:await cdp.send('CSS.getPlatformFontsForNode',{nodeId})})
  }
  assert.match(fonts[0].computed,/Yu Gothic/);assert.match(fonts[1].computed,/Noto Sans SC/)
  fs.writeFileSync(path.join(output,'font-evidence.json'),JSON.stringify(fonts,null,2));await cdp.detach()
  const settle=()=>page.evaluate(async()=>{await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));await Promise.all(document.getAnimations().filter(a=>a.playState==='running'&&a.effect?.getComputedTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})))})
  const capture=async name=>{await settle();await page.screenshot({path:path.join(output,name+'.png')})}
  const dock=n=>`#workbench-dock [data-panel-toggle="${n}"]`
  const expanded=async n=>page.$eval(dock(n),n=>n.getAttribute('aria-expanded'))
  for(const n of ['inspector','detail']) {
   assert.equal(await expanded(n),'false');await page.click(dock(n));assert.equal(await expanded(n),'true')
   await page.click(dock(n));assert.equal(await expanded(n),'false');await page.click(dock(n));assert.equal(await expanded(n),'true')
  }
  await capture('workbench-expanded-1440')
  const before=await page.$eval('#detail-panel',n=>n.getBoundingClientRect().height)
  const handle=await page.$('#handle-detail'),box=await handle.boundingBox()
  assert.ok(box&&box.width>10,'visible resize handle')
  await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();await page.mouse.move(box.x+box.width/2,box.y-55,{steps:6});await page.mouse.up()
  assert.ok(await page.$eval('#detail-panel',n=>n.getBoundingClientRect().height)>before+30,'pointer resize')
  await page.reload();await page.waitForSelector('.hud-scene-copy strong')
  assert.equal(await expanded('inspector'),'true');assert.equal(await expanded('detail'),'true')
  await page.evaluate(()=>setStudioView('timeline'))
  assert.equal(await expanded('inspector'),'true');assert.equal(await expanded('detail'),'true')
  await page.evaluate(()=>setStudioView('session'));assert.equal(await expanded('inspector'),'false')
  await page.evaluate(()=>setStudioView('overview'));assert.equal(await expanded('inspector'),'true')
  for(const [width,height] of [[760,600],[760,500]]) {
   await page.setViewport({width,height});await settle()
   // Overlay visibility is different from the persistent layout preference.
   if(await expanded('inspector')==='true') await page.click(dock('inspector'))
   await page.click(dock('inspector'));await settle();assert.equal(await expanded('inspector'),'true')
   await page.click('#workbench-dock .dock-label');await settle();assert.equal(await expanded('inspector'),'false')
   await page.click(dock('inspector'));await settle();assert.equal(await expanded('inspector'),'true')
   await capture(`workbench-expanded-${width}-${height}`)
   await page.click(dock('inspector'));assert.equal(await expanded('inspector'),'false')
   const bounds=await page.evaluate(()=>({shell:document.querySelector('.studio-shell').getBoundingClientRect().bottom,dock:byId('workbench-dock').getBoundingClientRect().bottom,detail:byId('detail-panel').getBoundingClientRect().bottom,h:innerHeight,overflow:document.documentElement.scrollWidth>innerWidth+1}))
   assert.ok(bounds.dock<=height+1&&bounds.detail<=bounds.shell+1,JSON.stringify(bounds));assert.equal(bounds.overflow,false)
  }
  await page.evaluate(()=>HDSIWorkspaceProfile.apply('v7'));assert.equal(await page.$eval('#workbench-dock',n=>getComputedStyle(n).display),'none')
  await page.evaluate(()=>HDSIWorkspaceProfile.apply('v4'))
  await page.evaluate(()=>{taskPanelOverrides.clear();setStudioView('overview');applyPanelLayout();persist()})
  const open=async()=>{await page.evaluate(()=>openConfig('fixture'));await page.waitForFunction(()=>configSectionsReady&&!configSaving)}
  const tab=async name=>{await page.click(`[data-config-tab="${name}"]`);await settle()}
  const input=async(selector,value)=>page.$eval(selector,(n,v)=>{n.value=v;n.dispatchEvent(new Event('input',{bubbles:true}))},value)
  const close=async()=>page.evaluate(()=>requestCloseConfigDialog())
  const writes=()=>page.evaluate(()=>refinement.writes.map(w=>w.section))
  const reset=()=>page.evaluate(()=>refinement.writes=[])
  for(const [width,height] of [[1440,900],[1280,768],[760,600],[480,500],[360,560]]) {
   await page.setViewport({width,height});await open()
   let anchor
   for(const name of ['story','users','groups','bots','providers','secrets','plugins','yaml']) {
    await tab(name)
    const m=await page.evaluate(()=>{
     const b=document.querySelector('.config-body'),d=byId('config-dialog').getBoundingClientRect(),f=document.querySelector('#config-form > footer').getBoundingClientRect(),header=document.querySelector('#config-form > header').getBoundingClientRect()
     const visible=[...document.querySelectorAll('#config-form > footer button')].filter(n=>!n.hidden)
     return {tab:document.querySelector('.config-tab-panel.active').dataset.configPanel,width:innerWidth,height:innerHeight,left:d.left,right:d.right,top:d.top,bottom:d.bottom,footer:f.top,footerBottom:f.bottom,header:header.top,bodyHeight:b.clientHeight,overflow:b.scrollWidth>b.clientWidth+1,reachable:visible.every(n=>{const r=n.getBoundingClientRect();return r.left>=d.left&&r.right<=d.right+1&&r.bottom<=innerHeight})}
    })
    assert.ok(m.top>=0&&m.left>=0&&m.right<=width+1&&m.bottom<=height+1,JSON.stringify(m));assert.equal(m.overflow,false,JSON.stringify(m));assert.ok(m.reachable&&m.bodyHeight>80,JSON.stringify(m))
    if(anchor) assert.ok(Math.abs(m.footerBottom-anchor.footerBottom)<1&&Math.abs(m.header-anchor.header)<1,'stable dialog frame')
    anchor=m;metrics.push(m)
    if(['users','groups','bots','providers'].includes(name)) {
     const fields=await page.$$eval('.config-tab-panel.active .cfg-card-header input,.config-tab-panel.active .cfg-card-header select',nodes=>nodes.map(n=>({l:n.closest('label')?.querySelector('span')?.textContent,w:n.clientWidth})))
     assert.ok(fields.length&&fields.every(n=>n.l),'persistent identity labels')
     if(name==='providers') assert.ok(fields[1].w>200,'provider mode never truncated')
    }
    if(width===1440||width===760) await capture(`config-${name}-${width}`)
    if(['users','groups','providers','plugins'].includes(name)) {
     await page.click('.config-tab-panel.active .cfg-expand-toggle')
     assert.equal(await page.$eval('.config-body',n=>n.scrollWidth>n.clientWidth+1),false,'expanded '+name+' width '+width)
     if(width===1440||width===760) await capture(`config-${name}-expanded-${width}`)
    }
   }
   await tab('users');await page.focus('[data-config-tab="users"]');await page.keyboard.press('ArrowRight');assert.equal(await page.$eval('[data-config-tab="groups"]',n=>n.getAttribute('aria-selected')),'true')
   await close()
  }
  await page.setViewport({width:1440,height:900});await open();await tab('users')
  await input('#cfg-users-list [data-row="label"]','保留已编辑的称呼')
  await page.click('[data-add-row="userAccounts"]')
  assert.equal(await page.$$eval('#cfg-users-list .cfg-card',n=>n.length),2)
  assert.equal(await page.$eval('#cfg-users-list .cfg-card:last-child [data-row="label"]',n=>n.value),'保留已编辑的称呼')
  await page.click('#cfg-users-list .cfg-card:first-child .cfg-del');await page.click('#cfg-users-list .cfg-card:first-child .cfg-del')
  assert.equal(await page.$$eval('#cfg-users-list .cfg-card',n=>n.length),1)
  const toggle='#cfg-users-list .cfg-toggle-mini';await page.focus(toggle);const checked=await page.$eval(toggle,n=>n.getAttribute('aria-checked'));await page.keyboard.press('Space');assert.notEqual(await page.$eval(toggle,n=>n.getAttribute('aria-checked')),checked)
  await reset();await page.click('#config-save-all');await page.waitForFunction(()=>!configSaving)
  assert.deepEqual(await writes(),['userAccounts'],'save-all commits dirty sections only')
  await close();await open()
  await tab('story');await input('[data-cfg="characterName"]','第三轮人物')
  await tab('groups');await input('#cfg-groups-list [data-row="label"]','第三轮群')
  await reset();await page.click('#config-save');await page.waitForFunction(()=>!configSaving)
  assert.deepEqual(await writes(),['groupChats']);assert.deepEqual(await page.evaluate(()=>[...configDirtyPanels]),['story'])
  await tab('yaml');await input('#config-source','storyDefaults:\n  characterName: YAML draft\n')
  await reset();await page.click('#config-save-all');await page.waitForFunction(()=>!configSaving)
  assert.deepEqual(await writes(),[],'mixed YAML/forms never silently overwrite')
  assert.match(await page.$eval('#config-status',n=>n.textContent),/尚未保存/)
  await close();await open();await tab('story');await input('[data-cfg="characterName"]','部分失败测试')
  await tab('groups');await input('#cfg-groups-list [data-row="label"]','失败时保留')
  await page.evaluate(()=>{refinement.fail='groupChats';refinement.writes=[]})
  await page.click('#config-save-all');await page.waitForFunction(()=>!configSaving)
  assert.deepEqual(await writes(),['storyDefaults','groupChats']);assert.deepEqual(await page.evaluate(()=>[...configDirtyPanels]),['groups'])
  assert.match(await page.$eval('#config-status',n=>n.textContent),/保存失败/)
  await page.evaluate(()=>{refinement.fail='';refinement.hold=true;refinement.writes=[]})
  await page.click('#config-save-all');await page.waitForFunction(()=>!!refinement.release)
  await page.evaluate(()=>{byId('config-save-all').click();byId('config-save').click();requestCloseConfigDialog()})
  assert.deepEqual(await writes(),['groupChats']);assert.equal(await page.$eval('#config-dialog',n=>n.open),true)
  assert.equal(await page.$eval('.config-body',n=>n.inert),true)
  await page.evaluate(()=>{refinement.hold=false;refinement.release()});await page.waitForFunction(()=>!configSaving)
  assert.deepEqual(await page.evaluate(()=>[...configDirtyPanels]),[])
  await tab('secrets');assert.equal(await page.$eval('#config-save',n=>n.hidden),true);assert.equal(await page.$eval('#config-save-all',n=>n.hidden),true)
  await input('#secret-alias','round3-test');await input('#secret-value','fixture-not-a-real-key');await reset();await page.click('#save-secret');await page.waitForFunction(()=>refinement.writes.length>0)
  assert.deepEqual(await writes(),['secret']);assert.match(await page.$eval('#config-save-scope',n=>n.textContent),/立即保存/)
  await tab('plugins');assert.equal(await page.$eval('#config-save',n=>n.hidden),true)
  await reset();await page.click('[data-plugin-toggle]');await page.waitForFunction(()=>refinement.writes.length>0);assert.deepEqual(await writes(),['plugin'])
  await close()
  for(const mode of ['unsupported','error','empty']) {
   await page.evaluate(mode=>{refinement.analysis=mode;analysisState={data:null,loading:false,lastStoryId:''};setStudioView('overview');setStudioView('analysis')},mode)
   await page.waitForSelector('#arrangement .ui-state')
   assert.equal(await page.$eval('#arrangement .ui-state',n=>n.dataset.state),mode)
   await capture(`analysis-${mode}`)
   if(mode==='error') {await page.evaluate(()=>refinement.analysis='empty');await page.click('#arrangement .ui-state button');await page.waitForFunction(()=>document.querySelector('#arrangement .ui-state')?.dataset.state==='empty')}
  }
  await page.evaluate(()=>{selectedStory().running=false;renderArrangement()});await page.waitForSelector('#arrangement [data-state="idle"]');await capture('analysis-idle');await page.evaluate(()=>selectedStory().running=true)
  // An older analysis response must not replace an offline state or strand loading.
  await page.evaluate(()=>{desktop.stories.semanticAnalysis=()=>new Promise(resolve=>refinement.resolveAnalysis=resolve);refreshSemanticAnalysis()})
  await page.waitForFunction(()=>!!refinement.resolveAnalysis)
  await page.evaluate(()=>{selectedStory().running=false;renderArrangement();refinement.resolveAnalysis({})})
  await page.waitForSelector('#arrangement [data-state="idle"]')
  assert.equal(await page.evaluate(()=>analysisState.loading),false)
  await page.evaluate(()=>selectedStory().running=true)
  await page.evaluate(async()=>{setSurface('logs');desktop.logs.query=async()=>[];await hydrateLogs()})
  await page.waitForFunction(()=>byId('logs-vlist').textContent.includes('还没有日志记录'));await capture('logs-empty')
  await input('#log-search','不存在的关键词');await page.evaluate(()=>applyLogFilters());await page.waitForFunction(()=>byId('logs-vlist').textContent.includes('没有匹配的日志'));await capture('logs-no-match')
  await page.click('#logs-vlist .ui-state button');await page.waitForFunction(()=>byId('log-search').value==='')
  await page.evaluate(()=>{appendLogRecord({id:'round3-new',storyId:'fixture',source:'worker',level:'info',at:new Date().toISOString(),message:'新的日志正常出现'},true);renderLogs()})
  assert.equal(await page.$('#logs-vlist .ui-state'),null);assert.equal(await page.$$eval('#logs-vlist .log-row',n=>n.length),1)
  await page.evaluate(()=>{setSurface('studio');setStudioView('stats')});await page.waitForSelector('.stats-view')
  await page.evaluate(async()=>{desktop.stories.timelineRange=async()=>({entries:[]});statsWindowCache.at=0;state.usageSeries=[{day:'2026-10-19'}];state.hostOverview={usage:{calls:1}};byId('arrangement').replaceChildren();await renderStatsView(byId('arrangement'),selectedStory())})
  const stats=await page.$$eval('.stats-card',nodes=>nodes.map(n=>({label:n.querySelector('.stats-card-label').textContent,value:n.querySelector('.stats-card-value')?.textContent,sub:n.querySelector('.stats-card-sub')?.textContent})))
  assert.equal(stats.find(n=>n.label==='模型每次消费').value,'—');assert.match(stats.find(n=>n.label==='每日平均消费').sub,/不可用/);await capture('stats-missing')
  await page.evaluate(async()=>{state.hostOverview={usage:{calls:1,estimatedCost:0}};state.usageSeries=[{day:'2026-10-19',estimatedCost:0}];byId('arrangement').replaceChildren();await renderStatsView(byId('arrangement'),selectedStory())})
  assert.match(await page.$eval('.stats-view',n=>n.textContent),/¥0\.0000/);await capture('stats-zero')
  assert.deepEqual(errors,[])
  fs.writeFileSync(path.join(output,'refinement-measurements.json'),JSON.stringify(metrics,null,2))
  console.log('Round 3 PASS: persistent dock, pointer resize, compact overlays, fixed 8-tab config at 5 sizes, persistent labels, keyboard, scoped/partial/busy/conflict saves, immediate actions, Analysis/Logs/Stats states.');console.log(output)
 } finally {await browser.close()}
})().catch(error=>{console.error(error);process.exitCode=1})


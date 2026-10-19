// Final panel-seam regression: isolated renderer only; never starts a Worker.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os')
const {pathToFileURL}=require('node:url')
const puppeteer=require(require.resolve('puppeteer-core',{paths:[process.cwd(),'C:/dev/HDS-Interlude']}))
const output=process.env.UI_TEST_SCREENSHOT_DIR||path.join(os.tmpdir(),'hdsi-panel-polish');fs.mkdirSync(output,{recursive:true})
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
  const settle=()=>page.evaluate(async()=>{await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));await Promise.all(document.getAnimations().filter(a=>a.playState==='running'&&a.effect?.getComputedTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})))})
  const toggle=async n=>{await page.click(`#workbench-dock [data-panel-toggle="${n}"]`);await settle()}
  const ensure=async(n,on)=>{if(await page.$eval(`#workbench-dock [data-panel-toggle="${n}"]`,n=>n.getAttribute('aria-expanded'))!==String(on))await toggle(n)}
  const capture=async name=>{await settle();await page.screenshot({path:path.join(output,name+'.png')})}
  const measure=()=>page.evaluate(()=>{
   const box=n=>{const r=n.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom}}
   const w=document.querySelector('.workspace-panel'),s=getComputedStyle(w),surface=w.querySelector('.surface.active')
   const header=n=>{const p=document.querySelector(n),h=p.querySelector('.panel-header');return {box:box(h),padding:getComputedStyle(h).paddingLeft,overflow:h.scrollWidth>h.clientWidth+1,border:getComputedStyle(p).borderLeftWidth,rightBorder:getComputedStyle(p).borderRightWidth}}
   return {width:innerWidth,height:innerHeight,overflow:document.documentElement.scrollWidth>innerWidth+1,workspace:box(w),surface:box(surface),padding:[s.paddingLeft,s.paddingRight,s.paddingBottom],browser:header('.browser-panel'),inspector:header('.inspector-panel'),detail:{...box(byId('detail-panel')),border:getComputedStyle(byId('detail-panel')).borderTopWidth},dock:box(byId('workbench-dock')),handles:['browser','inspector','detail'].map(id=>{const n=byId('handle-'+id),s=getComputedStyle(n),g=getComputedStyle(n,'::after');return {id,visible:s.display!=='none',box:box(n),background:s.backgroundColor,grip:g.content}})}
  })
  await ensure('inspector',true);await ensure('detail',true)
  for(const [width,height] of [[1440,900],[1280,768],[1024,768],[860,600],[760,500]]) {
   await page.setViewport({width,height});await settle()
   for(const view of ['overview','session','timeline','mixer','stats','analysis']) {
    await page.evaluate(view=>setStudioView(view),view)
    await ensure('browser',width>860);await ensure('inspector',width>1120);await ensure('detail',true)
    const m=await measure();m.view=view;metrics.push(m)
    assert.equal(m.overflow,false,JSON.stringify(m))
    assert.ok(m.dock.bottom<=height+1&&m.detail.bottom<=m.dock.y+1,JSON.stringify(m))
    assert.deepEqual(m.padding,[width>860?'6px':'0px',width>1120?'6px':'0px','6px'])
    assert.ok(m.surface.bottom<=m.workspace.bottom-5,JSON.stringify(m))
    assert.equal(m.browser.rightBorder,'1px');assert.equal(m.inspector.border,'1px');assert.equal(m.detail.border,'1px')
    assert.equal(m.handles[0].visible,width>860);assert.equal(m.handles[1].visible,width>1120)
    assert.equal(m.handles[2].visible,true);assert.notEqual(m.handles[2].background,'rgba(0, 0, 0, 0)');assert.equal(m.handles[2].grip,'""')
    if(width>860)assert.equal(m.browser.overflow,false)
    if(width>1120){assert.equal(m.inspector.overflow,false);assert.equal(m.browser.box.height,56);assert.equal(m.inspector.box.height,56)}
    if(view==='overview'||width===1440)await capture(`${view}-${width}`)
   }
  }
  await page.setViewport({width:1440,height:900});await page.evaluate(()=>setStudioView('overview'));await ensure('browser',true);await ensure('inspector',true)
  // All eight collapsed combinations must reclaim the rail, not leave ghost gaps.
  for(const b of [true,false])for(const i of [true,false])for(const d of [true,false]){
   await ensure('browser',b);await ensure('inspector',i);await ensure('detail',d)
   const m=await measure();metrics.push({...m,collapsedCombination:{b,i,d}})
   assert.deepEqual(m.padding,[b?'6px':'0px',i?'6px':'0px',d?'6px':'0px'])
   assert.deepEqual(m.handles.map(h=>h.visible),[b,i,d]);assert.equal(m.overflow,false)
  }
  for(const n of ['browser','inspector','detail'])await ensure(n,true)
  // Drag both vertical rails to their minimum: title and close control stay usable.
  for(const [name,dx] of [['browser',-300],['inspector',300]]) {
   const r=await (await page.$('#handle-'+name)).boundingBox()
   await page.mouse.move(r.x+3,r.y+r.height/2);await page.mouse.down();await page.mouse.move(r.x+3+dx,r.y+r.height/2,{steps:8});await page.mouse.up();await settle()
  }
  const narrow=await measure();metrics.push({...narrow,minimumWidths:true});assert.equal(narrow.browser.overflow,false);assert.equal(narrow.inspector.overflow,false)
  assert.equal(await page.$eval('#inspector-kind',n=>getComputedStyle(n).display),'none')
  assert.equal(await page.$eval('.browser-item small',n=>getComputedStyle(n).display),'none')
  await capture('minimum-sidebars-1440')
  // Restore clean fixture dimensions for the delivery screenshot.
  await page.evaluate(()=>{const l=layoutFor();l.panelWidths={browser:214,inspector:264};l.panelHeights={detail:174};applyPanelLayout()});await capture('overview-final-1440')
  for(const width of [1024,760]){
   await page.setViewport({width,height:600});await settle();await ensure('inspector',true)
   const m=await measure();assert.ok(m.inspector.box.right<=width+1);await capture(`overlay-${width}`)
   await page.click('#workbench-dock .dock-label');await settle();await ensure('inspector',true);await ensure('inspector',false)
   if(width===760){await ensure('browser',true);await capture('browser-overlay-760');await ensure('browser',false)}
  }
  await page.evaluate(()=>HDSIWorkspaceProfile.apply('v7'));await settle()
  assert.equal(await page.$eval('.workspace-panel',n=>getComputedStyle(n).padding),'0px')
  assert.equal(await page.$eval('#workbench-dock',n=>getComputedStyle(n).display),'none');await capture('v7-unchanged')
  assert.deepEqual(errors,[])
  fs.writeFileSync(path.join(output,'panel-measurements.json'),JSON.stringify(metrics,null,2))
  console.log('Panel polish PASS: 30 page/size checks, 8 collapse combinations, reserved rails, minimum widths, pointer resize, overlays and V7 isolation.');console.log(output)
 } finally {await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1})

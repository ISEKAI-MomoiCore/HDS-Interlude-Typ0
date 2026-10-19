// Content-to-border spacing checks; all data comes from isolated browser fixtures.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os')
const {pathToFileURL}=require('node:url')
const puppeteer=require(require.resolve('puppeteer-core',{paths:[process.cwd(),'C:/dev/HDS-Interlude']}))
const ts=require('typescript'),catalogSource=ts.createSourceFile('mixer.ts',fs.readFileSync('src/main/ipc/mixer.ts','utf8'),ts.ScriptTarget.Latest,true)
let catalogNode;function find(n){if(ts.isVariableDeclaration(n)&&n.name.getText(catalogSource)==='MIXER_PARAMS')catalogNode=n.initializer;ts.forEachChild(n,find)}find(catalogSource)
const literal=n=>ts.isStringLiteral(n)?n.text:ts.isNumericLiteral(n)?Number(n.text):n.kind===ts.SyntaxKind.TrueKeyword?true:ts.isArrayLiteralExpression(n)?n.elements.map(literal):undefined
const keys=new Set(['key','section','label','desc','type','min','max','step','hot','options'])
const catalog=catalogNode.elements.map(n=>Object.fromEntries(n.properties.filter(p=>keys.has(p.name?.getText(catalogSource))).map(p=>[p.name.getText(catalogSource),literal(p.initializer)])))
const output=process.env.UI_TEST_SCREENSHOT_DIR||path.join(os.tmpdir(),'hdsi-ui-spacing');fs.mkdirSync(output,{recursive:true})
const baseline=!!process.env.UI_SPACING_BASELINE
;(async()=>{
 const browser=await puppeteer.launch({executablePath:process.env.UI_TEST_BROWSER||'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true})
 try {
  const page=await browser.newPage(),errors=[],metrics=[];page.on('pageerror',e=>errors.push(e.message))
  await page.setViewport({width:1440,height:900})
  await page.evaluateOnNewDocument(require('./fixtures/studio.cjs'));await page.evaluateOnNewDocument(require('./fixtures/ui-hierarchy.cjs'),catalog);await page.evaluateOnNewDocument(require('./fixtures/ui-refinement.cjs'))
  await page.goto(pathToFileURL(path.resolve(process.env.UI_TEST_DIST?'dist/renderer/index.html':'src/renderer/index.html')).href);await page.waitForSelector('.hud-scene-copy strong')
  if(baseline)await page.evaluate(()=>{for(const s of document.styleSheets)if(s.href?.endsWith('/ui-spacing.css'))s.disabled=true})
  const settle=()=>page.evaluate(async()=>{await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));await Promise.all(document.getAnimations().filter(a=>a.playState==='running'&&a.effect?.getComputedTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})))})
  const capture=async name=>{await settle();await page.screenshot({path:path.join(output,name+'.png')})}
  const measure=async(name,selector,min)=>{
   const items=await page.$$eval(selector,nodes=>nodes.filter(n=>n.getClientRects().length&&!n.hidden).map(n=>{
    const s=getComputedStyle(n),r=n.getBoundingClientRect(),padding=[s.paddingTop,s.paddingRight,s.paddingBottom,s.paddingLeft].map(parseFloat)
    const walker=document.createTreeWalker(n,NodeFilter.SHOW_TEXT),rects=[];let t
    while(t=walker.nextNode()){const a=t.textContent.search(/\S/),b=t.textContent.trimEnd().length;if(a<0)continue;const range=document.createRange();range.setStart(t,a);range.setEnd(t,b);rects.push(...range.getClientRects())}
    const gap=rects.length?[Math.min(...rects.map(t=>t.top-r.top-parseFloat(s.borderTopWidth))),Math.min(...rects.map(t=>r.right-t.right-parseFloat(s.borderRightWidth))),Math.min(...rects.map(t=>r.bottom-t.bottom-parseFloat(s.borderBottomWidth))),Math.min(...rects.map(t=>t.left-r.left-parseFloat(s.borderLeftWidth)))]:null
    return {id:n.id,tag:n.tagName,cls:n.className,text:(n.innerText||n.value||'').slice(0,80),padding,gap,width:r.width,height:r.height,scrollOverflow:n.scrollWidth>n.clientWidth+1}
   }))
   metrics.push({name,selector,items})
   if(!baseline&&min){assert.ok(items.length,name+' is exercised');for(const item of items){assert.ok(item.padding[0]>=min[0]&&item.padding[3]>=min[1],name+JSON.stringify(item));if(item.tag==='BUTTON'&&item.gap)assert.ok(item.gap.every(v=>v>=5.5),name+' text clearance '+JSON.stringify(item))}}
   return items
  }
  const ensure=async(n,on)=>{const s=`#workbench-dock [data-panel-toggle="${n}"]`;if(await page.$eval(s,n=>n.getAttribute('aria-expanded'))!==String(on))await page.click(s);await settle()}
  await ensure('inspector',true);await ensure('detail',true)
  await measure('summary cells','.context-inspector-section .inspect-grid > div',[10,10]);await measure('summary actions','.inspector-actions button',[7,10]);await measure('workspace actions','.workspace-actions > button',[6,12]);await measure('detail rows','.detail-row',[12,16]);await capture('overview-expanded-1440')
  await page.evaluate(()=>{setStudioView('timeline');state.selectedScript=buildScriptBlocks(state.snapshot.entries)[0];setDetail('script')});await measure('script reading','.script-detail',[16,20]);await capture('detail-script-1440');await page.evaluate(()=>setDetail('data'));await measure('data source','#detail-content pre',[16,20])
  for(const width of [1440,760]){
   await page.setViewport({width,height:width===1440?900:600});await page.evaluate(()=>{mixerState.section='人物与故事';setSurface('studio');setStudioView('mixer')});await page.waitForFunction(()=>mixerState.params.length>0&&mixerState.storyId===state.storyId);await page.evaluate(()=>renderMixerStrips());await page.waitForSelector('.story-quick textarea');await settle()
   await measure('story textarea '+width,'.story-quick textarea',[12,14])
   const groups=await page.$$eval('[data-mixer-section]',ns=>ns.map(n=>n.dataset.mixerSection))
   for(let i=0;i<groups.length;i++){await page.click(`[data-mixer-section="${groups[i]}"]`);await page.waitForSelector('#mixer-strips .mixer-channel').catch(async e=>{await capture('mixer-failure');console.log(await page.evaluate(()=>({section:mixerState.section,view:state.browserView,surface:state.surface,params:mixerState.params.length,width:innerWidth})));throw e});await measure('mixer fields '+groups[i]+' '+width,'.mixer-number,.mixer-select,.mixer-text');await measure('mixer actions '+groups[i]+' '+width,'.mixer-actions button',[7,12]);if(i===1)await capture('mixer-controls-'+width);assert.equal(await page.$eval('#mixer-strips',n=>n.scrollWidth>n.clientWidth+1),false)}
  }
  for(const [width,height] of [[1440,900],[1280,768],[760,600],[480,500],[360,560]]){
   await page.setViewport({width,height});await page.evaluate(()=>openConfig('fixture'));await page.waitForFunction(()=>configSectionsReady)
   for(const tab of ['story','users','groups','bots','providers','secrets','plugins','yaml']){
    await page.click(`[data-config-tab="${tab}"]`);await settle()
    await measure('config fields '+tab+' '+width,'#config-form .config-tab-panel.active input:not([type="checkbox"]):not([type="range"]),#config-form .config-tab-panel.active select,#config-form .config-tab-panel.active textarea')
    if(['users','groups','providers','plugins'].includes(tab)){await page.click('.config-tab-panel.active .cfg-expand-toggle');await measure('expand button '+tab+' '+width,'.config-tab-panel.active .cfg-expand-toggle',[8,12]);await measure('expanded fields '+tab+' '+width,'.config-tab-panel.active .cfg-expand input:not([type="checkbox"]),.config-tab-panel.active .cfg-expand select,.config-tab-panel.active .cfg-expand textarea')}
    const m=await page.evaluate(()=>{const n=document.querySelector('.config-body'),f=document.querySelector('#config-form > footer').getBoundingClientRect();return {overflow:n.scrollWidth>n.clientWidth+1,footerBottom:f.bottom,height:innerHeight}});assert.equal(m.overflow,false,tab+width);assert.ok(m.footerBottom<=height+1)
    if([1440,760].includes(width)&&['story','providers','plugins','yaml'].includes(tab))await capture(`config-${tab}-${width}`)
   }
   await page.evaluate(()=>requestCloseConfigDialog())
  }
  await page.setViewport({width:1440,height:900});await page.evaluate(()=>openWizard())
  for(let step=1;step<=6;step++){await page.evaluate(step=>{wizardStep=step;updateWizardUI()},step);await measure('wizard '+step,'.wizard-step:not([hidden]) input:not([type="checkbox"]):not([type="range"]),.wizard-step:not([hidden]) textarea,.wizard-step:not([hidden]) select');if(step===1||step===4)await capture('wizard-'+step)}await page.evaluate(()=>byId('story-dialog').close())
  await page.evaluate(()=>openAccountWizard([]));await measure('account wizard','.wiz-field input,.wiz-field select',[8,12]);await capture('account-wizard');await page.evaluate(()=>byId('account-wizard').close())
  await page.click('#theme-menu-btn');await measure('theme section titles','.theme-section-title',[8,0]);await measure('theme cards','.theme-card',[16,16]);await measure('theme pack actions','.theme-pack-actions button',[8,12]);await capture('themes');await page.click('#theme-close')
  await page.keyboard.down('Control');await page.keyboard.press('k');await page.keyboard.up('Control');await page.waitForSelector('#global-search-input');await measure('search','#global-search-input',[12,16]);await capture('search');await page.keyboard.press('Escape')
  if(!baseline){for(const row of metrics.filter(m=>m.name.startsWith('config fields')||m.name.startsWith('expanded fields')||m.name.startsWith('mixer fields')||m.name.startsWith('wizard '))){for(const n of row.items){assert.ok(n.padding[0]>=7&&n.padding[3]>=11,row.name+JSON.stringify(n));if(n.tag!=='TEXTAREA')assert.ok(n.height>=36,row.name+JSON.stringify(n));if(n.tag==='SELECT')assert.ok(n.padding[1]>=32,row.name+' select arrow clearance '+JSON.stringify(n))}}}
  assert.deepEqual(errors,[]);fs.writeFileSync(path.join(output,'spacing-measurements.json'),JSON.stringify(metrics,null,2));console.log((baseline?'BASELINE':'PASS')+': spacing measurements, 7 Mixer groups, 8 config tabs at 5 sizes, wizard steps and utility dialogs. '+output)
 } finally {await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1})

// Round 2: task layouts, prose/editing hierarchy and complete child-page sweep.
const assert=require('node:assert/strict')
const fs=require('node:fs'),path=require('node:path'),os=require('node:os')
const {pathToFileURL}=require('node:url')
const puppeteer=require(require.resolve('puppeteer-core',{paths:[process.cwd(),'C:/dev/HDS-Interlude']}))
// Read safe literal UI metadata from the real IPC catalog, never execute IPC code.
const ts=require('typescript')
const catalogSource=ts.createSourceFile('mixer.ts',fs.readFileSync(path.resolve('src/main/ipc/mixer.ts'),'utf8'),ts.ScriptTarget.Latest,true)
let catalogNode
function findCatalog(node){if(ts.isVariableDeclaration(node)&&node.name.getText(catalogSource)==='MIXER_PARAMS')catalogNode=node.initializer;ts.forEachChild(node,findCatalog)}
findCatalog(catalogSource)
assert.ok(catalogNode&&ts.isArrayLiteralExpression(catalogNode))
const literal=node=>ts.isStringLiteral(node)?node.text:ts.isNumericLiteral(node)?Number(node.text):node.kind===ts.SyntaxKind.TrueKeyword?true:ts.isArrayLiteralExpression(node)?node.elements.map(literal):undefined
const metadataKeys=new Set(['key','section','label','desc','type','min','max','step','hot','options'])
const mixerCatalog=catalogNode.elements.map(node=>Object.fromEntries(node.properties.filter(p=>metadataKeys.has(p.name?.getText(catalogSource))).map(p=>[p.name.getText(catalogSource),literal(p.initializer)])))
const output=process.env.UI_TEST_SCREENSHOT_DIR || path.join(os.tmpdir(),'hdsi-ui-hierarchy')
fs.mkdirSync(output,{recursive:true})
;(async()=>{
  const browser=await puppeteer.launch({executablePath:process.env.UI_TEST_BROWSER || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',headless:true})
  try {
    const page=await browser.newPage(),errors=[],metrics=[]
    page.on('pageerror',error=>errors.push(error.message))
    await page.setViewport({width:1440,height:900})
    await page.evaluateOnNewDocument(require('./fixtures/studio.cjs'))
    await page.evaluateOnNewDocument(require('./fixtures/ui-hierarchy.cjs'),mixerCatalog)
    await page.goto(pathToFileURL(path.resolve(process.env.UI_TEST_DIST?'dist/renderer/index.html':'src/renderer/index.html')).href)
    await page.waitForSelector('.hud-scene-copy strong')
    const settle=()=>page.evaluate(async()=>{await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));await Promise.all(document.getAnimations().filter(a=>a.playState==='running'&&a.effect?.getComputedTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})))})
    const capture=async name=>{await settle();await page.screenshot({path:path.join(output,`hierarchy-${name}.png`)})}
    const layout=()=>page.evaluate(()=>{
      const box=id=>{const r=byId(id).getBoundingClientRect();return {width:r.width,height:r.height,top:r.top,bottom:r.bottom}}
      return {panels:effectivePanels(),saved:layoutFor().panels,workspace:box('studio-surface'),inspector:box('inspector-panel'),detail:box('detail-panel'),overflow:document.documentElement.scrollWidth>innerWidth+1}
    })
    for(const view of ['overview','session','mixer','stats','analysis']) {
      await page.evaluate(view=>{setSurface('studio');setStudioView(view)},view)
      const result=await layout()
      assert.equal(result.inspector.width,0,view);assert.equal(result.detail.height,0,view)
      assert.ok(result.workspace.height>700,view+JSON.stringify(result));assert.equal(result.overflow,false)
      assert.equal(result.saved.inspector,true);assert.equal(result.saved.detail,true)
      if(view==='session') {
        const prose=await page.evaluate(()=>{
          const p=document.querySelector('.session-clip p'),cs=getComputedStyle(p)
          return {full:p.textContent===buildScriptBlocks(state.snapshot.entries)[0].content,length:p.textContent.length,size:parseFloat(cs.fontSize),line:parseFloat(cs.lineHeight),max:cs.maxHeight,white:cs.whiteSpace,font:cs.fontFamily}
        })
        assert.ok(prose.full&&prose.length>300);assert.ok(prose.size>=14&&prose.line>=24)
        assert.equal(prose.max,'none');assert.equal(prose.white,'pre-wrap');metrics.push({prose})
      }
      if(view==='mixer') await page.waitForSelector('.story-quick textarea')
      if(view==='stats') await page.waitForSelector('.stats-card-value')
      await capture(view)
    }
    // Explicit drill-down restores panels, without corrupting saved Timeline layout.
    await page.evaluate(()=>{setStudioView('overview');inspect({type:'scene',entry:state.snapshot.scenes[0]});setDetail('deliveries')})
    let result=await layout();assert.ok(result.inspector.width>=180&&result.detail.height>=80)
    await page.evaluate(()=>{togglePanel('inspector');togglePanel('detail')})
    result=await layout();assert.equal(result.inspector.width,0);assert.equal(result.detail.height,0)
    assert.equal(await page.$eval('#workbench-dock [data-panel-toggle="inspector"]',n=>n.getAttribute('aria-expanded')),'false')
    await page.click('#workbench-dock [data-panel-toggle="inspector"]');assert.ok((await layout()).inspector.width>=180)
    await page.evaluate(()=>{setStudioView('session');setStudioView('timeline')})
    result=await layout();assert.ok(result.inspector.width>=180&&result.detail.height>=80)
    await page.evaluate(()=>{setStudioView('overview');taskPanelOverrides.clear();applyPanelLayout()})
    assert.equal(await page.$('#restore-inspector'),null,'automatic task defaults have no floating strips')

    for(const surface of ['connect','logs','koishi']) {
      await page.evaluate(surface=>setSurface(surface),surface)
      if(surface==='connect') await page.waitForSelector('#connect-open-wizard')
      if(surface==='logs') await page.waitForSelector('.log-row')
      result=await layout();assert.equal(result.inspector.width,0);assert.equal(result.detail.height,0)
      if(surface==='logs') {
        const logs=await page.evaluate(()=>{
          const p=byId('logs-scroll'),s=getComputedStyle(document.querySelector('.log-row span')),t=getComputedStyle(document.querySelector('.log-row time'))
          return {height:p.clientHeight,scroll:p.scrollHeight,font:s.fontFamily,timeFont:t.fontFamily,size:parseFloat(s.fontSize),count:p.querySelectorAll('.log-row').length}
        })
        assert.ok(logs.height>500&&logs.scroll>logs.height,JSON.stringify(logs));assert.ok(logs.size>=13)
        assert.notEqual(logs.font,logs.timeFont);assert.ok(await page.$eval('.log-row span',n=>n.textContent.length)>10,'fixture must show real Chinese log messages');metrics.push({logs})
        await page.$eval('#logs-scroll',n=>n.scrollTop=0)
      }
      await capture(surface)
    }

    // Seven Mixer sections, including real pointer use of optional presets.
    await page.evaluate(()=>{setSurface('studio');setStudioView('mixer')})
    const groups=await page.$$eval('[data-mixer-section]',nodes=>nodes.map(n=>n.dataset.mixerSection))
    assert.equal(groups.length,7)
    for(let i=0;i<groups.length;i++) {
      await page.click(`[data-mixer-section="${groups[i]}"]`)
      await page.waitForSelector('#mixer-strips .mixer-channel')
      const count=await page.$$eval('#mixer-strips .mixer-channel',nodes=>nodes.length)
      assert.ok(count>0,groups[i]+' must render real catalog parameters or story editor')
      metrics.push({mixerSection:groups[i],cards:count})
      await capture(`mixer-group-${i+1}`)
    }
    await page.setViewport({width:760,height:600})
    await page.waitForFunction(()=>document.querySelector('.workspace-panel').getBoundingClientRect().left<1)
    await settle()
    for(let i=0;i<groups.length;i++) {
      await page.click(`[data-mixer-section="${groups[i]}"]`)
      await page.waitForSelector('#mixer-strips .mixer-channel',{timeout:5000}).catch(async error=>{await capture('failure');console.error(await page.evaluate(()=>({view:state.browserView,section:mixerState.section,surface:state.surface,errors:document.querySelector('#mixer-foot')?.textContent})));throw error});await settle()
      const overflow=await page.$eval('#mixer-strips',n=>n.scrollWidth>n.clientWidth+1)
      assert.equal(overflow,false,'compact Mixer '+groups[i])
      await capture(`mixer-group-${i+1}-760`)
    }
    await page.setViewport({width:1440,height:900})
    await page.waitForFunction(()=>document.querySelector('.workspace-panel').getBoundingClientRect().left>=150)
    await page.click('.mixer-presets-disclosure > summary')
    assert.equal(await page.$eval('.mixer-presets-disclosure',n=>n.open),true)
    await page.click('.preset-btn')
    assert.ok(await page.evaluate(()=>Object.keys(mixerDraft('fixture').pending).length)>0)
    await capture('mixer-presets')
    await page.click('.mixer-presets-disclosure > summary')

    // Eight config tabs at desktop and compact widths. No saves are performed.
    for(const width of [1440,760]) {
      await page.setViewport({width,height:width===1440?900:600})
      await page.evaluate(()=>openConfig('fixture'))
      await page.waitForFunction(()=>!byId('config-save').disabled)
      const tabs=await page.$$eval('[data-config-tab]',nodes=>nodes.map(n=>n.dataset.configTab))
      assert.equal(tabs.length,8)
      for(const tab of tabs) {
        await page.click(`[data-config-tab="${tab}"]`)
        const bounds=await page.evaluate(()=>{
          const body=document.querySelector('.config-body'),dialog=byId('config-dialog'),rect=dialog.getBoundingClientRect()
          return {width:body.clientWidth,scroll:body.scrollWidth,left:rect.left,right:rect.right}
        })
        assert.ok(bounds.scroll<=bounds.width+1,tab+JSON.stringify(bounds))
        assert.ok(bounds.left>=0&&bounds.right<=width+1,tab+JSON.stringify(bounds))
        if(tab==='story') assert.ok(await page.$eval('.cfg-tall textarea',n=>parseFloat(getComputedStyle(n).fontSize))>=13)
        if(tab==='yaml') assert.match(await page.$eval('#config-source',n=>getComputedStyle(n).fontFamily),/Consolas|monospace/)
        await capture(`config-${tab}-${width}`)
        if(['providers','groups','users','plugins'].includes(tab)) {
          const expand=await page.$('.config-tab-panel.active .cfg-expand-toggle')
          if(expand){await expand.click();await capture(`config-${tab}-expanded-${width}`)}
        }
      }
      await page.evaluate(()=>byId('config-dialog').close())
    }

    for(const [width,height] of [[1440,900],[1280,768],[760,600]]) {
      await page.setViewport({width,height})
      for(const view of ['overview','session','mixer']) {
        await page.evaluate(view=>{taskPanelOverrides.clear();if(view==='mixer')mixerState.section='人物与故事';setSurface('studio');setStudioView(view)},view)
        if(view==='mixer') await page.waitForSelector('.story-quick textarea')
        await settle()
        const geometry=await page.evaluate(()=>{
          const title=byId('workspace-title').getBoundingClientRect(),field=document.querySelector('.story-quick textarea')?.getBoundingClientRect()
          return {title:title.width,overflow:document.documentElement.scrollWidth>innerWidth+1,fieldTop:field?.top,fieldBottom:field?.bottom,titleLeft:title.left,titleRight:title.right,drawerRight:byId('browser-panel').getBoundingClientRect().right}
        })
        assert.ok(geometry.title>0);assert.equal(geometry.overflow,false)
        if(width<=860){assert.ok(geometry.titleLeft>=70,'page title must clear Browser FAB');assert.ok(geometry.drawerRight<=1,'closed Browser drawer must be off-screen')}
        if(view==='mixer') assert.ok(geometry.fieldTop<height-90,JSON.stringify({width,height,geometry}))
        metrics.push({width,height,view,geometry});await capture(`${view}-${width}`)
        if(view==='session') {
          await page.click('.session-fork');await capture(`fork-${width}`)
          const fork=await page.$eval('.fork-dialog',n=>{const r=n.getBoundingClientRect();return {left:r.left,right:r.right,bottom:r.bottom,scroll:n.scrollWidth,width:n.clientWidth}})
          assert.ok(fork.left>=0&&fork.right<=width+1&&fork.bottom<=height+1&&fork.scroll<=fork.width+1,JSON.stringify(fork))
          await page.click('.fork-dialog [value="cancel"]')
        }
      }
      await page.evaluate(()=>openWizard())
      for(let step=1;step<=6;step++) {
        await page.evaluate(step=>{wizardStep=step;updateWizardUI()},step)
        assert.equal(await page.$$eval('.wizard-step',nodes=>nodes.filter(n=>!n.hidden).length),1)
        await capture(`wizard-${step}-${width}`)
      }
      await page.evaluate(()=>byId('story-dialog').close())
    }
    // Focused tasks must retain a real, clickable Inspector on compact windows.
    for(const width of [1000,760]) {
      await page.setViewport({width,height:768})
      await page.evaluate(()=>{taskPanelOverrides.clear();setSurface('studio');setStudioView('session')})
      await settle();await page.click('#inspector-fab');await settle()
      const drawer=await page.$eval('#inspector-panel',n=>{const r=n.getBoundingClientRect();return {left:r.left,right:r.right,open:n.classList.contains('panel-open')}})
      assert.ok(drawer.open&&drawer.left>=0&&drawer.right<=width+1,JSON.stringify(drawer))
      await page.click('#workspace-title');await settle()
      assert.equal(await page.$eval('#inspector-panel',n=>n.classList.contains('panel-open')),false)
      await page.evaluate(()=>HDSIWorkspaceProfile.apply('v7'));await settle()
      assert.equal(await page.$eval('#inspector-fab',n=>getComputedStyle(n).display),'none','V7 has no legacy Inspector FAB')
      await page.evaluate(()=>HDSIWorkspaceProfile.apply('v4'))
    }
    await page.setViewport({width:1440,height:900})
    await page.evaluate(()=>{setStudioView('timeline');state.selectedScript=buildScriptBlocks(state.snapshot.entries)[0]})
    for(const detail of ['script','events','deliveries','usage','data']) {
      await page.evaluate(detail=>setDetail(detail),detail);await capture(`detail-${detail}`)
    }
    await page.click('#theme-menu-btn');await capture('theme');await page.click('#theme-close')
    await page.evaluate(()=>byId('help-dialog').showModal());await capture('help');await page.evaluate(()=>byId('help-dialog').close())
    await page.keyboard.down('Control');await page.keyboard.press('k');await page.keyboard.up('Control')
    await page.waitForSelector('#global-search');await capture('search');await page.keyboard.press('Escape')
    await page.evaluate(()=>openAccountWizard([]));await capture('account');await page.evaluate(()=>byId('account-wizard').close())
    // Persisted focused views must not interpret active-tab restoration as a user reveal.
    for(const view of ['overview','session','mixer']) {
      await page.evaluate(view=>{taskPanelOverrides.clear();setSurface('studio');setStudioView(view);persist()},view)
      await page.reload()
      await page.waitForSelector({overview:'.hud-scene-copy strong',session:'.session-clip p',mixer:'.story-quick textarea'}[view])
      await settle()
      const restored=await layout()
      assert.equal(await page.evaluate(()=>state.browserView),view)
      assert.equal(restored.detail.height,0,view+' cold start must keep task detail hidden')
      assert.equal(restored.inspector.width,0,view+' cold start must keep task inspector hidden')
      assert.equal(restored.saved.detail,true,'cold start must preserve Timeline preference')
    }
    assert.deepEqual(errors,[])
    fs.writeFileSync(path.join(output,'hierarchy-measurements.json'),JSON.stringify(metrics,null,2))
    console.log('Round 2 task layouts, panel restoration, full prose, 7 Mixer groups, 8 config tabs, 6 wizard steps, 5 details and utility dialogs: PASS')
    console.log(output)
  } finally {await browser.close()}
})().catch(error=>{console.error(error);process.exitCode=1})

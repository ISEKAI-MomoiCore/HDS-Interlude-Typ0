// Round 3: all writes are in-memory preload fixtures; no Electron/Worker is started.
module.exports = function installRefinementFixture() {
  const api = window.hdsiDesktop, original = api.stories.configSection
  globalThis.refinement = { writes:[], fail:'', hold:false, analysis:'unsupported' }
  api.stories.configSection = async (id,section,data) => {
    if(data===undefined) return original(id,section)
    refinement.writes.push({id,section,data:structuredClone(data)})
    if(refinement.hold) await new Promise(resolve=>refinement.release=resolve)
    if(refinement.fail===section) throw new Error('fixture partial failure: '+section)
    return original(id,section,data)
  }
  api.stories.saveConfig = async (id,source) => {refinement.writes.push({id,section:'yaml',source});return {ok:true}}
  api.secrets.set = async (alias,value) => {refinement.writes.push({section:'secret',alias});return {ok:true}}
  api.stories.pluginToggle = async (id,key,enabled) => {refinement.writes.push({section:'plugin',id,key,enabled});return {ok:true}}
  api.stories.semanticAnalysis = async () => {
    if(refinement.analysis==='unsupported') throw new Error('当前 Worker 尚未提供语义分析接口')
    if(refinement.analysis==='error') throw new Error('fixture connection lost')
    return null
  }
}

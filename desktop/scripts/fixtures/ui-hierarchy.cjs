// Isolated second-round visual data. All mutations stay in this browser context.
module.exports = function installHierarchyFixture(mixerCatalog) {
  const config = {
    storyDefaults: { characterName:'林间', characterProfile:'住在城市南侧的插画师。\n说话简短，习惯先倾听，再慢慢给出回应。', world:'当代城市，雨季刚刚开始。', style:'克制、自然，在日常对话里延续故事。', timezone:'Asia/Shanghai' },
    userAccounts:[{ qq:'10001', personId:'reader', enabled:true, label:'窗边的人', profile:'喜欢雨天和旧书店', relationship:'旧识' }],
    groupChats:[{ groupId:'20001', enabled:true, label:'雨夜书店', purpose:'在雨夜书店交换日常与阅读片段。', characterRole:'常客', willingnessPreset:'custom', willingness:{threshold:0.6} }],
    botAccounts:[{ qq:'30001', label:'故事机器人', enabled:true }],
    providers:[{ id:'primary', mode:'openai-compatible', endpoint:'https://api.example.test/v1', model:'story-model', apiKey:'$secret:story-model', temperature:0.8 }],
  }
  const api=window.hdsiDesktop
  api.stories.mixerRead = async () => mixerCatalog.map((param,index) => ({...param,value:index%5===0?undefined:param.type==='knob'?param.min:param.type==='toggle'?true:param.type==='select'?param.options[0]:'保持自然、克制的叙事节奏。\n在日常对话中延续人物关系。'}))
  api.stories.config = async () => ({ source:'storyDefaults:\n  characterName: 林间\n  timezone: Asia/Shanghai\nproviders: []\n', aliases:['story-model'] })
  api.stories.configSection = async (_id, section, value) => value === undefined ? structuredClone(config[section] ?? {}) : (config[section]=structuredClone(value), {ok:true})
  api.stories.plugins = async () => ({ entries:[{ rawKey:'console:fixture', key:'console', packageName:'console', enabled:true, installed:'5.30.11', official:true, config:{} }], warnings:[] })
  api.accounts.list = async () => []
  api.connection = { detect: async () => ({ snowluma:'running', snowlumaWebui:{port:5099}, snowlumaAccounts:[] }), firstRunReadiness:async () => ({checks:[],allOk:true,criticalOk:true}) }
  api.secrets = { list:async () => ['story-model'] }
  api.stories.semanticAnalysis = async () => { throw new Error('当前 Worker 尚未提供语义分析接口') }
  const range = api.stories.timelineRange
  api.stories.timelineRange = async (...args) => {
    const data=await range(...args)
    data.entries=data.entries.map(entry=>entry.kind !== 'script' ? entry : {...entry,content:[
      '雨落在书店的玻璃上，窗外的灯光在水里慢慢散开。林间把那把黑伞靠在门边，像把一句没说完的话暂时放了下来。',
      '“你上次借我的书，还没看完。”她说。\n屏幕亮起，你的消息刚好抵达：不着急，等天晴了再还。',
      '她看了很久，最后只回了一个“好”字。书店里很安静，翻页的声音从另一排书架传过来。那一刻，她忽然觉得，等待也可以是一件有形状的事。',
      '门口有人收起滴水的雨衣。她抬起头，把桌边空着的椅子往外挪了一点。\n“这里还有位置。”',
      '窗外的雨没有停。她却已经开始想着，明天应该把伞送到哪里，又该怎样不经意地提起，书里夹着的那张旧车票。',
      '夜深以后，城市里的声音慢慢变少。她合上书，记住了今天最后一句对话，也记住了你说话时那个短短的停顿。'
    ].join('\n\n')})
    return data
  }
  const now=Date.now()
  api.logs.query = async query => query?.before ? [] : Array.from({length:220},(_,i)=>({id:`log-${i}`,storyId:'fixture',source:i%2?'worker':'delivery',level:i%9===0?'error':i%4===0?'warn':'info',at:new Date(now-i*15000).toISOString(),message:i%9===0?'投递暂时失败：上游连接已断开，等待重试。':'收到新消息，已更新场景与连续性记录。',correlation:`corr-${i}`}))
  api.logs.stats = async () => ({total:220})
  window.confirm=()=>true
}

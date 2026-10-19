import { registerHandle } from './register'
/**
 * 调音台域：stories:mixerRead / stories:mixerWrite（P2 结构批次，自 main.ts 逐字迁移）。
 * 白名单参数表 MIXER_PARAMS 是唯一事实来源——新增参数在此补一行（含 rc57 同步的
 * specializationAutoTrim 与默认值描述），渲染层按表渲染。
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import yaml from 'js-yaml'
import type { IpcContext } from './context'

export function registerMixerIpc(ctx: IpcContext) {
  const { stories, config, broadcast } = ctx
  // D-批次5 调音台：白名单参数读写。渲染层只拿到安全参数的当前值；
  // 写入经范围校验后以 js-yaml 应用到 canonical（$secret 别名段不在此路径触碰）。
  function mixerMainProvider(h: any) {
    const providers = Array.isArray(h?.model?.providers) ? h.model.providers : []
    const provider = providers.find((p: any) => p.enabled !== false && p.useForMain === true)
    if (!provider) throw new Error('请先在模型配置中指定用于主叙事的提供商，再调整采样参数。')
    return provider
  }
  const MIXER_PARAMS: Array<{
    key: string, section: string, label: string, desc: string, hot?: boolean,
    type: 'knob' | 'toggle' | 'select' | 'text',
    min?: number, max?: number, step?: number, integer?: boolean, options?: string[],
    apply: (hdsi: Record<string, any>, value: any) => void,
    read: (hdsi: Record<string, any>) => unknown,
  }> = [
    { key: 'temperature', section: 'MODEL', label: 'Temperature', desc: '主叙事采样温度。越高越有创造性，越低越稳定。', hot: true, type: 'knob', min: 0, max: 2, step: 0.05, apply: (h,v)=>{mixerMainProvider(h).temperature=v}, read: h=>h?.model?.providers?.find((p: any)=>p.enabled!==false&&p.useForMain===true)?.temperature },
    { key: 'topP', section: 'MODEL', label: 'Top P', desc: '核采样截断。1.0 不截断，越小越保守。', type: 'knob', min: 0, max: 1, step: 0.05, apply: (h,v)=>{mixerMainProvider(h).topP=v}, read: h=>h?.model?.providers?.find((p: any)=>p.enabled!==false&&p.useForMain===true)?.topP },
    { key: 'mainMaxTokens', section: 'MODEL', label: 'Max Tokens', desc: '主叙事单次最大输出 token 数。', type: 'knob', min: 1024, max: 32000, step: 512, integer: true, apply: (h,v)=>{(h.model??={}).mainMaxTokens=v}, read: h=>h?.model?.mainMaxTokens },
    { key: 'mainTimeout', section: 'MODEL', label: 'Timeout (s)', desc: '主叙事请求超时秒数。', type: 'knob', min: 10, max: 300, step: 5, integer: true, apply: (h,v)=>{(h.model??={}).mainTimeout=v === undefined ? undefined : v*1000}, read: h=>h?.model?.mainTimeout!=null?Math.round(h.model.mainTimeout/1000):undefined },
    { key: 'mainResponseFormat', section: 'MODEL', label: 'Response Format', desc: 'json-object=结构化输出（推荐）；prompt-only=纯文本。', hot: true, type: 'select', options: ['json-object', 'prompt-only'], apply: (h,v)=>{(h.model??={}).mainResponseFormat=v}, read: h=>h?.model?.mainResponseFormat },
    { key: 'payloadOrder', section: 'MODEL', label: 'Payload Order', desc: 'cache-first=对话历史前置命中前缀缓存（DeepSeek/GLM/Kimi 等可显著降本提速）；legacy=传统顺序。当前默认 cache-first。', type: 'select', options: ['cache-first', 'legacy'], apply: (h,v)=>{(h.model??={}).mainPayloadOrder=v}, read: h=>h?.model?.mainPayloadOrder },
    { key: 'mainStreaming', section: 'MODEL', label: 'First Bubble', desc: '实验性流式首泡：私聊首条回复在完整结果前先发出（仅 JSON 模式、支持 SSE 的接口）。off=关闭。', type: 'select', options: ['off', 'experimental'], apply: (h,v)=>{(h.model??={}).mainStreamingMode=v}, read: h=>h?.model?.mainStreamingMode },
    { key: 'specialization', section: 'MODEL', label: '特化档位', desc: '主叙事合约按模型档位切换：off=完整原始合约；lite=精简（flash/Grok/GLM-4.x）；standard=标准+content-only；full=完整+say 锚点（Claude/GPT）。lite 同步精简压缩/时间导演提示词；下回合生效。', hot: true, type: 'select', options: ['off', 'lite', 'standard', 'full'], apply: (h,v)=>{(h.model??={}).specialization=v}, read: h=>h?.model?.specialization },
    { key: 'specializationFamily', section: 'MODEL', label: '特化家族', desc: 'auto=按模型名识别（只决定套哪套特化块）；中转别名识别不出时显式指定；generic=不套家族块。', type: 'select', options: ['auto', 'generic', 'gemini-flash', 'gemini', 'claude', 'gpt', 'glm', 'kimi', 'deepseek', 'grok'], apply: (h,v)=>{(h.model??={}).specializationFamily=v}, read: h=>h?.model?.specializationFamily },
    { key: 'specializationAutoTrim', section: 'MODEL', label: '合约自动裁剪', desc: 'rc57 新增：按已启用的功能裁剪系统合约（如未启用 QQ 空间、无群投递或单平台时移除对应板块，降低每轮输入体积）；窗口内仍有对应数据或待办意图时保留解释行。默认开启。', type: 'toggle', apply: (h,v)=>{(h.model??={}).specializationAutoTrim=v}, read: h=>h?.model?.specializationAutoTrim },
    { key: 'failoverEnabled', section: 'MODEL', label: 'Failover', desc: '模型失败时自动切换到下一个提供商。', type: 'toggle', apply: (h,v)=>{((h.model??={}).failover??={}).enabled=v}, read: h=>h?.model?.failover?.enabled },
    { key: 'autoAdvanceEnabled', section: 'TEMPO', label: 'Auto Advance', desc: '无对话时按真实时间自动补写角色生活。', hot: true, type: 'toggle', apply: (h,v)=>{(h.runtime??={}).autoAdvanceEnabled=v}, read: h=>h?.runtime?.autoAdvanceEnabled },
    { key: 'autoAdvanceIntervalMinutes', section: 'TEMPO', label: 'Advance Interval', desc: '普通时段自动推进目标间隔（分钟）。', hot: true, type: 'knob', min: 5, max: 1440, step: 5, integer: true, apply: (h,v)=>{(h.runtime??={}).autoAdvanceIntervalMinutes=v}, read: h=>h?.runtime?.autoAdvanceIntervalMinutes },
    { key: 'autoAdvanceJitterMinutes', section: 'TEMPO', label: 'Jitter (min)', desc: '推进间隔随机浮动范围。', type: 'knob', min: 0, max: 60, step: 1, integer: true, apply: (h,v)=>{(h.runtime??={}).autoAdvanceJitterMinutes=v}, read: h=>h?.runtime?.autoAdvanceJitterMinutes },
    { key: 'typingSpeed', section: 'TEMPO', label: 'Typing Speed', desc: '模拟打字速度（字符/秒）。8=正常，15+=快手。', hot: true, type: 'knob', min: 1, max: 100, step: 1, integer: true, apply: (h,v)=>{(h.runtime??={}).typingCharactersPerSecond=v}, read: h=>h?.runtime?.typingCharactersPerSecond },
    { key: 'typingBaseDelay', section: 'TEMPO', label: 'Base Delay (s)', desc: '分段消息基础等待秒数。', type: 'knob', min: 0, max: 60, step: 0.5, apply: (h,v)=>{(h.runtime??={}).typingBaseDelaySeconds=v}, read: h=>h?.runtime?.typingBaseDelaySeconds },
    { key: 'typingMaxDelay', section: 'TEMPO', label: 'Max Delay (s)', desc: '单条后续消息最长等待。', type: 'knob', min: 0, max: 120, step: 1, integer: true, apply: (h,v)=>{(h.runtime??={}).typingMaxDelaySeconds=v}, read: h=>h?.runtime?.typingMaxDelaySeconds },
    { key: 'maxMsgChars', section: 'TEMPO', label: 'Max Msg Chars', desc: '单条可见消息最大字符数。默认 1500（rc57 起）；2000=QQ 上限。', hot: true, type: 'knob', min: 100, max: 12000, step: 100, integer: true, apply: (h,v)=>{(h.runtime??={}).maxMessageCharacters=v}, read: h=>h?.runtime?.maxMessageCharacters },
    { key: 'debounce', section: 'TEMPO', label: 'Debounce (s)', desc: '短消息合并等待秒数。', type: 'knob', min: 0, max: 15, step: 0.5, apply: (h,v)=>{(h.runtime??={}).userMessageDebounceSeconds=v}, read: h=>h?.runtime?.userMessageDebounceSeconds },
    { key: 'proactive', section: 'TEMPO', label: 'Proactive', desc: '允许角色主动发消息（无新消息时）。', type: 'toggle', apply: (h,v)=>{(h.runtime??={}).allowProactiveMessages=v}, read: h=>h?.runtime?.allowProactiveMessages },
    { key: 'proactiveThr', section: 'TEMPO', label: 'Proactive Thr', desc: '主动联系意愿门槛（0-1）；Urge 引擎关闭时生效。', type: 'knob', min: 0, max: 1, step: 0.05, apply: (h,v)=>{(h.runtime??={}).proactiveWillingnessThreshold=v}, read: h=>h?.runtime?.proactiveWillingnessThreshold },
    { key: 'urgeProactiveThr', section: 'TEMPO', label: 'Urge Proactive Thr', desc: 'Urge 引擎启用时的主动联系意愿门槛（Agency strict 模式读取这里，上面 Proactive Thr 不生效）；不是发送概率。', type: 'knob', min: 0, max: 1, step: 0.05, apply: (h,v)=>{((h.urge??={}) as any).proactiveWillingnessThreshold=v}, read: h=>h?.urge?.proactiveWillingnessThreshold },
    { key: 'agencyEnabled', section: 'TEMPO', label: 'Agency Window', desc: '主体行动窗口总开关（rc50 起插件默认关闭；不开则下列 Contact Temp/Natural/ Daily Cap 全部不生效）。主动消息总开关仍由 Proactive 独立控制。', hot: true, type: 'toggle', apply: (h,v)=>{(h.agency??={}).enabled=v}, read: h=>h?.agency?.enabled },
    { key: 'contactMode', section: 'TEMPO', label: 'Contact Temp', desc: '主动联系温度（须 Agency Window 开启）：strict=沉默本身不是理由（现状）；natural=想念/好奇近况/想分享此刻也是合法动机（须剧本显示她想到对方），阈值与间隔放宽；balanced=同自然但更节制。容量门（设备/隐私/日程）三档不放宽。', hot: true, type: 'select', options: ['strict', 'natural', 'balanced'], apply: (h,v)=>{(h.agency??={}).contactMode=v}, read: h=>h?.agency?.contactMode },
    { key: 'naturalThreshold', section: 'TEMPO', label: 'Natural Thr', desc: '自然/平衡模式的意愿阈值（strict 档沿用 Proactive Thr）。', type: 'knob', min: 0, max: 1, step: 0.05, apply: (h,v)=>{(h.agency??={}).naturalWillingnessThreshold=v}, read: h=>h?.agency?.naturalWillingnessThreshold },
    { key: 'naturalInterval', section: 'TEMPO', label: 'Natural Interval', desc: '自然/平衡模式的安全间隔（分钟）；仅当小于严格间隔时生效。', type: 'knob', min: 0, max: 1440, step: 5, integer: true, apply: (h,v)=>{(h.agency??={}).naturalMinimumIntervalMinutes=v}, read: h=>h?.agency?.naturalMinimumIntervalMinutes },
    { key: 'proactiveDailyCap', section: 'TEMPO', label: 'Daily Cap', desc: '每参与者每 24 小时主动联系上限（三档全生效；0=不限）。', type: 'knob', min: 0, max: 20, step: 1, integer: true, apply: (h,v)=>{(h.agency??={}).proactiveDailyCap=v}, read: h=>h?.agency?.proactiveDailyCap },
    { key: 'urgeEnabled', section: 'TEMPO', label: 'Urge Engine', desc: '弹性推进引擎（替代固定间隔）。', hot: true, type: 'toggle', apply: (h,v)=>{(h.urge??={}).enabled=v}, read: h=>h?.urge?.enabled },
    { key: 'urgeFreq', section: 'TEMPO', label: 'Urge Freq', desc: '弹性推进档位。', type: 'select', options: ['low', 'medium', 'high', 'custom'], apply: (h,v)=>{(h.urge??={}).frequency=v}, read: h=>h?.urge?.frequency },
    { key: 'ctxWindow', section: 'TEMPO', label: 'Context Window', desc: '额外保留最近多少分钟记录。', type: 'knob', min: 0, max: 1440, step: 5, integer: true, apply: (h,v)=>{(h.runtime??={}).contextTimeWindowMinutes=v}, read: h=>h?.runtime?.contextTimeWindowMinutes },
    { key: 'ctxEntries', section: 'TEMPO', label: 'Context Entries', desc: '写入主叙事的近期条目数（默认 17，rc57 起较旧版 35 减半）。小模型建议与 Context Window 一起调小（如 8 + 0）——两者叠加生效，只调一个会被另一个顶住。', type: 'knob', min: 1, max: 200, step: 1, integer: true, apply: (h,v)=>{(h.runtime??={}).contextEntryLimit=v}, read: h=>h?.runtime?.contextEntryLimit },
    { key: 'newlineSplit', section: 'TEMPO', label: 'Newline Split', desc: '小模型适配：模型没按合约输出 <sep/> 而用换行分条时，把换行当作消息边界再发送。Gemma 等小模型建议开启。', type: 'toggle', apply: (h,v)=>{(h.runtime??={}).convertNewlineToSeparator=v}, read: h=>h?.runtime?.convertNewlineToSeparator },
    { key: 'maxScriptChars', section: 'TEMPO', label: 'Max Script Chars', desc: '单次剧本上限。默认 1400（rc57 起）。', type: 'knob', min: 500, max: 12000, step: 500, integer: true, apply: (h,v)=>{(h.runtime??={}).maxScriptCharacters=v}, read: h=>h?.runtime?.maxScriptCharacters },
    { key: 'memoryEnabled', section: 'MEMORY', label: 'Memory System', desc: '场景压缩/事实/状态演化总开关。', hot: true, type: 'toggle', apply: (h,v)=>{(h.memory??={}).enabled=v}, read: h=>h?.memory?.enabled },
    { key: 'factLimit', section: 'MEMORY', label: 'Facts/Turn', desc: '每次附带长期事实数。', type: 'knob', min: 1, max: 200, step: 1, integer: true, apply: (h,v)=>{(h.memory??={}).factLimit=v}, read: h=>h?.memory?.factLimit },
    { key: 'recentEntryLimit', section: 'MEMORY', label: 'Entries/Turn', desc: '每次附带最近条目数。', type: 'knob', min: 1, max: 200, step: 1, integer: true, apply: (h,v)=>{(h.memory??={}).recentEntryLimit=v}, read: h=>h?.memory?.recentEntryLimit },
    { key: 'bgInterval', section: 'MEMORY', label: 'BG Interval', desc: '后台整理检查周期。', type: 'knob', min: 1, max: 1440, step: 1, integer: true, apply: (h,v)=>{(h.memory??={}).backgroundIntervalMinutes=v}, read: h=>h?.memory?.backgroundIntervalMinutes },
    { key: 'sceneTrigger', section: 'MEMORY', label: 'Scene Trigger', desc: '未压缩条目达到此数触发整理。', type: 'knob', min: 1, max: 500, step: 1, integer: true, apply: (h,v)=>{(h.memory??={}).sceneEntryThreshold=v}, read: h=>h?.memory?.sceneEntryThreshold },
    { key: 'patchConf', section: 'MEMORY', label: 'Patch Conf', desc: '设定变更最低置信度。', type: 'knob', min: 0.5, max: 1, step: 0.01, apply: (h,v)=>{(h.memory??={}).statePatchConfidenceThreshold=v}, read: h=>h?.memory?.statePatchConfidenceThreshold },
    { key: 'autoPatch', section: 'MEMORY', label: 'Auto Patch', desc: '自动应用设定演化。', type: 'toggle', apply: (h,v)=>{(h.memory??={}).autoApplyStatePatches=v}, read: h=>h?.memory?.autoApplyStatePatches },
    { key: 'consequences', section: 'MEMORY', label: 'Consequences', desc: '剧情余波持续影响。', type: 'toggle', apply: (h,v)=>{(h.memory??={}).activeConsequencesEnabled=v}, read: h=>h?.memory?.activeConsequencesEnabled },
    { key: 'conseqLimit', section: 'MEMORY', label: 'Conseq Limit', desc: '单次余波条数上限。', type: 'knob', min: 1, max: 20, step: 1, integer: true, apply: (h,v)=>{(h.memory??={}).activeConsequencePromptLimit=v}, read: h=>h?.memory?.activeConsequencePromptLimit },
    { key: 'maxFacts', section: 'MEMORY', label: 'Max Facts', desc: '单剧本事实总量上限。', type: 'knob', min: 10, max: 2000, step: 10, integer: true, apply: (h,v)=>{(h.memory??={}).maxFactsPerStory=v}, read: h=>h?.memory?.maxFactsPerStory },
    { key: 'prevScenes', section: 'MEMORY', label: 'Prev Scenes', desc: '附带已关闭场景摘要数。', type: 'knob', min: 0, max: 4, step: 1, integer: true, apply: (h,v)=>{(h.memory??={}).previousSceneSummaries=v}, read: h=>h?.memory?.previousSceneSummaries },
    { key: 'obFilter', section: 'CHANNEL', label: 'OneBot Filter', desc: '账号白名单过滤（空白名单=拒全部）。', type: 'toggle', apply: (h,v)=>{(h.onebot??={}).enabled=v}, read: h=>h?.onebot?.enabled },
    { key: 'chatActions', section: 'CHANNEL', label: 'Chat Actions', desc: '群聊引用/表情回应/原生表情。', type: 'toggle', apply: (h,v)=>{(h.chatActions??={}).enabled=v}, read: h=>h?.chatActions?.enabled },
    { key: 'exprThreshold', section: 'CHANNEL', label: 'Expr Threshold', desc: '原生表情发送意愿阈值。', type: 'knob', min: 0, max: 1, step: 0.05, apply: (h,v)=>{(h.chatActions??={}).expressionThreshold=v}, read: h=>h?.chatActions?.expressionThreshold },
    { key: 'voiceTranscribe', section: 'CHANNEL', label: 'Audio Understanding', desc: '语音/音频原生理解（须主模型支持音频输入，如 Gemini；SnowLuma 服务端转码后直传，不做文本转写）。', type: 'toggle', apply: (h,v)=>{((h.model??={}).audio??={}).enabled=v}, read: h=>h?.model?.audio?.enabled },
    { key: 'stickersEnabled', section: 'CHANNEL', label: 'Sticker Library', desc: '本地表情包：启用后扫描素材目录（默认 data/hds-interlude/stickers），由勾选“贴图”用途的模型建立描述后按语义选用。', type: 'toggle', apply: (h,v)=>{(h.stickers??={}).enabled=v}, read: h=>h?.stickers?.enabled },
    { key: 'logLevel', section: 'LOG', label: 'Level', desc: 'silent/error/warn/info/debug。排障用 debug。', hot: true, type: 'select', options: ['silent', 'error', 'warn', 'info', 'debug'], apply: (h,v)=>{(h.logging??={}).level=v}, read: h=>h?.logging?.level },
    { key: 'logVerbosity', section: 'LOG', label: 'Verbosity', desc: 'summary/standard/diagnostic。', type: 'select', options: ['summary', 'standard', 'diagnostic'], apply: (h,v)=>{(h.logging??={}).verbosity=v}, read: h=>h?.logging?.verbosity },
    { key: 'logPreview', section: 'LOG', label: 'Preview Length', desc: '日志预览字符数。', type: 'knob', min: 50, max: 4000, step: 50, integer: true, apply: (h,v)=>{(h.logging??={}).previewLength=v}, read: h=>h?.logging?.previewLength },
    { key: 'timeDirector', section: 'ADVANCED', label: 'Time Director', desc: '自动推进前先生成时间账本。', type: 'toggle', apply: (h,v)=>{(h.timelineDirector??={}).enabled=v}, read: h=>h?.timelineDirector?.enabled },
    { key: 'alterEnabled', section: 'ADVANCED', label: 'Alter System', desc: '情绪偏移系统。', type: 'toggle', apply: (h,v)=>{(h.alterSystem??={}).enabled=v}, read: h=>h?.alterSystem?.enabled },
    { key: 'alterThreshold', section: 'ADVANCED', label: 'Alter Trigger', desc: '情绪分析触发阈值。', type: 'knob', min: 1, max: 50, step: 1, integer: true, apply: (h,v)=>{(h.alterSystem??={}).baseThreshold=v}, read: h=>h?.alterSystem?.baseThreshold },
    { key: 'preplanEnabled', section: 'ADVANCED', label: 'Preplan', desc: '日程预排。', type: 'toggle', apply: (h,v)=>{(h.schedulePreplan??={}).enabled=v}, read: h=>h?.schedulePreplan?.enabled },
    { key: 'preplanHorizon', section: 'ADVANCED', label: 'Preplan Horizon', desc: '预排展望天数。', type: 'knob', min: 1, max: 30, step: 1, integer: true, apply: (h,v)=>{(h.schedulePreplan??={}).horizonDays=v}, read: h=>h?.schedulePreplan?.horizonDays },
    { key: 'blindMode', section: 'ADVANCED', label: 'Blind Mode', desc: '沉浸模式（日志屏蔽正文）。', type: 'toggle', apply: (h,v)=>{(h.blindMode??={}).enabled=v}, read: h=>h?.blindMode?.enabled },
    { key: 'splitMessages', section: 'ADVANCED', label: 'Split Messages', desc: '按分隔符拆多条消息。', type: 'toggle', apply: (h,v)=>{(h.runtime??={}).splitReplyMessages=v}, read: h=>h?.runtime?.splitReplyMessages },
    { key: 'worldSeederEnabled', section: 'ADVANCED', label: 'World Seeder', desc: '世界事件播种器：后台低频生成与她有关的外部事件（线下通道/NPC），到点以 [世界事件] 进入剧本。模型须在模型中心的连接上勾选“用于世界播种”。', type: 'toggle', apply: (h,v)=>{(h.worldSeeder??={}).enabled=v}, read: h=>h?.worldSeeder?.enabled },
    { key: 'seederCadence', section: 'ADVANCED', label: 'Seeder Cadence', desc: '播种器生成检查间隔（分钟）；含随机抖动，多数检查输出空。', type: 'knob', min: 5, max: 1440, step: 5, integer: true, apply: (h,v)=>{(h.worldSeeder??={}).cadenceMinutes=v}, read: h=>h?.worldSeeder?.cadenceMinutes },
    { key: 'seederDailyCap', section: 'ADVANCED', label: 'Seeder Daily Cap', desc: '播种器每 24 小时注入事件上限（高重要性每天至多 1 条）。', type: 'knob', min: 1, max: 20, step: 1, integer: true, apply: (h,v)=>{(h.worldSeeder??={}).dailyCap=v}, read: h=>h?.worldSeeder?.dailyCap },
    { key: 'weatherEnabled', section: 'ADVANCED', label: 'Weather', desc: '运行时天气：从 Open-Meteo（免费无 Key）拉取真实天气，以 [世界事件] 注入当前温度与天况；观测点默认从故事设定地点自动解析。架空世界会自动跳过。', hot: true, type: 'toggle', apply: (h,v)=>{(h.weather??={}).enabled=v}, read: h=>h?.weather?.enabled },
    { key: 'qzoneEnabled', section: 'ADVANCED', label: 'Qzone', desc: 'QQ 空间通道（需 SnowLuma 在线）：她可以发说说/评论/点赞，并感知好友动态；限额在 Console 的 qzone 分区调整。高频有风控风险，保持保守。', type: 'toggle', apply: (h,v)=>{(h.qzone??={}).enabled=v}, read: h=>h?.qzone?.enabled },
    { key: 'mainPrompt', section: 'ADVANCED', label: 'Main Prompt', desc: '⚠️ 除非有把握，否则不要修改。系统主提示词：与固定合约、文风和特化块协作塑造全部回合的写作行为。留空=内置默认；清空并保存=恢复默认。', type: 'text', apply: (h,v)=>{h.mainPrompt=v}, read: h=>h?.mainPrompt },
  ]
  registerHandle('stories:mixerRead', (_event, metaId: string) => {
    const handle = stories.get(String(metaId || ''))
    if (!handle) throw new Error('剧本不存在。')
    const doc = yaml.load(readFileSync(path.join(handle.dir, 'koishi.yml'), 'utf8')) as any
    const hdsiKey = Object.keys(doc?.plugins ?? {}).find(key => /^hds-interlude:/.test(key))
    const hdsi = hdsiKey ? doc.plugins[hdsiKey] : {}
    return MIXER_PARAMS.map(param => {
      const raw = param.read(hdsi)
      const value = param.type === 'knob'
        ? (typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined)
        : (raw ?? undefined)
      return { key: param.key, section: param.section, label: param.label, desc: param.desc,
        hot: param.hot ?? false, type: param.type,
        min: param.min, max: param.max, step: param.step,
        options: param.options, value }
    })
  })
  registerHandle('stories:mixerWrite', async (_event, metaId: string, patch: unknown) => {
    const handle = stories.get(String(metaId || ''))
    if (!handle) throw new Error('剧本不存在。')
    const input = patch && typeof patch === 'object' ? patch as Record<string, unknown> : {}
    const file = path.join(handle.dir, 'koishi.yml')
    const doc = yaml.load(readFileSync(file, 'utf8')) as any
    if (!doc?.plugins || typeof doc.plugins !== 'object') throw new Error('剧本配置缺少 plugins 段。')
    const hdsiKey = Object.keys(doc.plugins).find(key => /^hds-interlude:/.test(key)) ?? 'hds-interlude:m0'
    doc.plugins[hdsiKey] ??= {}
    const applied: Array<{ key: string, value: unknown }> = []
    for (const param of MIXER_PARAMS) {
      const raw = input[param.key]
      if (!Object.hasOwn(input, param.key) || raw === undefined || (raw === '' && param.type !== 'text')) continue
      if (raw === null) {
        // Undefined object properties are omitted by YAML; remove them explicitly so inheritance survives a reload.
        param.apply(doc.plugins[hdsiKey], undefined)
        const prune = (node: any) => {
          if (!node || typeof node !== 'object') return
          for (const key of Object.keys(node)) { if (node[key] === undefined) delete node[key]; else prune(node[key]) }
        }
        prune(doc.plugins[hdsiKey])
        applied.push({ key: param.key, value: null })
        continue
      }
      if (param.type === 'knob') {
        const value = Number(raw)
        if (!Number.isFinite(value) || value < (param.min ?? -Infinity) || value > (param.max ?? Infinity)) throw new Error(`参数 ${param.key} 超出范围 [${param.min ?? '-∞'}, ${param.max ?? '∞'}]。`)
        const decimals = Math.max(0, Math.ceil(-Math.log10(param.step ?? 1)))
        const clamped = param.integer ? Math.round(value) : Number((Math.round(value / (param.step ?? 1)) * (param.step ?? 1)).toFixed(decimals))
        param.apply(doc.plugins[hdsiKey], clamped)
        applied.push({ key: param.key, value: clamped })
      } else {
        // Validate IPC values independently of renderer control type.
        if (param.type === 'toggle' && typeof raw !== 'boolean') throw new Error(param.key + ' 必须是布尔值。')
        if (param.type === 'select' && (typeof raw !== 'string' || !param.options?.includes(raw))) throw new Error(param.key + ' 不是有效选项。')
        param.apply(doc.plugins[hdsiKey], raw)
        applied.push({ key: param.key, value: raw })
      }

    }
    if (!applied.length) return { applied, reloaded: false, needsReload: false }
    config.save(handle.dir, yaml.dump(doc, { lineWidth: 160, noRefs: true }))
    const needsReload = Boolean(handle.running)
    broadcast('story:log', { storyId: metaId, line: `[mixer] 已写入 ${applied.map(item => `${item.key}=${item.value}`).join('、')}（canonical 已备份；${needsReload ? 'Worker 仍运行旧配置，等待用户确认重载' : 'Worker 当前未加载'}）。` })
    return { applied, reloaded: false, needsReload }
  })
}

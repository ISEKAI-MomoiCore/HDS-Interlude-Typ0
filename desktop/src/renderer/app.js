var scrollerEl = null
var scrollerDrag = null
// Persist task-specific panel choices separately; saved Timeline layouts stay intact.
var taskPanelOverrides = new Map()

// P2-3：preload 桥缺失（打包路径错/上下文隔离异常）时，renderer 整个脚本会在
// 第一次 desktop.* 调用处中止——用户只看到永久白屏。这里改为渲染本地错误页
// 并停止执行，给出重载入口而不是无声死亡。
const desktop = window.hdsiDesktop
if (!desktop || typeof desktop.stories?.list !== 'function') {
  document.addEventListener('DOMContentLoaded', () => {
    document.body.innerHTML = `
      <div style="min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0f1216;color:#e6e9ef;font-family:system-ui,sans-serif">
        <div style="max-width:520px;padding:32px;border:1px solid #2a3140;border-radius:10px">
          <h2 style="margin:0 0 12px;font-size:16px">界面加载失败</h2>
          <p style="margin:0 0 8px;font-size:13px;color:#9aa4b5">桌面桥（preload）未正确加载。应用的其余部分（故事数据、Worker 进程）不受影响。</p>
          <p style="margin:0 0 16px;font-size:12px;color:#6b7688">可尝试重新加载界面；若持续出现，请附带日志目录（可在主进程数据目录 logs/ 下找到）反馈。</p>
          <button data-reload-ui style="padding:8px 18px;font-size:13px;background:#3b82f6;color:#fff;border:none;border-radius:6px;cursor:pointer">重新加载</button>
        </div>
      </div>`
    // CSP default-src 'self' 不放行内联事件——必须用监听器绑定，否则这个
    // 唯一的恢复按钮在 preload 失败页上同样点不动。
    document.querySelector('[data-reload-ui]')?.addEventListener('click', () => location.reload())
  })
  throw new Error('hdsiDesktop preload bridge missing — renderer halted with local error page')
}
const phases = { running: '运行', muted: '静音', paused: '暂停' }
const defaultState = { surface: 'studio', storyId: '', detail: 'events', browserView: 'overview', viewMode: 'workbench' }
const defaultTracks = { script: true, receive: true, send: true, alter: true, state: true, preplan: true, media: true, compaction: false }
const defaultLayout = { followNow: true, spanMinutes: 14 * 60, centerAt: null, tracks: { ...defaultTracks }, panels: { browser: true, inspector: true, detail: true } }
function readWorkspace() {
  try { return JSON.parse(localStorage.getItem('hdsi.typ0.workspace') || '{}') || {} }
  catch { return {} }
}
const restoredWorkspace = readWorkspace()
const state = { ...defaultState, ...restoredWorkspace, storyLayouts: restoredWorkspace.storyLayouts || {}, stories: [], snapshot: null, logs: [], deliveries: [], usage: [], hostOverview: null, deliveryHistory: [], usageSeries: [], selection: restoredWorkspace.selection || null }
// Explicit task panel choices survive reload without altering Timeline preferences.
for (const [key, value] of Object.entries(restoredWorkspace.taskPanels || {})) {
  if (!value || typeof value !== 'object') continue
  const panels = Object.fromEntries(['inspector', 'detail'].filter(name => typeof value[name] === 'boolean').map(name => [name, value[name]]))
  taskPanelOverrides.set(key, panels)
}
const logIds = new Set()
const byId = id => document.getElementById(id)
let configuredStoryId = null
// P2-2：未绑定账号消息计数——此前进 unassigned-inbox.json 后完全不可见。
let unassignedInboxCount = 0
// 配置对话框脏标记：yaml 与结构化两个保存路径互斥，关闭前据此提示丢弃
let configYamlDirty = false
let configLoadSeq = 0
let configSectionsReady = false
let configSaving = false
// Phase B（§10.2）：统一 Config Draft——分面板脏集合 + 序列化基线（预览/保存全部依据）。
let configDirtyPanels = new Set()
let configYamlBaseline = ''
let configSectionsBaseline = ''
const CONFIG_PANEL_LABELS = { story: '人设与故事', users: '用户白名单', groups: '群聊管理', bots: '机器人', providers: '模型提供商', yaml: 'YAML' }
/** 标签页 → 配置节。secrets/plugins 有各自的保存入口，不在此表。 */
const CONFIG_PANEL_SECTIONS = { story: 'storyDefaults', users: 'userAccounts', groups: 'groupChats', bots: 'botAccounts', providers: 'providers' }

/** 序列化当前结构化草稿（与 saveConfigSections 同源，只读不写）。 */
function serializeConfigSections() {
  const payload = {}
  const panel = document.querySelector('[data-config-panel="story"]')
  const storyData = {}
  if (panel) for (const el of panel.querySelectorAll('[data-cfg]')) {
    if (el.dataset.cfgArray !== undefined) {
      const lines = el.value.split('\n').map(line => line.trim()).filter(Boolean)
      if (lines.length) storyData[el.dataset.cfg] = lines
      else if (Array.isArray(configSectionData?.storyDefaults?.[el.dataset.cfg]) && configSectionData.storyDefaults[el.dataset.cfg].length) storyData[el.dataset.cfg] = []
    }
    else storyData[el.dataset.cfg] = el.value.trim()
  }
  payload.storyDefaults = storyData
  for (const [containerId, section] of [
    ['cfg-users-list', 'userAccounts'], ['cfg-groups-list', 'groupChats'],
    ['cfg-bots-list', 'botAccounts'], ['cfg-providers-list', 'providers'],
  ]) {
    const container = byId(containerId)
    if (!container) { payload[section] = null; continue }
    payload[section] = [...container.querySelectorAll('.cfg-card')].map(card => {
      const loaded = card.__loadedRow
      const row = (loaded && typeof loaded === 'object') ? { ...loaded } : {}
      for (const el of card.querySelectorAll('[data-row]')) {
        const key = el.dataset.row
        if (key === 'enabled') row[key] = el.classList.contains('on')
        else if (el.type === 'number') { const raw = el.value.trim(); if (raw === '') delete row[key]; else { const parsed = Number(raw); if (Number.isFinite(parsed)) row[key] = parsed; else delete row[key] } }
        else if (el.type === 'checkbox') row[key] = el.checked
        else row[key] = el.value.trim()
      }
      const wEl = card.querySelector('[data-w]')
      if (wEl) {
        // 审计：rc52 willingness 还带 replyCost/baseGain/quoteGain/keywordGain/keywords
        // 子字段（Console 可调），整对象重建会把它们抹回默认——合并保留。
        const loadedWillingness = loaded && typeof loaded.willingness === 'object' && loaded.willingness ? loaded.willingness : {}
        // 数值门只在 custom 档启用：无条件 enabled:true 会让插件把
        // "档位=关闭 + 旧数值门 enabled" 兼容解析成 custom（意愿门静默开启）。
        row.willingness = { ...loadedWillingness, enabled: row.willingnessPreset === 'custom' }
        for (const wel of card.querySelectorAll('[data-w]')) { const parsed = Number(wel.value); if (wel.value.trim() !== '' && Number.isFinite(parsed)) row.willingness[wel.dataset.w] = parsed }
      }
      return row
    })
  }
  return payload
}

/** P1-3：非 input 途径的修改（开关/删行/加行）统一走此标记——此前只设
 * configSectionsDirty 不进 configDirtyPanels，脏徽标/保存全部/关闭确认全部漏判。 */
function markConfigPanelDirty(panelEl) {
  const panel = panelEl?.closest?.('[data-config-panel]')
  if (!panel || panel.dataset.configPanel === 'secrets' || panel.dataset.configPanel === 'plugins') return
  configSectionsDirty = true
  configDirtyPanels.add(panel.dataset.configPanel)
  configDraftSummary()
}

function configDraftSummary() {
  const parts = [...configDirtyPanels].map(id => CONFIG_PANEL_LABELS[id] ?? id)
  const badge = byId('config-dirty-badge')
  if (badge) {
    if (!parts.length) { badge.hidden = true; badge.textContent = '' }
    else {
      const mixed = configDirtyPanels.has('yaml') && configDirtyPanels.size > 1
      badge.hidden = false
      badge.textContent = (mixed ? '混合草稿 · ' : '未保存 · ') + parts.join(' · ')
      badge.classList.toggle('mixed', mixed)
    }
  }
  updateConfigActions()
  return parts
}


function updateConfigActions() {
  const panel = document.querySelector('.config-tab-panel.active')?.dataset.configPanel || 'story'
  const immediate = ['secrets', 'plugins'].includes(panel)
  const mixed = configDirtyPanels.has('yaml') && configDirtyPanels.size > 1
  const current = byId('config-save'), all = byId('config-save-all')
  if (current) {
    current.hidden = immediate
    current.textContent = panel === 'yaml' ? '仅保存 YAML' : '仅保存本页'
    current.disabled = !configSectionsReady || configSaving
  }
  if (all) {
    all.hidden = immediate && configDirtyPanels.size === 0
    all.textContent = configSaving ? '正在保存…' : mixed ? '处理草稿冲突' : immediate ? '保存其他页面草稿' : '保存全部草稿'
    all.disabled = !configSectionsReady || configSaving
  }
  const scopes = {
    secrets: '立即保存到本机密钥库，不包含在“保存全部草稿”中；此处不会展示已存密钥原文。',
    plugins: '插件操作将立即写入，不包含在“保存全部草稿”中；运行中的 Worker 需确认重载。',
    yaml: 'YAML 是完整配置。请勿与表单草稿混合覆盖；保存不会自动重载 Worker。',
  }
  const body = document.querySelector('#config-form .config-body')
  if (body) body.inert = configSaving || !configSectionsReady
  document.querySelectorAll('#config-revert,#config-dialog button[value=cancel],#config-cancel').forEach(button => { button.disabled = configSaving })
  const scope = byId('config-save-scope')
  if (scope) scope.textContent = mixed ? 'YAML 与表单均有修改。为避免互相覆盖，请先选择一个来源保存；另一个来源的草稿会保留。' : scopes[panel] || '表单修改暂存在草稿中。“保存全部草稿”只提交有修改的分区，不自动重载 Worker。'
  document.querySelectorAll('[data-config-tab]').forEach(button => {
    button.classList.toggle('has-draft', configDirtyPanels.has(button.dataset.configTab))
    button.setAttribute('aria-selected', String(button.classList.contains('active')))
    button.tabIndex = button.classList.contains('active') ? 0 : -1
  })
}

// Persistent labels replace placeholder-only identity fields. Data attributes and
// serializers stay unchanged so the form continues using the existing IPC schema.
function organizeConfigCard(card, type) {
  card.dataset.cardType = type
  const header = card.querySelector('.cfg-card-header')
  if (!header) return
  const labels = { qq: type === 'botAccounts' ? '机器人 QQ 号' : 'QQ 号', label: type === 'providers' ? '连接名称' : type === 'groupChats' ? '群名称' : '称呼 / 备注', personId:'人物 ID', groupId:'群号', responseMode:'响应方式', contextLimit:'上下文条数', cooldownSeconds:'冷却秒数', mode:'接口类型', model:'模型名称', endpoint:'API 端点' }
  for (const control of [...header.children].filter(node => node.matches('input,select'))) {
    const label = document.createElement('label'); label.className = 'cfg-field'
    const title = document.createElement('span'); title.textContent = labels[control.dataset.row] || control.placeholder || control.dataset.row
    control.before(label); label.append(title, control)
  }
  const actions = document.createElement('div'); actions.className = 'cfg-card-actions'
  for (const control of [...header.children].filter(node => node.matches('.cfg-toggle-mini,button'))) actions.appendChild(control)
  header.appendChild(actions)
  const toggle = card.querySelector('.cfg-toggle-mini')
  if (toggle) {
    toggle.setAttribute('role','switch'); toggle.tabIndex = 0
    toggle.setAttribute('aria-label','启用此条目'); toggle.setAttribute('aria-checked',String(toggle.classList.contains('on')))
    toggle.textContent = '启用此条目'
    toggle.addEventListener('keydown',event=>{if(event.key===' '||event.key==='Enter'){event.preventDefault();toggle.click()}})
  }
}

function renderUiState(target, {kind='empty', title, body, detail='', action, onAction}) {
  const node = document.createElement('section'); node.className = `ui-state ui-state--${kind}`; node.dataset.state = kind
  node.innerHTML = `<span class="ui-state-label">${escapeHtml({empty:'暂无内容',error:'暂时无法读取',unsupported:'当前不可用',idle:'尚未就绪'}[kind] || '状态')}</span><h3>${escapeHtml(title)}</h3><p>${escapeHtml(body)}</p>${detail ? `<details><summary>技术信息</summary><pre>${escapeHtml(detail)}</pre></details>` : ''}`
  if (action) { const button=document.createElement('button');button.type='button';button.textContent=action;button.addEventListener('click',onAction);node.appendChild(button) }
  target.replaceChildren(node)
  return node
}

function configPreviewText() {
  const lines = []
  if (configDirtyPanels.has('yaml')) {
    const current = byId('config-source')?.value ?? ''
    const oldLines = configYamlBaseline.split('\n')
    const newLines = current.split('\n')
    let added = 0, removed = 0
    const oldSet = new Map(); for (const l of oldLines) oldSet.set(l, (oldSet.get(l) ?? 0) + 1)
    for (const l of newLines) { const n = oldSet.get(l) ?? 0; if (n > 0) oldSet.set(l, n - 1); else added += 1 }
    for (const [l, n] of oldSet) if (n > 0) removed += n
    lines.push(`YAML：+${added} / -${removed} 行（相对上次保存）`)
  }
  if ([...configDirtyPanels].some(id => id !== 'yaml')) {
    try {
      const now = serializeConfigSections()
      const before = JSON.parse(configSectionsBaseline || '{}')
      for (const section of Object.keys(now)) {
        const a = JSON.stringify(before[section] ?? null); const b = JSON.stringify(now[section])
        if (a !== b) {
          const beforeCount = Array.isArray(before[section]) ? before[section].length : '-'
          const nowCount = Array.isArray(now[section]) ? now[section].length : '-'
          lines.push(`${CONFIG_PANEL_LABELS[{ storyDefaults: 'story', userAccounts: 'users', groupChats: 'groups', botAccounts: 'bots', providers: 'providers' }[section]] ?? section}: 有变更（${beforeCount} → ${nowCount} 行）`)
        }
      }
    } catch { lines.push('配置节：序列化比对失败（以保存结果为准）') }
  }
  if (!lines.length) lines.push('当前没有未保存的修改。')
  return lines.join('\n')
}
let configSectionsDirty = false
// 配置保存与运行实例分离：保存结构化配置时不静默中断 Worker，连接页提供唯一的
// 明确重载主动作。集合只记录本次桌面会话内已知的“磁盘配置领先于 Worker”状态。
const needsReloadStoryIds = new Set()
let workerAction = null
let refreshFailureCount = 0
let refreshRequestSeq = 0
let connectRenderSeq = 0
let readyPanelSeq = 0
let snapshotRequestRevision = 0
let viewportRefreshTimer = null

function persist() {
  localStorage.setItem('hdsi.typ0.workspace', JSON.stringify({
    surface: state.surface, storyId: state.storyId, detail: state.detail, browserView: state.browserView, viewMode: state.viewMode,
    storyLayouts: state.storyLayouts, selection: state.selection, taskPanels: Object.fromEntries(taskPanelOverrides),
  }))
}
function escapeHtml(value) { return String(value ?? '').replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char])) }
function selectedStory() { return state.stories.find(story => story.meta.id === state.storyId) }
function safeTimezone() { try { new Intl.DateTimeFormat('zh-CN', { timeZone: state.snapshot?.timezone }); return state.snapshot?.timezone || undefined } catch { return undefined } }
var dateTextFormatterCache = {}
function dateText(value) {
  const date = new Date(value); if (Number.isNaN(date.getTime())) return '—'
  const tz = safeTimezone() || ''
  // Intl 构造成本高（paint 路径每帧多次调用），按时区缓存格式化器
  const format = dateTextFormatterCache[tz] || (dateTextFormatterCache[tz] = new Intl.DateTimeFormat('zh-CN', { timeZone: tz || undefined }))
  return format.format(date)
}
/** 日志行时间：与剧本时间共用故事时区的同一口钟（此前用机器本地时区，跨时区部署对不上）。 */
function logTimeText(value) {
  const date = new Date(value); if (Number.isNaN(date.getTime())) return '—'
  const tz = safeTimezone() || ''
  const format = dateTextFormatterCache['log:' + tz] || (dateTextFormatterCache['log:' + tz] = new Intl.DateTimeFormat('zh-CN', { timeZone: tz || undefined, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }))
  return format.format(date)
}
// 写入守卫：值未变化时不触碰 DOM，避免 60fps 重绘时的无谓失效与闪烁
function setStyle(el, prop, value) { if (el.style[prop] !== value) el.style[prop] = value }
function setText(el, value) { if (el.textContent !== value) el.textContent = value }
function compact(value, length = 80) { const text = String(value || '').replace(/\s+/g, ' ').trim(); return text.length > length ? `${text.slice(0, length)}…` : text }
/** 交互错误统一反馈：日志留档 + 当前界面 Toast——此前错误只进 Logs 页，操作发生处毫无变化。 */
function reportUserError(storyId, message) {
  appendLog({ storyId: storyId || 'shell', line: message })
  showToast(message, 'err')
}
function layoutFor(storyId = state.storyId) {
  const id = storyId || '__desktop__'
  const previous = state.storyLayouts[id] || {}
  // 启动/读取时清理坏 viewport：centerAt 非有限数值时重置回 NOW
  if (previous.centerAt) {
    const c = new Date(previous.centerAt).getTime()
    if (!Number.isFinite(c) || Math.abs(c) > 8e15) { previous.centerAt = null; previous.followNow = true }
  }
  const layout = {
    ...defaultLayout, ...previous,
    spanMinutes: bounded(Number(previous.spanMinutes) || defaultLayout.spanMinutes, 1/3, 14 * 24 * 60),
    tracks: { ...defaultTracks, ...(previous.tracks || {}) },
    panels: { ...defaultLayout.panels, ...(previous.panels || {}) },
  }
  state.storyLayouts[id] = layout
  return layout
}
function timelineViewport(storyId = state.storyId) {
  const layout = layoutFor(storyId)
  const span = layout.spanMinutes * 60 * 1000
  const center = toMillis(layout.centerAt) ?? Date.now()
  if (!layout.centerAt) layout.centerAt = new Date(center).toISOString()
  return { from: new Date(center - span / 2).toISOString(), to: new Date(center + span / 2).toISOString(), center, span, followNow: layout.followNow }
}
const REGISTERED_TRACKS = ['script', 'receive', 'send', 'alter', 'state', 'preplan', 'media', 'compaction']
// ── 虚拟画布坐标系（DAW 式：clip 绝对像素定位，transform 滚动） ─────────
var canvas = { originMs: 0, pxPerMs: 0.02, scrollMs: 0, totalMs: 0, viewWidthPx: 800 }

function updateCanvasFromViewport() {
  const vp = timelineViewport(), arr = byId('arrangement')
  canvas.headerWidth = arr?.querySelector('.arrangement-track > header')?.getBoundingClientRect().width || 132
  canvas.viewWidthPx = Math.max(1,(arr?.clientWidth || 932)-canvas.headerWidth)
  canvas.originMs = Date.parse(vp.from); canvas.totalMs = vp.span
  canvas.pxPerMs = canvas.viewWidthPx/vp.span; canvas.scrollMs = 0
  // 播放头几何基准每次布局/重绘时缓存一次（rAF 动画循环只做算术+transform 写入）
  refreshPlayheadGeometry()
}

/** 播放头几何（相对画布父容器的 x/y/h）。独立出来：布局变化（HUD↔Timeline
 *  切换过渡、面板开合、窗口缩放）时由 ResizeObserver 重测，否则 rAF 循环一直
 *  拿旧高度画"半截 NOW 线"——renderArrangement 的快路径不重测 canvas。 */
function refreshPlayheadGeometry() {
  const arr = byId('arrangement')
  if (arr && arr.parentElement) {
    const arrRect = arr.getBoundingClientRect(), parentRect = arr.parentElement.getBoundingClientRect()
    canvas.playhead = { x: arrRect.left - parentRect.left + canvas.headerWidth, y: arrRect.top - parentRect.top, h: arrRect.height }
  }
}

function timeToPx(ms) { return (ms - canvas.originMs) * canvas.pxPerMs }
function pxToTime(px) { return canvas.originMs + px / canvas.pxPerMs }
function activeTrackCount() { return REGISTERED_TRACKS.filter(key => layoutFor().tracks[key]).length }

// 宿主事件（story:log 与 logs:record）经由这里进入可见窗口。Follow 关闭时新
// 记录进入 paused 缓冲，恢复 Follow 或点击 backlog 提示时一次性补齐。
var rendererLogSeq = 0
function appendLog(event, render = true) {
  // 审查T3: 渲染器自产日志也要有 id——renderLogs 增量分支按 id 去重，无 id 会被静默吞掉。
  const item = { id: `renderer-${Date.now().toString(36)}-${rendererLogSeq++}`, at: new Date().toISOString(), storyId: event.storyId || 'shell', line: String(event.line || ''), source: 'renderer', level: 'info' }
  appendLogItem(item, render)
}

function appendLogRecord(record, render = true) {
  if (!record || !record.id || logIds.has(record.id)) return
  logIds.add(record.id)
  appendLogItem({ id: record.id, at: record.at || new Date().toISOString(), storyId: record.storyId || 'desktop', line: String(record.message || ''), source: record.source || 'desktop', level: record.level || 'info', correlation: record.correlation }, render)
  window.HDSIViewModel?.notify('logs')
}

const inboxReasonLabels = { 'worker-timeout': '等待确认超时', 'worker-rejected': 'worker 拒收', 'worker-unavailable': 'worker 不可用', muted: '静音', paused: '暂停' }
function humanizeInboxReasons(text) {
  return text.replace(/入站消息已进入收件箱：([\w-]+)/u, (_m, reason) => `入站消息已进入收件箱：${inboxReasonLabels[reason] || reason}`)
}

function appendLogItem(item, render) {
  // UI-33: 剥离 ANSI 终端控制序列（渲染层只显示纯文本）
  item.line = String(item.line || '').replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
  item.line = humanizeInboxReasons(item.line)
  if (!logView.following && state.surface === 'logs') {
    logView.paused.push(item)
    logView.backlog = logView.paused.length
    if (logView.paused.length > 2_000) logView.paused.splice(0, logView.paused.length - 2_000)
    byId('log-backlog').textContent = `PAUSED ${logView.backlog} 条待补齐`
    return
  }
  state.logs.push(item)
  if (state.logs.length > 4_000) {
    const removed = state.logs.splice(0, state.logs.length - 4_000)
    removed.forEach(removedItem => { if (removedItem.id) logIds.delete(removedItem.id) })
  }
  if (render && state.surface === 'logs') renderLogs(false)
}

/** 复审：暂停跟随的缓冲不走宿主查询（查询自带过滤），恢复/补齐合并回列表前
 *  必须按当前 logFilter 重筛——否则改过过滤条件后，暂停期间到达的旧日志会
 *  无条件塞回列表，与过滤后的视图不一致。 */
function logMatchesFilter(item) {
  if (logFilter.levels.size && !logFilter.levels.has(item.level || 'info')) return false
  if (logFilter.source && item.source !== logFilter.source) return false
  if (logFilter.search) {
    const haystack = String(item.line || item.message || '').toLowerCase()
    if (!haystack.includes(logFilter.search.toLowerCase())) return false
  }
  if (logFilter.correlationId && item.correlationId !== logFilter.correlationId) return false
  return true
}

function resumeLogFollow() {
  logView.following = true
  byId('log-follow').checked = true
  if (logView.paused.length) {
    logView.paused.forEach(item => { if (logMatchesFilter(item)) state.logs.push(item) })
    logView.paused = []
    logView.backlog = 0
    byId('log-backlog').textContent = ''
  }
  byId('logs-status').textContent = '已恢复跟随'
  renderLogs(true)
}

// ── M5 Logs Surface：虚拟化 + 过滤 + 分页 + Follow/Pause ────────────────────
// state.logs 只承载当前故事的可见窗口（内存上限），历史通过 before 游标向宿主分页。
const logFilter = { levels: new Set(), source: '', search: '', correlationId: '' }
const logView = { following: true, loadingOlder: false, exhausted: false, paused: [], backlog: 0, openId: null, selectedId: null }
const LOG_RENDER_CHUNK = 160
let logRenderCount = 0
let logHydrateSeq = 0
/** 最近一次成功补齐所对齐的故事：refresh() 只在换故事时重建日志视图，
 *  后台事件（入站消息/阶段变化）不再把暂停跟随的读者拽回底部。 */
let logHydratedFor = null
let logOlderSeq = 0

function visibleLogs() {
  return state.logs.filter(item => !state.storyId || item.storyId === state.storyId || item.storyId === 'desktop')
}

function logQueryBase(extra = {}) {
  return {
    storyId: state.storyId || undefined,
    levels: logFilter.levels.size ? [...logFilter.levels] : undefined,
    sources: logFilter.source ? [logFilter.source] : undefined,
    search: logFilter.search || undefined,
    correlationId: logFilter.correlationId || undefined,
    ...extra,
  }
}

function logRowClass(item) {
  const level = item.level || 'info'
  const classes = ['log-row']
  if (level === 'error') classes.push('error')
  else if (level === 'warn') classes.push('warn')
  if (item.id && item.id === logView.openId) classes.push('log-open')
  if (item.id && item.id === logView.selectedId) classes.push('selected')
  return classes.join(' ')
}

function renderLogRow(item) {
  const row = document.createElement('div')
  row.className = logRowClass(item)
  row.dataset.id = item.id || ''
  row.innerHTML = `<time>${escapeHtml(logTimeText(item.at))}</time><b>${escapeHtml(`${item.storyId || 'desktop'} · ${item.source || 'desktop'} · ${item.level || 'info'}`)}</b><span>${escapeHtml(item.line || item.message || '')}</span>`
  row.addEventListener('click', () => toggleLogRow(item.id))
  return row
}

function toggleLogRow(id) {
  if (!id) return
  logView.openId = logView.openId === id ? null : id
  logView.selectedId = id
  renderLogs(false)
}

/** 窗口化渲染：只为可见滚动区间附近创建 DOM，向上滚动时分块补齐更早记录。 */
function renderLogs(scrollToBottom = logView.following) {
  const scroll = byId('logs-scroll')
  const list = byId('logs-vlist')
  if (!scroll || !list) return
  const rows = visibleLogs()
  // 首次/翻页后全量重建；增量追加时只补新块，避免高频日志反复重排。
  const fullRender = logRenderCount === 0 || rows.length < logRenderCount || rows.length - logRenderCount > LOG_RENDER_CHUNK
  const previousHeight = scroll.scrollHeight
  const atBottom = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 40

  if (fullRender) {
    list.replaceChildren()
    const fragment = document.createDocumentFragment()
    const visible = rows.slice(-LOG_RENDER_CHUNK * 4)
    visible.forEach(item => fragment.appendChild(renderLogRow(item)))
    list.appendChild(fragment)
    logRenderCount = visible.length
    if (rows.length > visible.length) {
      const older = document.createElement('button')
      older.className = 'logs-older'
      older.textContent = `载入更早记录（${rows.length - visible.length} 条被折叠）`
      older.addEventListener('click', () => void loadOlderLogs())
      list.prepend(older)
    }
  } else {
    // UI-34: 增量追加新行（之前只更新计数，新日志可能不显示）
    const existingIds = new Set([...list.children].map(child => child.dataset?.id).filter(Boolean))
    const newRows = rows.filter(row => row.id && !existingIds.has(row.id))
    if (newRows.length) {
      const fragment = document.createDocumentFragment()
      newRows.forEach(item => fragment.appendChild(renderLogRow(item)))
      list.appendChild(fragment)
    }
    logRenderCount = rows.length
  }
  if (!rows.length) {
    const filtered = logFilter.levels.size || logFilter.source || logFilter.search || logFilter.correlationId
    renderUiState(list, {title:filtered ? '没有匹配的日志' : '还没有日志记录', body:filtered ? '当前筛选条件没有返回记录，可以清除筛选后重试。' : 'Worker 和连接产生新事件后，记录会出现在这里。', action:filtered ? '清除筛选' : '重新读取', onAction:()=>{
      if(filtered){byId('log-level-filter').selectedIndex=0;byId('log-source-filter').value='';byId('log-search').value='';byId('log-correlation').value='';applyLogFilters()}
      else void hydrateLogs()
    }})
  } else list.querySelector('.ui-state')?.remove()
  const backlogNode = byId('log-backlog')
  if (backlogNode) backlogNode.textContent = logView.backlog > 0 ? `PAUSED ${logView.backlog} 条待补齐` : ''
  byId('logs-count').textContent = `${rows.length} records`
  const newest = rows.at(-1)
  byId('logs-range').textContent = rows.length ? `${dateText(rows[0].at).slice(5)} → ${dateText(newest.at).slice(5)}` : ''
  if (scrollToBottom || atBottom) scroll.scrollTop = scroll.scrollHeight
  else scroll.scrollTop += scroll.scrollHeight - previousHeight
}

async function hydrateLogs() {
  const requestSeq = ++logHydrateSeq
  const requestedStoryId = state.storyId
  // 暂停跟随的缓冲不被后台补齐清空：同故事的缓冲在重建后保留未落盘条目，
  // 换故事时旧缓冲随视图一起作废。
  const pausedBefore = logView.paused
  const sameStory = logHydratedFor === requestedStoryId
  logRenderCount = 0
  logView.exhausted = false
  logView.paused = []
  logView.backlog = 0
  try {
    // 审查T5: 记录 fetch 前的长度，await 期间经 onLogRecord 到达的实时条目在重建后补回。
    const preCount = state.logs.length
    const records = await desktop.logs.query(logQueryBase({ limit: 500 }))
    if (requestSeq !== logHydrateSeq || requestedStoryId !== state.storyId) return
    const arrived = state.logs.slice(preCount)
    logIds.clear()
    state.logs = []
    // 宿主返回 newest-first；日志窗格天然按时间顺序展示。
    records.slice().reverse().forEach(record => appendLogRecord(record, false))
    arrived.forEach(record => { if (!record.id || !logIds.has(record.id)) appendLogRecord(record, false) })
    if (sameStory) for (const item of pausedBefore) if ((!item.id || !logIds.has(item.id)) && logMatchesFilter(item)) logView.paused.push(item)
    logView.backlog = logView.paused.length
    logHydratedFor = requestedStoryId
    renderLogs(logView.following)
    byId('logs-status').textContent = `已从磁盘补齐 ${records.length} 条（最近优先）`
  } catch (error) {
    if (requestSeq === logHydrateSeq && requestedStoryId === state.storyId) appendLog({ storyId: state.storyId || 'shell', line: `读取持久化日志失败：${error}` })
  }
}

async function loadOlderLogs() {
  if (logView.loadingOlder || logView.exhausted) return
  const oldest = state.logs.find(item => item.id)
  if (!oldest) return
  logView.loadingOlder = true
  const requestSeq = ++logOlderSeq
  const requestedStoryId = state.storyId
  try {
    const records = await desktop.logs.query(logQueryBase({ before: oldest.id, limit: 500 }))
    if (requestSeq !== logOlderSeq || requestedStoryId !== state.storyId) return
    if (!records.length) { logView.exhausted = true; byId('logs-status').textContent = '已到达最早记录'; return }
    // 审计修复：宿主返回新→旧；逐条 unshift 天然得到旧→新，reverse 反而局部倒序。
    records.forEach(record => { logIds.add(record.id); state.logs.unshift(record) })
    // 审查T6: 向上翻页无界增长——硬上限 12000，超出丢最旧（磁盘可重查）。
    if (state.logs.length > 12000) state.logs = state.logs.slice(-12000)
    logRenderCount = 0
    renderLogs(false)
  } catch (error) {
    if (requestSeq === logOlderSeq && requestedStoryId === state.storyId) appendLog({ storyId: state.storyId || 'shell', line: `载入更早日志失败：${error}` })
  } finally { if (requestSeq === logOlderSeq) logView.loadingOlder = false }
}

function applyLogFilters() {
  // 等级下拉是单选语义；映射回下游（本地筛选 + 磁盘补齐 query）共用的
  // logFilter.levels 集合：'' = 不过滤，'debug'/'error' = 精确一级，
  // 'info+'/'warn+' = 阈值（该级及以上）。
  const levelValue = byId('log-level-filter').value
  const LEVEL_FILTERS = { '': [], debug: ['debug'], 'info+': ['info', 'warn', 'error'], 'warn+': ['warn', 'error'], error: ['error'] }
  logFilter.levels = new Set(LEVEL_FILTERS[levelValue] ?? [])
  logFilter.source = byId('log-source-filter').value
  logFilter.search = byId('log-search').value.trim()
  logFilter.correlationId = byId('log-correlation').value.trim()
  logRenderCount = 0
  void hydrateLogs()
}

function setupLogsSurface() {
  // 旧实现是 <select multiple> + focus 展开/blur 收起的 size 技巧——在 Windows
  // 上渲染成两行高的怪框（debug/info 各占一行），Ctrl 多选完全不可发现。
  // 改为普通单选下拉：全部/仅 debug/阈值两档/仅 error，选中即生效。
  const levelSelect = byId('log-level-filter')
  levelSelect.replaceChildren(
    new Option('全部等级', ''),
    new Option('仅 debug', 'debug'),
    new Option('info 及以上', 'info+'),
    new Option('warn 及以上', 'warn+'),
    new Option('仅 error', 'error'),
  )
  levelSelect.addEventListener('change', applyLogFilters)
  byId('log-source-filter').replaceChildren(new Option('全部来源', ''), ...['desktop', 'worker', 'bridge', 'router', 'delivery', 'channel', 'koishi'].map(source => new Option(source, source)))
  byId('logs-apply').addEventListener('click', applyLogFilters)
  for (const id of ['log-search', 'log-correlation']) byId(id).addEventListener('keydown', event => { if (event.key === 'Enter') applyLogFilters() })
  byId('log-source-filter').addEventListener('change', applyLogFilters)
  byId('logs-clear').addEventListener('click', () => { state.logs = []; logIds.clear(); logRenderCount = 0; renderLogs() })
  byId('log-follow').addEventListener('change', event => { event.target.checked ? resumeLogFollow() : (logView.following = false) })
  // 死代码清理·接线：Blind 沉浸模式的主进程机制此前无 UI 可达（半接线幽灵）。
  byId('log-blind')?.addEventListener('change', event => {
    const enabled = event.target.checked
    void desktop.logs.setBlind(enabled).catch(error => { showToast('Blind 模式切换失败：' + String(error), 'error'); event.target.checked = !enabled })
  })
  byId('logs-export').addEventListener('click', async () => {
    try {
      const result = await desktop.logs.export({ storyId: state.storyId || undefined, from: undefined, to: undefined })
      appendLog({ storyId: state.storyId || 'shell', line: `日志已导出（${result.records} 条，应用 Blind 规则）：${result.target}` })
    } catch (error) { appendLog({ storyId: state.storyId || 'shell', line: `导出失败：${error}` }) }
  })
  const scroll = byId('logs-scroll')
  scroll.addEventListener('scroll', () => {
    if (scroll.scrollTop < 60 && !logView.loadingOlder && !logView.exhausted && state.logs.length) void loadOlderLogs()
    if (logView.following) {
      const atBottom = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 40
      if (!atBottom) { logView.following = false; byId('log-follow').checked = false; byId('logs-status').textContent = '已暂停跟随（Pause）— 新日志在后台积累' }
    }
  })
  // 恢复跟随：点击 Follow 或滚到底部
  scroll.addEventListener('scroll', () => {
    if (!logView.following && scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 10) {
      // 走 resumeLogFollow()：手动置位会漏掉 paused 缓冲的补齐与 PAUSED 计数刷新。
      resumeLogFollow()
    }
  })
}

/** Blind/失明模式由宿主推送时，此会话的日志立即清屏并停止显示正文。 */
function applyLogBlind(enabled) {
  const toggle = byId('log-blind')
  if (toggle) toggle.checked = enabled === true
  if (!enabled) return
  state.logs = []
  logIds.clear()
  logRenderCount = 0
  renderLogs()
  byId('logs-status').textContent = 'Blind 模式已启用：正文已从视图移除'
}

function runThemeInteraction(kind, trigger, target) {
  if (!target || typeof window.HDSIThemeV3?.applyInteraction !== 'function') return Promise.resolve(false)
  try { return Promise.resolve(window.HDSIThemeV3.applyInteraction(target, kind, trigger)).catch(() => false) } catch { return Promise.resolve(false) }
}

function setSurface(surface) {
  if(surface!=='koishi' && typeof consoleState!=='undefined' && consoleState.embedded)void detachConsole()
  state.surface = surface; persist()
  applyPanelLayout()
  syncWorkspaceProfileView()
  window.HDSIViewModel?.notify('app')
  document.querySelectorAll('.surface').forEach(node => node.classList.toggle('active', node.id === `${surface}-surface`))
  // V2 §16：Tab 状态同步 aria-selected/tabindex（方向键切换见文件尾）
  document.querySelectorAll('[data-surface]').forEach(node => {
    const active = node.dataset.surface === surface
    node.classList.toggle('active', active)
    node.setAttribute('aria-selected', String(active))
    node.tabIndex = active ? 0 : -1
  })
  // 回到 Logs 时补齐暂停期间积累的记录；离开时保持缓冲但不渲染。
  if (surface === 'koishi') { void refreshConsoleInfo(); scheduleConsoleResize() }
  if (surface === 'connect') { void renderConnectView() }
  void refreshAccountPanel()
  if (surface === 'logs') {
    if (!logView.following && logView.paused.length) byId('log-backlog').textContent = `PAUSED ${logView.paused.length} 条待补齐`
    renderLogs()
  }
  void runThemeInteraction('page', 'enter', byId(`${surface}-surface`))
}

// ============================================================
// P0: 连接与账号中心
// ============================================================

let connectState = { detection: null, readiness: null }

// ── P2 §3：readiness 从"渲染连接页"解耦成数据任务 ──────────────────────────
// 探测是纯本地 IPC 读（模型检查不联网），但仍按故事键控 + 60s TTL + 在途去重，
// 防止被 stories:changed / story:inbox 等高频事件放大。
const READINESS_TTL_MS = 60_000
const readinessCache = new Map()   // storyId -> { data, at }
const readinessInFlight = new Map() // storyId -> Promise
function fetchReadiness(storyId, { force = false } = {}) {
  const hit = readinessCache.get(storyId)
  if (!force && hit && Date.now() - hit.at < READINESS_TTL_MS) return Promise.resolve(hit.data)
  let flight = readinessInFlight.get(storyId)
  if (!flight) {
    flight = (async () => {
      let data = null
      try { if (desktop.connection) data = await desktop.connection.firstRunReadiness(storyId) }
      catch { data = null }
      readinessCache.set(storyId, { data, at: Date.now() })
      return data
    })().finally(() => { readinessInFlight.delete(storyId) })
    readinessInFlight.set(storyId, flight)
  }
  return flight
}
/** 复审：readiness 是全局缓存但按故事键控——切故事的瞬间必须先清掉旧故事的
 *  值（缓存命中则立即换上），再异步取新故事的实态，否则状态栏会沿用上一个
 *  故事的模型检查结果，直到下一次后台 refresh 才纠正。 */
function syncReadinessForStory(storyId) {
  if (!storyId) { connectState.readiness = null; return }
  const hit = readinessCache.get(storyId)
  connectState.readiness = hit && Date.now() - hit.at < READINESS_TTL_MS ? hit.data : null
  void fetchReadiness(storyId).then(data => {
    if (data && state.storyId === storyId) { connectState.readiness = data; void updateStatusBar() }
  })
}
// V3 阶段3：连接页声明式组件的数据通道——renderConnectView 回填，DSL 组件读取
const connectParts = { stepsHtml: '', sideHtml: '' }

async function renderConnectView() {
  const main = byId('connect-main'); if (!main) return
  const renderSeq = ++connectRenderSeq
  main.innerHTML = '<p class="muted-copy">正在检测连接状态…</p>'
  try {
    if (desktop.connection) connectState.detection = await desktop.connection.detect()
  } catch { connectState.detection = null }
  if (renderSeq !== connectRenderSeq || state.surface !== 'connect') return
  const det = connectState.detection ?? {}
  const snowStatus = String(det.snowluma ?? 'not-found')
  const webui = det.snowlumaWebui ?? {}
  const detAccounts = Array.isArray(det.snowlumaAccounts) ? det.snowlumaAccounts : []
  const channelLabel = kind => kind === 'wechat' ? '微信' : kind === 'other' ? '其他 OneBot' : 'QQ'
  // 规范 §5：步骤卡的模型/白名单状态来自就绪检查——先刷新右侧面板取新鲜数据。
  await renderReadyPanel().catch(() => {})
  if (renderSeq !== connectRenderSeq || state.surface !== 'connect') return
  const rc = connectState.readiness
  const rcCheck = (id) => (rc?.checks ?? []).find(check => check.id === id)

  // ── 已绑定账号卡片（跨剧本总览）──
  let boundCards = ''
  try {
    const accounts = await desktop.accounts.list()
    const bound = Array.isArray(accounts) ? accounts : []
    if (bound.length) {
      boundCards = '<section class="account-registry"><div class="account-registry-head"><div><span class="connect-eyebrow">ACCOUNT REGISTRY</span><h3>已接入账号</h3><p>账号是平台身份，端点是故事投递路径。</p></div><span class="account-registry-count">' + bound.length + ' ENTRIES</span></div><div class="account-cards">'
        + bound.map(entry => {
          const ext = entry.externalState ?? 'not-configured'
          const led = ext === 'online' ? 'ok' : ext === 'connecting' ? 'warn' : 'err'
          const extLabel = ext === 'online' ? '渠道在线' : ext === 'connecting' ? '连接中' : ext === 'configuration-error' ? '配置错误' : ext === 'offline' ? '离线' : '未配置'
          const kind = entry.channelKind === 'wechat' ? '微信' : entry.channelKind === 'other' ? 'OB' : 'QQ'
          const endpoint = entry.externalUpstream?.endpoint || '本地适配器 / 自动发现'
          const selected = state.storyId === entry.storyId ? ' selected' : ''
          return `<div class="account-card${selected}" data-story="${escapeHtml(entry.storyId)}" data-self-id="${escapeHtml(entry.selfId)}">
            <div class="account-channel-mark ${entry.channelKind === 'wechat' ? 'wechat' : entry.channelKind === 'other' ? 'other' : 'qq'}">${kind}</div>
            <div class="account-card-head"><b>${escapeHtml(entry.nickname || entry.selfId)}</b><small>${escapeHtml(entry.selfId)} · ${escapeHtml(entry.storyName || entry.storyId)}</small></div>
            <div class="account-card-endpoint"><span>${escapeHtml(endpoint)}</span><small>${entry.channelKind === 'wechat' ? 'OneBot / 微信' : entry.channelKind === 'other' ? 'OneBot / 自定义' : 'OneBot / QQ'}</small></div>
            <div class="account-card-status ext-${led}"><span class="dot ${led}"></span>${extLabel}</div>
            <div class="account-card-actions"><button data-acct-action="edit">配置端点</button><button data-acct-action="select">打开剧本</button><button data-acct-action="unbind">解绑</button></div>
          </div>`
        }).join('') + '</div></section>'
    } else {
      boundCards = '<section class="account-registry"><div class="account-registry-head"><div><span class="connect-eyebrow">ACCOUNT REGISTRY</span><h3>已接入账号</h3><p>还没有账号绑定到故事。</p></div><span class="account-registry-count">0 ENTRIES</span></div><p class="account-empty">尚未接入任何账号。完成下面的账号步骤后，这里会显示端点状态。</p></section>'
    }
  } catch { boundCards = '<section class="account-registry"><div class="account-registry-head"><div><span class="connect-eyebrow">ACCOUNT REGISTRY</span><h3>已接入账号</h3></div></div><p class="account-empty">账号列表读取失败。</p></section>' }

  // ── SnowLuma 三态首屏 ──
  let snowCard = ''
  if (snowStatus === 'running') {
    snowCard = `
    <div class="connect-card snow-ok">
      <h3>ONEBOT SnowLuma 接入</h3>
      <div class="connect-status"><span class="dot ok"></span><span><strong>运行中</strong>${webui.reachable ? ` · 管理界面 :${escapeHtml(String(webui.port))}` : ''}</span></div>
      ${detAccounts.length ? `<p class="muted">检测到 ${detAccounts.length} 个已配置账号：${detAccounts.map(a => escapeHtml(a.uin)).join('、')}</p>` : `<p class="muted">${webui.reachable ? '管理界面可访问；请在 SnowLuma 中确认 QQ 已登录并开启 OneBot WebSocket。' : '进程已运行，但管理界面尚不可访问；请确认 SnowLuma 已完成启动。'}</p>`}
      <div class="connect-actions">
        <button id="snow-webui-btn">打开管理界面</button>
        <button id="connect-recheck-inner">↻ 重新检测</button>
      </div>
    </div>`
  } else if (snowStatus === 'installed') {
    snowCard = `
    <div class="connect-card snow-warn">
      <h3>ONEBOT SnowLuma 接入</h3>
      <div class="connect-status"><span class="dot warn"></span><span><strong>${det.snowlumaProcess?.status === 'unknown' ? '已安装（进程状态未知）' : '已安装（未运行）'}</strong> · ${escapeHtml(det.snowlumaPath ?? '')}</span></div>
      <p class="muted">SnowLuma 是 typ0 的 QQ 通道：它把你的 QQ 变成机器人能收发的消息桥。手动运行它的 launcher.bat 并登录 QQ，然后回到这里重新检测。</p>
      <div class="connect-actions">
        <button id="connect-recheck-inner">↻ 重新检测</button>
      </div>
    </div>`
  } else if (snowStatus === 'unknown') {
    snowCard = `
    <div class="connect-card snow-warn">
      <h3>ONEBOT SnowLuma 接入</h3>
      <div class="connect-status"><span class="dot warn"></span><span><strong>无法确认安装状态</strong></span></div>
      <p class="muted">本机进程检测不可用。你仍可以直接在步骤 4 配置任意 OneBot WebSocket 端点；如果使用 QQ，再手动确认 SnowLuma 是否已安装并运行。</p>
      <div class="connect-actions"><button id="snow-download-btn">打开下载页</button><button id="connect-recheck-inner">↻ 重新检测</button></div>
    </div>`
  } else {
    snowCard = `
    <div class="connect-card snow-err">
      <h3>ONEBOT SnowLuma 接入</h3>
      <div class="connect-status"><span class="dot err"></span><span><strong>未检测到 SnowLuma</strong></span></div>
      <p class="muted">SnowLuma 是 typ0 的 QQ 通道——独立应用，负责把你的 QQ 变成机器人能收发的消息桥。typ0 通过它的 WebSocket 端点收发消息。</p>
      <p class="muted">首次使用：① 从 SnowLuma Releases 下载并解压 → ② 运行 launcher.bat，在管理界面里登录 QQ → ③ 回到这里点击重新检测。</p>
      <div class="connect-actions">
        <button id="snow-download-btn">打开下载页</button>
        <button id="connect-recheck-inner">↻ 重新检测</button>
      </div>
    </div>`
  }

  // ── 规范 §5：步骤化就绪（左 1-5 步，右就绪检查面板在侧栏 aside）──
  const story = selectedStory()
  const stepIcon = { ok: '✓', warn: '!', err: '✕', skip: '◌', busy: '…' }
  // 审计：status/hint 混有宿主/worker 产生的字符串（readiness summary/detail）——
  // 步骤卡是 innerHTML 模板，统一在此转义（与 renderReadyPanel 同规则）。
  const stepCard = (no, cls, status, title, hint, actions) => `
    <div class="step-card ${cls}">
      <span class="step-no">${no}</span>
      <div class="step-main"><b>${escapeHtml(title)}<span class="step-status ${cls}">${stepIcon[cls] ?? ''} ${escapeHtml(status)}</span></b><small>${escapeHtml(hint)}</small></div>
      <div class="step-actions">${actions}</div>
    </div>`
  // 1 Worker
  const workerBusy = story && workerAction?.storyId === story.meta.id
  const workerNeedsReload = story && needsReloadStoryIds.has(story.meta.id)
  const workerCls = !story ? 'skip' : story.running && story.bridgeReady ? 'ok' : 'warn'
  const workerStatus = !story ? '未配置' : workerBusy ? (workerAction.kind === 'reload' ? '正在重载' : '正在加载') : story.running ? (story.bridgeReady ? (workerNeedsReload ? '待重载' : '已就绪') : '检查中') : '需要处理'
  const workerHint = !story ? '先创建或从左侧选择一个剧本，Worker 才有承载对象。'
    : workerBusy ? '正在执行操作，请不要重复点击。'
      : story.running ? (story.bridgeReady
        ? (workerNeedsReload ? '配置已保存，但当前 Worker 仍使用旧配置；确认重载后才会生效。' : 'Worker 正在运行，剧本可以收发消息与自动推进。')
        : 'Worker 进程启动中，bridge 就绪后才能安全重载.')
      : 'Worker 未加载：时间线、聊天与投递都不可用。'
  const workerActions = !story ? '<button data-step-action="new-story">＋ 新建剧本</button>'
    : workerBusy ? `<button class="primary" disabled>${workerAction.kind === 'reload' ? '正在重载…' : '正在加载…'}</button>`
      : story.running && story.bridgeReady
        ? `<button data-step-action="reload-worker" class="primary">${workerNeedsReload ? '应用配置并重载' : '重载 Worker'}</button><button data-step-action="open-story">打开剧本</button>`
        : story.running ? '<button disabled>正在启动…</button>'
        : '<button data-step-action="load-worker" class="primary">加载 Worker</button>'
  // 2 模型
  const modelCheck = rcCheck('model')
  const modelCls = !story ? 'skip' : modelCheck?.status === 'ok' ? 'ok' : modelCheck?.status === 'warn' ? 'warn' : 'err'
  const modelStatus = !story ? '未配置' : modelCheck?.status === 'ok' ? '已就绪' : modelCheck?.status === 'warn' ? '状态不明' : '需要处理'
  const modelHint = !story ? '创建剧本后在配置中填写模型提供商（API Key、endpoint、模型名）。'
    : modelCheck?.status === 'ok' ? '模型连接可用，可以生成剧本。' : '模型 API Key 或 endpoint 未配置——没有模型她无法回复。'
  // 账号清单（步骤 3/4 共用）：提前拉取，渠道分流与接入门控都以它为准。
  let boundAccountsForGate = []
  try { const listResult = await desktop.accounts.list(); boundAccountsForGate = Array.isArray(listResult) ? listResult : []; connectState.accountEntries = boundAccountsForGate } catch { boundAccountsForGate = [] }
  // 3 消息渠道——P2-a（复核）：按已绑定账号的 channelKind 分流，QQ 通道才
  // 展示 SnowLuma 语义；微信/其他通道展示各自的接入说明，不再被 QQ 文案淹没。
  const boundChannelKinds = new Set(boundAccountsForGate.map(item => item.channelKind === 'wechat' || item.channelKind === 'other' ? item.channelKind : 'qq'))
  const hasWechatBound = boundChannelKinds.has('wechat') || boundChannelKinds.has('other')
  let channelCls, channelStatus, channelHint, channelActions
  const channelReadiness = rc?.channel
  if (!story) {
    channelCls = 'skip'; channelStatus = '未配置'
    channelHint = '创建剧本后选择 OneBot 适配器；SnowLuma 只负责 QQ 通道的独立运行环境。'
    channelActions = '<button data-step-action="recheck">↻ 重新检测</button>'
  } else if (channelReadiness?.status === 'ready') {
    channelCls = 'ok'; channelStatus = '已配置'
    channelHint = `剧本已启用 OneBot 适配器。${snowStatus === 'running' ? 'SnowLuma 进程正在运行；账号登录与 Self ID 会在步骤 4 单独验证。' : 'SnowLuma 状态不会直接等同于账号在线。'}`
    channelActions = snowStatus === 'running' ? '<button data-step-action="snow-webui">打开管理界面</button>' : '<button data-step-action="recheck">↻ 重新检测</button>'
  } else {
    channelCls = channelReadiness?.status === 'checking' || channelReadiness?.status === 'degraded' ? 'warn' : 'err'
    channelStatus = channelReadiness?.summary ?? '需要处理'
    channelHint = channelReadiness?.detail ?? '请在剧本配置中启用 OneBot 适配器。'
    channelActions = '<button data-step-action="recheck">↻ 重新检测</button>'
  }
  // 4 账号
  let accountEntry = null
  try { const accounts = await desktop.accounts.list(); accountEntry = (Array.isArray(accounts) ? accounts : []).find(item => item.storyId === story?.meta.id) } catch { accountEntry = null }
  // 审计：accountKindLabel 此前被引用但从未定义——已绑定账号的剧本渲染连接页
  // 即 ReferenceError，页面卡在"正在检测连接状态…"。通道标签与 channelLabel 同源。
  const accountKindLabel = channelLabel(accountEntry?.channelKind)
  const accountReadiness = rc?.account
  const accountCls = !story ? 'skip' : accountReadiness?.status === 'ready' ? 'ok' : accountReadiness?.status === 'checking' || accountReadiness?.status === 'degraded' ? 'warn' : 'err'
  const accountStatus = !story ? '未配置' : accountReadiness?.status === 'ready' ? '已就绪' : accountReadiness?.status === 'checking' ? '检查中' : accountReadiness?.summary ?? '需要处理'
  const accountHint = !story ? '创建剧本并绑定账号后，消息才会进入剧本。'
    : accountReadiness?.detail ?? (accountEntry ? `账号 ${accountEntry.selfId}（${accountKindLabel}）正在等待端点验证。` : '该剧本尚未绑定账号。QQ 通道需 SnowLuma 运行；微信/其他通道可直接输入账号 ID 接入。')
  const hasNonQqAccount = boundAccountsForGate.some(item => item.channelKind === 'wechat' || item.channelKind === 'other')
  const gateOpen = snowStatus === 'running' || hasNonQqAccount
  const accountActions = `<button id="connect-add-account" ${gateOpen ? 'class="primary"' : 'disabled title="QQ 通道需 SnowLuma 运行；微信/其他通道可先接入一个非 QQ 账号后随时添加"'}>＋ 接入账号</button>`
  // 5 交往对象
  const whitelistCheck = rcCheck('whitelist')
  const whitelistCls = !story ? 'skip' : whitelistCheck?.status === 'ok' ? 'ok' : 'warn'
  const whitelistStatus = !story ? '未配置' : whitelistCheck?.status === 'ok' ? '已就绪' : '需要注意'
  // P2-b（复核）：文案以 readyCheck 的 detail 为准——"过滤未启用=接受所有会话"
  // 与"白名单 N 人"是两种不同的 ok，不再统一说"白名单非空"。
  const whitelistHint = !story ? '白名单决定谁可以和她私聊。'
    : whitelistCheck?.status === 'ok'
      ? (whitelistCheck?.detail ?? '白名单配置有效。')
      : '过滤已启用且白名单为空——当前会拒绝全部私聊，请在配置中添加交往对象。'

  // V3 阶段3：步骤列与侧栏列交给声明式页面组合（社区包可覆盖 page/connect-main）；
  // 组件从 connectParts 取本轮回填的 HTML，DOM 结构与旧版逐层一致。
  connectParts.stepsHtml = `
    <div class="connect-steps">
      <div class="connect-step-rail-head"><span class="connect-eyebrow">CONNECT / ONBOARDING</span><h3>连接向导</h3><p>从运行环境到首次聊天。</p></div>
      <div class="connect-step-rail">
        ${stepCard(1, workerCls, workerStatus, '运行环境', workerHint, workerActions)}
        ${stepCard(2, modelCls, modelStatus, '模型', modelHint, '<button id="connect-goto-models">打开模型配置</button>')}
        ${stepCard(3, channelCls, channelStatus, '平台渠道', channelHint, channelActions)}
        ${stepCard(4, accountCls, accountStatus, '账号端点', accountHint, accountActions)}
        ${stepCard(5, whitelistCls, whitelistStatus, '交往对象', whitelistHint, '<button id="connect-goto-whitelist">打开白名单配置</button>')}
      </div>
    </div>`
  connectParts.sideHtml = `
    <div class="connect-detail">
      ${boundCards}
      <div class="connect-config-card">
        <div class="connect-config-head"><div><span class="connect-eyebrow">PLATFORM / ENDPOINT</span><h3>平台与端点</h3><p>选择平台后，探测登录信息和能力矩阵。</p></div><span class="connect-config-step">STEP 3 / 4</span></div>
        <div class="connect-platform-row"><button class="connect-platform active" data-channel="qq" type="button"><b>QQ / OneBot v11</b><small>SnowLuma · 正向 WebSocket</small></button><button class="connect-platform" data-channel="wechat" type="button"><b>微信 / OneBot v11</b><small>外部网关 · wxid / 别名</small></button><button class="connect-platform" data-channel="other" type="button"><b>自定义适配器</b><small>手动输入协议端点</small></button></div>
        <div class="connect-endpoint-summary"><div><span>当前端点</span><b>${accountEntry ? escapeHtml(accountEntry.externalUpstream?.endpoint || '本地适配器 / 自动发现') : '等待账号端点'}</b></div><div><span>探测状态</span><b class="${accountEntry?.externalState === 'online' ? 'ok' : 'warn'}">${accountEntry?.externalState === 'online' ? '可达 · ONLINE' : '等待探测'}</b></div><button id="connect-open-wizard" type="button" class="primary">${accountEntry ? '配置端点' : '接入账号'} →</button></div>
      </div>
      ${snowCard}
      <div class="connect-card account-detail-card">
        <div class="account-detail-head"><div><span class="connect-eyebrow">SELECTED ENDPOINT</span><h3>${accountEntry ? escapeHtml(accountEntry.nickname || accountEntry.selfId) : '尚未选择账号'}</h3></div>${accountEntry ? `<span class="account-detail-status ${accountEntry.externalState === 'online' ? 'ok' : 'warn'}"><span class="dot ${accountEntry.externalState === 'online' ? 'ok' : 'warn'}"></span>${accountEntry.externalState === 'online' ? 'ONLINE' : 'CHECK'}</span>` : ''}</div>
        ${accountEntry ? `<div class="account-detail-grid"><div><span>CHANNEL</span><b>${accountKindLabel}</b></div><div><span>SELF ID</span><b>${escapeHtml(accountEntry.selfId)}</b></div><div class="wide"><span>ENDPOINT</span><b>${escapeHtml(accountEntry.externalUpstream?.endpoint || '本地适配器 / 自动发现')}</b></div><div><span>OWNER KIND</span><b>story-role</b></div><div><span>ROUTING</span><b>follow source</b></div></div><div class="account-capabilities"><div><span>私聊收发</span><b class="${accountEntry.externalState === 'online' ? 'ok' : 'warn'}">${accountEntry.externalState === 'online' ? '已验证' : '待验证'}</b></div><div><span>群聊收发</span><b>宿主暂不支持</b></div><div><span>上游探测</span><b>${accountEntry.externalCode === 'ONEBOT_AUTH_FAILED' ? '令牌校验失败' : accountEntry.externalState === 'online' ? '已通过' : '待检查'}</b></div><div><span>Token</span><b>${accountEntry.externalUpstream?.tokenAlias ? 'STORED' : 'NONE'}</b></div></div><button id="connect-edit-account" class="account-detail-action">配置端点</button>` : '<p class="muted">绑定账号后，这里会显示平台、Self ID、端点地址和能力状态。</p>'}
      </div>
      <div class="connect-card">
        <h3>端点原则</h3>
        <div class="endpoint-principles"><div><b>单平台</b><span>保留轻量协议和默认路由。</span></div><div><b>多平台</b><span>启用端点选择和来源跟随。</span></div><div><b>安全</b><span>Token 只保存在本机凭据库。</span></div></div>
        ${snowStatus === 'running' ? '<p class="muted" style="margin-top:10px">SnowLuma 已运行，可在账号步骤中接入检测到的账号。</p>' : '<p class="muted" style="margin-top:10px">QQ 账号需要 SnowLuma；微信或其他 OneBot 通道可使用外部端点。</p>'}
      </div>
    </div>`
  // 声明式运行时会在 mount() 内异步 replaceChildren()。必须等待挂载完成后再查找并绑定按钮，
  // 否则这里绑定到的是上一次渲染留下的节点（或仍处于 loading 状态的空容器），
  // 最终表现为按钮可见但点击没有任何反应。
  if (window.HDSIPageRuntime?.listOfficial().includes('connect-main')) {
    await window.HDSIPageRuntime.mount('connect-main', main)
  } else {
    main.innerHTML = `<div class="connect-layout">${connectParts.stepsHtml}${connectParts.sideHtml}</div>`
  }
  if (renderSeq !== connectRenderSeq || state.surface !== 'connect') return

  // 步骤主操作（data-step-action 与旧按钮 id 并存；旧 id 绑定在下方统一处理）
  main.querySelectorAll('[data-step-action]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const action = btn.dataset.stepAction
      if (action === 'new-story') byId('new-story')?.click()
      else if (action === 'open-story') setSurface('studio')
      else if (action === 'load-worker') void loadSelected()
      else if (action === 'reload-worker') void reloadSelected()
      else if (action === 'snow-webui') window.open(`http://127.0.0.1:${webui.port ?? 5099}`, '_blank')
      else if (action === 'recheck') void renderConnectView()
      else if (action === 'snow-download') window.open('https://github.com/SnowLuma/SnowLuma/releases', '_blank')
    })
  })

  // ── 事件绑定 ──
  const bind = (id, fn) => { const el = byId(id); if (el) el.addEventListener('click', fn) }
  bind('connect-recheck-inner', () => void renderConnectView())
  bind('connect-goto-whitelist', () => openConfigTab('users'))
  bind('connect-goto-models', () => openConfigTab('providers'))
  bind('snow-webui-btn', () => window.open(`http://127.0.0.1:${webui.port ?? 5099}`, '_blank'))
  bind('snow-download-btn', () => window.open('https://github.com/SnowLuma/SnowLuma/releases', '_blank'))
  bind('connect-add-account', () => openAccountWizard(detAccounts))
  bind('connect-edit-account', () => { if (accountEntry) openAccountWizard(detAccounts, accountEntry) })
  let selectedPlatform = accountEntry?.channelKind ?? 'qq'
  const updatePlatform = () => {
    main.querySelectorAll('.connect-platform').forEach(item => { const active = item.dataset.channel === selectedPlatform; item.classList.toggle('active', active); item.setAttribute('aria-pressed', String(active)) })
    const action = byId('connect-open-wizard')
    if (action) action.textContent = accountEntry && (accountEntry.channelKind ?? 'qq') === selectedPlatform ? '配置端点 →' : `接入${channelLabel(selectedPlatform)}账号 →`
  }
  bind('connect-open-wizard', () => openAccountWizard(detAccounts, accountEntry && (accountEntry.channelKind ?? 'qq') === selectedPlatform ? accountEntry : null, selectedPlatform))
  main.querySelectorAll('.connect-platform').forEach(button => button.addEventListener('click', () => { selectedPlatform = button.dataset.channel; updatePlatform() }))
  updatePlatform()

  // 账号卡片操作
  main.querySelectorAll('[data-acct-action]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const card = btn.closest('.account-card')
      const storyId = card?.dataset.story ?? ''
      if (btn.dataset.acctAction === 'edit') {
        if (storyId !== state.storyId) { selectStory(storyId); showToast('已切换到该账号所属剧本；再次点击配置端点即可编辑。', 'info'); return }
        const entry = (connectState.accountEntries ?? []).find(item => item.storyId === storyId && String(item.selfId) === card.dataset.selfId); openAccountWizard(detAccounts, entry)
      }
      else if (btn.dataset.acctAction === 'select') { selectStory(storyId); setSurface('studio') }
      else if (btn.dataset.acctAction === 'unbind') {
        if (!window.confirm('解绑影响范围：该剧本将立即停止收发此账号的消息（在途消息可能丢失）；剧本本身、历史记录与其它配置不受影响。\n恢复方式：随时可在连接页重新接入该账号。继续吗？')) return
        try { await desktop.accounts.unbind(storyId, card.dataset.selfId); showToast('已解绑。', 'ok'); await renderConnectView() }
        catch (error) { showToast('解绑失败：' + error, 'err') }
      }
    })
  })

  // B26: 重新检查按钮——先解绑再绑，防止 renderConnectView 重入时叠加监听器
  const recheckBtn = byId('connect-recheck')
  if (recheckBtn) { const clone = recheckBtn.cloneNode(true); recheckBtn.replaceWith(clone); clone.addEventListener('click', () => void renderConnectView()) }

  // B6：就绪面板已由本函数开头 await renderReadyPanel() 刷新数据——此处二次
  // 调用只会重复 IPC 并让面板再闪一次"正在检查…"，删除。
}

/** 接入新账号向导：选账号 → 确认连接（自动地址 + 测试）→ 绑定。 */
function openAccountWizard(detAccounts, existingEntry = null, requestedKind = 'qq') {
  const story = selectedStory()
  detAccounts = (Array.isArray(detAccounts) ? detAccounts : []).map(a => ({ ...a, uin: String(a.uin), wsEndpoints: Array.isArray(a.wsEndpoints) ? a.wsEndpoints : [] }))
  const existing = document.getElementById('account-wizard')
  existing?.remove()
  const overlay = document.createElement('dialog')
  overlay.id = 'account-wizard'
  overlay.className = 'account-wizard'
  const initialKind = existingEntry?.channelKind ?? requestedKind
  const initialUin = String(existingEntry?.selfId ?? '')
  const accountOptions = detAccounts.length
    ? detAccounts.map(a => `<option value="${escapeHtml(a.uin)}" ${a.uin === initialUin ? 'selected' : ''}>${escapeHtml(a.uin)}${a.hasToken ? '（需令牌）' : ''} · ${a.wsEndpoints.map(e => 'ws:' + e.port).join('/')}</option>`).join('')
    : ''
  const firstEndpoint = (detAccounts.find(a => a.uin === initialUin) ?? (!initialUin ? detAccounts[0] : null))?.wsEndpoints?.[0]
  const defaultEndpoint = existingEntry?.externalUpstream?.endpoint || (firstEndpoint ? `ws://127.0.0.1:${firstEndpoint.port}${firstEndpoint.path || ''}` : '')
  const initialManual = initialUin && (!detAccounts.some(a => a.uin === initialUin) || initialKind !== 'qq') ? initialUin : ''
  overlay.innerHTML = `
    <form method="dialog" style="min-width:440px">
      <h3 style="margin:0 0 4px">${existingEntry ? '配置账号端点' : '接入新账号'}</h3>
      <p class="muted" style="font-size:11px;margin:0 0 12px">${story ? `将绑定到剧本「${escapeHtml(story.meta.name)}」` : 'WARNING 尚未选择剧本——请先在左侧选择或创建剧本'}</p>
      <label class="wiz-field">通道类型
        <select id="wiz-channel">
          <option value="qq" ${initialKind === 'qq' ? 'selected' : ''}>QQ（SnowLuma / OneBot）</option>
          <option value="wechat" ${initialKind === 'wechat' ? 'selected' : ''}>微信（onebots 别名 / 原生通道）</option>
          <option value="other" ${initialKind === 'other' ? 'selected' : ''}>其他 OneBot 通道</option>
        </select>
      </label>
      <label class="wiz-field" id="wiz-account-field">机器人账号
        ${detAccounts.length
          ? `<select id="wiz-uin">${accountOptions}<option value="__manual" ${initialManual ? 'selected' : ''}>手动输入…</option></select>
             <input id="wiz-uin-manual" value="${escapeHtml(initialManual)}" placeholder="手动输入账号 ID" style="display:none" autocomplete="off" />`
          : `<input id="wiz-uin-manual" value="${escapeHtml(initialUin)}" placeholder="机器人账号 ID" autocomplete="off" />`}
        <small id="wiz-account-hint" class="wiz-hint">QQ：5–11 位数字。检测到的账号已自动列出。</small>
      </label>
      <label class="wiz-field">OneBot WebSocket 连接地址
        <input id="wiz-endpoint" value="${escapeHtml(defaultEndpoint)}" placeholder="ws://127.0.0.1:…" autocomplete="off" />
      </label>
      <label class="wiz-field">访问令牌（OneBot access token，不是 WebUI 密码）
        <input id="wiz-token" type="password" placeholder="留空 = 不发送令牌（除非选择下方令牌来源）" autocomplete="off" />
      </label>
      <div class="wiz-token-sources" role="group" aria-label="令牌来源">
      <label class="wiz-token-choice"><input type="checkbox" id="wiz-reuse-token" ${existingEntry?.externalUpstream?.tokenAlias ? 'checked' : ''} />沿用已保存令牌（仅相同账号与端点）</label>
      <label class="wiz-token-choice" id="wiz-local-token-choice"><input type="checkbox" id="wiz-local-token" />使用本机 SnowLuma 配置中的令牌（须与账号、端口和路径匹配）</label>
      </div>
      <label class="wiz-field">昵称（可选）
        <input id="wiz-nick" value="${escapeHtml(existingEntry?.nickname ?? '')}" placeholder="对这台机器人的称呼" autocomplete="off" />
      </label>
      <div class="wiz-probe"><button type="button" id="wiz-probe-btn">测试连接</button><span id="wiz-probe-result"></span></div>
      <div class="wiz-actions" style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px">
        <button type="button" id="wiz-cancel">取消</button>
        <button type="button" id="wiz-bind" class="primary" ${story ? '' : 'disabled'}>${existingEntry ? '保存端点' : '绑定账号'}</button>
      </div>
    </form>`
  document.body.appendChild(overlay)
  overlay.showModal()
  // §16：弹窗打开后焦点进入首个可操作控件
  overlay.querySelector('select, input, button')?.focus()

  const uinSelect = overlay.querySelector('#wiz-uin')
  const uinManual = overlay.querySelector('#wiz-uin-manual')
  const endpointInput = overlay.querySelector('#wiz-endpoint')
  const channelSelect = overlay.querySelector('#wiz-channel')
  const accountHint = overlay.querySelector('#wiz-account-hint')
  const HINTS = {
    qq: 'QQ：5–11 位数字。检测到的 SnowLuma 账号已自动列出。',
    wechat: '微信：4–64 位字母/数字/下划线/连字符。示例：onebots 网关的数字别名，或原生通道的 wxid_xxx。',
    other: '其他 OneBot 通道：4–64 位字母/数字/下划线/连字符的账号 ID。',
  }
  const applyChannel = () => {
    const kind = channelSelect?.value ?? 'qq'
    if (accountHint) accountHint.textContent = HINTS[kind] ?? HINTS.qq
    if (uinSelect) uinSelect.style.display = kind === 'qq' ? '' : 'none'
    if (uinManual) { uinManual.style.display = kind !== 'qq' || !uinSelect || uinSelect.value === '__manual' ? '' : 'none'; uinManual.placeholder = kind === 'qq' ? '手动输入 QQ 号' : kind === 'wechat' ? '账号 ID（如 onebots 别名 / wxid_xxx）' : '账号 ID' }
    overlay.querySelector('#wiz-local-token-choice').hidden = kind !== 'qq'
    if (kind !== 'qq') overlay.querySelector('#wiz-local-token').checked = false
  }
  channelSelect?.addEventListener('change', applyChannel)
  applyChannel()
  uinSelect?.addEventListener('change', () => {
    const manual = uinSelect.value === '__manual'
    if (uinManual) uinManual.style.display = manual ? '' : 'none'
    if (!manual) {
      const acc = detAccounts.find(a => a.uin === uinSelect.value)
      const ep = acc?.wsEndpoints?.[0]
      if (ep) endpointInput.value = `ws://127.0.0.1:${ep.port}${ep.path || ''}`
    }
  })
  // 通道中立取值（§5.3）：非 QQ 通道一律取手动输入——QQ 检测下拉只属于 QQ 通道，
  // 隐藏的 select 保留旧值不得污染微信/其他通道的账号。
  const currentUin = () => {
    const kind = channelSelect?.value ?? 'qq'
    if (kind !== 'qq') return (uinManual?.value.trim() ?? '')
    return (uinSelect && uinSelect.value !== '__manual' ? uinSelect.value : (uinManual?.value.trim() ?? ''))
  }

  const probeButton = overlay.querySelector('#wiz-probe-btn')
  const bindButton = overlay.querySelector('#wiz-bind')
  const tokenInput = overlay.querySelector('#wiz-token')
  const reuseInput = overlay.querySelector('#wiz-reuse-token')
  const localInput = overlay.querySelector('#wiz-local-token')
  const result = overlay.querySelector('#wiz-probe-result')
  let revision = 0, saving = false
  const sameEndpoint = (a, b) => { try { return new URL(a).href === new URL(b).href } catch { return false } }
  const updateCredentialHint = () => {
    const canReuse = !!existingEntry?.externalUpstream?.tokenAlias && currentUin() === String(existingEntry.selfId) && sameEndpoint(endpointInput.value.trim(), existingEntry.externalUpstream.endpoint)
    reuseInput.disabled = !canReuse
    tokenInput.placeholder = localInput.checked ? '留空 = 读取本机匹配令牌；填写则优先使用输入值' : canReuse && reuseInput.checked ? '留空 = 沿用此账号、此端点的已保存令牌' : '留空 = 无令牌'
  }
  const invalidate = () => { revision++; result.textContent = ''; result.className = ''; probeButton.disabled = false; updateCredentialHint() }
  overlay.querySelectorAll('input, select').forEach(input => { input.addEventListener('input', invalidate); input.addEventListener('change', invalidate) })
  localInput.addEventListener('change', () => { if(localInput.checked)reuseInput.checked=false; updateCredentialHint() })
  reuseInput.addEventListener('change', () => { if(reuseInput.checked)localInput.checked=false; updateCredentialHint() })
  updateCredentialHint()
  const tokenOptions = () => ({ storyId: story?.meta.id, selfId: currentUin(), useLocalToken: channelSelect.value === 'qq' && localInput.checked, reuseSavedToken: !reuseInput.disabled && reuseInput.checked })
  probeButton.addEventListener('click', async () => {
    if (probeButton.disabled) return
    const run = ++revision
    probeButton.disabled = true; result.textContent = '测试中…'; result.className = ''
    try {
      const probe = await desktop.connection.probeUpstream(endpointInput.value.trim(), tokenInput.value, tokenOptions())
      if (run !== revision || !overlay.open) return
      if (!probe.ok) { result.textContent = '✗ ' + (probe.error ?? '失败'); result.className = 'probe-err'; return }
      if (currentUin() && String(probe.selfId) !== currentUin()) { result.textContent = '✗ 上游账号与所选机器人账号不一致，请核对。'; result.className = 'probe-err'; return }
      result.textContent = `✓ 上游连接成功（${probe.latencyMs}ms · 账号 ${probe.selfId || '?'}${probe.nickname ? ' ' + probe.nickname : ''}）`
      result.className = 'probe-ok'
    } catch (error) { if (run === revision && overlay.open) { result.textContent = '✗ ' + error; result.className = 'probe-err' } }
    finally { if (run === revision) probeButton.disabled = false }
  })
  overlay.querySelector('#wiz-cancel').addEventListener('click', () => { if (!saving) overlay.close() })
  overlay.addEventListener('cancel', event => { if (saving) event.preventDefault() })
  overlay.addEventListener('close', () => { revision++; overlay.remove() })
  overlay.querySelector('form').addEventListener('submit', event => { event.preventDefault(); bindButton.click() })
  bindButton.addEventListener('click', async () => {
    if (saving || !story) return
    if (selectedStory()?.meta.id !== story.meta.id) { showToast('当前剧本已变更，请重新打开账号配置。', 'err'); return }
    const uin = currentUin(), kind = channelSelect?.value ?? 'qq'
    if (kind === 'qq' && !/^\d{5,11}$/.test(uin)) { showToast('QQ 通道的账号必须是 5–11 位数字。', 'err'); return }
    if (kind !== 'qq' && !/^[A-Za-z0-9_-]{4,64}$/.test(uin)) { showToast('该通道的账号只允许 4–64 位字母/数字/下划线/连字符。', 'err'); return }
    const endpoint = endpointInput.value.trim()
    if (!endpoint && existingEntry?.externalUpstream?.endpoint && currentUin() === String(existingEntry.selfId)) { showToast('已配置的端点不能留空；若要停止接入，请取消后解绑此账号。', 'err'); return }
    if (endpoint) {
      let parsed
      try { parsed = new URL(endpoint) } catch { /* validation below */ }
      if (!parsed || !['ws:', 'wss:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.hash || [...parsed.searchParams.keys()].some(k => /token|authorization/i.test(k))) { showToast('请输入有效 ws:// 或 wss:// 地址；令牌请填入独立字段。', 'err'); return }
    }
    const options = tokenOptions()
    const upstreamArg = endpoint ? { endpoint, tokenText: tokenInput.value.trim(), useLocalToken: options.useLocalToken, reuseSavedToken: options.reuseSavedToken } : undefined
    const nickname = overlay.querySelector('#wiz-nick').value.trim() || uin
    saving = true; revision++; result.textContent = ''; result.className = ''
    const controls = [...overlay.querySelectorAll('input, select, button')].map(el => [el, el.disabled])
    controls.forEach(([el]) => { el.disabled = true })
    try {
      await desktop.accounts.bind(story.meta.id, uin, nickname, upstreamArg, kind)
      showToast('账号接入完成。', 'ok'); overlay.close(); await renderConnectView()
    } catch (error) { showToast('绑定失败：' + error, 'err') }
    finally { saving = false; controls.forEach(([el, disabled]) => { el.disabled = disabled }); probeButton.disabled = false; updateCredentialHint() }
  })
}

async function renderReadyPanel() {
  const panel = byId('connect-ready-panel'); if (!panel) return
  const renderSeq = ++readyPanelSeq
  const story = selectedStory()
  if (!story) {
    connectState.readiness = null
    panel.innerHTML = `<div class="ready-panel"><h3>就绪检查</h3><p class="muted-copy" style="font-size:11px">选择一个剧本后显示检查结果。</p></div>`
    return
  }
  panel.innerHTML = `<div class="ready-panel"><h3>就绪检查</h3><p class="muted-copy" style="font-size:11px">正在检查…</p></div>`
  // 连接页的就绪面板是用户主动查看：强制穿透 TTL 缓存取新鲜数据（同时回填缓存）。
  connectState.readiness = await fetchReadiness(story.meta.id, { force: true })
  if (renderSeq !== readyPanelSeq || selectedStory()?.meta.id !== story.meta.id) return
  const rc = connectState.readiness
  if (!rc || rc.error) {
    panel.innerHTML = `<div class="ready-panel"><h3>就绪检查</h3><p class="muted-copy" style="font-size:11px">无法执行检查：${escapeHtml(rc?.error ?? '连接失败')}</p></div>`
    return
  }
  const items = (rc.checks ?? []).map(c => `
    <div class="ready-item"><span class="dot ${c.status}"></span>
      <span>${escapeHtml(c.label)}${c.status !== 'ok' && c.detail ? ` <small class="muted-copy" style="font-size:10px;display:block;margin:2px 0 0">${escapeHtml(c.detail)}</small>` : ''}</span>
      ${c.action === 'load' ? '<button style="margin-left:auto;font-size:10px" data-ready-action="load">加载 Worker</button>' : ''}
      ${c.action === 'reload' ? '<button style="margin-left:auto;font-size:10px" data-ready-action="reload">↻ 重载 Worker</button>' : ''}
      ${c.action === 'run' ? '<button style="margin-left:auto;font-size:10px" data-ready-action="run">▶ 切换到运行</button>' : ''}
      ${c.action === 'config' ? `<button style="margin-left:auto;font-size:10px" data-ready-action="config" data-ready-check="${escapeHtml(c.id)}">去配置</button>` : ''}
      ${c.action === 'models' ? '<button style="margin-left:auto;font-size:10px" data-ready-action="models">去录入</button>' : ''}
    </div>`).join('')
  const layerStatusClass = status => status === 'ready' ? 'ok' : status === 'checking' || status === 'degraded' || status === 'not-started' ? 'warn' : 'err'
  const renderLayers = (title, item) => {
    const layers = Array.isArray(item?.layers) ? item.layers : []
    if (!layers.length) return ''
    return `<details class="ready-layers"><summary>${escapeHtml(title)}分层诊断（${layers.length}）</summary>${layers.map(layer => `<div class="ready-layer"><span class="dot ${layerStatusClass(layer.status)}"></span><span><b>${escapeHtml(layer.label)}</b><small>${escapeHtml(layer.summary)}${layer.detail ? ` · ${escapeHtml(layer.detail)}` : ''}</small></span>${layer.code ? `<code>${escapeHtml(layer.code)}</code>` : ''}</div>`).join('')}</details>`
  }
  const summaryClass = rc.allOk ? 'ok' : 'err'
  const summaryText = rc.allOk ? 'OK 全部就绪，可以开始聊天' : rc.criticalOk ? `WARNING 基本就绪（${rc.checks.filter(c => c.status !== 'ok').length} 项待完善）` : 'ERROR 尚未就绪'
  panel.innerHTML = `<div class="ready-panel"><h3>就绪检查</h3>${items}${renderLayers('渠道', rc.channel)}${renderLayers('账号', rc.account)}<div class="ready-summary ${summaryClass}">${summaryText}</div></div>`
  void updateStatusBar()
  // 绑定操作按钮
  // 二轮#1(B04): 按检查项定位目的地——不再把 'bots' 当故事 ID 传给 openConfig，
  // 也不让所有检查项共用一个目的地。
  panel.querySelectorAll('[data-ready-action]').forEach(btn => {
    btn.addEventListener('click', () => {
      const action = btn.dataset.readyAction
      if (action === 'load') void loadSelected()
      // needs-reload 必须走真正的 unload+load：load() 对运行中 worker 是幂等
      // no-op，点"加载"只会假装修好（needsReload 被清而旧配置仍在跑）。
      else if (action === 'reload') void reloadSelected()
      else if (action === 'run') void runStoryFromReadiness()
      else if (action === 'models') openConfigTab('providers')
      else if (action === 'config') {
        const check = btn.dataset.readyCheck
        if (check === 'model') openConfigTab('providers')
        else if (check === 'whitelist') openConfigTab('users')
        else if (check === 'channel') openAccountPanel()
        else openConfigTab('story')
      }
    })
  })
}

/** 就绪检查「切换到运行」：暂停/静音中的剧本一键回 running（与 Space 循环同一 IPC）。 */
async function runStoryFromReadiness() {
  const story = selectedStory(); if (!story) return
  const storyId = story.meta.id
  try {
    await desktop.stories.setPhase(storyId, 'running')
    showToast('剧本已切换到运行。', 'ok')
    await refresh()
    if (state.surface === 'connect') await renderReadyPanel()
  } catch (error) { reportUserError(storyId, '切换到运行失败：' + error) }
}

// ============================================================
// P0: 首次使用向导
// ============================================================

let wizardStep = 1

function openWizard() {
  wizardStep = 1
  byId('story-form').reset()
  updateWizardUI()
  byId('story-dialog').showModal()
}

function updateWizardUI() {
  document.querySelectorAll('.wizard-step').forEach(s => s.hidden = s.dataset.step !== String(wizardStep))
  // 新步骤从头上读起：矮视口下主体可滚，切换时归顶。
  const wizardBody = document.querySelector('#story-form .wizard-body')
  if (wizardBody) wizardBody.scrollTop = 0
  byId('wizard-prev').hidden = wizardStep <= 1
  byId('wizard-next').hidden = wizardStep >= 6
  byId('wizard-submit').hidden = wizardStep < 6
  byId('wizard-skip').hidden = wizardStep !== 4 // 步骤4（渠道）可跳过
  byId('story-form-title').textContent = `新建剧本（${wizardStep}/6）`
  // 步骤 3（模型）和 4（渠道）加载状态检查；6 为创建前检查清单
  if (wizardStep === 3) void checkWizardModel()
  if (wizardStep === 4) void checkWizardChannel()
  if (wizardStep === 6) void renderWizardReadyCheck()
  void runThemeInteraction('wizard', 'switch', document.querySelector(`.wizard-step[data-step="${wizardStep}"]`))
}

function wizardProviderInput() {
  const form = byId('story-form')
  const get = n => form.querySelector(`[name=${n}]`)?.value?.trim() ?? ''
  return { mode: get('providerMode'), model: get('providerModel'), endpoint: get('providerEndpoint'), apiKey: get('providerApiKey') }
}

// B21: 模型步骤既显示"将要写入什么"，也保留现有剧本的模型状态作参考。
async function checkWizardModel() {
  const el = byId('wizard-model-status'); if (!el) return
  el.className = 'wizard-status'
  const p = wizardProviderInput()
  if (p.model && p.apiKey) {
    // 与主进程 model-readiness 的 OFFICIAL_MODES 口径一致：只有 openai-compatible
    // 需要端点；openrouter / gemini 系官方预设同样自动使用官方端点。
    if (p.mode === 'openai-compatible' && !p.endpoint) {
      el.textContent = `WARNING ${p.mode} 需要填写端点地址`
      el.className = 'wizard-status err'; return
    }
    el.textContent = `OK 创建时将写入：${p.mode} · ${p.model}`
    el.className = 'wizard-status ok'; return
  }
  if (p.model || p.apiKey) {
    el.textContent = 'WARNING 模型名和 API Key 需同时填写（或都留空，稍后配置）'
    el.className = 'wizard-status err'; return
  }
  try {
    const story = selectedStory()
    if (story && desktop.connection) {
      const rc = await desktop.connection.firstRunReadiness(story.meta.id)
      const model = (rc.checks ?? []).find(c => c.id === 'model')
      if (model) {
        el.textContent = `INFO 现有剧本「${story.meta.name}」的模型：${model.detail || model.label}。新剧本的模型请在上方填写。`
        return
      }
    }
  } catch { /* fall through */ }
  el.textContent = '未配置模型。在上方填写，或创建后在「配置 → 模型提供商」中设置。'
}

// B20: 渠道步骤显示 SnowLuma 检测状态；填写机器人账号则显示将执行的绑定。
async function checkWizardChannel() {
  const el = byId('wizard-channel-status'); if (!el) return
  el.className = 'wizard-status'
  const form = byId('story-form')
  const accountId = form.querySelector('[name=botSelfId]')?.value?.trim() ?? ''
  const channelKind = form.querySelector('[name=botChannelKind]')?.value ?? 'qq'
  if (accountId) {
    const valid = channelKind === 'qq' ? /^\d{5,11}$/.test(accountId) : /^[A-Za-z0-9_-]{4,64}$/.test(accountId)
    const label = channelKind === 'qq' ? 'QQ' : channelKind === 'wechat' ? '微信' : '该通道'
    if (valid) { el.textContent = `OK 创建时将绑定${label}账号 ${accountId}`; el.className = 'wizard-status ok' }
    else { el.textContent = channelKind === 'qq' ? 'ERROR QQ 通道的账号须为 5–11 位数字' : 'ERROR 账号 ID 须为 4–64 位字母、数字、下划线或连字符'; el.className = 'wizard-status err' }
    return
  }
  try {
    if (desktop.connection) {
      const det = await desktop.connection.detect()
      const workers = Array.isArray(det.workers) ? det.workers : []
      const running = workers.some(w => w.bridgeReady)
      const snow = det.snowluma === 'running' ? 'SnowLuma 运行中' : det.snowluma === 'installed' ? 'SnowLuma 已安装（未运行）' : '未检测到 SnowLuma'
      if (running) { el.textContent = `OK ${snow}，且已有运行中的 Worker 连接`; el.className = 'wizard-status ok' }
      else { el.textContent = `WARNING ${snow}——在上方填写机器人账号，或稍后在「连接」页配置` }
      return
    }
  } catch { /* fall through */ }
  el.textContent = 'WARNING 可稍后在「连接」页配置'
}

// V2 §6.2 创建前检查：清单（当前值/状态/操作），提交按钮文案随阻断项变化。
async function renderWizardReadyCheck() {
  const el = byId('wizard-ready-check'); if (!el) return
  const form = byId('story-form')
  const name = form.querySelector('[name=name]')?.value?.trim() ?? ''
  const char = form.querySelector('[name=characterName]')?.value?.trim() ?? ''
  const profile = form.querySelector('[name=characterProfile]')?.value?.trim() ?? ''
  const world = form.querySelector('[name=world]')?.value?.trim() ?? ''
  const whitelist = form.querySelector('[name=whitelist]')?.value?.trim() ?? ''
  const p = wizardProviderInput()
  const botSelfId = form.querySelector('[name=botSelfId]')?.value?.trim() ?? ''
  const botChannelKind = form.querySelector('[name=botChannelKind]')?.value ?? 'qq'
  const botChannelLabel = botChannelKind === 'wechat' ? '微信' : botChannelKind === 'other' ? '其他通道' : 'QQ'
  const whitelistCount = whitelist ? whitelist.split('\n').filter(Boolean).length : 0
  const modelReady = !!(p.model && p.apiKey && !(/compatible|openrouter|gemini-openai|gemini-interactions/.test(p.mode) && !p.endpoint))
  const rows = [
    { label: '故事名称', value: name || '（未填写）', state: name ? 'ok' : 'err', goto: 1 },
    { label: '主角设定', value: char ? (char + (profile ? ' · 已填写' : '')) : '（未填写）', state: char ? 'ok' : 'err', goto: 1 },
    { label: '世界观', value: world || '（默认现代都市）', state: 'ok', goto: 2 },
    { label: '模型', value: modelReady ? (p.mode + ' · ' + p.model) : '未配置', state: modelReady ? 'ok' : 'later', goto: 3 },
    { label: '通道 / 账号', value: botSelfId ? (botChannelLabel + ' · ' + botSelfId) : '未配置', state: botSelfId ? 'ok' : 'later', goto: 4 },
    { label: '白名单', value: whitelistCount ? (whitelistCount + ' 人') : '（允许所有人）', state: whitelistCount ? 'ok' : 'later', goto: 5 },
  ]
  const stateLabel = { ok: '✓ 已完成', err: '✗ 必填', later: '◌ 可稍后' }
  const stateColor = { ok: 'var(--status-success)', err: 'var(--status-danger)', later: 'var(--dim)' }
  el.innerHTML = '<table class="wizard-check-table"><thead><tr><th>项目</th><th>当前值</th><th>状态</th><th>操作</th></tr></thead><tbody>'
    + rows.map(row => '<tr><td>' + escapeHtml(row.label) + '</td><td>' + escapeHtml(row.value) + '</td><td style="color:' + stateColor[row.state] + '">' + stateLabel[row.state] + '</td><td><button type="button" data-wizard-goto="' + row.goto + '">编辑</button></td></tr>').join('')
    + '</tbody></table>'
  el.querySelectorAll('[data-wizard-goto]').forEach(btn => btn.addEventListener('click', () => { wizardStep = Number(btn.dataset.wizardGoto); updateWizardUI() }))
  const submit = byId('wizard-submit')
  const blockers = rows.filter(row => row.state === 'err').length
  const laters = rows.filter(row => row.state === 'later').length
  if (submit) {
    submit.textContent = blockers ? '请先完成必填项' : laters ? '创建，稍后配置' : '创建剧本'
    submit.disabled = blockers > 0
  }
}

// ── 三视图模式：一次性布局预设（应用后可继续手动微调，模式仅作起点与高亮）──
// 日常=只看她的生活流（隐藏两侧面板）；工作台=完整 Studio；诊断=聚焦 Logs，默认收起 Inspector/Detail。
function applyViewMode(mode) {
  if (!['daily', 'workbench', 'diagnostics'].includes(mode)) return
  if (mode === 'daily') {
    state.browserView = 'overview'; lastRenderedSnapshotKey = ''
    setSurface('studio')
    choosePanel('browser', false); choosePanel('inspector', false); choosePanel('detail', false)
    renderContext()
  } else if (mode === 'workbench') {
    setSurface('studio')
    choosePanel('browser', true); choosePanel('inspector', true); choosePanel('detail', true)
    renderContext()
  } else {
    setSurface('logs')
    choosePanel('inspector', false); choosePanel('detail', false)
  }
  state.viewMode = mode; persist()
  document.querySelectorAll('[data-view-mode]').forEach(node => node.classList.toggle('active', node.dataset.viewMode === mode))
  document.querySelector('details.layout-menu[open]')?.removeAttribute('open')
}

function setDetail(detail, { reveal = true } = {}) {
  state.detail = detail; persist()
  if (reveal && !effectivePanels().detail) choosePanel('detail', true)
  document.querySelectorAll('[data-detail]').forEach(node => node.classList.toggle('active', node.dataset.detail === detail))
  renderDetail()
}

function selectStory(id, shouldFetchSnapshot = true) {
  // 审查T8: 停留在连接页时切换故事，就绪面板要跟着刷新。
  if (state.surface === 'connect') void renderConnectView() // B4：左右两栏同源刷新，避免新剧本配旧步骤卡
  // UI-32: 切故事时主动撤下旧 Console 嵌入
  if (state.storyId !== id && consoleState.embedded) void detachConsole()
  state.storyId = id || ''; state.snapshot = null; state.snapshotError = null; state.hostOverview = null; state.deliveryHistory = []; state.usageSeries = []; state.inspected = null; state.selectedScript = null; state.selection = null; persist()
  updateRunStateText(); syncReadinessForStory(state.storyId); void updateStatusBar()  // 切换立即反映，不等下一轮刷新
  byId('story-select').value = state.storyId
  renderStoryList(); renderContext(); void hydrateLogs(); void refreshHostProjection()
  void refreshAccountPanel()
  if (shouldFetchSnapshot && id) void refreshSnapshot()
}

let hostProjectionTimer = null
/** 性能审计：投递/token 事件每次触发 3 个 IPC 全量读（overview+deliveries+usage），
 * 一条分段回复可放大到 9 轮——尾随防抖 120ms 合并（幂等读）。 */
function scheduleHostProjectionRefresh() {
  if (hostProjectionTimer) return
  hostProjectionTimer = setTimeout(() => { hostProjectionTimer = null; void refreshHostProjection() }, 120)
}
async function refreshHostProjection() {
  const story = selectedStory()
  if (!story) { state.hostOverview = null; state.deliveryHistory = []; state.usageSeries = []; if (state.browserView === 'overview') renderStoryHud(byId('story-hud'), null); renderInspector(); renderDetail(); return }
  const storyId = story.meta.id
  try {
    const [overview, deliveries, usageSeries] = await Promise.all([
      desktop.runtime.overview(storyId), desktop.stories.deliveries(storyId, { limit: 120 }), desktop.stories.usage(storyId, { limit: 90 }),
    ])
    // P2 竞态批次：投影数据源是宿主文件（outbox/inbox/logs），worker 重启不使其
    // 失效——故只做故事切换守卫，不加 pid 锚点（加了反而错误丢弃仍有效的数据）。
    if (state.storyId !== storyId) { noteStaleDrop('projection', '故事已切换'); return }
    state.hostOverview = overview; state.deliveryHistory = deliveries; state.usageSeries = usageSeries
    // Host rows can change status/content without changing the ledger length.
    state.deliveriesRev = (state.deliveriesRev || 0) + 1
    state.usageRev = (state.usageRev || 0) + 1
  } catch (error) {
    if (state.storyId === storyId) appendLog({ storyId, line: `读取宿主状态投影失败：${error}` }, false)
  }
  if (state.browserView === 'overview') renderStoryHud(byId('story-hud'), state.snapshot)
  renderInspector(); renderDetail()
  // V7 数据面消费 hostOverview（CHANNEL/MODEL/updatedAt 均入渲染 key）——投影
  // 刷新后需触发一次重渲染；V7 分支自带 key 记忆化，无变化时不重绘。V4 的
  // Arrangement 不消费投影，不在触发之列（避免时间线无谓重排）。
  if (document.body.classList.contains('v7-profile-active')) renderArrangement()
}

var snapshotFlight=null
var snapshotAgain=false
/** P2 竞态批次：过期响应丢弃计数（worker 重启/切故事/新请求后晚归结果被守卫
 *  拒绝）。仅内存计数 + devtools console.debug——不进日志页（守卫触发高频，
 *  入页会刷屏；需要时在 devtools 里读）。 */
var staleDropCounters = { timeline: 0, projection: 0 }
function noteStaleDrop(surface, reason) {
  staleDropCounters[surface] = (staleDropCounters[surface] ?? 0) + 1
  console.debug('[stale] ' + surface + ' 响应已丢弃：' + reason)
}
function refreshSnapshot(){
  if(snapshotFlight){snapshotAgain=true;return snapshotFlight}
  snapshotFlight=readSnapshot().finally(()=>{snapshotFlight=null;noteTimelineRefresh();if(snapshotAgain){snapshotAgain=false;clearTimeout(viewportRefreshTimer);viewportRefreshTimer=setTimeout(()=>void refreshSnapshot(),100)}})
  return snapshotFlight
}
async function readSnapshot() {
  const story = selectedStory()
  if (!story) return renderArrangement()
  if (!story.running || !story.bridgeReady) {
    state.snapshot = null; renderArrangement(); renderInspector(); renderDetail(); return
  }
  byId('detail-status').textContent = 'READING SNAPSHOT…'
  const requestRevision = ++snapshotRequestRevision
  // P2 竞态批次：worker 身份锚点——同一故事的 worker 崩溃重启后 storyId/revision
  // 都不变，重启前在飞的旧 worker 响应仍可能落地。pid 在重启后必然变化
  // （卸载后为 undefined），落地时不一致即丢弃。
  const workerPid = story.pid
  state.timelineCompat = false
  const viewport = timelineViewport(story.meta.id)
  try {
    let snapshot
    try {
      snapshot = await desktop.stories.timelineRange(story.meta.id, {
        from: viewport.from, to: viewport.to,
        tracks: ['script', 'messages', 'system', 'scenes', 'facts', 'preplan', 'alter', 'compaction'], detailLevel: 'full', limit: 240,
      })
      const entries=new Map((snapshot.entries||[]).map(e=>[e.entityId||e.id,e]))
      let cursor=snapshot.nextCursor, pages=0
      const cursors=new Set()
      while(cursor&&pages++<8&&!cursors.has(cursor)&&requestRevision===snapshotRequestRevision&&state.storyId===story.meta.id&&selectedStory()?.pid===workerPid){
        cursors.add(cursor)
        const page=await desktop.stories.timelineRange(story.meta.id,{from:viewport.from,to:viewport.to,cursor,limit:240,detailLevel:'full'})
        for(const e of page.entries||[])entries.set(e.entityId||e.id,e)
        cursor=page.nextCursor
      }
      snapshot.nextCursor=cursor
      // The nearest earlier script supplies the left-edge continuation anchor.
      const prior=await desktop.stories.timelineRange(story.meta.id,{from:new Date(0).toISOString(),to:viewport.from,tracks:['script'],limit:1,detailLevel:'full'})
      for(const e of prior.entries||[])entries.set(e.entityId||e.id,e)
      snapshot.entries=[...entries.values()].sort((a,b)=>Date.parse(a.occurredAt)-Date.parse(b.occurredAt))
    } catch (rangeError) {
      // A worker with the pre-M3 bridge remains readable. This fallback is
      // deliberately temporary and never fabricates an M3 revision/range.
      appendLog({ storyId: story.meta.id, line: `范围时间线不可用，已退回兼容快照：${rangeError}` }, false)
      snapshot = await desktop.stories.timeline(story.meta.id, 120)
      // P1：兼容模式显性化——状态栏 detail-status 常驻标记，不再只有一行日志。
      state.timelineCompat = true
    }
    if (state.storyId !== story.meta.id || requestRevision !== snapshotRequestRevision) { noteStaleDrop('timeline', '故事已切换或已有更新请求'); return }
    if (selectedStory()?.pid !== workerPid) { noteStaleDrop('timeline', 'worker 已重启/卸载，旧 worker 响应丢弃'); return }
    state.snapshot = snapshot
    state.snapshotError = null
    restoreSelection(snapshot)
    byId('detail-status').textContent = state.timelineCompat
      ? `兼容快照 · ${compact(snapshot.updatedAt || 'LIVE', 28)}`
      : snapshot.revision ? `REVISION · ${compact(snapshot.revision, 28)}` : `SNAPSHOT · ${compact(snapshot.updatedAt || 'LIVE', 28)}`
  } catch (error) {
    if (state.storyId === story.meta.id && requestRevision === snapshotRequestRevision && selectedStory()?.pid === workerPid) {
      appendLog({ storyId: story.meta.id, line: `读取时间线失败：${error}` })
      state.snapshot = null
      state.snapshotError = String(error)
    }
  }
    // 只在快照 revision 变化时才触发完整重绘（Inspector/Detail 始终刷新）
  renderInspector(); renderDetail()
  const storyMeta = byId('transport-story-meta')
  if (storyMeta && state.snapshot) storyMeta.textContent = `${state.snapshot.timezone || '时区未提供'} · ${state.snapshot.cursorAt ? `${dateText(state.snapshot.cursorAt)} ${hudTime(state.snapshot.cursorAt)}` : '叙事游标未提供'}`
  const newKey = `${state.storyId}:${state.snapshot?.revision ?? 'none'}:${state.browserView}:${JSON.stringify(layoutFor().tracks)}:${state.snapshot?.range?.from || ''}:${state.snapshot?.range?.to || ''}:${selectedStory()?.running}:${selectedStory()?.bridgeReady}`
  if (newKey !== lastRenderedSnapshotKey) renderArrangement()
  else { paintTimeline() }
}async function refreshAccountPanel() {
  // UI_DESIGN_SPEC_V2 §2/§5.3：侧栏账号改为只读摘要——连接页是唯一写入口，
  // 杜绝两处编辑同一账号的修改冲突。
  const pane = byId('account-panel')
  if (!pane) return
  const story = selectedStory()
  if (!story) { pane.innerHTML = '<small class="account-hint">选择一个剧本后显示账号摘要。</small>'; return }
  let status
  // 审计：失败分支此前不带故事守卫——切换故事后迟到的错误会覆盖新故事的面板。
  try { status = await desktop.accounts.status(story.meta.id) } catch (error) { if (state.storyId === story.meta.id) pane.innerHTML = '<small class="account-hint">读取账号状态失败：' + escapeHtml(String(error)) + '</small>'; return }
  const externalState = status.external?.state || 'not-configured'
  if (state.storyId !== story.meta.id) return
  const kindLabel = status.entry?.channelKind === 'wechat' ? '微信' : status.entry?.channelKind === 'other' ? '其他通道' : 'QQ'
  const stateBadge = status.entry
    ? (externalState === 'online' ? '<em class="account-led online">● 渠道在线</em>'
      : externalState === 'connecting' ? '<em class="account-led ready">◌ 连接中</em>'
      : externalState === 'configuration-error' ? '<em class="account-led drift">● 配置错误</em>'
      : '<em class="account-led offline">○ 离线</em>')
    : '<em class="account-led offline">◌ Idle · 无账号</em>'
  pane.innerHTML = '<div class="account-row">' + stateBadge + '<span>' + escapeHtml(status.entry?.selfId || '未登记') + '</span><span class="account-nick">' + escapeHtml(status.entry?.nickname || '') + '</span></div>'
    + (status.entry ? '<small class="account-hint">通道：' + kindLabel + (status.entry?.externalUpstream?.endpoint ? ' · 外部上游已配置' : '') + '</small>' : '<small class="account-hint">Idle：此剧本未绑定账号（无消息进入）。在连接页接入或从插件版导入。</small>')
    + '<div class="account-actions"><button id="account-goto-connect" class="primary">在连接页管理 →</button></div>'
  byId('account-goto-connect')?.addEventListener('click', () => void openAccountPanel())
}

function renderStoryList() {
  const filter = byId('story-filter').value.trim().toLowerCase()
  const list = byId('story-list')
  // §2：refresh() 由 story:inbox / stories:changed 等后台事件高频触发，全量重建
  // 会销毁正在浏览列表的用户的焦点与滚动位置——记录归属，重建后原位恢复。
  const activeEl = document.activeElement
  const activeStoryId = activeEl && list.contains(activeEl)
    ? (activeEl.dataset.storyId ?? activeEl.closest('[data-story-id]')?.dataset.storyId ?? '')
    : ''
  const listScrollTop = list.scrollTop
  list.replaceChildren()
  const visible = state.stories.filter(story => !filter || `${story.meta.name} ${story.meta.characterName} ${story.meta.id}`.toLowerCase().includes(filter))
  byId('story-count').textContent = `${visible.length} STORIES`
  // 分支树：按谱系排序并缩进；orphan（来源缺失）标注但不限制功能。
  const trees = buildBranchTree(visible)
  const ordered = trees.flatMap(tree => tree.nodes.map(node => ({
    meta: visible.find(story => story.meta.id === node.storyId),
    node,
  }))).filter(item => item.meta)
  for (const { meta: story, node } of ordered) {
    const button = document.createElement('button'); button.className = `story-strip ${story.meta.phase}${story.meta.id === state.storyId ? ' selected' : ''}`
    button.dataset.storyId = story.meta.id
    const indent = node.depth > 0 ? `margin-left:${Math.min(node.depth, 4) * 14}px` : ''
    const lineage = node.parent ? `<span class="branch-tag" title="自 ${escapeHtml(dateText(node.parent.forkedAt))} 分出">${node.orphan ? ' orphan' : ''}分支</span>` : ''
    button.innerHTML = `<span class="story-led ${story.running ? 'online' : ''}"></span><span style="${indent}"><b>${escapeHtml(story.meta.name)}${lineage}</b><small>${escapeHtml(story.meta.characterName)} · ${escapeHtml(story.meta.id)}</small></span><em>${story.running ? (story.bridgeReady ? 'LIVE' : 'BOOT') : `<span title="上次运行状态：${escapeHtml(String(phases[story.meta.phase] ?? story.meta.phase))}">OFFLINE</span>`}</em>`
    button.addEventListener('click', () => selectStory(story.meta.id))
    bindContextMenu(button, () => [
      // 菜单动作必须作用于右键点中的故事（story.meta.id），不得走 selectedStory()——
      // 右键不改变选中，旧实现会把加载/备份作用到另一个故事上。
      { label: story.running ? '■ 卸载 Worker' : '▶ 加载 Worker', action: async () => { try { if (story.running) await desktop.stories.unload(story.meta.id); else await desktop.stories.load(story.meta.id); await refresh() } catch (error) { reportUserError(story.meta.id, String(error)) } } },
      { label: '▣ 备份', action: () => void backupStoryById(story.meta.id) },
      { label: '⇄ 回放收件箱', disabled: !(story.meta.id === state.storyId && (state.hostOverview?.inbox?.pending ?? 0) > 0), action: () => void replayStoryInbox(story.meta.id) },
      { separator: true },
      { label: 'DELETE 删除剧本…', action: () => void deleteStory(story) },
    ])
    list.appendChild(button)
  }
  if (activeStoryId) list.querySelector(`.story-strip[data-story-id="${CSS.escape(activeStoryId)}"]`)?.focus()
  list.scrollTop = listScrollTop
}

// 渲染进程版分支树构建（与主进程 branch-registry.ts 同语义的纯函数副本；
// renderer 不能 require TS 模块，此函数无 IO 无副作用，行为由 runtime 测试锚定）。
function buildBranchTree(stories) {
  const byId = new Map(stories.map(story => [story.meta.id, story.meta]))
  const memo = new Map()
  const resolve = (id, seen) => {
    if (memo.has(id)) return memo.get(id)
    const meta = byId.get(id)
    if (!meta) return undefined
    const parent = meta.parent
    if (!parent) { const r = { rootId: id, depth: 0, orphan: false }; memo.set(id, r); return r }
    if (seen.has(id) || seen.size > 32) { const r = { rootId: id, depth: 0, orphan: false }; memo.set(id, r); return r }
    seen.add(id)
    const parentResolved = byId.has(parent.storyId) ? resolve(parent.storyId, seen) : undefined
    const r = parentResolved
      ? { rootId: parentResolved.rootId, depth: parentResolved.depth + 1, orphan: parentResolved.orphan }
      : { rootId: id, depth: 0, orphan: true }
    memo.set(id, r)
    return r
  }
  const trees = new Map()
  for (const meta of byId.values()) {
    const resolved = resolve(meta.id, new Set())
    if (!resolved) continue
    const rootId = resolved.orphan ? meta.id : resolved.rootId
    let tree = trees.get(rootId)
    if (!tree) { tree = { rootId, nodes: [] }; trees.set(rootId, tree) }
    tree.nodes.push({
      storyId: meta.id, name: meta.name,
      ...(meta.parent ? { parent: meta.parent } : {}),
      orphan: resolved.orphan,
      depth: resolved.depth,
    })
  }
  for (const tree of trees.values()) tree.nodes.sort((a, b) => a.depth - b.depth || a.name.localeCompare(b.name, 'zh-CN'))
  return [...trees.values()].sort((a, b) => a.rootId.localeCompare(b.rootId))
}
/** 规范 §4.3：运行状态必须图标+文字——四态文案与行为说明。 */
function updateRunStateText() {
  const el = byId('run-state-text'); if (!el) return
  const story = selectedStory()
  let text = '离线 · Worker 未加载'
  let busy = false
  if (story) {
    if (!story.running) text = '离线 · Worker 未加载'
    else if (!story.bridgeReady) { text = '启动中 · Worker 正在加载'; busy = true }
    else if (story.meta.phase === 'muted') text = '静音中 · 继续生成但不发送'
    else if (story.meta.phase === 'paused') text = '已暂停 · 新消息进入收件箱'
    else text = '运行中 · 正常收发与自动推进'
  }
  el.textContent = unassignedInboxCount > 0 ? `${text} · 未分配 ${unassignedInboxCount}` : text
  el.classList.toggle('busy', busy)
  const phaseControl = document.querySelector('.transport-state')
  const phaseKey = !story?.running ? 'offline' : !story.bridgeReady ? 'booting' : (story.meta.phase || 'running')
  const phaseLabel = { offline: 'OFFLINE', booting: 'BOOTING', running: 'RUNNING', muted: 'MUTED', paused: 'PAUSED' }[phaseKey] || 'UNKNOWN'
  if (phaseControl) {
    phaseControl.dataset.phase = phaseKey
    phaseControl.dataset.phaseLabel = phaseLabel
    phaseControl.querySelectorAll('[data-phase]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.phase === story?.meta?.phase && !!story?.running)))
  }
}

/** 规范 §4.4：状态栏四摘要——Worker/通道/模型分源，不用一个字段代表所有故障。 */
async function updateStatusBar() {
  const story = selectedStory()
  const storyIdAtEntry = state.storyId
  const channelEl = byId('channel-state'); const modelEl = byId('model-state')
  const bridgeEl = byId('bridge-state')
  if (!channelEl || !modelEl) return
  // 桥：会话快照（P1）。订阅事件实时更新缓存；此处再拉一次权威状态，
  // 覆盖"刚切换故事/事件尚未到达"的窗口。拉取失败保留缓存显示。
  if (story?.running && bridgeEl) {
    try {
      const fresh = await desktop.stories.bridgeStatus(story.meta.id)
      if (fresh && storyIdAtEntry === state.storyId) bridgeStatusState.byStory.set(story.meta.id, fresh)
    } catch { /* 未加载/剧本不存在等——chip 回退缓存或默认文案 */ }
  }
  if (bridgeEl) {
    // §3 同款守卫：晚到的桥快照不得写进已切换故事的 chip。
    if (storyIdAtEntry === state.storyId) {
      const chip = bridgeChipFor(story)
      bridgeEl.textContent = chip.text; bridgeEl.className = chip.className
      bridgeEl.title = chip.title
    }
  }
  // 通道：所选故事的账号外部连接状态
  let channelText = '通道：未知'; let channelClass = 'status-cell'
  if (!story) { channelText = '通道：—' }
  else {
    try {
      const accounts = await desktop.accounts.list()
      const entry = (Array.isArray(accounts) ? accounts : []).find(item => item.storyId === story.meta.id)
      if (!entry) { channelText = '通道：未绑定'; channelClass = 'status-cell warn' }
      else if (entry.externalState === 'online') { channelText = `通道：${entry.channelKind === 'wechat' ? '微信' : 'QQ'} 在线`; channelClass = 'status-cell ok' }
      else if (entry.externalState === 'connecting') { channelText = '通道：连接中'; channelClass = 'status-cell warn' }
      else if (entry.externalState === 'configuration-error') { channelText = '通道：配置错误'; channelClass = 'status-cell err' }
      else { channelText = '通道：离线'; channelClass = 'status-cell err' }
    } catch { channelText = '通道：未知' }
  }
  // §3：快速切故事时，晚到的通道探测不得把上一个故事的文案写进状态栏。
  if (storyIdAtEntry !== state.storyId) return
  channelEl.textContent = channelText; channelEl.className = channelClass
  // 模型：就绪检查缓存（renderReadyPanel 刷新；未选故事显示 —）
  let modelText = '模型：—'; let modelClass = 'status-cell'
  if (story) {
    const modelCheck = (connectState.readiness?.checks ?? []).find(check => check.id === 'model')
    if (modelCheck?.status === 'ok') { modelText = '模型：可用'; modelClass = 'status-cell ok' }
    else if (modelCheck?.status === 'warn') { modelText = '模型：状态不明'; modelClass = 'status-cell warn' }
    else if (modelCheck?.status === 'err') { modelText = '模型：未配置'; modelClass = 'status-cell err' }
    else { modelText = '模型：检查中'; modelClass = 'status-cell' }
  }
  modelEl.textContent = modelText; modelEl.className = modelClass
}

function renderContext() {
  const story = selectedStory()
  const select = byId('story-select')
  // §2：下拉选项全量重建不得丢掉正在操作 select 的用户的焦点。
  const selectHadFocus = document.activeElement === select
  select.replaceChildren()
  const placeholder = new Option(state.stories.length ? '选择故事' : '暂无故事', '')
  select.add(placeholder)
  for (const item of state.stories) select.add(new Option(`${item.meta.name} · ${item.meta.characterName}`, item.meta.id, false, item.meta.id === state.storyId))
  if (selectHadFocus) select.focus()
  byId('story-phase-readout').textContent = story ? (story.running ? `${String(phases[story.meta.phase] ?? story.meta.phase).toUpperCase()} · ${story.meta.id}` : `OFFLINE · ${story.meta.id}`) : '未选择故事'
  byId('story-health').textContent = story?.running ? (story.bridgeReady ? 'WORKER READY' : 'WORKER BOOTING') : 'WORKER OFFLINE'
  updateRunStateText()
  byId('workspace-subtitle').textContent = state.browserView === 'overview'
    ? (story ? '时间线、场景与连续性记录' : '选择一个故事以开始观察')
    : story ? `${story.meta.name} · ${story.meta.characterName} · ${story.running ? 'Worker 已加载' : 'Worker 未加载'}` : '选择一个故事以开始观察'
  byId('workspace-title').textContent = { settings: '故事配置', session: '剧本阅读', mixer: '行为设置', stats: '运行统计', analysis: '语义分析', overview: '故事总览', timeline: '时间线', facts: '事实与场景', schedule: '日程计划' }[state.browserView] || 'Arrangement'
  document.querySelectorAll('[data-browser-view]').forEach(node => node.classList.toggle('active', node.dataset.browserView === state.browserView))
  document.querySelectorAll('[data-studio-mode]').forEach(node => {
    const active = node.dataset.studioMode === state.browserView
    node.classList.toggle('active', active)
    node.setAttribute('aria-pressed', String(active))
  })
  byId('koishi-story').textContent = story ? `${story.meta.name} (${story.meta.id})` : '未选择'
  byId('koishi-worker').textContent = story?.running ? (story.bridgeReady ? '已就绪' : '启动中') : '未加载'
  byId('story-timezone').textContent = state.snapshot?.timezone || 'LOCAL TIME'
  const storyMeta = byId('transport-story-meta')
  if (storyMeta) storyMeta.textContent = story ? `${state.snapshot?.timezone || '时区待读取'} · ${state.snapshot?.cursorAt ? `${dateText(state.snapshot.cursorAt)} ${hudTime(state.snapshot.cursorAt)}` : '叙事游标待读取'}` : '选择一个故事以查看运行状态'
  applyPanelLayout(); renderTrackMenu(); renderArrangementScale()
  renderArrangement(); renderInspector(); renderDetail()
  if (state.surface === 'koishi') void refreshConsoleInfo()
}

function panelTaskKey() {
  return `${state.storyId || '__desktop__'}:${state.surface}:${state.surface === 'studio' ? state.browserView : ''}`
}
function isFocusedTask() {
  return state.surface !== 'studio' || ['overview', 'session', 'mixer', 'stats', 'analysis'].includes(state.browserView)
}
function effectivePanels() {
  const panels = { ...layoutFor().panels }
  if (isFocusedTask()) Object.assign(panels, { inspector: false, detail: false }, taskPanelOverrides.get(panelTaskKey()))
  return panels
}
function choosePanel(name, visible) {
  if (!visible) byId(`${name}-panel`)?.classList.remove('panel-open')
  if (name !== 'browser' && isFocusedTask()) {
    const key = panelTaskKey()
    taskPanelOverrides.set(key, { ...taskPanelOverrides.get(key), [name]: visible })
  } else {
    const layout = layoutFor(); layout.panels[name] = visible
  }
  persist()
  applyPanelLayout()
}

function applyPanelLayout() {
  const layout = layoutFor()
  const shell = document.querySelector('.studio-shell')
  const panels = effectivePanels()
  shell.classList.toggle('browser-hidden', !panels.browser)
  shell.classList.toggle('inspector-hidden', !panels.inspector)
  shell.classList.toggle('detail-hidden', !panels.detail)
  byId('browser-panel').classList.toggle('panel-collapsed', !panels.browser)
  byId('inspector-panel').classList.toggle('panel-collapsed', !panels.inspector)
  byId('detail-panel').classList.toggle('panel-collapsed', !panels.detail)
  // UI-26: 应用保存的自定义宽高（拖拽写入 layout.panelWidths/panelHeights）
  const b = panels.browser !== false
  const i = panels.inspector !== false
  const d = panels.detail !== false
  // 历史版本允许把面板宽度保存为极小值，导致 Browser/Inspector 只剩一条窄缝，
  // 既看不清内容，也无法稳定命中其中的按钮。这里对持久化数据做最终边界校验，
  // 不依赖拖拽入口是否曾经运行过。
  const workspaceMin = 420
  const browserMin = 150
  const inspectorMin = 180
  const sideBudget = Math.max(0, shell.clientWidth - workspaceMin)
  const savedBrowser = Number(layout.panelWidths?.browser)
  const savedInspector = Number(layout.panelWidths?.inspector)
  const browserMax = Math.max(browserMin, Math.min(420, sideBudget - (i ? inspectorMin : 0)))
  const bw = b ? bounded(Number.isFinite(savedBrowser) ? savedBrowser : 214, browserMin, browserMax) : 0
  const inspectorMax = Math.max(inspectorMin, Math.min(480, sideBudget - (b ? bw : 0)))
  const iw = i ? bounded(Number.isFinite(savedInspector) ? savedInspector : 264, inspectorMin, inspectorMax) : 0
  const workspaceMinHeight = Math.min(300, Math.max(120, shell.clientHeight - 80))
  const detailMax = Math.max(80, shell.clientHeight - workspaceMinHeight)
  const dh = bounded(Number.isFinite(Number(layout.panelHeights?.detail)) ? Number(layout.panelHeights.detail) : 174, 80, detailMax)

  // 860px 以下由 CSS 把 Browser/Inspector 改为抽屉或覆盖层；不要用行内 grid
  // 配置把响应式布局重新挤回三栏。
  const viewportWidth = window.innerWidth || shell.clientWidth
  if (viewportWidth <= 860) {
    shell.style.gridTemplateColumns = 'minmax(320px,1fr)'
  } else if (viewportWidth <= 1120) {
    shell.style.gridTemplateColumns = b ? `${bw}px minmax(390px,1fr)` : 'minmax(390px,1fr)'
  } else {
    shell.style.gridTemplateColumns = b && i ? `${bw}px minmax(420px,1fr) ${iw}px`
      : b ? `${bw}px minmax(420px,1fr)`
      : i ? `minmax(420px,1fr) ${iw}px`
      : 'minmax(420px,1fr)'
  }
  shell.style.gridTemplateRows = d ? `minmax(${workspaceMinHeight}px,1fr) ${dh}px` : 'minmax(0,1fr)'
  // Place every visible grid item explicitly: collapsed panels must not leave
  // implicit columns/rows, nor auto-place the Inspector below the workspace.
  byId('detail-panel').style.gridColumn = viewportWidth <= 860 || !b ? '1 / -1' : '2 / -1'
  byId('detail-panel').style.gridRow = '2'
  document.querySelector('.workspace-panel').style.gridColumn = b && viewportWidth > 860 ? '2' : '1'
  document.querySelector('.workspace-panel').style.gridRow = '1'
  byId('inspector-panel').style.gridColumn = b ? '3' : '2'
  byId('inspector-panel').style.gridRow = '1'
  document.querySelectorAll('[data-panel-toggle]').forEach(button => {
    const name = button.dataset.panelToggle
    const overlay = (name === 'inspector' && viewportWidth <= 1120) || (name === 'browser' && viewportWidth <= 860)
    const expanded = panels[name] !== false && (!overlay || byId(`${name}-panel`).classList.contains('panel-open'))
    button.setAttribute('aria-pressed', String(expanded))
    button.setAttribute('aria-expanded', String(expanded))
    button.setAttribute('aria-controls', `${name}-panel`)
    const status = button.querySelector('.dock-state')
    if (status) status.textContent = expanded ? '已展开' : '已收起'
  })

  // Detail 收起时 Browser 不再 span 2 行（让唯一一行占满全部高度）
  const browserPanel = byId('browser-panel')
  if (browserPanel) browserPanel.style.gridRow = d ? '1 / span 2' : '1'
  updatePanelRestoreStrips()
  bindResizeHandles(shell, layout, b, i)
}

// ── 面板分隔条（document 级事件，不依赖 pointer capture） ────────────────
var resizeDragState = null
function bindResizeHandles(shell, layout, b, i) {
  // 绑定三个手柄
  const handles = [
    { id: 'handle-browser', target: 'browser', axis: 'vertical' },
    { id: 'handle-inspector', target: 'inspector', axis: 'vertical' },
    { id: 'handle-detail', target: 'detail', axis: 'horizontal' },
  ]
  for (const h of handles) {
    const el = byId(h.id)
    if (!el || el.dataset.bound) continue
    el.dataset.bound = '1'
    el.addEventListener('pointerdown', event => {
      event.preventDefault()
      event.stopPropagation()
      resizeDragState = { target: h.target, axis: h.axis, x: event.clientX, y: event.clientY }
      document.body.style.cursor = h.axis === 'vertical' ? 'col-resize' : 'row-resize'
    })
  }
}

// document 级 move/up（一次绑定）
if (!document.querySelector('[data-resize-doc-bound]')) {
  document.body.setAttribute('data-resize-doc-bound', '1')
  document.addEventListener('pointermove', event => {
    if (!resizeDragState) return
    const layout = layoutFor()
    layout.panelWidths ??= { browser: 214, inspector: 264 }
    layout.panelHeights ??= { detail: 174 }
    if (resizeDragState.axis === 'vertical' && resizeDragState.target === 'browser') {
      layout.panelWidths.browser = bounded(layout.panelWidths.browser + event.clientX - resizeDragState.x, 150, 420)
    } else if (resizeDragState.axis === 'vertical' && resizeDragState.target === 'inspector') {
      layout.panelWidths.inspector = bounded(layout.panelWidths.inspector - (event.clientX - resizeDragState.x), 180, 480)
    } else if (resizeDragState.axis === 'horizontal' && resizeDragState.target === 'detail') {
      layout.panelHeights.detail = bounded(layout.panelHeights.detail - (event.clientY - resizeDragState.y), 80, 520)
    }
    resizeDragState.x = event.clientX
    resizeDragState.y = event.clientY
    applyPanelLayout()
    return

  })
  document.addEventListener('pointerup', () => {
    if (resizeDragState) { resizeDragState = null; document.body.style.cursor = ''; persist() }
  })
}


function togglePanel(name) {
  const panel = byId(`${name}-panel`)
  const overlay = (name === 'inspector' && innerWidth <= 1120) || (name === 'browser' && innerWidth <= 860)
  const visible = overlay ? !effectivePanels()[name] || !panel.classList.contains('panel-open') : !effectivePanels()[name]
  choosePanel(name, visible)
  if (overlay) panel.classList.toggle('panel-open', visible)
  applyPanelLayout()
  void runThemeInteraction('panel', visible ? 'expand' : 'collapse', byId(`${name}-panel`))
}

var timelineFrame = 0
var workspaceSaveTimer = null
function updateViewport(transform) {
  const current = timelineViewport(), layout = layoutFor()
  const next = transform({...current,spanMinutes:current.span/60000}) || {}
  if (Number.isFinite(next.spanMinutes)) layout.spanMinutes = TimelineModel.clampSpan(next.spanMinutes*60000)/60000
  if (Number.isFinite(next.center)) { layout.centerAt = new Date(next.center).toISOString(); layout.followNow = false }
  if (next.followNow != null) layout.followNow = next.followNow
  if (next.followNow === true) layout.centerAt = new Date().toISOString()
  clearTimeout(workspaceSaveTimer); workspaceSaveTimer = setTimeout(persist,350)
  if (!timelineFrame) timelineFrame = requestAnimationFrame(() => { timelineFrame=0; paintTimeline() })
  snapshotRequestRevision++
  clearTimeout(viewportRefreshTimer); viewportRefreshTimer=setTimeout(()=>void refreshSnapshot(),300)
}
function paintTimeline() {
  if (state.surface !== 'studio' || ['session','mixer','stats','settings'].includes(state.browserView)) return
  const overviewMode = state.browserView === 'overview'
  updateCanvasFromViewport()
  const from=canvas.originMs,span=canvas.totalMs,width=canvas.viewWidthPx
  for (const lane of document.querySelectorAll('.track-lane')) {
    setStyle(lane,'width',width+'px')
    const clips=[...lane.querySelectorAll('.clip[data-start-ms]')]
    const rows=TimelineModel.rows(clips.map((el,id)=>({id,start:+el.dataset.startMs,end:+el.dataset.endMs})))
    let maxRow=0
    for (const [id,el] of clips.entries()) {
      const box=TimelineModel.interval(+el.dataset.startMs,+el.dataset.endMs,from,span,width,6)
      const hidden=!box
      if(el.hidden!==hidden)el.hidden=hidden
      if (!box) continue
      setStyle(el,'left',box.left+'px');setStyle(el,'width',box.width+'px');el.classList.toggle('compact-clip',box.width<48)
      const row=overviewMode?0:(rows.get(id)||0),primary=el.classList.contains('primary-clip');maxRow=Math.max(maxRow,row)
      setStyle(el,'top',(8+row*(primary?132:34))+'px')
      if(primary){
        const preview=compact(el._scriptContent,Math.max(8,Math.floor(box.width/7)*5))
        const b=el._previewEl||(el._previewEl=el.querySelector('b'))
        if(b&&b.textContent!==preview)b.textContent=preview
      }
    }
    setStyle(lane,'minHeight',overviewMode?'34px':(16+(maxRow+1)*(lane.closest('.script-track')?132:34))+'px')
  }
  renderArrangementScale();updateTimelineScroller(timelineBounds(state.snapshot))
}

function returnToNow() {
  updateViewport(() => ({ followNow: true }))
}

var rulerSignature = ''
var rulerGridSignature = ''
var rulerFormatterCache = {}
// ── Phase C（§8.4）：时间控制——NOW 文字按钮 / 快捷范围 / 当前窗口 / 刷新状态 ──
document.querySelectorAll('[data-time-preset]').forEach(btn => {
  btn.addEventListener('click', () => {
    const preset = btn.dataset.timePreset
    if (preset === 'now') { updateViewport(() => ({ followNow: true })); }
    else if (preset === '24h') { updateViewport(() => ({ spanMinutes: 24 * 60, followNow: true })); }
    else if (preset === '7d') { updateViewport(() => ({ spanMinutes: 7 * 24 * 60, followNow: true })); }
    else if (preset === 'custom') {
      const vp = timelineViewport()
      const fmt = ms => new Date(ms).toLocaleString('sv').slice(0, 16).replace('T', ' ')
      void (async () => {
        const fromStr = await hostPrompt({ title: '自定义时间范围', label: '起始时间（YYYY-MM-DD HH:mm 或留空=当前-范围/2）：', value: fmt(vp.center - vp.span / 2), placeholder: 'YYYY-MM-DD HH:mm' })
        if (fromStr === null) return
        const toStr = await hostPrompt({ title: '自定义时间范围', label: '结束时间（同上格式，留空=现在）：', value: fmt(vp.center + vp.span / 2), placeholder: 'YYYY-MM-DD HH:mm' })
        if (toStr === null) return
        const from = fromStr.trim() ? Date.parse(fromStr.trim().replace(' ', 'T')) : NaN
        const to = toStr.trim() ? Date.parse(toStr.trim().replace(' ', 'T')) : Date.now()
        if (Number.isFinite(from) && Number.isFinite(to) && to > from) {
          updateViewport(() => ({ center: from + (to - from) / 2, spanMinutes: (to - from) / 60000, followNow: false }))
        } else showToast('时间范围无效：需要 起始 < 结束。', 'err')
      })()
    }
  })
})

function spanLabel(ms) {
  if (ms < 60_000) return Math.round(ms / 1000) + ' 秒'
  if (ms < 3_600_000) return Math.round(ms / 60_000) + ' 分钟'
  if (ms < 86_400_000) return (ms / 3_600_000).toFixed(ms < 10 * 3_600_000 ? 1 : 0) + ' 小时'
  return (ms / 86_400_000).toFixed(ms < 10 * 86_400_000 ? 1 : 0) + ' 天'
}

let timelineLastRefresh = { at: 0, ok: true, error: '' }
function noteTimelineRefresh() {
  timelineLastRefresh = { at: Date.now(), ok: !state.snapshotError, error: state.snapshotError ?? '' }
  updateTimelineRefreshLabel()
}
function updateTimelineRefreshLabel() {
  const btn = byId('refresh-timeline'); if (!btn) return
  const time = timelineLastRefresh.at ? new Date(timelineLastRefresh.at).toLocaleTimeString('zh-CN', { hour12: false }) : ''
  btn.title = timelineLastRefresh.ok
    ? `刷新时间线投影（F5）· 最近刷新 ${time || '—'}`
    : `刷新失败：${timelineLastRefresh.error}（${time}）——点击重试`
}

function renderArrangementScale() {
  const vp=timelineViewport(),from=Date.parse(vp.from)
  setText(byId('arrange-range-start'),dateText(vp.from));setText(byId('arrange-range-end'),dateText(vp.to))
  setText(byId('arrange-range-meta'),Math.round(vp.span/1000)+' SEC · '+(vp.followNow?'FOLLOW':'PINNED'))
  // §8.4：拖动范围后在标尺区显示"当前窗口"摘要；旋钮旁显示人话范围（14 小时）
  setText(byId('timeline-window-label'),(vp.followNow?'跟随现在':'当前窗口：')+spanLabel(vp.span))
  const ticks=document.querySelector('#arrangement-ruler > div');if(!ticks)return
  const steps=[1000,5000,10000,30000,60000,120000,300000,600000,1800000,3600000,7200000,21600000,43200000,86400000,172800000,604800000]
  const step=steps.find(x=>x/vp.span*canvas.viewWidthPx>=85)||steps.at(-1)
  // 刻度只在 几何/时区 变化时重建；静止重绘（定时刷新等）零重建
  const signature=`${from}|${vp.span}|${canvas.viewWidthPx}|${safeTimezone()||''}`
  if(signature!==rulerSignature){
    rulerSignature=signature
    const tz=safeTimezone()||'',formatKey=tz+':'+(step<60000)
    const format=rulerFormatterCache[formatKey]||(rulerFormatterCache[formatKey]=new Intl.DateTimeFormat('zh-CN',{timeZone:tz||undefined,month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',second:step<60000?'2-digit':undefined,hour12:false}))
    const parts=[]
    for(let t=Math.ceil(from/step)*step;t<=from+vp.span;t+=step) parts.push('<span style="left:'+((t-from)/vp.span*canvas.viewWidthPx)+'px">'+escapeHtml(format.format(t))+'</span>')
    ticks.innerHTML=parts.join('')
  }
  setStyle(ticks,'width','100%');setStyle(ticks,'marginLeft','0')
  const spacing=step/vp.span*canvas.viewWidthPx,offset=(Math.ceil(from/step)*step-from)/vp.span*canvas.viewWidthPx
  // 背景格线重写前按 0.5px 精度比较，避免每帧重设 background 触发整道重绘
  const gridSignature=`${Math.round(spacing*2)}|${Math.round(offset*2)}`
  if(gridSignature!==rulerGridSignature){
    rulerGridSignature=gridSignature
    for(const lane of document.querySelectorAll('.track-lane')){lane.style.backgroundImage='linear-gradient(90deg,var(--kiy-line, #494949) 1px,transparent 1px)';lane.style.backgroundSize=spacing+'px 100%';lane.style.backgroundPosition=offset+'px 0'}
  }
}

function renderTrackMenu(counts = {}) {
  const tracks = layoutFor().tracks
  const labels = { script: 'script', receive: 'receive', send: 'send', alter: 'alter', state: 'state', preplan: 'preplan', media: 'media', compaction: 'compaction' }
  Object.entries(labels).forEach(([key, domKey]) => {
    const button = document.querySelector(`[data-track-toggle="${key}"]`)
    if (!button) return
    button.setAttribute('aria-pressed', String(Boolean(tracks[key])))
    const count = byId(`track-count-${domKey}`); if (count) count.textContent = String(counts[key] || 0)
  })
  byId('track-menu-count').textContent = `${activeTrackCount()} / ${Object.keys(defaultTracks).length}`
}

function itemSelection(type, entry) {
  const storyId = state.storyId
  if (type === 'script') return { type, storyId, entityId: entry.entries?.[0]?.entityId || entry.entries?.[0]?.id || null }
  if (type === 'fact') return { type, storyId, entityId: entry.fact?.id || entry.fact?.entityId || null }
  if (type === 'scene') return { type, storyId, entityId: entry.scene?.id || entry.scene?.entityId || null }
  if (type === 'preplan') return { type, storyId, entityId: `preplan:${entry.preplan?.revision ?? 'current'}` }
  return { type: 'entry', storyId, entityId: entry.entityId || entry.id || null }
}

function inspect(value) {
  state.inspected = value
  state.selection = itemSelection(value.type, value.entry)
  persist()
  if (!effectivePanels().inspector) choosePanel('inspector', true)
  if (innerWidth <= 1120) byId('inspector-panel').classList.add('panel-open')
  renderInspector()
  for(const el of document.querySelectorAll('.clip')) el.classList.toggle('selected',el.dataset.entityId===String(state.selection?.entityId))
}

function restoreSelection(snapshot) {
  const selection = state.selection
  if (!selection?.entityId) { state.inspected = null; state.selectedScript = null; return }
  if (selection.storyId !== state.storyId) { state.inspected = null; state.selectedScript = null; state.selection = null; persist(); return }
  const entries = snapshot.entries || []
  let found
  if (selection.type === 'script') {
    const entry = entries.find(item => (item.entityId || item.id) === selection.entityId)
    if (entry) {
      const block = buildScriptBlocks(entries).find(item => item.entries.some(script => (script.entityId || script.id) === selection.entityId))
      if (block) { state.selectedScript = block; state.inspected = { type: 'script', entry: block }; return }
    }
  } else if (selection.type === 'entry') {
    found = entries.find(item => (item.entityId || item.id) === selection.entityId)
    if (found) { state.inspected = { type: 'entry', entry: found }; return }
  } else if (selection.type === 'fact') {
    found = (snapshot.facts || []).find(item => (item.entityId || item.id) === selection.entityId)
    if (found) { state.inspected = { type: 'fact', entry: { fact: found, kind: found.scope, content: found.content } }; return }
  } else if (selection.type === 'scene') {
    found = (snapshot.scenes || []).find(item => (item.entityId || item.id) === selection.entityId)
    if (found) { state.inspected = { type: 'scene', entry: { scene: found, kind: found.status, content: found.hook || found.summary } }; return }
  } else if (selection.type === 'preplan' && snapshot.preplan) {
    state.inspected = { type: 'preplan', entry: { preplan: snapshot.preplan, kind: `preplan r${snapshot.preplan.revision}`, content: `${snapshot.preplan.validFrom} → ${snapshot.preplan.validThrough}` } }; return
  }
  // A selected original remains readable outside the current viewport.
}

function entryTrack(entry) {
  if (entry.track === 'script') return 'narrative'
  if (entry.track === 'system') return /alter|emotion|offset/i.test(entry.kind) ? 'alter' : 'events'
  if (/^(user-message|message-perceived|group-member)/i.test(entry.kind)) return 'receive'
  if (/^(character-message|character-group-message|character-platform-action|outgoing)/i.test(entry.kind)) return 'send'
  if (/user|message|reply|group/i.test(entry.kind)) return 'receive'
  if (/script|narrative|advance|follow/i.test(entry.kind)) return 'narrative'
  return 'events'
}

/** Media-track classifier: entries carrying image/audio counts land on the media track. */
function isMediaEntry(entry) {
  return (typeof entry.imageCount === 'number' && entry.imageCount > 0) || (typeof entry.audioCount === 'number' && entry.audioCount > 0)
}

/** Render media badge: image/audio icons with count. */
function mediaBadgeHtml(entry) {
  let html = ''
  if (entry.imageCount > 0) html += `<span class="media-badge media-img">IMG${entry.imageCount > 1 ? String(entry.imageCount) : ''}</span>`
  if (entry.audioCount > 0) html += `<span class="media-badge media-aud">AUDIO${entry.audioCount > 1 ? String(entry.audioCount) : ''}</span>`
  return html || escapeHtml(compact(entry.content || entry.kind, 22))
}

/** Alter colour: direction→hue, |value|→opacity (fades with decay weight). */
function alterClipStyle(entry) {
  const val = typeof entry.alterValue === 'number' ? entry.alterValue : (typeof entry.alter === 'number' ? entry.alter : null)
  if (val === null) return ''
  const intensity = Math.min(Math.abs(val) / 20, 1) // ±20 = full opacity
  const opacity = 0.15 + intensity * 0.85
  const hue = val > 0 ? 220 : val < 0 ? 340 : 0    // positive=serious(blue), negative=relaxed(pink)
  return `background:hsla(${hue},60%,55%,${opacity.toFixed(2)});border-color:hsla(${hue},60%,45%,${Math.min(opacity + 0.2, 1).toFixed(2)})`
}

function toMillis(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const n = Number(value)
    if (Number.isFinite(n) && n > 1e12) return n // 数字字符串时间戳
    const time = Date.parse(value)
    if (Number.isFinite(time)) return time
  }
  return undefined
}
function bounded(value, min, max) { return Math.max(min, Math.min(max, value)) }

/** UI-07: viewRange 唯一控制绘制——bounds 始终从当前 viewport 取。
 * snapshot.range 只说明已加载的数据范围，不参与绘制坐标。 */
function timelineBounds(snapshot) { const vp=timelineViewport();return {start:Date.parse(vp.from),end:Date.parse(vp.to),now:Date.now()} }


function buildScriptBlocks(entries) {
  const scripts = entries.filter(entry => entryTrack(entry) === 'narrative').slice().sort((a, b) => (toMillis(a.occurredAt) || 0) - (toMillis(b.occurredAt) || 0))
  const blocks = scripts.map(entry => ({
    start: toMillis(entry.startedAt) ?? toMillis(entry.occurredAt) ?? Date.now(), end: toMillis(entry.endedAt),
    entries: [entry], content: entry.content || '', exactRange: Boolean(toMillis(entry.endedAt)),
    // Protocol 4 annotations (may be absent on legacy entries).
    ...(entry.commitId ? { commitId: entry.commitId } : {}),
    ...(Array.isArray(entry.deliveryActions) && entry.deliveryActions.length ? { deliveryActions: entry.deliveryActions } : {}),
    ...(entry.sceneCheckpoint ? { sceneCheckpoint: entry.sceneCheckpoint } : {}),
  }))
  // 补 end：无显式 endedAt 的块，用下一个块的 start 作为结束（最后一个用 NOW）
  // —— 剧本从写入到下一次推进之间，就是它覆盖的生活时段。
  // 先按 start 排序：连写段的 occurredAt 与覆盖起点可能交错。
  blocks.sort((a, b) => a.start - b.start)
  for (let i = 0; i < blocks.length; i++) {
    if (blocks[i].end == null) {
      blocks[i].end = i + 1 < blocks.length ? blocks[i + 1].start : Date.now()
      blocks[i].inferredEnd = true
    }
  }
  // 呈现层顺序化（HDSI 语义：剧本是时间上一条连续的条，不分行）：
  // 相邻两段确认区间在数据上可能交错（连写时模型各自确认），展示时把前段截到后段 start。
  // 只影响时间轴几何，详情/数据仍显示原始区间。
  for (let i = 0; i + 1 < blocks.length; i++) {
    if (blocks[i].end > blocks[i + 1].start) blocks[i].end = blocks[i + 1].start
  }
  // 丢弃退化段（零/负时长：同起点连写或坏数据）——这类 1ms 窄条会掉到第二行并闪烁；
  // 内容不丢，仍可在 Events 列表 / 详情中阅读。
  for (let i = blocks.length - 1; i >= 0; i--) if (!(blocks[i].end > blocks[i].start)) blocks.splice(i, 1)
  return blocks
}

/** 投递现实角标：只有非全部成功的行动才提示，避免正常投递刷屏。 */
function deliveryBadge(actions) {
  if (!Array.isArray(actions)) return ''
  const bad = actions.filter(action => action.status !== 'delivered')
  if (!bad.length) return ''
  const failed = bad.reduce((sum, action) => sum + (action.segments ?? []).filter(segment => segment.status === 'failed' || segment.status === 'cancelled').length, 0)
  const pending = bad.reduce((sum, action) => sum + (action.segments ?? []).filter(segment => segment.status === 'pending').length, 0)
  const parts = []
  if (failed) parts.push(failed + ' 未送达')
  if (pending) parts.push(pending + ' 待确认')
  return '<span class="clip-chip delivery-badge">' + parts.join(' · ') + '</span>'
}

function clip(track, entry, bounds, options = {}) {
  const button = document.createElement('button'); button.className = `clip ${track}${options.primary ? ' primary-clip' : ''}`
  const start = toMillis(entry.startAt) ?? entry.start ?? toMillis(entry.occurredAt) ?? bounds.now
  const end = toMillis(entry.endAt) ?? entry.end ?? start + (options.tick ? 45_000 : 1)
  // UI-21: 先判断区间与视窗相交，完全窗外的直接返回（不制造边缘假块）
  const bStart = bounds.start; const bEnd = bounds.end
  // Loaded nodes remain available for viewport painting.
  // 画布坐标：绝对像素定位（不随视窗变化，滚动=改 scrollLeft）
  const leftPx = Math.max(timeToPx(start), 0)
  const rightPx = timeToPx(end)
  const widthPx = Math.max(rightPx - leftPx, options.tick ? 2 : options.primary ? 6 : 3)
  const width = widthPx  // 供预览字数计算
  // UI-22: 子行避让——同轨重叠事件交替上下偏移（非 script 主轨）
  const subRow = options.primary ? 0 : (entry.__subRow ?? 0)
  button.style.left = `${leftPx}px`; button.style.width = `${widthPx}px`
  button.dataset.startMs = String(start); button.dataset.endMs = String(end); button._scriptContent = entry.content || entry.kind || ''
  if (subRow) button.style.top = `${16 + subRow * 14}px`
  button.title = `${entry.kind} · ${compact(entry.content, 140)}`
  // UI-18: 预览字数按 clip 宽度自适应（宽块多字，窄块少字）
  const previewChars = options.primary ? Math.max(20, Math.min(200, Math.floor(width * 3))) : 22
  // UI-19: 推断 end 的块加 inferred 类（虚线右缘 + 淡尾效果）
  if (entry.inferredEnd) button.classList.add('inferred')
  // UI-25: 恢复投递角标（之前定义了但没接入）
  const badge = options.primary && Array.isArray(entry.deliveryActions) ? deliveryBadge(entry.deliveryActions) : ''
  // Media clips: show icon + count for image/audio attachments
  const mediaBadge = isMediaEntry(entry) ? mediaBadgeHtml(entry) : ''
  // Alter track: colour by direction (serious=blue / relaxed=pink), opacity by |value| (decay)
  const alterStyle = track === 'alter' ? alterClipStyle(entry) : ''
  if (alterStyle) button.setAttribute('style', `${button.getAttribute('style') || ''};${alterStyle}`)
  // §8.3 来源端点徽标：metadata.channel 由主仓 M1a 写入（channelKind qq/wechat）
  const channelMeta = entry.metadata?.channel ?? entry.metadata
  const endpointKind = channelMeta && typeof channelMeta === 'object' ? String(channelMeta.channelKind ?? '') : ''
  const endpointBadge = (track === 'messages' && endpointKind) ? `<span class="endpoint-badge ${endpointKind === 'wechat' ? 'wechat' : 'qq'}" title="来源端点：${endpointKind === 'wechat' ? '微信' : 'QQ'} ${escapeHtml(String(channelMeta.selfId ?? ''))}">${endpointKind === 'wechat' ? '微' : 'Q'}</span>` : ''
  button.innerHTML = options.primary
    ? `<b>${escapeHtml(compact(entry.content || entry.kind, previewChars))}</b>${badge}${endpointBadge}<small>${dateText(start)}${entry.inferredEnd ? ' → 推断' : ''}</small>`
    : mediaBadge || escapeHtml(compact(entry.content || entry.kind, 22)) + endpointBadge
  const type = entry.entries ? 'script' : entry.fact ? 'fact' : entry.scene ? 'scene' : entry.preplan ? 'preplan' : 'entry'
  // 增量重绘时元素可能被保留复用：处理器一律读 __entry（最新数据），不闭包旧快照
  button.__entry = entry
  button.addEventListener('click', () => { const e = button.__entry; if (type === 'script') { state.selectedScript = e; setDetail('script') }; inspect({ type, entry: e }) })
  // UI-24: 按 entityId 比较选中（对象引用不稳定）
  const selEntityId = state.selection?.entityId
  const entryEntityId = entry.entityId || entry.id || (entry.entries?.[0]?.entityId || entry.entries?.[0]?.id)
  button.dataset.entityId=String(entryEntityId)
  if (selEntityId && entryEntityId && String(selEntityId) === String(entryEntityId)) button.classList.add('selected')
  bindContextMenu(button, () => {
    const e = button.__entry
    const items = [
      { label: '检查内容', action: () => inspect({ type, entry: e }) },
    ]
    if (type === 'script') items.push({ label: '⤴ 从此分支续写', action: () => openForkDialog(selectedStory(), e) })
    items.push({ separator: true })
    items.push({ label: '复制文本', action: () => { void navigator.clipboard.writeText(e.content || '') } })
    return items
  })
  return button
}

// UI-22: 同轨事件按时间排序后分配子行（重叠的交替偏移）；增量重绘与全量重建共用
function assignSubRows(entries) {
  const sorted = entries.slice().sort((a, b) => (toMillis(a.startAt) ?? 0) - (toMillis(b.startAt) ?? 0))
  let lastEnd = 0; let row = 0
  for (const entry of sorted) {
    const start = toMillis(entry.startAt) ?? toMillis(entry.occurredAt) ?? 0
    if (start < lastEnd) row = (row + 1) % 3  // 最多 3 层子行
    else row = 0
    entry.__subRow = row
    lastEnd = Math.max(lastEnd, start + 30_000)  // 假设最少 30s 占用
  }
}

// §8.2 轨道视觉：辅助图标 + 名称 + 数量（颜色只作辅助，语义靠图标与文字）
const TRACK_ICONS = { SCRIPT: '✎', RECEIVE: '↓', SEND: '↑', 'MEDIA FILES': '▣', ALTER: '∿', 'FACTS & SCENES': '◇', PREPLAN: '▤', COMPACTION: '⧉', SCENES: '◇', FACTS: '◆', 'SCHEDULE / FUTURE': '▤' }

function hudChannelLabel(entry) {
  const channel = entry?.metadata?.channel ?? entry?.metadata
  if (!channel || typeof channel !== 'object') return ''
  const kind = String(channel.channelKind || '').toLowerCase()
  const name = kind === 'wechat' ? '微信' : kind === 'qq' ? 'QQ' : kind
  const conversation = channel.conversationKind === 'group' ? '群' : channel.conversationKind === 'private' ? '私' : ''
  return [name, conversation].filter(Boolean).join(' · ')
}
function hudTime(value) {
  const ms = toMillis(value)
  return Number.isFinite(ms) ? new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: safeTimezone() }).format(new Date(ms)) : '--:--'
}
function hudDateTime(value) {
  const ms = toMillis(value)
  return Number.isFinite(ms) ? new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: safeTimezone() }).format(new Date(ms)) : '—'
}
const HUD_DELIVERY_LABELS = Object.freeze({ generated: '待发送', sending: '发送中', sent: '已受理', confirmed: '已确认', accepted: '已受理', unknown: '结果未知', 'retryable-failed': '可重试失败', 'permanent-failed': '不可重试失败' })
function hudDeliveryStateLabel(value) { return HUD_DELIVERY_LABELS[String(value || '')] || String(value || '状态未知') }

function renderStoryHud(target, snapshot) {
  if (!target) return
  const story = selectedStory()
  const focused = target.contains(document.activeElement) ? document.activeElement : null
  const focusKey = focused?.dataset.hudKey, focusAction = focused?.dataset.hudAction
  const scrollTop = target.scrollTop
  if (!story) { target.innerHTML = '<div class="studio-hud-empty">从左侧 Browser 选择一个故事以查看总览。</div>'; return }

  const entries = (snapshot?.entries || []).slice().sort((a, b) => (toMillis(b.occurredAt) || 0) - (toMillis(a.occurredAt) || 0))
  const narrativeEntries = entries.filter(entry => entry.track === 'script' || entry.kind === 'script' || entry.actor === 'narrator')
  const scenes = (snapshot?.scenes || []).slice().sort((a, b) => (toMillis(a.startedAt) || 0) - (toMillis(b.startedAt) || 0))
  const activeScene = scenes.filter(scene => scene.status === 'active').at(-1)
  const currentScene = activeScene || scenes.at(-1)
  const facts = (snapshot?.facts || []).slice().sort((a, b) => (toMillis(b.updatedAt) || 0) - (toMillis(a.updatedAt) || 0)).slice(0, 4)
  const receiveCount = entries.filter(entry => entryTrack(entry) === 'receive').length
  const sendCount = entries.filter(entry => entryTrack(entry) === 'send').length
  const outboxReady = !!state.hostOverview?.outbox?.states
  const states = state.hostOverview?.outbox?.states || {}
  const confirmedCount = (states.confirmed || 0) + (states.accepted || 0) + (states.sent || 0)
  const pendingCount = (states.generated || 0) + (states.sending || 0)
  const failedCount = (states['retryable-failed'] || 0) + (states['permanent-failed'] || 0)
  const unknownCount = states.unknown || 0
  const preplan = snapshot?.preplan
  const validFrom = toMillis(preplan?.validFrom)
  const validThrough = toMillis(preplan?.validThrough)
  const preplanLabel = preplan
    ? [validFrom ? `${hudDateTime(preplan.validFrom)} 起` : '', validThrough ? `至 ${hudDateTime(preplan.validThrough)}` : ''].filter(Boolean).join(' · ') || '已生成预计划'
    : '暂无预计划'
  const windowFrom = snapshot?.range?.from
  const windowTo = snapshot?.range?.to
  const windowLabel = windowFrom && windowTo ? `${hudDateTime(windowFrom)} — ${hudDateTime(windowTo)}` : '当前时间窗'
  const activityItems = [
    ...(state.deliveryHistory || []).map(item => ({
      time: item.updatedAt || item.createdAt,
      icon: ['unknown', 'retryable-failed', 'permanent-failed'].includes(item.state) ? '!' : '↗',
      title: `投递 · ${hudDeliveryStateLabel(item.state)}`,
      detail: item.lastError || [item.platform, item.selfId, item.kind === 'group' ? '群聊' : item.kind === 'private' ? '私聊' : ''].filter(Boolean).join(' · ') || item.deliveryId,
      source: 'OUTBOX',
      tone: ['unknown', 'retryable-failed', 'permanent-failed'].includes(item.state) ? 'warning' : 'normal',
    })),
    ...((state.hostOverview?.recentErrors || []).map(item => ({
      time: item.at,
      icon: '!',
      title: `宿主错误 · ${item.source || 'runtime'}`,
      detail: item.message || '错误记录',
      source: 'HOST LOG',
      tone: 'warning',
    }))),
  ].filter(item => Number.isFinite(toMillis(item.time)))
    .sort((a, b) => (toMillis(b.time) || 0) - (toMillis(a.time) || 0))
    .slice(0, 4)

  target.innerHTML = `
    <div class="studio-hud-signals" aria-label="故事运行摘要">
      <article class="studio-hud-signal indigo"><small>叙事记录 <em>${escapeHtml(windowLabel)}</em></small><strong>${snapshot ? `${narrativeEntries.length} 个剧本条目` : '时间线尚未可读'}</strong><span>${snapshot ? `${entries.length} 条时间线记录 · ${receiveCount} 入站 · ${sendCount} 出站` : '等待 HDSI 时间线投影'}</span></article>
      <article class="studio-hud-signal moss"><small>场景与连续性 <em>${scenes.length} SCENES</em></small><strong>${currentScene ? (activeScene ? '有进行中场景' : '最近场景已闭合') : '暂无场景记录'}</strong><span>${(snapshot?.facts || []).length} 条投影事实 · 时区 ${escapeHtml(snapshot?.timezone || '未提供')}</span></article>
      <article class="studio-hud-signal verm"><small>投递账本 <em>${unknownCount ? `${unknownCount} UNKNOWN` : failedCount ? `${failedCount} FAILED` : 'HOST OUTBOX'}</em></small><strong>${outboxReady ? `${confirmedCount} 条已受理 / 确认` : '账本尚未可读'}</strong><span>${outboxReady ? `${pendingCount} 待处理 · ${unknownCount} 结果未知 · ${failedCount} 失败` : '等待宿主 Outbox 投影'}</span></article>
    </div>
    <div class="studio-hud-context">
      <section class="studio-hud-card scene-feature"><h3>当前场景 <span>${activeScene ? 'ACTIVE' : currentScene ? 'LATEST' : 'NO SCENE'}</span></h3><div class="studio-hud-list" data-hud-scene></div></section>
      <section class="studio-hud-card"><h3>最近叙事条目 <span>${narrativeEntries.length} ENTRIES</span></h3><div class="studio-hud-list" data-hud-recent></div><button class="hud-card-link" type="button" data-hud-action="timeline">查看完整时间线 →</button></section>
    </div>
    <div class="studio-hud-lower">
      <section class="studio-hud-card"><h3>持续性事实 <span>${(snapshot?.facts || []).length} ACTIVE FACTS</span></h3><div class="studio-hud-list" data-hud-facts></div><button class="hud-card-link" type="button" data-hud-action="facts">查看事实与场景 →</button></section>
      <section class="studio-hud-card"><h3>计划与宿主活动 <span>${preplan ? 'PREPLAN' : 'HOST LEDGER'}</span></h3><div class="hud-preplan"><i aria-hidden="true">▤</i><span><b>${escapeHtml(preplanLabel)}</b><small>${preplan ? `时区 ${escapeHtml(preplan.timezone || snapshot?.timezone || '—')} · ${Number(preplan.revision) || 0} 次修订` : '仅显示插件实际提供的预计划窗口'}</small></span></div><div class="studio-hud-list" data-hud-activity></div><div class="hud-card-actions"><button class="hud-card-link" type="button" data-hud-action="deliveries">投递记录 →</button><button class="hud-card-link" type="button" data-hud-action="logs">诊断日志 →</button></div></section>
    </div>`

  const recent = target.querySelector('[data-hud-recent]')
  const recentItems = narrativeEntries.slice(0, 4)
  if (recentItems.length) recentItems.forEach(entry => {
    const button = document.createElement('button'); button.className = 'studio-hud-item'; button.type = 'button'
    const channel = hudChannelLabel(entry)
    const title = entry.actor && entry.actor !== 'narrator' ? entry.actor : story.meta.characterName || '叙事'
    button.dataset.hudKey = `entry:${entry.entityId ?? entry.id ?? entry.occurredAt}`
    button.innerHTML = `<time>${hudTime(entry.occurredAt)}</time><i class="hud-item-dot narrative"></i><span class="hud-item-body"><b>${escapeHtml(title)}</b><strong>${escapeHtml(compact(entry.content || entry.kind || '剧本条目', 100))}</strong><small>${escapeHtml(channel || 'HDSI SCRIPT')} · ${escapeHtml(entry.participantId || 'narrative')}</small></span>`
    button.addEventListener('click', () => focusTimelineAt(toMillis(entry.occurredAt)))
    recent.appendChild(button)
  })
  else recent.innerHTML = '<div class="studio-hud-empty">此时间窗没有脚本条目；可在完整时间线中检查入站与系统记录。</div>'

  const sceneTarget = target.querySelector('[data-hud-scene]')
  if (currentScene) {
    const sceneButton = document.createElement('button'); sceneButton.className = 'studio-hud-item hud-scene'; sceneButton.type = 'button'
    sceneButton.dataset.hudKey = `scene:${currentScene.id}`
    const sceneStatus = currentScene.status === 'active' ? '进行中' : currentScene.status === 'closed' ? '已闭合' : currentScene.status || '状态未知'
    const sceneRange = `${dateText(currentScene.startedAt)}${currentScene.endedAt ? ` → ${dateText(currentScene.endedAt)}` : ' → 进行中'}`
    sceneButton.innerHTML = `<span class="hud-scene-copy"><small>SCENE ${escapeHtml(String(currentScene.id ?? '—').padStart(2, '0'))} · ${escapeHtml(sceneStatus)}</small><strong>${escapeHtml(compact(currentScene.hook || currentScene.summary || `场景 ${currentScene.id ?? ''}`, 110))}</strong><em>${escapeHtml(compact(currentScene.summary || '插件未提供场景摘要。', 150))}</em><i>${escapeHtml(sceneRange)} · ${Number(currentScene.entryCount) || 0} 条来源记录</i></span>`
    sceneButton.addEventListener('click', () => focusTimelineAt(toMillis(currentScene.startedAt)))
    sceneTarget.appendChild(sceneButton)
  } else sceneTarget.innerHTML = '<div class="studio-hud-empty">HDSI 尚未提供场景记录。</div>'

  const factsTarget = target.querySelector('[data-hud-facts]')
  if (facts.length) facts.forEach(fact => {
    const button = document.createElement('button'); button.className = 'studio-hud-item hud-fact'; button.type = 'button'
    const labels = [fact.scope, fact.unresolved ? '待解决' : '', Number.isFinite(Number(fact.confidence)) ? `置信 ${Math.round(Number(fact.confidence) * 100)}%` : ''].filter(Boolean)
    button.dataset.hudKey = `fact:${fact.id}`
    button.innerHTML = `<i class="hud-index">${escapeHtml(String(fact.id ?? '·'))}</i><span class="hud-item-body"><b>${escapeHtml(fact.scope || '连续性事实')}</b><strong>${escapeHtml(compact(fact.content || '—', 100))}</strong><small>${escapeHtml(labels.join(' · '))}</small></span><em>${Number.isFinite(Number(fact.importance)) ? `重要度 ${Math.round(Number(fact.importance) * 100)}%` : ''}</em>`
    button.addEventListener('click', () => focusTimelineAt(toMillis(fact.updatedAt)))
    factsTarget.appendChild(button)
  })
  else factsTarget.innerHTML = '<div class="studio-hud-empty">当前投影中没有活动事实。</div>'

  const activityTarget = target.querySelector('[data-hud-activity]')
  if (activityItems.length) activityItems.forEach(item => {
    const row = document.createElement('div'); row.className = `studio-hud-item hud-activity${item.tone === 'warning' ? ' warning' : ''}`
    row.innerHTML = `<i class="hud-activity-icon">${escapeHtml(item.icon)}</i><span class="hud-item-body"><b>${escapeHtml(compact(item.title, 44))}</b><strong>${escapeHtml(compact(item.detail || '记录中没有补充信息', 84))}</strong><small>${hudDateTime(item.time)} · ${escapeHtml(item.source)}</small></span>`
    activityTarget.appendChild(row)
  })
  else activityTarget.innerHTML = '<div class="studio-hud-empty">当前没有投递或错误活动记录。</div>'

  target.querySelector('[data-hud-action="timeline"]')?.addEventListener('click', () => void setStudioView('timeline'))
  target.querySelector('[data-hud-action="facts"]')?.addEventListener('click', () => void setStudioView('facts'))
  target.querySelector('[data-hud-action="deliveries"]')?.addEventListener('click', () => setDetail('deliveries'))
  target.querySelector('[data-hud-action="logs"]')?.addEventListener('click', () => setSurface('logs'))
  // Projection refreshes must not discard keyboard focus or move the reading position.
  const replacement = [...target.querySelectorAll('button')].find(button => focusKey ? button.dataset.hudKey === focusKey : focusAction && button.dataset.hudAction === focusAction)
  replacement?.focus({ preventScroll: true })
  target.scrollTop = scrollTop
}

function makeTrack(label, key, entries, bounds, options = {}) {
  if (!options.primary) assignSubRows(entries)
  const row = document.createElement('div'); row.className = `arrangement-track ${options.className || ''}`
  const icon = TRACK_ICONS[label] ?? '·'
  row.innerHTML = `<header><i class="track-led${entries.length ? ' on' : ''}" data-key="${key}"></i><b><span class="track-icon" aria-hidden="true">${icon}</span>${label}</b><small>${entries.length} 条${options.note ? ` · ${options.note}` : ''}</small></header><div class="track-lane"></div>`
  row.__trackEntries = entries
  row.__trackKey = key
  const lane = row.querySelector('.track-lane')
  lane.style.width = `${canvas.totalMs * canvas.pxPerMs}px`
  entries.forEach(entry => { const el = clip(key, entry, bounds, options); if (el.nodeType === 1) lane.appendChild(el) })
  // 右键菜单：轨道头（增量重绘会更新 __trackEntries，这里读实时值）
  const header = row.querySelector('header')
  if (header) {
    bindContextMenu(header, () => {
      const liveEntries = row.__trackEntries || []
      const items = [
        { label: `${label} 轨道`, disabled: true },
        { separator: true },
        { label: liveEntries.length ? `打开事件列表（${liveEntries.length} 项）` : '无内容', action: liveEntries.length ? () => { setDetail('events') } : undefined },
        { label: liveEntries.length ? `复制全部文本（${liveEntries.length} 项）` : '', action: liveEntries.length ? () => { void navigator.clipboard.writeText(liveEntries.map(e => e.content || '').join('\n\n')) } : undefined },
        { separator: true },
        { label: layoutFor().tracks[label2Key(label)] ? '隐藏此轨道' : '显示此轨道', disabled: label2Key(label) == null, action: () => { const layout = layoutFor(); const k = label2Key(label); if (k == null) return; layout.tracks[k] = !layout.tracks[k]; persist(); renderArrangement() } },
      ].filter(item => item.label !== '')
      return items
    })
  }
  // 右键菜单：轨道空白区域
  bindContextMenu(lane, () => {
    const items = [
      { label: '回到 NOW', action: () => returnToNow() },
      { label: '刷新时间线', action: () => void refreshSnapshot() },
      { label: '删除所选时间范围…', disabled: !state.timeSelection || state.timeSelection.storyId !== state.storyId || selectedStory()?.meta.phase !== 'paused', action: () => { const selection = state.timeSelection; if (selection?.storyId === state.storyId) void commitPurgeSelection(selection.from, selection.to) } },
      { separator: true },
      { label: '重置缩放（14h）', action: () => { updateViewport(() => ({ spanMinutes: 14 * 60, followNow: true })); updateKnobFromViewport() } },
    ]
    return items
  })
  return row
}

function label2Key(label) {
  const map = { 'SCRIPT': 'script', 'RECEIVE': 'receive', 'SEND': 'send', 'ALTER': 'alter', 'FACTS & SCENES': 'state', 'PREPLAN': 'preplan', 'MEDIA FILES': 'media', 'COMPACTION': 'compaction' }
  // 审查T15: 未知标签返回 null，调用方禁用隐藏项——回落 script 会误改不可见轨道的开关。
  return map[label] || null
}

let v7SignalId = ''
let lastRenderedV7Key = ''

function isV7Profile() {
  return window.HDSIWorkspaceProfile?.current() === 'v7'
}

function syncWorkspaceProfileView() {
  const active = isV7Profile() && state.surface === 'studio'
  document.body.classList.toggle('v7-profile-active', active)
  const v7 = byId('v7-workbench-surface')
  const studio = byId('studio-surface')
  if (v7) v7.toggleAttribute('hidden', !active)
  if (studio && active) studio.setAttribute('aria-hidden', 'true')
  else if (studio) studio.removeAttribute('aria-hidden')
}

function v7EntryId(entry, index = 0) {
  return String(entry?.entityId ?? entry?.id ?? `${entry?.occurredAt ?? 'event'}-${index}`)
}

function v7EntryTime(entry) {
  return toMillis(entry?.occurredAt) ?? toMillis(entry?.startedAt) ?? toMillis(entry?.createdAt)
}

function v7TrackLabel(entry) {
  const track = entryTrack(entry)
  return ({ receive: 'RECEIVE', send: 'SEND', narrative: 'SCRIPT', alter: 'ALTER', events: 'EVENT' })[track] || 'EVENT'
}

function v7Time(value) {
  const ms = toMillis(value)
  if (!ms) return '—'
  return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: safeTimezone() }).format(new Date(ms))
}

function v7RunState(story, entries) {
  if (!story?.running) return { id: 'idle', label: 'OFFLINE', detail: 'Worker 未加载' }
  if (story.meta.phase === 'paused') return { id: 'waiting', label: 'PAUSED', detail: '自动推进已暂停' }
  const latest = entries[entries.length - 1]
  const track = latest ? entryTrack(latest) : null
  if (track === 'receive') return { id: 'waiting', label: 'WAITING', detail: '等待剧本推进' }
  if (track === 'narrative') return { id: 'responding', label: 'RESPONDING', detail: '正在生成叙事' }
  if (track === 'send') return { id: 'settled', label: 'SETTLED', detail: '最近一次发送已完成' }
  return { id: 'idle', label: 'IDLE', detail: story.bridgeReady ? 'Worker 已就绪' : 'Worker 启动中' }
}

function v7Trend(entries) {
  const valid = entries.map((entry, index) => ({ entry, index, time: v7EntryTime(entry) })).filter(item => Number.isFinite(item.time))
  const latest = Math.max(Date.now(), valid.length ? valid[valid.length - 1].time : 0)
  const earliestData = valid.length ? Math.min(...valid.map(item => item.time)) : latest - 12 * 3600_000
  const span = Math.max(6 * 3600_000, latest - earliestData)
  const start = latest - span
  const bucketCount = 12
  const buckets = Array.from({ length: bucketCount }, (_, i) => ({ receive: 0, send: 0, total: 0, entries: [], at: start + ((i + .5) / bucketCount) * span }))
  for (const item of valid) {
    const index = Math.max(0, Math.min(bucketCount - 1, Math.floor(((item.time - start) / span) * bucketCount)))
    const track = entryTrack(item.entry)
    buckets[index].total++
    buckets[index].entries.push(item.entry)
    if (track === 'receive') buckets[index].receive++
    if (track === 'send') buckets[index].send++
  }
  const width = 720, height = 210, pad = { top: 18, right: 18, bottom: 30, left: 28 }
  const innerW = width - pad.left - pad.right, innerH = height - pad.top - pad.bottom
  const max = Math.max(1, ...buckets.map(item => Math.max(item.receive, item.send, item.total)))
  const x = index => pad.left + index * (innerW / (bucketCount - 1))
  const y = value => pad.top + innerH - (value / max) * innerH
  const path = key => buckets.map((bucket, index) => `${index ? 'L' : 'M'} ${x(index).toFixed(1)} ${y(bucket[key]).toFixed(1)}`).join(' ')
  const grid = [0, .5, 1].map(ratio => `<line x1="${pad.left}" y1="${y(max * ratio).toFixed(1)}" x2="${width - pad.right}" y2="${y(max * ratio).toFixed(1)}" />`).join('')
  const points = key => buckets.map((bucket, index) => `<circle class="v7-trend-point ${key}" data-v7-trend-index="${index}" cx="${x(index).toFixed(1)}" cy="${y(bucket[key]).toFixed(1)}" r="3.5"><title>${v7Time(bucket.at)} · ${key === 'receive' ? 'Receive' : 'Send'} ${bucket[key]}</title></circle>`).join('')
  const labels = buckets.map((bucket, index) => index % 2 === 0 ? `<text x="${x(index).toFixed(1)}" y="${height - 8}" text-anchor="middle">${v7Time(bucket.at).slice(0, 5)}</text>` : '').join('')
  const svg = `<svg class="v7-trend-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Receive 与 Send 活动趋势"><g class="v7-trend-grid">${grid}</g><path class="receive" d="${path('receive')}"/><path class="send" d="${path('send')}"/>${points('receive')}${points('send')}<g class="v7-trend-labels">${labels}</g></svg>`
  return { svg, buckets, max, span, total: valid.length }
}

function v7StateGraph(runState) {
  const nodes = [
    ['idle', 'IDLE', '无待处理事件'],
    ['waiting', 'WAITING', '等待输入或路由'],
    ['responding', 'RESPONDING', '叙事生成中'],
    ['settled', 'SETTLED', '最近动作已完成'],
  ]
  const order = ['idle', 'waiting', 'responding', 'settled']
  const currentIndex = Math.max(0, order.indexOf(runState.id))
  return `<div class="v7-state-graph" role="list" aria-label="运行状态机">${nodes.map(([id, label, detail], index) => `<div class="v7-state-step ${id === runState.id ? 'current' : ''} ${index < currentIndex ? 'visited' : ''}" role="listitem"><span class="v7-state-node">${index + 1}</span><div><b>${label}</b><small>${detail}</small></div></div>${index < nodes.length - 1 ? '<i class="v7-state-link" aria-hidden="true">→</i>' : ''}`).join('')}</div>`
}

function renderV7Workbench(target, snapshot) {
  if (!target) return
  const story = selectedStory()
  const entries = (snapshot?.entries || []).slice().sort((a, b) => (v7EntryTime(a) || 0) - (v7EntryTime(b) || 0))
  // Snapshot revisions do not necessarily change when the host lifecycle changes.
  // Include the live story/host state so V7 does not keep stale chips and facts.
  const v7Phase = story?.meta?.phase || ''
  const lifecycle = `${story?.running ? 'running' : 'stopped'}:${story?.bridgeReady ? 'ready' : 'booting'}`
  const channelState = state.hostOverview?.channel?.state || state.hostOverview?.worker?.channelState || ''
  const modelState = state.hostOverview?.model?.state || state.hostOverview?.worker?.modelState || ''
  const key = `${state.storyId}:${snapshot?.revision || snapshot?.updatedAt || 'none'}:${entries.length}:${v7SignalId}:${state.hostOverview?.updatedAt || ''}:${v7Phase}:${lifecycle}:${channelState}:${modelState}`
  if (key === lastRenderedV7Key && target.children.length) return
  lastRenderedV7Key = key
  if (!story) {
    target.innerHTML = `<div class="v7-empty"><span class="v7-kicker">DATA STATE SURFACE / V7</span><h1>选择一个故事</h1><p>V7 不显示传统时间轴。选择故事后，这里会以趋势、状态机和事件数据表呈现运行状态。</p><button type="button" data-v7-action="new">＋ 新建故事</button></div>`
    target.querySelector('[data-v7-action="new"]')?.addEventListener('click', () => byId('new-story')?.click())
    return
  }
  const runState = v7RunState(story, entries)
  const trend = v7Trend(entries)
  const receive = entries.filter(entry => entryTrack(entry) === 'receive').length
  const send = entries.filter(entry => entryTrack(entry) === 'send').length
  const script = entries.filter(entry => entryTrack(entry) === 'narrative').length
  const scenes = snapshot?.scenes?.length || 0
  const facts = snapshot?.facts?.length || 0
  const recent = entries.slice(-14).reverse()
  const selected = recent.find((entry, index) => v7EntryId(entry, entries.length - 1 - index) === v7SignalId) || entries.find((entry, index) => v7EntryId(entry, index) === v7SignalId) || entries[entries.length - 1]
  if (selected) v7SignalId = v7EntryId(selected, entries.indexOf(selected))
  const selectedTrack = selected ? v7TrackLabel(selected) : '—'
  const selectedSummary = selected ? compact(selected.content || selected.summary || selected.kind || '无正文摘要', 260) : '尚无可选事件。'
  const phase = phases[story.meta.phase] || story.meta.phase || '未知'
  const worker = story.running ? (story.bridgeReady ? 'READY' : 'BOOTING') : 'OFFLINE'
  const channel = state.hostOverview?.channel?.state || state.hostOverview?.worker?.channelState || '—'
  const model = state.hostOverview?.model?.state || state.hostOverview?.worker?.modelState || '—'
  target.innerHTML = `<div class="v7-frame">
    <header class="v7-command"><div class="v7-command-title"><span class="v7-kicker">DATA STATE SURFACE / V7</span><h1>${escapeHtml(story.meta.name)}</h1><p>${escapeHtml(story.meta.characterName || '未命名角色')} · ${escapeHtml(story.meta.id)}</p></div><div class="v7-command-state"><span class="v7-state-chip ${runState.id}"><i></i>${runState.label}</span><small>${escapeHtml(runState.detail)}</small></div><div class="v7-command-actions"><button type="button" data-v7-action="refresh" title="刷新快照">↻</button><button type="button" data-v7-action="new" title="新建故事">＋</button><button type="button" data-v7-action="theme" title="切换主题">◐</button></div></header>
    <div class="v7-metrics" aria-label="故事指标"><div><b>${entries.length}</b><span>EVENTS</span></div><div><b>${receive}</b><span>RECEIVE</span></div><div><b>${send}</b><span>SEND</span></div><div><b>${script}</b><span>SCRIPT</span></div><div><b>${scenes}</b><span>SCENES</span></div><div><b>${facts}</b><span>FACTS</span></div></div>
    <div class="v7-grid">
      <section class="v7-panel v7-trend-panel"><header><div><span class="v7-kicker">01 / ACTIVITY</span><h2>Activity trend</h2></div><div class="v7-legend"><span class="receive">Receive</span><span class="send">Send</span></div></header><div class="v7-chart-wrap">${trend.svg}</div><footer><span>${trend.total ? `${trend.total} events in ${Math.max(1, Math.round(trend.span / 3600000))}h window` : 'No activity in current snapshot'}</span><span>LIVE WINDOW</span></footer></section>
      <section class="v7-panel v7-state-panel"><header><div><span class="v7-kicker">02 / STATE MACHINE</span><h2>Runtime path</h2></div><span class="v7-phase">${escapeHtml(String(phase).toUpperCase())}</span></header>${v7StateGraph(runState)}<dl class="v7-runtime-facts"><div><dt>WORKER</dt><dd>${escapeHtml(worker)}</dd></div><div><dt>CHANNEL</dt><dd>${escapeHtml(String(channel))}</dd></div><div><dt>MODEL</dt><dd>${escapeHtml(String(model))}</dd></div></dl></section>
      <section class="v7-panel v7-events-panel"><header><div><span class="v7-kicker">03 / EVENT STREAM</span><h2>Recent events</h2></div><span class="v7-count">${recent.length} / ${entries.length}</span></header><div class="v7-event-table" role="table" aria-label="最近事件"><div class="v7-event-head" role="row"><span>TIME</span><span>TYPE</span><span>SOURCE</span><span>SUMMARY</span></div>${recent.length ? recent.map((entry, index) => `<button type="button" class="v7-event-row ${selected && v7EntryId(entry, entries.indexOf(entry)) === v7SignalId ? 'selected' : ''}" data-v7-entry="${escapeHtml(v7EntryId(entry, entries.indexOf(entry)))}" role="row"><time>${v7Time(v7EntryTime(entry))}</time><b>${v7TrackLabel(entry)}</b><span>${escapeHtml(compact(entry.actor || entry.channel || entry.kind || 'system', 22))}</span><strong>${escapeHtml(compact(entry.content || entry.summary || entry.kind || 'event', 86))}</strong></button>`).join('') : '<div class="v7-no-events">当前快照没有事件。</div>'}</div></section>
      <aside class="v7-panel v7-signal-panel"><header><div><span class="v7-kicker">04 / CURRENT SIGNAL</span><h2>Selected event</h2></div><span class="v7-signal-mark" aria-hidden="true"></span></header><div class="v7-signal-content">${selected ? `<div class="v7-signal-meta"><b>${escapeHtml(selectedTrack)}</b><time>${v7Time(v7EntryTime(selected))}</time></div><h3>${escapeHtml(compact(selected.actor || selected.channel || selected.kind || 'System event', 80))}</h3><p>${escapeHtml(selectedSummary)}</p><dl><div><dt>KIND</dt><dd>${escapeHtml(selected.kind || '—')}</dd></div><div><dt>ID</dt><dd>${escapeHtml(v7EntryId(selected, entries.indexOf(selected)))}</dd></div></dl>` : '<p class="v7-muted">选择一条事件后查看信号详情。</p>'}</div><footer><button type="button" data-v7-action="inspect" ${selected ? '' : 'disabled'}>打开详情</button><button type="button" data-v7-action="now">刷新当前</button></footer></aside>
    </div>
    <footer class="v7-footer"><span>SCENE <b>${escapeHtml(snapshot?.scenes?.at(-1)?.summary || snapshot?.scenes?.at(-1)?.hook || '—')}</b></span><span>SNAPSHOT <b>${escapeHtml(snapshot?.revision ? compact(snapshot.revision, 26) : 'compat')}</b></span><span>V4 保留完整 Browser / Inspector / Arrangement；V7 只共享数据源。</span></footer>
  </div>`
  const pickEntry = entry => {
    if (!entry) return
    v7SignalId = v7EntryId(entry, entries.indexOf(entry))
    lastRenderedV7Key = ''
    renderV7Workbench(target, state.snapshot)
  }
  target.querySelectorAll('[data-v7-entry]').forEach(button => button.addEventListener('click', () => pickEntry(entries.find((entry, index) => v7EntryId(entry, index) === button.dataset.v7Entry))))
  target.querySelectorAll('[data-v7-trend-index]').forEach(point => point.addEventListener('click', () => {
    const bucket = trend.buckets[Number(point.dataset.v7TrendIndex)]
    pickEntry(bucket?.entries?.at(-1))
  }))
  target.querySelector('[data-v7-action="refresh"]')?.addEventListener('click', () => void refreshSnapshot())
  target.querySelector('[data-v7-action="now"]')?.addEventListener('click', () => void refreshSnapshot())
  target.querySelector('[data-v7-action="new"]')?.addEventListener('click', () => byId('new-story')?.click())
  target.querySelector('[data-v7-action="theme"]')?.addEventListener('click', () => byId('theme-menu-btn')?.click())
  target.querySelector('[data-v7-action="inspect"]')?.addEventListener('click', () => {
    if (!selected) return
    state.inspected = { type: 'entry', entry: selected }
    state.detail = 'events'
    renderInspector(); renderDetail()
    showToast('已在 Inspector / Detail 中打开当前事件。', 'info')
  })
}

var lastRenderedSnapshotKey = ''
// Overview shares the time canvas; document-style views must not drive its HUD.
function isTimelineStudioView(view = state.browserView) {
  return ['overview', 'timeline', 'facts', 'schedule'].includes(view)
}
function renderArrangement() {
  syncWorkspaceProfileView()
  if (isV7Profile() && state.surface === 'studio') {
    renderV7Workbench(byId('v7-workbench-surface'), state.snapshot)
    return
  }
  const overviewMode = state.browserView === 'overview'
  const timelineVisible = isTimelineStudioView()
  const modeViewport = byId('studio-mode-viewport')
  const transitioning = Boolean(modeViewport?.classList.contains('is-transitioning'))
  if (modeViewport && !transitioning) modeViewport.dataset.studioView = overviewMode ? 'overview' : 'timeline'
  if (modeViewport) modeViewport.setAttribute('aria-busy', String(transitioning))
  byId('story-hud')?.setAttribute('aria-hidden', String(!overviewMode && !transitioning))
  byId('arrangement')?.setAttribute('aria-hidden', 'false')
  byId('studio-surface').classList.toggle('timeline-hidden', !timelineVisible)
  byId('studio-surface').classList.toggle('studio-overview', overviewMode)
  if (!timelineVisible && nowPlayheadEl) nowPlayheadEl.style.display = 'none'
  // 流畅度：同故事同 revision 不重建 DOM（避免定时器刷屏时闪烁）
  const currentKey = `${state.storyId}:${state.snapshot?.revision ?? 'none'}:${state.browserView}:${JSON.stringify(layoutFor().tracks)}:${state.snapshot?.range?.from || ''}:${state.snapshot?.range?.to || ''}:${selectedStory()?.running}:${selectedStory()?.bridgeReady}`
  if (currentKey === lastRenderedSnapshotKey && byId('arrangement')?.children.length > 0) {
    // 只更新标尺和拖拉条，不重建轨道
    if (overviewMode) renderStoryHud(byId('story-hud'), state.snapshot)
    paintTimeline()
    ensureNowPlayhead()
    return
  }
  lastRenderedSnapshotKey = currentKey
  updateCanvasFromViewport()  // 每次渲染前同步画布参数
  const target = byId('arrangement'); const story = selectedStory()
  if (!story) {
    laneStructureKey = ''; target.replaceChildren()
    if (overviewMode) renderStoryHud(byId('story-hud'), null)
    else target.innerHTML = '<div class="arrangement-empty">从左侧 Browser 选择一个故事。Studio 只展示来自 HDSI 和 typ-0 的有限只读投影。</div>'
    return
  }
  if (state.browserView === 'session') { laneStructureKey = ''; target.replaceChildren(); return renderSessionView(target, story) }
  if (state.browserView === 'mixer') {
    // 审查T17: revision 变化不需要重建 mixer（参数/人设与快照无关）——同故事已渲染时跳过。
    if (mixerState.storyId === story.meta.id && target.querySelector('.mixer-rack')) return
    laneStructureKey = ''; target.replaceChildren(); return renderMixerView(target, story)
  }
  if (state.browserView === 'stats') { laneStructureKey = ''; target.replaceChildren(); return renderStatsView(target, story) }
  if (state.browserView === 'analysis') { laneStructureKey = ''; target.replaceChildren(); return renderAnalysisView(target, story) }
  if (!story.running || !story.bridgeReady) {
    laneStructureKey = ''; target.innerHTML = `<div class="arrangement-empty"><strong>${escapeHtml(story.meta.name)}</strong> 尚未可读。加载并等待 Worker bridge 就绪后，才能请求它的时间线投影。<button data-arrangement-load>Load Worker</button></div>`
    if (overviewMode) renderStoryHud(byId('story-hud'), state.snapshot)
    target.querySelector('button')?.addEventListener('click', loadSelected); return
  }
  const snapshot = state.snapshot
  if (!snapshot) { laneStructureKey = ''; target.innerHTML = state.snapshotError
    ? `<div class="arrangement-empty"><strong>读取时间线失败</strong><br>${escapeHtml(compact(state.snapshotError, 180))}<br><button data-arrangement-refresh>重试</button></div>`
    : '<div class="arrangement-empty">正在等待时间线投影… <button data-arrangement-refresh>Refresh</button></div>'
    if (overviewMode) renderStoryHud(byId('story-hud'), null)
    target.querySelector('button')?.addEventListener('click', refreshSnapshot); return
  }
  const entries = snapshot.entries || []; const bounds = timelineBounds(snapshot); const visibleTracks = layoutFor().tracks
  const scripts = buildScriptBlocks(entries).map(block => ({ ...block, kind: 'script', meta: `${block.exactRange ? '已确认时段' : '时间点'} · ${dateText(block.start)}` }))
  // 连条布局：script 片段按时长比例顺序排列（无间隙），宽度 ∝ 段时长

  const timeline = entries.map(entry => ({ ...entry, startAt: entry.startedAt || entry.occurredAt, endAt: entry.endedAt || entry.startedAt || entry.occurredAt }))
  const receive = timeline.filter(entry => entryTrack(entry) === 'receive')
  const send = timeline.filter(entry => entryTrack(entry) === 'send')
  const alter = timeline.filter(entry => entryTrack(entry) === 'alter')
  const mediaEntries = timeline.filter(entry => isMediaEntry(entry))
  const scenes = (snapshot.scenes || []).map(scene => ({ kind: scene.status, content: scene.hook || scene.summary, scene, startAt: toMillis(scene.startedAt) || bounds.start, endAt: toMillis(scene.endedAt) || bounds.now }))
  const facts = (snapshot.facts || []).map(fact => ({ kind: fact.scope, content: fact.content, fact, startAt: toMillis(fact.updatedAt) || bounds.now, endAt: (toMillis(fact.updatedAt) || bounds.now) + 20 * 60 * 1000 }))
  const preplan = snapshot.preplan ? [{ kind: `preplan r${snapshot.preplan.revision}`, content: `计划 r${snapshot.preplan.revision} · ${hudDateTime(snapshot.preplan.validFrom)} → ${hudDateTime(snapshot.preplan.validThrough)}`, preplan: snapshot.preplan, startAt: toMillis(snapshot.preplan.validFrom) || bounds.now, endAt: toMillis(snapshot.preplan.validThrough) || bounds.end }] : []
  const alterState = snapshot.alter
  const compactionState = snapshot.compaction
  const compactionEntries = compactionState ? [{ kind: compactionState.isDirty ? 'compacting' : 'idle', content: `${compactionState.sceneHook || 'Scene #' + compactionState.activeSceneId} · ${compactionState.entryCount} entries · ${dateText(toMillis(compactionState.lastCompactionAt) || bounds.now)}`, startAt: toMillis(compactionState.lastCompactionAt) || bounds.start, endAt: bounds.now }] : []
  renderTrackMenu({ script: scripts.length, receive: receive.length, send: send.length, alter: alter.length, state: scenes.length + facts.length, preplan: preplan.length, media: mediaEntries.length, compaction: compactionEntries.length })
  const desired = []
  if (state.browserView === 'facts') { desired.push({ label: 'SCENES', key: 'scenes', entries: scenes, options: { note: 'RANGE' } }, { label: 'FACTS', key: 'events', entries: facts, options: { note: 'ACTIVE' } }) }
  else if (state.browserView === 'schedule') desired.push({ label: 'SCHEDULE / FUTURE', key: 'schedule', entries: preplan, options: { className: 'preplan-track', note: 'TENTATIVE' } })
  else {
    if (visibleTracks.script) desired.push({ label: 'SCRIPT', key: 'narrative', entries: scripts, options: { className: 'script-track', primary: true, note: 'SEGMENTS' } })
    if (visibleTracks.receive) desired.push({ label: 'RECEIVE', key: 'messages', entries: receive, options: { className: 'message-track receive', note: 'INBOUND' } })
    if (visibleTracks.send) desired.push({ label: 'SEND', key: 'messages', entries: send, options: { className: 'message-track send', note: 'OUTBOUND' } })
    if (visibleTracks.alter) desired.push({ label: 'ALTER', key: 'events', entries: alter, options: { className: 'alter-track', note: alterState ? `VAL ${alterState.value > 0 ? '+' : ''}${(Number.isFinite(Number(alterState.value)) ? Number(alterState.value) : 0).toFixed(1)}${alterState.emotionalOffset ? ' · ' + alterState.emotionalOffset.direction.toUpperCase() : ''}` : 'EMOTION' } })
    if (visibleTracks.state) desired.push({ label: 'FACTS & SCENES', key: 'scenes', entries: [...scenes, ...facts], options: { className: 'facts-track', note: 'STATE' } })
    if (visibleTracks.preplan) desired.push({ label: 'PREPLAN', key: 'schedule', entries: preplan, options: { className: 'preplan-track', note: 'FUTURE' } })
    if (visibleTracks.media) desired.push({ label: 'MEDIA FILES', key: 'media', entries: mediaEntries, options: { className: 'media-track', note: 'ATTACHMENTS' } })
    if (visibleTracks.compaction) desired.push({ label: 'COMPACTION', key: 'compaction', entries: compactionEntries, options: { className: 'compaction-track', note: compactionState ? (compactionState.isDirty ? 'DIRTY' : 'CLEAN') : 'OFFLINE' } })
  }
  // Arrangement 始终持有完整轨道。Overview 只通过布局和裁切显示前三条，
  // 因而 HUD 与 Timeline 使用的就是同一批 DOM 节点，不需要跨父节点搬运。
  const arrangementDesired = desired
  // 增量重绘：轨道结构（视图/可见轨集合）不变时按 entityId 复用既有 clip 元素。
  const structureKey = `v:studio|t:${JSON.stringify(visibleTracks)}|shared:arrangement`
  if (structureKey !== laneStructureKey || target.querySelectorAll('.arrangement-track').length !== arrangementDesired.length) {
    laneStructureKey = structureKey
    rulerGridSignature = ''
    const scrollTop = target.scrollTop
    target.replaceChildren(...arrangementDesired.map(d => makeTrack(d.label, d.key, d.entries, bounds, d.options)))
    target.scrollTop = scrollTop
  } else {
    reconcileTracks(target, arrangementDesired, bounds)
  }
  byId('arrange-range-start').textContent = dateText(bounds.start); byId('arrange-range-end').textContent = dateText(bounds.end)
  byId('arrangement-ruler').title = `${dateText(bounds.start)} → ${dateText(bounds.end)}`
  const footerText = `${entries.length} entries · ${scripts.length} segments${snapshot.nextCursor ? ' · 部分加载（请缩小范围）' : ''}${selectedStory()?.meta.phase === 'paused' ? ' · Shift+拖选可删除区间' : ''}`
  const footerEl = target.querySelector('.arrangement-footer')
  if (footerEl) footerEl.textContent = footerText
  else { const footer = document.createElement('div'); footer.className = 'arrangement-footer'; footer.textContent = footerText; target.appendChild(footer) }
  updateTimelineScroller(bounds)
  ensureNowPlayhead()
  // 恢复滚动位置：用 canvas 设置时缓存的偏移（不是重新调 timelineViewport——
  // followNow=true 时每次调用返回新的 Date.now()，会导致 scrollLeft 和 clip 不同步）
  const arr = byId('arrangement')
  if (arr) arr.scrollLeft = 0
  paintTimeline()
  if (overviewMode) renderStoryHud(byId('story-hud'), snapshot)
}

// ── 增量 clip 协调：按 entityId 复用/更新/增删，避免整轨重建闪烁 ─────────
var laneStructureKey = ''
function reconcileTracks(target, desired, bounds) {
  const sections = Array.from(target.querySelectorAll('.arrangement-track'))
  desired.forEach((d, i) => {
    const section = sections[i]; if (!section) return
    section.__trackEntries = d.entries
    if (!d.options.primary) assignSubRows(d.entries)
    const lane = section.querySelector('.track-lane'); if (!lane) return
    const fresh = d.entries.map(entry => clip(d.key, entry, bounds, d.options)).filter(el => el && el.nodeType === 1)
    reconcileClips(lane, fresh)
    const small = section.querySelector('header small')
    if (small) small.textContent = `${d.entries.length}${d.options.note ? ` · ${d.options.note}` : ''}`
    section.querySelector('.track-led')?.classList.toggle('on', d.entries.length > 0)
  })
}
function reconcileClips(lane, fresh) {
  // P2-6：无 entityId 的条目（Facts/Scenes）此前以 startMs 为 key——同毫秒多条
  // 会互相覆盖；补 kind + lane 序号消歧（同一元素的序号在增量重绘间保持稳定，
  // 因为 reconcile 按 key 复用后 dataset 不变）。
  let clipSeq = 0
  const clipKey = el => {
    const id = el.dataset.entityId
    if (id && id !== 'undefined' && id !== 'null') return id
    if (!el.dataset.fallbackKey) el.dataset.fallbackKey = `fb:${el.closest('.arrangement-track')?.__trackKey ?? el.dataset.startMs}:${el.dataset.startMs}:${++clipSeq}`
    return el.dataset.fallbackKey
  }
  // 审查T18: facts/scenes 无实体 id 时按 startMs 做 key，同毫秒多条会撞 key——
  // Map 构建时后项覆盖前项导致被覆盖的旧元素脱离 Map 永不清理（DOM 残留重复）；
  // 保留分支也可能 keep 一个已被同 key 前一条 remove 的 detached 元素（新 clip 被静默丢弃）。
  const existing = new Map()
  for (const el of Array.from(lane.querySelectorAll('.clip'))) {
    const key = clipKey(el)
    const prev = existing.get(key)
    if (prev) prev.remove()
    existing.set(key, el)
  }
  const keep = new Set()
  const detached = new Set()
  for (const el of fresh) {
    const key = clipKey(el)
    const old = existing.get(key)
    if (old && !detached.has(key) && old.dataset.startMs === el.dataset.startMs && old.dataset.endMs === el.dataset.endMs && old._scriptContent === el._scriptContent) {
      old.classList.toggle('selected', el.classList.contains('selected'))
      old.title = el.title
      old.__entry = el.__entry
      keep.add(key)
    } else {
      if (old && !detached.has(key)) old.remove()
      detached.add(key)
      lane.appendChild(el)
      keep.add(key)
    }
  }
  for (const [key, el] of existing) if (!keep.has(key) && el.isConnected) el.remove()
}


// Scroller has one persistent implementation.

document.addEventListener('keydown', event => {
  if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement) return
  // 组合键（Ctrl/Meta/Alt）先于焦点与模态判定：按钮获得焦点是点击后的常态，
  // 不能因此废掉 Ctrl+K 全局搜索。
  if (event.ctrlKey || event.metaKey || event.altKey) {
    if (event.key.toLowerCase() === 'k' && !document.querySelector('dialog[open]')) { event.preventDefault(); openGlobalSearch() }
    return
  }
  // 模态对话框（配置/向导）打开期间其余快捷键整体屏蔽。
  if (document.querySelector('dialog[open]')) return
  if (event.key === 'F5') { event.preventDefault(); void refreshSnapshot(); return }
  if (event.key === '?') { event.preventDefault(); byId('help-dialog').showModal(); return }
  // 审查T20: 焦点在按钮/摘要上时 Space 留给原生激活（无障碍），不得切剧本相位。
  if (event.target instanceof HTMLButtonElement || event.target instanceof HTMLDetailsElement) return
  if (event.code === 'Space') {
    event.preventDefault()
    const cycle = ['running', 'muted', 'paused']
    const current = selectedStory()?.meta?.phase
    if (!current) return
    const next = cycle[(cycle.indexOf(current) + 1) % cycle.length]
    // Space 是"滚动页面"的肌肉记忆——切换必须给出可见反馈，否则用户不知道自己按停了角色
    void desktop.stories.setPhase(state.storyId, next).then(() => { showToast(`已切换：${phases[next] ?? next}（Space 循环 运行/静音/暂停）`, 'info'); return refresh() }).catch(error => reportUserError(state.storyId, `切换状态失败：${error}`))
    return
  }
  const viewKeys = { '1': 'overview', '2': 'timeline', '3': 'session', '4': 'mixer' }
  const target = viewKeys[event.key]
  if (target) { const button = document.querySelector(`[data-browser-view="${target}"]`); if (button) button.click() }
})

// ── M6 Koishi Surface：隔离 Console 嵌入的前端控制 ──────────────────────────
const consoleState = { descriptor: null, embedded: false }
let consoleResizeTimer = null

function koishiAnchorBounds() {
  const anchor = byId('koishi-embed-anchor')
  if (!anchor || !anchor.offsetParent) return null
  const rect = anchor.getBoundingClientRect()
  if (rect.width < 50 || rect.height < 50) return null
  return { x: Math.round(rect.left), y: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) }
}

async function refreshConsoleInfo() {
  const story = selectedStory()
  if (!story) { consoleState.descriptor = null; consoleState.embedded = false; renderKoishiState(); return }
  try {
    const info = await desktop.console.info(story.meta.id)
    if (state.storyId !== story.meta.id) return
    consoleState.descriptor = info.descriptor || null
    consoleState.embedded = Boolean(info.embedded)
  } catch { consoleState.descriptor = null; consoleState.embedded = false }
  renderKoishiState()
}

function renderKoishiState() {
  const story = selectedStory()
  const overlay = byId('koishi-overlay')
  byId('koishi-endpoint').textContent = consoleState.descriptor?.endpoint || '待 Worker 上报'
  byId('koishi-embed-state').textContent = consoleState.embedded ? '已嵌入（隔离会话）' : '未嵌入'
  byId('koishi-attach').disabled = !consoleState.descriptor
  byId('koishi-detach').disabled = !consoleState.embedded
  const embeddable = consoleState.descriptor && koishiAnchorBounds()
  // 端点就绪且 Surface 可见 → 隐藏说明覆盖层，露出嵌入视图。
  overlay.classList.toggle('hidden', Boolean(consoleState.embedded && embeddable))
  if (consoleState.descriptor && !consoleState.embedded) {
    byId('koishi-overlay-title').textContent = 'Console 端点已就绪'
    byId('koishi-overlay-text').textContent = '点击「打开 Console」以隔离会话嵌入。页面只能访问该故事的 loopback 端点，不能使用 Node、读取密钥或导航到其它网址。'
  } else if (!consoleState.descriptor) {
    byId('koishi-overlay-title').textContent = '当前故事的 Koishi Console'
    byId('koishi-overlay-text').textContent = story?.running
      ? 'Worker 已启动，正在等待它上报 Console 端口（注入的 loopback server 就绪后自动出现）。'
      : '加载 Worker 后，桌面壳会为它注入仅绑定 127.0.0.1 的隔离 Console 端点。'
  }
}

async function attachConsole() {
  const story = selectedStory()
  if (!story || !consoleState.descriptor) return
  const bounds = koishiAnchorBounds()
  if (!bounds) { byId('koishi-status').textContent = '窗口过小或 Surface 未可见，无法嵌入。'; return }
  try {
    await desktop.console.attach(story.meta.id, bounds)
    consoleState.embedded = true
    renderKoishiState()
    byId('koishi-status').textContent = `已嵌入 ${consoleState.descriptor.endpoint}`
  } catch (error) { byId('koishi-status').textContent = `嵌入失败：${error}` }
}

async function detachConsole(storyId = state.storyId) {
  if (!storyId) return
  try { await desktop.console.detach(storyId) } catch { /* view may already be destroyed */ }
  if (storyId === state.storyId) { consoleState.embedded = false; renderKoishiState() }
}

function scheduleConsoleResize() {
  if (!consoleState.embedded) return
  clearTimeout(consoleResizeTimer)
  consoleResizeTimer = setTimeout(() => {
    const story = selectedStory(); if (!story) return
    const bounds = koishiAnchorBounds()
    if (bounds) desktop.console.resize(story.meta.id, bounds).catch(error => console.warn('[console] resize 失败：', error))
  }, 120)
}

/** 选点重启：从当前选中的剧本条目位置创建分支。 */
async function createBranchFromSelection(entry) {
  const story = selectedStory()
  if (!story) return
  if (!entry) { appendLog({ storyId: story.meta.id, line: '创建分支需要先在时间线上选中一个位置。' }); return }
  const name = await hostPrompt({ title: '创建分支', label: '分支名称（必填）：', value: story.meta.name + ' · 新分支', confirmLabel: '创建' })
  if (!name || !name.trim()) return
  const forkPoint = {
    ...(Number.isSafeInteger(Number(entry.id)) ? { entryId: Number(entry.id) } : {}),
    ...(entry.occurredAt ? { occurredAt: entry.occurredAt } : {}),
  }
  if (forkPoint.entryId === undefined && !forkPoint.occurredAt) {
    appendLog({ storyId: story.meta.id, line: '所选对象没有可定位的时间信息，无法作为分叉点。' }); return
  }
  if (story.running) {
    if (!window.confirm('创建分支前会先卸载当前剧本（保证数据库复制完整）。继续吗？')) return
    try { await desktop.stories.unload(story.meta.id); await refresh() } catch (error) { reportUserError(story.meta.id, '卸载失败：' + error); return }
  }
  try {
    const result = await desktop.stories.forkBranch(story.meta.id, { name: name.trim(), slug: 'branch', forkPoint })
    appendLog({ storyId: story.meta.id, line: '分支已创建：' + result.id + '（默认暂停、未绑定账号）。源剧本数据完整保留。' })
    showToast('分支已创建，正在切换到它。', 'ok')
    await refresh()
    state.storyId = result.id; persist()
    await refresh()
  } catch (error) { reportUserError(story.meta.id, '创建分支失败：' + error) }
}

// ── 选区删除（purge-range）：Shift+拖选 Arrangement 时间轴 → 确认 → bridge purge ──
let purgeDragState = null

function purgeSelectionOverlay() {
  let overlay = byId('purge-selection')
  if (!overlay) {
    overlay = document.createElement('div')
    overlay.id = 'purge-selection'
    overlay.style.cssText = 'position:absolute; top:0; bottom:0; background:rgba(223,119,119,.18); border-left:1px solid #df7777; border-right:1px solid #df7777; pointer-events:none; z-index:5;'
    byId('arrangement').appendChild(overlay)
  }
  return overlay
}

function purgeSelectionPercent(fromEvent){const rect=byId('arrangement').getBoundingClientRect();return new Date(pxToTime(bounded(fromEvent.clientX-rect.left-canvas.headerWidth,0,canvas.viewWidthPx))).toISOString()}

async function commitPurgeSelection(fromIso, toIso) {
  const story = selectedStory()
  if (!story) return
  if (story.meta.phase !== 'paused') {
    appendLog({ storyId: story.meta.id, line: '选区删除仅在剧本暂停（paused）时可用——请先 ■ 暂停剧本。' }); return
  }
  if (!window.confirm('删除 ' + dateText(fromIso) + ' → ' + dateText(toIso) + ' 区间内的剧本、记忆、事实与意图？\n该操作不可撤销（软删，Canon 保留）。')) return
  try {
    const result = await desktop.stories.purgeRange(story.meta.id, fromIso, toIso)
    if (result.canceled) { appendLog({ storyId: story.meta.id, line: '选区删除已取消。' }); return }
    appendLog({ storyId: story.meta.id, line: '选区删除完成，时间线将出现诚实空洞（该区间视为未发生）。' })
    void refreshSnapshot()
  } catch (error) { reportUserError(story.meta.id, '选区删除失败：' + error) }
}

function renderInspector() {
  const target = byId('inspector-content'); const story = selectedStory(); const item = state.inspected
  if (item?.type === 'script') {
    byId('inspector-kind').textContent = 'SCRIPT SEGMENT'
    target.innerHTML = `<div class="inspect-title">剧本时段</div><div class="inspect-subtitle">${escapeHtml(dateText(item.entry.start))} → ${escapeHtml(dateText(item.entry.end))}</div><dl class="inspect-grid"><div><dt>剧本条目</dt><dd>${item.entry.entries.length}</dd></div><div><dt>字符数</dt><dd>${String(item.entry.content || '').length}</dd></div></dl><section class="inspect-content">${escapeHtml(compact(item.entry.content, 500))}</section><button id="inspect-open-script">在下方展开完整剧本</button>`
    byId('inspect-open-script')?.addEventListener('click', () => setDetail('script'))
    for (const action of item.entry.deliveryActions || []) {
      const section = document.createElement('section'); section.className = 'delivery-reality'
      const title = document.createElement('b'); title.textContent = `${action.eventId} · ${action.status}`; section.appendChild(title)
      for (const segment of action.segments || []) {
        const line = document.createElement('div'); line.className = 'delivery-segment'
        line.textContent = `${segment.status} · ${segment.content}`; section.appendChild(line)
      }
      target.appendChild(section)
    }
    return
  }
  if (item?.type === 'entry') {
    const entry = item.type === 'script' ? item.entry.entries?.[0] : item.entry
    const actions = item.type === 'script' ? item.entry.deliveryActions : entry?.deliveryActions
    const actionsHtml = Array.isArray(actions) && actions.length ? actions.map(action => {
      // 旧账本/部分失败行动可能没有 segments——空保护防整个 Inspector 断渲染。
      const segments = (action.segments ?? []).map(seg => '<div class="delivery-segment"><em>' + escapeHtml(seg.status) + '</em><span>' + escapeHtml(compact(seg.content, 60)) + '</span></div>').join('')
      return '<section class="delivery-reality"><b>行动 ' + escapeHtml(String(action.eventId).slice(0, 8)) + ' · ' + escapeHtml(action.status) + '</b>' + segments + '</section>'
    }).join('') : ''
    const deepLinkId = entry?.entityId || entry?.id
    // §8.3：事件摘要必须含投递状态与来源端点（metadata.channel 由主仓 M1a 落账）
  const deliverySummary = Array.isArray(entry?.deliveryActions) && entry.deliveryActions.length
    ? entry.deliveryActions.map(action => action.status).join(' / ') : ''
  const chMeta = entry?.metadata?.channel
  const endpointSummary = chMeta && typeof chMeta === 'object'
    ? `${chMeta.channelKind === 'wechat' ? '微信' : 'QQ'}${chMeta.selfId ? ' · ' + chMeta.selfId : ''}${chMeta.conversationKind === 'group' ? ' · 群聊' : chMeta.conversationKind === 'private' ? ' · 私聊' : ''}`
    : ''
  target.innerHTML = `<div class="inspect-title">${escapeHtml(entry?.actor || 'system')}</div><dl class="inspect-grid"><div><dt>发生时间</dt><dd>${escapeHtml(dateText(entry?.occurredAt))}</dd></div><div><dt>参与者</dt><dd>${escapeHtml(entry?.participantId || '—')}</dd></div>${deliverySummary ? `<div><dt>投递状态</dt><dd>${escapeHtml(deliverySummary)}</dd></div>` : ''}${endpointSummary ? `<div><dt>来源端点</dt><dd>${escapeHtml(endpointSummary)}</dd></div>` : ''}<div><dt>条目 ID</dt><dd>${escapeHtml(entry?.id)}</dd></div>${entry?.commitId ? `<div><dt>Commit</dt><dd>${escapeHtml(String(entry.commitId).slice(0, 12))}</dd></div>` : ''}</dl><section class="inspect-content">${escapeHtml(entry?.content)}</section>${actionsHtml}<section class="inspector-actions"><button id="inspect-to-events">在 Events 中查看</button>${deepLinkId ? '<button id="inspect-to-logs">查相关日志</button>' : ''}<button id="inspect-to-branch">从此处创建分支</button></section>`
    byId('inspect-to-events')?.addEventListener('click', () => setDetail('events'))
    byId('inspect-to-branch')?.addEventListener('click', () => void createBranchFromSelection(entry))
    byId('inspect-to-logs')?.addEventListener('click', () => {
      // 日志深链接：切到 Logs Surface，用条目 ID 作关键词过滤（correlation 人工定位）。
      const term = String(deepLinkId)
      setSurface('logs')
      const search = byId('log-search')
      if (search) search.value = term
      applyLogFilters()
    })
    return
  }
  if (item?.type === 'fact' || item?.type === 'scene' || item?.type === 'preplan') {
    byId('inspector-kind').textContent = item.type.toUpperCase()
    const subject = item.entry.fact || item.entry.scene || item.entry.preplan
    target.innerHTML = `<div class="inspect-title">${escapeHtml(item.entry.content || item.entry.kind)}</div><div class="inspect-subtitle">${escapeHtml(item.type)} · ${escapeHtml(item.entry.kind || '—')}</div><section class="inspect-content">${escapeHtml(JSON.stringify(subject, null, 2))}</section>`
    return
  }
  byId('inspector-kind').textContent = 'STORY CONTEXT'
  if (!story) { byId('inspector-kind').textContent = 'INSPECTOR'; target.innerHTML = `<div class="empty-state"><strong>未选择故事</strong><p>从左侧选择一个故事，或创建新剧本。</p><div class="empty-actions"><button id="empty-new-story">＋ 新建剧本</button></div></div>`; byId('empty-new-story')?.addEventListener('click', () => byId('new-story')?.click()); return }

  const snapshot = state.snapshot
  const overview = state.hostOverview
  const outbox = overview?.outbox?.states ?? {}
  const usage = overview?.usage
  const error = overview?.recentErrors?.[0]
  const core = overview?.worker?.runtimeCore || story.runtimeCore
  const bridge = overview?.worker?.bridgeProtocol || story.bridgeProtocol
  const entries = snapshot?.entries || []
  const observedEndpoints = new Map()
  for (const entry of entries) {
    const channel = entry.metadata?.channel
    if (!channel || typeof channel !== 'object') continue
    const kind = channel.channelKind === 'wechat' ? '微信' : channel.channelKind === 'qq' ? 'QQ' : String(channel.channelKind || '通道')
    const selfId = String(channel.selfId || channel.endpointId || '默认端点')
    const key = `${kind}:${selfId}`
    const prior = observedEndpoints.get(key) || { kind, selfId, count: 0, latestAt: '' }
    prior.count += 1
    if (!prior.latestAt || (toMillis(entry.occurredAt) || 0) > (toMillis(prior.latestAt) || 0)) prior.latestAt = entry.occurredAt
    observedEndpoints.set(key, prior)
  }
  const endpointHtml = [...observedEndpoints.values()].slice(0, 4).map(item => `<div class="context-endpoint"><i>${item.kind === '微信' ? 'W' : item.kind === 'QQ' ? 'Q' : '·'}</i><span><b>${escapeHtml(item.kind)} · ${escapeHtml(item.selfId)}</b><small>时间窗内 ${item.count} 条记录 · 最近 ${hudTime(item.latestAt)}</small></span><em class="observed">近期出现</em></div>`).join('') || '<div class="context-muted">当前时间窗没有可识别的渠道来源；这不代表端点离线。</div>'
  const scenes = (snapshot?.scenes || []).slice().sort((a, b) => (toMillis(a.startedAt) || 0) - (toMillis(b.startedAt) || 0))
  const activeScene = scenes.filter(scene => scene.status === 'active').at(-1)
  const currentScene = activeScene || scenes.at(-1)
  const facts = (snapshot?.facts || []).slice().sort((a, b) => (toMillis(b.updatedAt) || 0) - (toMillis(a.updatedAt) || 0))
  const sceneHtml = currentScene
    ? `<div class="context-route-row"><span>${activeScene ? '进行中' : '最近场景'}</span><b>${escapeHtml(compact(currentScene.hook || currentScene.summary || `场景 ${currentScene.id}`, 72))}</b></div><div class="context-route-row"><span>场景状态</span><b>${escapeHtml(currentScene.status || '未知')} · ${Number(currentScene.entryCount) || 0} 条来源记录</b></div>`
    : '<div class="context-muted">HDSI 尚未提供场景记录。</div>'
  const factsHtml = facts.slice(0, 3).map(fact => `<div class="context-route-row"><span>${escapeHtml(fact.scope || '事实')}${fact.unresolved ? ' · 待解决' : ''}</span><b>${escapeHtml(compact(fact.content || '—', 62))}</b></div>`).join('') || '<div class="context-muted">当前投影没有活动事实。</div>'
  const preplan = snapshot?.preplan
  const preplanHtml = preplan
    ? `<div class="context-route-row"><span>预计划有效期</span><b>${escapeHtml(preplan.validFrom ? dateText(preplan.validFrom) : '未提供起点')} → ${escapeHtml(preplan.validThrough ? dateText(preplan.validThrough) : '未提供终点')}</b></div><div class="context-route-row"><span>计划时区 / 修订</span><b>${escapeHtml(preplan.timezone || snapshot?.timezone || '—')} · ${Number(preplan.revision) || 0}</b></div>`
    : '<div class="context-muted">暂无预计划；不推断下一步行动。</div>'
  const phaseLabel = phases[story.meta.phase] ?? story.meta.phase
  const workerLabel = story.running ? (story.bridgeReady ? '已就绪' : '启动中') : '未加载'
  const inboxCount = overview?.inbox?.pending ?? 0
  const outboxPending = (outbox.generated || 0) + (outbox.sending || 0)
  const outboxUnknown = outbox.unknown || 0
  const outboxFailed = (outbox['retryable-failed'] || 0) + (outbox['permanent-failed'] || 0)
  const outboxSettled = (outbox.confirmed || 0) + (outbox.accepted || 0) + (outbox.sent || 0)
  target.innerHTML = `<div class="inspect-story-head"><span class="inspect-eyebrow">SELECTED STORY</span><div class="inspect-title">${escapeHtml(story.meta.name)}</div><div class="inspect-subtitle">${escapeHtml(story.meta.characterName)} · ${escapeHtml(story.meta.id)}</div></div>
    <section class="context-inspector-section"><h4>运行与桥接 <small>${escapeHtml(String(phaseLabel).toUpperCase())}</small></h4><dl class="inspect-grid"><div><dt>故事阶段</dt><dd>${escapeHtml(phaseLabel)}</dd></div><div><dt>Worker</dt><dd>${escapeHtml(workerLabel)}</dd></div><div><dt>Bridge 协议</dt><dd>${bridge ? `v${escapeHtml(String(bridge))}` : '未协商'}</dd></div><div><dt>HDSI Core</dt><dd>${escapeHtml(core?.version || 'unknown')}</dd></div>${usage ? `<div><dt title="${escapeHtml(usage.day || '未提供用量日期')}">模型调用 · ${escapeHtml(String(usage.day || '最近记录').replace(/^\d{4}-/, ''))}</dt><dd>${Number(usage.calls) || 0}</dd></div><div><dt>Token 输入 / 输出</dt><dd>${Number(usage.inputTokens) || 0} / ${Number(usage.outputTokens) || 0}</dd></div>` : ''}<div><dt>故事时区</dt><dd>${escapeHtml(snapshot?.timezone || '未提供')}</dd></div><div><dt>叙事游标</dt><dd>${escapeHtml(snapshot?.cursorAt ? dateText(snapshot.cursorAt) : '—')}</dd></div></dl></section>
    <section class="context-inspector-section"><h4>近期端点来源 <small>${observedEndpoints.size} OBSERVED</small></h4>${endpointHtml}<p class="context-note">基于时间窗内条目来源；不等同于账号在线状态。</p></section>
    <section class="context-inspector-section"><h4>当前场景</h4><div class="context-route">${sceneHtml}</div></section>
    <section class="context-inspector-section"><h4>持续性事实 <small>${facts.length} ACTIVE</small></h4><div class="context-route">${factsHtml}</div></section>
    <section class="context-inspector-section"><h4>预计划</h4><div class="context-route">${preplanHtml}</div></section>
    <section class="context-inspector-section"><h4>消息账本</h4><dl class="inspect-grid"><div><dt>收件箱待处理</dt><dd>${overview ? (inboxCount > 0 ? `<button id="inspect-replay" title="把等待的入站消息重新投递给角色">${inboxCount} 条 · 回放</button>` : '0 条') : '读取中…'}</dd></div><div><dt>已受理 / 确认</dt><dd>${overview?.outbox ? outboxSettled : '—'}</dd></div><div><dt>等待投递</dt><dd>${overview?.outbox ? outboxPending : '—'}</dd></div><div><dt>未知 / 失败</dt><dd>${overview?.outbox ? `${outboxUnknown} / ${outboxFailed}` : '—'}</dd></div></dl></section>
    ${error ? `<section class="inspect-error"><b>最近宿主错误 · ${escapeHtml(error.source || 'runtime')}</b><p>${escapeHtml(compact(error.message.replace(/\x1b\[[0-9;]*m/g, ''), 220))}</p></section>` : ''}
    <section class="inspector-actions"><button id="inspect-config">配置故事</button><button id="inspect-backup">创建备份</button></section>`
  byId('inspect-config')?.addEventListener('click', () => openConfig(story.meta.id))
  byId('inspect-backup')?.addEventListener('click', () => backupSelected())
  byId('inspect-replay')?.addEventListener('click', () => void replayStoryInbox(story.meta.id))
}

/** 收件箱回放：Inspector 的"N 待处理"此前只是一个数字——消息进了收件箱没有任何 UI 出口。 */
async function replayStoryInbox(storyId) {
  const button = byId('inspect-replay')
  if (button) { button.disabled = true; button.textContent = '回放中…' }
  try {
    const result = await desktop.stories.replayInbox(storyId)
    showToast(`收件箱回放完成：消费 ${result?.consumed ?? 0} 条，剩余 ${result?.pending ?? 0} 条。`, 'info')
  } catch (error) {
    reportUserError(storyId, '收件箱回放失败：' + error)
  } finally {
    await refreshHostProjection().catch(() => undefined)
    renderInspector()
  }
}

// ── 宿主输入对话框 ────────────────────────────────────────────────────────
// window.prompt 在 Electron 渲染层不渲染任何界面、恒返回 null——删除剧本/
// 创建分支/自定义时间范围/导入剧本等需要文本输入的流程全部静默失败。这里用
// 应用内 <dialog>（index.html #prompt-dialog）提供等价的 Promise 化 prompt；
// window.confirm 在 Electron 正常渲染，保持原生不动。
function hostPrompt({ title = '输入', message = '', label = '', value = '', placeholder = '', requireMatch = '', confirmLabel = '确定', danger = false }) {
  return new Promise(resolve => {
    const dlg = byId('prompt-dialog'); if (!dlg) { resolve(null); return }
    const input = byId('prompt-input'), confirmBtn = byId('prompt-confirm'), hint = byId('prompt-hint')
    byId('prompt-title').textContent = title
    const msgEl = byId('prompt-message')
    msgEl.textContent = message; msgEl.hidden = !message
    const labelEl = byId('prompt-label')
    labelEl.textContent = label; labelEl.hidden = !label
    input.value = value
    input.placeholder = placeholder
    confirmBtn.textContent = confirmLabel
    confirmBtn.classList.toggle('danger', Boolean(danger))
    hint.textContent = requireMatch ? `输入 ${requireMatch} 以确认` : ''
    const check = () => { const ok = !requireMatch || input.value.trim() === requireMatch; confirmBtn.disabled = !ok; hint.hidden = ok || !requireMatch }
    input.oninput = check
    let settled = false
    const finish = result => {
      if (settled) return
      settled = true
      input.oninput = null
      dlg.close()
      resolve(result)
    }
    byId('prompt-cancel').onclick = () => finish(null)
    byId('prompt-close').onclick = () => finish(null)
    // Esc 触发 dialog 的 cancel 事件——统一走 finish，避免 promise 悬挂
    dlg.oncancel = event => { event.preventDefault(); finish(null) }
    byId('prompt-form').onsubmit = event => { event.preventDefault(); if (!confirmBtn.disabled) finish(input.value) }
    check()
    dlg.showModal()
    input.focus()
    if (value) input.select()
  })
}

/** 删除剧本：preload 一直暴露 delete，但界面上没有任何入口——分支试错后无法清理。 */
async function deleteStory(story) {
  if (!window.confirm(`删除剧本「${story.meta.name}」？\n主进程会先创建备份，再把该剧本从列表移除。此操作用于清理不再需要的剧本。`)) return
  const typed = await hostPrompt({
    title: '删除剧本',
    message: `将删除「${story.meta.name}」。主进程会先创建备份，再把该剧本从列表移除。`,
    label: '请输入剧本 ID 以确认删除：',
    requireMatch: story.meta.id,
    confirmLabel: '删除',
    danger: true,
  })
  if (typed === null) { showToast('已取消删除。', 'info'); return }
  if (typed !== story.meta.id) { showToast('ID 不匹配，已取消删除。', 'info'); return }
  try {
    await desktop.stories.delete(story.meta.id)
    mixerDrafts.delete(story.meta.id)   // 审计修复：草稿不随剧本删除清空，同 id 重建时复活
    needsReloadStoryIds.delete(story.meta.id) // B2：悬空标记清理
    showToast('剧本已删除（备份已创建）。', 'ok')
    await refresh()
  } catch (error) { reportUserError(story.meta.id, '删除剧本失败：' + error) }
}

var lastDetailKey=''
function renderDetail() {
  // 实时投递/用量事件此前不参与 key：持久化历史为空时（常态）列表对实时事件失明，永远不更新
  const detailKey=JSON.stringify([state.storyId,state.detail,state.selectedScript?.content,state.snapshot?.revision,state.detail==='deliveries'?[state.deliveryHistory.length,state.deliveriesRev]:state.detail==='usage'?[state.usageSeries.length,state.usageRev]:null])
  const stableKey=state.detail==='script'?JSON.stringify([state.storyId,state.detail,state.selectedScript?.entries]):detailKey
  if(stableKey===lastDetailKey)return
  lastDetailKey=stableKey
  const target = byId('detail-content'); const story = selectedStory(); const snapshot = state.snapshot
  if (state.detail === 'script') {
    const block = state.selectedScript
    target.innerHTML = block ? `<section class="script-detail"><header><strong>Script Segment</strong><span>${escapeHtml(dateText(block.start))} → ${escapeHtml(dateText(block.end))} · ${block.entries.length} 段</span></header>${block.entries.map((entry, index) => `<article><div><b>${index + 1}</b><time>${escapeHtml(dateText(entry.occurredAt))}</time><em>${escapeHtml(entry.kind)}</em></div><p>${escapeHtml(entry.content)}</p></article>`).join('')}</section>` : '<p class="muted-copy">在 Arrangement 的 Script 主轨选择一个覆盖时段的块，即可在这里阅读完整剧本。</p>'
  } else if (state.detail === 'events') {
    const entries = snapshot?.entries || []
    target.innerHTML = entries.length ? entries.slice().reverse().map(entry => `<button class="detail-row" data-entry="${escapeHtml(entry.id)}"><time>${escapeHtml(dateText(entry.occurredAt))}</time><b>${escapeHtml(entry.kind)}</b><span>${escapeHtml(compact(entry.content, 220))}</span></button>`).join('') : '<p class="muted-copy">尚无可展示的事件。加载 Worker 后可读取有限时间线。</p>'
    target.querySelectorAll('[data-entry]').forEach(button => button.addEventListener('click', () => { const entry = entries.find(row => String(row.id) === button.dataset.entry); if (entry) inspect({ type: 'entry', entry }) }))
  } else if (state.detail === 'deliveries') {
    const rows = state.deliveryHistory.length ? state.deliveryHistory : state.deliveries.filter(item => !story || item.storyId === story.meta.id)
    const deliveryStateLabels = { generated: '待发', sending: '发送中', sent: '已受理', confirmed: '已确认', accepted: '已受理', unknown: '结果未知', 'retryable-failed': '失败·可重试', 'permanent-failed': '失败·不可重试' }
    target.innerHTML = rows.length ? rows.slice().reverse().map(item => `<div class="detail-row passive"><time>${escapeHtml(dateText(item.at || item.updatedAt || new Date().toISOString()))}</time><b class="delivery-state" data-state="${escapeHtml(item.state || 'generated')}">${escapeHtml(deliveryStateLabels[item.state] || item.state || 'generated')}</b><span>${escapeHtml(compact(item.content || item.lastError || item.error || item.deliveryId, 220))}</span></div>`).join('') : '<p class="muted-copy">当前故事尚无投递记录。这里只显示宿主 Outbox 账本与实时投递事件。</p>'
  } else if (state.detail === 'usage') {
    const rows = state.usageSeries
    target.innerHTML = rows.length ? rows.slice().reverse().map(item => `<div class="detail-row passive"><time>${escapeHtml(item.day)}</time><b>${escapeHtml(`${item.calls} calls`)}</b><span>${escapeHtml(`in ${item.inputTokens} / cached ${item.cachedInputTokens} / out ${item.outputTokens}${item.estimatedCost != null ? ` · est. ${item.estimatedCost.toFixed(4)}` : ''}`)}</span></div>`).join('') : '<p class="muted-copy">尚无持久化模型用量记录。</p>'
  } else {
    target.innerHTML = `<pre>${escapeHtml(JSON.stringify({ story: story?.meta || null, snapshot: snapshot ? { storyId: snapshot.storyId, timezone: snapshot.timezone, entryCount: snapshot.entries?.length, sceneCount: snapshot.scenes?.length, factCount: snapshot.facts?.length, preplan: snapshot.preplan ? { revision: snapshot.preplan.revision, validFrom: snapshot.preplan.validFrom, validThrough: snapshot.preplan.validThrough } : null } : null }, null, 2))}</pre>`
  }
}

// 旧的全量 renderLogs 已被上方 M5 窗口化版本取代。

async function refresh() {
  const requestSeq = ++refreshRequestSeq
  try {
    const [stories, resources] = await Promise.all([desktop.stories.list(), desktop.runtime.resources()])
    if (requestSeq !== refreshRequestSeq) return
    state.resources = resources
    state.stories = stories
    window.HDSIViewModel?.notify('app')
    if (!stories.some(story => story.meta.id === state.storyId)) {
      // 审查T10: 当前故事被外部删除时，旧快照/选区不得挂到新故事名下。
      state.storyId = stories[0]?.meta.id || ''
      state.snapshot = null; state.snapshotError = null; state.inspected = null; state.selection = null; lastRenderedSnapshotKey = ''
    }
    byId('resource-state').textContent = `Worker ${resources.runningWorkers}/${resources.maxWorkers}`
    renderStoryList(); renderContext(); renderLogs(); if (state.storyId !== logHydratedFor) void hydrateLogs(); void refreshHostProjection(); void updateStatusBar()
    // §3：readiness 刷新与 surface 解耦——常驻 Studio 也在 TTL 过期后取实态，
    // 状态栏模型项不再永久"检查中"。缓存按故事键控，切故事即为 miss。
    const readinessStory = selectedStory()
    if (readinessStory?.meta.id) syncReadinessForStory(readinessStory.meta.id)
    // 审查T8: 恢复到连接页时 refresh 填充故事后补渲染就绪面板（启动时 setSurface 先于数据到达）。
    if (state.surface === 'connect') void renderReadyPanel()
    if (state.storyId && selectedStory()?.running && selectedStory()?.bridgeReady) void refreshSnapshot()
    refreshFailureCount = 0
  } catch (error) {
    if (requestSeq !== refreshRequestSeq) return
    // 启动竞态/主进程繁忙时此前是 unhandled rejection + 整屏空白——补有限次自动重试。
    refreshFailureCount++
    appendLog({ storyId: 'shell', line: `读取宿主状态失败（第 ${refreshFailureCount} 次）：${error}` })
    if (refreshFailureCount <= 3) {
      showToast('读取宿主状态失败，5 秒后自动重试', 'err')
      setTimeout(() => { void refresh() }, 5_000)
    }
  }
}

async function loadSelected() {
  const story = selectedStory(); if (!story) return
  if (workerAction) return
  const storyId = story.meta.id
  workerAction = { storyId, kind: 'load' }
  if (state.surface === 'connect') void renderConnectView()
  try {
    await desktop.stories.load(storyId)
    needsReloadStoryIds.delete(storyId)
    showToast('Worker 已加载，正在等待 bridge 就绪。', 'ok')
    await refresh()
  } catch (error) {
    reportUserError(storyId, `加载失败：${error}`)
  } finally {
    if (workerAction?.storyId === storyId) workerAction = null
    if (state.surface === 'connect') void renderConnectView()
  }
}

async function reloadSelected() {
  const story = selectedStory(); if (!story) return
  if (workerAction || !story.running || !story.bridgeReady) return
  if (!window.confirm('重载 Worker 会中断当前正在生成的回复和待发投递，但不会删除剧本数据。继续吗？')) return
  const storyId = story.meta.id
  workerAction = { storyId, kind: 'reload' }
  if (state.surface === 'connect') void renderConnectView()
  try {
    await desktop.stories.unload(storyId)
    await desktop.stories.load(storyId)
    needsReloadStoryIds.delete(storyId)
    showToast('Worker 已重载，新配置已生效。', 'ok')
    await refresh()
  } catch (error) {
    reportUserError(storyId, `重载失败：${error}`)
    try { await refresh() } catch { /* 已通过 reportUserError 告知用户 */ }
  } finally {
    if (workerAction?.storyId === storyId) workerAction = null
    if (state.surface === 'connect') void renderConnectView()
  }
}
async function backupSelected() {
  const story = selectedStory(); if (!story) return
  await backupStoryById(story.meta.id)
}

/** 右键菜单等入口按显式 id 备份——不经 selectedStory()，避免作用到错误故事。 */
async function backupStoryById(storyId) {
  if (!storyId) return
  try {
    const result = await desktop.stories.backup(storyId)
    appendLog({ storyId, line: `已创建不含密钥的剧本备份：${result.archive}` })
    if (result.restored === false) {
      showToast('备份已创建，但 Worker 未能恢复，请检查日志后手动加载。', 'err')
    } else if (result.restored === true) {
      showToast('备份已创建，Worker 恢复指令已发出。', 'ok')
    } else {
      showToast('备份已创建（不含密钥）。', 'ok')
    }
    await refresh()
  } catch (error) { reportUserError(storyId, `备份失败：${error}`) }
}

function renderAliases(aliases) { byId('secret-aliases').textContent = aliases?.length ? `已保存别名：${aliases.join(' · ')}` : '尚未保存任何密钥别名。' }
async function openConfig(storyId) {
  if (configSaving) return
  // Allocate the request token before the IPC call. If the user changes
  // stories quickly, an older, slower config response must not replace the
  // newer form (incrementing after await leaves that race open).
  const requestSeq = ++configLoadSeq
  configSectionsReady = false; updateConfigActions()
  try {
    const result = await desktop.stories.config(storyId)
    if (requestSeq !== configLoadSeq) return
    configuredStoryId = storyId
    // P1-4：请求序号守卫——快速切剧本/重开配置时，晚到的旧请求不得覆盖新表单。
    configYamlDirty = false; configSectionsDirty = false
    configDirtyPanels = new Set()
    byId('config-source').value = result.source
    configYamlBaseline = result.source
    byId('config-title').textContent = `剧本配置 · ${storyId}`
    byId('config-status').textContent = ''
    renderAliases(result.aliases)
    const dialog = byId('config-dialog')
    if (!dialog.dataset.dirtyBound) {
      dialog.dataset.dirtyBound = '1'
      // 脏标记按标签页分桶：YAML 与结构化节的保存路径互斥，提示要能说清丢的是哪边
      dialog.addEventListener('input', event => {
        const panel = event.target.closest('[data-config-panel]')
        if (!panel || panel.dataset.configPanel === 'secrets' || panel.dataset.configPanel === 'plugins') return
        if (panel.dataset.configPanel === 'yaml') configYamlDirty = true
        else configSectionsDirty = true
        configDirtyPanels.add(panel.dataset.configPanel)
        configDraftSummary()
      })
      dialog.addEventListener('cancel', event => {
        if (configSaving) { event.preventDefault(); return }
        if ((configYamlDirty || configSectionsDirty) && !window.confirm('配置有未保存的修改，确定丢弃？')) event.preventDefault()
      })
      dialog.addEventListener('close', () => { configYamlDirty = false; configSectionsDirty = false; configDirtyPanels = new Set(); const badge = byId('config-dirty-badge'); if (badge) badge.hidden = true })
    }
    // 三方审查P2: 加载未完成前禁用保存——窗口期 rows=[] 会把四个配置节整体写空。
    const saveBtn = byId('config-save')
    const saveAllBtn = byId('config-save-all')
    if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = '加载中…' }
    if (saveAllBtn) saveAllBtn.disabled = true
    let sectionsLoaded = false
    void renderPluginsPanel(storyId, requestSeq)
    void loadConfigSections(storyId).then(ok => { sectionsLoaded = ok }).finally(() => {
      if (requestSeq !== configLoadSeq) return  // 旧请求晚到：不恢复按钮（新请求接管）、不写基线
      configSectionsReady = sectionsLoaded
      if (byId('config-dialog').open && configuredStoryId === storyId) {
        if (sectionsLoaded) {
          if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = '保存当前分区' }
          if (saveAllBtn) saveAllBtn.disabled = false
          try { configSectionsBaseline = JSON.stringify(serializeConfigSections()) } catch { configSectionsBaseline = '' }
        } else {
          // 审计：加载失败时列表里仍是上一个故事的卡片——清空并保持保存禁用，
          // 否则"保存"会把故事 A 的 userAccounts/groupChats/botAccounts/providers
          // 整段写进故事 B。"保存全部"同样要禁用：结构化脏标记叠加空列表
          // 会把清空后的节整段写回。
          for (const listId of ['cfg-users-list', 'cfg-groups-list', 'cfg-bots-list', 'cfg-providers-list']) { const list = byId(listId); if (list) list.innerHTML = '' }
          if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = '加载失败 · 关闭后重试' }
          if (saveAllBtn) saveAllBtn.disabled = true
        }
      } else {
        if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = '保存当前分区' }
        if (saveAllBtn) saveAllBtn.disabled = false
      }
      configDraftSummary()
    })
    configDraftSummary()
    byId('config-dialog').showModal()
    // 绑定按钮（每次打开时确保生效）
    bindConfigDialogButtons()
  } catch (error) {
    reportUserError(storyId, `无法读取配置：${error}`)
    // 入口已把 configSectionsReady 置 false（面板 inert）；配置读取失败若不收尾，
    // 对话框停留在"上一个故事的卡片可见但整面板不可编辑"的死锁态。按节加载
    // 失败同款清理：清空列表 + 保持保存禁用（防把旧故事数据写进新故事）。
    if (requestSeq === configLoadSeq) {
      for (const listId of ['cfg-users-list', 'cfg-groups-list', 'cfg-bots-list', 'cfg-providers-list']) { const list = byId(listId); if (list) list.innerHTML = '' }
      const statusFail = byId('config-status')
      if (statusFail) statusFail.textContent = `配置加载失败：${error}`
      configDraftSummary()
    }
  }
}

// B01-B05: 打开当前故事的配置窗并切到指定标签。
// openConfig() 需要故事 ID，不是标签名——此处封装"选故事 → 开配置 → 切标签"完整链路。

// V4：Overview 是 HUD + 三轨预览，不再改写 Timeline 的工作视窗；
// 用户从预览块进入 Timeline 时才以事件时间定位。
function applyViewViewport(view) {
  if (view === 'timeline') updateKnobFromViewport()
}

// B06/B07/B22: 切换 browserView 并回到 Studio 表面。
// browserView 是 Studio 内部子视图，必须在 studio 表面上才能渲染。
// HUD / Timeline 直接切换：V7 不再对共享轨道做形变、淡入或延迟显示。
// 保留这层清理是为了兼容热更新/旧会话中可能遗留的 V4.3 morph 样式。
function clearStudioViewTransitionState(view) {
  // 死代码清理：V4.2/V4.3 形变工作室的 morph 类清扫与内联样式复位已移除
  // （没有代码再添加那些类/样式）；保留的是活核——视图属性切换与 aria 状态。
  const viewport = byId('studio-mode-viewport')
  if (viewport) {
    viewport.dataset.studioView = view || state.browserView
    viewport.setAttribute('aria-busy', 'false')
  }
  byId('story-hud')?.setAttribute('aria-hidden', String((view || state.browserView) !== 'overview'))
  byId('arrangement')?.setAttribute('aria-hidden', 'false')
}

function setStudioView(view, options = {}) {
  const previous = state.browserView
  if (state.surface !== 'studio') setSurface('studio')

  // Always clear any stale morph state before changing the data attribute. The
  // layout CSS is intentionally transition-free, so this update is immediate.
  clearStudioViewTransitionState(view)
  if (!options.force && previous === view) {
    renderContext()
    return Promise.resolve()
  }

  state.browserView = view
  persist()
  lastRenderedSnapshotKey = ''
  applyViewViewport(view)
  clearStudioViewTransitionState(view)
  renderContext()
  void runThemeInteraction('hudTimeline', 'switch', byId('studio-mode-viewport'))
  if (view === 'mixer') void runThemeInteraction('mixer', 'enter', byId('studio-mode-viewport'))
  return Promise.resolve()
}

function focusTimelineAt(ms, options = {}) {
  const target = Number(ms)
  const ready = Number.isFinite(target) ? setStudioView('timeline', { focusMs: target }) : setStudioView('timeline')
  return Promise.resolve(ready).then(() => {
    if (!Number.isFinite(target)) return
    updateViewport(viewport => ({ center: target, followNow: false, spanMinutes: options.spanMinutes ?? viewport.spanMinutes / 60000 }))
    renderArrangement()
  })
}

function openConfigTab(tab) {
  const story = selectedStory()
  if (!story) { showToast('请先选择一个剧本。','err'); return }
  void openConfig(story.meta.id).then(() => {
    const btn = document.querySelector(`[data-config-tab="${tab}"]`)
    if (btn) btn.click()
  })
}

// 二轮#2(B01): OneBot 连接参数（机器人账号、外部 WS 地址、token 别名）
// 在侧栏 ONEBOT ACCOUNT 面板配置。这里负责导航过去并高亮。
async function openAccountPanel() {
  const story = selectedStory()
  if (!story) { showToast('请先选择一个剧本。','err'); return }
  // C 阶段：channel 修复主入口改为连接页（向导含检测/测试/绑定全流程）。
  if (state.surface !== 'connect') setSurface('connect')
  else void renderConnectView()
  // 高亮导航目标（此前引用未声明的 panel → 回调 ReferenceError，高亮从未生效）。
  // 渲染是异步重建的，延迟到下一拍再定位 connect-main。
  setTimeout(() => {
    const target = byId('connect-main')
    if (!target) return
    target.classList.remove('flash-highlight')
    // 强制 reflow，使重入同一元素时动画能再次触发。
    void target.offsetWidth
    target.classList.add('flash-highlight')
    setTimeout(() => target.classList.remove('flash-highlight'), 1800)
  }, 60)
}

var configSectionData = {}
async function loadConfigSections(storyId) {
  const seq = configLoadSeq
  try {
    const [story, users, groups, bots, providers] = await Promise.all([
      desktop.stories.configSection(storyId, 'storyDefaults'),
      desktop.stories.configSection(storyId, 'userAccounts'),
      desktop.stories.configSection(storyId, 'groupChats'),
      desktop.stories.configSection(storyId, 'botAccounts'),
      desktop.stories.configSection(storyId, 'providers'),
    ])
    if (seq !== configLoadSeq || configuredStoryId !== storyId) return  // P1-4：晚到的旧请求丢弃
    configSectionData = { storyDefaults: story, userAccounts: users, groupChats: groups, botAccounts: bots, providers }
    renderStoryDefaultsForm(story)
    renderAccountsList('cfg-users-list', users, 'userAccounts')
    renderAccountsList('cfg-groups-list', groups, 'groupChats')
    renderAccountsList('cfg-bots-list', bots, 'botAccounts')
    renderAccountsList('cfg-providers-list', providers, 'providers')
    return true
  } catch (error) {
    appendLog({ storyId, line: `[config] 配置节加载失败：${error}` })
    return false
  }
}

function renderStoryDefaultsForm(data) {
  const panel = document.querySelector('[data-config-panel="story"]')
  if (!panel) return
  for (const el of panel.querySelectorAll('[data-cfg]')) {
    // data-cfg-array：数组字段以"每行一条"呈现（perspectives/supplementaryFacts）。
    if (el.dataset.cfgArray !== undefined) el.value = Array.isArray(data?.[el.dataset.cfg]) ? data[el.dataset.cfg].join('\n') : ''
    else el.value = String(data?.[el.dataset.cfg] ?? '')
  }
}

// ── 第三方 Koishi 插件面板（Phase 1）：即时写回（不经草稿/保存全部）──
// 启停 = 实例键 ~ 前缀（Koishi loader 官方约定，配置保留）；配置 = YAML 片段
// 原文（敏感字段须 $secret:别名）；安装探测 = desktop 运行时解析（官方域优先）。
async function renderPluginsPanel(storyId, seq) {
  const list = byId('cfg-plugins-list')
  if (!list) return
  let data
  try { data = await desktop.stories.plugins(storyId) }
  catch (error) {
    if (seq === undefined || seq === configLoadSeq) list.innerHTML = '<p class="muted">插件清单读取失败：' + escapeHtml(String(error)) + '</p>'
    return
  }
  if (seq !== undefined && seq !== configLoadSeq) return
  const entries = Array.isArray(data?.entries) ? data.entries : []
  const warnings = Array.isArray(data?.warnings) ? data.warnings : []
  if (!entries.length) {
    list.innerHTML = (warnings.map(w => '<p class="muted">' + escapeHtml(w) + '</p>').join('')) || '<p class="muted">plugins 段为空。</p>'
    return
  }
  const groups = new Map()
  for (const entry of entries) {
    const label = entry.group ?? ''
    if (!groups.has(label)) groups.set(label, [])
    groups.get(label).push(entry)
  }
  const installBadge = entry => entry.installed
    ? '<span class="chip ok">v' + escapeHtml(String(entry.installed)) + '</span><button type="button" class="plugin-update-btn" title="安装该插件的最新版本">更新</button><button type="button" class="plugin-uninstall-btn" title="从 typ0 插件运行时目录卸载">卸载</button>'
    : '<span class="chip err">未安装</span><button type="button" class="plugin-install-btn" title="从 npmmirror 安装到 typ0 插件运行时目录">安装</button><button type="button" class="plugin-install-copy" title="复制手动安装命令">复制命令</button>'
  const riskBadge = entry => entry.risk === 'high' ? '<span class="chip warn">⚠ 与 HDSI 冲突高风险</span>' : ''
  const officialBadge = entry => entry.official ? '<span class="chip">官方</span>' : ''
  const cardHtml = entry => `
    <div class="cfg-card" data-raw-key="${escapeHtml(entry.rawKey)}">
      <div class="cfg-card-header">
        <button type="button" class="cfg-toggle-mini ${entry.enabled ? 'on' : ''}" data-plugin-toggle role="switch" aria-checked="${Boolean(entry.enabled)}" aria-label="启用插件 ${escapeHtml(entry.packageName)}" title="${entry.enabled ? '立即停用，配置保留' : '立即启用'}">启用插件</button>
        <b>${escapeHtml(entry.packageName)}</b>
        <small class="muted">${escapeHtml(entry.key)}</small>
        ${installBadge(entry)}${officialBadge(entry)}${riskBadge(entry)}
        <button type="button" class="cfg-expand-toggle">▸ 配置</button>
        <button type="button" class="cfg-del">删</button>
      </div>
      <div class="cfg-expand">
        <label>插件配置 YAML<textarea class="plugin-config-editor" rows="6" spellcheck="false">${escapeHtml(entry.configText || '')}</textarea></label>
        <p class="muted">YAML 原文（缩进须深于键行，建议 4 空格起步）；敏感字段（apiKey/token 等）请用 $secret:别名，密钥先录入密钥库。留空保存 = 清空配置。</p>
        <button type="button" class="plugin-config-save">立即保存插件配置</button>
      </div>
    </div>`
  let html = ''
  for (const [label, groupEntries] of groups) {
    if (label) html += `<div class="cfg-section-title">分组：${escapeHtml(label)}</div>`
    html += groupEntries.map(cardHtml).join('')
  }
  list.innerHTML = html + (warnings.length ? warnings.map(w => '<p class="muted">' + escapeHtml(w) + '</p>').join('') : '')

  // 即时动作统一收口：成功后标 needsReload 并刷新面板。
  const act = async (fn, note) => {
    try {
      const result = await fn()
      if (result?.needsReload) needsReloadStoryIds.add(storyId)
      appendLog({ storyId, line: '[plugins] ' + note + '（' + (result?.needsReload ? '需重载生效' : 'worker 未加载，下次加载生效') + '）' })
      void renderPluginsPanel(storyId)
    } catch (error) { showToast('插件操作失败：' + String(error), 'error') }
  }
  for (const card of list.querySelectorAll('.cfg-card')) {
    const rawKey = card.dataset.rawKey || ''
    const entry = entries.find(item => item.rawKey === rawKey)
    card.querySelector('.cfg-toggle-mini')?.addEventListener('click', async () => {
      const toggleEl = card.querySelector('.cfg-toggle-mini')
      const enable = !toggleEl.classList.contains('on')
      if (enable && entry?.risk === 'high' && !window.confirm('「' + entry.packageName + '」是适配器/数据库类插件，会与 HDSI 的 OneBot 桥接或 SQLite 存储正面冲突（selfId 争抢/事件流/多驱动约束），很可能导致 worker 启动失败或消息异常。' + '\n' + '确定要启用吗？')) return
      await act(() => desktop.stories.pluginToggle(storyId, rawKey, enable), (enable ? '启用' : '停用') + '插件 ' + rawKey)
    })
    card.querySelector('.plugin-config-save')?.addEventListener('click', async () => {
      await act(() => desktop.stories.pluginConfig(storyId, rawKey, card.querySelector('.plugin-config-editor').value), '更新插件配置 ' + rawKey)
    })
    card.querySelector('.plugin-install-copy')?.addEventListener('click', event => {
      const name = entry?.packageName || ''
      const pkg = entry?.official ? '@koishijs/plugin-' + name : 'koishi-plugin-' + name
      const command = 'npm install ' + pkg + ' --save --legacy-peer-deps --ignore-scripts'
      void navigator.clipboard?.writeText(command).then(() => { event.target.textContent = '已复制'; showToast('已复制：' + command) }, () => showToast(command))
    })
    // Phase 2：受控安装（npmmirror / --ignore-scripts / --legacy-peer-deps）。
    // 未安装的插件先试社区包名，失败且无 scope 再试官方 @koishijs 域。
    card.querySelector('.plugin-install-btn')?.addEventListener('click', async event => {
      const btn = event.currentTarget
      const name = entry?.packageName || ''
      if (!name) return
      if (!window.confirm('安装「' + (name.startsWith('@') ? name : 'koishi-plugin-' + name) + '」到 typ0 插件运行时目录？' + '\n' + '来源 registry.npmmirror.com；--ignore-scripts（不执行第三方安装脚本，原生依赖类插件不可用）；--legacy-peer-deps（不复制 koishi，宿主同实例）。安装进度见日志。')) return
      btn.disabled = true; btn.textContent = '安装中…'
      try {
        try { await desktop.stories.pluginInstall(name.startsWith('@') ? name : 'koishi-plugin-' + name) }
        catch (firstError) {
          if (name.startsWith('@')) throw firstError
          try { await desktop.stories.pluginInstall('@koishijs/plugin-' + name) }
          catch { throw firstError }
        }
        showToast('已安装 ' + name + '，可启用插件并重载 worker', 'success')
        void renderPluginsPanel(storyId)
      } catch (error) { showToast('安装失败：' + String(error), 'error'); btn.disabled = false; btn.textContent = '安装' }
    })
    card.querySelector('.plugin-update-btn')?.addEventListener('click', async event => {
      const btn = event.currentTarget
      const name = entry?.packageName || ''
      if (!name) return
      btn.disabled = true; btn.textContent = '更新中…'
      try {
        const pkg = entry?.official ? '@koishijs/plugin-' + name : 'koishi-plugin-' + name
        const result = await desktop.stories.pluginUpdate(pkg)
        showToast('已更新 ' + name + '（v' + (result?.version ?? '?') + '）', 'success')
        void renderPluginsPanel(storyId)
      } catch (error) { showToast('更新失败：' + String(error), 'error'); btn.disabled = false; btn.textContent = '更新' }
    })
    card.querySelector('.plugin-uninstall-btn')?.addEventListener('click', async event => {
      const btn = event.currentTarget
      const name = entry?.packageName || ''
      if (!name) return
      if (btn.dataset.arm === '1') {
        btn.disabled = true; btn.textContent = '卸载中…'
        try {
          const pkg = entry?.official ? '@koishijs/plugin-' + name : 'koishi-plugin-' + name
          await desktop.stories.pluginUninstall(pkg)
          showToast('已卸载 ' + name, 'success')
          void renderPluginsPanel(storyId)
        } catch (error) { showToast('卸载失败：' + String(error), 'error'); btn.disabled = false; btn.textContent = '卸载' }
      } else { btn.dataset.arm = '1'; btn.textContent = '确认卸载?'; setTimeout(() => { btn.dataset.arm = ''; btn.textContent = '卸载' }, 2500) }
    })
    card.querySelector('.cfg-del')?.addEventListener('click', event => {
      const btn = event.currentTarget
      if (btn.dataset.arm === '1') { void act(() => desktop.stories.pluginRemove(storyId, rawKey), '移除插件 ' + rawKey) }
      else { btn.dataset.arm = '1'; btn.textContent = '确认删?'; setTimeout(() => { btn.dataset.arm = ''; btn.textContent = '删' }, 2500) }
    })
    card.querySelector('.cfg-expand-toggle')?.addEventListener('click', () => {
      card.classList.toggle('expanded')
      const btn = card.querySelector('.cfg-expand-toggle')
      if (btn) btn.textContent = card.classList.contains('expanded') ? '▾ 收起' : '▸ 配置'
    })
  }
}

/** providers 卡就地重渲前的取值：与 serializeConfigSections 同规则，
 *  保留用户已填值与未触碰字段的已加载值（切换模式/协议不丢草稿）。 */
function providerRowFromCard(card) {
  const row = { ...(card.__loadedRow || {}) }
  for (const el of card.querySelectorAll('[data-row]')) {
    const key = el.dataset.row
    if (key === 'enabled') row[key] = el.classList.contains('on')
    else if (el.type === 'number') { const raw = el.value.trim(); if (raw === '') delete row[key]; else { const parsed = Number(raw); row[key] = Number.isFinite(parsed) ? parsed : row[key] } }
    else if (el.type === 'checkbox') row[key] = el.checked
    else row[key] = el.value
  }
  return row
}

function buildAccountCard(card, row, type) {
  card.__loadedRow = row   // 三方审查P2: 保存时直接展开卡片引用，替代索引回查（修 T22 引入的错位）
  const enabled = row.enabled !== false
  const val = k => escapeHtml(String(row[k] ?? ''))
  // 审计修复：数值字段同样必须转义（恶意归档可注入 onfocus= 载荷）。
  const num = (v, d) => escapeHtml(String(v ?? d))

    if (type === 'userAccounts') {
      card.innerHTML = `<div class="cfg-card-header">
        <input data-row="qq" value="${val('qq')}" placeholder="QQ号" style="width:100px">
        <input data-row="label" value="${val('label')}" placeholder="称呼" style="width:80px">
        <input data-row="personId" value="${val('personId')}" placeholder="人物ID" style="width:80px">
        <div class="cfg-toggle-mini ${enabled ? 'on' : ''}" data-row="enabled"></div>
        <button type="button" class="cfg-expand-toggle">▸ 详细</button>
        <button type="button" class="cfg-del">删</button>
      </div>
      <div class="cfg-expand">
        <label class="cfg-tall">用户资料（覆盖默认）<textarea data-row="profile" rows="3">${val('profile')}</textarea></label>
        <label class="cfg-tall">与主角关系（覆盖默认）<textarea data-row="relationship" rows="3">${val('relationship')}</textarea></label>
      </div>`
    } else if (type === 'groupChats') {
      card.innerHTML = `<div class="cfg-card-header">
        <input data-row="groupId" value="${val('groupId')}" placeholder="群号" style="width:100px">
        <input data-row="label" value="${val('label')}" placeholder="群名称" style="width:80px">
        <select data-row="responseMode" style="width:100px">
          <option value="mention-only" ${row.responseMode !== 'always' ? 'selected' : ''}>仅@时</option>
          <option value="always" ${row.responseMode === 'always' ? 'selected' : ''}>始终</option>
        </select>
        <input data-row="contextLimit" value="${num(row.contextLimit, 20)}" placeholder="上下文" style="width:50px" type="number" min="4" max="100">
        <input data-row="cooldownSeconds" value="${num(row.cooldownSeconds, 60)}" placeholder="冷却s" style="width:50px" type="number" min="0">
        <div class="cfg-toggle-mini ${enabled ? 'on' : ''}" data-row="enabled"></div>
        <button type="button" class="cfg-expand-toggle">▸ 详细</button>
        <button type="button" class="cfg-del">删</button>
      </div>
      <div class="cfg-expand">
        <label class="cfg-tall">群用途<textarea data-row="purpose" rows="2">${val('purpose')}</textarea></label>
        <label class="cfg-tall">主角群内角色<textarea data-row="characterRole" rows="2">${val('characterRole')}</textarea></label>
        <label class="cfg-short">受理机器人QQ<input data-row="assignee" value="${val('assignee')}" placeholder="留空=原生路由"></label>
        <label class="cfg-short">合并等待(s)<input data-row="debounceSeconds" value="${num(row.debounceSeconds, 1)}" type="number" min="0" max="10" step="0.5"></label>
        <label class="cfg-short">历史图上限<input data-row="historicalImageLimit" value="${num(row.historicalImageLimit, 3)}" type="number" min="0" max="6"></label>
        <label class="cfg-short">意愿档位<select data-row="willingnessPreset">
          <option value="off" ${row.willingnessPreset !== 'custom' && !['quiet','reserved','normal','active','eager','auto'].includes(row.willingnessPreset) ? 'selected' : ''}>关闭（默认）</option>
          <option value="quiet" ${row.willingnessPreset === 'quiet' ? 'selected' : ''}>极少</option>
          <option value="reserved" ${row.willingnessPreset === 'reserved' ? 'selected' : ''}>谨慎</option>
          <option value="normal" ${row.willingnessPreset === 'normal' ? 'selected' : ''}>标准</option>
          <option value="active" ${row.willingnessPreset === 'active' ? 'selected' : ''}>活跃</option>
          <option value="eager" ${row.willingnessPreset === 'eager' ? 'selected' : ''}>热情</option>
          <option value="auto" ${row.willingnessPreset === 'auto' ? 'selected' : ''}>按生活状态自动</option>
          <option value="custom" ${row.willingnessPreset === 'custom' ? 'selected' : ''}>自定义数值（下方）</option>
        </select></label>
        <div class="cfg-willingness"><div class="config-grid">
          <label class="cfg-short">意愿门槛<input data-w="threshold" value="${num(row.willingness?.threshold, 0.24)}" type="number" step="0.01"></label>
          <label class="cfg-short">最大分<input data-w="maxScore" value="${num(row.willingness?.maxScore, 1)}" type="number" step="0.05"></label>
          <label class="cfg-short">半衰(s)<input data-w="decayHalfLifeSeconds" value="${num(row.willingness?.decayHalfLifeSeconds, 180)}" type="number"></label>
          <label class="cfg-short">放大<input data-w="probabilityAmplifier" value="${num(row.willingness?.probabilityAmplifier, 1.3)}" type="number" step="0.05"></label>
        </div><small class="muted">数值仅在"意愿档位=自定义"时生效；回复扣分/关键词等其余子字段在 Koishi Console 调整，此处保存不会覆盖。</small></div>
      </div>`
    } else if (type === 'botAccounts') {
      card.innerHTML = `<div class="cfg-card-header">
        <input data-row="qq" value="${val('qq')}" placeholder="机器人QQ号" style="width:120px">
        <input data-row="label" value="${val('label')}" placeholder="备注" style="width:100px">
        <div class="cfg-toggle-mini ${enabled ? 'on' : ''}" data-row="enabled"></div>
        <button type="button" class="cfg-del">删</button>
      </div>`
    } else if (type === 'providers') {
      // 与 HDSI Console 的 Provider schema 同构（src/index.ts ProviderIdentity/
      // union/Assignments）：身份 → 随模式的连接参数 → 用途/价格。endpoint 与
      // protocol 仅存在于 openai-compatible；官方预设自动使用官方端点。
      const modes = ['openai-compatible','zhipu-official','openai-official','deepseek-official','moonshot-official','dashscope-official','siliconflow-official','openrouter','gemini-openai','gemini-interactions']
      const compat = !row.mode || row.mode === 'openai-compatible'
      const protocol = row.protocol === 'anthropic-messages' ? 'anthropic-messages' : 'chat-completions'
      const dsThinking = type === 'providers' && row.mode === 'deepseek-official'
        ? (row.deepseekThinking === 'enabled' ? 'enabled' : 'disabled')
        : (['inherit','disabled','enabled'].includes(row.deepseekThinking) ? row.deepseekThinking : 'inherit')
      const effort = ['low','high','max'].includes(row.deepseekReasoningEffort) ? row.deepseekReasoningEffort : 'low'
      const sel = (current, options) => options.map(([value, label]) => `<option value="${value}" ${current === value ? 'selected' : ''}>${label}</option>`).join('')
      // 随模式的连接参数（Console 各 union 成员的字段）
      const modeFields = compat ? `
        <label class="cfg-short">请求协议<select data-row="protocol">${sel(protocol, [['chat-completions','Chat Completions（OpenAI 格式）'], ['anthropic-messages','Anthropic Messages']])}</select></label>
        <label class="cfg-short">API 端点<input data-row="endpoint" value="${val('endpoint')}" placeholder="https://host/v1/chat/completions"></label>
        ${protocol === 'anthropic-messages' ? `<label style="font-size:9px;color:#727272"><input data-row="anthropicCache" type="checkbox" ${row.anthropicCache ? 'checked' : ''}> Anthropic 前缀缓存标记</label>` : ''}
        <label class="cfg-short">DeepSeek 思考<select data-row="deepseekThinking">${sel(dsThinking, [['inherit','inherit（不主动发送）'], ['disabled','disabled（强制关闭）'], ['enabled','enabled（强制开启）']])}</select></label>
        ${dsThinking === 'enabled' ? `<label class="cfg-short">思考强度<select data-row="deepseekReasoningEffort">${sel(effort, [['low','low'], ['high','high'], ['max','max']])}</select></label>` : ''}
        <label class="cfg-tall">额外请求头 JSON<textarea data-row="extraHeaders" rows="2" placeholder='{"X-Title":"HDSI"}（可留空）'>${val('extraHeaders')}</textarea></label>
        <label class="cfg-tall">额外请求体 JSON<textarea data-row="extraBody" rows="2" placeholder='{"temperature":0.5}（可留空）'>${val('extraBody')}</textarea></label>`
        : row.mode === 'zhipu-official' ? `
        <label class="cfg-short">推理强度<select data-row="reasoningEffort">${sel(['low','high','max'].includes(row.reasoningEffort) ? row.reasoningEffort : 'high', [['low','low'], ['high','high（默认）'], ['max','max']])}</select></label>`
        : row.mode === 'deepseek-official' ? `
        <label class="cfg-short">思考模式<select data-row="deepseekThinking">${sel(dsThinking, [['disabled','关闭（更快，适合结构化叙事）'], ['enabled','开启']])}</select></label>
        ${dsThinking === 'enabled' ? `<label class="cfg-short">思考强度<select data-row="deepseekReasoningEffort">${sel(effort, [['low','low'], ['high','high'], ['max','max']])}</select></label>` : ''}`
        : row.mode === 'dashscope-official' ? `
        <label class="cfg-short">百炼地域<select data-row="dashscopeRegion">${sel(['beijing','singapore','us'].includes(row.dashscopeRegion) ? row.dashscopeRegion : 'beijing', [['beijing','北京（默认）'], ['singapore','新加坡'], ['us','美国']])}</select></label>`
        : ''
      card.innerHTML = `<div class="cfg-card-header">
        <input data-row="label" value="${val('label') || val('id')}" placeholder="连接名称" style="width:90px">
        <select data-row="mode" style="width:130px">${modes.map(m => `<option value="${m}" ${row.mode === m ? 'selected' : ''}>${m}</option>`).join('')}</select>
        <input data-row="model" value="${val('model')}" placeholder="模型" style="width:120px">
        ${compat ? `<input data-row="endpoint" value="${val('endpoint')}" placeholder="端点" style="width:140px">` : ''}
        <div class="cfg-toggle-mini ${enabled ? 'on' : ''}" data-row="enabled"></div>
        <button type="button" class="cfg-expand-toggle">▸ 详细</button>
        <button type="button" class="cfg-del">删</button>
      </div>
      <div class="cfg-expand">
        <label class="cfg-short">API Key（$secret:别名）<input data-row="apiKey" value="${val('apiKey')}" style="width:200px"></label>
        ${modeFields}
        <label class="cfg-short">代理（可选）<input data-row="proxyAgent" value="${val('proxyAgent')}" placeholder="http://127.0.0.1:7890" style="width:180px"></label>
        <div class="config-grid">
          <label class="cfg-short">温度<input data-row="temperature" value="${num(row.temperature, 0.8)}" type="number" step="0.05"></label>
          <label class="cfg-short">Top P<input data-row="topP" value="${num(row.topP, 1)}" type="number" step="0.05"></label>
          <label class="cfg-short">Max Tokens<input data-row="maxTokens" value="${num(row.maxTokens, 4096)}" type="number"></label>
          <label class="cfg-short">超时(ms)<input data-row="timeout" value="${num(row.timeout, 60000)}" type="number"></label>
        </div>
        <div class="config-grid" style="grid-template-columns:repeat(7,1fr)">
          <label style="font-size:9px;color:#727272"><input data-row="useForMain" type="checkbox" ${row.useForMain !== false ? 'checked' : ''}> 主叙事</label>
          <label style="font-size:9px;color:#727272"><input data-row="useForCompaction" type="checkbox" ${row.useForCompaction ? 'checked' : ''}> 压缩</label>
          <label style="font-size:9px;color:#727272"><input data-row="useForAlter" type="checkbox" ${row.useForAlter ? 'checked' : ''}> Alter</label>
          <label style="font-size:9px;color:#727272"><input data-row="useForStickers" type="checkbox" ${row.useForStickers ? 'checked' : ''}> 贴图</label>
          <label style="font-size:9px;color:#727272"><input data-row="useForEmbedding" type="checkbox" ${row.useForEmbedding ? 'checked' : ''}> Embed</label>
          <label style="font-size:9px;color:#727272"><input data-row="useForVision" type="checkbox" ${row.useForVision ? 'checked' : ''}> 识图</label>
          <label style="font-size:9px;color:#727272"><input data-row="useForWorldSeeding" type="checkbox" ${row.useForWorldSeeding ? 'checked' : ''}> 播种</label>
        </div>
        <div class="config-grid" style="grid-template-columns:repeat(3,1fr)">
          <label class="cfg-short">输入价($/M)<input data-row="priceInput" value="${num(row.priceInput, 0)}" type="number" step="0.1"></label>
          <label class="cfg-short">输出价($/M)<input data-row="priceOutput" value="${num(row.priceOutput, 0)}" type="number" step="0.1"></label>
          <label class="cfg-short">缓存价($/M)<input data-row="priceCachedInput" value="${num(row.priceCachedInput, 0)}" type="number" step="0.1"></label>
        </div>
      </div>`
    }

  organizeConfigCard(card, type)
  card.querySelector('.cfg-expand-toggle')?.addEventListener('click', () => {
    card.classList.toggle('expanded')
    const btn = card.querySelector('.cfg-expand-toggle')
    if (btn) { btn.textContent = card.classList.contains('expanded') ? '收起详细设置' : '展开详细设置'; btn.setAttribute('aria-expanded', String(card.classList.contains('expanded'))) }
  })
  card.querySelector('.cfg-toggle-mini')?.addEventListener('click', e => { const toggle=e.currentTarget;toggle.classList.toggle('on');toggle.setAttribute('aria-checked',String(toggle.classList.contains('on')));markConfigPanelDirty(card) })
  card.querySelector('.cfg-del')?.addEventListener('click', event => {
    // 两段式删除：首击武装为"确认删?"，2.5 秒内再击才真删（此前一点就没）
    const btn = event.currentTarget
    if (btn.dataset.arm === '1') { const panelHost = card.closest('[data-config-panel]'); card.remove(); markConfigPanelDirty(panelHost ? { closest: () => panelHost } : card) }
    else {
      btn.dataset.arm = '1'; btn.textContent = '确认删?'
      setTimeout(() => { if (btn.isConnected) { btn.dataset.arm = ''; btn.textContent = '删' } }, 2_500)
    }
  })
  // providers：模式/协议/思考档切换 → 保留已填值就地重渲（连接参数随模式变化，
  // 端点仅 openai-compatible 存在——官方预设自动使用官方端点）。
  if (type === 'providers') {
    const rerender = focusKey => {
      const current = providerRowFromCard(card)
      buildAccountCard(card, current, type)
      markConfigPanelDirty(card)
      card.querySelector(`[data-row="${focusKey}"]`)?.focus()
    }
    card.querySelector('select[data-row="mode"]')?.addEventListener('change', () => rerender('mode'))
    card.querySelector('select[data-row="protocol"]')?.addEventListener('change', () => rerender('protocol'))
    card.querySelector('select[data-row="deepseekThinking"]')?.addEventListener('change', () => rerender('deepseekThinking'))
  }
}

function renderAccountsList(containerId, rows, type, prependOnly = false) {
  const container = byId(containerId)
  if (!container) return
  // B24: 只在前面追加新行，不清空已有内容——保留用户已编辑的行。
  if (prependOnly) {
    if (!Array.isArray(rows) || !rows.length) return
    for (const row of rows) {
      const card = document.createElement('div')
      card.className = 'cfg-card'
      buildAccountCard(card, row, type)
      container.prepend(card)
    }
    return
  }
  container.replaceChildren()
  if (!Array.isArray(rows) || !rows.length) {
    renderUiState(container,{title:'尚未添加条目',body:'使用上方添加按钮建立条目；修改会先保留在草稿中。'})
    return
  }
  rows.forEach(row => {
    const card = document.createElement('div')
    card.className = 'cfg-card'
    buildAccountCard(card, row, type)
    container.appendChild(card)
  })
}

async function saveConfigSections(storyId) {
  const pending = [...configDirtyPanels].filter(id => CONFIG_PANEL_SECTIONS[id])
  for (const panel of pending) await saveConfigSection(storyId, CONFIG_PANEL_SECTIONS[panel])
}
function openCreate() { openWizard() }

/** §5：单节写——只提交当前标签页对应的配置节。全量写会把其它标签页的
 *  未保存草稿一并提交（改一次人设就可能触发群聊配置回写）。 */
async function saveConfigSection(storyId, section) {
  const status = byId('config-status')
  const panelId = Object.keys(CONFIG_PANEL_SECTIONS).find(key => CONFIG_PANEL_SECTIONS[key] === section)
  const label = CONFIG_PANEL_LABELS[panelId] ?? section
  try {
    const payload = serializeConfigSections()[section] ?? null
    const result = await desktop.stories.configSection(storyId, section, payload)
    if (result?.needsReload) needsReloadStoryIds.add(storyId)
    else needsReloadStoryIds.delete(storyId)
    if (panelId) configDirtyPanels.delete(panelId)
    configSectionsDirty = [...configDirtyPanels].some(id => id !== 'yaml')
    configDraftSummary()
    // 复审：基线按节更新——整体重建会把其它标签页尚未保存的草稿一并烤进
    // 基线，"预览变更"随即误报"没有未保存的修改"。写入的 payload 即宿主现状
    // （configSection 是整节替换），直接作为该节的新基线。
    try {
      const baseline = JSON.parse(configSectionsBaseline || '{}')
      baseline[section] = payload
      configSectionsBaseline = JSON.stringify(baseline)
    } catch { configSectionsBaseline = JSON.stringify(serializeConfigSections()) }
    if (status) status.textContent = result?.needsReload
      ? `「${label}」已保存；Worker 仍使用旧配置，请到连接页确认“重载 Worker”。`
      : `「${label}」已保存；下次加载 Worker 时生效。`
    if (state.surface === 'connect' && state.storyId === storyId) void renderConnectView()
  } catch (error) {
    if (status) status.textContent = `保存失败：${error}`
    throw error
  }
}

document.querySelectorAll('[data-surface]').forEach(button => button.addEventListener('click', () => setSurface(button.dataset.surface)))
document.querySelectorAll('[data-detail]').forEach(button => button.addEventListener('click', () => setDetail(button.dataset.detail)))
// V3 §22.4：运行状态切换经 Action Registry（story.setPhase），未来声明式页面/沙箱包同一入口
document.querySelectorAll('[data-phase]').forEach(button => button.addEventListener('click', () => window.HDSIActions?.dispatch('story.setPhase', button.dataset.phase)))
document.querySelectorAll('[data-browser-view]').forEach(button => button.addEventListener('click', () => {
  const view = button.dataset.browserView
  if (view === 'settings' && state.storyId) { state.browserView = view; persist(); if (state.surface !== 'studio') setSurface('studio'); openConfig(state.storyId); return }
  void setStudioView(view)
}))
document.querySelectorAll('[data-studio-mode]').forEach(button => button.addEventListener('click', () => void setStudioView(button.dataset.studioMode)))
document.querySelectorAll('[data-track-toggle]').forEach(button => button.addEventListener('click', () => {
  const layout = layoutFor(); const key = button.dataset.trackToggle
  layout.tracks[key] = !layout.tracks[key]
  persist(); renderTrackMenu(); renderArrangement()
}))
document.querySelectorAll('[data-view-mode]').forEach(button => button.addEventListener('click', () => applyViewMode(button.dataset.viewMode)))
document.querySelectorAll('[data-panel], [data-panel-toggle]').forEach(button => button.addEventListener('click', () => {
  togglePanel(button.dataset.panel || button.dataset.panelToggle)
  // 下拉菜单里的面板开关：点击后收起菜单本体（原生 details 不会自己关）
  button.closest('details.layout-menu')?.removeAttribute('open')
}))
// Layout / More 下拉：原生 details 允许多个菜单同时展开；这样会互相遮挡，
// 看起来就像菜单项无法点击。保持同一时刻只有一个菜单展开，并在点击外部时全部收起。
document.querySelectorAll('details.layout-menu').forEach(menu => {
  menu.addEventListener('keydown', event => {
    const summary = menu.querySelector('summary')
    const items = [...menu.querySelectorAll('button:not(:disabled),a[href]')].filter(el => el.getClientRects().length)
    if (event.key === 'Escape' && menu.open) { event.preventDefault(); event.stopPropagation(); menu.open = false; summary?.focus(); return }
    if (!['ArrowDown','ArrowUp','Home','End'].includes(event.key)) return
    if (event.target === summary && !menu.open) {
      event.preventDefault(); menu.open = true
      requestAnimationFrame(() => { const targets = [...menu.querySelectorAll('button:not(:disabled),a[href]')].filter(el => el.getClientRects().length); (event.key === 'ArrowUp' || event.key === 'End' ? targets.at(-1) : targets[0])?.focus() })
      return
    }
    if (!menu.open || !items.length) return
    event.preventDefault()
    const index = items.indexOf(document.activeElement)
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length-1 : (index + (event.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length
    items[next]?.focus()
  })
  menu.addEventListener('toggle', () => {
    if (!menu.open) return
    document.querySelectorAll('details.layout-menu[open]').forEach(other => {
      if (other !== menu) other.removeAttribute('open')
    })
  })
})
document.addEventListener('click', event => {
  document.querySelectorAll('details.layout-menu[open]').forEach(menu => {
    if (!menu.contains(event.target)) menu.removeAttribute('open')
  })
})
/* UI-01: 旧缩放/平移按钮已由拖拉条替代，绑定移除 */
byId('arrangement').addEventListener('mousedown', event => {
  if (!event.shiftKey || !selectedStory() || !state.snapshot) return
  purgeDragState = { from: purgeSelectionPercent(event) }
  const overlay = purgeSelectionOverlay()
  overlay.style.left = byId('arrangement').getBoundingClientRect().left + 'px'
  overlay.style.width = '0px'
  event.preventDefault()
})
byId('arrangement').addEventListener('mousemove', event => {
  if (!purgeDragState) return
  const current = purgeSelectionPercent(event)
  const overlay = purgeSelectionOverlay()
  const leftTime = Math.min(Date.parse(purgeDragState.from), Date.parse(current))
  overlay.style.left=(canvas.headerWidth+timeToPx(leftTime))+'px'
  overlay.style.width=Math.abs(Date.parse(current)-Date.parse(purgeDragState.from))*canvas.pxPerMs+'px'
})
byId('arrangement').addEventListener('mouseup', event => {
  if (!purgeDragState) return
  const to = purgeSelectionPercent(event)
  const from = purgeDragState.from
  purgeDragState = null
  const overlay = byId('purge-selection')
  if (overlay) overlay.remove()
  if (Math.abs(Date.parse(from) - Date.parse(to)) < 60_000) return
  state.timeSelection = { storyId: state.storyId, from: Date.parse(from) < Date.parse(to) ? from : to, to: Date.parse(from) < Date.parse(to) ? to : from }
  byId('detail-status').textContent='选区：'+dateText(from)+' → '+dateText(to)
})
byId('arrangement').addEventListener('wheel', event => {
  if(!selectedStory()||!state.snapshot||['session','mixer','stats','settings'].includes(state.browserView))return
  if (state.browserView === 'overview') { event.preventDefault(); void setStudioView('timeline', { immediate: true }) }
  const vp=timelineViewport(),dx=TimelineModel.wheelPixels(event.deltaX,event.deltaMode,event.currentTarget.clientHeight),dy=TimelineModel.wheelPixels(event.deltaY,event.deltaMode,event.currentTarget.clientHeight)
  if(event.ctrlKey||event.metaKey){event.preventDefault();const rect=event.currentTarget.getBoundingClientRect(),anchor=bounded((event.clientX-rect.left-canvas.headerWidth)/canvas.viewWidthPx,0,1)
    const next=TimelineModel.zoom(Date.parse(vp.from),vp.span,Math.exp(dy*.002),anchor)
    updateViewport(()=>({center:next.from+next.span/2,spanMinutes:next.span/60000,followNow:false}))
  }else if(event.shiftKey||Math.abs(dx)>Math.abs(dy)){event.preventDefault();updateViewport(()=>({center:vp.center+(dx||dy)/canvas.pxPerMs,followNow:false}))}
},{passive:false})

byId('story-select').addEventListener('change', event => window.HDSIActions?.dispatch('story.select', event.target.value))
byId('story-filter').addEventListener('input', renderStoryList)
byId('new-story').addEventListener('click', openCreate)
byId('refresh-timeline').addEventListener('click', refreshSnapshot); byId('backup-story').addEventListener('click', backupSelected)
byId('export-story').addEventListener('click', async () => { const story = selectedStory(); if (!story) return; try { const result = await desktop.stories.export(story.meta.id); if (!result.canceled) { appendLog({ storyId: story.meta.id, line: `已导出不含密钥的剧本目录：${result.path}` }); showToast('剧本目录已导出（不含密钥）。', 'ok') } } catch (error) { reportUserError(story.meta.id, `导出失败：${error}`) } })
byId('open-backups').addEventListener('click', async () => { const story = selectedStory(); if (!story) return; try { await desktop.stories.openBackupFolder(story.meta.id) } catch (error) { reportUserError(story.meta.id, `无法打开备份位置：${error}`) } })
let wizardSubmitting = false
byId('story-form').addEventListener('submit', async event => {
  event.preventDefault()
  // 隐式提交防线：hidden 的 wizard-submit 仍是表单的默认提交键，任意步骤
  // 在输入框按 Enter 都会触发 submit——只有末步（6/6 检查页）才允许创建。
  // wizardSubmitting 挡住创建期间的重复 Enter / 连点（避免建出多个剧本）。
  if (wizardStep !== 6 || wizardSubmitting) return
  wizardSubmitting = true
  try {
  const data = new FormData(event.currentTarget)
  const rawId = String(data.get('id') ?? '').trim()
  const autoId = rawId || `story-${Date.now().toString(36)}`
    const whitelistRaw = String(data.get('whitelist') ?? '').trim()
    const whitelist = whitelistRaw ? whitelistRaw.split('\n').map(q=>q.trim()).filter(Boolean) : []
    // 空白名单 = 对所有人开放私聊——对接真实 QQ 号的 bot，这个默认值值得一次阻断式确认
    if (!whitelist.length && !window.confirm('未添加任何白名单用户 = 允许所有人私聊该角色。确定以此配置创建吗？（稍后可在 配置 → 用户白名单 中添加）')) return
    try {
    const created = await desktop.stories.create({ id: autoId, name: data.get('name'), characterName: data.get('characterName'), description: data.get('world') ?? '' })
    byId('story-dialog').close(); state.storyId = created.id
    // 审查T9: create 已成功——refresh 失败只降级为警告，不能走"创建失败"路径（重试会建重复剧本）。
    try { await refresh() } catch (refreshError) { appendLog({ storyId: created.id, line: `创建后刷新失败（不影响创建结果）：${refreshError}` }) }
    // B17/B18(二轮#6): create 接口只接收 name/characterName/description——
    // 人设（characterProfile）与世界观（storyDefaults.world）创建后补写。
    // configSection 写是整体替换，先读当前值合并再写回。
    const profile = String(data.get('characterProfile') ?? '').trim()
    const world = String(data.get('world') ?? '').trim()
    let profileOk = true
    if (profile || world) {
      try {
        const base = await desktop.stories.configSection(created.id, 'storyDefaults')
        const merged = { ...((base && typeof base === 'object') ? base : {}) }
        if (profile) merged.characterProfile = profile
        if (world) merged.world = world
        await desktop.stories.configSection(created.id, 'storyDefaults', merged)
      } catch (sdErr) { profileOk = false; appendLog({ storyId: created.id, line: `人设/世界观写入失败（可稍后在配置中补填）：${sdErr}` }) }
    }
    // B17: 白名单通过 configSection 写入（创建接口不直接支持白名单）
    let whitelistOk = true
    if (whitelist.length) {
      try {
        await desktop.stories.configSection(created.id, 'userAccounts', whitelist.map(qq=>({ qq, enabled: true, label: '', profile: '', relationship: '' })))
      } catch(wlErr) { whitelistOk = false; appendLog({ storyId: created.id, line: `白名单写入失败（可稍后在配置中添加）：${wlErr}` }) }
    }
    // B21: 向导填写的模型提供商写入新剧本（设为主叙事）
    const wp = wizardProviderInput()
    if (wp.model && wp.apiKey) {
      try {
        // ConfigMediator rejects plaintext sensitive values. Save the key in
        // the host secret store first, then persist only its alias in the
        // story-owned YAML/config section.
        const alias = `wizard-${String(created.id).replace(/[^A-Za-z0-9_.-]/g, '-').slice(0, 110)}-main-key`
        if (!desktop.secrets || typeof desktop.secrets.set !== 'function') throw new Error('桌面密钥库不可用，未写入模型 API Key。')
        await desktop.secrets.set(alias, wp.apiKey)
        await desktop.stories.configSection(created.id, 'providers', [{ id: 'main', mode: wp.mode, model: wp.model, endpoint: wp.endpoint, apiKey: `$secret:${alias}`, temperature: 0.8, useForMain: true }])
      } catch(mErr) { appendLog({ storyId: created.id, line: `模型配置写入失败（可稍后在配置中设置）：${mErr}` }) }
    }
    // B20: 向导填写的机器人账号在创建后立即绑定
    const botSelfId = String(data.get('botSelfId') ?? '').trim()
    const botChannelKind = String(data.get('botChannelKind') ?? 'qq')
    const botUpstream = String(data.get('botUpstream') ?? '').trim()
    if (botSelfId) {
      const validBotId = botChannelKind === 'qq' ? /^\d{5,11}$/.test(botSelfId) : /^[A-Za-z0-9_-]{4,64}$/.test(botSelfId)
      if (!validBotId) appendLog({ storyId: created.id, line: `机器人账号 ID 格式无效（${botSelfId}），未绑定——请稍后在连接页配置。` })
      else {
        try { await desktop.accounts.bind(created.id, botSelfId, String(data.get('name') ?? ''), botUpstream ? { endpoint: botUpstream } : undefined, botChannelKind) }
        catch(bindErr) { appendLog({ storyId: created.id, line: `账号绑定失败（可稍后在连接页重试）：${bindErr}` }) }
      }
    }
    // 二轮#6: 提示按实际写入结果措辞——不再在写入失败时宣称成功
    const toastParts = [`剧本「${data.get('name')}」已创建`]
    if (whitelist.length) toastParts.push(whitelistOk ? `白名单 ${whitelist.length} 人` : '白名单未写入（见日志）')
    if ((profile || world) && !profileOk) toastParts.push('人设未写入（见日志）')
    showToast(toastParts.join('，') + '。', whitelistOk && profileOk ? 'ok' : 'info')
    // 创建成功后的下一步必须围绕“刚创建的故事”展开：再次显式选中并持久化，
    // 防止刷新/异步写入期间沿用旧故事，导致新手看到错误的连接状态。
    if (state.storyId !== created.id) selectStory(created.id, false)
    else { state.storyId = created.id; persist(); renderContext(); renderStoryList() }
    // 向导完成 → 跳到当前故事的连接页显示就绪检查与加载主动作
    setSurface('connect')
  } catch (error) { appendLog({ storyId: 'shell', line: `创建失败：${error}` }); showToast('创建失败：'+error,'err') }
  } finally { wizardSubmitting = false }
})
// 向导导航按钮
byId('wizard-prev')?.addEventListener('click', () => { if (wizardStep > 1) { wizardStep--; updateWizardUI() } })
byId('wizard-next')?.addEventListener('click', () => { if (wizardStep < 6) { wizardStep++; updateWizardUI() } })
byId('wizard-skip')?.addEventListener('click', () => {
  if (wizardStep === 4) {
    // W3：「跳过」语义 = 本次不配置渠道——清空该步输入，避免检查页显示半填状态
    const form = byId('story-form')
    form.querySelector('[name=botSelfId]').value = ''
    form.querySelector('[name=botUpstream]').value = ''
  }
  if (wizardStep < 6) { wizardStep++; updateWizardUI() }
})
// B20/B21: 步骤内输入即时刷新状态文案
for (const field of ['providerMode','providerModel','providerEndpoint','providerApiKey']) {
  byId('story-form').querySelector(`[name=${field}]`)?.addEventListener('input', () => { if (wizardStep === 3) void checkWizardModel() })
}
// 端点仅 openai-compatible 需要（官方预设自动使用官方端点，与主进程
// model-readiness 的 OFFICIAL_MODES 口径一致）：非兼容模式隐藏端点输入。
{
  const modeSelect = byId('story-form').querySelector('[name=providerMode]')
  const endpointField = byId('story-form').querySelector('[name=providerEndpoint]')?.closest('label')
  const syncWizardEndpoint = () => { if (endpointField) endpointField.hidden = modeSelect?.value !== 'openai-compatible' }
  modeSelect?.addEventListener('change', () => { syncWizardEndpoint(); if (wizardStep === 3) void checkWizardModel() })
  syncWizardEndpoint()
}

// ============================================================
// 插件版配置导入（连接页 ⤓ 按钮 → 分析预览 → 勾选/目标 → 执行报告）
// 只迁配置不迁数据；密钥明文自动转入本机密钥库（主进程完成）。
// ============================================================
function initConfigImport() {
  const btn = byId('import-config-btn')
  const dlg = byId('import-dialog')
  const body = byId('import-body')
  const run = byId('import-run')
  const note = byId('import-note')
  const badge = byId('import-dialog-badge')
  if (!btn || !dlg || !dlg.showModal || !body || !run) return
  let sessionId = ''

  const moduleRow = (key, title, summary, checked, hint, disabled) =>
    `<label class="import-module" style="${disabled ? 'opacity:.55' : ''}"><input type="checkbox" data-module="${key}" ${checked ? 'checked' : ''}${disabled ? ' disabled' : ''}><span class="import-module-text"><b>${title}</b><small>${escapeHtml(summary)}</small>${hint ? `<small class="import-module-hint">${escapeHtml(hint)}</small>` : ''}</span></label>`

  const renderPreview = async analysis => {
    const m = analysis.modules
    const warnings = analysis.warnings || []
    badge.textContent = analysis.file || 'koishi.yml'
    badge.className = 'pack-verdict'
    const accountsDetail = m.accounts.adapters.map(adapter => `<small class="import-module-hint">${escapeHtml(adapter.selfId || '?')} · ${escapeHtml(adapter.protocol)} · ${escapeHtml(adapter.endpoint)}${adapter.reverse ? '（反向，不自动绑定）' : ''}</small>`).join('')
    let stories = []
    try { stories = await desktop.stories.list() } catch { /* 列表不可用仅影响删除选项 */ }
    body.innerHTML =
      `<div class="pack-preview-block"><b>检测到的内容（勾选要导入的模块）</b>`
      + moduleRow('persona', '人设与故事', m.persona.present ? `角色：${m.persona.characterName || '(未命名)'}` : '源配置无 storyDefaults', m.persona.present)
      + moduleRow('relations', '关系（白名单）', `用户 ${m.relations.users} · 群聊 ${m.relations.groups}`, m.relations.users + m.relations.groups > 0)
      + `<label class="import-module"><input type="checkbox" data-module="accounts" checked><span class="import-module-text"><b>账号</b><small>机器人 ${m.accounts.bots} · adapter ${m.accounts.adapters.length}（可自动绑定 ${m.accounts.bindable}）</small>${accountsDetail}</span></label>`
      + moduleRow('model', '模型配置', `${m.model.providers} 个连接 · 明文密钥 ${m.model.plaintextKeys} 个（自动转入密钥库）`, m.model.providers > 0)
      + moduleRow('behavior', '状态机与运行行为', m.behavior.length ? `${m.behavior.length} 节：${m.behavior.map(item => item.key).join('、')}` : '源配置无行为节', m.behavior.length > 0)
      + (() => {
        const db = m.database || {}
        if (!db.found) return moduleRow('database', '剧本数据库', '未探测到源数据库（按 yml 内 database-sqlite 路径查找）', false, '跳过数据库；仅导入配置', true)
        const size = db.sizeBytes > 1024 * 1024 ? `${(db.sizeBytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(db.sizeBytes / 1024))} KB`
        const c = db.counts || {}
        const hints = []
        if (db.error) hints.push(`读取统计失败（${db.error}）——仍可尝试整库导入`)
        if (db.walActive) hints.push('源库有未合并 WAL，建议先关闭插件版实例')
        if ((db.storySelfIds || []).length > 1) hints.push(`库内有 ${db.storySelfIds.length} 个剧本，以主剧本承载`)
        return moduleRow('database', '剧本数据库（整库替换）', `${size} · 剧本 ${c.story ?? '?'} · 剧本条目 ${c.script_entry ?? '?'} · 事实 ${c.fact ?? '?'} · 用户/绑定 ${c.user ?? '?'}/${c.binding ?? '?'}`, true, hints.join('；') || '聊天记录、事实与记忆全部随库迁移；analytics 等无关表原样保留')
      })()
      + moduleRow('mainPrompt', '主提示词覆盖', m.mainPrompt.present ? '源有自定义主提示词' : '源无自定义', false, '默认不导入，保持 typ0 默认提示词')
      + moduleRow('misc', '其他（blindMode / logging）', m.misc.blindMode || m.misc.logging ? [m.misc.blindMode ? 'blindMode' : '', m.misc.logging ? 'logging' : ''].filter(Boolean).join(' · ') : '源配置无对应节', true)
      + `</div>`
      + (warnings.length ? `<div class="pack-preview-block"><b>注意事项</b><ul class="pack-diag-list">${warnings.map(item => `<li class="pack-diag-warn">${escapeHtml(item)}</li>`).join('')}</ul></div>` : '')
      + `<div class="pack-preview-block"><b>目标</b><label class="cfg-short">新剧本名称<input id="import-story-name" value="${escapeHtml(m.persona.characterName || '导入的剧本')}"></label>`
      + (stories.length
        ? `<div class="import-delete"><b>导入成功后删除现有剧本（可选；删除前自动归档备份）</b>${stories.map(story => `<label class="import-module"><input type="checkbox" data-delete-id="${escapeHtml(story.meta?.id ?? story.id ?? '')}"><span class="import-module-text"><b>${escapeHtml(story.meta?.name ?? story.name ?? story.meta?.id ?? story.id ?? '?')}</b></span></label>`).join('')}</div>`
        : '')
      + `</div>`
    note.textContent = '数据库模块为整库替换：插件版的聊天记录、事实与记忆全部迁入新剧本。'
    run.hidden = false; run.disabled = false; run.textContent = '开始导入'
  }

  const renderReport = result => {
    badge.textContent = '完成'
    badge.className = 'pack-verdict pack-verdict-pass'
    const count = status => result.report.filter(item => item.status === status).length
    body.innerHTML =
      `<div class="pack-preview-identity"><strong>已创建剧本「${escapeHtml(result.storyName)}」</strong><span>${count('ok')} 项成功 · ${count('warning')} 项警告 · ${count('skipped')} 项跳过</span></div>`
      + `<div class="pack-preview-block"><b>明细</b><ul class="pack-diag-list">${result.report.map(item => `<li class="${item.status === 'warning' ? 'pack-diag-warn' : ''}" style="${item.status === 'skipped' ? 'opacity:.6' : ''}"><b>${escapeHtml(item.module)}</b> ${escapeHtml(item.detail)}</li>`).join('')}</ul></div>`
      + (result.secrets.length ? `<div class="pack-preview-block"><b>密钥库新增别名</b><ul class="pack-diag-list">${result.secrets.map(alias => `<li><code>${escapeHtml(alias)}</code></li>`).join('')}</ul></div>` : '')
      + (result.account ? `<div class="pack-preview-block"><b>账号</b><ul class="pack-diag-list"><li>${escapeHtml(result.account.selfId)} → ${escapeHtml(result.account.endpoint)}</li></ul></div>` : '')
    note.textContent = '新剧本未加载（paused）；到连接页确认账号与就绪检查后加载 Worker。'
    run.hidden = true
  }

  btn.addEventListener('click', async () => {
    let picked
    try { picked = await window.hdsiDesktop.importer.pickAnalyze() }
    catch (error) { console.error('[import] 分析失败', error); showToast(`读取失败：${error}`, 'err'); return }
    if (!picked || picked.cancelled) return
    sessionId = picked.sessionId
    await renderPreview(picked.analysis)
    dlg.showModal()
    run.focus()
  })

  run.addEventListener('click', async () => {
    if (!sessionId || run.disabled) return
    const modules = {}
    body.querySelectorAll('[data-module]').forEach(el => { modules[el.dataset.module] = el.checked })
    const deleteIds = [...body.querySelectorAll('[data-delete-id]')].filter(el => el.checked).map(el => el.dataset.deleteId)
    const storyName = byId('import-story-name')?.value?.trim() || ''
    if (deleteIds.length && !window.confirm(`导入成功后将删除以下剧本（删除前自动归档备份）：${deleteIds.join('、')}。确定？`)) return
    run.disabled = true; run.textContent = '导入中…'
    try {
      const result = await window.hdsiDesktop.importer.execute(sessionId, { modules, ...(storyName ? { storyName } : {}) })
      sessionId = ''
      for (const id of deleteIds) { try { await desktop.stories.delete(id) } catch (error) { showToast(`删除剧本 ${id} 失败：${error}`, 'err') } }
      // 自动切换到新导入的剧本：账号已随导入登记/转移，用户下一步就是在新剧本上确认连接。
      window.HDSIActions?.dispatch('story.select', result.storyId)
      renderReport(result)
      showToast(`已创建剧本「${result.storyName}」并切换为当前剧本。`, 'ok')
    } catch (error) {
      run.disabled = false; run.textContent = '开始导入'
      showToast(`导入失败：${error}`, 'err')
    }
  })
  byId('import-cancel')?.addEventListener('click', () => dlg.close())
  byId('import-close')?.addEventListener('click', () => dlg.close())
}
initConfigImport()
for (const field of ['botSelfId', 'botChannelKind']) {
  const control = byId('story-form').querySelector(`[name=${field}]`)
  control?.addEventListener('input', () => { if (wizardStep === 4) void checkWizardChannel() })
  control?.addEventListener('change', () => { if (wizardStep === 4) void checkWizardChannel() })
}
/* 旧 form submit handler 已移除——改用 config-save/config-cancel 按钮 */
byId('save-secret').addEventListener('click', async () => { const alias = byId('secret-alias').value.trim(); const value = byId('secret-value').value; try { renderAliases(await desktop.secrets.set(alias, value)); byId('secret-value').value = ''; byId('config-status').textContent = `密钥别名 ${alias} 已保存到本机安全存储。` } catch (error) { byId('config-status').textContent = `密钥保存失败：${error}` } })

setInterval(() => {
  const now = new Date()
  byId('clock').innerHTML = `<span style="color:var(--faint);margin-right:6px">${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}</span>${now.toLocaleTimeString()}`
}, 1_000)
// 新剧本产生时自动刷新：故事变化 → 防抖 2s 刷快照（不等 30s 定时器）
var autoSnapshotTimer = null
function scheduleAutoSnapshot() {
  clearTimeout(autoSnapshotTimer)
  autoSnapshotTimer = setTimeout(() => {
    const story = selectedStory()
    // 审查T16: mixer/settings/session/stats 不消费快照——revision 变化触发 renderArrangement
    // 会整体重建这些视图（编辑中的草稿/焦点静默丢失）。快照刷新只服务时间线类视图。
    const timelineViews = ['overview', 'timeline', 'facts', 'schedule']
    if (story?.running && story?.bridgeReady && state.surface === 'studio' && timelineViews.includes(state.browserView)) {
      void refreshSnapshot()
    }
  }, 2_000)
}
desktop.onStoriesChanged(() => { void refresh(); scheduleAutoSnapshot() })
desktop.onStoryExit(detail => {
  // B2：worker 退出后"待重载"不再成立（下次加载必用新配置）。
  if (detail?.storyId) needsReloadStoryIds.delete(detail.storyId)
  // P0-4：崩溃必须有用户可见反馈。Normal/killed are user-initiated paths, already
  // have feedback in the UI, no extra interference.
  if (detail?.exitKind === 'crash' || detail?.exitKind === 'error') {
    showToast(`Worker of story ${detail.storyId} exited unexpectedly (kind=${detail.exitKind} code=${detail.exitCode ?? 'n/a'}${detail.signal ? ` signal=${detail.signal}` : ''}), you can reload it on the connection page.`, 'err', 8000)
  }
})
// P2-2：未绑定账号的消息落地可见——toast + 状态栏计数，指引到连接页绑定。
desktop.onRouterUnassigned(event => {
  unassignedInboxCount += 1
  const account = event && typeof event === 'object' ? String(event.accountKey ?? event.selfId ?? '未知账号') : '未知账号'
  showToast(`收到发往未绑定账号 ${account} 的消息，已存入未分配收件箱——到连接页绑定该账号后即可接收。`, 'err', 8000)
  updateRunStateText()
})
desktop.onStoryPhase(refresh); desktop.onStoryInbox(() => { refresh(); scheduleAutoSnapshot() })
desktop.onAccountConnection(event => {
  if (event.storyId === state.storyId) void refreshAccountPanel()
  // P2-1：连接页的步骤卡与就绪检查随连接事件自动更新，不再等手动重新检查。
  if (state.surface === 'connect') { void renderConnectView(); void renderReadyPanel() }
  void updateStatusBar()
})
desktop.onLogRecord(record => {
  appendLogRecord(record)
  // 模型调用完成/剧本落库 → 防抖刷快照
  const msg = String(record.message || '')
  if (/剧本已落库|模型调用完成|场景压缩完成|叙事完成|committed/.test(msg)) scheduleAutoSnapshot()
})
desktop.onLogBlind(enabled => applyLogBlind(enabled))
desktop.onConsoleReady(event => { if (event.storyId === state.storyId) void refreshConsoleInfo() })
desktop.onConsoleRevoked(event => { if (event.storyId === state.storyId) { consoleState.descriptor = null; consoleState.embedded = false } renderKoishiState() })
desktop.onStoryDelivery(event => { state.deliveries.push({ ...event, at: new Date().toISOString() }); if (state.deliveries.length > 400) state.deliveries.shift(); state.deliveriesRev = (state.deliveriesRev || 0) + 1; if (event.storyId === state.storyId) scheduleHostProjectionRefresh(); renderDetail() })
desktop.onStoryToken(event => { state.usage.push({ ...event, at: new Date().toISOString() }); if (state.usage.length > 400) state.usage.shift(); state.usageRev = (state.usageRev || 0) + 1; appendLog({ storyId: event.storyId, line: `[token] ${event.task || 'unknown'} ${event.model || ''}` }); if (event.storyId === state.storyId) scheduleHostProjectionRefresh(); renderDetail() })
desktop.onStoryRuntime(event => { appendLog({ storyId: event.storyId, line: `[runtime] ${event.phase || 'updated'}` }); if (event.storyId === state.storyId) void refreshSnapshot() })
// P1：桥会话状态流——协商/降级/失联/闭合实时更新状态栏 chip（per-story 缓存，
// 切换故事时 updateStatusBar 再向主进程拉一次权威快照）。
var bridgeStatusState = { byStory: new Map() }
desktop.onStoryBridge(snapshot => {
  if (!snapshot || typeof snapshot.storyId !== 'string') return
  bridgeStatusState.byStory.set(snapshot.storyId, snapshot)
  if (snapshot.storyId === state.storyId) void updateStatusBar()
})
function bridgeChipFor(story) {
  if (!story?.running) return { text: '桥：—', className: 'status-cell', title: '' }
  const snap = bridgeStatusState.byStory.get(story.meta.id)
  if (!snap || snap.state === 'connecting') return { text: '桥：协商中', className: 'status-cell', title: '等待 Worker 上报 bridge-ready（30s 内未达成将判失败）' }
  if (snap.state === 'ready') return { text: `桥：P${snap.protocol ?? '?'} 就绪`, className: 'status-cell ok', title: `protocol ${snap.protocol ?? '?'} · ${snap.capabilities?.length ?? 0} 项能力` }
  if (snap.state === 'degraded') {
    const missing = (snap.unavailableFeatures || []).map(item => `${item.label}：${item.reason}${item.fallback ? `，${item.fallback}` : ''}`).join('\n')
    return { text: `桥：P${snap.protocol ?? '?'} 降级`, className: 'status-cell warn', title: `${(snap.warnings || []).join('\n')}${missing ? `\n受限功能：\n${missing}` : ''}`.trim() }
  }
  if (snap.state === 'stale') return { text: '桥：失联', className: 'status-cell err', title: `心跳超 45s（最后活跃 ${snap.lastSeenAt ?? '未知'}）——请求将按超时处理，恢复后自动继续` }
  if (snap.state === 'failed') return { text: '桥：协商失败', className: 'status-cell err', title: snap.failure?.detail || '原因未知' }
  return { text: '桥：已关闭', className: 'status-cell', title: `Worker 已退出（${snap.closedAs?.exitKind ?? 'unknown'}）` }
}
byId('koishi-attach').addEventListener('click', () => void attachConsole())
byId('koishi-detach').addEventListener('click', () => void detachConsole())
byId('help-close')?.addEventListener('click', () => byId('help-dialog').close())
window.addEventListener('resize', scheduleConsoleResize)
// Grid sizes are owned by applyPanelLayout; crossing a breakpoint must also
// reflow the current task without waiting for navigation or a data refresh.
var panelLayoutResizeFrame = 0
window.addEventListener('resize', () => {
  if (panelLayoutResizeFrame) return
  panelLayoutResizeFrame = requestAnimationFrame(() => { panelLayoutResizeFrame = 0; applyPanelLayout() })
})
document.querySelectorAll('[data-view-mode]').forEach(node => node.classList.toggle('active', node.dataset.viewMode === (state.viewMode || 'workbench')))
document.addEventListener('hdsi-workspace-profile-change', () => { lastRenderedSnapshotKey = ''; lastRenderedV7Key = ''; syncWorkspaceProfileView(); renderContext() })
syncWorkspaceProfileView()
// Restoring an active tab is not an explicit request to reveal the detail panel.
setSurface(state.surface); setDetail(state.detail, { reveal: false }); setupLogsSurface(); refresh()

// ── Session View：Ableton 式片段槽网格（点击检查 / 从此分支续写） ──────────
function renderSessionView(target, story) {
  if (!story.running || !story.bridgeReady) { target.innerHTML = `<div class="arrangement-empty"><strong>${escapeHtml(story.meta.name)}</strong> 尚未可读。加载 Worker 后 Session 视图才能列出剧本片段。<button data-arrangement-load>Load Worker</button></div>`; target.querySelector('button')?.addEventListener('click', loadSelected); return }
  const snapshot = state.snapshot
  if (!snapshot) { target.innerHTML = '<div class="arrangement-empty">正在等待时间线投影… <button data-arrangement-refresh>Refresh</button></div>'; target.querySelector('button')?.addEventListener('click', refreshSnapshot); return }
  const blocks = buildScriptBlocks(snapshot.entries || [])
  const wrap = document.createElement('div'); wrap.className = 'session-grid'
  if (!blocks.length) { wrap.innerHTML = '<p class="muted-copy" style="padding:20px">当前投影窗口内没有剧本片段。缩放时间轴或等待自动推进产生内容。</p>'; target.appendChild(wrap); return }
  blocks.forEach((block, index) => {
    const card = document.createElement('div')
    card.className = `session-clip${state.selectedScript === block ? ' selected' : ''}`
    card.tabIndex = 0; card.setAttribute('aria-label', `剧本片段 ${blocks.length - index}，查看详情`)
    card.addEventListener('keydown', event => { if (event.target === card && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); card.click() } })
    const meta = `${dateText(block.start)} · ${block.entries?.length || 1} 条记录 · ${block.exactRange ? '时间段' : '时间点'}`
    card.innerHTML = `<header><span class="session-index">${String(blocks.length - index).padStart(2, '0')}</span><b>${escapeHtml(meta)}</b><button class="session-fork" title="从这个片段的末尾创建分支剧本（整库复制，原剧本不动）">⤴ 分支续写</button></header><p>${escapeHtml(block.content || '（此片段暂无正文）')}</p>`
    card.querySelector('.session-fork').addEventListener('click', event => { event.stopPropagation(); openForkDialog(story, block) })
    card.addEventListener('click', () => { state.selectedScript = block; setDetail('script'); inspect({ type: 'script', entry: block }); document.querySelectorAll('.session-clip').forEach(node => node.classList.remove('selected')); card.classList.add('selected') })
    bindContextMenu(card, () => [
      { label: '检查片段', action: () => inspect({ type: 'script', entry: block }) },
      { label: '⤴ 从此分支续写', action: () => openForkDialog(story, block) },
      { separator: true },
      { label: '复制片段文本', action: () => { void navigator.clipboard.writeText(block.content || '') } },
    ])
    wrap.appendChild(card)
  })
  target.appendChild(wrap)
}

function openForkDialog(story, block) {
  if (block == null) {
    // 没有 block 上下文（从故事条右键进入）：尝试用最新剧本片段
    const snapshot = state.snapshot
    const blocks = snapshot ? buildScriptBlocks(snapshot.entries || []) : []
    const latest = blocks[blocks.length - 1]
    if (latest && Number.isSafeInteger(Number(latest.entries?.[0]?.id))) block = latest
    else { appendLog({ storyId: story.meta.id, line: '无法建立分支锚点（无剧本片段）。' }); return }
  }
  // UI-36: 在 fallback 之后取 entryId（之前 fallback 不重算，显示 undefined）
  const entryId = block.entries?.[0]?.id
  if (!Number.isSafeInteger(Number(entryId))) { appendLog({ storyId: story.meta.id, line: '锚点条目 ID 无效。' }); return }

  const dialog = document.createElement('dialog'); dialog.className = 'fork-dialog'
  dialog.innerHTML = `<form method="dialog"><header><strong>分支续写 · ${escapeHtml(story.meta.name)}</strong><small>锚点：entry #${escapeHtml(String(entryId))} · ${escapeHtml(dateText(block.start))}<br>分支将复制完整剧本库从该锚点续写；原剧本与其它分支不受影响（同分支树一次仅一个可运行）。</small></header><label>分支名称<input name="name" required maxlength="60" placeholder="例如：雨天支线" value="${escapeHtml(`${story.meta.name} · 分支`)}"></label><footer><span>forkPoint = entryId ${escapeHtml(String(entryId))}</span><button type="button" value="cancel">取消</button><button type="submit" value="ok" class="primary">创建分支</button></footer></form>`
  document.body.appendChild(dialog)
  dialog.showModal()
  dialog.querySelector('[value="cancel"]')?.addEventListener('click',()=>dialog.close())
  dialog.addEventListener('close', async () => {
    const name = String((dialog.querySelector('input[name=name]')?.value || '')).trim()
    const ok = dialog.returnValue === 'ok' && name
    dialog.remove()
    if (!ok) return
    appendLog({ storyId: story.meta.id, line: `正在从 entry ${entryId} 创建分支「${name}」…（整库复制，可能需要数秒）` })
    try {
      const result = await desktop.stories.forkBranch(story.meta.id, { name, forkPoint: { entryId } })
      appendLog({ storyId: result?.id || story.meta.id, line: `分支已创建：${result?.name || name}（${result?.id || '未知 ID'}）。切换到它开始续写。` })
      await refresh()
    } catch (error) { reportUserError(story.meta.id, `分支创建失败：${error}`) }
  })
  dialog.querySelector('input[name=name]')?.focus()
}

// ── Mixer：Ableton 式分板块调音台（6 板块 × 45 参数） ──────────────────
var mixerState = {params:[],storyId:null,section:'人物与故事',request:0}
var mixerDrafts = new Map()
var contextMenu = null
function mixerDraft(id) {
  if(!mixerDrafts.has(id))mixerDrafts.set(id,{pending:{},flight:null,timer:null})
  return mixerDrafts.get(id)
}
// ============================================================
// P2-1: 统一设置导航 — 按用户目标组织（替代 MODEL/TEMPO 内部模块名）
// ============================================================
const SETTING_NAV_SECTIONS = [
  { key:'人物与故事', legacy:['STORY','CHARACTER'], icon:'PERSON', desc:'主角设定、世界观、配角、叙事文风' },
  { key:'连接与聊天对象', legacy:['CHANNEL'], icon:'LINK', desc:'渠道、白名单、群聊规则' },
  { key:'模型与费用', legacy:['MODEL'], icon:'MODEL', desc:'模型连接、温度、Token 上限' },
  { key:'联系节奏', legacy:['TEMPO'], icon:'TIME', desc:'主动联系频率、Urge、休息窗口' },
  { key:'记忆与连续性', legacy:['MEMORY'], icon:'ANALYSIS', desc:'事实数量、压缩阈值、回忆深度' },
  { key:'扩展能力', legacy:['ADVANCED'], icon:'EXT', desc:'贴纸、表情、网页浏览、多关系' },
  { key:'高级与诊断', legacy:['LOG','DIAGNOSTIC'], icon:'CONFIG', desc:'日志级别、健康面板、YAML' },
]
function mixerSectionForLegacy(section) {
  for(const nav of SETTING_NAV_SECTIONS) { if(nav.legacy.includes(section)) return nav.key }
  return '高级与诊断'
}
// ============================================================
// P2-3: 行为预设
// ============================================================
const BEHAVIOR_PRESETS = {
  contact: { label:'联系频率', key:'contactPreset', options:[
    { value:'less', label:'较少', desc:'推进间隔拉长、联系门槛提高、温度切回严格', patch:{ autoAdvanceIntervalMinutes:90, proactiveThr:0.75, contactMode:'strict' } },
    { value:'normal', label:'适中', desc:'默认节奏，兼顾自然与响应（平衡温度）', patch:{ autoAdvanceIntervalMinutes:40, proactiveThr:0.65, contactMode:'balanced' } },
    { value:'more', label:'较频繁', desc:'推进更密、更容易主动联系（自然温度）', patch:{ autoAdvanceIntervalMinutes:20, proactiveThr:0.50, contactMode:'natural' } },
  ]},
  cost: { label:'费用优先', key:'costPreset', options:[
    // rc57 同步：插件默认值调整（contextTimeWindowMinutes 45→6、recentEntryLimit 默认 30），
    // “均衡”档必须与真实默认对齐，否则一键“默认参数”反而把上下文窗口抬高 7.5 倍。
    { value:'save', label:'节省', desc:'上下文窗口和事实数减少', patch:{ recentEntryLimit:20, factLimit:10, ctxWindow:3 } },
    { value:'balanced', label:'均衡', desc:'默认参数', patch:{ recentEntryLimit:30, factLimit:20, ctxWindow:6 } },
    { value:'rich', label:'保留更多上下文', desc:'更多原始条目和事实（窗口回到 rc56 前的 45 分钟）', patch:{ recentEntryLimit:50, factLimit:30, ctxWindow:45 } },
  ]},
  scope: { label:'聊天范围', key:'scopePreset', options:[
    // 二轮#4(B11): 群聊接入开关是 onebot.groupChats[].enabled（配置节），
    // 不是 chatActions（那是引用/表情动作开关）。预设直接启停群聊行；
    // obFilter 不再顺带打开——白名单为空时打开会拒绝全部用户。
    { value:'private', label:'只私聊', desc:'停用全部群聊（私聊不受影响；群聊规则保留，随时可再启用）', groupChats:'off' },
    { value:'groups', label:'允许指定群聊', desc:'启用已添加的群聊（具体群在「配置 → 群聊管理」中添加）', groupChats:'on' },
  ]},
  log: { label:'日志密度', key:'logPreset', options:[
    { value:'standard', label:'标准', desc:'关键结果和模型计时', patch:{ logLevel:'info', logVerbosity:'standard' } },
    { value:'diagnostic', label:'诊断', desc:'追加跳过原因、队列和上下文统计', patch:{ logLevel:'debug', logVerbosity:'diagnostic' } },
  ]},
}
function renderMixerView(target,story) {
  // 二轮#8: 未选择故事时不渲染 Mixer（loadMixerStrips 等会直接读 story.meta.id）
  if (!story) { target.innerHTML = '<div class="arrangement-empty">先从左侧选择一个剧本，再调整设置。</div>'; return }
  const sections = SETTING_NAV_SECTIONS.map(s=>s.key)
  const wrap=document.createElement('div');wrap.className='mixer-rack'
  wrap.innerHTML=`
    <header class="mixer-head">
      <div class="mixer-head-copy"><span class="mixer-eyebrow">STORY BEHAVIOUR</span><strong>行为设置 Mixer</strong><span>调整角色如何写作、何时联系、使用哪一种通道。</span></div>
      <div class="mixer-actions"><span class="mixer-draft-badge" id="mixer-draft-badge" aria-live="polite">读取中</span><button id="mixer-save">保存</button><button id="mixer-reload" class="primary">保存并重载 Worker</button></div>
    </header>
    <div class="mixer-signal-row" aria-label="Mixer 状态摘要">
      <div class="mixer-signal"><span class="mixer-signal-label">DRAFT</span><strong id="mixer-signal-draft">读取中</strong><small>本地草稿，尚未写入故事配置</small></div>
      <div class="mixer-signal"><span class="mixer-signal-label">EFFECTIVE</span><strong id="mixer-signal-effective">读取中</strong><small>当前配置中的显式值</small></div>
      <div class="mixer-signal"><span class="mixer-signal-label">RELOAD</span><strong>保存后生效</strong><small>重载会中断生成中的回复</small></div>
    </div>
    <details class="mixer-presets-disclosure"><summary>快速预设 <span>联系频率、费用、聊天范围与日志密度</span></summary><div class="behavior-presets" id="behavior-presets"></div></details>
    <div class="mixer-sections" role="tablist" aria-label="设置分组">${sections.map(sec=>{
      const nav=SETTING_NAV_SECTIONS.find(s=>s.key===sec)
      return `<button type="button" role="tab" aria-pressed="${sec===mixerState.section}" data-mixer-section="${sec}" class="mixer-section-btn ${sec===mixerState.section?'active':''}" title="${nav?.desc??''}">${sec}</button>`
    }).join('')}</div>
    <div class="mixer-channel-strip" id="mixer-strips"></div>
    <div class="mixer-foot" id="mixer-foot" role="status" aria-live="polite">读取中…</div>`
  target.appendChild(wrap)
  wrap.querySelectorAll('[data-mixer-section]').forEach(btn=>btn.addEventListener('click',()=>{mixerState.section=btn.dataset.mixerSection;wrap.querySelectorAll('[data-mixer-section]').forEach(b=>{b.classList.toggle('active',b===btn);b.setAttribute('aria-pressed',String(b===btn))});renderMixerStrips()}))
  wrap.querySelector('#mixer-save').addEventListener('click',()=>{void flushMixer(story.meta.id).then(()=>showToast('已保存。' + (story.running ? '重载后生效。' : ''),'ok')).catch(e=>showToast('保存失败：'+e,'err'))})
  wrap.querySelector('#mixer-reload').addEventListener('click',async event=>{
    event.currentTarget.disabled=true
    // 重载会中断正在生成的回复与待发投递——先问一句
    if(!window.confirm('保存并重载会中断正在生成的回复与待发消息。继续？')){event.currentTarget.disabled=false;return}
    try{await flushMixer(story.meta.id);await desktop.stories.unload(story.meta.id);await desktop.stories.load(story.meta.id);needsReloadStoryIds.delete(story.meta.id);await refresh();showToast('已保存并重载。','ok')}
    catch(error){mixerStatus(story.meta.id,'未重载：'+error);showToast('重载失败：'+error,'err')}
    finally{wrap.querySelector('#mixer-reload').disabled=false}
  })
  renderBehaviorPresets(wrap, story)
  updateMixerSummary(story.meta.id)
  void loadMixerStrips(story.meta.id)
}
function renderBehaviorPresets(wrap, story) {
  const container=wrap.querySelector('#behavior-presets');if(!container)return
  container.innerHTML=`<div class="preset-title">选择预设前可悬停查看影响；群聊范围会立即写入配置，其余参数加入待保存草稿。</div>`
  for(const [id,preset] of Object.entries(BEHAVIOR_PRESETS)) {
    const group=document.createElement('div');group.className='preset-group'
    group.innerHTML=`<div class="preset-label">${preset.label}</div>`
    for(const opt of preset.options) {
      const btn=document.createElement('button');btn.type='button';btn.className='preset-btn';btn.textContent=opt.label;btn.title=opt.desc
      btn.addEventListener('click',()=>{
        const draft=mixerDraft(story.meta.id)
        const patchKeys=Object.entries(opt.patch??{})
        for(const [key,val] of patchKeys) draft.pending[key]=val
        if(opt.groupChats){
          // 二轮#4: 聊天范围预设直接启停群聊配置节（立即写盘，不进 mixer 草稿）
          void (async()=>{
            try{
              const rows=await desktop.stories.configSection(story.meta.id,'groupChats')
              const list=Array.isArray(rows)?rows:[]
              if(!list.length){mixerStatus(story.meta.id,'尚未添加任何群聊——先在「配置 → 群聊管理」中添加群，再切换范围。');return}
              await desktop.stories.configSection(story.meta.id,'groupChats',list.map(r=>({...r,enabled:opt.groupChats==='on'})))
              mixerStatus(story.meta.id,`预设「${opt.label}」：${list.length} 个群聊已${opt.groupChats==='on'?'启用':'停用'}。Worker 重载后生效。`)
            }catch(error){mixerStatus(story.meta.id,'群聊范围切换失败：'+error)}
          })()
        } else if(patchKeys.length){
          mixerStatus(story.meta.id,`预设「${opt.label}」已加入待保存（${Object.keys(draft.pending).length} 项待保存）`)
        }
        // 高亮只在同组内互斥：container 横跨四组预设，全局清除会让
        // "联系频率/费用/聊天范围/日志密度"四组只剩一组能显示选中。
        btn.closest('.preset-group')?.querySelectorAll('.preset-btn').forEach(b=>b.classList.remove('active'))
        btn.classList.add('active')
      })
      group.appendChild(btn)
    }
    container.appendChild(group)
  }
}
function updateMixerSummary(id) {
  if (state.storyId !== id) return
  const draft = mixerDraft(id)
  const pending = Object.keys(draft.pending).length
  const effective = mixerState.params.filter(param => param.value != null).length
  const badge = byId('mixer-draft-badge')
  const draftSummary = byId('mixer-signal-draft')
  const effectiveSummary = byId('mixer-signal-effective')
  if (badge) { badge.textContent = pending ? `${pending} 项待保存` : '无待保存修改'; badge.classList.toggle('pending', pending > 0) }
  if (draftSummary) draftSummary.textContent = pending ? `${pending} 项待保存` : '无待保存修改'
  if (effectiveSummary) effectiveSummary.textContent = `${effective} 项已生效`
}
function mixerStatus(id,text){if(state.storyId===id&&byId('mixer-foot'))byId('mixer-foot').textContent=text;updateMixerSummary(id)}
async function loadMixerStrips(storyId) {
  const request=++mixerState.request;mixerState.storyId=storyId
  try{const params=await desktop.stories.mixerRead(storyId)
    if(request!==mixerState.request||state.storyId!==storyId||state.browserView!=='mixer')return
    mixerState.params=params;renderMixerStrips();mixerStatus(storyId,'未指定表示继承核心默认值；修改保留为草稿，保存后重载生效。')
  }catch(error){mixerStatus(storyId,'读取失败：'+error)}
}
function renderMixerStrips() {
  const strips=byId('mixer-strips'),id=mixerState.storyId;if(!strips||id!==state.storyId)return
  const draft=mixerDraft(id);strips.replaceChildren()
  // P2-1: 按目标分组过滤（将旧内部 section 映射到新的导航 key）
  const params=mixerState.params.filter(p=>mixerSectionForLegacy(p.section)===mixerState.section)
  // 二轮#3(B08/B14): 后端参数表没有 STORY/CHARACTER 分类，该分组如果只等
  // mixer 参数永远空白——改为内嵌人设/世界观速编表单（走 configSection）。
  if(mixerState.section==='人物与故事'&&!params.length){renderStoryQuickForm(strips,id);return}
  for(const param of params){
    const value=Object.hasOwn(draft.pending,param.key)?draft.pending[param.key]:param.value
    const isPending=Object.hasOwn(draft.pending,param.key)
    const card=document.createElement('article');card.className='mixer-channel'+(param.hot?' hot':'')+(isPending?' pending':'');card.dataset.paramKey=param.key;card.dataset.paramType=param.type
    const copy=document.createElement('div');copy.className='mixer-param-copy'
    const label=document.createElement('label');label.textContent=param.label;copy.appendChild(label)
    const desc=document.createElement('p');desc.className='mixer-description';desc.textContent=param.desc;copy.appendChild(desc)
    const control=document.createElement('div');control.className='mixer-param-control'
    const stateEl=document.createElement('div');stateEl.className='mixer-param-state'
    card.append(copy,control,stateEl)
    const refreshState = () => {
      const pending = Object.hasOwn(draft.pending,param.key), v = pending ? draft.pending[param.key] : param.value
      card.classList.toggle('pending',pending)
      stateEl.className = 'mixer-param-state ' + (pending ? 'pending-state' : 'effective-state')
      stateEl.replaceChildren()
      stateEl.append(document.createTextNode(pending ? `待保存：${v ?? '继承默认'}` : `生效：${param.value ?? '继承默认'}`))
      if (pending) {
        const detail=document.createElement('small');detail.textContent=`当前：${param.value ?? '继承默认'}`;stateEl.prepend(detail)
        const revert=document.createElement('button');revert.type='button';revert.className='param-revert';revert.textContent='撤销'
        revert.addEventListener('click',()=>{delete draft.pending[param.key];renderMixerStrips();updateMixerSummary(id);document.querySelector(`[data-param-key="${param.key}"] .mixer-param-control input:not([type="range"]),[data-param-key="${param.key}"] .mixer-param-control select,[data-param-key="${param.key}"] .mixer-param-control button`)?.focus()});stateEl.appendChild(revert)
      }
    }
    const change=v=>{
      if ((v ?? null) === (param.value ?? null)) delete draft.pending[param.key]
      else draft.pending[param.key]=v
      refreshState();mixerStatus(id,'待保存 '+Object.keys(draft.pending).length+' 项；切换分组保留草稿。')
    }
    card.refreshMixerState = refreshState
    refreshState()
    if(param.type==='knob'){
      const range=document.createElement('input');range.type='range';range.className='mixer-fader';range.min=param.min;range.max=param.max;range.step=param.step;range.value=value??param.min;range.disabled=value==null
      const input=document.createElement('input');input.type='number';input.className='mixer-number';input.min=param.min;input.max=param.max;input.step=param.step;input.placeholder='继承';if(value!=null)input.value=value
      const sliderLine=document.createElement('div');sliderLine.className='mixer-slider-line';sliderLine.append(range,input);control.appendChild(sliderLine)
      input.addEventListener('change',()=>{if(input.value===''){change(null);range.disabled=true}else if(input.checkValidity()){change(Number(input.value));range.disabled=false;range.value=input.value}else input.reportValidity()})
      range.addEventListener('input',()=>{input.value=range.value;change(Number(range.value))})
    }else if(param.type==='toggle'){
      const button=document.createElement('button');button.type='button';button.className=`mixer-toggle ${value===true?'on':value===false?'off':'inherit'}`;button.textContent=value==null?'继承':value?'ON':'OFF';button.setAttribute('aria-pressed',String(value===true));button.title=param.desc
      let current=value;button.addEventListener('click',()=>{current=current==null?true:current===true?false:null;change(current);button.className=`mixer-toggle ${current===true?'on':current===false?'off':'inherit'}`;button.textContent=current==null?'继承':current?'ON':'OFF';button.setAttribute('aria-pressed',String(current===true))});button.title+=' · 点击循环：继承 → ON → OFF → 继承';control.appendChild(button)
    }else if(param.type==='select'){
      const input=document.createElement('select');input.className='mixer-select';input.add(new Option('未指定（继承）','',false,value==null))
      for(const option of param.options||[])input.add(new Option(option,option,false,option===value))
      input.addEventListener('change',()=>change(input.value===''?null:input.value));control.appendChild(input)
    }else if(param.type==='text'){
      // rc25：长文本参数（主提示词等）。change 提交（与 knob 一致，不逐键入草稿）；
      // 空串是合法值——保存后由服务侧按“清空=恢复默认”语义处理。
      const input=document.createElement('textarea');input.className='mixer-text';input.rows=5
      input.placeholder='未指定（继承内置默认）'
      if(value!=null)input.value=String(value)
      input.addEventListener('change',()=>{change(input.value)})
      control.appendChild(input)
    }
    strips.appendChild(card)
  }
}
var storyQuickToken = 0
// 二轮#3: 人物与故事分组的人设/世界观速编表单。
// configSection 写是整体替换——先读当前 storyDefaults 合并再写回，不覆盖其他字段。
function renderStoryQuickForm(strips, storyId) {
  const card=document.createElement('div');card.className='mixer-channel story-quick'
  let storyQuickLoaded = false   // 审查T21: 读取失败时禁用保存，防空值覆盖已有人设/世界观
  card.innerHTML=`
    <label>主角设定（背景/性格/说话方式）<textarea data-sq="characterProfile" rows="5" placeholder="加载中…"></textarea></label>
    <label>世界观（时代/地点/现实规则）<textarea data-sq="world" rows="3" placeholder="加载中…"></textarea></label>
    <p class="mixer-description">直接写入剧本配置（storyDefaults），Worker 重载后生效。完整字段（视角/配角/文风/时区）在「配置 → 人设与故事」。</p>
    <button type="button" class="primary" id="story-quick-save">保存</button>`
  strips.replaceChildren(card)
  const token=++storyQuickToken
  void desktop.stories.configSection(storyId,'storyDefaults').then(data=>{
    storyQuickLoaded = true
    if(token!==storyQuickToken)return
    card.querySelector('[data-sq=characterProfile]').value=String(data?.characterProfile??'')
    card.querySelector('[data-sq=world]').value=String(data?.world??'')
  }).catch(()=>{card.querySelectorAll('[data-sq]').forEach(el=>{el.placeholder='读取失败，请重进该分组重试'})
    // 审查T21: 未加载成功前保存按钮禁用——merge 会把空 textarea 无条件写进 storyDefaults。
    const btn=card.querySelector('#story-quick-save'); if(btn){btn.disabled=true;btn.textContent='未加载（禁用保存）'}})
  card.querySelector('#story-quick-save').addEventListener('click',async function(){
    if (!storyQuickLoaded) return   // 审查T21: 未加载成功禁止保存
    this.disabled=true
    try{
      const base=await desktop.stories.configSection(storyId,'storyDefaults')
      const merged={...((base&&typeof base==='object')?base:{}),
        characterProfile:card.querySelector('[data-sq=characterProfile]').value,
        world:card.querySelector('[data-sq=world]').value}
      await desktop.stories.configSection(storyId,'storyDefaults',merged)
      mixerStatus(storyId,'人设与世界观已保存；Worker 重载后生效。')
      showToast('已保存。重载后生效。','ok')
    }catch(error){
      mixerStatus(storyId,'保存失败：'+error)
      showToast('保存失败：'+error,'err')
    }finally{this.disabled=false}
  })
}
async function flushMixer(storyId) {
  const draft=mixerDraft(storyId)
  if(draft.flight){await draft.flight;return flushMixer(storyId)}
  const patch={...draft.pending};if(!Object.keys(patch).length)return
  draft.flight=(async()=>{
    try{const result=await desktop.stories.mixerWrite(storyId,patch)
      if (result?.needsReload) needsReloadStoryIds.add(storyId)
      else needsReloadStoryIds.delete(storyId)
      const appliedKeys=new Set(result.applied.map(item=>item.key))
      // B12/B13: 提交过的键要从待保存中移除（包括后端不认识的），
      // 否则残留项会导致递归 flushMixer 无限重提交同一 patch。
      // 二轮#5: 但只清除"提交后没被再次修改"的键——保存期间用户改出的新值保留，
      // 由下方重入的 flushMixer 提交（否则并发编辑会被这次保存静默吞掉）。
      for(const key of Object.keys(patch)){if(draft.pending[key]===patch[key])delete draft.pending[key]}
      for(const item of result.applied){
        if(mixerState.storyId===storyId){const param=mixerState.params.find(p=>p.key===item.key);if(param)param.value=item.value}
      }
      if(mixerState.storyId===storyId)document.querySelectorAll('#mixer-strips .mixer-channel').forEach(card=>card.refreshMixerState?.())
      const unsupported=Object.keys(patch).filter(k=>!appliedKeys.has(k))
      if(unsupported.length)mixerStatus(storyId,`已保存 ${result.applied.length} 项；后端不支持: ${unsupported.join('、')}（已清除）。Worker 重载后生效。`)
      else mixerStatus(storyId, result.needsReload ? '已保存；当前 Worker 仍使用旧配置，重载后生效。' + (Object.keys(draft.pending).length ? '仍有新的未保存修改。' : '') : '已保存。' + (Object.keys(draft.pending).length ? '仍有新的未保存修改。' : ''))
    }catch(error){mixerStatus(storyId,'保存失败，草稿已保留：'+error);throw error}
    finally{draft.flight=null}
  })()
  await draft.flight
  // 只在有新的待保存项时重入（本次已清除的键不会重复出现，不会无限循环；
  // flight 期间产生的新草稿在这里得到提交——这正是二轮#5 要保住的数据）
  if(Object.keys(draft.pending).length)await flushMixer(storyId)
}

let contextMenuReturnFocus = null
function showContextMenu(x, y, items) {
  dismissContextMenu()
  contextMenu = document.createElement('div'); contextMenu.className = 'context-menu'
  // §6：菜单语义 + 键盘导航（方向键/Home/End/Esc）——此前仅鼠标可达。
  contextMenu.setAttribute('role', 'menu')
  contextMenuReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
  items.forEach(item => {
    if (item.separator) { const sep = document.createElement('div'); sep.className = 'context-sep'; sep.setAttribute('role', 'separator'); contextMenu.appendChild(sep); return }
    const btn = document.createElement('button')
    btn.textContent = item.label
    btn.disabled = !!item.disabled
    btn.setAttribute('role', 'menuitem')
    btn.addEventListener('click', () => { dismissContextMenu(); item.action?.() })
    contextMenu.appendChild(btn)
  })
  document.body.appendChild(contextMenu)
  const rect = contextMenu.getBoundingClientRect()
  const clampX = Math.min(x, window.innerWidth - rect.width - 8)
  const clampY = Math.min(y, window.innerHeight - rect.height - 8)
  contextMenu.style.left = `${clampX}px`; contextMenu.style.top = `${clampY}px`
  contextMenu.addEventListener('keydown', e => {
    const buttons = [...contextMenu.querySelectorAll('button')].filter(b => !b.disabled)
    if (!buttons.length) return
    const index = buttons.indexOf(document.activeElement)
    if (e.key === 'ArrowDown') { e.preventDefault(); (buttons[index + 1] ?? buttons[0]).focus() }
    else if (e.key === 'ArrowUp') { e.preventDefault(); (buttons[index - 1] ?? buttons[buttons.length - 1]).focus() }
    else if (e.key === 'Home') { e.preventDefault(); buttons[0].focus() }
    else if (e.key === 'End') { e.preventDefault(); buttons[buttons.length - 1].focus() }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); dismissContextMenu() }
  })
  contextMenu.querySelector('button:not([disabled])')?.focus()
}
function dismissContextMenu() {
  contextMenu?.remove(); contextMenu = null
  // §6：关闭（Esc/外部点击/执行菜单项）后把焦点还给触发元素。
  const el = contextMenuReturnFocus; contextMenuReturnFocus = null
  if (el && el.isConnected) el.focus()
}
document.addEventListener('click', e => { if (contextMenu && !contextMenu.contains(e.target)) dismissContextMenu() })
document.addEventListener('keydown', e => { if (e.key === 'Escape') { dismissContextMenu(); document.querySelector('details.layout-menu[open]')?.removeAttribute('open'); const po = byId('purge-selection'); if (po) { po.remove(); purgeDragState = null } } })

function bindContextMenu(el, buildItems) {
  // 键盘 Menu/Shift+F10 会对聚焦元素触发 contextmenu 事件——标记语义供读屏通告。
  el.setAttribute('aria-haspopup', 'menu')
  el.addEventListener('contextmenu', event => {
    event.preventDefault(); event.stopPropagation()
    showContextMenu(event.clientX, event.clientY, buildItems())
  })
}

// ── FL Studio 式时间线拖拉条（持久 DOM，仅更新样式） ─────────────────────

function ensureTimelineScroller() {
  const container = byId('timeline-scroller-container')
  if (!container || scrollerEl) return
  scrollerEl = document.createElement('div')
  scrollerEl.className = 'timeline-scroller'
  scrollerEl.innerHTML = `
    <div class="scroller-track">
      <div class="scroller-window">
        <div class="scroller-handle left"></div>
        <div class="scroller-handle right"></div>
      </div>
      <div class="scroller-now"></div>
    </div>
    <div class="scroller-labels"><span id="sc-label-start"></span><span>NOW</span><span id="sc-label-end"></span></div>`
  container.appendChild(scrollerEl)
  bindScrollerEvents()
}

var overviewRanges = new Map()
function overviewRange() {
  if(scrollerDrag) return {start:scrollerDrag.b.totalStart,end:scrollerDrag.b.totalStart+scrollerDrag.b.totalSpan}
  const entryCount=(state.snapshot?.entries||[]).length
  // 审查T19: 快照未到（启动首帧 ResizeObserver 先于 IPC）不缓存——否则空数据污染
  // 范围，旧历史永远落在缓存 start 之外（拖拉条够不到、Overview 鸟瞰被裁）。
  const cached=overviewRanges.get(state.storyId)
  const revision=String(state.snapshot?.revision ?? 'none')
  if(cached && cached.revision===revision) return cached
  const vp=timelineViewport(),times=(state.snapshot?.entries||[]).map(e=>toMillis(e.startedAt||e.occurredAt)).filter(Number.isFinite)
  if(!entryCount) return {start:Math.min(Date.parse(vp.from),Date.now())-vp.span,end:Math.max(Date.now())+vp.span}
  const range={revision,start:Math.min(Date.parse(vp.from),...times)-vp.span,end:Math.max(Date.parse(vp.to),Date.now())+vp.span}
  overviewRanges.set(state.storyId,range)
  return range
}
function updateTimelineScroller(bounds) {
  ensureTimelineScroller()
  if (!scrollerEl || !bounds) return
  const viewport = timelineViewport()
  const vpFrom = new Date(viewport.from).getTime()
  const vpTo = new Date(viewport.to).getTime()
  // 全范围：从最早数据到未来合理边界
  const {start:totalStart,end:totalEnd}=overviewRange()
  const totalSpan = Math.max(1, totalEnd - totalStart)
  const vpStartPct = bounded(((vpFrom - totalStart) / totalSpan) * 100, 0, 100)
  const vpEndPct = bounded(((vpTo - totalStart) / totalSpan) * 100, 0, 100)
  const nowPct = bounded(((Date.now() - totalStart) / totalSpan) * 100, 0, 100)
  const win = scrollerEl.querySelector('.scroller-window')
  const now = scrollerEl.querySelector('.scroller-now')
  const labelS = scrollerEl.querySelector('#sc-label-start')
  const labelE = scrollerEl.querySelector('#sc-label-end')
  if (win) {
    setStyle(win,'left',`${vpStartPct}%`)
    setStyle(win,'width',`${Math.max(vpEndPct - vpStartPct, 1)}%`)
  }
  if (now) setStyle(now,'left',`${nowPct}%`)
  if (labelS) setText(labelS,new Date(totalStart).toLocaleTimeString())
  if (labelE) setText(labelE,new Date(totalEnd).toLocaleTimeString())
}

function bindScrollerEvents() {
  if (!scrollerEl) return
  const track = scrollerEl.querySelector('.scroller-track')
  const win = scrollerEl.querySelector('.scroller-window')
  const handleL = scrollerEl.querySelector('.scroller-handle.left')
  const handleR = scrollerEl.querySelector('.scroller-handle.right')

  const getBounds = () => {
    const viewport = timelineViewport()
    const vpFrom = new Date(viewport.from).getTime()
    const vpTo = new Date(viewport.to).getTime()
    const {start:totalStart,end:totalEnd}=overviewRange()
    return { totalStart, totalSpan: Math.max(1, totalEnd - totalStart), vpFrom, vpTo, vpSpan: vpTo - vpFrom }
  }

  const pctToTime = (pct, b) => b.totalStart + (pct / 100) * b.totalSpan

  track.addEventListener('pointerdown', event => {
    event.preventDefault()
    const rect = track.getBoundingClientRect()
    const pct = bounded(((event.clientX - rect.left) / rect.width) * 100, 0, 100)
    const b = getBounds()
    if (event.target === handleL) scrollerDrag = { mode: 'left', pct, b }
    else if (event.target === handleR) scrollerDrag = { mode: 'right', pct, b }
    else if (event.target.closest('.scroller-window')) scrollerDrag = { mode: 'pan', pct, b, startCenter: (b.vpFrom + b.vpTo) / 2 }
    else {
      // 点击空白：跳转
      updateViewport(() => ({ center: pctToTime(pct, b), followNow: false }))
    }
    track.setPointerCapture(event.pointerId)
  })

  track.addEventListener('pointermove', event => {
    if (!scrollerDrag) return
    const rect = track.getBoundingClientRect()
    const pct = bounded(((event.clientX - rect.left) / rect.width) * 100, 0, 100)
    const { b } = scrollerDrag
    if (scrollerDrag.mode === 'pan') {
      const deltaMs = ((pct - scrollerDrag.pct) / 100) * b.totalSpan
      updateViewport(() => ({ center: scrollerDrag.startCenter + deltaMs, followNow: false }))
    } else {
      const next=TimelineModel.resize(b.vpFrom,b.vpTo,pctToTime(pct,b),scrollerDrag.mode)
      updateViewport(()=>({spanMinutes:next.span/60000,center:next.from+next.span/2,followNow:false}))
    }
  })


  const endDrag = () => { scrollerDrag = null }
  track.addEventListener('pointerup', endDrag)
  track.addEventListener('pointercancel', endDrag)

  // 右键菜单：拖拉条
  bindContextMenu(track, () => [
    { label: '回到 NOW', action: () => returnToNow() },
    { label: '重置缩放（14h）', action: () => { updateViewport(() => ({ spanMinutes: 14 * 60, followNow: true })); updateKnobFromViewport() } },
    { separator: true },
    { label: '刷新数据', action: () => void refreshSnapshot() },
  ])

  // 双击 NOW 标记回到中心
  scrollerEl.querySelector('.scroller-now')?.addEventListener('dblclick', () => returnToNow())
}

// ── 面板恢复条 + 分隔条拖拽（10.22） ─────────────────────────────────────
function updatePanelRestoreStrips() {
  const layout = layoutFor()
  const choices = taskPanelOverrides.get(panelTaskKey()) || {}
  // Automatic task defaults need no floating restore strips. Explicit collapses do.
  const collapsed = name => isFocusedTask() && name !== 'browser' ? choices[name] === false : !layout.panels[name]
  const defs = [
    { id: 'restore-browser', label: '▸ Browser', cls: 'browser', show: collapsed('browser'), panel: 'browser' },
    { id: 'restore-inspector', label: '◂ Inspector', cls: 'inspector', show: false, panel: 'inspector' },
    { id: 'restore-detail', label: '▴ Detail', cls: 'detail', show: false, panel: 'detail' },
  ]
  for (const def of defs) {
    let el = byId(def.id)
    if (def.show && !el) {
      el = document.createElement('button')
      el.type = 'button'
      el.id = def.id; el.className = `panel-restore ${def.cls}`
      el.textContent = def.label; el.title = `恢复 ${def.panel} 面板`
      el.addEventListener('pointerdown', e => { e.stopPropagation() })
      el.addEventListener('click', e => { e.stopPropagation(); togglePanel(def.panel) })
      document.body.appendChild(el)
    } else if (!def.show && el) {
      el.remove()
    }
  }
}




// 分隔条拖拽调宽

// 初始化恢复条
setTimeout(updatePanelRestoreStrips, 100)

// ── 实时播放头 + 定时刷新（Ableton 式：60fps 播放头 + 到达右缘整页前翻） ──
var nowPlayheadEl = null
var nowPlayheadRAF = null

function ensureNowPlayhead() {
  if (nowPlayheadEl?.isConnected) return
  const arrangement = byId('arrangement')
  if (!arrangement) return
  nowPlayheadEl = document.createElement('div')
  nowPlayheadEl.className = 'now-playhead'
  nowPlayheadEl.innerHTML = '<span class="now-playhead-label">NOW</span>'
  // 放在 arrangement 内部（画布坐标系，随轨道一起滚动）
  arrangement.parentElement.appendChild(nowPlayheadEl)
  nowPlayheadEl.style.pointerEvents = 'none'
  nowPlayheadEl.style.position = 'absolute'
  nowPlayheadEl.style.left = '0px'
  nowPlayheadEl.style.willChange = 'transform'
  watchPlayheadGeometry(arrangement)
  startNowPlayheadAnimation()
}

// 播放头几何监听：#arrangement 的盒子尺寸变化（HUD↔Timeline 过渡结束、面板
// 开合、窗口缩放、轨道增减）都会改变可用高度。renderArrangement 的快路径
// （同 key 不重测 canvas）覆盖不到这些时机，rAF 循环就一直拿旧高度画半截线。
// #arrangement 是 index.html 的固定节点（只替换子元素），一次监听终身有效。
let playheadGeometryWatched = false
function watchPlayheadGeometry(arrangement) {
  if (playheadGeometryWatched) return
  playheadGeometryWatched = true
  const remeasure = () => refreshPlayheadGeometry()
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(remeasure).observe(arrangement)
  window.addEventListener('resize', remeasure)
}

function startNowPlayheadAnimation() {
  if (nowPlayheadRAF) return
  const animate = () => {
    nowPlayheadRAF = requestAnimationFrame(animate)
    if (!nowPlayheadEl) return
    const story = selectedStory()
    if (!story || !story.running || !state.snapshot) {
      if (nowPlayheadEl.style.display !== 'none') nowPlayheadEl.style.display = 'none'
      return
    }
    const px = timeToPx(Date.now())
    const inTimeline = state.surface === 'studio' && isTimelineStudioView()
    if (!inTimeline || px < 0 || px > canvas.viewWidthPx) {
      if (nowPlayheadEl.style.display !== 'none') nowPlayheadEl.style.display = 'none'
      // Ableton 翻页：follow 模式下播放头越过右缘时整页前翻（视窗回中）
      if (inTimeline && px > canvas.viewWidthPx && layoutFor().followNow) returnToNow()
      return
    }
    if (nowPlayheadEl.style.display === 'none') nowPlayheadEl.style.display = 'block'
    const g = canvas.playhead
    if (g) {
      nowPlayheadEl.style.transform = `translateX(${g.x + px}px)`
      const top = g.y + 'px', height = g.h + 'px'
      // 高度与顶点分别判断：ResizeObserver 只改 h（y 不变）时也要落盘
      if (nowPlayheadEl.style.top !== top || nowPlayheadEl.style.height !== height) { nowPlayheadEl.style.top = top; nowPlayheadEl.style.height = height }
    }
  }
  nowPlayheadRAF = requestAnimationFrame(animate)
}

// One idle refresh source; event requests are coalesced.
// follow 回中已移交给播放头 rAF 的右缘翻页（startNowPlayheadAnimation），这里只做数据保鲜。
setInterval(()=>{
  if(document.hidden||state.surface!=='studio'||scrollerDrag||state.browserView === 'overview'||!isTimelineStudioView())return
  void refreshSnapshot()
},15000)


// ── 面板拖拽调宽（更新 grid 模板，保持吸附） ─────────────────────────────

// ── Ableton 式时间尺度旋钮（20s–30天，上下拖动调节） ─────────────────────
var knobCanvas = null
var knobCtx = null
var knobDrag = null

// 对数刻度：20 秒 → 30 天（43,200 分钟），映射到 0–270° 旋钮角度
var KNOB_MIN_SEC = 20
var KNOB_MAX_SEC = 30 * 24 * 3600  // 2,592,000 秒
var KNOB_MAX_ANGLE = 270

function spanSecToKnobAngle(spanSec) {
  const clamped = Math.max(KNOB_MIN_SEC, Math.min(KNOB_MAX_SEC, spanSec))
  const logMin = Math.log(KNOB_MIN_SEC)
  const logMax = Math.log(KNOB_MAX_SEC)
  const logVal = Math.log(clamped)
  return ((logVal - logMin) / (logMax - logMin)) * KNOB_MAX_ANGLE
}
function formatSpanLabel(spanSec) {
  if (spanSec < 60) return `${Math.round(spanSec)}s`
  if (spanSec < 3600) return `${Math.round(spanSec / 60)}min`
  if (spanSec < 86400) return `${(spanSec / 3600).toFixed(spanSec < 7200 ? 1 : 0)}h`
  return `${Math.round(spanSec / 86400)}d`
}

function drawKnob(angle) {
  if (!knobCtx) return
  const w = 22; const h = 22; const cx = w / 2; const cy = h / 2
  const outerR = 9; const innerR = 6
  knobCtx.clearRect(0, 0, w, h)

  // 背景弧（270° 从 -135° 到 +135°）
  knobCtx.beginPath()
  knobCtx.arc(cx, cy, outerR, (-135 - 90) * Math.PI / 180, (135 - 90) * Math.PI / 180)
  knobCtx.lineWidth = 2
  knobCtx.strokeStyle = '#3a3a3a'
  knobCtx.stroke()

  // 值弧（从起点到当前角度）
  knobCtx.beginPath()
  knobCtx.arc(cx, cy, outerR, (-135 - 90) * Math.PI / 180, (-135 - 90 + angle) * Math.PI / 180)
  knobCtx.lineWidth = 2
  knobCtx.strokeStyle = '#c49e00'
  knobCtx.stroke()

  // 内圈
  knobCtx.beginPath()
  knobCtx.arc(cx, cy, innerR - 1, 0, 2 * Math.PI)
  knobCtx.fillStyle = '#2a2a2a'
  knobCtx.fill()

  // 指针线
  const pointerAngle = (-135 + angle - 90) * Math.PI / 180
  knobCtx.beginPath()
  knobCtx.moveTo(cx + Math.cos(pointerAngle) * (innerR - 3), cy + Math.sin(pointerAngle) * (innerR - 3))
  knobCtx.lineTo(cx + Math.cos(pointerAngle) * (innerR + 1), cy + Math.sin(pointerAngle) * (innerR + 1))
  knobCtx.lineWidth = 1.5
  knobCtx.strokeStyle = '#e0d0a0'
  knobCtx.stroke()
}

function updateKnobFromViewport() {
  const vp = timelineViewport()
  const spanSec = vp.span / 1000
  const angle = spanSecToKnobAngle(spanSec)
  drawKnob(angle)
  const label = byId('time-knob-label')
  if (label) label.textContent = formatSpanLabel(spanSec)
}

function initTimeKnob() {
  knobCanvas = byId('time-knob')
  if (!knobCanvas) return
  knobCtx = knobCanvas.getContext('2d')
  const wrap = knobCanvas.parentElement
  if (!wrap) return

  wrap.addEventListener('pointerdown', event => {
    event.preventDefault()
    event.stopPropagation()
    const vp = timelineViewport()
    knobDrag = { startY: event.clientY, startSpanSec: vp.span / 1000 }
    wrap.setPointerCapture(event.pointerId)
    wrap.style.cursor = 'grabbing'
  })

  wrap.addEventListener('pointermove', event => {
    if (!knobDrag) return
    // 旋钮惯例：向上拖 = 顺时针 = 增大跨度（时间范围变大），向下拖 = 逆时针
    // = 缩短跨度（放大）。spanSecToKnobAngle 是"跨度越大角度越大（顺时针）"。
    const deltaY = knobDrag.startY - event.clientY  // 向上为正
    // 每 100px 拖动 = 对数域全程的 40%
    const logStart = Math.log(knobDrag.startSpanSec)
    const logMin = Math.log(KNOB_MIN_SEC)
    const logMax = Math.log(KNOB_MAX_SEC)
    const logRange = logMax - logMin
    const sensitivity = logRange * 0.4 / 100
    const newLog = logStart + deltaY * sensitivity
    const newSpanSec = Math.exp(bounded(newLog, logMin, logMax))
    const newSpanMin = Math.max(0.33, newSpanSec / 60)  // 最小 20s ≈ 0.33 分钟
    updateViewport(() => ({ spanMinutes: newSpanMin, followNow: false }))
    updateKnobFromViewport()
  })

  const endDrag = () => { knobDrag = null; wrap.style.cursor = '' }
  wrap.addEventListener('pointerup', endDrag)
  wrap.addEventListener('pointercancel', endDrag)

  // 双击重置为默认 14 小时
  wrap.addEventListener('dblclick', () => {
    updateViewport(() => ({ spanMinutes: 14 * 60, followNow: true }))
    updateKnobFromViewport()
  })

  updateKnobFromViewport()
}

// 在 renderArrangementScale 里同步旋钮（视窗被拖拉条/其它途径改变时）
const _origRenderArrangementScaleKnob = renderArrangementScale
renderArrangementScale = function() {
  _origRenderArrangementScaleKnob()
  updateKnobFromViewport()
}

// 初始化（等 DOM 就绪）
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initTimeKnob)
else initTimeKnob()

// ── Stats 视图：数据统计 + 功能状态栏 ─────────────────────────────────────
// P1-b（复核）：Stats 固定拉取最近 24h 数据——此前直接读当前视窗快照，
// 视窗只有 14h/6h 时"最近 24h"统计就缺数据。独立请求 + 失败回落快照并注明范围。
const statsWindowCache = { storyId: '', at: 0, entries: null, failed: false }
async function fetchStatsEntries(storyId) {
  if (statsWindowCache.storyId === storyId && Date.now() - statsWindowCache.at < 60_000 && !statsWindowCache.failed) return statsWindowCache.entries
  try {
    const to = new Date(); const from = new Date(to.getTime() - 24 * 3_600_000)
    const result = await desktop.stories.timelineRange(storyId, { from: from.toISOString(), to: to.toISOString(), limit: 400, detailLevel: 'full' })
    statsWindowCache.storyId = storyId; statsWindowCache.at = Date.now(); statsWindowCache.entries = result?.entries ?? []; statsWindowCache.failed = false
  } catch {
    statsWindowCache.storyId = storyId; statsWindowCache.at = Date.now(); statsWindowCache.entries = null; statsWindowCache.failed = true
  }
  return statsWindowCache.entries
}

async function renderStatsView(target, story) {
  const wrap = document.createElement('div'); wrap.className = 'stats-view'
  if (!story) { wrap.innerHTML = '<p class="muted-copy" style="padding:20px">选择一个故事以查看统计。</p>'; target.appendChild(wrap); return }
  // §12.1：统计卡片必须显示时间范围和更新时间（快照 range + 拉取时刻）
  if (!story.running || !story.bridgeReady) { wrap.innerHTML = '<p class="muted-copy" style="padding:20px">Worker 未加载，无法读取时间线数据。</p>'; target.appendChild(wrap); return }

  const statsEntries = await fetchStatsEntries(story.meta.id)
  // 审计：拉取期间切换故事或视图时中止——旧故事的统计不得追加到新渲染的页面；
  // target 是跨视图复用的持久节点，晚到的 wrap 会污染已切换的 Timeline。
  if (state.storyId !== story.meta.id || state.browserView !== 'stats') return
  const usedFallback = statsEntries === null
  const entries = usedFallback ? (state.snapshot?.entries || []) : statsEntries
  const snapshot = state.snapshot
  const usage = state.usageSeries || []

  // === 计算指标 ===
  // RPH：按小时分桶的 user-message 计数（最近 24h）
  const now = Date.now()
  const rphBuckets = new Array(24).fill(0)
  for (const e of entries) {
    if (e.kind !== 'user-message') continue
    const t = toMillis(e.occurredAt)
    if (t == null || now - t > 24 * 3600_000) continue
    const hoursAgo = Math.floor((now - t) / 3600_000)
    rphBuckets[23 - hoursAgo]++
  }
  const totalRounds = rphBuckets.reduce((a, b) => a + b, 0)
  const avgRph = (totalRounds / 24).toFixed(1)

  // 平均剧本字数
  const scriptEntries = entries.filter(e => e.track === 'script' || e.kind === 'script')
  const avgScriptChars = scriptEntries.length
    ? Math.round(scriptEntries.reduce((sum, e) => sum + (e.content || '').trim().length, 0) / scriptEntries.length)
    : 0

  // 平均回复延迟：user-message → 下一条 character-message/script
  const replyDelays = []
  const sorted = entries.slice().sort((a, b) => (toMillis(a.occurredAt) ?? 0) - (toMillis(b.occurredAt) ?? 0))
  for (let i = 0; i < sorted.length - 1; i++) {
    if (sorted[i].kind !== 'user-message') continue
    const next = sorted[i + 1]
    if (next.kind === 'character-message' || next.kind === 'script' || next.track === 'script') {
      const delay = (toMillis(next.occurredAt) ?? 0) - (toMillis(sorted[i].occurredAt) ?? 0)
      if (delay > 0 && delay < 300_000) replyDelays.push(delay)
    }
  }
  replyDelays.sort((a, b) => a - b)
  const medianDelay = replyDelays.length ? replyDelays[Math.floor(replyDelays.length / 2)] : 0

  // 模型消费
  const currentUsage = state.hostOverview?.usage
  const totalCalls = currentUsage?.calls ?? 0
  const totalCost = currentUsage?.estimatedCost ?? 0
  const avgCost = totalCalls ? (totalCost / totalCalls) : 0
  const costSamples = usage.filter(d => Number.isFinite(d.estimatedCost))
  const dailyAvg = costSamples.length ? costSamples.reduce((sum, d) => sum + d.estimatedCost, 0) / costSamples.length : 0

  // === 渲染 ===
  const fmt = (ms) => ms >= 60_000 ? `${(ms / 60_000).toFixed(1)}min` : `${(ms / 1000).toFixed(1)}s`
  const fmtC = (c) => c >= 1 ? `¥${c.toFixed(2)}` : `¥${c.toFixed(4)}`

  wrap.innerHTML = `
    <div class="stats-grid">
      <div class="stats-card wide">
        <div class="stats-card-label">对话轮数 / 小时（最近 24h）</div>
        <div class="rph-chart">${rphBuckets.map((count, i) => {
          const h = totalRounds ? Math.max(count / Math.max(...rphBuckets) * 100, count > 0 ? 4 : 0) : 0
          const label = new Date(now - (23 - i) * 3600_000).getHours()
          return `<div class="rph-bar" title="${label}:00 — ${count} 轮"><span style="height:${h}%"></span><small>${label}</small></div>`
        }).join('')}</div>
        <div class="stats-card-value">${avgRph} avg · ${totalRounds} total</div>
      </div>
      <div class="stats-card">
        <div class="stats-card-label">平均剧本字数</div>
        <div class="stats-card-value">${scriptEntries.length ? avgScriptChars : '—'}<small>字 / 段</small></div>
        <div class="stats-card-sub">${scriptEntries.length ? scriptEntries.length + ' 段样本' : '未采样 · 尚无剧本片段'}</div>
      </div>
      <div class="stats-card">
        <div class="stats-card-label" title="user-message 与其后最近一条角色条目的间隔（含自动推进，近似值）">中位回复延迟（近似）</div>
        <div class="stats-card-value">${replyDelays.length ? fmt(medianDelay) : '—'}</div>
        <div class="stats-card-sub">${replyDelays.length ? replyDelays.length + ' 次配对' : '未采样 · 尚无可配对的回复'}</div>
      </div>
      <div class="stats-card">
        <div class="stats-card-label">模型每次消费</div>
        <div class="stats-card-value">${Number.isFinite(currentUsage?.estimatedCost) && totalCalls > 0 ? fmtC(avgCost) : '—'}</div>
        <div class="stats-card-sub">${Number.isFinite(currentUsage?.estimatedCost) ? (totalCalls ? totalCalls + ' 次调用' : '未采样 · 尚无模型调用') : '不可用 · 未返回消费统计'}</div>
      </div>
      <div class="stats-card">
        <div class="stats-card-label">每日平均消费</div>
        <div class="stats-card-value">${costSamples.length ? fmtC(dailyAvg) : '—'}</div>
        <div class="stats-card-sub">${costSamples.length ? costSamples.length + ' 天有效消费样本' : usage.length ? '不可用 · 按日记录未返回消费' : '未采样 · 尚无按日记录'}</div>
      </div>
      <div class="stats-card wide">
        <div class="stats-card-label">功能状态</div>
        <div class="status-lights" id="status-lights">${renderStatusLights(story)}</div>
      </div>
    </div>`
  const statsRangeText = usedFallback ? '当前时间线视窗（24h 独立拉取失败，统计可能不完整）' : '最近 24 小时（独立于时间线视窗）'
  wrap.insertAdjacentHTML('afterbegin', `<div class="view-meta"><span>数据范围：${statsRangeText}</span><span>更新：${new Date().toLocaleTimeString('zh-CN', { hour12: false })}</span></div>`)
  target.appendChild(wrap)
}

function renderStatusLights(story) {
  const overview = state.hostOverview
  const logs = (state.logs || []).filter(l => !state.storyId || l.storyId === state.storyId || l.storyId === 'desktop' || l.storyId === 'shell')
  // 最近 20 条日志中找模型调用结果（按当前故事过滤——别的故事的失败不应点亮此灯）
  const recentModelLogs = logs.filter(l => /模型调用/.test(l.line)).slice(-5)
  const modelFailures = recentModelLogs.filter(l => /失败|错误/.test(l.line)).length
  // 最近 advance
  const lastAdvance = logs.filter(l => /advance|推进/.test(l.line)).slice(-1)[0]
  const lastAdvanceAge = lastAdvance ? (Date.now() - new Date(lastAdvance.at).getTime()) / 60_000 : Infinity

  const lights = [
    { name: 'Worker', ok: story.bridgeReady, warn: false },
    { name: 'OneBot', ok: state.hostOverview?.worker?.bridgeReady ?? false, warn: false },
    { name: '模型', ok: modelFailures === 0, warn: modelFailures > 0 && modelFailures < 3 },
    { name: '推进', ok: story.meta.phase === 'running' && lastAdvanceAge < 90, warn: story.meta.phase === 'running' && lastAdvanceAge >= 90 },
    { name: '收件箱', ok: (overview?.inbox?.pending ?? 0) === 0, warn: (overview?.inbox?.pending ?? 0) > 0 && (overview?.inbox?.pending ?? 0) <= 5 },
  ]
  return lights.map(l => {
    const cls = l.ok ? 'ok' : l.warn ? 'warn' : 'err'
    return `<div class="status-light ${cls}" title="${l.name}: ${l.ok ? '正常' : l.warn ? '警告' : '异常'}"><i></i>${l.name}</div>`
  }).join('')
}

// ── 右下角 OSD：实时指标 + 迷你折线图 ────────────────────────────────────
var osdHistory = []
var osdTimer = null

function updateOSD() {
  const cpu = byId('osd-cpu'); const mem = byId('osd-mem')
  const rph = byId('osd-rph'); const delay = byId('osd-delay')
  if (!cpu) return

  // 从 performance API 取近似指标（不依赖 Node/os 模块）
  const memInfo = performance.memory
  if (memInfo) {
    const usedPct = Math.round(memInfo.usedJSHeapSize / memInfo.jsHeapSizeLimit * 100)
    if (mem) mem.textContent = `${usedPct}%`
  } else if (mem) mem.textContent = 'n/a'

  // CPU 用帧间隔近似（requestAnimationFrame 间隔的倒数）
  // 简化：用当前正在执行的定时器密度
  const story = selectedStory()
  const snapshot = state.snapshot
  const entries = snapshot?.entries || []
  const now = Date.now()
  const recentMsgs = entries.filter(e => e.kind === 'user-message' && now - (toMillis(e.occurredAt) ?? 0) < 3600_000)
  if (rph) rph.textContent = String(recentMsgs.length)

  // 延迟：最近回复
  const sorted = entries.slice().sort((a, b) => (toMillis(b.occurredAt) ?? 0) - (toMillis(a.occurredAt) ?? 0))
  const lastUser = sorted.find(e => e.kind === 'user-message')
  const lastChar = sorted.find(e => e.kind === 'character-message' || e.kind === 'script')
  if (delay && lastUser && lastChar) {
    const d = Math.abs((toMillis(lastChar.occurredAt) ?? 0) - (toMillis(lastUser.occurredAt) ?? 0))
    delay.textContent = d > 0 ? `${(d / 1000).toFixed(0)}s` : '--'
  } else if (delay) delay.textContent = '--'

  // WRK：真实 Worker 占用（此前这里显示编造的"CPU 近似值"，会误导排障）
  if (cpu) cpu.textContent = state.resources ? `${state.resources.runningWorkers}/${state.resources.maxWorkers}` : '--'

  // 迷你折线：RPH 真实历史
  if (rph) {
    osdHistory.push(recentMsgs.length)
    if (osdHistory.length > 60) osdHistory.shift()
  }

  // 折线图
  drawOSDSpark()
}

function drawOSDSpark() {
  const canvas = byId('osd-spark')
  if (!canvas) return
  const ctx = canvas.getContext('2d')
  const w = 120; const h = 24
  ctx.clearRect(0, 0, w, h)
  if (osdHistory.length < 2) return
  const max = Math.max(...osdHistory, 1)
  ctx.beginPath()
  ctx.strokeStyle = '#a0d0a0'
  ctx.lineWidth = 1
  for (let i = 0; i < osdHistory.length; i++) {
    const x = (i / (osdHistory.length - 1)) * w
    const y = h - (osdHistory[i] / max) * (h - 2) - 1
    if (i === 0) ctx.moveTo(x, y)
    else ctx.lineTo(x, y)
  }
  ctx.stroke()
}

// OSD 每 3 秒更新
if (!osdTimer) {
  osdTimer = setInterval(updateOSD, 3_000)
  setTimeout(updateOSD, 500)  // 启动时立即执行一次
}

// Configure Tab 切换 + 保存 + 添加行
document.querySelectorAll('[data-config-tab]').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('[data-config-tab]').forEach(b => b.classList.toggle('active', b === btn))
    document.querySelectorAll('[data-config-panel]').forEach(p => p.classList.toggle('active', p.dataset.configPanel === btn.dataset.configTab))
    document.querySelector('.config-body').scrollTop = 0
    updateConfigActions()
  })
})
document.querySelector('.config-tabs')?.addEventListener('keydown', event => {
  const tabs = [...document.querySelectorAll('[data-config-tab]')]
  const index = tabs.indexOf(event.target)
  if (index < 0 || !['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return
  event.preventDefault()
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length
  tabs[next].click(); tabs[next].focus()
})
byId('config-save')?.addEventListener('click',async event=>{
  if(!configuredStoryId)return
  if (configSaving || !configSectionsReady) return
  const button=event.currentTarget;configSaving=true;updateConfigActions()
  try{
    const active=document.querySelector('.config-tab-panel.active')
    const onYaml=Boolean(active?.querySelector('#config-source'))
    // 两个保存路径互斥：跨路径的未保存修改必须明示，不能静默丢弃
    if(onYaml&&configSectionsDirty&&!window.confirm('当前在 YAML 标签页：本次只保存 YAML 原文，其它标签页的未保存修改不会被保存。继续？'))return
    if(!onYaml&&configYamlDirty&&!window.confirm('当前在结构化标签页：本次只保存当前分区，YAML 标签页的手工修改不会被保存。继续？'))return
    if(onYaml){
      const result = await desktop.stories.saveConfig(configuredStoryId,byId('config-source').value)
      if (result?.needsReload) needsReloadStoryIds.add(configuredStoryId)
      else needsReloadStoryIds.delete(configuredStoryId)
      configYamlDirty=false
      configDirtyPanels.delete('yaml'); configYamlBaseline=byId('config-source').value; configDraftSummary()
      byId('config-status').textContent = result?.needsReload
        ? 'YAML 配置已保存；Worker 仍使用旧配置，请到连接页确认“重载 Worker”。'
        : 'YAML 配置已保存；下次加载 Worker 时生效。'
      if (state.surface === 'connect' && state.storyId === configuredStoryId) void renderConnectView()
    }
    else {
      // §5：按当前标签页只写对应节——不再连带其它标签页的草稿。
      const section = CONFIG_PANEL_SECTIONS[active?.dataset.configPanel]
      if (!section) {
        byId('config-status').textContent = '密钥库与插件分区有各自的保存入口，无需在此保存。'
        return
      }
      await saveConfigSection(configuredStoryId, section)
    }
  }catch(error){byId('config-status').textContent='保存失败：'+error}
  finally{configSaving=false;configDraftSummary()}
})
// ── Phase B（§10.2）：保存全部 / 预览变更 / 放弃修改 ─────────────────────
byId('config-save-all')?.addEventListener('click', async event => {
  if (!configuredStoryId) return
  if (configSaving || !configSectionsReady) return
  configSaving = true; updateConfigActions()
  const status = byId('config-status')
  // 复审：异常分支只有 YAML 真的写入过才能说"YAML 已保存"——纯结构化保存
  // 失败时旧文案会凭空报告一次从未发生的 YAML 保存。
  let yamlSavedThisRun = false
  try {
    const parts = configDraftSummary()
    if (!parts.length) { if (status) status.textContent = '没有未保存的修改。'; return }
    // Mixed full-YAML and form drafts cannot safely be merged: require an explicit source.
    const mixed = configDirtyPanels.has('yaml') && configDirtyPanels.size > 1
    if (mixed) { status.textContent = '尚未保存：YAML 与表单草稿可能互相覆盖。请切换到需要保留的来源，使用“仅保存本页 / 仅保存 YAML”，或放弃草稿后重新编辑。'; return }
    if (!window.confirm(`保存全部草稿（${parts.join('、')}）。\n仅提交已修改的分区，不自动重载 Worker。继续？`)) return
    let yamlNeedsReload = false
    if (configDirtyPanels.has('yaml')) {
      const result = await desktop.stories.saveConfig(configuredStoryId, byId('config-source').value)
      yamlNeedsReload = Boolean(result?.needsReload)
      if (yamlNeedsReload) needsReloadStoryIds.add(configuredStoryId)
      else needsReloadStoryIds.delete(configuredStoryId)
      configYamlDirty = false
      configYamlBaseline = byId('config-source').value
      configDirtyPanels.delete('yaml')
      yamlSavedThisRun = true
    }
    if ([...configDirtyPanels].some(id => id !== 'yaml')) await saveConfigSections(configuredStoryId)
    if (status) status.textContent = (yamlNeedsReload || needsReloadStoryIds.has(configuredStoryId))
      ? '已保存全部草稿；Worker 仍使用旧配置，请到连接页确认“重载 Worker”。'
      : '已保存全部草稿；下次加载 Worker 时生效。'
    if (state.surface === 'connect' && state.storyId === configuredStoryId) void renderConnectView()
  } catch (error) {
    // 部分失败如实报告：YAML 已保存时明确结构化配置未保存，不假报全成功。
    if (status) status.textContent = `保存失败：${error}${yamlSavedThisRun ? '（YAML 已保存，结构化配置未保存——请修正后重试）' : ''}`
  }
  finally { configSaving = false; configDraftSummary() }
})

byId('config-preview')?.addEventListener('click', () => {
  const status = byId('config-status')
  const text = configPreviewText()
  if (status) {
    status.textContent = ''
    status.innerHTML = ''
    const list = document.createElement('div')
    list.className = 'config-preview-list'
    list.textContent = text
    status.appendChild(list)
  }
})

byId('config-revert')?.addEventListener('click', async () => {
  const parts = configDraftSummary()
  if (!parts.length) { showToast('当前没有未保存的修改。', 'info'); return }
  if (!window.confirm(`放弃全部修改（${parts.join('、')}）并重新加载？此操作不可撤销。`)) return
  await openConfig(configuredStoryId)
})

function requestCloseConfigDialog() {
  if (configSaving) return
  if ((configYamlDirty || configSectionsDirty) && !window.confirm('配置有未保存的修改，确定丢弃？')) return
  byId('config-dialog').close()
}
byId('config-cancel')?.addEventListener('click', () => requestCloseConfigDialog())
document.querySelectorAll('[data-add-row]').forEach(btn => {
  btn.addEventListener('click', () => {
    const type = btn.dataset.addRow
    const targetId = { userAccounts: 'cfg-users-list', groupChats: 'cfg-groups-list', botAccounts: 'cfg-bots-list', providers: 'cfg-providers-list' }[type]
    if (!targetId) return
    const container = byId(targetId)
    if (!container) return
    container.querySelector('.ui-state')?.remove()
    container.querySelector('p')?.remove()
    const newRow = type === 'groupChats'
      ? { groupId: '', label: '', enabled: true, responseMode: 'mention-only', contextLimit: 20, cooldownSeconds: 60 }
      : type === 'providers'
      ? { label: '', mode: 'openai-compatible', protocol: 'chat-completions', model: '', endpoint: '', apiKey: '', temperature: 0.8, useForMain: false }
      : { qq: '', label: '', enabled: true }
    // B24: 直接在现有容器前面插入新行，不重建列表——保留用户已编辑的行。
    renderAccountsList(targetId, [newRow], type, true)
    container.querySelector('.cfg-card')?.scrollIntoView({ block: 'nearest' })
  markConfigPanelDirty(btn)
  })
})


function bindConfigDialogButtons() {
  const dialog = byId('config-dialog')
  if (!dialog || dialog.dataset.buttonsBound) return
  dialog.dataset.buttonsBound = '1'
  // X 按钮（header 里的关闭）。#config-cancel 由文末的独立绑定处理——
  // 它也带 value=cancel，若在此一并绑定会出现双重确认框
  dialog.querySelectorAll('button[value=cancel]').forEach(btn => {
    if (btn.id === 'config-cancel') return
    btn.addEventListener('click', () => requestCloseConfigDialog())
  })

  // Phase 3：Console 官方插件配置页一键启用（@koishijs/plugin-config 随宿主附带）
  byId('plugin-console-page-btn')?.addEventListener('click', () => {
    if (!configuredStoryId) return
    if (!window.confirm('为嵌入式 Koishi Console 启用官方「插件配置」页（向 plugins 段添加 config 插件，@koishijs/plugin-config 随 typ0 附带）？' + String.fromCharCode(10) + String.fromCharCode(10) + '重载 worker 后，在剧本的 Console 标签里即可用官方表单编辑任意插件配置（含第三方）；typ0 的插件面板/YAML 标签仍然可用。')) return
    void (async () => {
      try {
        const result = await desktop.stories.pluginAdd(configuredStoryId, 'config')
        if (result?.needsReload) needsReloadStoryIds.add(configuredStoryId)
        appendLog({ storyId: configuredStoryId, line: '[plugins] 已启用 Console 插件配置页（重载后生效）。' })
        void renderPluginsPanel(configuredStoryId)
      } catch (error) { showToast('启用失败：' + String(error), 'error') }
    })()
  })

  // Phase 3：市场搜索（npmmirror）→ 结果条目（兼容性详情 + 安装并添加）
  const marketRun = async () => {
    const query = String(byId('plugin-market-query')?.value || '').trim()
    const note = byId('plugin-market-note')
    const results = byId('plugin-market-results')
    if (!query || !results) return
    if (note) { note.textContent = '搜索中…'; }
    results.innerHTML = '<p class="muted">搜索中…</p>'
    try {
      const data = await desktop.stories.pluginMarketSearch(query)
      const entries = Array.isArray(data?.entries) ? data.entries : []
      if (note) note.textContent = entries.length ? entries.length + ' 个结果' : '无结果'
      results.innerHTML = entries.map((entry, index) => `
        <div class="plugin-market-item" data-index="${index}">
          <b>${escapeHtml(entry.packageName)}</b>
          <small class="muted">v${escapeHtml(String(entry.version))}${entry.date ? ' · ' + escapeHtml(String(entry.date).slice(0, 10)) : ''}${entry.publisher ? ' · ' + escapeHtml(entry.publisher) : ''}</small>
          <span class="plugin-market-desc">${escapeHtml(entry.description || '')}</span>
          <button type="button" class="plugin-market-compat" title="获取 peer 依赖并判定与当前 Koishi 的兼容性">兼容性</button>
          <button type="button" class="plugin-market-install primary">安装并添加</button>
          <span class="plugin-market-compat-result"></span>
        </div>`).join('') || '<p class="muted">无匹配的 Koishi 插件（仅收录 koishi-plugin-* / @koishijs/plugin-*）。</p>'
      entries.forEach((entry, index) => {
        const row = results.querySelector('[data-index="' + index + '"]')
        row?.querySelector('.plugin-market-compat')?.addEventListener('click', async event => {
          const btn = event.currentTarget
          const out = row.querySelector('.plugin-market-compat-result')
          btn.disabled = true; btn.textContent = '查询中…'
          try {
            const detail = await desktop.stories.pluginMarketDetail(entry.packageName)
            const label = detail.compat === 'ok' ? '✓ 兼容当前 Koishi'
              : detail.compat === 'mismatch' ? ('⚠ 要求 koishi ' + (detail.peerRange || '?'))
                : '· 未声明 koishi peer'
            if (out) { out.textContent = label; out.className = 'plugin-market-compat-result ' + (detail.compat === 'ok' ? 'ok' : detail.compat === 'mismatch' ? 'warn' : '') }
            btn.textContent = '已查询'
          } catch (error) { if (out) out.textContent = '查询失败'; btn.disabled = false; btn.textContent = '兼容性' }
        })
        row?.querySelector('.plugin-market-install')?.addEventListener('click', async event => {
          const btn = event.currentTarget
          if (!configuredStoryId) return
          const shortName = entry.pluginName || entry.packageName
          const risky = /^(koishi-plugin-)?(adapter|database)/.test(entry.packageName)
          if (!window.confirm('安装并添加「' + entry.packageName + '」？' + String.fromCharCode(10) + String.fromCharCode(10) + '来源 npmmirror；--ignore-scripts（不执行第三方安装脚本）；安装后写入 plugins 段并需重载 worker。' + (risky ? String.fromCharCode(10) + '⚠ 该插件属于适配器/数据库类，与 HDSI 的桥接或存储正面冲突，可能导致 worker 启动失败。' : ''))) return
          btn.disabled = true; btn.textContent = '安装中…'
          try {
            await desktop.stories.pluginInstall(entry.packageName)
            const result = await desktop.stories.pluginAdd(configuredStoryId, shortName)
            if (result?.needsReload) needsReloadStoryIds.add(configuredStoryId)
            appendLog({ storyId: configuredStoryId, line: '[plugins] 市场安装 ' + entry.packageName + ' 并添加到剧本（重载后生效）。' })
            btn.textContent = '已安装'
            showToast('已安装并添加 ' + entry.packageName + '，重载 worker 后生效', 'success')
            void renderPluginsPanel(configuredStoryId)
          } catch (error) { showToast('安装失败：' + String(error), 'error'); btn.disabled = false; btn.textContent = '安装并添加' }
        })
      })
    } catch (error) {
      if (note) note.textContent = ''
      results.innerHTML = '<p class="muted">搜索失败：' + escapeHtml(String(error)) + '</p>'
    }
  }
  byId('plugin-market-search')?.addEventListener('click', () => void marketRun())
  byId('plugin-market-query')?.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); void marketRun() } })

  // 插件面板：添加插件（即时写 canonical，默认启用空配置）
  byId('plugin-add-btn')?.addEventListener('click', () => {
    if (!configuredStoryId) return
    const input = byId('plugin-add-name')
    const name = String(input?.value || '').trim()
    if (!name) return showToast('请填写插件名，例如 points', 'warn')
    if (!/^(@[A-Za-z0-9._-]+[/])?[A-Za-z0-9._-]+$/.test(name)) return showToast('插件名只允许字母、数字、点、下划线、连字符（可带 @scope/ 前缀）。', 'warn')
    const pkg = name.startsWith('@') || name.startsWith('koishi-plugin-') ? name : null
    const installHint = pkg ? '安装：npm install ' + pkg : '安装：npm install koishi-plugin-' + name + '（官方插件为 @koishijs/plugin-' + name + '）'
    if (!window.confirm('添加插件「' + name + '」到 plugins 段（默认启用、空配置）。' + "\n" + "\n" + installHint + '——未安装的插件会导致 worker 启动报错，可先在面板停用（~ 前缀）。' + "\n" + "\n" + '继续？')) return
    void (async () => {
      try {
        const result = await desktop.stories.pluginAdd(configuredStoryId, name)
        if (result?.needsReload) needsReloadStoryIds.add(configuredStoryId)
        appendLog({ storyId: configuredStoryId, line: '[plugins] 添加插件 ' + name + '（需重载生效）' })
        input.value = ''
        void renderPluginsPanel(configuredStoryId)
      } catch (error) { showToast('添加失败：' + String(error), 'error') }
    })()
  })
}

new ResizeObserver(()=>{if(!timelineFrame)timelineFrame=requestAnimationFrame(()=>{timelineFrame=0;paintTimeline();scheduleConsoleResize()})}).observe(byId('arrangement'))
document.addEventListener('keydown',e=>{if(e.key==='Escape'){purgeDragState=null;byId('purge-selection')?.remove();scrollerDrag=null;resizeDragState=null;document.body.style.cursor=''}})
byId('story-dialog').querySelectorAll('[value="cancel"]').forEach(b=>b.addEventListener('click',()=>byId('story-dialog').close()))

document.addEventListener('mouseup',()=>{if(purgeDragState){purgeDragState=null;byId('purge-selection')?.remove()}})
window.addEventListener('blur',()=>{scrollerDrag=null;resizeDragState=null;purgeDragState=null;byId('purge-selection')?.remove();document.body.style.cursor=''})

// ============================================================
// P2-2: 全局功能搜索 (Ctrl+K)
// ============================================================
const SEARCH_INDEX = [
  // 功能别名 → 目标位置
  { terms:['主动联系','主动说话','主动消息','让角色主动找我'], title:'主动联系', desc:'允许角色根据场景主动发送消息', location:'设置 → 联系节奏', action:()=>{ mixerState.section='联系节奏'; setStudioView('mixer') } },
  { terms:['换模型','模型','主模型','更换模型','AI'], title:'模型连接', desc:'管理模型提供商、API Key、模型名', location:'设置 → 模型与费用', action:()=>{ openConfigTab('providers') } },
  { terms:['登录 QQ','QQ 渠道','连接 QQ','OneBot','SnowLuma','渠道'], title:'连接 QQ 渠道', desc:'配置 SnowLuma 或通用 OneBot 连接', location:'连接与账号', action:()=>{ setSurface('connect') } },
  { terms:['白名单','交往对象','谁能聊天','允许谁'], title:'白名单管理', desc:'添加/移除允许私聊的 QQ 号', location:'设置 → 连接与聊天对象', action:()=>{ openConfigTab('users') } },
  { terms:['新建角色','新建剧本','创建','开始'], title:'新建剧本', desc:'创建新角色并完成首次配置向导', location:'新建剧本', action:()=>{ openWizard() } },
  { terms:['时间轴','轨道','剧本工作台'], title:'剧本工作台', desc:'时间轴、轨道、原文、分支、事实', location:'Studio', action:()=>{ setStudioView('overview') } },
  { terms:['日志','诊断','排错','为什么不能聊天'], title:'诊断', desc:'收发链路、日志、模型用量', location:'诊断', action:()=>{ setSurface('logs') } },
  { terms:['费用','Token','省钱','减少费用','用量'], title:'费用优化', desc:'调整上下文窗口和事实数减少 Token 消耗', location:'设置 → 快速调整', action:()=>{ setStudioView('mixer') } },
  { terms:['记忆','事实','压缩','遗忘'], title:'记忆与连续性', desc:'事实数量、压缩阈值、回忆深度', location:'设置 → 记忆与连续性', action:()=>{ mixerState.section='记忆与连续性'; setStudioView('mixer') } },
  { terms:['贴纸','表情','图片'], title:'扩展能力', desc:'贴纸库、原生表情、网页浏览', location:'设置 → 扩展能力', action:()=>{ mixerState.section='扩展能力'; setStudioView('mixer') } },
  { terms:['暂停','停止','静音','停止推进'], title:'暂停/静音角色', desc:'暂停停止自动推进；静音生成剧本但不发送', location:'顶栏运行控制', action:()=>{ showToast('请使用顶栏的「暂停」或「静音」按钮。','info') } },
  { terms:['备份','导出'], title:'备份剧本', desc:'创建备份或导出存档文件夹', location:'Browser → Story Operations', action:()=>{ showToast('在左侧 Browser 面板的 STORY OPERATIONS 中操作。','info') } },
  { terms:['YAML','高级','配置文件'], title:'YAML 编辑', desc:'直接编辑 Koishi 配置文件', location:'Configure → YAML', action:()=>{ openConfigTab('yaml') } },
]
function searchFeatures(query) {
  const q=query.trim().toLowerCase();if(!q)return[]
  const results=[]
  for(const item of SEARCH_INDEX) {
    const score=item.terms.reduce((best,t)=>{
      const idx=t.toLowerCase().indexOf(q)
      return idx>=0?Math.max(best,idx===0?3:1):best
    },0)
    if(score>0)results.push({...item,score})
  }
  return results.sort((a,b)=>b.score-a.score).slice(0,8)
}
let globalSearchReturnFocus = null
function openGlobalSearch() {
  dismissGlobalSearch()
  const overlay=document.createElement('div');overlay.id='global-search';overlay.className='global-search-overlay'
  // §6：浮层是对话框——补语义 + 焦点陷阱 + 关闭归还焦点，Tab 不再逃到底层页面。
  overlay.setAttribute('role','dialog');overlay.setAttribute('aria-modal','true');overlay.setAttribute('aria-label','全局搜索')
  overlay.innerHTML=`<div class="global-search-box">
    <input type="search" id="global-search-input" placeholder="搜索功能…（如：登录QQ / 主动联系 / 换模型）" autocomplete="off" />
    <div class="global-search-results" id="global-search-results"></div>
  </div>`
  document.body.appendChild(overlay)
  globalSearchReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
  overlay.addEventListener('click',e=>{if(e.target===overlay)dismissGlobalSearch()})
  const input=overlay.querySelector('#global-search-input')
  input.focus()
  input.addEventListener('input',()=>{
    const results=searchFeatures(input.value)
    const container=overlay.querySelector('#global-search-results')
    if(!input.value.trim()){container.innerHTML='<p class="gs-hint">输入关键词搜索功能和设置</p>';return}
    if(!results.length){container.innerHTML='<p class="gs-hint">没有匹配的功能</p>';return}
    container.innerHTML=results.map((r,i)=>`<button data-gs-index="${i}" class="gs-result">
      <div class="gs-title">${escapeHtml(r.title)}</div>
      <div class="gs-desc">${escapeHtml(r.desc)}</div>
      <div class="gs-location">AT ${escapeHtml(r.location)}</div>
    </button>`).join('')
    container.querySelectorAll('.gs-result').forEach(btn=>{
      btn.addEventListener('click',()=>{dismissGlobalSearch();results[+btn.dataset.gsIndex]?.action?.()})
    })
  })
  input.addEventListener('keydown',e=>{
    if(e.key==='Enter'){const first=overlay.querySelector('.gs-result');if(first)first.click()}
  })
  overlay.addEventListener('keydown',e=>{
    if(e.key==='Escape'){e.preventDefault();dismissGlobalSearch();return}
    if(e.key!=='Tab')return
    const focusables=[...overlay.querySelectorAll('input,button')].filter(el=>!el.disabled&&el.getClientRects().length>0)
    if(!focusables.length)return
    const first=focusables[0],last=focusables[focusables.length-1]
    if(e.shiftKey&&(document.activeElement===first||document.activeElement===overlay)){e.preventDefault();last.focus()}
    else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus()}
  })
}
function dismissGlobalSearch(){
  document.getElementById('global-search')?.remove()
  const el=globalSearchReturnFocus;globalSearchReturnFocus=null
  if(el&&el.isConnected)el.focus()
}

// ============================================================
// P2-4: 全局 Toast 反馈系统
// ============================================================
/** 历史调用点混用 success/error/warn（CSS 只定义 ok/err/info）——统一映射，
 *  未知类型回退 info，不再出现无样式的透明提示。 */
const TOAST_TYPE_ALIASES = { ok: 'ok', success: 'ok', err: 'err', error: 'err', warn: 'warn', info: 'info' }
function showToast(message,type='info',duration=3500){
  const kind = TOAST_TYPE_ALIASES[type] ?? 'info'
  let container=document.getElementById('toast-container')
  if(!container){container=document.createElement('div');container.id='toast-container';container.setAttribute('role','status');container.setAttribute('aria-live','polite');document.body.appendChild(container)}
  const toast=document.createElement('div');toast.className=`toast toast-${kind}`
  // §6：role 挂在每个 toast 上——err 用 alert（读屏立即播报），其余 status。
  // 挂入打开 dialog 的 toast 脱离 #toast-container 的 aria-live，必须自带语义。
  toast.setAttribute('role', kind === 'err' ? 'alert' : 'status')
  toast.textContent=message
  // dialog 的 top layer 永远高于页面的 z-index——模态打开时把提示挂进
  // 弹窗内部，否则保存失败/安装结果等反馈正好发生在被遮挡的时刻。
  const openDialog=document.querySelector('dialog[open]')
  ;(openDialog ?? container).appendChild(toast)
  setTimeout(()=>{toast.classList.add('toast-out');setTimeout(()=>toast.remove(),300)},duration)
}


// ═══════════════════════════════════════════════════════════════════════════
// 语义分析面板：情绪×场景 / 事实地图 / 压缩健康 / 叙事节奏
// ═══════════════════════════════════════════════════════════════════════════

var analysisState = { data: null, loading: false, lastStoryId: '', requestSeq: 0 }
function refreshSemanticAnalysis() {
  analysisState.data = null; analysisState.lastStoryId = ''; analysisState.loading = false
  analysisState.requestSeq = (analysisState.requestSeq || 0) + 1
  lastRenderedSnapshotKey = ''
  renderArrangement()
}

async function renderAnalysisView(target, story) {
  if (!story.running || !story.bridgeReady) {
    analysisState.requestSeq = (analysisState.requestSeq || 0) + 1
    analysisState.data = null; analysisState.loading = false; analysisState.lastStoryId = ''
    renderUiState(target,{kind:'idle',title:'语义分析尚未就绪',body:'加载当前故事的 Worker 后，才能读取分析能力与数据。',action:'加载 Worker',onAction:loadSelected})
    return
  }
  if (analysisState.loading && analysisState.lastStoryId === story.meta.id) {
    target.innerHTML = '<div class="analysis-loading">正在获取语义分析数据…</div>'
    return
  }
  if (!analysisState.data || analysisState.lastStoryId !== story.meta.id) {
    analysisState.loading = true; analysisState.lastStoryId = story.meta.id
    target.innerHTML = '<div class="analysis-loading">正在获取语义分析数据…</div>'
    const requestSeq = analysisState.requestSeq = (analysisState.requestSeq || 0) + 1
    try {
      const data = await desktop.stories.semanticAnalysis(story.meta.id)
      if (requestSeq !== analysisState.requestSeq) return
      analysisState.data = data
    } catch (error) {
      // 与成功路径同款守卫：失败页也不得写进已切换的视图。
      if (requestSeq !== analysisState.requestSeq || state.browserView !== 'analysis' || state.storyId !== story.meta.id) return
      const unsupported = /未提供|未实现|unsupported|not supported|not implemented|method.not.found/i.test(String(error))
      renderUiState(target,{kind:unsupported?'unsupported':'error',title:unsupported?'当前插件未提供语义分析':'语义分析读取失败',body:unsupported?'这是能力边界，不代表故事运行失败。可以继续阅读剧本或查看时间线。':'请检查 Worker 状态或诊断日志，再重试读取。',detail:String(error),action:'重新读取',onAction:refreshSemanticAnalysis})
      return
    } finally {
      if (requestSeq === analysisState.requestSeq) analysisState.loading = false
    }
    // 审计修复：请求期间用户可能已切走视图/剧本——晚到的结果不得覆盖新视图。
    if (state.browserView !== 'analysis' || state.storyId !== story.meta.id) return
  }
  const d = analysisState.data
  if (!d) { renderUiState(target,{title:'尚无分析样本',body:'当前接口可用，但还没有返回分析数据。积累故事记录后可重新读取。',action:'重新读取',onAction:refreshSemanticAnalysis}); return }
  const wrap = document.createElement('div'); wrap.className = 'analysis-rack'
  // 同一故事的分析数据此前只取一次且无刷新入口——面板永远显示第一次进入时的陈旧快照
  const refreshButton = document.createElement('button')
  refreshButton.type = 'button'
  refreshButton.className = 'browser-item'
  refreshButton.style.cssText = 'width:auto;margin:0 0 8px;padding:4px 10px'
  refreshButton.textContent = '↻ 刷新分析数据'
  refreshButton.addEventListener('click', refreshSemanticAnalysis)
  wrap.appendChild(refreshButton)
  // §12.1：数据范围 + 更新时间 + 完整性（语义分析由 Worker 一次性返回）
  const analysisMeta = document.createElement('div'); analysisMeta.className = 'view-meta'
  analysisMeta.innerHTML = `<span>数据范围：全时间线（语义分析快照）</span><span>更新：手动刷新 · ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}</span>`
  wrap.appendChild(analysisMeta)
  // §12.2 可追溯性：每张卡提供"定位到时间线"——跳到 Studio 时间线并居中到
  // 该主题相关的最近时刻（压缩=上次压缩时间；情绪=最近场景起点；事实= updatedAt）
  const locate = (label, isoTime) => {
    const btn = document.createElement('button')
    btn.type = 'button'; btn.className = 'analysis-locate'; btn.textContent = '⌖ 定位到时间线'
    btn.title = `在时间线上定位「${label}」附近的条目`
    btn.addEventListener('click', () => {
      const t = toMillis(isoTime)
      setStudioView('timeline')
      updateViewport(() => ({ center: Number.isFinite(t) ? t : Date.now(), spanMinutes: Math.min(layoutFor().spanMinutes, 6 * 60), followNow: false }))
      showToast(`已定位到时间线：${label}`, 'info')
    })
    return btn
  }
  const cards = [
    buildCompactionHealth(d.compactionHealth),
    buildNarrativeCoherence(d.narrativeCoherence),
    buildEmotionScenes(d.emotionScenes, d.sceneSimilarities),
    buildFactMap(d.factMap),
  ]
  const anchors = [
    d.compactionHealth?.lastCompactionAt,
    d.narrativeCoherence?.[0]?.occurredAt ?? d.narrativeCoherence?.[0]?.endAt,
    d.emotionScenes?.[0]?.startedAt ?? d.sceneSimilarities?.[0]?.occurredAt,
    d.factMap?.nodes?.[0]?.updatedAt,
  ]
  const labels = ['压缩健康', '叙事连贯性', '情绪与场景', '语义记忆地图']
  cards.forEach((card, index) => {
    if (anchors[index]) {
      const actions = document.createElement('div'); actions.style.cssText = 'display:flex;justify-content:flex-end;padding:4px 8px 8px'
      actions.appendChild(locate(labels[index], anchors[index]))
      card.appendChild(actions)
    }
    wrap.appendChild(card)
  })
  target.replaceChildren(wrap)
}

function buildCompactionHealth(h) {
  const card = document.createElement('div'); card.className = 'analysis-card'
  // 复审：maxFacts=0 或字段缺失时不得产出 NaN/Infinity（width:NaN% 与告警文案污染）。
  const safePct = v => (Number.isFinite(v) ? Math.min(100, Math.round(v)) : 0)
  const bar = (label, pct, detail) => '<div class="analysis-bar-row"><span class="analysis-bar-label">' + escapeHtml(label) + '</span><div class="analysis-bar"><div class="analysis-bar-fill" style="width:' + safePct(pct) + '%"></div></div><span class="analysis-bar-value">' + escapeHtml(detail ?? safePct(pct) + '%') + '</span></div>'
  const health = h ?? {}
  const factsRatio = health.maxFacts > 0 ? health.activeFacts / health.maxFacts : 0
  const warnings = []
  if (factsRatio > 0.8) warnings.push('事实接近上限：' + health.activeFacts + '/' + health.maxFacts)
  if (health.embeddingCoverage < 30 && health.totalEntries > 50) warnings.push('嵌入覆盖率低（' + health.embeddingCoverage + '%）：语义召回可能漏条目')
  card.innerHTML = '<div class="analysis-card-title">STATS 压缩健康</div>'
    + bar('条目压缩', health.coveragePercent)
    + bar('事实饱和', factsRatio * 100, health.activeFacts + '/' + health.maxFacts)
    + bar('嵌入覆盖', health.embeddingCoverage)
    + '<div class="analysis-meta-row"><span>场景 ' + health.activeScenes + ' 活跃 / ' + health.closedScenes + ' 已关</span><span>工作细节 ' + health.workingDetailCount + (health.expiredWorkingDetails ? '（' + health.expiredWorkingDetails + ' 过期）' : '') + '</span><span>嵌入维度 ' + (health.embeddingDimension || '—') + '</span><span>上次压缩 ' + (health.lastCompactionAt ? dateText(health.lastCompactionAt) : '—') + '</span></div>'
    + warnings.map(w => '<div class="analysis-warning">WARNING ' + escapeHtml(w) + '</div>').join('')
  return card
}

function buildNarrativeCoherence(items) {
  const card = document.createElement('div'); card.className = 'analysis-card'
  // 复审：undefined 与 NaN 一并排除（旧过滤只挡 null，undefined 会画出 NaN 坐标）。
  const valid = (Array.isArray(items) ? items : []).filter(i => Number.isFinite(i.similarityToPrev))
  if (!valid.length) {
    card.innerHTML = '<div class="analysis-card-title">RHYTHM 叙事节奏</div><div class="analysis-empty-hint">无嵌入数据——需要开启 Embedding 功能后产生剧本条目。</div>'
    return card
  }
  const width = 800, height = 140, padding = 30
  const minS = Math.min(...valid.map(i => i.similarityToPrev)), maxS = Math.max(...valid.map(i => i.similarityToPrev))
  const yRange = maxS - minS || 1
  const pts = valid.map((item, idx) => {
    const x = padding + (idx / Math.max(1, valid.length - 1)) * (width - padding * 2)
    const y = height - padding - ((item.similarityToPrev - minS) / yRange) * (height - padding * 2)
    return { x: x, y: y, occurredAt: item.occurredAt, similarityToPrev: item.similarityToPrev }
  })
  const path = pts.map((p, i) => (i === 0 ? 'M' : 'L') + p.x + ',' + p.y).join(' ')
  const lowPoints = pts.filter(p => p.similarityToPrev < minS + yRange * 0.2)
  // V2 §12.2：图表点可点击/键盘可达（tabindex+role=button），点击定位时间线；
  // 附表格替代视图（无障碍）——点行同样可定位。
  const circleHtml = (p, isLow) => '<circle data-locate-at="' + p.occurredAt + '" data-sim="' + p.similarityToPrev + '" cx="' + p.x + '" cy="' + p.y + '" r="' + (isLow ? 4 : 2.5) + '" fill="' + (isLow ? '#ff6b6b' : '#ffc900') + '" opacity="' + (isLow ? 1 : 0.6) + '" tabindex="0" role="button" aria-label="' + dateText(p.occurredAt) + ' 相似度 ' + p.similarityToPrev + (isLow ? '（低谷）' : '') + '" style="cursor:pointer"/>'
  card.innerHTML = '<div class="analysis-card-title">RHYTHM 叙事节奏 <small>相邻条目余弦相似度 · 低谷=话题断裂 · 点可定位</small></div>'
    + '<svg viewBox="0 0 ' + width + ' ' + height + '" class="analysis-svg">'
    + '<line x1="' + padding + '" y1="' + (height - padding) + '" x2="' + (width - padding) + '" y2="' + (height - padding) + '" stroke="#333" stroke-width="1"/>'
    + '<path d="' + path + '" fill="none" stroke="#ffc900" stroke-width="2" stroke-linejoin="round"/>'
    + lowPoints.map(p => circleHtml(p, true)).join('')
    + pts.filter(p => !lowPoints.includes(p)).map(p => circleHtml(p, false)).join('')
    + '</svg>'
    + '<div class="analysis-meta-row"><span>' + valid.length + ' 个有嵌入的条目</span><span>相似度 ' + minS.toFixed(3) + '–' + maxS.toFixed(3) + '</span><span>低谷 ' + lowPoints.length + ' 处</span></div>'
    + '<details class="analysis-table-alt"><summary>表格视图（无障碍替代）</summary><table><thead><tr><th>时间</th><th>相似度</th><th></th></tr></thead><tbody>'
    + valid.map(item => '<tr><td>' + escapeHtml(dateText(item.occurredAt)) + '</td><td>' + item.similarityToPrev + '</td><td><button type="button" data-locate-at="' + item.occurredAt + '">定位</button></td></tr>').join('')
    + '</tbody></table></details>'
  card.querySelectorAll('[data-locate-at]').forEach(el => {
    const go = () => {
      const t = toMillis(el.dataset.locateAt)
      setStudioView('timeline')
      updateViewport(() => ({ center: Number.isFinite(t) ? t : Date.now(), spanMinutes: 120, followNow: false }))
      showToast('已定位到时间线：' + dateText(el.dataset.locateAt), 'info')
    }
    el.addEventListener('click', go)
    el.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); go() } })
  })
  return card
}

function buildEmotionScenes(scenes, similarities) {
  const card = document.createElement('div'); card.className = 'analysis-card'
  // 复审：数组可能整体缺失（语义分析未实现时）；hook 缺失不得抛 TypeError。
  const sceneList = Array.isArray(scenes) ? scenes : []
  const sims = Array.isArray(similarities) ? similarities : []
  if (!sceneList.length) {
    card.innerHTML = '<div class="analysis-card-title">SCENE 情绪×场景</div><div class="analysis-empty-hint">无场景数据。</div>'
    return card
  }
  function alterColor(v) { return v > 2 ? '#ff9500' : v > 0.5 ? '#ffd700' : v > -0.5 ? '#666' : v > -2 ? '#4a9eff' : '#2563eb' }
  const rows = sceneList.slice(-20).map(scene => {
    const color = alterColor(scene.avgAlter)
    const dur = scene.endedAt ? Math.round((Date.parse(scene.endedAt) - Date.parse(scene.startedAt)) / 60000) : '—'
    return '<div class="analysis-emotion-row"><div class="analysis-alter-band" style="background:' + color + '" title="alter ' + scene.avgAlter + '"></div><div class="analysis-scene-info"><span class="analysis-scene-hook">' + escapeHtml((scene.hook || scene.summary || scene.id || '').slice(0, 50)) + '</span><span class="analysis-scene-meta">' + dateText(scene.startedAt) + ' · ' + dur + 'min · alter ' + scene.avgAlter + '</span></div></div>'
  }).join('')
  card.innerHTML = '<div class="analysis-card-title">SCENE 情绪×场景 <small>最近 ' + Math.min(20, sceneList.length) + ' 个场景</small></div>'
    + '<div class="analysis-legend"><span style="color:#2563eb">■ 沉重</span><span style="color:#4a9eff">■ 略低</span><span style="color:#666">■ 平稳</span><span style="color:#ffd700">■ 略轻</span><span style="color:#ff9500">■ 严重</span></div>'
    + rows
    + (sims.length ? '<div class="analysis-sim-list">' + sims.slice(0, 8).map(sim => '<span class="analysis-sim-tag">' + escapeHtml(String(sim.sceneA ?? '')) + '↔' + escapeHtml(String(sim.sceneB ?? '')) + ' ' + (Number.isFinite(sim.similarity) ? (sim.similarity * 100).toFixed(0) : '—') + '%</span>').join('') + '</div>' : '')
  return card
}

function buildFactMap(facts) {
  const card = document.createElement('div'); card.className = 'analysis-card'
  const factList = Array.isArray(facts) ? facts : []
  const withEmb = factList.filter(f => f.embedding && f.embedding.length > 0)
  if (!withEmb.length) {
    card.innerHTML = '<div class="analysis-card-title">MAP 语义记忆地图</div><div class="analysis-empty-hint">无事实嵌入——需要开启 Embedding 后经过压缩链路产生。</div>'
    return card
  }
  var dim = withEmb[0].embedding.length
  var means = new Array(dim).fill(0)
  withEmb.forEach(f => f.embedding.forEach((v, i) => { means[i] += v / withEmb.length }))
  var centered = withEmb.map(f => f.embedding.map((v, i) => v - means[i]))
  var pc1 = analysisPowerIter(centered, dim, null)
  var pc2 = analysisPowerIter(centered, dim, pc1)
  var pts = centered.map((vec, idx) => ({ x: analysisDot(vec, pc1), y: analysisDot(vec, pc2), factId: withEmb[idx].factId, content: withEmb[idx].content, importance: withEmb[idx].importance, confidence: withEmb[idx].confidence, relatedFactIds: withEmb[idx].relatedFactIds }))
  var xMin = Math.min.apply(null, pts.map(p => p.x)), xMax = Math.max.apply(null, pts.map(p => p.x))
  var yMin = Math.min.apply(null, pts.map(p => p.y)), yMax = Math.max.apply(null, pts.map(p => p.y))
  var xRange = xMax - xMin || 1, yRange = yMax - yMin || 1
  var width = 600, height = 350, pad = 40
  function px(p) { return pad + ((p.x - xMin) / xRange) * (width - pad * 2) }
  function py(p) { return height - pad - ((p.y - yMin) / yRange) * (height - pad * 2) }
  // V2 §12.2：节点可点击（tabindex+role=button），点击后在 Inspector 显示原始事实。
  var scatter = pts.map(p => {
    var r = 3 + (Number.isFinite(p.importance) ? p.importance : 0) * 8
    var color = p.confidence > 0.8 ? '#4ade80' : p.confidence > 0.5 ? '#ffd700' : '#ff6b6b'
    return '<circle data-fact-id="' + escapeHtml(String(p.factId)) + '" cx="' + px(p) + '" cy="' + py(p) + '" r="' + r + '" fill="' + color + '" opacity="0.8" tabindex="0" role="button" aria-label="事实：' + escapeHtml(String(p.content ?? '').slice(0, 50)) + ' 重要性' + (p.importance ?? '—') + ' 置信度' + (p.confidence ?? '—') + '" style="cursor:pointer"/>'
  }).join('')
  var ptById = {}; pts.forEach(p => { ptById[p.factId] = p })
  var edges = []
  pts.forEach(p => { (Array.isArray(p.relatedFactIds) ? p.relatedFactIds : []).forEach(rid => { if (ptById[rid] && p.factId < rid) edges.push({ a: p, b: ptById[rid] }) }) })
  var edgeSvg = edges.map(e => '<line x1="' + px(e.a) + '" y1="' + py(e.a) + '" x2="' + px(e.b) + '" y2="' + py(e.b) + '" stroke="#555" stroke-width="0.5" opacity="0.4"/>').join('')
  card.innerHTML = '<div class="analysis-card-title">MAP 语义记忆地图 <small>' + withEmb.length + '/' + factList.length + ' 条有嵌入 · 大小=重要性 · 颜色=置信度 · 点看事实</small></div>'
    + '<svg viewBox="0 0 ' + width + ' ' + height + '" class="analysis-svg">' + edgeSvg + scatter + '</svg>'
    + '<div class="analysis-legend"><span style="color:#4ade80">● 高置信</span><span style="color:#ffd700">● 中置信</span><span style="color:#ff6b6b">● 低置信</span><span>── 关联</span></div>'
    + '<details class="analysis-table-alt"><summary>表格视图（无障碍替代）</summary><table><thead><tr><th>事实</th><th>重要性</th><th>置信度</th></tr></thead><tbody>'
    + withEmb.slice(0, 60).map(f => '<tr><td>' + escapeHtml(String(f.content ?? '').slice(0, 80)) + '</td><td>' + f.importance + '</td><td>' + f.confidence + '</td></tr>').join('')
    + '</tbody></table></details>'
  // §12.2：节点点击/回车 → Inspector 显示原始事实摘要
  card.querySelectorAll('[data-fact-id]').forEach(el => {
    const show = () => {
      const fact = withEmb.find(f => String(f.factId) === el.dataset.factId)
      if (!fact) return
      inspect({ type: 'fact', entry: { fact, kind: 'fact', actor: 'system', content: String(fact.content ?? ''), occurredAt: fact.updatedAt, metadata: {} } })
      showToast('事实已在摘要面板显示', 'info')
    }
    el.addEventListener('click', show)
    el.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); show() } })
  })
  return card
}

function analysisDot(a, b) { var s = 0; for (var i = 0; i < Math.min(a.length, b.length); i++) s += a[i] * b[i]; return s }
/** 固定种子 PRNG：PCA 此前用 Math.random 初始化，同一数据两次渲染布局不同，用户会误以为事实关系变了。 */
function analysisSeededRandom(seed) { let t = seed >>> 0; return () => { t += 0x6D2B79F5; let r = Math.imul(t ^ (t >>> 15), 1 | t); t ^= t + Math.imul(r ^ (r >>> 7), 61 | r); return ((r ^ (r >>> 14)) >>> 0) / 4294967296 } }
function analysisPowerIter(data, dim, orthogonalTo) {
  const rand = analysisSeededRandom(0x48445349)
  var v = new Array(dim); for (var i = 0; i < dim; i++) v[i] = rand() - 0.5
  for (var iter = 0; iter < 30; iter++) {
    var next = new Array(dim).fill(0)
    data.forEach(function(vec) { var proj = analysisDot(vec, v); for (var i = 0; i < dim; i++) next[i] += proj * vec[i] })
    var norm = Math.sqrt(analysisDot(next, next)) || 1
    v = next.map(function(x) { return x / norm })
    if (orthogonalTo) { var d = analysisDot(v, orthogonalTo); v = v.map(function(x, i) { return x - d * orthogonalTo[i] }) }
  }
  return v
}

// ── Phase D（§15.2）：窄屏 Inspector 覆盖层 / Browser 抽屉 开合 ────────────
byId('inspector-fab')?.addEventListener('click', () => {
  const panel = byId('inspector-panel'); if (!panel) return
  if (!effectivePanels().inspector) choosePanel('inspector', true)
  panel.classList.toggle('panel-open')
  applyPanelLayout()
})
byId('browser-fab')?.addEventListener('click', () => {
  if (!effectivePanels().browser) choosePanel('browser', true)
  byId('browser-panel')?.classList.toggle('panel-open')
  applyPanelLayout()
})
// 覆盖层/抽屉打开时点击面板外关闭（§15 覆盖层交互惯例）
document.addEventListener('click', event => {
  const inspector = byId('inspector-panel')
  if (inspector?.classList.contains('panel-open')
    && !inspector.contains(event.target)
    && !event.target.closest('[data-panel-toggle="inspector"],#inspector-fab')) { inspector.classList.remove('panel-open'); applyPanelLayout() }
  const browser = byId('browser-panel')
  if (browser?.classList.contains('panel-open')
    && !browser.contains(event.target)
    && !event.target.closest('[data-panel-toggle="browser"],#browser-fab')) { browser.classList.remove('panel-open'); applyPanelLayout() }
}, true)

// ── V2 §16：Tab 方向键切换 + 弹窗关闭后焦点恢复触发按钮 ────────────────────
document.querySelector('.surface-tabs')?.addEventListener('keydown', event => {
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
  const tabs = [...document.querySelectorAll('[data-surface]')]
  const current = tabs.findIndex(tab => tab.getAttribute('aria-selected') === 'true')
  const next = (current + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length
  tabs[next]?.focus()
  tabs[next]?.click()
  event.preventDefault()
})

// §16：弹窗打开记录触发按钮，关闭后恢复焦点（所有 dialog 的 close 统一挂）。
let lastDialogTrigger = null
document.addEventListener('click', event => {
  const trigger = event.target.closest?.('button, [role="button"]')
  if (trigger && !trigger.closest?.('dialog')) lastDialogTrigger = trigger
}, true)
for (const dialog of document.querySelectorAll('dialog')) {
  dialog.addEventListener('close', () => {
    setTimeout(() => { if (lastDialogTrigger?.isConnected) lastDialogTrigger.focus() }, 0)
  })
}

// ── V3/V7：色板主题 + 独立工作台 Profile（V4 默认 / V7 副主题）──────
// 选择即应用并持久化；回退链由 theme/theme-runtime.js 保证（坏主题自动落回
// 上一次可用 → 墨 → 清澄默认），这里只负责卡片渲染与控制。兼容主题的色板
// 用 preview() 只读拉取，不触发应用。
async function initThemeMenu() {
  const themeApi = window.HDSIThemeV3
  const workspaceApi = window.HDSIWorkspaceProfile
  const btn = byId('theme-menu-btn'), dialog = byId('theme-dialog')
  if (!themeApi || !btn || !dialog || !dialog.showModal) return
  // 主题包 compatibility 判定用真实应用版本；通道不可用时保守回退旧基线。
  const appVersionOf = async () => {
    try {
      const value = await window.hdsiDesktop?.packs?.appVersion?.()
      return typeof value === 'string' && value.trim() ? value.trim() : '0.0.1'
    } catch { return '0.0.1' }
  }
  await themeApi.loadCompatIndex()
  // P1 修复：先登记已安装社区包，再恢复持久化主题——否则社区主题在 restore() 时
  // 尚未注册，会被回退链吞掉并覆盖持久化值。失效包（目录损坏/未通过复验）记入
  // failedPacks 在外观页展示与处置，不再只在控制台提示。
  let failedPacks = []
  const reloadPacks = async () => {
    if (!window.HDSIPackManager) return
    const restored = await window.HDSIPackManager.loadInstalled(await appVersionOf())
    failedPacks = Array.isArray(restored?.failed) ? restored.failed : []
  }
  await reloadPacks()
  // UI 测试钩子：注入 listInstalled mock 后重跑恢复路径（与 refreshSnapshot 同惯例）。
  window.__reloadThemePacks = async () => { await reloadPacks(); render() }
  await themeApi.restore()
  // 审计 P1：初始 setSurface/renderConnectView 早于本异步初始化执行——若上次
  // 启用的是社区页面包，首渲染挂载的还是官方页。这里显式重渲当前表面收口时序。
  if (window.HDSIPageRuntime?.activePack()) setSurface(state.surface)

  const compatPreviews = new Map()   // id → 主题定义（含 colors，供卡片色板）
  const preloadCompat = async () => {
    await Promise.all(themeApi.list().compat.map(async entry => {
      try { compatPreviews.set(entry.id, await themeApi.preview(entry.id)) } catch { /* 单套失败只影响该卡片 */ }
    }))
  }

  const swatchStrip = colors => {
    const keys = ['canvas', 'surface', 'surfaceRaised', 'accent', 'success', 'warning', 'danger', 'trackScript', 'trackReceive', 'trackSend']
    return '<span class="theme-swatches" aria-hidden="true">' + keys.map(key => `<i style="background:${colors?.[key] || 'transparent'}"></i>`).join('') + '</span>'
  }

  const card = (meta, current) => {
    const active = current === meta.id
    return `<button type="button" class="theme-card${active ? ' active' : ''}" data-theme-id="${escapeHtml(meta.id)}" aria-pressed="${active}">`
      + `<span class="theme-card-head"><b>${escapeHtml(meta.name)}</b><small>${meta.official ? '官方' : meta.community ? '社区' : 'V2 兼容'} · ${meta.kind === 'light' ? '浅色' : '深色'}</small></span>`
      + swatchStrip(meta.colors)
      + (meta.description ? `<span class="theme-card-desc">${escapeHtml(compact(meta.description, 46))}</span>` : '')
      + '</button>'
  }

  const seg = (container, options, activeValue, onPick) => {
    container.replaceChildren()
    for (const [value, label] of options) {
      const item = document.createElement('button')
      item.type = 'button'
      item.textContent = label
      item.className = value === activeValue ? 'active' : ''
      item.setAttribute('role', 'radio')
      item.setAttribute('aria-checked', String(value === activeValue))
      item.addEventListener('click', () => { onPick(value); render() })
      container.appendChild(item)
    }
  }

  const render = () => {
    const current = themeApi.current() || 'default'
    const status = themeApi.status()
    const official = window.HDSIBuiltinThemes ? window.HDSIBuiltinThemes.list() : []
    const currentMeta = official.find(theme => theme.id === current)
    const workspaceLabel = workspaceApi?.list().find(profile => profile.id === (workspaceApi.current() || 'v4'))?.shortName || 'V4 · 信息工作台'
    byId('theme-current-label').textContent = `${current === 'default' ? '清澄' : (currentMeta ? currentMeta.name : current)} · ${workspaceLabel}`
    const densityNow = document.documentElement.getAttribute('data-hdsi-density') || 'workbench'
    const motionNow = document.documentElement.getAttribute('data-hdsi-motion') || 'subtle'
    const workspaceNow = workspaceApi?.current() || 'v4'
    if (workspaceApi) seg(byId('workspace-profile'), workspaceApi.list().map(profile => [profile.id, profile.shortName]), workspaceNow, value => { workspaceApi.apply(value); showToast(value === 'v7' ? '已切换到 V7 数据状态界面。' : '已恢复 V4 信息工作台。', 'ok') })
    seg(byId('theme-density'), Object.entries(window.HDSITokens.DENSITY_TIERS).map(([id, tier]) => [id, tier.label]), densityNow, value => { themeApi.setUser({ density: value }); showToast(`密度已切换：${window.HDSITokens.DENSITY_TIERS[value].label}`, 'ok') })
    seg(byId('theme-motion'), [['off', '关闭'], ['subtle', '轻微'], ['standard', '标准']], motionNow, value => { themeApi.setUser({ motion: value }); showToast('动效档位已更新。', 'ok') })

    const sections = byId('theme-sections')
    sections.replaceChildren()
    const wrap = document.createElement('div')
    wrap.innerHTML = '<div class="theme-section-title">官方主题（V3 日式出厂）</div>'
      + '<div class="theme-grid">' + card({ id: 'default', name: '清澄', displayName: '清澄 · Kiyosumi', official: true, kind: 'light', colors: window.HDSITokens.CORE_DEFAULTS, description: 'V3 默认纸面工作台：暖白、墨色、靛蓝与朱砂。' }, current) + official.map(theme => card(theme, current)).join('') + '</div>'
    const community = window.HDSIPackManager ? window.HDSIPackManager.list() : []
    if (community.length) {
      wrap.innerHTML += '<div class="theme-section-title">社区主题包（已安装）</div>'
        + `<div class="theme-grid">${community.map(pack => card(pack, current)).join('')}</div>`
        + `<div class="theme-pack-actions"><button type="button" id="pack-export">导出当前官方主题为 .hdsitheme</button><button type="button" id="pack-import">导入主题包…</button></div>`
    } else {
      wrap.innerHTML += '<div class="theme-section-title">社区主题包</div><div class="theme-pack-actions"><button type="button" id="pack-export">导出当前官方主题为 .hdsitheme</button><button type="button" id="pack-import">导入主题包…</button></div>'
    }
    if (failedPacks.length) {
      wrap.innerHTML += '<div class="theme-section-title">已失效的主题包（恢复时未通过验证，未加载）</div>'
        + `<div class="pack-failed-list">${failedPacks.map(pack => `<div class="pack-failed-card" data-pack-id="${escapeHtml(pack.id)}"><div class="pack-failed-info"><b>${escapeHtml(pack.id)}</b><small>${escapeHtml(compact(pack.reason, 72))}</small></div><span class="pack-failed-actions"><button type="button" class="pack-retry">重试</button><button type="button" class="pack-failed-uninstall">卸载</button></span></div>`).join('')}</div>`
    }
    // 绑定在 wrap（尚未 append）上——此前误查 sections 导致导入/导出按钮从不挂事件。
    wrap.querySelectorAll('#pack-import').forEach(item => item.addEventListener('click', async () => {
      // 两段式导入：先验证不安装，预览确认后才落盘（第二批导入体验批次）。
      const picked = await window.HDSIPackManager.pickAndValidate(await appVersionOf())
      if (picked.cancelled) return
      openPackPreview(picked.report, picked.entries)
    }))
    wrap.querySelectorAll('#pack-export').forEach(item => item.addEventListener('click', async () => {
      const currentId = themeApi.current() || 'default'
      const officialId = currentId.startsWith('hdsi-') ? currentId : 'hdsi-japanese-light'
      const result = await window.HDSIPackManager.exportTheme(officialId)
      showToast(result.ok ? `已导出到 ${result.path}` : `导出失败：${result.error}`, result.ok ? 'ok' : 'err')
    }))
    wrap.querySelectorAll('.pack-failed-uninstall').forEach(item => item.addEventListener('click', async () => {
      const id = item.closest('.pack-failed-card')?.dataset.packId || ''
      const okUninstall = await window.HDSIPackManager.uninstall(id)
      if (okUninstall) { failedPacks = failedPacks.filter(entry => entry.id !== id); showToast(`已卸载失效包 ${id}。`, 'ok'); render() }
      else showToast('卸载失败，请手动删除该包目录。', 'err')
    }))
    wrap.querySelectorAll('.pack-retry').forEach(item => item.addEventListener('click', async () => {
      await reloadPacks()
      render()
      showToast(failedPacks.length ? `仍有 ${failedPacks.length} 个失效包。` : '失效包已全部恢复。', failedPacks.length ? 'err' : 'ok')
    }))
    if (themeApi.list().compat.length) {
      const compatCards = themeApi.list().compat.map(entry => compatPreviews.get(entry.id)).filter(Boolean).map(theme => card(theme, current)).join('')
      wrap.innerHTML += '<div class="theme-section-title">V2 兼容主题（L0 自动转换）</div>'
        + `<div class="theme-grid">${compatCards || '<span class="theme-card-desc">色板加载中…</span>'}</div>`
    }
    sections.appendChild(wrap)
    byId('theme-status-note').textContent = status.status === 'fallback' ? `已回退主题（${status.reason || '加载失败'}），可在上方重新选择。` : ''
    sections.querySelectorAll('[data-theme-id]').forEach(item => item.addEventListener('click', async () => {
      const id = item.dataset.themeId
      const ok = id === 'default' ? await themeApi.reset() : await themeApi.apply(id)
      // P1 修复：社区包主题同时激活其页面定义；离开社区主题时解除。
      // 审计 P2：仅主题真正应用成功才切换页面包——失败回退时不得留下主题/页面错位。
      if (ok && window.HDSIPageRuntime) {
        const pack = window.HDSIPackManager?.list().find(item => item.id === id)
        window.HDSIPageRuntime.setActivePack(pack?.pageCount ? id : '')
      }
      showToast(ok ? '主题已切换。' : '主题加载失败，已回退。', ok ? 'ok' : 'err')
      render()
    }))
  }

  // 导入预览：验证结果 → 对话框展示（身份/判定/诊断/色板/预览图/页面清单），
  // 确认后才安装。预览 SVG 只来自通过验证的包（验证器已拒绝脚本/事件属性/外链），
  // 内联注入不触发 CSP 的资源加载，脚本类内容另被 CSP 双重拦截。
  const openPackPreview = (report, entries) => {
    const previewDialog = byId('pack-preview-dialog')
    if (!previewDialog?.showModal) {
      if (report.verdict === 'block') { showToast(`导入被阻断：${report.errors[0]}`, 'err'); return }
      void window.HDSIPackManager.installValidated(report, entries).then(done => {
        showToast(done.ok ? '主题包已导入。' : done.error, done.ok ? 'ok' : 'err'); render()
      })
      return
    }
    const summary = window.HDSIPackManager.summarize(report, entries)
    const blocked = report.verdict === 'block'
    const verdictEl = byId('pack-preview-verdict')
    verdictEl.textContent = blocked ? `阻断 · ${summary.counts.errors} 项错误` : report.verdict === 'pass-with-warnings' ? `通过 · ${summary.counts.warnings} 条警告` : '通过'
    verdictEl.className = `pack-verdict ${blocked ? 'pack-verdict-block' : summary.counts.warnings ? 'pack-verdict-warn' : 'pack-verdict-pass'}`
    const identity = summary.identity
    const metaBits = [identity.version && `v${identity.version}`, identity.author, identity.license].filter(Boolean).map(escapeHtml).join(' · ')
    const swatches = '<span class="theme-swatches" aria-hidden="true">' + summary.swatches.map(color => `<i style="background:${/^#[0-9a-f]{3,6}$/i.test(color) ? color : 'transparent'}"></i>`).join('') + '</span>'
    const pagesHtml = summary.pages.length
      ? `<div class="pack-preview-block"><b>接管页面（${summary.pages.length}）</b><ul>${summary.pages.map(page => `<li><code>${escapeHtml(page.file)}</code> ${escapeHtml(page.id)}${page.title ? ` · ${escapeHtml(compact(page.title, 24))}` : ''}</li>`).join('')}</ul></div>`
      : ''
    const diagnostics = summary.diagnostics
    const diagHtml = diagnostics.length
      ? `<div class="pack-preview-block"><b>${blocked ? '阻断原因' : '警告'}</b><ul class="pack-diag-list">${diagnostics.slice(0, 12).map(item => `<li class="pack-diag-${item.level === 'error' ? 'error' : 'warn'}"><code>${escapeHtml(item.code)}</code><span class="pack-diag-path">${escapeHtml(item.path)}</span>${escapeHtml(item.message)}${item.hint ? `<small>${escapeHtml(item.hint)}</small>` : ''}</li>`).join('')}${diagnostics.length > 12 ? `<li>…其余 ${diagnostics.length - 12} 项</li>` : ''}</ul></div>`
      : ''
    byId('pack-preview-body').innerHTML =
      `<div class="pack-preview-identity"><strong>${escapeHtml(identity.name || identity.id || '未知主题包')}</strong>${metaBits ? `<span>${metaBits}</span>` : ''}${identity.description ? `<small>${escapeHtml(compact(identity.description, 80))}</small>` : ''}</div>`
      + (summary.previewSvg ? `<div class="pack-preview-art">${summary.previewSvg}</div>` : '')
      + `<div class="pack-preview-block">${swatches}</div>`
      + pagesHtml + diagHtml
    byId('pack-preview-note').textContent = blocked ? '验证未通过，不会安装；按提示修正后重新导入。' : '安装后可在社区主题区启用；卸载随时可用。'
    const confirmBtn = byId('pack-preview-confirm')
    confirmBtn.disabled = blocked
    confirmBtn.textContent = blocked ? '不可安装' : '安装'
    confirmBtn.onclick = async () => {
      if (confirmBtn.disabled) return
      previewDialog.close()
      const done = await window.HDSIPackManager.installValidated(report, entries)
      const previewTarget = byId('theme-sections') || dialog
      await runThemeInteraction('themePreview', done.ok ? 'success' : 'error', previewTarget)
      showToast(done.ok ? (report.warnings.length ? `已导入（${report.warnings.length} 条警告）。` : '主题包已导入。') : done.error, done.ok ? 'ok' : 'err')
      render()
    }
    byId('pack-preview-cancel').onclick = () => previewDialog.close()
    byId('pack-preview-close').onclick = () => previewDialog.close()
    previewDialog.showModal()
    confirmBtn.focus()
  }

  const open = async () => {
    if (!compatPreviews.size) await preloadCompat()
    render()
    dialog.showModal()
    byId('theme-close')?.focus()
  }
  btn.addEventListener('click', open)
  byId('theme-close')?.addEventListener('click', () => dialog.close())
  byId('theme-reset')?.addEventListener('click', async () => { await themeApi.reset(); showToast('已恢复清澄默认色板。工作台主题保持不变。', 'ok'); render() })
  document.addEventListener('keydown', event => {
    if (event.ctrlKey && event.shiftKey && (event.key === 'T' || event.key === 't')) { event.preventDefault(); open() }
  })
}
void initThemeMenu()

// ── V3 §21/§34 阶段3：声明式页面登记与挂载 ────────────────────────────────
// connect-main 页 = row(.connect-layout) [ConnectSteps, ConnectSidePanel]。
// DOM 与旧版逐层一致；社区 UI 包经 HDSIPageRuntime.registerPack + setActivePack
// 即可整体替换此页（校验/必需字段/渲染失败自动回退官方页）。
function initSemanticPages() {
  const dsl = window.HDSILayoutDSL, pages = window.HDSIPageRuntime
  if (!dsl || !pages) return
  const fromHtml = html => { const holder = document.createElement('div'); holder.innerHTML = html; return holder.firstElementChild }
  dsl.registerComponent('ConnectSteps', { version: '1.0.0', accepts: [], render: () => fromHtml(connectParts.stepsHtml) })
  dsl.registerComponent('ConnectSidePanel', { version: '1.0.0', accepts: [], render: () => fromHtml(connectParts.sideHtml) })
  pages.registerOfficial({
    page: {
      id: 'connect-main', route: 'connect', title: { fallback: '连接与账号' }, viewModel: 'app',
      layout: {
        type: 'row', className: 'connect-layout',
        children: [
          { type: 'component', component: 'ConnectSteps' },
          { type: 'component', component: 'ConnectSidePanel' },
        ],
      },
    },
  })
}
void initSemanticPages()

// V2 F7：更多菜单代理（原顶栏 Help/Import 收拢于此）
const closeMoreMenu = () => document.querySelector('#more-menu[open]')?.removeAttribute('open')
byId('responsive-theme-menu')?.addEventListener('click', () => { closeMoreMenu(); byId('theme-menu-btn')?.click() })
byId('responsive-new-story')?.addEventListener('click', () => { closeMoreMenu(); byId('new-story')?.click() })
byId('open-help-menu')?.addEventListener('click', () => { closeMoreMenu(); byId('help-dialog')?.showModal() })
byId('import-story-menu')?.addEventListener('click', async () => {
  closeMoreMenu()
  const targetId = await hostPrompt({ title: '导入剧本目录', label: '导入后的本地剧本 ID（原目录不会被修改）：', confirmLabel: '下一步' }); if (!targetId || !targetId.trim()) return
  const name = await hostPrompt({ title: '导入剧本目录', label: `导入后显示的剧本名称（可留空，默认沿用「${targetId.trim()}」）：`, confirmLabel: '导入' })
  try {
    const result = await desktop.stories.import(targetId.trim(), name?.trim() || undefined)
    if (!result.canceled) { appendLog({ storyId: result.id, line: `已导入剧本；原始 ID 为 ${result.originalId}。请在本机重新配置密钥和渠道绑定。` }); showToast('剧本已导入，请重新配置密钥与渠道绑定。', 'ok') }
    await refresh()
  } catch (error) { reportUserError('shell', `导入失败：${error}`) }
})

// ── V3 §22/§40.1 语义基础接线：View Model 绑定 + Action Registry ──────────
// 动作处理器保留原有行为（含错误日志与 refresh）；危险动作在此声明 confirm，
// dispatch 侧强制执行，任何 UI 层（含未来主题包）无法绕过。
if (window.HDSIViewModel) {
  window.HDSIViewModel.bind('app', () => ({
    surface: state.surface,
    storyId: state.storyId,
    phase: selectedStory()?.meta?.phase ?? null,
    storyCount: state.stories.length,
    runStateText: byId('run-state-text')?.textContent ?? '',
  }))
  window.HDSIViewModel.bind('logs', () => ({
    total: state.logs.length,
    surface: state.surface,
    following: logView.following,
  }))
}
if (window.HDSIActions) {
  window.HDSIActions.register('story.select', {
    label: '切换故事',
    handler: async id => { selectStory(id); window.HDSIViewModel?.notify('app') },
  })
  window.HDSIActions.register('story.setPhase', {
    label: '切换运行状态',
    handler: async phase => {
      const story = selectedStory(); if (!story) return false
      try { await desktop.stories.setPhase(story.meta.id, phase); await refresh() } catch (error) { appendLog({ storyId: story.meta.id, line: `切换状态失败：${error}` }); throw error }
    },
  })
  window.HDSIActions.register('timeline.refresh', { label: '刷新时间线', handler: async () => { await refresh(); window.HDSIViewModel?.notify('app') } })
  window.HDSIActions.register('config.open', { label: '打开配置', handler: async storyId => { openConfig(storyId || state.storyId) } })
}






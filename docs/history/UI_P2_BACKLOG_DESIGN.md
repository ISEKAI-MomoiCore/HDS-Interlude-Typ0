# UI P2 遗留问题设计文档（即时版）

- 日期：2026-10-17
- 来源：typ-0 渲染层前端审查（交互链路专项：事件绑定 / 状态同步 / 异步竞态 / UI 反馈）
- 状态：**已实施（2026-10-17，含审查修订）**。六项全部修复并通过全部测试套件；实施记录见 §8——其中 §1 在对照审查中发现比本文档更根本的成因（`hidden` 失效），已按修订后的根因修复。
- 行号约定：以 2026-10-17 修复后的 `desktop/src/renderer` 为准，仅作定位参考；关键锚点同时给出函数名。

---

## 0. 已修复项速览（背景，不在本文档范围）

| 级别 | 项 | 修复落点 |
| --- | --- | --- |
| P0 | `.studio-shell` 缺 `display:grid` | style.css（骨架声明 + 注释） |
| P0 | `.surface` 无可见性规则 | workspace-layout.css `.surface:not(.active){display:none}` |
| P1 | 保存群聊配置静默开启意愿门 | app.js 两处保存路径改为 `enabled: preset==='custom'` |
| P1 | 向导任意步骤 Enter 直接创建 | submit 处理器加 `wizardStep!==6 \|\| wizardSubmitting` 双守卫 + 提交锁 |
| P1 | 右键菜单作用于错误故事 | 删重复"加载 Worker"；备份改走 `backupStoryById(id)` |
| P1 | 日志页被后台刷新重置 | `logHydratedFor` 标记按故事重建；paused 缓冲保留；滚底恢复走 `resumeLogFollow()` |
| P1 | 加载失败时"保存全部"仍可点 | 与 `config-save` 同步禁用/恢复 |
| P1 | Stats/Analysis 晚到回写污染视图 | stats 补 `browserView` 守卫；analysis catch 分支同款 |
| P1 | 按钮焦点废掉全局快捷键 | keydown 重排：组合键 → F5/? → 模态屏蔽 → Space 焦点豁免 |
| P1 | `openAccountPanel` 未定义变量 | 定位 `connect-main` + flash-highlight 加/删（高亮首次真正生效） |
| P1 | Toast 类型名不匹配 + 模态内不可见 | `TOAST_TYPE_ALIASES` 归一 + `.toast-warn` + aria-live + 挂入打开的 dialog |
| P2 | Inspector `segments` 空保护 | `(action.segments ?? [])` |
| P2 | CSP 拦 preload 失败页 reload 按钮 | data 属性 + addEventListener |
| P2 | `window.open` 不走系统浏览器 | main.ts `setWindowOpenHandler`（http→openExternal，其余 deny） |
| P2 | Mixer 预设高亮跨组互斥 | 清除作用域收窄到 `.preset-group` |

回归测试：`scripts/test-button-interactions.cjs` 新增三条（studio-shell 计算样式 / surface 真实可见性 / 向导非末步 Enter 不创建且末步正常创建）；`scripts/test-b-fixes.cjs` 合成 submit 路径适配新守卫。

---

## 1. story-dialog 矮视口溢出（修复中发现，建议升为 P1.5）

**优先级理由**：这是功能不可达，不是体验瑕疵——默认窗口高度（main.ts：860px）下 6/6 步的"创建并检查"按钮落在视口外，且 `body{overflow:hidden}`（style.css UI-27）使页面无法滚动补救。矮屏/小窗口用户**物理上无法完成创建**。当前测试用 JS click 绕过，掩盖了该问题。

**证据**：
- `index.html` `#story-dialog` 为普通 `dialog`，无 `max-height`/内部滚动约束（对照：`#help-dialog` 已有 `max-height:82vh` + `.help-body` overflow:auto 的正确范式）。
- 实测（1440×900 无头视口）：6/6 页脚按钮 rect `y≈1048`，`elementFromPoint` 返回 null；body overflow:hidden，无可滚容器。

**设计**：
1. `#story-dialog { max-height: calc(100vh - 48px); display: flex; flex-direction: column; }`
2. 表单主体（步骤区）包一层可滚容器：`.wizard-body { overflow: auto; min-height: 0; }`；header 与 footer（上一步/下一步/提交）固定在 dialog 流的两端，**任何视口高度下页脚恒可达**。
3. 步骤切换时保持滚动位置在顶部（新步骤从头上读起）：`updateWizardUI()` 中 `wizardBody.scrollTop = 0`。
4. 验收：
   - 600px 视口高度下走完 6 步，提交按钮始终可见可点（真实坐标点击，非 JS click）。
   - 现有 test:buttons / test:bfixes 全绿；把其中的 JS click 换回 `page.click` 仍通过（作为本项的回归断言）。

**风险**：dialog flex 化对旧样式（footer 按钮 `hidden` 切换引起的跳动）影响小；需目检各步骤在 860px 默认高度下的布局。

---

## 2. 故事列表 / 下拉框全量重建（焦点与展开态被销毁）

**问题**：`refresh()` 每次执行 `renderStoryList()` + `renderContext()`，两者均 `replaceChildren` 重建全部节点。`refresh()` 由 `story:inbox`、`stories:changed`、`story:phase` 等后台事件高频触发——用户正在展开故事下拉、聚焦某故事按钮或滚动列表时，DOM 被整体换掉：焦点丢失、下拉收起、滚动位置归零。

**证据**：
- `renderStoryList()`：`const list = byId('story-list'); list.replaceChildren()` 后逐个 `appendChild`。
- `refresh()`：`renderStoryList(); renderContext(); renderLogs(); …` 无条件执行。
- `desktop.onStoryPhase(refresh)`、`desktop.onStoryInbox(() => { refresh(); … })`。

**设计**（增量 reconcile，两档实施）：
1. **保守档（先做，零结构变更）**：重建前检查归属——`document.activeElement` 位于 `#story-list` / `#story-select` / 任一 `.browser-section[open]` 内时，跳过本轮 `renderStoryList()`/`renderContext()`，只在下一拍（焦点离开后）补一次。实现为一个 `deferredListRefresh` 标志 + focusout 监听。
2. **正确档（后做）**：按 id 增量 reconcile——维持 `Map<storyId, node>`，diff `state.stories`：新增建节点、移除删节点、存在则只更新会变的字段（`selected`/`running`/`bridgeReady` 类名、LED、LIVE/OFFLINE 文案）。分支树的缩进与顺序变化时才整列重排。
3. 验收：
   - 消息到达时，聚焦在列表内某按钮上，`document.activeElement` 不变、焦点环不丢。
   - `details.browser-section` 的 open 态在 refresh 后保持。
   - 增删故事（外部删除/新建）后列表正确反映。

**边界**：故事数量在几十量级，reconcile 的复杂度可接受；注意 `buildBranchTree` 排序变化导致的移动需要整段重排（仅对该子树）。

---

## 3. 状态栏模型状态长期"检查中" + updateStatusBar 竞态

**问题（两半）**：
1. `modelCheck` 只来自 `connectState.readiness`，而 `renderReadyPanel()` 仅在连接页语境刷新（boot 一次、`state.surface==='connect'` 的 refresh 分支、连接事件且 surface 为 connect）。常驻 Studio 时状态栏永远显示"模型：检查中"。
2. `updateStatusBar()` 在 await 后不校验故事是否已切换：快速切故事时显示上一个故事的通道状态。

**证据**：`updateStatusBar()` 内 `const modelCheck = (connectState.readiness?.checks ?? []).find(check => check.id === 'model')`；`renderReadyPanel()` 三处调用点均有 `surface === 'connect'` 门槛；`updateStatusBar` 的 `await`（通道探测）之后直接写 `channelEl.textContent`。

**设计**：
1. 把 readiness 的刷新从"渲染连接页"解耦成数据任务：`refreshReadiness()`（带 60s TTL 缓存 + 在途去重），由 `refresh()` 在 TTL 过期时无条件调用，与 surface 无关；`renderReadyPanel` 与 `updateStatusBar` 都只读缓存。
2. `updateStatusBar()` 进入时快照 `const storyId = state.storyId`，await 后 `storyId !== state.storyId` 则直接 return（同 stats/analysis 的守卫范式）。
3. 验收：常驻 Studio 发生任意后台事件后，状态栏模型项在 TTL 窗口后变为 ok/warn/err 实态；连点两个故事，状态栏不出现张冠李戴的通道文案。

**边界**：readiness 探测是 IPC 读，TTL 防止高频事件放大；盲区=首次进入 Studio 后最多 TTL 秒内仍显示"检查中"，可接受。

---

## 4. HUD 硬编码假数据

**问题**：`renderStoryHud` 的 Story Pulse / Next Move / Scene 卡片里混着**字面量假数据**，用户会误以为来自真实快照：
- `'平静 · 有暗流'`（有 entries 时的固定文案）、`'最近 ${N} 回合情绪张力缓慢上升'`（固定句式）
- `'in 32m'`（Next Move 固定值）、`'SCENE 04'`（固定场景号）、fallback `'RAIN AT THE CROSSING'`

**证据**：`renderStoryHud` 的 signals 区块与 scene 按钮模板。

**设计**（三选一，推荐 a）：
- **a. 删除不可推导项**：Story Pulse 的情绪文案、张力趋势句、`in 32m`、`SCENE 04` 全部移除或替换为可从快照推导的值（preplan 下一项的真实剩余分钟数；scene 的真实序号——若快照无此字段则不显示该徽标）。假数据宁可缺省不可编造。
- b. 占位样式化：保留视觉结构，假数据改为明显的占位符（`—`）+ tooltip "等待快照字段"。
- c. 扩投影：主进程 timeline 投影补 `alterTrend`/`nextPreplanInMin` 字段后前端如实渲染（改动面最大，跨进程）。
- 验收：HUD 每一个显示值都能在 `state.snapshot` / hostOverview 中指出来源字段；grep `32m|SCENE 0|有暗流|缓慢上升` 无命中。

---

## 5. "保存当前分区"的实际语义是全部结构化节

**问题**：非 YAML 分支的"保存当前分区"按钮调用 `saveConfigSections()`，后者**依次写入 storyDefaults / userAccounts / groupChats / botAccounts / providers 全部五节**。文案让用户以为只保存当前标签页；实际会把其它标签页的未保存草稿一并提交——这也是已修意愿门问题（§0）曾经的放大器：改一次人设就可能触发群聊配置回写。

**证据**：`config-save` 处理器 else 分支 `await saveConfigSections(configuredStoryId)`；`saveConfigSections` 内五个 `configSection` 写。

**设计**：
1. 数据层：`serializeConfigSections()` 已按节产出，新增 `saveConfigSection(storyId, section)`（单节写 + needsReload 聚合）。
2. 行为分两档：
   - **语义对齐（推荐）**：按钮按当前 `configState.tab` 只写对应节；dirty 徽标按节显示。
   - 保守替代：保持全节写入，但按钮文案改为"保存全部结构化分区"并在确认框列明将写入的节（复用 `configDraftSummary()` 的 parts 文案）。
3. 与 §0 已修意愿门的联动：单节写后，改人设不再触碰 groupChats，该类事故面从根上收窄。
4. 验收：只改 storyDefaults 标签时，mock 的 configSection 写入序列仅含 storyDefaults；"保存全部"路径不回归（现有 test:bfixes 配置写断言保持）。

---

## 6. 无障碍缺口（键盘与读屏）

**问题**：
- 全局搜索（`openGlobalSearch`）无 `role="dialog"`/`aria-modal`/焦点陷阱：打开后 Tab 会跑到底层页面，Esc 行为部分依赖键盘监听。
- 上下文菜单（`showContextMenu`/`bindContextMenu`）仅鼠标可达（帮助页已注明，但仍是交互缺口）：无 `role="menu"`/`menuitem`、无方向键导航、无 Esc 关闭的 aria 通告。
- Toast 已加 `role="status" aria-live="polite"`（§0 已修），但**错误类**（err）建议升级为 `role="alert"`，读屏对失败立即播报。

**设计**：
1. 搜索浮层：容器补 `role="dialog" aria-modal="true" aria-label="全局搜索"`；打开时聚焦输入框并记录 `previouslyFocused`，关闭（Esc/选中/遮罩点击）时归还焦点；Tab 在浮层内循环（first/last 包装）。
2. 上下文菜单：容器 `role="menu"`、项 `role="menuitem"`；触发按钮 `aria-haspopup="menu"`；方向键上下移动 `aria-activedescendant`、Enter 激活、Esc 关闭并归还焦点；`showContextMenu` 增加 `triggerEl` 参数供归还。
3. Toast：`kind==='err'` 时用 `role="alert"`，其余维持 status。
4. 验收：纯键盘完成"右键菜单打开→选择→执行"（含 Esc 取消）；搜索浮层内 Tab 永不逃逸；axe 或手动读屏过一遍三处控件。

---

## 7. 实施顺序建议

1. **§1 story-dialog 溢出**（功能不可达，最小改动最大收益）
2. **§5 保存语义**（数据误操作面的收口，与已修意愿门同族）
3. **§3 状态栏**（数据任务解耦，顺手补竞态守卫）
4. **§2 列表增量 reconcile**（先保守档，正确档随后）
5. **§4 HUD 假数据**（等 §3 的 readiness 缓存就绪后一起做 UI 态收敛）
6. **§6 无障碍**（独立可并行，建议随 §2 的列表重构一并处理焦点管理）

每项独立可测、独立可回滚；§1/§3/§5 均有明确的单测锚点（真实坐标点击 / TTL 刷新 / 单节写序列）。

---

## 8. 实施记录（2026-10-17，按 §7 顺序执行）

全部六项已修复，回归：`test:buttons`（新增 §1/§2/§6 断言）、`test:bfixes`（新增 §3/§5 断言）与其余全部套件（runtime 75/75、timeline 8/8、ui/theme/interactions/compat-themes/connect/uireview）全绿。

| 节 | 落点 | 与原设计的偏差（审查修订） |
| --- | --- | --- |
| §1 | style.css `.wizard-step[hidden]{display:none!important}`（根因）+ `#story-dialog` flex 限高 + index.html `.wizard-body` 可滚容器 + `updateWizardUI()` 滚动归顶 | **根因修正**：审查实测发现 `.wizard-step{display:grid}` 压过 UA 的 `[hidden]` 规则，六步全部同时渲染才是 dialog 撑到 ~1200px 的直接原因（原设计定性"矮视口溢出"不完整）。先修 hidden（一行），flex 硬化保留为第二步。验收补"非当前步骤不可见"断言；600px 视口真实坐标走查入 test:buttons |
| §5 | app.js `saveConfigSection()`（新增，单节写）+ `config-save` 按 `.config-tab-panel.active` 分流；`CONFIG_PANEL_SECTIONS` 映射常量 | 推荐"语义对齐"方案落地。原设计的 `configState.tab` 实为 DOM 查询（无此状态变量）；secrets/plugins 标签给出独立保存入口提示。test:bfixes 断言写入序列仅含当前节、脏徽标按节清除 |
| §3 | app.js `fetchReadiness()`（60s TTL + 在途去重 + **按故事键控** `Map<storyId,…>`）+ `refresh()` 无条件 TTL 刷新 + `updateStatusBar()` 进入快照守卫；`renderReadyPanel` 改走缓存（force 穿透） | **补缓存键**：readiness 是按故事的 IPC（`firstRunReadiness(storyId)`），缓存必须键控，否则切故事串台。探测为纯本地读（模型检查不联网），TTL 成本无忧 |
| §2 | app.js `renderStoryList()` 记录焦点故事 id + scrollTop、重建后恢复（按钮加 `data-story-id`）；`renderContext()` select 焦点保持 | **未采用保守档**（跳过整轮 renderContext 会冻结 arrangement/inspector 等），改用"重建后恢复"方案——零数据延迟，与 B24 prependOnly 同族 |
| §4 | `renderStoryHud`：情绪文案→真实 `pulse`、趋势句→`最近活动 <时间>`、`in 32m`→由 `preplan.validFrom` 推导（不可推导降级 PLANNED）、`SCENE 04`→`scenes.length` 真实序号、删除 RAIN AT THE CROSSING fallback | 采用方案 a；比原设计预期更省——快照已有 `validFrom/validThrough` 与 `scenes.length`，无需主进程改动。grep 验收（32m/SCENE 0/有暗流/缓慢上升）零命中 |
| §6 | `openGlobalSearch` role=dialog + aria-modal + 焦点陷阱 + 焦点归还；`showContextMenu` role=menu/menuitem + 方向键/Home/End/Esc + 触发元素 `aria-haspopup` + 焦点归还；`showToast` role 挂到每个 toast（err→alert，其余→status） | **补录缺口**：挂入 dialog 的 toast 脱离 `#toast-container` 的 aria-live，此前读屏完全不播报——role 下沉到元素本身后同时修复（alert 插入即播报）。test:buttons 覆盖三处 |

---

## 9. 复审追加项（2026-10-17 第二轮，已全部修复）

§8 落地后的对照复审又发现/确认六项，前五项当日修复，第六项按复审建议延后：

| 项 | 核实结论 | 落点 |
| --- | --- | --- |
| P2：切故事后模型状态沿用上一个故事 | 属实，且比报告更久——`selectStory()` 不走 `refresh()`，旧值要等下一次后台事件才纠正 | 新增 `syncReadinessForStory(storyId)`（缓存命中立即换、未命中先清空再取），`selectStory()` 与 `refresh()` 共用；test:bfixes 用"故事 A ok / 故事 B err + 探测延迟"验证不再串台 |
| P2：单节保存污染"预览变更"基线 | 属实——`saveConfigSection` 原把整份 DOM 序列化烤进基线，其它标签页草稿随即从预览中消失 | 基线改为按节更新（写入的 payload 即宿主现状）；顺带补全 `configPreviewText` 的 storyDefaults→面板名映射；test:bfixes 验证双脏单存后预览仍报"人设与故事 有变更" |
| P3：日志暂停缓冲不按新过滤条件重筛 | 属实——paused 缓冲不走宿主查询，恢复/补齐时无条件塞回 | 新增 `logMatchesFilter()`，`hydrateLogs` 恢复与 `resumeLogFollow` 合并两条路径都套用；test:bfixes 验证 level 过滤后 info 条目不再回流 |
| P3：save-all 异常文案假报"YAML 已保存" | 属实——纯结构化保存失败也会带上该句 | `yamlSavedThisRun` 标志提升到 try 外，catch 按实际写入情况措辞；test:bfixes 注入写失败验证 |
| P3：workspace-title 缺 analysis 映射 | 属实——回落成 "Arrangement" | 映射补 `analysis: 'Analysis'` |
| P3：四个分析构建函数对退化数据产出 NaN/抛错 | 属实——`maxFacts=0` 得 NaN 宽度、`scene.hook`/`relatedFactIds`/数组缺失直接 TypeError | `buildCompactionHealth`（safePct+安全比率）、`buildNarrativeCoherence`（finite 过滤）、`buildEmotionScenes`/`buildFactMap`（数组与字段兜底）；test:bfixes 用 7 组退化输入断言不抛错且无 NaN |
| P3：列表/下拉仍全量重建（DOM 抖动） | 属实，属 §2"正确档"增量 reconcile 的范围 | **按复审建议延后**（焦点/滚动已由 §8 的恢复方案保住，抖动属体验优化） |

回归：全部 10 套件通过（runtime 75/75、timeline 8/8、ui/bfixes/theme/interactions/compat-themes/connect/buttons/uireview 全绿），`dist` 已重建。

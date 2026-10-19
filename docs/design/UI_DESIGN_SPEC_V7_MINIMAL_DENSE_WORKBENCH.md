# HDSI Desktop typ·0 · V7 数据状态界面设计规范

> 文档状态：已实施第一版
>
> 适用入口：`C:\dev\HDSI-desktop-typ-0\desktop\src\renderer\index.html`
>
> V7 是与 V4 并列的第二个原生工作台主题，不是 V4 的低配色板，也不是旧 HUD / Timeline 的 CSS 变体。

---

## 1. 设计结论

### 1.1 V4 与 V7 是两种不同的工作台产品

| 主题 | 产品定位 | 信息组织 | 适用任务 |
|---|---|---|---|
| **V4 · Information Studio** | 高度信息化的叙事监控工作台 | Browser + Workspace + Inspector + Detail；HUD、Arrangement、完整轨道 | 排错、回溯、长时间监控、逐条分析、编辑参数 |
| **V7 · Data State Surface** | 极简的数据状态界面 | 指标、趋势图、状态机、事件表、当前信号 | 快速判断当前状态、定位异常、确认下一步、日常写作运行 |

V4 保留原有的三栏工作台和传统 Arrangement。V7 不显示传统时间轴轨道、不显示轨道菜单、不显示 HUD 的分栏卡片，也不复制 V4 的业务状态。

### 1.2 V7 要回答四个问题

1. **现在发生了什么？** —— Activity Trend 和 Recent Events；
2. **系统处于什么状态？** —— Runtime Path 状态机；
3. **这个事件为什么重要？** —— Current Signal；
4. **是否需要操作？** —— 顶部状态、Worker / Channel / Model 三个运行事实和少量操作按钮。

V7 的极简不是减少数据，而是取消无助于决策的空间隐喻。时间轴轨道适合逐项回溯，但不是运行中的必要信息；V7 将同一批事件压缩为可比较的数量、趋势和状态转移。

---

## 2. 设计原则

### 2.1 结构极简，数据高密度

V7 只保留五种结构：

- **数字**：当前快照内的事件量、收发量、脚本量、场景量、事实量；
- **折线**：Receive / Send 的活动趋势；
- **节点**：系统状态机；
- **表格行**：最近事件；
- **信号面**：当前选中事件的摘要。

不使用：

- 传统 Timeline 轨道；
- 运行中不需要的时间旋钮和时间范围按钮；
- 大面积仪表盘卡片；
- 玻璃、渐变、霓虹、浮夸装饰；
- 为了“看起来实时”而虚构的 CPU、延迟或健康数值。

### 2.2 线、面、阴影和圆弧

- **线**：分隔模块、表示数据边界和趋势网格；
- **面**：区分主工作面、数据面和信号面；
- **阴影面**：只用于焦点、悬停和键盘聚焦，表示可操作性，不作为装饰；
- **圆弧**：只用于状态机节点和运行状态灯，表示状态而不是按钮；
- **颜色**：继续消费既有 Palette Theme token，V7 不拥有第二套颜色主题。

### 2.3 V4 完全隔离

V7 的 CSS 全部以 `html[data-hdsi-workspace="v7"]` 为作用域。V7 的 DOM、渲染函数和交互不会修改 V4 的 Arrangement 轨道布局，也不会替换 V4 的 HUD 内容。

---

## 3. 页面信息架构

```text
┌────────────────────────────────────────────────────────────┐
│ STORY / 当前故事        状态                  刷新  新建  主题 │
├────────────────────────────────────────────────────────────┤
│ EVENTS   RECEIVE   SEND   SCRIPT   SCENES   FACTS            │
├───────────────────────────────┬────────────────────────────┤
│ 01 / ACTIVITY                 │ 02 / STATE MACHINE          │
│ Receive / Send 折线趋势        │ IDLE → WAITING →            │
│                               │ RESPONDING → SETTLED        │
├───────────────────────────────┼────────────────────────────┤
│ 03 / EVENT STREAM             │ 04 / CURRENT SIGNAL         │
│ 最近事件数据表                 │ 当前事件、来源、摘要、状态   │
├───────────────────────────────┴────────────────────────────┤
│ 当前场景 · 快照 revision · 数据源说明                       │
└────────────────────────────────────────────────────────────┘
```

V7 只在 `studio` 主表面显示。连接、诊断、Console 等主表面仍沿用现有页面；切换到这些页面时 V7 表面隐藏，回到剧本页面后恢复。

---

## 4. 模块规范

### 4.1 Command Header

顶部命令区只显示：

- 当前故事名称；
- 角色名与故事 ID；
- 当前运行状态：`OFFLINE / IDLE / WAITING / RESPONDING / SETTLED`；
- 状态的一句解释；
- 刷新、新建故事、主题入口。

不在 V7 中重复展示旧 status-ruler 的全部状态。全局 transport bar 仍保留，用于跨主表面导航和全局运行控制，但在 V7 中视觉降级为宿主导航。

### 4.2 Metrics Strip

六个指标采用“数字 + 极短标签 + 分隔线”：

| 指标 | 来源 | 说明 |
|---|---|---|
| EVENTS | `snapshot.entries` | 当前快照事件总量 |
| RECEIVE | `entryTrack(entry) === receive` | 输入、用户消息、收到的事件 |
| SEND | `entryTrack(entry) === send` | 角色消息、发送动作、投递事件 |
| SCRIPT | `entryTrack(entry) === narrative` | 剧本或叙事生成事件 |
| SCENES | `snapshot.scenes` | 当前投影场景数量 |
| FACTS | `snapshot.facts` | 当前投影事实数量 |

这些数字是快照投影中的真实计数，不用于假装显示系统资源占用。

### 4.3 Activity Trend

#### 目标

用一张图替代 Timeline 轨道，回答“最近活动是否增加、输入和输出是否失衡”。

#### 图表定义

- 横轴：当前快照事件的时间范围，最多压缩为 12 个桶；
- 纵轴：每个桶的事件数量；
- 蓝线：Receive；
- 绿线：Send；
- 点：可点击的数据桶；
- 每个点有 SVG `title`，键盘/辅助技术可获得时间和数量；
- 没有事件时仍显示空图结构和明确的 `No activity` 文案。

#### 交互

- 点击 Receive / Send 数据点：选中该桶最近一条事件；
- 点击事件表行：趋势图不跳转，但 Current Signal 同步更新；
- 不提供缩放、拖拽和传统时间轴滚动；需要精确回溯时切换 V4。

### 4.4 Runtime Path

状态机是运行语义，不是装饰插图：

```text
IDLE → WAITING → RESPONDING → SETTLED
```

状态判断：

- Worker 未加载：`OFFLINE`，图中保持 IDLE 节点并在顶部给出离线状态；
- 故事暂停：`PAUSED`，图中当前节点为 WAITING；
- 最新事件属于 Receive：`WAITING`；
- 最新事件属于 Script / Narrative：`RESPONDING`；
- 最新事件属于 Send：`SETTLED`；
- 没有可判断的最新事件：`IDLE`。

节点表达：

- 当前节点：实心强调色圆节点 + 硬阴影；
- 已经经过的节点：强调色边框；
- 未经过节点：弱边框；
- 节点下方保留一句状态解释；
- Worker、Channel、Model 三项作为状态机底部事实栏，不做大卡片。

### 4.5 Event Stream

最近事件表替代传统轨道：

```text
TIME | TYPE | SOURCE | SUMMARY
```

默认显示最近 14 条，按新到旧排列。每一行是按钮而不是不可交互文本：

- 点击：更新 Current Signal；
- 键盘 Enter / Space：同样更新；
- 当前行：左侧强调线和浅色面；
- Hover / Focus：硬阴影，说明该行可操作；
- 摘要过长时单行截断，完整内容进入 Current Signal 或 V4 Inspector。

### 4.6 Current Signal

Current Signal 是 V7 唯一的详细信息面。显示：

- 事件轨道类型；
- 发生时间；
- Actor / Channel / Kind；
- 摘要正文；
- 事件 ID；
- “打开详情”操作。

“打开详情”不会复制第二个 Inspector。它把当前事件写入已有 `state.inspected`，并调用现有 Inspector / Detail 渲染逻辑；V7 默认仍隐藏这些面板，用户可以切回 V4 继续深度检查。

### 4.7 Footer Facts

底部只保留对运行判断有用的连续性信息：

- 当前场景摘要；
- 当前快照 revision；
- 明确提示 V7 与 V4 共享同一数据源。

---

## 5. 数据边界与复用规则

### 5.1 V7 使用的既有状态源

```js
state.storyId
state.stories
state.snapshot
state.hostOverview
state.deliveryHistory
state.usageSeries
```

主要数据：

```js
state.snapshot.entries
state.snapshot.scenes
state.snapshot.facts
state.snapshot.revision
state.snapshot.timezone
```

### 5.2 V7 不建立第二套业务模型

V7 只做派生计算：

- `entryTrack(entry)`：复用 V4 的轨道分类规则，但只将结果转换为类型标签；
- `v7Trend(entries)`：按时间桶聚合 Receive / Send；
- `v7RunState(story, entries)`：从故事运行状态和最新事件推导状态机；
- `v7SignalId`：仅保存当前界面选中的事件 ID，不持久化为业务状态。

V7 不写入 Worker，不修改快照，不改变时间线查询协议，不改变交付状态。

### 5.3 刷新策略

- 顶部刷新：调用现有 `refreshSnapshot()`；
- Worker / 故事变化：继续通过已有 desktop event 触发 refresh；
- V7 下自动快照刷新条件扩展为 `state.surface === 'studio' && profile === 'v7'`；
- V7 不需要时间轴滚动或时间旋钮，因此不会因为视窗拖动而产生额外查询。

---

## 6. Workspace Profile 行为

### 6.1 持久化

```text
localStorage key: hdsi-workspace-profile
默认值: v4
```

```html
<html data-hdsi-workspace="v4">
<html data-hdsi-workspace="v7">
```

V4 默认保留，避免升级后现有用户的工作区突然变化。用户在“主题”对话框中选择：

- `V4 · 信息工作台`
- `V7 · 数据状态界面`

当前实现仍使用已有 `window.HDSIWorkspaceProfile` API：

```js
window.HDSIWorkspaceProfile.apply('v7')
window.HDSIWorkspaceProfile.apply('v4')
```

### 6.2 切换原则

- V4 与 V7 直接切换，无透明度、位移、缩放、轨道形变动画；
- 故事、快照、选中事件和颜色主题不变；
- V4 的 Browser / Inspector / Detail DOM 不删除，只在 V7 作用域下隐藏；
- 回到 V4 时恢复原有表面和事件绑定。

---

## 7. 响应式策略

### 大屏（> 980px）

- 趋势图与状态机并排；
- 事件表与 Current Signal 并排；
- 指标带六列展示。

### 中屏（621–980px）

- 模块改为单列：趋势 → 状态机 → Current Signal → 事件表；
- 顶部命令区把状态放到标题下方；
- 指标仍保持六列，必要时缩小间距。

### 小屏（≤ 620px）

- 指标改为三列两行；
- 事件表隐藏 Source 列，保留 Time / Type / Summary；
- 状态机允许横向滚动，不压缩节点文案到不可读；
- 不恢复旧 Browser / Inspector，深度操作仍通过 V4 主题完成。

---

## 8. 可访问性与可用性

- 图表使用 `role="img"`、`aria-label` 和 SVG `title`；
- 事件行使用真实 `button`，支持 Tab、Enter、Space；
- 所有操作按钮有 `title` 或可见标签；
- 当前状态不只依赖颜色，同时显示文字；
- 当前事件使用左侧线、背景面和文字状态共同表达；
- `:focus-visible` 使用 2px 强调色轮廓；
- V7 禁止动效，避免状态变化造成阅读漂移；
- 内容截断只发生在列表摘要，Current Signal 承担可读的详情入口。

---

## 9. 实施文件

### 新增 / 保留

```text
C:\dev\HDSI-desktop-typ-0\desktop\src\renderer\workspace-profile.js
C:\dev\HDSI-desktop-typ-0\desktop\src\renderer\workspace-profile-v7.css
```

### 修改

```text
C:\dev\HDSI-desktop-typ-0\desktop\src\renderer\index.html
C:\dev\HDSI-desktop-typ-0\desktop\src\renderer\app.js
```

实现要点：

- `index.html` 增加独立 `#v7-workbench-surface`；
- `app.js` 增加 `renderV7Workbench()`、趋势聚合、状态机派生和当前事件选择；
- `renderArrangement()` 在 V7 + Studio 时提前进入 V7 渲染路径，V4 原路径不变；
- `setSurface()` 和 `hdsi-workspace-profile-change` 事件统一调用 `syncWorkspaceProfileView()`；
- V7 CSS 只作用于 `data-hdsi-workspace="v7"`；
- `workspace-profile-v7.css` 不再覆写旧 HUD / Timeline 的视觉细节，而是隐藏旧表面并提供独立布局。

---

## 10. 验收标准

### 结构

- [x] V4 默认启动且原有工作台可用；
- [x] V7 可以通过主题对话框切换；
- [x] V7 不显示 Browser、Inspector、Detail、Arrangement Track、时间旋钮和时间范围按钮；
- [x] V7 使用独立 surface，不依赖旧 HUD / Timeline 的 DOM 排版；
- [x] 切回 V4 后旧工作台恢复。

### 数据

- [x] 指标来自真实快照，不写死演示数据；
- [x] 趋势图使用 `snapshot.entries`；
- [x] 状态机使用故事运行状态和最新事件；
- [x] 事件表可点击并更新 Current Signal；
- [x] Current Signal 可以进入现有 Inspector / Detail 数据通道。

### 交互

- [x] 趋势点可选中对应时间桶内最近事件；
- [x] 刷新按钮调用既有快照刷新；
- [x] 新建故事和主题按钮复用既有入口；
- [x] V7 与 V4 切换没有 HUD / Timeline 动画；
- [x] 键盘焦点可见，事件行可用键盘操作。

### 工程验证

- [x] `npm run build`
- [x] `npm run typecheck`
- [x] `npm run test:ui`
- [x] `npm run test:timeline`

---

## 11. 后续迭代建议

第一版实施完成后，下一步只做数据语义和可用性细化，不再把 V7 拉回 V4：

1. 为趋势桶增加“无事件 / 只有 Receive / 只有 Send”的空态标注；
2. 为状态机记录最近一次状态转移时间；
3. 将 Current Signal 的“打开详情”补充为明确的“切回 V4 并定位”动作；
4. 对 `hostOverview` 的 Channel / Model 字段做真实 schema 对齐，避免依赖兼容字段；
5. 增加 V7 专属 UI 测试，验证 profile 切换后旧 Timeline 不可见、指标和事件行可见；
6. 在真实快照与离线快照上做一次人工视觉验收。

V7 的边界必须保持清晰：**V4 负责完整的叙事工作台，V7 负责快速的数据状态判断。**


# HDSI Desktop typ·0 UI 设计规范 v4

## Overview 窄轨预览与 Timeline 展开工作台

> 状态：设计方案，暂不改代码
>
> 基于：`UI_DESIGN_SPEC_V3_THEME_SYSTEM.md`
>
> 适用项目：`HDSI-desktop-typ-0-cev`
>
> 核心目标：让 Studio 默认以故事 HUD 和三条窄轨道呈现全局状态，用户进入时间线时通过连续、可理解的展开动效进入现有轨道工作台。

---

## 1. 设计结论

V4 不再把 Overview 和 Timeline 设计成两个互不相干的页面，而是把它们定义为同一工作区的两个空间状态：

```text
Overview
  HUD 状态块
  三条窄轨预览：Script / Receive / Send
  当前场景与最近活动摘要

             展开
              ↓

Timeline
  完整时间尺
  完整轨道高度
  事件块、场景、来源、投递和 playhead
```

默认进入 `Overview`。点击轨道、Timeline 按钮或使用快捷键后，窄轨区域沿着原有位置展开为完整时间线。返回 Overview 时反向收拢，保留用户最后一次 Timeline 的时间范围、缩放和滚动位置。

这套设计有三个约束：

1. Overview 是可用的状态摘要，不是时间线的截图缩略图。
2. Timeline 的真实数据和交互全部保留，动效只改变呈现方式。
3. 动效必须能被关闭，并且不能阻塞事件定位、刷新和键盘操作。

---

## 2. 视图状态模型

第一版直接复用已有 `state.browserView`：

| 状态 | 视觉名称 | 作用 |
|---|---|---|
| `overview` | Overview | 默认故事 HUD + 三条窄轨预览 |
| `timeline` | Timeline | 现有完整轨道工作台 |
| `session` | Session | 独立工作页 |
| `mixer` | Mixer | 独立工作页 |
| `stats` | Stats | 独立工作页 |
| `analysis` | Analysis | 独立工作页 |
| 其它 | Facts / Schedule / Settings | 保持现有语义 |

不新增第二套 `studioMode` 状态，避免 `browserView` 与 `studioMode` 互相覆盖。未来如果需要在 Session 内再增加子模式，再单独引入嵌套状态。

### 2.1 持久化字段

保留现有字段，并为 Timeline 增加独立视窗缓存：

```js
state.browserView = 'overview'
state.timelineViewport = {
  center: null,
  spanMinutes: 840,
  scrollLeft: 0,
  followNow: true
}
state.studioTransition = 'idle'
```

`studioTransition` 只用于渲染锁和测试，不需要长期持久化。进入 Overview 不重置 `timelineViewport`。

### 2.2 旧状态迁移

- 已保存 `browserView: 'overview'` 的用户继续进入 Overview，但显示新三轨预览。
- 已保存 `browserView: 'timeline'` 的用户继续进入完整 Timeline。
- 旧版本中 Overview 使用的全范围时间线窗口迁移到 `timelineViewport`，第一次展开时继续使用该范围。
- 不删除已有 `overviewRanges` 缓存；它只作为初始范围的兼容来源，不能再决定 Overview 的布局。

---

## 3. Overview 的具体布局

### 3.1 页面层级

```text
Workspace Header
  ├─ Story 标题 / 场景摘要
  ├─ HUD / Timeline 切换器
  └─ 轻量动作：刷新、导出、更多

Story HUD
  ├─ Story Pulse
  ├─ Channels
  └─ Next Move

Rail Preview
  ├─ Script
  ├─ Receive
  └─ Send

Context Strip
  ├─ 当前场景
  ├─ 最近叙事回合
  └─ 系统状态
```

Overview 的主要视觉焦点是 HUD 与窄轨预览。三条轨道不能被状态卡片挤出首屏，也不能因为没有事件而折叠到零高度。

### 3.2 三条窄轨

默认轨道固定为：

| 轨道 | 含义 | 预览内容 |
|---|---|---|
| Script | 叙事脚本、场景和模型计划 | 当前场景、最近脚本摘要 |
| Receive | 入站消息和接收来源 | QQ / 微信、私聊 / 群聊、参与者 |
| Send | 出站投递和主动联系 | 目标端点、投递状态、等待状态 |

预览轨道尺寸建议：

```css
--overview-rail-header: 112px;
--overview-rail-row: 34px;
--overview-rail-gap: 1px;
--overview-rail-preview-height: 106px;
```

总高度约 106px，不包含 HUD 和上下间距。轨道标签使用左侧固定列，右侧使用和 Timeline 相同的时间坐标映射，但只显示有限数量的摘要块。

每条轨道至少显示：

- 一条当前或最近事件；
- 一个时间位置；
- 一个短状态标签；
- 当前场景或端点的颜色标记。

没有数据时仍保留轨道行，并显示 `NO RECENT ACTIVITY` 或中文本地化短提示，不能让布局塌陷。

### 3.3 预览块

预览块与完整 Timeline 块使用同一 `eventId`、`entryId` 或 `sceneId`：

```html
<button class="rail-preview-clip"
        data-event-id="..."
        data-track="receive">
  <span class="clip-time">20:42</span>
  <span class="clip-label">QQ 私聊</span>
</button>
```

预览块只展示摘要，不显示完整正文。点击后直接进入 Timeline 并定位到该事件。

---

## 4. Overview → Timeline 的展开动效

### 4.1 动效目标

用户应感知为“同一条轨道被打开”，而不是离开一个页面后加载另一个页面。动效要保持事件块、场景色带和时间位置的连续性。

### 4.2 动效分段

建议总时长 360ms，使用三段式缓动：

| 阶段 | 时间 | 动作 |
|---|---:|---|
| 准备 | 0–40ms | 冻结快照、保存 Overview 选中块、测量目标布局 |
| 展开 | 40–280ms | 轨道区域增高、完整时间尺显现、同 ID 事件块移动到目标位置 |
| 收尾 | 280–360ms | 完整标签和细节淡入，移除过渡层，恢复 Timeline 交互 |

建议曲线：

```css
--studio-ease: cubic-bezier(.22, .8, .24, 1);
--studio-expand-duration: 360ms;
```

### 4.3 视觉变化

展开时按以下顺序变化：

1. `Rail Preview` 的三条轨道高度从 34px 增长到完整轨道高度。
2. 时间尺从窄轨顶部淡入并扩展到完整宽度。
3. 预览块的背景色和位置以 FLIP 方式移动到完整事件块位置。
4. 完整正文、来源、端点、状态图标淡入。
5. Playhead 在最后 80ms 显示，避免在布局尚未稳定时跳动。

不能对整个 Timeline 使用 `transform: scale()` 作为主要动效。整块缩放会导致文字模糊、线宽变化和轨道标题漂移。

### 4.4 技术实现建议

建议增加一层 Studio 视图容器：

```html
<div id="studio-mode-viewport" class="studio-mode-viewport">
  <section id="story-hud" class="story-hud"></section>
  <section id="overview-rails" class="overview-rails"></section>
  <section id="arrangement" class="arrangement"></section>
  <div id="studio-transition-layer" aria-hidden="true"></div>
</div>
```

实现方式：

1. Overview 和 Timeline 使用同一份 snapshot，但分别渲染预览层和完整层。
2. 切换前测量同 ID 预览块与完整块的 `DOMRect`。
3. 在 `studio-transition-layer` 中建立临时视觉副本。
4. 使用 FLIP：先保持预览位置，再动画到 Timeline 位置。
5. 完成后隐藏预览层，启用完整 Timeline 交互。

如果目标浏览器不支持 View Transitions API，使用标准 Web Animations API 和 CSS transition 实现同样流程。临时副本必须设置 `pointer-events: none`，不能拦截用户操作。

### 4.5 反向收拢

Timeline → Overview 的动效使用同一流程反向执行：

- 保留当前选中事件；
- 将完整块缩回对应的三轨预览位置；
- 隐藏时间尺和 playhead；
- 最后显示 HUD 摘要。

如果当前 Timeline 选中事件不在预览条目中，Overview 应将其加入“最近活动”预览，而不是让选中状态消失。

---

## 5. 快速切换入口

### 5.1 Workspace Header 分段控件

固定显示：

```text
[ HUD ] [ Timeline ]
```

要求：

- `HUD` 当前默认选中；
- `Timeline` 当前展开时高亮；
- 点击当前模式不重复执行动效；
- 过渡期间按钮进入 `aria-busy` 或短暂禁用；
- 其它 Browser 视图打开时控件保持可见，但不抢夺该页面自己的标题。

### 5.2 轨道点击

以下操作直接触发展开：

- 点击任意预览轨道；
- 点击预览块；
- 点击“查看完整时间线”；
- 双击当前场景摘要。

轨道块点击应在展开完成后定位到对应事件；如果用户在动效期间继续点击，记录最后一次目标，完成后只执行一次定位。

### 5.3 键盘

```text
1       → Overview / HUD
2       → Timeline
Enter   → 展开当前聚焦的预览块
Escape  → 取消尚未完成的展开并恢复原模式
```

输入框、文本编辑器、下拉菜单获得焦点时不触发数字快捷键。

---

## 6. Timeline 视图要求

展开后的 Timeline 必须保持现有功能：

- 时间尺和时间范围预设；
- 滚轮缩放；
- 横向滚动和底部滚动条；
- playhead 与 NOW 跟随；
- 轨道显隐；
- 事件、场景和投递块选择；
- Inspector 和 Detail Dock；
- Session、Mixer、Stats、Analysis 等视图切换。

动效不改变 `layoutFor().tracks`、时间范围计算和真实轨道数据。Timeline 视图完成后，事件操作与从侧栏直接进入 Timeline 的结果必须一致。

### 6.1 时间线视窗

展开时优先恢复用户上次 Timeline 视窗：

```js
restoreTimelineViewport(state.timelineViewport)
```

如果 Overview 用户点击了某个事件，则以该事件为中心，覆盖默认视窗中心，但不覆盖用户保存的缩放比例。

---

## 7. 数据与渲染边界

### 7.1 共享数据

Overview 和 Timeline 共享：

- `state.snapshot.entries`；
- `state.snapshot.scenes`；
- `state.snapshot.facts`；
- `state.snapshot.preplan`；
- `state.deliveryHistory`；
- `state.hostOverview`；
- `state.usageSeries`；
- `metadata.channel`、`channelContext` 和 endpoint 信息。

### 7.2 独立渲染函数

建议新增：

```js
renderStoryHud(target, snapshot)
renderOverviewRails(target, snapshot, viewport)
renderArrangement(target, snapshot, { mode: 'timeline' })
transitionStudioMode(from, to, options)
focusTimelineAt(ms, options)
```

`renderOverviewRails` 只能生成预览块，不能复制完整正文和复杂 Inspector 内容。完整数据继续由 Timeline 和 Detail 使用。

### 7.3 更新策略

- snapshot revision 变化时更新 HUD 和窄轨；
- Timeline 处于隐藏状态时不进行完整轨道 repaint；
- 动效期间冻结当前 revision，避免内容在移动过程中改变；
- 动效结束后检查 revision，若发生变化则补做一次渲染。

---

## 8. 性能与稳定性

动效期间只允许以下属性参与高频动画：

- `transform`；
- `opacity`；
- `clip-path`；
- 已测量的高度或网格轨道值。

避免对包含大量事件的完整 Timeline 反复触发同步布局。建议在一次读阶段完成所有 `getBoundingClientRect()`，再统一写入动画属性。

过渡期间设置：

```text
pointer-events: none  → 临时副本
aria-hidden: true     → 非活动层
overflow: clip        → 过渡容器
```

动效超过 500ms 未完成时必须自动回退到目标状态，避免界面锁死。

---

## 9. 可访问性与动效降级

### 9.1 Reduced Motion

检测：

```js
window.matchMedia('(prefers-reduced-motion: reduce)').matches
```

启用后：

- 直接切换布局；
- 保留选中事件和定位；
- 不生成 FLIP 临时副本；
- 不让内容因为过渡而延迟可操作。

### 9.2 语义状态

- 分段控件使用 `role="group"`；
- 当前模式按钮使用 `aria-pressed`；
- 过渡容器使用 `aria-busy`；
- 非活动视图使用 `aria-hidden`；
- 预览块提供明确的 `aria-label`，例如“20:42，Receive，QQ 私聊，展开时间线”。

颜色不能单独表达轨道类型或投递状态，必须同时保留文字、图标或状态标签。

---

## 10. 响应式规则

### 宽屏

- HUD 三列状态块；
- 三条窄轨完整显示；
- 展开后使用当前三栏宿主结构；
- 轨道预览和场景摘要位于同一首屏。

### 中等窗口

- HUD 状态块可以变为两列；
- 三轨保持三行，不允许横向滚动；
- 展开动效只改变中间 Studio 区域，不推挤 Browser 和 Inspector 到屏幕外。

### 窄窗口

- HUD 状态块改为单列；
- 预览块保留时间和通道，正文隐藏；
- Timeline 展开后仍使用真实滚动容器；
- 动效时长缩短到 240ms，减少视线移动。

---

## 11. 主题与社区皮肤接口

新增语义变量：

```css
--studio-preview-height: 106px;
--studio-rail-row-height: 34px;
--studio-expanded-row-height: 120px;
--studio-transition-duration: 360ms;
--studio-transition-ease: cubic-bezier(.22, .8, .24, 1);
--studio-preview-opacity: .92;
--studio-rail-divider: var(--hdsi-color-border);
```

社区主题可改变：

- 预览轨道高度；
- 轨道边线和背景；
- 展开曲线和时长范围；
- 预览块密度；
- HUD 与窄轨之间的间距；
- 展开时是否显示场景色带。

主题不能：

- 删除 Script、Receive、Send 三条核心轨道；
- 把 Timeline 交互替换为静态图片；
- 禁止键盘切换；
- 隐藏唯一的错误或投递失败状态；
- 加载远程脚本实现动效。

---

## 12. 实施阶段

### M0：结构分层

- 新增 `studio-mode-viewport`；
- 将 HUD、窄轨预览、完整 Arrangement 分为独立层；
- 保证现有 Timeline 可以单独工作；
- 默认 `browserView = 'overview'`。

### M1：窄轨预览

- 实现 Script、Receive、Send 三条固定预览轨；
- 接入当前 snapshot；
- 实现预览块点击和空状态；
- 增加 HUD / Timeline 分段控件。

### M2：展开与收拢

- 实现 `transitionStudioMode()`；
- 加入 FLIP 事件块移动；
- 恢复 Timeline viewport；
- 支持 reduced motion 和超时回退。

### M3：交互联动

- 轨道、场景、最近回合定位 Timeline；
- 键盘快捷键；
- Escape 取消过渡；
- Inspector / Detail 选择状态同步。

### M4：主题和质量门

- 新增 V4 主题变量；
- 测试社区主题兼容；
- 检查 1280×720、1440×900、125% 缩放和窄窗口；
- 检查刷新、故事切换、快照更新期间的过渡一致性。

---

## 13. 测试与验收标准

### 功能验收

- 默认进入 Overview；
- Overview 始终显示三条窄轨；
- 点击窄轨可以进入 Timeline；
- Timeline 能恢复上次时间范围、缩放和滚动位置；
- 点击预览块后 Timeline 自动定位到同一事件；
- Timeline 的拖动、缩放、轨道显隐、Inspector 和 Detail 不回归；
- Overview 与 Timeline 使用相同事件身份，不出现重复或错位事件。

### 视觉验收

- 展开过程中轨道位置连续；
- 文字不会被整体缩放到模糊；
- 时间尺、场景色带和 playhead 的出现顺序稳定；
- 返回 Overview 后 HUD 不被过渡残影遮挡；
- 窄窗口下没有横向溢出或按钮被裁切。

### 稳定性验收

- 快速连续点击不会重复创建过渡层；
- snapshot 在过渡期间更新不会造成空白；
- 动效超时会自动恢复可操作状态；
- reduced motion 下不等待动画；
- 页面隐藏、故事切换和刷新期间不会残留 `aria-busy` 或 `pointer-events: none`。

---

## 14. 最终推荐

采用“**默认 Overview + 三轨预览 + 同区域展开 Timeline**”作为 V4 的核心交互。

Overview 负责快速理解故事当前状态，三条窄轨让用户看到 Script、Receive、Send 的连续关系；Timeline 负责精确定位和工作。两者共享数据和事件身份，通过 FLIP 和容器展开形成连续过渡，既保留 typ0 HTML 的视觉语言，也保留当前轨道工作台的专业能力。

本文件定义设计和实施边界；当前实现状态见第 15 节。

---

## 15. 当前实现映射

V4 已按本规范接入桌面端渲染器，当前代码映射如下：

| V4 概念 | 当前实现 |
|---|---|
| Studio 视图切换 | `state.browserView = 'overview' | 'timeline'` |
| HUD 容器 | `#story-hud` |
| 三条窄轨 | `renderOverviewRails()` 生成 Script / Receive / Send |
| 完整轨道 | 继续复用现有 `#arrangement` 和 `renderArrangement()` |
| Timeline 视窗 | 继续复用现有 `storyLayouts` / `timelineViewport()`，不新增重复持久化字段 |
| 切换状态 | `setStudioView()` / `transitionStudioMode()` |
| 事件定位 | `focusTimelineAt()` |
| 连续动效 | 容器高度与 `clip-path` 过渡 + 同 `entityId` 的 FLIP 视觉副本 |
| 动效降级 | `prefers-reduced-motion` 直接切换 |

窄轨目前嵌入 `#story-hud` 内部，以便 HUD、最近回合和三轨预览共享同一个可滚动区域；这不改变语义结构，也不阻止未来将窄轨拆为独立容器。完整轨道在 Overview 状态下保留为不可见测量层，保证旧的时间线几何、playhead 和回归测试继续有效；它不会接收鼠标和键盘输入。

已验证：

- `npm run build`；
- `npm run typecheck`；
- `npm run test:ui`；
- `npm run test:timeline`；
- `npm run test:v3`。

后续视觉校准又补充了参考稿中的高密度层级：窄轨置于 HUD 顶部、三张状态卡使用 Indigo / Moss / Vermilion 状态带、场景卡使用章节标题和圆环装饰、右侧 Inspector 增加 Active Endpoints / Linked Participants / Next Route 分区。

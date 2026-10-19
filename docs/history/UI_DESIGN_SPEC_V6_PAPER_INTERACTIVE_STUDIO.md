# HDSI Desktop typ·0 UI 设计规范 V6

## Paper Workbench / 纸面工作台的高交互版

> 状态：V4 基础上的 V6 设计与可交互 HTML 原型
>
> 适用项目：`C:\dev\HDSI-desktop-typ-0`
>
> 原型文件：`desktop/src/renderer/index-v6.html`
>
> 基线：`UI_DESIGN_SPEC_V4_MORPHING_STUDIO.md`、当前 `desktop/src/renderer/index.html`

---

## 0. 一句话结论

V6 **不推翻 V4**。它保留 V4 的纸面工作台、HUD / Timeline 两态、三条窄轨、完整时间线和可连续展开的空间关系；只把“状态摘要”升级成可以继续操作的“编辑台”，把隐藏在鼠标悬停、选中、定位和展开动作里的信息做成清晰、可探索、可回退的交互层。

> **V6 = V4 的结构稳定性 + 日式编辑设计的秩序 + 更大胆的交互反馈。**

这里的“大胆”不是更大的卡片、更多渐变或全屏仪表盘，而是：

- 让窄轨可以直接操作，而不是只能预览；
- 让时间、来源、状态和下一步动作在同一条视觉路径上出现；
- 让纸面上的线、折角、印章、索引都对应真实状态；
- 让 HUD → Timeline 继续是同一个工作区的连续展开；
- 让空白成为导航节奏，不让空白变成失去入口的空洞。

V6 的视觉原则可以浓缩成一句：

> **视觉上克制，行为上有锋芒；结构上留白，反馈上不含糊。**

---

## 1. V4 基线与 V6 调整范围

### 1.1 V4 必须原样保留的部分

| V4 基线 | V6 处理 |
|---|---|
| `browserView` 中的 `overview` / `timeline` 语义 | 保留，不增加第二套页面状态 |
| HUD 默认首屏 | 保留，增强为可操作 HUD |
| Script / Receive / Send 三条窄轨 | 保留，成为第一优先交互入口 |
| Timeline 的真实数据、时间尺、轨道块与 playhead | 保留，不做第二套数据投影 |
| 左侧 Browser、右侧 Inspector、底部 Detail | 保留，增加更明确的层级提示 |
| `timelineViewport` 的时间范围、缩放、滚动位置 | 保留，切换视图不重置 |
| Overview → Timeline 的几何连续转场 | 保留当前已修复的几何过渡，不回退为整页缩放 |
| 纸质工作台与低饱和色板 | 保留，增加少量靛蓝、朱印红、苔绿作为语义强调 |

### 1.2 V6 只做“增量”的部分

1. **状态层**：顶部由单纯 status ruler 增加当前章节、焦点轨道、时间窗口和活动数。
2. **操作层**：三条窄轨支持点击定位、双击展开、键盘聚焦、右侧 Inspector 预览。
3. **索引层**：Browser 的分组按钮具有“纸带索引”外观；当前视图通过边缘色条与短标签标记。
4. **批注层**：用户可对当前事件加临时 note；note 只在本地 UI 层展示，不伪装成后端数据。
5. **反馈层**：hover、focus、selected、loading、error、muted 各有稳定的纸面表现。
6. **主题层**：默认 `paper-studio`；按同一 token 映射提供 `night-signal`，不改变信息结构。

### 1.3 V6 明确不做的事情

- 不把 V4 改成 V5 式全屏控制台或霓虹 HUD。
- 不将现有轨道数据复制成独立的“演示数据层”。
- 不用持续呼吸、强烈弹跳或大面积模糊阴影承担状态说明。
- 不把所有可见元素都变成按钮；可操作性必须有层级。
- 不改变 Koishi、Worker、模型、账号和日志的权限边界。
- 不要求本轮同步修改后端协议或持久化 schema。

---

## 2. 设计依据：把日式极简转译成界面规则

V6 借鉴的是可验证的设计方法，不把“日式”当成装饰标签。

### 2.1 `ma`：把间隔当成时间与关系

关于 `ma` 的研究将其描述为积极组织构图、节奏和感知的空间 / 时间间隔，而不只是“空白”。因此在 V6 中，轨道之间的 8–16px 间隔用于表达层级和停顿；点击轨道时，间隔收窄、焦点线出现，表达“正在进入这条轨道”，而不是简单填充空间。

界面规则：

- 不用连续卡片填满工作区；保留可读的纸面间隔；
- 空状态保留轨道骨架和入口；
- 时间轴上无事件的区间仍显示轻网格和章节标记；
- 动画使用“靠近 / 展开 / 留出间隔”，不使用整页突然替换。

### 2.2 日本编辑与印刷设计：用网格制造自由

日本字体与海报设计实例常见强烈的版式网格、非对称构图、字距和正负形对比。V6 不复制某个海报，而是把这些方法转换为：固定的 12 栏工作区、错位的章节标题、窄字距元数据和一条不对称的朱印标记。

界面规则：

- 中文标题与英文元数据分工，不让英文术语吞没中文任务名；
- 轨道块使用统一时间坐标，但允许摘要标签在视觉上错位；
- 强调色只用于“焦点 / 状态 / 动作”，不作为表面装饰；
- 关键操作拥有明确的边线或印章，不靠发光。

### 2.3 材质与不完美：纸张是层级，不是噪声

纸面纹理只用于区分 canvas、surface、raised surface 和 sunken surface。纹理透明度低于 4%，不影响文字和事件块的对比度。所有“手工感”都必须回到信息结构：折角表示收藏 / 注记，红印表示风险 / 当前，铅笔线表示焦点。

### 2.4 参考资料

- *The Visual Language of Silence: Aesthetic Functions and Compositional Structure of Ma in Medieval Japanese Painting*：用于理解 `ma` 作为积极的构图和时间节奏，而非空白装饰。<https://doi.org/10.69760/portuni.26080004>
- Musashino Art University / Japan Design Resource Database, *Japanese Typography Exhibition*：用于参考日本字体、印刷材料与构图的关系。<https://designdesigndesign.jp/en/database/09_02/>
- RISD Museum, *Carved Paper*：用于参考日本纸样、非对称、斜向构图与正负空间对比。<https://risdmuseum.org/exhibitions-events/exhibitions/carved-paper>
- Designmuseum Danmark, *Japan Modern Poster*：用于参考日本现代海报中传统与现代视觉语言的并置。<https://designmuseum.dk/en/exhibition/japan-modern-poster/>
- MoMA, *Typography and the Poster*：用于参考把文字从被动标签转为具有构图作用的视觉元素。<https://www.moma.org/calendar/exhibitions/443>

这些资料只提供构图、材料和节奏方面的参考；V6 不将它们当作日本文化的单一代表，也不把文化概念直接等同于“极简”。

---

## 3. 视觉系统

### 3.1 色彩 token

```css
:root,
[data-theme="paper-studio"] {
  --v6-canvas: #e5e0d5;
  --v6-paper: #f7f3eb;
  --v6-paper-raised: #fffdf8;
  --v6-paper-sunken: #dcd5c7;
  --v6-ink: #252a26;
  --v6-ink-2: #59635d;
  --v6-ink-3: #848b83;
  --v6-line: #c8c2b5;
  --v6-line-strong: #97978d;
  --v6-indigo: #586f7c;
  --v6-indigo-soft: #dce6e8;
  --v6-moss: #6e806a;
  --v6-moss-soft: #e1e9de;
  --v6-vermilion: #bb5d4f;
  --v6-vermilion-soft: #f1ddd7;
  --v6-sand: #bb985e;
  --v6-pencil: #455f73;
  --v6-script: #866995;
  --v6-receive: #5b8ca4;
  --v6-send: #b57757;
  --v6-shadow-ink: rgba(41, 43, 38, .24);
  --v6-shadow-hard: 3px 3px 0 var(--v6-shadow-ink);
}

[data-theme="night-signal"] {
  --v6-canvas: #181c1c;
  --v6-paper: #252a29;
  --v6-paper-raised: #303735;
  --v6-paper-sunken: #111515;
  --v6-ink: #edf0e9;
  --v6-ink-2: #bbc3b9;
  --v6-ink-3: #8b958b;
  --v6-line: #414945;
  --v6-line-strong: #626e66;
  --v6-indigo: #8bb2bd;
  --v6-indigo-soft: #2d454a;
  --v6-moss: #9aaf8b;
  --v6-moss-soft: #2e4031;
  --v6-vermilion: #e28370;
  --v6-vermilion-soft: #4a302c;
  --v6-sand: #d0ab65;
  --v6-pencil: #a7c7d0;
  --v6-shadow-ink: rgba(0, 0, 0, .5);
  --v6-shadow-hard: 3px 3px 0 var(--v6-shadow-ink);
}
```

### 3.2 字体与密度

- 标题：系统无衬线 / 日文环境优先 `Noto Sans CJK JP`，中文环境优先 `Noto Sans CJK SC`。
- 元数据：`ui-monospace, Consolas, SFMono-Regular, monospace`。
- 正文：系统 UI sans-serif，正文最小 12px，重要辅助文字不低于 11px。
- 默认密度：V4 的密集工作台；V6 通过间隔层次提高可读性，不通过放大所有控件。
- 长文本最多两行摘要，完整内容进入 Inspector / Detail，不在窄轨里强行塞满。

### 3.3 线、纸、硬光影

| 用法 | 视觉 | 语义 |
|---|---|---|
| 普通分隔 | 1px `--v6-line` | 结构边界 |
| 当前轨道 | 2px 靛蓝 / 朱红竖线 | 焦点和选择 |
| 纸带索引 | 3px 左色条 + 1px 错位底线 | 当前导航 |
| 纸张浮起 | `3px 3px 0` 硬投影 | 可抓取的浮层 |
| 错误 / 阻断 | 朱红印章 + 实线 | 需要处理 |
| 键盘焦点 | 2px 外描边 + 2px offset | 可访问的焦点 |

硬光影只用于可被交互的对象、浮层和当前选中对象；普通布局面板不加阴影。禁止把 `box-shadow` 做成大面积柔光。

---

## 4. 信息架构：V6 仍然是同一个工作台

```text
Transport Bar
  ├─ HDSI typ·0 标记
  ├─ Connect / Studio / Diagnostics / Console
  ├─ 当前故事
  ├─ Running / Muted / Paused
  └─ Theme / Layout / New Story

Status Ruler
  ├─ 当前章节与故事健康度
  ├─ Channel / Model
  ├─ 时间窗刻度
  └─ 本地时区

Studio Shell
  ├─ Browser
  │   ├─ Story list
  │   ├─ Selected story views
  │   └─ Arrangement tracks
  ├─ Workspace
  │   ├─ Workspace header
  │   ├─ Paper index / view switch
  │   ├─ Story HUD or Timeline
  │   └─ Context strip
  ├─ Inspector
  └─ Detail dock
```

V6 的新增元素都挂在现有容器内：不改变 `studio-shell` 的三列 / 两行工作台，不引入平行的“设计展示页”。

---

## 5. HUD：从摘要变成可操作的编辑台

### 5.1 HUD 首屏结构

```text
[章节签 / STORY 004] [故事标题                         ] [LIVE 印章]
[当前场景摘要 · 08:42] [下一步动作：等待接收 / 继续生成] [活动 06]

      ┌─ Story Pulse ───────────────────────┐
      │ 场景标题 / 情绪线 / 当前参与者       │
      │ 最近事件带 · 操作入口                 │
      └──────────────────────────────────────┘

  SCRIPT       ── 事件摘要 ─────●────────── now
  RECEIVE      ─────消息───────◎────────── now
  SEND         ─────────投递────◆───────── now

[当前焦点：Receive] [18 条事件] [Ctrl/Cmd+K 搜索] [双击轨道进入 Timeline]
```

### 5.2 HUD 顶部章节签

- 左侧使用两位数字或短章节 ID，例如 `04 / EVENING LOOP`。
- 当前故事标题仍是主要中文标题，不以英文标题替代。
- 右侧显示状态印章：`LIVE`、`MUTED`、`PAUSED`、`OFFLINE`；印章颜色与文字必须同时存在。
- 点击章节签：回到当前故事根视图，并清除临时事件注记，不清除后端数据。

### 5.3 Story Pulse

Story Pulse 是一个真实的交互入口，而非装饰卡片：

- 点击情绪 / 场景标签，Inspector 定位到对应状态来源；
- 点击最近事件带，选中事件并在轨道上显示同一 `eventId`；
- 点击“下一步动作”直接执行安全动作，例如进入 Timeline、打开接收轨、打开 Connect 检查；
- 不可执行时显示原因，不显示伪按钮。

### 5.4 三条窄轨的大胆交互

每条窄轨同时具备四个层级：

1. **轨道本体**：点击空白位置，把 playhead 移到该时间。
2. **事件块**：单击选中并更新 Inspector；双击进入 Timeline 并定位。
3. **轨道标签**：点击聚焦该轨道；再次点击取消焦点。
4. **轨道尾端**：显示 `+N` 或 `NO ACTIVITY`，点击展开对应 Detail。

交互反馈：

- hover：只出现事件摘要和一条铅笔线，不改变布局高度；
- focus：轨道左侧出现靛蓝边线，其他轨道降低到 78% 对比度；
- selected：事件块出现 3px 硬阴影和朱印 / 靛蓝角标；
- loading：轨道保留骨架，使用 3 个短线段的静态占位，不闪烁；
- error：轨道标题旁显示朱印 `!`，事件正文仍可读；
- empty：显示明确入口，例如 `无新消息 · 查看全部`。

---

## 6. Timeline：完整信息不牺牲纸面秩序

### 6.1 Timeline 顶部

Timeline 顶部仍使用 V4 的 `arrangement-ruler` 与时间预设，但新增：

- 当前时间窗标签：`24H / LIVE WINDOW`；
- 当前焦点轨道标签，例如 `FOCUS · RECEIVE`；
- playhead 顶部采用短朱印旗，不覆盖时间刻度；
- 章节分隔线使用更长的铅笔线，并在 Inspector 中显示章节名。

### 6.2 宽轨展开

- 展开后保持三条默认轨顺序和用户选择的额外轨道；
- 每条轨的左侧标题列固定，右侧时间坐标沿用 V4；
- 首次展开不改变 `scrollLeft` 和时间窗；
- 从 HUD 点击某个事件进入 Timeline 时，将该事件作为 focus，不自动把用户带到“现在”；
- 返回 HUD 后保留当前 focus、时间窗和滚动位置。

### 6.3 宽轨的探索层

- 轨道块顶部显示时间，底部显示来源 / 目标；
- 仅在 hover / focus 后出现次要操作：`定位`、`复制摘要`、`加入注记`；
- 右侧 Inspector 先展示“下一步”，再展示原始字段；
- Detail Dock 用于完整正文、事件流、投递和模型用量，不让 Timeline 变成 JSON 查看器。

---

## 7. 交互状态和动画

### 7.1 状态模型

在现有状态上增加 UI-only 字段，不改后端协议：

```js
state.v6Ui = {
  focusTrack: null,
  selectedEventId: null,
  noteEventIds: [],
  commandPaletteOpen: false,
  transition: 'idle'
}
```

`focusTrack`、`selectedEventId`、`noteEventIds` 可以通过 sessionStorage 保存；不得覆盖真实故事数据。

### 7.2 HUD ⇄ Timeline

继续使用现有 V4 几何转场修复：

- 由窄轨 / 宽轨的真实位置计算 FLIP 几何；
- 不对整个 `.studio-mode-viewport` 使用 `scale()`；
- 不让父级高度 transition 与轨道子级高度互相竞争；
- 轨道延迟显示与层级提升应保持现有实现；
- 快速反向点击必须取消未完成的旧 transition，并以当前目标状态重新计算。

V6 只增加两个非阻塞层：

1. 当前焦点轨道的铅笔线从原位置延伸到新位置；
2. 状态印章在 160–220ms 内落下，`prefers-reduced-motion` 时直接显示。

推荐时间参数：

```css
--v6-motion-fast: 140ms;
--v6-motion-state: 220ms;
--v6-motion-layout: 460ms;
--v6-ease-editorial: cubic-bezier(.22, .72, .2, 1);
```

### 7.3 动画禁用规则

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 1ms !important;
    transition-duration: 1ms !important;
    scroll-behavior: auto !important;
  }
}
```

减少动态效果后，仍必须保留焦点、选中、错误和当前 playhead 的静态表现。

---

## 8. 键盘、无障碍与可用性

### 8.1 键盘操作

| 按键 | 行为 |
|---|---|
| `H` | HUD |
| `T` | Timeline |
| `J` / `K` | 上一个 / 下一个事件 |
| `Enter` | 打开当前事件的 Inspector |
| `Shift + Enter` | 进入 Timeline 并定位当前事件 |
| `N` | 给当前事件添加 / 移除本地注记 |
| `Ctrl/Cmd + K` | 打开命令面板 / 搜索 |
| `Esc` | 关闭临时层、取消焦点或退出命令面板 |
| `?` | 打开帮助 |

### 8.2 语义要求

- 轨道块使用 `<button>` 或带完整键盘代理的交互元素；
- `aria-pressed` 表达轨道焦点和视图切换；
- `aria-live="polite"` 只播报模式、选中对象和关键错误，不播报每一条时间刻度；
- 颜色状态必须同时有文字或图形标记；
- 不能用 `title` 作为唯一说明；
- 1280×720 下 HUD、三轨和 Inspector 的主要入口必须可见；
- 低宽度时先隐藏 Detail Dock，再折叠 Browser / Inspector，不把轨道裁成不可操作的窄条。

---

## 9. HTML / CSS / JS 落地映射

### 9.1 原有 DOM 对应

| V4 / 当前选择器 | V6 行为 |
|---|---|
| `.transport-bar` | 增加章节签、状态印章和主题切换入口 |
| `.status-ruler` | 增加 focus track、window label、活动数 |
| `.browser-panel` | `.browser-section` 使用纸带索引和当前色条 |
| `.workspace-panel` | 保持三列 / 两行布局 |
| `.studio-view-switch` | HUD / Timeline 的唯一模式入口 |
| `.story-hud` | 增加 pulse、章节签、next action、事件带 |
| `.arrangement` | 复用真实轨道；Overview 只改变展示高度 |
| `.arrangement-ruler` | 增加 playhead flag、章节线、焦点标签 |
| `.inspector-panel` | 首屏显示下一步，再展开来源字段 |
| `.detail-panel` | 保持 Script / Events / Deliveries / Usage / Data |

### 9.2 原型文件

`desktop/src/renderer/index-v6.html` 是独立、无 Electron API 的设计稿：

- 内置静态 fixture，不调用 `app.js`；
- 演示 HUD / Timeline 切换、窄轨聚焦、事件选中、注记、Inspector、主题切换；
- 使用与 V4 对应的类名和 `data-*` 语义，便于未来拆回 `index.html`、`style.css`、`workspace-layout.css`；
- 不替换生产入口，不覆盖已经修复的 V4 转场代码。

推荐生产实施顺序：

1. 先把 token、focus、selected、note 状态接入现有 renderer；
2. 再将 HUD 内静态结构拆成现有 `renderStoryHud` 的增量节点；
3. 复用当前轨道渲染和 V4 FLIP 转场；
4. 最后迁移批注、命令面板和纸带索引样式；
5. 每一步都保留 `index-v6.html` 作为视觉回归基准。

---

## 10. 分阶段实施计划

### V6-A：纸面 token 与结构稳定

- 增加 `paper-studio` / `night-signal` 的 V6 token；
- 统一边线、硬影、印章和焦点 ring；
- 不改业务数据和视图状态；
- 通过截图确认 V4 HUD、Timeline、Connect、Logs、Console 均可读。

### V6-B：可操作窄轨

- 为 Script / Receive / Send 增加事件按钮语义；
- 单击选择、双击进入 Timeline、空白处定位 playhead；
- 轨道菜单与窄轨共享当前状态；
- Inspector 显示事件来源、目标和下一步。

### V6-C：纸带索引与注记

- Browser 当前分组增加色条 / 折角；
- 增加 UI-only 本地注记；
- 注记必须支持撤销、清空和 sessionStorage 迁移；
- 不让注记混入故事事实或导出数据。

### V6-D：动画与质量门

- 复用 V4 的轨道几何转场修复；
- 增加焦点铅笔线和状态印章，但不改变布局时序；
- 增加 reduced-motion、快速反向点击、空数据和错误数据用例；
- 完成构建、类型检查、UI 测试和人工截图审查。

---

## 11. 验收标准

### 11.1 设计验收

- 打开页面 3 秒内可辨认：当前故事、运行状态、当前视图和下一步动作；
- HUD 看起来仍是 V4 的纸面工作台，而不是另一套控制台；
- V6 的增强主要通过线、索引、印章、折角和交互状态体现；
- 纸面材质不会降低文本、按钮和事件块的对比度；
- Night Signal 只是暗色材质变体，不改变结构和术语。

### 11.2 交互验收

- 三条窄轨可点击、可聚焦、可选中、可双击展开；
- 单击事件后 Inspector、Detail 和轨道焦点指向同一个事件；
- HUD → Timeline → HUD 不丢失时间窗、scrollLeft、选中事件和 focusTrack；
- 快速连续切换不会出现旧轨道覆盖新轨道、内容跳跃或高度竞争；
- 所有新增交互都有键盘路径和可见焦点；
- 空数据、离线、暂停和错误状态仍然可理解、可恢复。

### 11.3 工程验收

- 生产入口 `desktop/src/renderer/index.html` 不被原型文件自动替换；
- `index-v6.html` 不依赖 Node、Electron、远程字体或网络资源；
- 不新增后端字段，不改变 Worker / Koishi 权限边界；
- 在合入生产 renderer 前通过 `npm run build`、`npm run typecheck`、`npm run test:ui` 和 `npm run test:timeline`；
- 对 HUD / Timeline 至少保留一组截图基准和一组 reduced-motion 基准。

---

## 12. 最终设计判断

V4 的优点不是“看起来简单”，而是它把故事、轨道和 Timeline 放进了一个可理解的空间关系里。V6 的任务不是用更强烈的视觉覆盖这个关系，而是让用户感觉：

- 纸面上的每条线都可以继续追踪；
- 每个事件块都可以继续行动；
- 每次展开都保留自己的上下文；
- 每个大胆的视觉细节都在解释一个状态或入口。

因此 V6 应被实施为 **V4 的 Paper Workbench 2.0**，而不是新的视觉主题重做。

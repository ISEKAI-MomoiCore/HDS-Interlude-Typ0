# HDSI Desktop typ·0 UI 设计规范 v3

## 高度自定义主题、社区皮肤与日式极简工作台

> 状态：设计方案 + 首轮协议实现已落地
>
> 基于：`UI_DESIGN_SPEC_V2.md`
>
> 适用项目：`HDSI-desktop-typ-0`
>
> 核心目标：在保持信息密度和专业效率的同时，建立一个可以由社区制作、分享和维护 UI 皮肤的主题系统。官方出厂主题使用日式极简设计语言，强调留白、秩序、纸面感、低装饰和高可读性。

---

## 1. V3 的设计方向

### 1.1 一句话定义

**一套像工作室一样高效、像日式文具一样克制、像个人工作台一样可塑的桌面界面。**

### 1.2 三个核心平衡

V3 不把“高密度”和“宽松美观”理解为互相排斥的选择，而是分为三个层次处理：

| 层次 | 设计策略 |
|---|---|
| 数据密度 | 同一屏展示更多有效信息，减少重复标题、无意义卡片和大面积空白 |
| 视觉呼吸 | 使用明确的层级间距、细分隔线和区域留白，避免信息粘连 |
| 交互密度 | 常用动作就近放置，高风险动作收进菜单，避免每个控件都争夺注意力 |

### 1.3 V3 目标

- 官方主题默认具有统一、克制、耐看的日式极简风格。
- 用户可以调整颜色、密度、字体、圆角、阴影、布局和动效。
- 社区可以制作主题包，不需要修改主程序源码。
- 主题包可以导入、导出、预览、回滚和安全卸载。
- 主题变化不改变业务语义、状态含义、键盘操作和数据结构。
- 在 1280×720、125% 系统缩放下仍然保持可用。
- 高密度模式不把正文压缩到不可读，不把关键状态隐藏在颜色中。

### 1.4 非目标

- 不允许主题作者覆盖账号权限、消息投递、文件读写或 Worker 控制逻辑。
- 不允许通过主题包加载远程脚本。
- 不把所有页面做成自由拖拽的白板；布局可调，但必须有稳定的语义区域。
- 不提供无限数量的官方预设。官方主题需要经过可读性、性能和状态覆盖测试。

---

## 2. 视觉哲学：日式极简工作台

### 2.1 关键词

- **Ma（间）**：留白用于分隔语义，不是装饰性空白。
- **Shibui（涩）**：低饱和、克制、耐看，不使用持续发光和强渐变。
- **Kanso（简素）**：去除不承担任务的视觉元素。
- **Seijaku（静）**：动效轻、状态稳定、视觉不喧闹。
- **Shibumi（雅）**：使用少量精确的强调色承载行为意义。

### 2.2 高密度的实现方式

高密度不通过缩小所有字体实现，而是通过以下方法实现：

1. 将重复的说明移入 tooltip 和帮助层。
2. 将状态摘要放在同一行，详情放入 Inspector。
3. 用细分隔线代替厚重卡片边框。
4. 用短标签、计数和图标减少重复标题。
5. 让轨道、日志和列表支持连续滚动，而不是每条数据单独卡片化。
6. 只对主要动作使用高对比度颜色。
7. 在关键区块之间保留 8–16px 的清晰呼吸间距。

### 2.3 美学禁用项

官方主题默认不使用：

- 大面积渐变背景；
- 持续闪烁或呼吸光效；
- 过度圆角；
- 玻璃拟态作为主要容器；
- 无语义的装饰性图形；
- 用纯黑和纯白造成刺眼对比；
- 在所有按钮上使用图标和阴影。

社区主题可以突破这些限制，但导入时必须通过可读性和性能检查。

---

## 3. 主题系统的层级模型

主题不是一份直接替换 CSS 的文件，而是五层合成结果：

```text
系统默认基础值
  ↓
官方或社区主题 Palette
  ↓
视觉风格 Style
  ↓
用户密度、字体、布局和组件覆盖
  ↓
无障碍与系统约束覆盖
  ↓
最终运行时 CSS Variables
```

### 3.1 优先级

从低到高：

1. `core-defaults`
2. `theme.palette`
3. `theme.style`
4. `user.customization`
5. `accessibility.override`
6. `runtime.state`

业务状态永远覆盖主题颜色。例如主题作者不能把错误状态变成与成功状态完全相同的颜色。

### 3.2 主题和布局分离

主题负责：

- 颜色；
- 字体；
- 间距；
- 圆角；
- 边框；
- 阴影；
- 动效；
- 组件视觉层级。

布局配置负责：

- 面板是否显示；
- Browser、Inspector、Detail 宽度；
- 时间线轨道顺序；
- 默认工作区；
- 是否启用紧凑工具栏；
- 侧栏分组展开状态。

布局不能修改语义区域的职责，也不能隐藏唯一的错误提示、保存按钮或运行状态。

---

## 4. 主题包规范

### 4.1 目录结构

```text
my-theme/
├─ theme.json          # 必需：主题清单和 token
├─ preview.svg         # 必需：主题预览图，禁止脚本和外链
├─ README.md           # 推荐：作者说明和使用建议
├─ license.txt         # 推荐：授权信息
├─ assets/             # 可选：本地静态资源
│  ├─ logo.svg
│  └─ texture.svg
└─ fonts/              # 可选：随包字体，需明确授权
```

主题包默认只能包含 JSON、Markdown、SVG、PNG、WebP、WOFF2 等受控资源。禁止执行 `.js`、`.html`、`.exe` 或动态加载远程资源。

### 4.2 `theme.json` 最小结构

```json
{
  "$schema": "https://hdsi.local/theme.schema.v3.json",
  "schemaVersion": 3,
  "id": "community-washi",
  "name": "Washi Paper",
  "displayName": "和纸",
  "version": "1.0.0",
  "author": {
    "name": "HDSI Community",
    "url": "https://example.invalid"
  },
  "license": "CC-BY-4.0",
  "description": "米白纸面与墨色文字的低刺激工作台。",
  "tags": ["light", "minimal", "japanese", "high-density"],
  "base": "hdsi-japanese-light",
  "compatibility": {
    "minAppVersion": "0.0.1",
    "maxAppVersion": "*"
  },
  "preview": "./preview.svg",
  "tokens": {},
  "components": {},
  "layout": {},
  "accessibility": {
    "minimumContrast": "AA",
    "supportsHighContrast": true,
    "supportsReducedMotion": true
  }
}
```

### 4.3 主题 ID 规则

- 只允许小写字母、数字和短横线；
- 长度 3–48；
- 不得使用官方保留前缀 `hdsi-` 以外的系统 ID；
- 版本使用 SemVer；
- 主题包导入后以 `id@version` 建立缓存；
- 同 ID 新版本必须经过兼容性检查后替换。

### 4.4 主题元数据

主题选择器必须展示：

- 名称；
- 作者；
- 版本；
- 许可证；
- 兼容版本；
- 亮/暗/高对比等标签；
- 密度；
- 是否包含本地字体；
- 最近验证结果；
- 是否为官方主题。

---

## 5. Token 体系

### 5.1 基础颜色 Token

```json
{
  "tokens": {
    "color": {
      "canvas": "#f5f1e8",
      "surface": "#fbf9f4",
      "surfaceRaised": "#ffffff",
      "surfaceSunken": "#ebe6da",
      "border": "#d8d0c2",
      "borderStrong": "#b9ad9c",
      "textPrimary": "#292722",
      "textSecondary": "#625d54",
      "textMuted": "#8c8579",
      "textDisabled": "#aaa398",
      "accent": "#b56a3c",
      "accentSoft": "#ead5c5",
      "success": "#547a53",
      "warning": "#a06b2c",
      "danger": "#a44c4c",
      "info": "#536f85",
      "focus": "#8a5a3d"
    }
  }
}
```

### 5.2 层级颜色

所有颜色必须通过语义 Token 使用，组件不得直接引用主题作者自定义的原始色值：

```css
--hdsi-color-canvas
--hdsi-color-surface
--hdsi-color-text-primary
--hdsi-color-text-secondary
--hdsi-color-state-success
--hdsi-color-state-warning
--hdsi-color-state-danger
--hdsi-color-state-info
--hdsi-color-track-script
--hdsi-color-track-receive
--hdsi-color-track-send
```

这样可以在高对比模式和未来主题迁移时统一修正。

### 5.3 密度 Token

```json
{
  "tokens": {
    "density": {
      "baseUnit": 4,
      "scale": 0.92,
      "panelPadding": 12,
      "sectionGap": 10,
      "controlGap": 6,
      "rowHeight": 28,
      "compactRowHeight": 24,
      "timelineTrackHeight": 32,
      "scriptTrackHeight": 96
    }
  }
}
```

密度档位：

| 档位 | scale | 正文 | 控件高度 | 适用 |
|---|---:|---:|---:|---|
| 极简高密度 | 0.88 | 12px | 26px | 日志、时间线、诊断 |
| 工作台 | 0.94 | 12px | 28px | 默认 |
| 标准 | 1.00 | 13px | 32px | 长时间配置 |
| 宽松 | 1.08 | 14px | 36px | 演示、低视力 |

任何档位都不得让正文低于 12px，状态标签不得低于 11px。

### 5.4 几何 Token

```json
{
  "tokens": {
    "geometry": {
      "radiusNone": "0px",
      "radiusSm": "2px",
      "radiusMd": "4px",
      "radiusLg": "7px",
      "borderThin": "1px",
      "borderStrong": "1px",
      "focusRingWidth": "2px"
    }
  }
}
```

官方日式主题使用 `radiusSm` 与 `radiusMd`，避免所有元素变成卡片。

### 5.5 字体 Token

```json
{
  "tokens": {
    "typography": {
      "ui": "'Yu Gothic UI', 'Microsoft YaHei', sans-serif",
      "display": "'Yu Mincho', 'Microsoft YaHei', serif",
      "mono": "'Cascadia Code', Consolas, monospace",
      "bodySize": "13px",
      "smallSize": "11px",
      "labelSize": "10px",
      "lineHeight": 1.5,
      "letterSpacing": "0.01em"
    }
  }
}
```

字体策略：

- UI 和数据默认使用无衬线字体；
- 只在标题、空状态或故事文本中可选用日式衬线字体；
- 社区字体必须随包提供或使用系统字体名；
- 禁止主题下载远程字体；
- 字体加载失败必须自动回退。

### 5.6 动效 Token

```json
{
  "tokens": {
    "motion": {
      "enabled": true,
      "level": "subtle",
      "fast": "100ms",
      "normal": "160ms",
      "slow": "240ms",
      "easing": "cubic-bezier(.2,.7,.2,1)"
    }
  }
}
```

支持：`off`、`subtle`、`standard`。官方主题不得使用 `strong` 动效等级。

系统 `prefers-reduced-motion: reduce` 时强制使用 `off`。

---

## 6. 官方出厂主题

官方主题数量控制在 5 个，每个主题解决一种真实工作场景。

### 6.1 主题总览

| ID | 名称 | 基调 | 密度 | 推荐场景 |
|---|---|---|---|---|
| `hdsi-japanese-light` | 白纸 | 米白、墨黑、柿色 | 工作台 | 默认、日常配置 |
| `hdsi-sumi` | 墨 | 深炭、灰白、朱砂 | 极简高密度 | 长时间运行、日志 |
| `hdsi-aizome` | 蓝染 | 靛蓝、雾蓝、米灰 | 工作台 | Studio、时间线 |
| `hdsi-matcha` | 抹茶 | 茶绿、竹灰、土黄 | 标准 | 轻量工作、低刺激 |
| `hdsi-akari` | 灯 | 暖灰、琥珀、深棕 | 宽松 | 演示、夜间阅读 |

### 6.2 白纸 `hdsi-japanese-light`

设计语言：和纸、墨色标题、柿色重点。

- Canvas：`#f5f1e8`
- Surface：`#fbf9f4`
- Primary text：`#292722`
- Accent：`#b56a3c`
- Border：`#d8d0c2`
- 阴影：默认关闭，仅在弹窗使用轻阴影；
- 轨道：使用低饱和蓝、朱、茶紫，不使用霓虹；
- 状态：成功用茶绿，警告用赭黄，错误用朱红。

页面表现：

- 左侧 Browser 稍深于主画布；
- 标题区使用细横线而不是厚色块；
- 时间线轨道背景接近纸面，clip 使用低饱和纯色；
- 空状态使用一条柿色竖线作为视觉锚点。

### 6.3 墨 `hdsi-sumi`

设计语言：墨色纸面、银灰文字、少量朱砂。

- Canvas：`#202120`
- Surface：`#292a28`
- Primary text：`#e9e7e0`
- Accent：`#c97952`
- Border：`#464943`
- 只使用轻微层级差，不使用黑色渐变；
- 适合高密度时间线和日志；
- 错误状态使用更明亮的朱红边框和文字，避免依赖红色点。

### 6.4 蓝染 `hdsi-aizome`

设计语言：深靛蓝底、雾蓝文字、米白内容。

- Canvas：`#1d2730`
- Surface：`#25343f`
- Primary text：`#e7ecec`
- Accent：`#d7a66a`
- Info：`#83b7c7`
- 适合时间轴和故事关系浏览；
- Receive 轨使用雾蓝，Send 轨使用暖米色，Script 轨使用柔紫。

### 6.5 抹茶 `hdsi-matcha`

设计语言：低饱和茶绿、竹灰、米黄色。

- Canvas：`#eef0e8`
- Surface：`#f8f8f1`
- Primary text：`#2d332d`
- Accent：`#6e8056`
- 适合长时间阅读和配置；
- 避免鲜艳绿色造成“全部正常”的误判，状态绿色使用更深的茶色。

### 6.6 灯 `hdsi-akari`

设计语言：夜间室内光、暖灰纸面、琥珀操作色。

- Canvas：`#282522`
- Surface：`#332e29`
- Primary text：`#eee4d7`
- Accent：`#d39a54`
- 动效使用 subtle；
- 适合展示和夜间使用；
- 禁止大面积发光，保证文字边缘清晰。

### 6.7 官方主题共性

- 所有主题必须通过 AA 对比度检查；
- 所有主题都提供高对比变体；
- 所有主题都支持 reduced motion；
- 主题切换不改变布局数据和用户已选故事；
- 主题预览图必须展示：顶栏、连接卡片、时间线、日志和弹窗五种状态。

---

## 7. 主题选择器与自定义编辑器

### 7.1 主题选择器

入口：`更多 → 外观与主题`，快捷键 `Ctrl+Shift+T`。

```text
┌────────────────────────────────────────────────────────────┐
│ 外观与主题                                   [关闭]        │
├────────────────────────────────────────────────────────────┤
│ 当前主题：白纸 · HDSI 官方                                  │
│ [应用] [编辑副本] [导出]                                    │
├────────────────────────────────────────────────────────────┤
│ 官方主题                                                     │
│ [白纸] [墨] [蓝染] [抹茶] [灯]                              │
├────────────────────────────────────────────────────────────┤
│ 我的主题                                                     │
│ [和纸社区版] [工作台高对比] [+ 新建主题]                    │
├────────────────────────────────────────────────────────────┤
│ 社区主题                                                     │
│ [导入主题包] [打开主题文件夹]                               │
└────────────────────────────────────────────────────────────┘
```

主题卡片必须显示：

- 预览图；
- 主题名称；
- 作者和版本；
- 视觉标签；
- 密度；
- 可访问性检查结果；
- 当前状态：使用中 / 有修改 / 不兼容 / 验证失败。

### 7.2 编辑器布局

```text
┌──────────────────────────────────────────────────────────────┐
│ 编辑主题：白纸副本                         [预览] [保存]     │
├──────────────┬───────────────────────────────┬───────────────┤
│ 类别导航     │ 控件编辑区                    │ 实时预览       │
│              │                               │               │
│ 快速预设     │ 当前区块的 Token 和组件       │ 当前页面       │
│ 颜色         │                               │ 连接 / Studio  │
│ 字体         │                               │ / Logs         │
│ 密度         │                               │               │
│ 组件         │                               │               │
│ 布局         │                               │               │
│ 动效         │                               │               │
│ 无障碍       │                               │               │
└──────────────┴───────────────────────────────┴───────────────┘
```

### 7.3 快速设置

编辑器顶部提供三组无需理解 Token 的选项：

1. 视觉风格：纸面、墨色、蓝染、现代、工业。
2. 信息密度：高密度、工作台、标准、宽松。
3. 动效：关闭、轻微、标准。

切换快速设置会生成可撤销的草稿，不直接覆盖用户主题。

### 7.4 颜色编辑

颜色编辑以语义名称展示，而不是 `--accent-3`：

- 主背景；
- 工作区背景；
- 主文字；
- 次文字；
- 边框；
- 主要操作；
- 成功；
- 警告；
- 错误；
- 信息；
- Script / Receive / Send / Media / Facts 轨道。

每个颜色控件同时显示：

- 色板；
- HEX；
- 对比度；
- 是否通过 AA；
- 恢复默认按钮。

### 7.5 实时预览

实时预览至少提供五个场景：

1. 连接页：成功、警告、错误卡片；
2. Studio：轨道和 clip；
3. Logs：普通、警告、错误行；
4. 配置页：输入框、按钮、tab；
5. Dialog：保存、危险确认和空状态。

预览默认使用静态 fixture，不调用真实 Worker，不发送消息，不读取用户数据。

### 7.6 保存策略

按钮：

- `应用预览`
- `保存为新主题`
- `覆盖当前主题`
- `导出主题包`
- `恢复上次保存`
- `重置当前区块`

编辑器关闭时有未保存修改，必须显示变更数量和“继续编辑 / 保存 / 放弃”。

---

## 8. 社区主题生态

### 8.1 社区作者体验

社区作者应当可以：

1. 复制官方主题作为起点；
2. 在主题编辑器里调整 Token；
3. 导出主题包；
4. 在本地预览所有状态；
5. 运行验证器；
6. 发布到社区仓库或手动分享文件。

不要求社区作者修改 `app.js` 或重新构建 Electron 主程序。

### 8.2 主题包安全边界

默认主题包只允许声明式资源：

- JSON Token；
- CSS 变量映射；
- 受控组件变体；
- 本地图片和字体；
- 预览图。

禁止：

- 任意 JavaScript；
- `@import` 外链；
- 远程图片、远程字体、远程 CSS；
- 修改 CSP；
- 读取 `window.desktop`、IPC、文件系统或密钥；
- 覆盖消息内容和用户数据；
- 修改状态文本语义；
- 通过 CSS 隐藏危险按钮或错误消息。

### 8.3 CSS 限制

主题 CSS 如果未来开放，必须满足：

- 选择器只能以 `[data-hdsi-theme]` 或允许的组件类开头；
- 禁止 `@import`；
- 禁止 `url(http://...)` 和 `url(https://...)`；
- 禁止 `behavior`、`expression`、脚本 URL；
- 禁止覆盖 `display:none` 到强制可见的状态区域；
- 禁止修改 `pointer-events` 使用户无法操作核心控件；
- 禁止无限大 z-index；
- 单个主题 CSS 体积默认不超过 256KB。

首版建议完全不开放任意 CSS，只开放 Token 和预定义组件变体。

### 8.4 社区主题验证器

导入时执行：

1. JSON Schema 校验；
2. ID 和版本校验；
3. 资源路径校验；
4. 外链和脚本扫描；
5. 颜色对比度检查；
6. 必填状态覆盖检查；
7. 字体回退检查；
8. 预览图安全检查；
9. 兼容版本检查；
10. 渲染快照检查。

验证结果分为：

- `通过`
- `通过但有警告`
- `阻断导入`

警告不能阻止本地试用，但主题卡片必须显示警告。

### 8.5 社区分享格式

导出文件使用 `.hdsitheme` 扩展名，本质是 ZIP：

```text
theme.hdsitheme
├─ theme.json
├─ preview.svg
├─ README.md
├─ license.txt
└─ assets/
```

主题包包含完整版本信息和校验摘要，不依赖在线服务才能使用。

### 8.6 社区市场的最低信息

如果未来提供在线主题列表，主题卡片至少显示：

- 作者；
- 版本；
- 更新时间；
- 下载量；
- 许可证；
- 支持的应用版本；
- 是否通过安全校验；
- 是否包含外部资源；
- 最近报告的问题。

市场不是主题运行时的必要依赖。离线环境仍可导入本地包。

---

## 9. 主题与组件的技术契约

### 9.1 CSS 变量命名

```css
[data-hdsi-theme] {
  --hdsi-color-canvas: ...;
  --hdsi-color-surface: ...;
  --hdsi-color-text-primary: ...;
  --hdsi-color-state-success: ...;
  --hdsi-space-1: ...;
  --hdsi-space-2: ...;
  --hdsi-radius-sm: ...;
  --hdsi-border-thin: ...;
  --hdsi-font-ui: ...;
  --hdsi-motion-fast: ...;
}
```

组件样式只能使用契约变量，不得直接写死主题颜色。

### 9.2 组件变体

允许主题选择的组件变体：

```ts
type ComponentVariant = {
  button: 'flat' | 'outline' | 'filled' | 'text'
  panel: 'line' | 'card' | 'paper' | 'sunken'
  status: 'dot-and-label' | 'bar-and-label' | 'icon-and-label'
  tabs: 'underline' | 'segment' | 'rail'
  timeline: 'dense' | 'standard' | 'editorial'
  log: 'compact' | 'comfortable' | 'table'
}
```

变体只能改变呈现，不改变 DOM 语义和行为。

### 9.3 状态契约

所有主题都必须实现以下状态：

```ts
type UiStatus =
  | 'idle'
  | 'checking'
  | 'ready'
  | 'running'
  | 'muted'
  | 'paused'
  | 'offline'
  | 'warning'
  | 'error'
  | 'unknown'
  | 'disabled'
```

主题只提供这些状态的视觉映射，不能删除状态或重新定义含义。

### 9.4 强制可见区域

以下区域即使主题作者设置极简布局，也必须可见：

- 当前故事；
- 当前运行状态；
- Worker/bridge 状态；
- 当前页面标题；
- 保存按钮；
- 错误和警告消息；
- 弹窗关闭按钮；
- 键盘焦点环。

---

## 10. 布局自定义

### 10.1 可自定义内容

用户可以保存：

- Browser 是否显示；
- Inspector 是否显示；
- Detail 高度；
- Browser、Inspector 宽度；
- 默认 Studio 子页；
- 默认时间范围；
- 轨道顺序和可见性；
- 日志默认过滤；
- 连接页是否作为启动页；
- OSD 是否显示。

### 10.2 不可自定义内容

- 状态语义；
- 主导航的可达性；
- 保存和取消行为；
- 错误区域的可见性；
- 键盘焦点顺序；
- 危险操作确认；
- 最小可读字号。

### 10.3 布局配置示例

```json
{
  "layout": {
    "mode": "workbench",
    "panels": {
      "browser": true,
      "inspector": true,
      "detail": true
    },
    "widths": {
      "browser": 248,
      "inspector": 300
    },
    "detailHeight": 210,
    "defaultStudioView": "timeline",
    "defaultRange": "14h",
    "tracks": ["script", "receive", "send", "media", "alter", "facts", "preplan"],
    "hiddenTracks": ["compaction"]
  }
}
```

### 10.4 布局预设

官方提供三种布局：

| 布局 | 结构 | 使用场景 |
|---|---|---|
| 日常 | Browser + Workspace + Inspector | 观察和聊天 |
| 工作台 | 三栏 + Detail | 调试和编辑 |
| 诊断 | Logs + Detail + OSD | 排错和运行维护 |

布局预设和主题独立保存。切换主题不应重置面板布局。

---

## 11. 日式极简组件规范

### 11.1 顶栏

- 高度 44–48px；
- 使用单条底边线；
- 品牌标志不使用持续动画；
- 当前故事使用细边框 select 或弹出列表；
- 运行状态使用文字胶囊或短标签；
- 主要按钮使用单一强调色；
- 不在顶栏堆叠多个彩色状态灯。

### 11.2 卡片

官方主题默认使用“线框卡片”：

- 1px 边框；
- 4px 圆角；
- 无投影；
- 标题和状态在同一行；
- 描述最多两行；
- 主要操作位于右下或标题右侧。

### 11.3 表格与列表

- 使用 28–32px 行高；
- 行间使用细线；
- Hover 只改变背景，不使用大阴影；
- 当前行使用左侧 2px 强调线；
- 数字和 ID 使用等宽字体；
- 长文本截断时提供完整 tooltip。

### 11.4 时间线

- 轨道头和内容区使用相同的垂直节奏；
- clip 不使用过度圆角；
- Script clip 使用主色，Receive/Send 使用方向和颜色双重提示；
- 推断数据使用虚线边缘和“推断”标签；
- 选择状态使用焦点环，不仅改变颜色。

### 11.5 状态标签

状态标签格式：

```text
● 在线
! 需要处理
× 连接失败
? 结果未知
```

不同主题可以更换图标风格，但必须保留文字。

### 11.6 Dialog

- 宽度 420–720px；
- 配置编辑器最大高度为窗口高度减 48px；
- 标题、说明、内容和操作区分层；
- 底部按钮顺序：取消、次要操作、主要操作；
- 危险操作使用明确的红色边框或警示区，不使用整窗红色。

---

## 12. 无障碍和可读性要求

主题系统必须在最终合成结果上做检查，而不是只检查主题原始色值。

### 12.1 强制要求

- 正文最小 12px；
- 关键状态对比度达到 WCAG AA；
- 状态不能只由颜色表达；
- 所有图标按钮有 `aria-label`；
- 所有 tab 有 `role` 和 `aria-selected`；
- 所有异步状态区有 `aria-live`；
- 焦点环不能被主题关闭；
- 支持 `prefers-reduced-motion`；
- 图表有文本摘要或表格替代；
- 高对比模式自动提升边框和状态文字对比度。

### 12.2 主题验证失败处理

如果主题不满足对比度：

1. 编辑器显示具体 Token 和对比度数值；
2. 提供一键修正；
3. 允许本地预览；
4. 默认禁止设为全局主题；
5. 可以导出为“实验主题”，并明确标记风险。

---

## 13. 性能和稳定性

### 13.1 性能预算

- 主题切换首次应用不超过 100ms；
- 已缓存主题切换不超过 50ms；
- 主题包最大 5MB；
- 主题资源总请求数为 0，全部使用本地资源；
- 主题切换不触发故事列表、时间线和日志重载；
- 主题编辑器预览只刷新 CSS，不重建真实工作区。

### 13.2 主题缓存

```ts
interface ThemeCacheRecord {
  id: string
  version: string
  contentHash: string
  installedAt: string
  lastUsedAt: string
  validation: ValidationReport
}
```

缓存损坏时自动回退到最近一次可用主题，再回退到 `hdsi-japanese-light`。

### 13.3 崩溃保护

主题应用过程必须使用临时状态：

```text
读取主题 → 校验 → 生成变量 → 应用到临时层 → 渲染检查 → 提交
```

如果任何一步失败，不修改当前正在使用的主题。

---

## 14. 文件和代码组织

建议增加：

```text
desktop/src/renderer/
├─ theme/
│  ├─ theme-loader.js
│  ├─ theme-schema.js
│  ├─ theme-validator.js
│  ├─ theme-runtime.js
│  ├─ theme-preview.js
│  ├─ theme-editor.js
│  └─ theme-storage.js
├─ themes/
│  ├─ builtin/
│  │  ├─ hdsi-japanese-light/
│  │  ├─ hdsi-sumi/
│  │  ├─ hdsi-aizome/
│  │  ├─ hdsi-matcha/
│  │  └─ hdsi-akari/
│  └─ community/
├─ components/
│  ├─ status-badge.js
│  ├─ empty-state.js
│  ├─ confirm-dialog.js
│  └─ theme-card.js
└─ styles/
   ├─ tokens.css
   ├─ components.css
   ├─ surfaces.css
   └─ accessibility.css
```

主题系统不得继续向 `app.js` 追加大量主题逻辑。`app.js` 负责状态和页面组合，`theme-runtime.js` 负责主题合成，`theme-editor.js` 负责编辑器。

---

## 15. 测试策略

### 15.1 单元测试

- JSON Schema 校验；
- 深度合并优先级；
- Token 缺省回退；
- 主题 ID 和版本；
- 颜色对比度；
- 禁止外链扫描；
- 主题卸载后的回退；
- `prefers-reduced-motion` 覆盖。

### 15.2 渲染测试

每个官方主题必须对以下页面做快照：

- 连接页成功/警告/错误；
- Studio 空状态和有数据状态；
- 时间线全轨道；
- Logs 普通/警告/错误；
- 配置弹窗；
- 危险确认弹窗；
- 高对比模式；
- reduced motion 模式。

### 15.3 交互测试

- 切换主题不改变当前故事；
- 切换主题不丢失未保存配置；
- 导入主题失败不影响当前主题；
- 删除当前主题自动回退；
- 主题编辑器取消不会写入主题；
- 布局预设和主题切换互不覆盖；
- 社区主题不能访问桌面 IPC。

### 15.4 性能测试

- 1000 条日志；
- 1000 个时间线条目；
- 10 个故事；
- 主题切换连续 50 次；
- 125% 和 150% 系统缩放；
- 1280×720、1366×768、1920×1080。

---

## 16. 实施分期

### Phase 1：主题运行时基础

1. 建立 CSS Token 层；
2. 把现有硬编码颜色替换为语义变量；
3. 实现主题加载、深度合并和回退；
4. 实现 `hdsi-japanese-light` 和 `hdsi-sumi`；
5. 加入主题切换测试。

### Phase 2：布局和密度

1. 抽离布局状态；
2. 实现高密度、工作台、标准、宽松四档；
3. 实现三套官方布局预设；
4. 完成 Browser、Inspector、Detail 的可保存尺寸。

### Phase 3：主题选择器和编辑器

1. 主题卡片；
2. 实时预览；
3. 语义颜色编辑；
4. 密度、字体、组件变体编辑；
5. 导出和导入。

### Phase 4：社区主题包

1. `.hdsitheme` 打包和解包；
2. Schema 和资源验证；
3. 本地主题目录；
4. 主题版本与回退；
5. 社区主题示例和作者文档。

### Phase 5：质量与发布

1. 五个官方出厂主题完整覆盖；
2. 对比度和快照检查；
3. 高对比和 reduced motion；
4. Windows 缩放和窗口尺寸验收；
5. 发布主题开发模板。

---

## 17. 验收标准

### 17.1 视觉

- [ ] 默认主题体现纸面、墨色、细线和低饱和强调色。
- [ ] 无大面积无语义装饰。
- [ ] 同一页面的层级最多使用四级表面色。
- [ ] 主要动作只使用一个主强调色。
- [ ] 高密度模式仍保留 12px 正文和清晰行距。
- [ ] 所有出厂主题在连接、Studio、Logs、Dialog 五种场景下风格一致。

### 17.2 自定义

- [ ] 用户可以实时预览主题修改。
- [ ] 用户可以保存为新主题，不覆盖官方主题。
- [ ] 用户可以导出并重新导入主题包。
- [ ] 用户可以单独重置某个区块。
- [ ] 主题和布局可以独立保存。
- [ ] 主题切换不会丢失故事、筛选器和配置草稿。

### 17.3 社区

- [ ] 不修改主程序源码即可制作主题包。
- [ ] 导入前完成安全、兼容和可读性验证。
- [ ] 主题包不能执行脚本或加载外链。
- [ ] 主题作者可以使用官方主题作为基础主题。
- [ ] 主题包包含作者、版本、许可证和预览图。
- [ ] 主题失效时自动回退到安全主题。

### 17.4 实用性

- [ ] 运行、静音、暂停、离线、警告、错误和未知状态都有文字说明。
- [ ] 所有关键状态不依赖颜色单独表达。
- [ ] 时间线、日志、分析可以互相定位。
- [ ] 1280×720 下主要操作可达。
- [ ] 125%/150% 系统缩放下无重叠和裁切。
- [ ] reduced motion 模式下所有状态仍然清楚。

---

## 18. 最终推荐

V3 的第一版不应直接开放“任意 CSS 和任意布局”。推荐采用以下路径：

1. 先完成语义 Token 和五个官方日式主题；
2. 再完成密度、布局和组件变体；
3. 再提供主题编辑器；
4. 最后开放经过验证的声明式社区主题包；
5. 在社区生态成熟后，再评估受限 CSS 扩展。

这样既能保证出厂体验稳定，也能让社区拥有足够的创作空间。主题可以改变 typ·0 的气质，但不能改变状态含义、操作可达性和运行安全。

---

## 19. 社区自定义的开放等级

V3 不把“主题”限定为换颜色。社区可以从轻量换肤逐步进入完整界面重构，但每一级开放能力都必须有明确的运行边界。

### 19.1 五级开放模型

| 等级 | 名称 | 可改变内容 | 是否需要代码 | 发布建议 |
|---|---|---|---:|---|
| L0 | Token 皮肤 | 颜色、字体、间距、圆角、阴影、动效 | 否 | 默认允许 |
| L1 | 组件皮肤 | 按钮、卡片、表格、轨道、状态、日志行变体 | 否 | 默认允许 |
| L2 | 工作区布局 | 面板顺序、宽度、轨道、工具栏和详情区域 | 否 | 默认允许 |
| L3 | 页面重组 | 页面由内置组件重新组合，完全改变页面结构 | 否 | 验证后允许 |
| L4 | 沙箱 UI 包 | 自定义页面、组件和交互编排，访问受控数据和命令 | 可选 | 用户明确启用 |

L0–L3 的主题包不执行脚本。L4 使用沙箱运行时，不直接访问 Electron 主进程、文件系统、密钥和任意 IPC。

### 19.2 “完全重构界面”的定义

完全重构不等于让主题包拥有桌面进程权限，而是允许社区重新定义：

- 顶栏和侧栏的组织方式；
- 页面中区块的排列方式；
- 故事卡片、时间线、日志、统计和配置的显示结构；
- 默认页面和工作区入口；
- 面板是否使用卡片、表格、列表或分栏；
- 状态信息的位置和密度；
- 组件之间的跳转关系；
- 同一数据在不同页面上的视图形式。

业务动作仍使用官方动作注册表，例如 `story.pause`、`story.load`、`config.save`、`log.openCorrelation`。社区主题可以决定按钮位于哪里、显示什么文字和图标，但不能伪造动作结果。

### 19.3 能改与不能改

社区可以改变：

- 页面结构；
- 视觉层级；
- 组件组合；
- 主题文案；
- 状态的视觉表达；
- 页面之间的导航；
- 密度和布局；
- 内置数据的排序和筛选；
- 是否显示低优先级字段。

社区不能改变：

- 状态的实际语义；
- 账号权限；
- 消息发送目标；
- 文件、密钥和数据库的访问权限；
- 失败时的确认和错误记录；
- 必须可达的保存、取消、返回和关闭操作；
- 无障碍最小要求。

---

## 20. 完整社区 UI 包规范

### 20.1 两种包类型

#### Declarative UI Pack

声明式 UI 包，推荐用于社区市场：

- 只使用 JSON、SVG、CSS Token 和内置组件；
- 不执行 JavaScript；
- 可以完整重组页面；
- 可以定义筛选、排序、条件显示和动作绑定；
- 不能访问任意网络和文件。

#### Sandboxed UI Pack

沙箱 UI 包，适合高级作者：

- 可以包含受限 JavaScript；
- 运行在独立 iframe 或受限 Web Worker 中；
- 只能访问授权的 View Model 和 Command API；
- 不能直接访问 `window.desktop`、Electron IPC、Node.js、文件系统或密钥；
- 安装时必须展示权限清单；
- 默认不允许开机自动启用。

社区市场默认只接受 Declarative UI Pack。Sandboxed UI Pack 需要单独标记和人工审核。

### 20.2 完整包目录

```text
my-workspace-ui/
├─ manifest.json              # UI 包清单
├─ theme.json                 # 主题 Token
├─ layout.json                # 壳层和页面布局
├─ pages/                     # 页面声明
│  ├─ connect.json
│  ├─ studio.json
│  ├─ diagnostics.json
│  └─ console.json
├─ components/                # 可复用声明式组件
│  ├─ story-card.json
│  ├─ status-strip.json
│  └─ timeline-lane.json
├─ assets/
│  ├─ preview.svg
│  ├─ icon.svg
│  └─ textures/
├─ locales/
│  ├─ zh-CN.json
│  ├─ ja-JP.json
│  └─ en-US.json
├─ README.md
└─ license.txt
```

Sandboxed UI Pack 额外允许：

```text
├─ runtime/
│  ├─ index.js
│  └─ worker.js
└─ permissions.json
```

### 20.3 `manifest.json`

```json
{
  "$schema": "https://hdsi.local/ui-pack.schema.v3.json",
  "schemaVersion": 3,
  "kind": "declarative-ui-pack",
  "id": "community-washi-workbench",
  "name": "和纸工作台",
  "version": "1.0.0",
  "author": {
    "name": "HDSI Community",
    "url": "https://example.invalid"
  },
  "license": "MIT",
  "description": "以和纸、墨线和编辑台为中心的完整界面重构。",
  "compatibility": {
    "minAppVersion": "0.0.1",
    "maxAppVersion": "*",
    "requiredUiContract": 3
  },
  "entry": {
    "theme": "./theme.json",
    "layout": "./layout.json",
    "pages": "./pages"
  },
  "capabilities": {
    "replacesShell": true,
    "replacesPages": true,
    "customComponents": true,
    "customCommands": false
  },
  "permissions": [],
  "preview": "./assets/preview.svg"
}
```

### 20.4 UI 包类型定义

```ts
type UiPackKind = 'declarative-ui-pack' | 'sandboxed-ui-pack'

interface UiPackCapabilities {
  replacesShell: boolean
  replacesPages: boolean
  customComponents: boolean
  customCommands: boolean
}

interface UiPackPermissions {
  network?: 'none' | 'loopback' | 'allowlist'
  storage?: 'none' | 'pack-local'
  clipboard?: boolean
  notifications?: boolean
}
```

默认权限必须为空。任何新增权限都必须显示为安装确认项，并且能够在设置中随时撤销。

---

## 21. Declarative Layout DSL

### 21.1 设计目标

布局 DSL 需要足够开放，可以重排整套界面；同时必须保留：

- 语义标签；
- 键盘顺序；
- 最小尺寸；
- 可见状态；
- 动作确认；
- 错误和状态通道。

### 21.2 Shell 定义

```json
{
  "shell": {
    "regions": [
      {
        "id": "global-header",
        "component": "ShellHeader",
        "required": true,
        "minSize": { "height": 44 }
      },
      {
        "id": "story-navigation",
        "component": "StoryNavigation",
        "required": true,
        "collapse": "drawer"
      },
      {
        "id": "main-workspace",
        "component": "PageOutlet",
        "required": true
      },
      {
        "id": "context-inspector",
        "component": "InspectorOutlet",
        "required": false,
        "collapse": "overlay"
      },
      {
        "id": "detail-dock",
        "component": "DetailOutlet",
        "required": true,
        "collapse": "bottom-sheet"
      }
    ]
  }
}
```

### 21.3 页面定义

```json
{
  "page": {
    "id": "studio-overview",
    "title": {
      "key": "page.studioOverview.title",
      "fallback": "剧本总览"
    },
    "route": "studio/overview",
    "viewModel": "story.overview",
    "layout": {
      "type": "stack",
      "gap": "lg",
      "children": [
        {
          "type": "component",
          "component": "StoryHealthHeader"
        },
        {
          "type": "grid",
          "columns": { "min": 220, "max": 1 },
          "children": [
            { "type": "component", "component": "RecentActivity" },
            { "type": "component", "component": "DeliverySummary" }
          ]
        }
      ]
    }
  }
}
```

### 21.4 内置布局节点

第一版提供以下节点：

- `stack`
- `row`
- `grid`
- `split`
- `tabs`
- `scroll`
- `when`
- `repeat`
- `component`
- `slot`
- `divider`
- `spacer`

禁止在 Declarative UI Pack 中创建原始 HTML 节点。这样可以保证组件语义、键盘行为和主题 Token 一致。

### 21.5 条件显示

```json
{
  "type": "when",
  "condition": {
    "path": "story.worker.status",
    "equals": "ready"
  },
  "then": {
    "type": "component",
    "component": "TimelineWorkspace"
  },
  "else": {
    "type": "component",
    "component": "WorkerEmptyState"
  }
}
```

条件表达式只允许读取 View Model，不允许执行函数、访问全局对象或拼接任意代码。

### 21.6 重复列表

```json
{
  "type": "repeat",
  "source": "stories.visible",
  "key": "meta.id",
  "empty": {
    "type": "component",
    "component": "StoryEmptyState"
  },
  "item": {
    "type": "component",
    "component": "StoryCard",
    "props": {
      "story": "$item"
    }
  }
}
```

### 21.7 Slot 和扩展点

官方页面暴露稳定扩展点：

```text
shell.header.leading
shell.header.actions
story.navigation.top
story.navigation.bottom
studio.overview.before
studio.overview.after
studio.timeline.toolbar
studio.timeline.trackHeader
diagnostics.filters
diagnostics.detail.actions
```

社区 UI 包可以替换整个页面，也可以只向某个 slot 添加组件。

---

## 22. 组件注册表和数据绑定

### 22.1 组件不是业务逻辑

主题组件只接收 View Model 和明确的 props：

```ts
interface UiComponentDefinition {
  id: string
  version: string
  accepts: string[]
  props: Record<string, UiPropDefinition>
  states: string[]
  actions: string[]
  accessibility: {
    role: string
    labelKey: string
    keyboard: string[]
  }
}
```

### 22.2 官方组件示例

```text
ShellHeader
StorySelector
StoryNavigation
StoryCard
StatusStrip
ReadinessChecklist
AccountCard
ModelCard
TimelineWorkspace
TimelineTrack
TimelineClip
SessionList
LogTable
LogRow
StatsCards
AnalysisChart
InspectorPanel
DetailDock
EmptyState
ErrorState
ConfirmDialog
```

### 22.3 View Model

社区界面读取的是稳定的、经过脱敏的 View Model，而不是底层数据库对象：

```ts
interface StoryOverviewViewModel {
  story: {
    id: string
    name: string
    characterName: string
    phase: string
  }
  worker: {
    status: string
    version?: string
    bridge?: string
  }
  channel: {
    status: string
    label: string
    endpointLabel?: string
  }
  model: {
    status: string
    providerLabel?: string
    modelLabel?: string
  }
  inbox: { pending: number }
  outbox: { pending: number, unknown: number }
  recentActivity: RecentActivityViewModel[]
}
```

View Model 不提供 API Key、token、文件绝对路径和未授权故事数据。

### 22.4 Action Registry

```ts
type UiActionId =
  | 'story.select'
  | 'story.create'
  | 'story.load'
  | 'story.unload'
  | 'story.setPhase'
  | 'story.pause'
  | 'story.mute'
  | 'story.resume'
  | 'story.backup'
  | 'story.import'
  | 'config.open'
  | 'config.save'
  | 'config.reload'
  | 'account.bind'
  | 'account.unbind'
  | 'connection.recheck'
  | 'timeline.refresh'
  | 'timeline.goNow'
  | 'log.openCorrelation'
  | 'diagnostics.export'
  | 'console.attach'
  | 'console.detach'
```

动作绑定示例：

```json
{
  "component": "Button",
  "props": {
    "label": "恢复运行",
    "intent": "primary",
    "action": "story.resume",
    "args": {
      "storyId": "$story.id"
    },
    "confirm": false
  }
}
```

危险动作必须声明 `confirm` 或 `confirmPolicy`，主题包不能绕过确认。

---

## 23. Sandboxed UI Pack

### 23.1 适用范围

Sandboxed UI Pack 用于真正想重写交互的高级作者，例如：

- 把 Studio 重写成卡片式故事阅读器；
- 把 Logs 重写成事件流和过滤工作台；
- 为社区角色创作专属的故事控制台；
- 增加不修改核心数据的本地可视化。

### 23.2 运行容器

推荐结构：

```text
Electron Renderer
  └─ UI Pack Host
      └─ sandbox iframe
          └─ community runtime
```

iframe 必须使用：

- `sandbox="allow-scripts"`；
- 无 `allow-same-origin`，除非使用独立不可写 origin；
- 无 Node integration；
- 无 Electron remote；
- 只通过 `postMessage` 接收经过筛选的 View Model 和 Action Response。

### 23.3 Sandbox API

```ts
interface HdsiUiSandboxApi {
  getViewModel(path: string): Promise<unknown>
  subscribe(path: string, listener: (value: unknown) => void): Unsubscribe
  dispatch(action: UiActionRequest): Promise<UiActionResult>
  openInspector(target: InspectorTarget): Promise<void>
  openDetail(target: DetailTarget): Promise<void>
  showToast(input: ToastInput): void
  getThemeTokens(): Readonly<Record<string, string>>
}
```

不提供：

- `fetch` 任意 URL；
- Node API；
- `desktop` 对象；
- 文件系统；
- secrets；
- 原始数据库查询；
- 未经筛选的 IPC。

### 23.4 Sandbox 权限

```json
{
  "permissions": {
    "network": "none",
    "storage": "pack-local",
    "clipboard": false,
    "notifications": false
  }
}
```

如果主题需要网络，例如加载社区自己的帮助内容，必须声明域名 allowlist，且默认关闭。主题市场不允许以主题名义收集用户数据。

### 23.5 沙箱失败处理

Sandboxed UI Pack 崩溃或超时后：

1. 自动显示官方安全页面；
2. 保存崩溃摘要；
3. 标记主题为“运行失败”；
4. 提供“仅本次使用官方界面”；
5. 不影响 Worker、故事和消息收发。

---

## 24. 页面完整重构示例

### 24.1 社区主题：故事阅读室

该主题完全替换默认三栏工作台：

```text
┌─────────────────────────────────────────────────────────────┐
│ 故事名             当前状态       [继续] [静音] [更多]      │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  今天                                                       │
│  ┌───────────────────────────────────────────────────────┐  │
│  │ 她在窗边写下……                                        │  │
│  │ 用户：你今天过得怎么样？                              │  │
│  │ 她：还不错，下午去了一趟书店。                        │  │
│  └───────────────────────────────────────────────────────┘  │
│                                                             │
│  [时间线] [事实] [计划] [投递]                              │
└─────────────────────────────────────────────────────────────┘
```

该主题仍然绑定官方 `story.select`、`story.setPhase`、`timeline.refresh` 和 `openDetail` 动作，不需要直接理解底层轨道。

### 24.2 社区主题：纯诊断工作台

```text
┌──────────────┬──────────────────────────────────────────────┐
│ 故事列表     │ 错误流                                      │
│              ├──────────────────────────────────────────────┤
│ Worker 状态  │ 过滤器  correlation  时间范围               │
│ 账号状态     ├──────────────────────────────────────────────┤
│ 模型状态     │ 日志表                                      │
│              │                                              │
│              ├──────────────────────────────────────────────┤
│              │ 事件详情 / 原始上下文 / 投递结果             │
└──────────────┴──────────────────────────────────────────────┘
```

该主题可以隐藏 Studio 的大部分视觉元素，但必须保留故事选择、Worker 状态和错误出口。

### 24.3 社区主题：角色档案馆

以角色卡片、关系、事实和剧情分支为主，不默认显示日志和 Mixer。对于普通用户，这是一种完整的页面重构；对于运行时，仍然使用同一套故事、事实和分支 API。

---

## 25. 五个日式出厂主题的页面级设计

本节定义官方主题在每个页面上的具体实现。主题之间共享组件契约，但不共享相同的视觉层级。

### 25.1 页面级共通骨架

所有官方主题的页面都包含四个语义层：

1. **识别层**：当前故事、页面名称、运行状态。
2. **操作层**：当前页面最常用动作。
3. **内容层**：数据、时间线、列表、表单或图表。
4. **解释层**：详情、来源、错误和帮助。

页面不通过装饰性大标题制造层级。标题、分隔线、状态标签和区域间距共同承担层级。

### 25.2 连接页

#### 白纸

- 背景使用纸面米白；
- 步骤卡是细边框矩形，不使用投影；
- 已完成项使用茶绿小印章样式；
- 阻断项使用柿色左边线；
- 右侧就绪检查使用“检查单”样式；
- 主按钮为柿色实心，其余为墨色线框。

#### 墨

- 左侧步骤使用炭灰层级；
- 状态用银灰文字 + 朱砂线；
- 错误状态在卡片左侧显示 2px 朱色线；
- 连接进度使用细横线，不使用旋转圆环；
- 适合同时显示多个账号和上游状态。

#### 蓝染

- 步骤编号使用靛蓝圆角方块；
- 就绪检查使用蓝染布签视觉；
- 模型、渠道和 Worker 使用三列状态摘要；
- 主按钮为暖米色，避免全页面蓝色失去层级。

#### 抹茶

- 卡片背景接近竹纸；
- 成功状态使用深茶绿；
- 连接错误使用土红而不是高饱和红；
- 表单行距稍宽，适合初次配置。

#### 灯

- 背景为暖炭色；
- 就绪检查使用暖灯色标题；
- 重点状态使用琥珀短线；
- 弹窗和卡片使用极轻的暖色阴影；
- 适合夜间配置和演示。

### 25.3 Studio 总览

#### 白纸

- 顶部显示故事标题、角色名和一行状态；
- 下方使用两列摘要：最近活动、记忆、投递、模型；
- 关键数字使用墨色等宽字体；
- 最近一条角色消息作为纸面摘录显示。

#### 墨

- 总览默认显示紧凑信息表；
- 状态和错误更靠近数据，不单独使用大卡片；
- OSD 以极小的等宽数字固定在右下角；
- 适合长时间后台运行。

#### 蓝染

- 总览使用“故事谱”概念：主角、参与者、端点和当前场景分层排列；
- 关系线和分支使用低饱和蓝紫色；
- 主要动作放在顶部右侧；
- 适合多故事和多分支浏览。

#### 抹茶

- 总览使用更明显的章节标题；
- 事实和场景摘要放在活动摘要下方；
- 绿色只表示正常，不表示正在运行；
- 适合阅读型用户。

#### 灯

- 总览强调最近活动和下一步；
- 当前角色的最近一句话以暖纸条显示；
- 统计数字使用琥珀色；
- 适合演示和展示。

### 25.4 时间线

#### 白纸

- 标尺为细墨线；
- Script 轨使用灰紫色纸签；
- Receive/Send 轨使用蓝和柿色方向色；
- Clip 的边缘为 1px 墨线；
- 选中时只增加柿色外框，不改变内容颜色。

#### 墨

- 高密度模式默认显示 8 个轨道；
- 轨道头使用炭灰和银字；
- Clip 使用纯色，不使用渐变；
- 错误投递在 Send 轨显示朱砂短线；
- 时间线底部保留快速过滤条。

#### 蓝染

- 主标尺使用深靛背景上的雾蓝刻度；
- 轨道之间以布纹般的细横线区分，但不加载外部纹理；
- 分支和场景边界使用不同的蓝紫色；
- 当前时间线范围使用暖米色标记。

#### 抹茶

- 轨道背景使用竹灰；
- 事实和场景使用柔和茶紫；
- 计划轨道使用土黄虚线；
- 更重视正文和时间标签的可读性。

#### 灯

- 时间线使用暖炭背景；
- 当前播放头为琥珀色；
- 重要 Script clip 可使用轻微暖色高光；
- 不使用发光边缘，避免夜间疲劳。

### 25.5 Session 片段

#### 白纸

- 片段显示为连续的纸页列表；
- 每页顶部显示时间、条目数和分支按钮；
- 分支按钮使用线框，不使用强色填充；
- 选中页使用柿色左边线。

#### 墨

- 使用紧凑表格式片段列表；
- 每行显示 entry 范围、字符数和状态；
- 详细文本在 Detail 中打开；
- 默认不展示大段正文。

#### 蓝染

- 片段按分支树分组；
- 分支关系使用靛蓝连接线；
- 当前分支使用米色标记；
- 支持按主线、分支、孤立片段筛选。

#### 抹茶

- 片段卡内容较宽松；
- 正文摘要最多显示 4 行；
- 片段下方显示场景、事实和关系标签；
- 适合阅读和回顾。

#### 灯

- 片段以暖纸片形式展示；
- 最近片段位于顶部；
- 分支续写使用明确的琥珀主按钮；
- 重要片段可以显示轻微的纸张层次阴影。

### 25.6 行为设置

#### 白纸

- 设置按“联系、模型、记忆、群聊、扩展”分区；
- 快速预设使用纸签；
- 复杂参数默认折叠；
- 未保存状态显示在标题右侧。

#### 墨

- 设置使用高密度双栏表格；
- 右侧显示参数说明；
- 当前修改行显示朱砂短线；
- 保存区固定在底部，避免长页面找不到按钮。

#### 蓝染

- 设置分组使用深靛 tab；
- 每个区块显示影响范围和重载要求；
- 模型、账号和群聊配置显示关系链；
- 适合高级用户集中调整。

#### 抹茶

- 默认使用标准字号和更大控件；
- 每个设置区显示“推荐值”；
- 不确定参数显示简短例子；
- 适合首次配置。

#### 灯

- 设置区块使用暖灰卡片；
- 主要参数使用琥珀滑块；
- 高风险操作使用暖红警示区；
- 适合演示期间快速调整。

### 25.7 Logs / Diagnostics

#### 白纸

- 日志为墨色表格；
- 错误行使用朱色左边线；
- 搜索和过滤位于表头；
- Detail 显示原始内容和跳转按钮。

#### 墨

- 默认最高信息密度；
- 使用等宽字体和固定列；
- 时间、来源、等级、消息四列对齐；
- 仅错误和警告使用颜色，普通行不着色。

#### 蓝染

- 日志按事件链分组；
- correlation ID 使用靛蓝标签；
- 一条链路可以展开为入站、模型、出站三段；
- 适合分析跨 Worker 的问题。

#### 抹茶

- 日志行距稍宽；
- 过滤器使用清晰的文字按钮；
- 失败原因默认显示完整短句；
- 适合不熟悉日志的用户。

#### 灯

- 错误和结果未知使用暖红/琥珀；
- 重要日志显示为暖纸条；
- 支持“只看需要处理”的工作视图；
- 适合演示和快速排错。

### 25.8 Stats / Analysis

#### 白纸

- 统计卡片使用无阴影线框；
- 图表使用墨线和柿色重点；
- 数据更新时间显示在标题右侧；
- 事实地图采用米白背景和低饱和节点。

#### 墨

- 统计采用紧凑数字表；
- 图表只使用两到三种颜色；
- 低谷、错误和异常使用朱砂点；
- 适合诊断长时间运行数据。

#### 蓝染

- 关系和相似度图使用蓝紫色层级；
- 场景之间的关联用细线表达；
- 重要节点用暖米色点出；
- 支持按分支筛选。

#### 抹茶

- 统计卡片使用更高的行距；
- 重要性和置信度同时显示数值；
- 图表旁提供文本结论；
- 避免只用颜色表达高低。

#### 灯

- 统计摘要优先于图表；
- 图表使用暖琥珀线；
- 异常以“需要查看”列表呈现；
- 适合在演示时快速说明故事状态。

### 25.9 Koishi Console

#### 白纸

- Console 作为干净的内嵌纸面区域；
- 状态未就绪时显示简洁检查单；
- 失败信息使用柿色左边线。

#### 墨

- Console 外壳使用深炭色；
- endpoint、Worker 和嵌入状态显示为等宽状态条；
- 适合开发和排错。

#### 蓝染

- Console 状态使用靛蓝连接关系；
- 当前故事和 Worker 标签置于左上角；
- 适合多 Worker 管理。

#### 抹茶

- 未嵌入状态提供清晰的下一步；
- 错误文本保持较大字号；
- 适合普通用户。

#### 灯

- Console 外壳使用暖炭和琥珀边线；
- 重试和在浏览器打开按钮保持高可见度；
- 适合展示和现场操作。

---

## 26. 社区作者的界面设计指南

### 26.1 作者必须先定义使用场景

主题提交前必须回答：

- 面向新用户、日常运行、开发诊断还是展示？
- 默认信息密度是什么？
- 主题是浅色、深色还是双模式？
- 主要阅读对象是故事文本、日志还是状态数据？
- 是否需要额外布局？
- 是否支持高对比和 reduced motion？

不接受只换颜色但没有使用场景说明的主题作为官方推荐主题。

### 26.2 页面设计说明

每个完整 UI 包必须提供 `README.md`，说明：

1. 设计理念；
2. 默认布局；
3. 各页面入口；
4. 颜色语义；
5. 适合的屏幕尺寸；
6. 支持的语言；
7. 已知限制；
8. 回退行为。

### 26.3 状态覆盖矩阵

作者必须为每个页面提供状态覆盖：

| 页面 | 空状态 | 加载 | 成功 | 警告 | 错误 | 结果未知 |
|---|---:|---:|---:|---:|---:|---:|
| 连接 | 必须 | 必须 | 必须 | 必须 | 必须 | 可选 |
| Studio | 必须 | 必须 | 必须 | 必须 | 必须 | 可选 |
| Logs | 必须 | 必须 | 必须 | 必须 | 必须 | 必须 |
| 配置 | 必须 | 必须 | 必须 | 必须 | 必须 | 必须 |
| Analysis | 必须 | 必须 | 必须 | 必须 | 必须 | 可选 |
| Console | 必须 | 必须 | 必须 | 必须 | 必须 | 可选 |

### 26.4 设计质量检查

主题作者不能只提交截图。提交包需要通过：

- 1280×720 检查；
- 1920×1080 检查；
- 125%/150% 缩放检查；
- 键盘操作检查；
- 长文本检查；
- 长故事和长日志检查；
- 错误状态检查；
- 主题切换和回退检查。

---

## 27. 社区主题版本和兼容策略

### 27.1 UI Contract 版本

UI Contract 版本描述稳定的：

- View Model；
- Action Registry；
- Component Registry；
- Layout DSL；
- 状态枚举。

主题包声明 `requiredUiContract`。应用升级后：

- 主版本不兼容时禁止启用；
- 次版本变更时运行迁移；
- 补丁版本通常向后兼容。

### 27.2 主题迁移

```ts
interface ThemeMigration {
  fromSchema: number
  toSchema: number
  migrate(input: unknown): unknown
}
```

迁移前创建只读备份。迁移失败时保留原包，不覆盖用户正在使用的版本。

### 27.3 回退顺序

```text
当前社区主题
  ↓ 加载失败
上一个可用社区主题
  ↓ 不可用
hdsi-japanese-light
  ↓ 核心错误
系统最低安全样式
```

回退后必须在状态栏显示“已回退主题”，并提供查看错误详情的入口。

---

## 28. 官方预设与社区重构的关系

官方主题不是限制社区的模板，而是稳定的参考实现：

- 官方主题提供完整 Token；
- 官方主题提供所有页面状态；
- 官方主题提供可复制的布局 DSL；
- 官方主题提供组件变体和测试 fixture；
- 官方主题提供对比度、缩放和性能基准。

社区主题可以：

1. 只复制颜色和字体；
2. 复制官方布局后重新排序；
3. 复制某个页面并替换组件；
4. 完整替换所有页面；
5. 在沙箱中实现自己的交互壳。

每一种方式都应当复用同一套数据和动作契约，避免主题越自由，系统越容易出现行为分叉。

---

## 29. 新增验收清单

### 社区自定义

- [ ] L0–L4 开放等级在安装界面中明确显示。
- [ ] Declarative UI Pack 不包含脚本和远程资源。
- [ ] 社区可以只改 Token，也可以完整替换页面布局。
- [ ] 完整替换页面后仍然可以选择故事、改变运行状态、保存配置和查看错误。
- [ ] 所有动作都通过 Action Registry 调用。
- [ ] 所有数据都来自经过筛选的 View Model。
- [ ] 自定义页面不能访问文件系统、密钥和任意 IPC。
- [ ] Sandboxed UI Pack 显示权限并可以撤销。
- [ ] 主题崩溃后自动回退安全页面。
- [ ] 主题包可以离线导入和使用。

### Declarative Layout DSL

- [ ] 支持 stack、row、grid、split、tabs、repeat、when、slot。
- [ ] 支持页面完全重组。
- [ ] 不允许原始 HTML 和任意脚本。
- [ ] 条件显示只读取 View Model。
- [ ] 动作必须引用官方 Action ID。
- [ ] 危险动作无法绕过确认策略。
- [ ] 必须区域不能被主题隐藏。

### 官方日式预设

- [ ] 白纸、墨、蓝染、抹茶、灯五个主题有完整页面定义。
- [ ] 每个主题覆盖连接、Studio、时间线、Session、设置、诊断、分析和 Console。
- [ ] 每个主题同时提供空、加载、成功、警告、错误状态。
- [ ] 每个主题通过对比度、缩放和 reduced motion 验收。
- [ ] 每个主题可以单独导出为参考主题包。

---

## 30. 实施顺序调整

为了真正支持“完全重构界面”，实施顺序应从单纯主题换色调整为：

### 阶段 1：语义基础

1. 整理 View Model；
2. 整理 Action Registry；
3. 整理 Component Registry；
4. 把当前硬编码页面状态抽成语义状态。

### 阶段 2：官方壳层

1. 建立 Token Runtime；
2. 建立 Shell、Page Outlet、Inspector、Detail Outlet；
3. 实现五个日式官方主题；
4. 完成页面级状态 fixture。

### 阶段 3：声明式页面

1. 实现 Layout DSL；
2. 将 Studio、Connect、Diagnostics 改为声明式页面；
3. 支持主题包覆盖页面；
4. 支持布局预设保存和回退。

### 阶段 4：社区工具链

1. 主题创建向导；
2. 页面预览和状态切换；
3. Schema 验证器；
4. `.hdsitheme` 打包器；
5. 示例社区主题。

### 阶段 5：沙箱扩展

1. 设计 sandbox host；
2. 实现 View Model 订阅；
3. 实现 Action API；
4. 权限、超时和崩溃回退；
5. 只在 Declarative 生态稳定后开放。

---

## 31. 最终原则

V3 的开放程度可以达到“完全重构界面”，但必须把自由度放在正确的层级：

- **视觉自由**：颜色、字体、几何、密度和动效；
- **结构自由**：页面、面板、轨道和组件排列；
- **交互自由**：在官方动作和数据契约内重新编排；
- **运行安全不自由**：权限、数据来源、确认和错误语义由核心保证。

官方预设负责给出稳定、美观、日式极简的出厂体验；社区主题负责扩展审美和工作方式；核心运行时负责保证所有主题都能正确表达状态并安全工作。

---

## 32. 社区自定义的完整范围矩阵

“高度自定义”不应只理解为换颜色。V3 将界面拆成六个可独立替换的层，主题作者可以只覆盖其中一层，也可以同时覆盖六层。

| 层级 | 可定义内容 | 推荐格式 | 默认开放等级 | 是否可执行代码 |
|---|---|---|---|---|
| 视觉 Token | 颜色、字号、线宽、圆角、间距、阴影、动效 | `theme.json` | L0 | 否 |
| 组件变体 | 按钮、标签、卡片、列表、时间线、日志行的呈现方式 | `variants.json` | L1 | 否 |
| 工作区布局 | 面板、轨道、侧栏、抽屉、详情区的排列和尺寸 | `layout.json` | L2 | 否 |
| 页面编排 | 页面顺序、区域组合、条件显示、重复列表、动作绑定 | `pages/*.json` | L3 | 否 |
| 自定义组件 | 由作者组合官方组件形成的可复用组件 | `components/*.json` | L3 | 否 |
| 自定义交互 | 复杂计算、动画、局部状态和自定义视图 | sandbox runtime | L4 | 受限 |

### 32.1 每一层的边界

1. **视觉 Token** 不能改变业务语义。例如把 `warning` 的颜色换成紫色可以，但不能让 `warning` 显示成“已完成”。
2. **组件变体** 不能删除可访问名称、焦点环、错误文本和确认按钮。
3. **工作区布局** 可以把 Inspector 放到左侧、变成抽屉或与主区域上下分割，但必须保留一个可达的 Inspector 入口。
4. **页面编排** 可以把 Studio 变成阅读器，也可以把 Logs 变成事件流，但必须声明所消费的 View Model 字段和所调用的 Action ID。
5. **自定义组件** 只能组合注册表组件；它不能通过属性字符串注入 HTML 或脚本。
6. **自定义交互** 只能在沙箱中运行。沙箱崩溃时，核心页面和 Worker 必须继续工作。

### 32.2 覆盖优先级

同一属性出现多处定义时，运行时按以下优先级合并：

```text
系统可访问性约束
  > 核心安全约束
  > 当前页面必需区域
  > 用户布局偏好
  > 社区页面定义
  > 社区组件变体
  > 社区 Token
  > 官方默认值
```

主题包永远不能覆盖前三层。这样可以允许完整换壳，同时避免作者通过布局隐藏错误、确认和状态。

### 32.3 页面覆盖声明

主题包需要明确自己覆盖到哪一层，避免用户安装后才发现整个导航被替换：

```json
{
  "overrides": {
    "tokens": true,
    "variants": true,
    "layout": true,
    "pages": ["studio", "timeline"],
    "shell": false,
    "sandboxRuntime": false
  },
  "fallback": {
    "unsupportedPage": "official.default",
    "missingViewModel": "official.empty",
    "runtimeError": "official.safe"
  }
}
```

安装页必须将上述覆盖范围翻译成用户可读的摘要，例如“替换 Studio 和时间线页面”“不替换主导航”“不包含脚本”。

---

## 33. 规范文件的正式定义

### 33.1 `manifest.json` 必填字段

下列字段是所有 UI Pack 的最小契约。字段未知时验证器应当给出警告，字段类型错误或缺少必填字段时阻断导入。

```ts
interface UiPackManifestV3 {
  schemaVersion: 3
  kind: 'theme-only' | 'declarative-ui-pack' | 'sandboxed-ui-pack'
  id: string                 // ^[a-z0-9][a-z0-9-._]{2,63}$
  name: string
  version: string             // SemVer
  author: {
    name: string
    homepage?: string
    contact?: string
  }
  license: string
  description: string
  compatibility: {
    minAppVersion: string
    maxAppVersion?: string
    requiredUiContract: 3
  }
  entry: {
    theme: string
    variants?: string
    layout?: string
    pages?: string
    components?: string
    runtime?: string
  }
  overrides: {
    tokens: boolean
    variants: boolean
    layout: boolean
    pages: string[]
    shell: boolean
    sandboxRuntime: boolean
  }
  capabilities: {
    replacesShell: boolean
    replacesPages: boolean
    customComponents: boolean
    customCommands: false
  }
  permissions: UiPackPermissions
  preview: string
}
```

`customCommands` 在 V3 固定为 `false`。社区包可以编排已有动作，但不能创建新的核心动作；需要新动作时必须先进入 HDSI 的正式 API 评审和版本发布流程。

### 33.2 `theme.json` 的 Token 约束

每个 Token 都有类型、单位和可接受范围。运行时只接受符合范围的值：

```json
{
  "schemaVersion": 3,
  "tokens": {
    "color.canvas": { "value": "#F5F1E8", "type": "color" },
    "color.text.primary": { "value": "#24211D", "type": "color" },
    "space.2": { "value": 8, "unit": "px", "type": "dimension", "min": 2, "max": 32 },
    "radius.sm": { "value": 2, "unit": "px", "type": "dimension", "min": 0, "max": 16 },
    "font.ui": { "value": "Noto Sans CJK SC, sans-serif", "type": "font-family" },
    "motion.fast": { "value": 120, "unit": "ms", "type": "duration", "min": 0, "max": 600 }
  }
}
```

Token 还必须支持语义别名，避免作者在每个组件里重复写颜色：

```json
{
  "aliases": {
    "color.state.warning": "color.accent.kaki",
    "color.focus.ring": "color.accent.vermilion",
    "color.surface.elevated": "color.paper.layer2"
  }
}
```

验证器需要检查别名环、未知 Token、单位不一致和对比度不足。主题包不能直接定义无限增长的任意 CSS 变量；新增 Token 必须带有 `x-community.*` 前缀，并且不能被核心组件当作安全状态使用。

### 33.3 Layout DSL 的 TypeScript 类型

下面的类型定义是布局解析器、编辑器和静态验证器共用的基础：

```ts
type LayoutNode =
  | { type: 'stack' | 'row' | 'grid'; children: LayoutNode[]; gap?: TokenRef }
  | { type: 'split'; direction: 'horizontal' | 'vertical'; ratio: number; children: [LayoutNode, LayoutNode] }
  | { type: 'tabs'; id: string; items: TabItem[]; selected?: string }
  | { type: 'scroll'; axis: 'x' | 'y' | 'both'; child: LayoutNode }
  | { type: 'when'; condition: Condition; then: LayoutNode; else?: LayoutNode }
  | { type: 'repeat'; source: ViewPath; key: string; item: LayoutNode; empty?: LayoutNode }
  | { type: 'component'; component: ComponentId; props?: Record<string, JsonValue> }
  | { type: 'slot'; slot: SlotId; fallback?: LayoutNode }
  | { type: 'divider' | 'spacer'; size?: TokenRef }

interface Condition {
  path: ViewPath
  op: 'equals' | 'notEquals' | 'in' | 'exists' | 'gt' | 'gte' | 'lt' | 'lte'
  value?: JsonValue
}
```

解析器必须拒绝函数、表达式字符串、模板插值中的任意代码和未登记的节点类型。`ratio`、`minSize`、`maxItems` 等数值必须有上限，避免主题包制造不可用的无限扩张布局。

### 33.4 View Model 字段声明

页面文件要声明自己依赖的字段，便于版本升级和离线预览：

```json
{
  "page": {
    "id": "story-reader",
    "viewModel": "story.detail",
    "requires": [
      "story.id",
      "story.name",
      "story.phase",
      "story.entries[]",
      "story.characters[]"
    ],
    "optional": ["story.cover", "story.lastActivityAt"]
  }
}
```

核心升级时若删除必需字段，兼容检查必须在安装或启动时指出具体字段，并自动切换到官方页面；不能让社区页面在运行中出现一片空白。

---

## 34. 完全重构界面的运行机制

### 34.1 三个可替换出口

为了让社区能够真正重构界面，Renderer 需要把界面拆成三个稳定出口：

```text
App Shell
  ├─ Navigation Outlet      主导航、故事选择、全局状态
  ├─ Page Outlet             当前页面的完整内容
  └─ Detail Outlet           Inspector、日志详情、确认和帮助
```

社区包可以：

- 只替换 Page Outlet，保留官方导航；
- 替换 Shell 的视觉和布局，但仍使用官方 Navigation Outlet；
- 同时替换三个出口，形成完整新壳；
- 在每个出口内使用官方组件、自己的声明式组合或沙箱视图。

### 34.2 路由和生命周期

每次页面切换都经过固定生命周期：

```text
resolve route
  → check required View Model
  → load theme/layout
  → mount page
  → subscribe state
  → handle actions
  → unmount and release subscriptions
```

主题作者无需处理 Electron 窗口、Worker 和 IPC 生命周期。页面卸载时运行时会自动取消订阅和中止未完成的沙箱任务，避免切换页面后继续写入旧页面。

### 34.3 必须保留的系统入口

即使社区包替换整个 Shell，也必须在以下任一位置提供入口：

| 系统入口 | 最低要求 |
|---|---|
| 当前故事 | 可见名称 + 切换动作 |
| 运行状态 | ready/running/error 等语义状态 |
| 全局错误 | 可展开内容 + 复制摘要 |
| 设置 | 可打开官方设置页 |
| 主题回退 | 一步切换官方安全主题 |
| 退出/关闭 | 与 Electron 窗口行为一致 |

入口可以是顶部栏、命令面板、抽屉或键盘快捷键，但不能只存在于作者 README 中。

### 34.4 主题故障隔离

渲染器需要为每个主题实例记录：

- 包 ID 和版本；
- 当前页面；
- 最近一次 Action ID；
- 沙箱执行耗时；
- 异常摘要；
- 回退原因。

发生异常时只卸载主题实例，不重启 Worker，不清除故事状态，不重复发送消息。用户再次启用主题前，系统应先显示上次失败页面和“仅本次使用官方界面”按钮。

---

## 35. 社区主题的开发工具链

### 35.1 推荐 CLI

官方提供 `hdsi-ui` CLI，社区作者不需要安装 Electron 开发环境：

```text
hdsi-ui init my-theme --template declarative
hdsi-ui dev ./my-theme --fixture all
hdsi-ui check ./my-theme
hdsi-ui snapshot ./my-theme --pages connect,studio,timeline
hdsi-ui pack ./my-theme --out my-theme.hdsitheme
hdsi-ui inspect my-theme.hdsitheme
```

命令行为：

- `init` 生成带注释的目录和最小主题；
- `dev` 启动本地预览，不连接真实账号和真实故事；
- `check` 执行 Schema、安全、无障碍和兼容性校验；
- `snapshot` 为所有页面和状态生成 PNG/SVG 快照；
- `pack` 固定 ZIP 内路径、写入摘要并生成 `.hdsitheme`；
- `inspect` 展示覆盖范围、权限、依赖版本和验证结果。

### 35.2 Fixture 状态集

预览工具必须提供统一状态，不允许作者只在“正常状态”下设计：

```text
connection: empty / checking / ready / timeout / rejected
story: no-story / loading / active / paused / muted / archived
timeline: empty / sparse / dense / long-text / branch-heavy
delivery: queued / sending / sent / failed / unknown
diagnostics: quiet / warning-heavy / error-heavy / huge-log
responsive: 1280x800 / 1440x900 / 1920x1080 / narrow-window
accessibility: 100% / 125% / 150% / reduced-motion / high-contrast
```

CLI 生成的报告需要列出每个 fixture 是否出现溢出、不可读文本、隐藏必需区域或动作失败。

### 35.3 主题编辑器的三栏工作区

官方编辑器建议采用固定三栏：

```text
┌──────────────┬───────────────────────────┬────────────────┐
│ Token / 页面 │ 实时预览                   │ 状态 / 校验     │
│ 树           │ 连接 / Studio / 时间线     │ 对比度          │
│              │ 1280 / 1440 / 移动宽度     │ 缺失字段        │
│              │                             │ 回退提示        │
└──────────────┴───────────────────────────┴────────────────┘
```

左栏负责选择 Token、组件和页面；中栏支持页面级预览、拖拽分栏和密度切换；右栏显示即时验证结果。编辑器中的修改先进入草稿，只有通过校验后才允许导出。

### 35.4 本地调试的安全默认值

`hdsi-ui dev` 使用完全虚拟的 View Model，默认关闭网络、剪贴板和通知。作者需要显式传入 `--allow-permission` 才能测试对应权限，并且权限只对当前开发会话有效。

---

## 36. 社区主题发布、审核和回滚

### 36.1 发布阶段

```text
本地开发 → 本地验证 → 私人分享 → 社区审核 → 可发现发布 → 版本更新
```

每个阶段都生成不可变的包摘要。升级只能安装新版本，不能原地修改已安装包，以便复现问题和回滚。

### 36.2 自动审核项目

自动审核至少包括：

1. ZIP 路径穿越和重复文件检查；
2. JSON Schema 和 SemVer 检查；
3. 脚本、远程 URL、危险 CSS 和隐藏元素扫描；
4. 资源大小、字体数量和图片尺寸限制；
5. 全部页面 fixture 的渲染快照；
6. 对比度、焦点可见性和 150% 缩放检查；
7. Action ID、View Model 字段和组件 ID 是否存在；
8. 沙箱权限与 manifest 是否一致。

### 36.3 人工审核重点

包含 Sandboxed UI Pack、网络 allowlist、剪贴板或通知权限的包必须人工审核。人工审核重点不是审美，而是：

- 权限是否与功能必要性匹配；
- 是否诱导用户输入密钥；
- 是否隐藏错误、确认和退出入口；
- 是否存在持续动画、音频或过度提醒；
- README 是否清楚说明数据用途和兼容版本。

### 36.4 用户侧回滚

设置页保留最近三个可用版本和一个官方安全主题。出现启动失败时，启动器按以下顺序回退：

```text
当前主题上一稳定版本
  → 官方主题（保留用户布局）
  → 官方安全主题（最小布局）
```

回滚只影响 Renderer 外观，不回滚故事、账号、消息和 Worker 配置。

---

## 37. 日式预设的统一页面规格

### 37.1 断点和网格

官方五套主题使用相同的几何基线，颜色和材质可以不同：

| 视口 | 主网格 | 左栏 | 右栏 | 内容最小宽度 |
|---|---:|---:|---:|---:|
| 1280×800 | 12 列 | 208px | 264px | 560px |
| 1440×900 | 12 列 | 240px | 288px | 640px |
| 1920×1080 | 16 列 | 264px | 320px | 760px |
| 窄窗口 | 单列 | 抽屉 | 抽屉 | 320px |

所有页面使用 8px 基线间距。标题、内容和详情之间以线、空白和状态标识形成层级，不依赖大面积阴影。

### 37.2 连接页的详细规格

连接页是首次启动和排障入口，固定为“端点摘要 + 就绪检查 + 操作区”三段：

| 区域 | 内容 | 交互 |
|---|---|---|
| 端点摘要 | Worker、Bridge、上游、账号、模型 | 点击打开对应 Inspector |
| 就绪检查 | 连接、认证、能力、故事、发送通道 | 按检查项跳转修复 |
| 操作区 | 重新检查、保存、打开日志、导入配置 | 危险操作需要确认 |

每个检查项必须同时显示图标、文字、机器状态和下一步动作。只有颜色而没有文字的状态不合格。

### 37.3 Studio 总览的详细规格

Studio 默认采用“摘要—活动—上下文”三段：

1. 摘要行显示故事名、角色、阶段、运行状态和最后更新时间；
2. 活动区显示最近 8 条事件，支持按入站、模型、出站过滤；
3. 上下文区显示记忆、事实、计划和待处理投递的数量；
4. 任何数字都能打开对应的过滤后页面，而不是只显示静态统计；
5. 无数据时显示解释原因和创建/导入入口，不显示空白卡片。

### 37.4 时间线的详细规格

时间线默认可见轨道顺序：`script → receive → model → send → alter → facts → preplan`。每条轨道都有：

- 轨道名称和当前筛选状态；
- 可折叠但不可永久隐藏的错误轨道；
- 事件数量、最近时间和异常数量；
- 键盘可达的 Clip；
- Clip 的时间、来源、摘要和状态。

拖动、缩放和过滤必须保留当前可视时间点。切换主题或布局后，时间范围、选中 Clip 和过滤条件应当保持。

### 37.5 Session 片段的详细规格

Session 页面把“阅读”和“操作”分开：

- 左侧显示片段目录、分支、时间和状态；
- 中央显示正文、角色、上下文和引用来源；
- 右侧显示继续、暂停、导出、打开时间线等动作；
- 长正文默认折叠技术元数据，展开后保留原始字段；
- 失败片段保留失败原因和重试条件，不能只显示红色标签。

### 37.6 设置页的详细规格

设置页使用稳定的两级导航：一级是“运行、连接、模型、记忆、群聊、外观、扩展”，二级是具体字段。每个字段必须包含：

```text
字段名 · 当前值 · 影响范围 · 是否需要重载 · 推荐值/示例 · 恢复默认
```

未保存变更在页面标题和导航项同时显示。离开页面时提供保存、放弃和继续编辑三个明确选项。

### 37.7 Diagnostics / Logs 的详细规格

诊断页默认分为“事件表 + 详情抽屉 + 关联链”：

- 事件表固定列：时间、等级、来源、故事、摘要；
- 详情抽屉显示 correlation ID、原始 payload 摘要、前后事件和建议动作；
- 关联链把 Receive、Model、Send 串为一条可展开链路；
- 大日志使用虚拟列表；
- 复制操作只复制用户可见的脱敏内容。

### 37.8 Stats / Analysis 的详细规格

分析页先给结论，再给图表：

1. 顶部显示成功率、平均延迟、未确认投递、活跃故事四个摘要；
2. 中部显示时间趋势、按渠道分布和异常列表；
3. 底部提供数据时间范围、采样方式和导出动作；
4. 图表必须同时提供表格或文本摘要，避免只靠颜色和图形传达信息。

### 37.9 Console 的详细规格

Console 不是独立的黑盒网页，而是带状态外壳的嵌入区域。外壳顶部必须显示：

```text
当前故事 · Worker · endpoint · 嵌入状态 · 在浏览器打开 · 重试
```

未就绪时显示诊断步骤；嵌入失败时提供外部打开和复制地址；主题不能伪造 Console 内部的登录状态。

---

## 38. 五个官方主题的出厂定位

| 主题 | 默认密度 | 主要用户 | 材质语言 | 默认布局 |
|---|---|---|---|---|
| 白纸 | 标准 | 日常创作 | 和纸、墨线、柿色印记 | 日常 |
| 墨 | 高 | 开发和长时间运行 | 炭色、银灰、朱砂线 | 工作台 |
| 蓝染 | 标准偏高 | 多故事和分支管理 | 靛蓝、布签、米色标记 | 工作台 |
| 抹茶 | 宽松 | 首次配置和阅读回顾 | 竹纸、茶绿、土色 | 日常 |
| 灯 | 标准 | 夜间使用和演示 | 暖炭、灯色、暖纸 | 日常 |

五个主题都必须提供同一套功能，不以审美差异为理由隐藏能力。差异只体现在信息层级、材质、密度、强调色和默认布局。

---

## 39. V3 交付验收补充

### 39.1 社区开放能力

- [ ] 作者可以只改 Token，也可以替换整个 Shell；
- [ ] 页面可以通过 DSL 完整重排，不需要修改核心源码；
- [ ] 每个页面都能声明 View Model 依赖和 Action 依赖；
- [ ] 无脚本包可在离线环境开发、预览、打包和安装；
- [ ] 沙箱包有权限清单、超时、崩溃隔离和官方回退；
- [ ] 主题包升级、降级和回滚不会影响业务数据；
- [ ] 校验器能覆盖安全、兼容、可访问性、性能和视觉回归。

### 39.2 出厂日式预设

- [ ] 五个主题在连接、Studio、时间线、Session、设置、诊断、分析、Console 均有页面定义；
- [ ] 每页覆盖空、加载、成功、警告、错误、无权限和窄窗口状态；
- [ ] 1280×800、150% 缩放、reduced motion 和键盘导航通过验收；
- [ ] 默认布局、密度和颜色差异不会改变同一状态的语义；
- [ ] 所有重要动作在三次操作内可达；
- [ ] 主题切换保留当前故事、页面、过滤和选中项。

### 39.3 不能接受的实现

- [ ] 用 `display:none` 隐藏错误、确认或保存区域；
- [ ] 用主题脚本直接调用 Electron IPC 或读取密钥；
- [ ] 用远程 CSS、图片或字体改变运行时外观；
- [ ] 让社区页面自行发明 Action ID 或绕过确认；
- [ ] 主题崩溃导致 Worker 重启、消息重发或故事状态丢失；
- [ ] 只展示正常态截图而没有错误、空状态和窄窗口设计。

---

## 40. V3 文档的实施建议

这份规范是目标架构，不代表当前 Renderer 已经实现完整主题运行时。建议按下面顺序把文档落到代码：

1. 先把现有页面状态整理成 View Model 和 Action Registry；
2. 用官方白纸主题完成 Token Runtime、Shell 和页面状态 fixture；
3. 再实现 Layout DSL 和三栏主题编辑器；
4. 以白纸主题导出第一个 Declarative UI Pack，验证离线安装、升级和回滚；
5. 补齐墨、蓝染、抹茶、灯四套主题及全部页面状态；
6. 最后实现 Sandboxed UI Pack，并在无脚本生态稳定后开放权限能力。

如果实现资源有限，优先保证 View Model、Action Registry、官方安全回退和验证器。这四项决定社区自定义能否长期开放，而不是一次性的 CSS 换肤功能。

---

## 35. 首轮实现对照（桌面端）

本节把 V3 规范中的协议边界映射到当前桌面端代码，便于后续继续实现时区分“已可用”和“仅有设计约束”的部分。

### 35.1 已实现

| 规范能力 | 当前实现 | 入口 |
|---|---|---|
| 主题包导入/导出 | ZIP 主题包、安装目录、原子替换与回滚 | `desktop/src/main/runtime/theme-packs.ts` |
| 主题包 IPC | pick/read/list/install/write/uninstall | `desktop/src/main/main.ts`、`desktop/src/preload/preload.ts` |
| manifest 兼容 | 可选 `manifest.json`，旧包继续读取 | `desktop/src/renderer/theme/pack-validator.js` |
| 图片资源 | `assets/` + `asset://`，运行时转换为 data URL，并接入 shell、topbar、browser、inspector、timeline、detail、dialog 等语义 surface | `style.css`、`pack-manager.js`、`theme-runtime.js` |
| 社区字体 | `fonts.ui` / `fonts.mono` 声明包内 WOFF/WOFF2；动态 `@font-face` 与 CSS 字体变量随主题切换清理 | `pack-validator.js`、`pack-manager.js`、`theme-runtime.js` |
| 受控动效 | level/preset 静态校验；`applyMotion(element, name)` 通过 Web Animations API 应用白名单关键帧，尊重档位和 reduced motion | `pack-validator.js`、`theme-runtime.js` |
| 页面安全边界 | 页面 JSON、覆盖页面 ID、来源校验 | `pack-validator.js`、`sandbox-host.js` |
| 损坏包隔离 | 单包恢复失败不会阻塞其它已安装主题 | `theme-packs.ts`、`pack-manager.js` |

### 35.2 保持兼容的规则

- 没有 `manifest.json` 的旧主题包按现有 `theme.json` 结构继续读取。
- 官方主题、V2 兼容主题和社区主题仍通过同一个主题运行时回退链应用。
- 主题包没有权限访问故事目录、密钥、Worker、任意 IPC 或远程资源。
- 导入失败只返回诊断，不替换当前正在使用的主题。

### 35.3 下一阶段实施边界

当前运行时已经能解析资源并把它们交给 CSS/页面层消费，页面视觉的完整重构仍需组件逐一接入对应变量。下一阶段按以下顺序推进：

1. 将其余页面组件逐步接入 `assetUrl()` 与语义资源变量；
2. 增加主题预览隔离层，导入前渲染静态预览；
3. 为 motion preset 接入页面级调用点，并补充真实窗口 reduced-motion 验证；
4. 增加 Electron 导入、重启恢复和失败回滚的端到端验证；
5. 增加主题版本升级、hash 和用户可读诊断。


### 35.5 协议 3.1 资源消费补充

社区主题可在 `theme.json` 声明包内字体与动效关键帧。字体仅接受 `assets/` 下的 WOFF/WOFF2，并在切换主题时删除动态样式节点和字体变量。未声明字体的主题继续使用 token 与系统回退字体。

```json
{
  "fonts": {
    "ui": { "src": "asset://fonts/ui.woff2", "weight": "400 700", "style": "normal", "display": "swap" },
    "mono": { "src": "asset://fonts/mono.woff2", "weight": "400", "style": "normal" }
  },
  "motion": {
    "level": "subtle",
    "presets": {
      "fade-in": {
        "from": { "opacity": 0 },
        "to": { "opacity": 1 },
        "properties": ["opacity"],
        "duration": 160,
        "delay": 0,
        "easing": "ease-out"
      }
    }
  }
}
```

`HDSIThemeV3.applyMotion(element, presetName)` 是宿主提供的调用面。它只读取当前已验证主题的 preset 和属性白名单；`off` 档或系统 reduced motion 下不执行插值，直接完成到目标状态。主题包仍然不能提供脚本或 CSS。当前触发器 API 已建立，具体页面调用点仍待逐一接线。

标准 surface key 为 `shell`、`topbar`、`browser`、`inspector`、`timeline`、`canvas`、`detail`、`dialog`。各 key 对应现有宿主区域的背景层；未声明时沿用既有纯色样式，图片仅作背景层，不改变布局与交互。

## 36. 操作性界面协议：宿主意图与主题动效

### 36.1 设计原则

V3 的主题系统需要表达界面状态变化的视觉语言。状态变化由宿主掌握，主题提供可验证的视觉响应。主题作者可以设计页面进入、面板展开、视图切换和反馈动效，宿主持续掌握生命周期、目标节点、业务事务和降级路径。

这个层次让社区主题可以拥有完整的界面气质，同时保证主题包不接触故事数据、账号状态、IPC、网络和文件系统。

### 36.2 协议组成

协议由三部分组成：

1. `motion.presets`：命名动效定义；
2. `interactions`：固定宿主意图到 preset 的映射；
3. 页面或布局节点的 `motion`：在声明式页面中绑定节点级触发器。

固定意图为 `page`、`panel`、`hudTimeline`、`wizard`、`mixer`、`themePreview`。固定触发器为 `enter`、`exit`、`expand`、`collapse`、`switch`、`success`、`error`。

### 36.3 示例

```json
{
  "motion": {
    "level": "subtle",
    "presets": {
      "timeline-switch": {
        "from": { "opacity": 0.9, "transform": "translateY(4px)" },
        "to": { "opacity": 1, "transform": "translateY(0)" },
        "properties": ["opacity", "transform"],
        "duration": 220,
        "easing": "cubic-bezier(.2,.8,.2,1)"
      }
    }
  },
  "interactions": {
    "hudTimeline": { "switch": "timeline-switch" }
  }
}
```

`motionSpec` 作为兼容字段保留。运行时优先读取 `motionSpec`，然后读取 `motion`。社区新包使用 `motion` 字段。

### 36.4 宿主接线

宿主界面动作在固定位置触发协议：

| 界面动作 | 意图 | 目标 |
|---|---|---|
| 页面进入 | `page.enter` | 当前 surface 根节点 |
| 页面离开 | `page.exit` | 即将卸载的页面根节点 |
| 面板展开/收起 | `panel.expand/collapse` | 对应面板根节点 |
| HUD/Timeline 切换 | `hudTimeline.switch` | `#studio-mode-viewport` |
| Wizard 步骤切换 | `wizard.switch` | 当前步骤节点 |
| 进入 Mixer | `mixer.enter` | Mixer 工作区根节点 |
| 主题预览反馈 | `themePreview.success/error` | 预览容器 |

宿主先处理状态，然后发出视觉意图。主题运行时只读取当前已验证主题的映射和 preset，动效结果不反向写入业务状态。

### 36.5 动效声明与安全边界

preset 只允许声明 `opacity`、`transform`、`clip-path`、`filter`、`background-color`、`color`、`border-color` 和 `box-shadow`。关键帧值不能包含外链、脚本、表达式或 CSS 注入内容。主题包不能包含 JavaScript、任意 CSS 文件、选择器、监听器和 IPC 调用。

主题页面中的 `motion` 支持字符串简写和触发器映射对象。验证器会递归检查页面、布局节点、tabs、when、repeat 与 scroll 的所有声明，并确认每个 preset 都存在。

### 36.6 运行时保障

- 动画具有 900ms 的页面过渡上限；
- 同一元素的新动效会取消旧动效；
- reduced-motion 或 `off` 档直接到达目标帧；
- Web Animations API 不可用时安全降级；
- 动效 Promise 失败不会阻塞页面挂载或卸载；
- 主题包验证失败不会替换当前主题；
- 旧主题没有交互声明时保持原有即时切换。

### 36.7 设计建议

官方预设使用短时、低干扰的动效表达层级和连续关系。HUD/Timeline 的几何展开由官方工作区布局控制，主题 preset 负责透明度、裁剪、颜色和轻微位移等视觉细节。主题作者应避免常驻无限循环、大面积滤镜和需要持续注意力的闪烁效果。

### 36.8 实施状态

V3 的操作性界面协议已经接入页面运行时、主题运行时、布局 DSL、主题包验证器、主题包管理器和宿主界面动作。后续扩展需要同步修改固定意图枚举、验证器、目标节点映射、示例包和测试矩阵。


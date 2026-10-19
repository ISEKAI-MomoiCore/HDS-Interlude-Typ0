# typ·0 主题包作者指南

- 适用：typ·0 桌面端 0.0.1-m4 及以上（theme-protocol 3.x，`schemaVersion: 3`）
- 本文档是**现行作者文档**：描述的是安装验证器（`desktop/src/renderer/theme/pack-validator.js`）实际执行的规则，两者冲突时以验证器为准。产品历史设计见 `docs/history/UI_DESIGN_SPEC_V3_THEME_SYSTEM.md`，协议审计与演进记录见 `UI_CUSTOMIZATION_PROTOCOL_AUDIT_AND_EXTENSION_PLAN.md`。
- 起步建议：在应用内「外观 → 导出当前官方主题为 .hdsitheme」获得参考包——它包含一套完整的合法 theme.json、包内 schema、预览图和官方页面定义，是最可靠的模板。

## 1. 能力矩阵（先读这个）

| 等级 | 能力 | 状态 |
|---|---|---|
| L0 | Token 换肤：颜色、字体栈、密度、动效等级 | ✅ 可用 |
| L1 | 包内资源：SVG/PNG/WebP/AVIF/GIF 图标与背景、WOFF/WOFF2 字体 | ✅ 可用 |
| L2 | 声明式动效：motion preset + 宿主意图绑定（interactions） | ✅ 可用 |
| L3 | 页面重组：pages/*.json 用布局 DSL 重排**官方登记组件** | ✅ 可用（仅 connect 页面有官方定义，见 §8） |
| L4 | 沙箱自定义页面（包内脚本） | ❌ **未开放**：页面 CSP 会阻断包内脚本，沙箱宿主已移除；启用需等待独立的沙箱 CSP 方案 |
| L5 | 本地开发扩展 | ❌ 未开放 |

任何形式的任意 JavaScript、远程 CSS、远程图片、文件系统与宿主 IPC 访问都被验证器拒绝——这不是 bug，是协议红线。社区包也不能注册新的核心组件；页面重组只能使用官方登记的组件（当前清单见 §8.4）。

## 2. 快速开始

一个最小可安装的主题包（`.hdsitheme`，本质是 zip）：

```text
my-theme.hdsitheme
├─ theme.json      # 必需
└─ preview.svg     # 可选（缺省时主题卡片用色板条代替）
```

`theme.json`：

```json
{
  "id": "community-my-theme",
  "version": "1.0.0",
  "name": "My Theme",
  "preview": "preview.svg",
  "tokens": {
    "color.canvas": "#f3f1eb",
    "color.text.primary": "#1f2327",
    "color.accent": "#174a63"
  }
}
```

打包：把文件放进一个目录，用任意 zip 工具压缩，改扩展名为 `.hdsitheme`。作者不需要关心 `b64:` 前缀——那是应用内部传输二进制的方式，磁盘上的包就是普通 zip。

## 3. 硬限制（超出直接拒绝安装）

| 限制 | 值 |
|---|---|
| 包总体积 | 5MB（按解压后计） |
| 单个条目 | 2MB |
| 条目数量 | 256 |
| 允许的扩展名 | json / md / txt / svg / png / webp / avif / jpg / jpeg / gif / ico / woff / woff2 / css / yaml / yml |
| 预览图 | 必须是纯静态 SVG，≤256KB |
| 脚本 | 任何 `.js` 条目都被拒绝 |

**安全扫描**作用于全部文本条目，命中即拒绝：`<script>` 标签、内联事件属性（`on...=`）、`javascript:` 协议、任何 `http(s)://` 远程链接、`@import`、指向外部的 `url()`。SVG 的 `xmlns` 声明和 theme.json 的 `$schema` 值会被豁免，其余一视同仁。

## 4. theme.json 字段

| 字段 | 必需 | 规则 |
|---|---|---|
| `id` | ✅ | `^[a-z0-9][a-z0-9-]{2,47}$`；不得以 `hdsi-` 开头（官方保留） |
| `version` | ✅ | SemVer（`1.2.3`、`1.2.3-rc.1` 均可） |
| `name` | ✅ | 字符串（展示名用 `displayName`） |
| `tokens` | ✅ | 见 §5 |
| `author` | — | 对象（如 `{ "name": "..." }`） |
| `preview` | — | 包内路径，默认 `preview.svg` |
| `density` | — | `compact` / `workbench` / `standard` / `relaxed`（默认 `workbench`） |
| `colorScheme` | — | `light` / `dark`（不写则按 canvas 亮度自动判定） |
| `aliases` | — | token 别名映射，不得成环 |
| `surfaces` | — | 区域背景声明，标准 key：`shell` `topbar` `browser` `inspector` `timeline` `canvas` `detail` `dialog` |
| `fonts` | — | 见 §7 |
| `motion` | — | 见 §9（兼容字段 `motionSpec` 仍可读，新包请用 `motion`） |
| `interactions` | — | 见 §9 |
| `overrides` | 带 `pages/` 时必需 | 至少 `overrides.pages: ["<page.id>", ...]`，须逐一对应包内页面 |
| `compatibility` | — | `{ minAppVersion, maxAppVersion }`；比较只看数字三元组、忽略预发布后缀；`maxAppVersion: "*"` 表示不限 |

`$schema` 建议写 `"./theme.schema.v3.json"` 并在包内附该文件（参考包自动携带；见 §10）。不要引用外部 URL——既解析不到，也过不了安全扫描的豁免习惯。

## 5. Token

token 用点分键名，只覆盖你想改的项，其余继承「清澄」默认值。以 `#` 开头的值必须是 `#rgb` 或 `#rrggbb`。

核心 token 名单（与 `theme/tokens.js` 的默认值同名，完整集请以参考包导出为准）：

| 族 | token |
|---|---|
| 表面 | `color.canvas` `color.surface` `color.surface.raised` `color.surface.sunken` `color.surface.hover` `color.surface.active` |
| 边线 | `color.border` `color.border.soft` `color.border.strong` `color.border.deep` |
| 文字 | `color.text.primary` `color.text.secondary` `color.text.muted` `color.text.on.accent` |
| 强调 | `color.accent` `color.accent.bright` `color.accent.faint` |
| 状态 | `color.state.success|.warning|.danger|.info` 及各自 `.bg` `.border` `.fg` |
| 时间线轨道 | `color.track.script`（+`.bright`）`color.track.receive` `color.track.send` `color.track.media` `color.track.facts` `color.track.alter` `color.track.preplan` `color.track.neutral` |
| 字体栈 | `font.ui` `font.mono`——必须以通用族（`sans-serif` / `monospace` 等）结尾，否则收到警告 |

合成结果会写成 `--hdsi-*` CSS 变量（如 `color.canvas` → `--hdsi-color-canvas`），页面 `className` 样式直接消费这些变量。`x-community.*` 前缀的自定义 token 目前不会被核心组件消费，仅作前向预留。

**对比度门槛**：`color.canvas` × `color.text.primary` ≥ 4.5（AA，低于即拒绝安装）；状态四族基色对 canvas < 3 给警告。做深浅反转主题时先过这一关。

## 6. 图片资源

- 放包内 `assets/` 目录，引用一律写 `asset://`（如 `asset://background/hero.webp`）；引用不存在的资源会被拒绝。
- 运行时 `asset://` 被转成 data URL 经 CSS 变量下发（`asset://hero.svg` → `--hdsi-asset-hero-svg`）；`surfaces` 里的 `background.image` 也走这条路。
- 远程 URL、绝对路径、`file://` 一律拒绝。

## 7. 字体

```json
"fonts": {
  "ui": { "src": "asset://fonts/ui.woff2", "weight": "400 700", "style": "normal", "display": "swap" }
}
```

- 键名：`ui` / `mono` / 或 `^[a-z][a-z0-9-]{0,31}$` 的受限命名键。
- `src` 必须是包内 `.woff` / `.woff2`。
- `weight` 100–900（整数或 `"400 700"` 这类组合），`style`：normal/italic/oblique，`display`：auto/block/swap/fallback/optional。
- 运行时生成受管 `@font-face`，切主题自动清理。

## 8. 页面包（pages/）

带 `pages/*.json`（文件名 `^pages/[\w-]+\.json$`）的包是 UI 包，必须声明 `theme.overrides.pages` 并与页面 `page.id` 一一对应。同一时刻只有一个页面包生效（用户激活其主题时接管页面，切走时解除）。

### 8.1 页面定义

```json
{
  "page": {
    "id": "connect-main",
    "route": "connect",
    "title": { "fallback": "连接与账号" },
    "viewModel": "app",
    "requires": ["app.someField"],
    "motion": { "enter": "page-enter" },
    "layout": { "type": "row", "children": [] }
  }
}
```

- `id` 必需（`^[\w-]+$`）；`requires` 列出的 View Model 路径缺失时，社区页拒绝挂载并回退官方页——用它保护你的页面不被数据变化打崩。
- 页面与节点都可声明 `motion`：字符串 = 绑定 `enter`；对象 = 触发器→preset。preset 必须在同包 `motion.presets` 里声明。

### 8.2 布局节点

| 节点 | 关键约束 |
|---|---|
| `stack` / `row` | `children` 数组；`gap`：sm/md/lg |
| `grid` | `columns.min` 需为 80–960 像素 |
| `scroll` | 必需 `child`；`axis`：x/y/both |
| `split` | `direction` horizontal/vertical；`ratio` 0.05–0.95；恰好 2 个 children |
| `tabs` | `items[]`：`id` + `label`（不得含 `<>`）+ `content` 节点 |
| `when` | `condition`：`{ path, op, value }`；`then` / 可选 `else` |
| `repeat` | `source` 为 View Path；必需 `key`；`item` / 可选 `empty`；上限 500 条 |
| `component` | 只能用官方登记组件；`props` 值禁止函数/表达式 |
| `slot` | 官方页面预留的扩展点 id；可带 `fallback` |
| `divider` / `spacer` | 无参数 |

条件运算：`equals` `notEquals` `in`（value 须数组）`exists` `gt` `gte` `lt` `lte`。View Path 形如 `app.status`（`^[\w-]+(\.[\w-]+)*$`）。

`props` / 条件 `value` 里的字符串支持 `$vm.<path>`（读 View Model）与 `$item.<path>`（repeat 迭代项）引用，其余原样输出。

### 8.3 动作

页面上能触发的动作全部经官方 Action Registry 登记（含确认策略），主题包不能新增、不能绕过确认。

### 8.4 当前官方登记组件

`ConnectSteps`、`ConnectSidePanel`（连接页）。清单随宿主演进扩充；引用未登记组件的页面在安装验证时被拒绝。

## 9. 动效

### 9.1 motion preset

```json
"motion": {
  "level": "subtle",
  "presets": {
    "page-enter": {
      "from": { "opacity": 0, "transform": "translateY(6px)" },
      "to": { "opacity": 1, "transform": "translateY(0)" },
      "properties": ["opacity", "transform"],
      "duration": 180,
      "easing": "cubic-bezier(.2,.8,.2,1)"
    }
  }
}
```

- `level`：off / subtle / standard / expressive（expressive 是兼容别名，按 standard 生效）。
- 属性白名单：`opacity` `transform` `clip-path` `filter` `background-color` `color` `border-color` `box-shadow`；`opacity` 必须是 0–1 数字。
- `duration` / `delay`：0–5000ms；`iterationCount`：1–20 或 `infinite`（`infinite` 会收到要求 reduced-motion 降级确认的警告）；`easing` 限标准关键字 / `steps()` / `cubic-bezier()`。
- 值字符串不得包含分号、大括号或函数式注入。
- 系统 `prefers-reduced-motion: reduce` 或用户选 off 时直接落最终帧——设计动效时保证最终帧就是可用状态。

### 9.2 interactions（宿主意图绑定）

意图与触发器都是**固定枚举**，主题只声明「这个意图用哪个 preset」：

| 意图 | 触发器 | 宿主目标 |
|---|---|---|
| `page` | enter / exit | 当前页面 surface |
| `panel` | expand / collapse | 面板根节点 |
| `hudTimeline` | switch | 工作区视口 |
| `wizard` | switch | 向导步骤节点 |
| `mixer` | enter | Mixer 工作区 |
| `themePreview` | success / error | 主题预览容器 |

```json
"interactions": { "page": { "enter": "page-enter" }, "panel": { "expand": "panel-expand" } }
```

preset 不存在、动效失败或被中断时宿主照常执行业务流程——动效纯视觉，不承载逻辑。

## 10. manifest.json（可选）

协议 3.1 的包身份文件，安装器不解析完整主题即可识别包；旧包没有它也能安装。字段须与 theme.json 对齐：

```json
{
  "schemaVersion": 3,
  "id": "community-my-theme",
  "version": "1.0.0",
  "displayName": "我的主题",
  "author": { "name": "..." },
  "license": "CC-BY-4.0",
  "entry": "theme.json",
  "capabilities": ["tokens", "assets", "motion", "pages"],
  "permissions": [],
  "compatibility": { "minAppVersion": "0.0.1", "maxAppVersion": "*" },
  "preview": "assets/preview.svg"
}
```

校验规则：`id` / `version` 必须与 theme.json 一致；`entry` 必须是 `theme.json`；`capabilities` 为字符串数组；`permissions` **必须为空数组**（当前协议不授予任何权限）。

## 11. 安装时会发生什么

导入 → 解包 → 静态验证（本文档全部规则 + 页面结构验证）→ **预览对话框**（身份/判定/逐条诊断/色板/预览图/接管页面清单）→ 你确认「安装」→ 安装到应用数据目录 `theme-packs/<id>/`（原子替换，失败自动回滚旧版）→ 登记。验证不过：安装按钮禁用、不落盘、不影响当前主题，诊断按 code + 位置逐条列出（如 `CONTRAST_BODY @ theme.json#tokens`）。通过但有警告（如缺少预览图、状态色对比度偏低）：可安装，警告随预览展示。

页面结构（布局 DSL）非法的 `pages/*.json` 也会在导入前阻断（诊断 code `PAGE_LAYOUT`），不会出现"安装成功但页面没生效"。

重启时已安装包会重新验证再恢复；损坏或失效的包在外观页「已失效的主题包」区列出原因，可一键重试或卸载。

## 12. 调试建议

1. 用「导出当前官方主题」得到参考包，在它的基础上改——结构保证合法。
2. `theme.json` 的 `$schema` 指向包内 `./theme.schema.v3.json`（参考包自带该文件），解包成目录后用支持 JSON Schema 的编辑器可获得实时结构校验。
3. 改完重新压缩为 zip、改后缀 `.hdsitheme`，应用内导入。每次导入都会先出预览：阻断原因按 code + 字段路径逐条给出，指到具体条目后再修。
4. 页面包先拿参考包里的 `pages/connect.json` 改起；动效 preset 名用小写短横线（`page-enter`）。
5. 深色/浅色反转主题优先核对 §5 的对比度门槛——这是最常见的安装失败原因之一。

## 13. 变更纪律

本文档随验证器演进同步修订。规则收紧时旧包按「验证不过即不安装」处理，不会静默降级；规则放松（新增能力）会在此处登记并尽量保持旧包可装。协议级变化的审计记录见 `UI_CUSTOMIZATION_PROTOCOL_AUDIT_AND_EXTENSION_PLAN.md`。

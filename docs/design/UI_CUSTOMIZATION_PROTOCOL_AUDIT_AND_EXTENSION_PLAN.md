# typ·0 桌面端代码审计与用户自定义界面协议升级提案

- 文档状态：分析稿 + 初步构建实现记录
- 审计对象：`C:\dev\HDSI-desktop-typ-0\desktop`
- 对照文档：`UI_DESIGN_SPEC_V3_THEME_SYSTEM.md`、V4–V7 界面规范
- 结论范围：当前代码问题、现有主题协议的实现差距、图片与动效扩展、深度界面重构边界
- 本轮操作：在审计结论基础上完成首轮主题协议构建；没有删除或修改剧本、配置、数据库和用户数据

---

## 1. 总结结论

当前版本的核心运行链路可以构建，现有自动化检查全部通过。审计没有发现会直接导致剧本数据丢失、故事目录被删除、出站消息重复投递的新增问题。当前需要优先处理的代码问题集中在社区主题包的落地链路和 sandbox 消息边界：

1. **社区主题包 IPC 没有接通**。渲染层已经调用 `hdsiDesktop.packs`，preload 和 main 没有对应 API 与 handler。导入、导出、恢复、卸载在当前发行包中无法形成完整闭环。
2. **sandbox-host 没有验证 `MessageEvent.source`**。同一 renderer 内的其他窗口或 iframe 可以伪造 guest RPC 消息。现有 Action Registry 限制了可执行动作，消息来源校验仍然需要补上。
3. **主题协议文档描述的开放程度高于当前实现**。当前页面 DSL 只能重组官方登记组件，社区包无法注册新组件；sandbox 具备独立页面能力，但距离完全重构桌面壳仍有宿主接线和权限边界需要定义。
4. **图片资源已经被协议允许，运行时资源模型还不完整**。当前可放入 SVG、PNG、WebP、WOFF2，缺少统一资源清单、引用解析、缓存、卸载和性能预算。
5. **动效目前主要停留在 motion token 层**。主题可以改变时长和动效等级，缺少可验证的命名动效、页面过渡、关键帧白名单以及 reduced-motion 降级规则。

推荐保留当前 theme 基座，增加一个向后兼容的协议修订版。主题包继续使用本地声明式资源，图片和动效通过受控 schema 接入，页面重排和沙箱页面继续分级开放。任意 JavaScript、远程 CSS、远程图片、任意 Electron IPC 维持禁止状态。

---

## 2. 审计依据与验证结果

### 2.1 已执行检查

在 `C:\dev\HDSI-desktop-typ-0\desktop` 执行了以下命令：

```text
npm run typecheck
npm run test:runtime
npm run test:timeline
npm run test:ui
npm run test:bfixes
npm run build
```

结果：

- TypeScript 类型检查：通过
- runtime：48 passed / 0 failed
- timeline：8 passed / 0 failed
- studio UI：通过
- B fixes：通过
- build：通过

这些结果说明当前代码没有被现有测试捕获的编译、语法和已覆盖回归错误。主题包 IPC 缺失和 sandbox 来源校验缺失属于测试覆盖之外的边界问题。

### 2.2 近期 safeStorage 修改

近期修改涉及：

- `src/main/runtime/secrets.ts` 增加 `tryGet`，区分 `missing`、`undecryptable`、`unavailable`；
- `src/main/runtime/config-compiler.ts` 在密文不可解时注入空字符串，让剧本继续进入运行流程；
- `src/main/main.ts` 的 ready check 会报告不可解密密钥。

该路径已经有运行时测试覆盖，当前没有证据表明会删除原始密钥文件或修改 canonical 剧本。运行时风险在于：密钥不可解时，连接器可能以空凭据启动并在后续连接阶段失败。ready check 已经具备提示能力，后续 UI 应把该状态显示为明确的“需要重新录入密钥”，同时避免把空字符串当作有效配置展示。

---

## 3. 代码审计结果

### 3.1 P1：社区主题包的主进程 IPC 未接通

涉及文件：

- `desktop/src/renderer/theme/pack-manager.js:66-145`
- `desktop/src/preload/preload.ts`
- `desktop/src/main/main.ts`

`pack-manager.js` 已经依赖以下接口：

```js
root.hdsiDesktop.packs.pickRead()
root.hdsiDesktop.packs.install(id, entries)
root.hdsiDesktop.packs.listInstalled()
root.hdsiDesktop.packs.write(name, entries)
root.hdsiDesktop.packs.uninstall(id)
```

当前 preload 暴露的 `hdsiDesktop` 没有 `packs`，main 进程也没有对应 `ipcMain.handle`。直接结果：

- 导入主题包进入“主进程包接口不可用”；
- 启动时无法从磁盘恢复已安装的社区主题；
- 导出主题包无法写入文件；
- 卸载只可能修改渲染层内存状态，无法清理持久化目录；
- V3 文档里描述的“导入、导出、恢复、卸载”没有实际闭环。

这属于功能链路缺失，优先级高于视觉和 schema 扩展。

#### 建议实现

在 preload 增加最小接口：

```ts
packs: {
  pickRead: () => ipcRenderer.invoke('themePacks:pickRead'),
  listInstalled: () => ipcRenderer.invoke('themePacks:listInstalled'),
  install: (id: string, entries: Record<string, string>) =>
    ipcRenderer.invoke('themePacks:install', id, entries),
  write: (name: string, entries: Record<string, string>) =>
    ipcRenderer.invoke('themePacks:write', name, entries),
  uninstall: (id: string) => ipcRenderer.invoke('themePacks:uninstall', id),
}
```

main 进程负责：

1. 通过系统文件选择器读取 `.hdsitheme`；
2. 解包后只返回主题包条目，不允许渲染层任意读取文件系统；
3. 将安装目录限制在 `userData/theme-packs/<safe-id>/`；
4. 先写入临时目录，验证通过后原子替换；
5. 写入导出包时只接受渲染层已经验证过的条目；
6. 卸载时校验 ID，禁止路径穿越；
7. 安装记录包含 schema 版本、主题 ID、版本、安装时间和校验摘要。

现阶段不需要改变主题运行时 API。补通道后再补一组 IPC 集成测试，覆盖取消选择、坏包、重复 ID、安装中断、卸载当前主题和重启恢复。

### 3.2 P1：sandbox 消息缺少来源校验

涉及文件：

- `desktop/src/renderer/semantics/sandbox-host.js:50`

当前 `handleRequest(event)` 只判断消息数据中的 `hdsiSandbox === 'guest'`，没有验证：

```js
 event.source === iframe.contentWindow
```

在同一 renderer 内，其他窗口或 iframe 理论上可以伪造 guest 消息，调用 `getViewModel`、`subscribe`、`unsubscribe`、`dispatch`、`getThemeTokens`、`showToast` 等 RPC。动作经过 Action Registry，权限风险已经被压低，消息边界仍应具备来源验证。

#### 建议修复

在处理 guest 消息前加入：

```js
if (event.source !== iframe.contentWindow) return
```

同时加入以下边界约束：

- `data.id` 必须为短字符串，长度限制在 128 字符以内；
- RPC 方法必须来自固定白名单；
- `subscribe` 数量限制在每个 sandbox 实例的预算内；
- 单次 payload 和累计待处理消息大小设上限；
- sandbox 销毁时清理所有订阅与待处理 promise；
- 保持 `postMessage('*')` 兼容 opaque origin，但始终依赖 `source` 对象校验。

### 3.3 P2：主题包验证器的错误反馈和健壮性

涉及文件：

- `desktop/src/renderer/theme/pack-validator.js`

观察到的改进点：

1. `validateEntries()` 假设所有 entry 都有 `.length`，异常输入可能让验证器自身抛出 TypeError；
2. `b64:` 条目大小按字符串长度近似估算，包大小限制存在误差；
3. `collectPages()` 遇到非法 JSON 时收集 `__invalid` 页面，最终可能表现为“安装成功但页面没有生效”；
4. `theme.overrides.pages` 只检查数组类型，没有检查声明的 page ID 是否存在；
5. DSL 页面错误应返回文件名、节点路径、字段名，当前反馈还不够集中。

建议将验证结果规范化为：

```ts
interface PackDiagnostic {
  level: 'error' | 'warning'
  code: string
  path: string
  message: string
  hint?: string
}
```

非法页面 JSON、缺少 overrides、未知 page ID 应在安装前明确阻断或显示可解释警告。验证器本身对非字符串条目先返回诊断，不直接抛异常。

### 3.4 P2：safeStorage 不可解密时的可观测性

当前降级策略保障了剧本加载连续性。连接器可能收到空凭据，导致用户在连接阶段才看到失败。建议：

- `readyCheck` 返回每个 alias 的状态和修复动作；
- 运行时 overview 显示“密钥存在但当前机器无法解密”；
- 日志记录 alias 名称和错误类别，不记录密钥明文；
- 配置编辑器保留 `$secret:alias` 引用，禁止自动覆盖成空字符串；
- 只有用户重新录入后才更新密文。

这属于可观测性和诊断问题，当前没有数据删除证据。

### 3.5 P2：文档开放等级与实现能力存在偏差

当前 `layout-dsl.js` 支持 stack、row、grid、split、tabs、scroll、when、repeat、component、slot、divider、spacer。组件必须预先登记，社区包无法注册新的核心组件。`page-runtime.js` 可以注册页面定义，`sandbox-host.js` 提供受控页面容器。

因此当前可实现能力是：

- token 级换肤；
- 本地静态资源的有限接入；
- 官方组件的页面重排；
- 受控 sandbox 页面；
- Action Registry 提供的业务动作调用。

当前尚未实现的能力包括：

- 主题包任意定义新的原生组件；
- 主题包直接改变 Electron 主窗口、系统菜单和主进程生命周期；
- 主题包任意访问文件系统、密钥库、网络和宿主 IPC；
- 主题包用任意脚本重写已有页面。

V3 文档中的“完全重构”需要改成可验收的分级定义，避免作者按“完全重构”理解成任意代码注入。

---

## 4. 当前协议能力矩阵

| 能力 | 文档设计 | 当前实现 | 结论 |
|---|---|---|---|
| 颜色、字体、间距、圆角、阴影 | 支持 | `tokens.js`、`theme-runtime.js` 支持主要 token | 可用 |
| 本地 SVG/PNG/WebP/WOFF2 | 支持 | 验证器允许，运行时缺少统一资源注册 | 部分可用 |
| 主题包导入 | 支持 | `pack-manager` 有调用点，IPC 缺失 | 当前不可用 |
| 主题包导出 | 支持 | 渲染层有生成逻辑，写文件 IPC 缺失 | 当前不可用 |
| 重启恢复已安装主题 | 支持 | `listInstalled` 调用点存在，主进程接口缺失 | 当前不可用 |
| 页面 DSL 重排 | 支持 | 官方组件、页面节点和动作注册表可用 | 可用 |
| 社区新组件 | 开放等级中有描述 | 没有社区组件注册通道 | 尚未开放 |
| Sandbox 页面 | 支持 | 基础宿主存在 | 可用但需补 source 校验 |
| 受控动效 | motion token 有描述 | 主要为时长和等级变量 | 需要扩展 |
| 图片作为主题表面 | 资源格式允许 | 没有统一 `asset://` 引用与生命周期 | 需要扩展 |
| reduced motion | 规范有要求 | `prefers-reduced-motion` 会降低 motion level | 基础可用 |

---

## 5. 协议是否需要更新

需要更新。当前 V3 文档已经建立了正确的分层方向，新增版本应重点修正三类问题：

1. **实现闭环**：把主题包 IPC、安装记录、恢复、卸载、导出写入流程纳入协议验收，而不是停留在 renderer API 描述。
2. **能力边界**：明确“页面完全重构”指声明式页面重组和受控 sandbox 页面，组件、动作、数据、文件和网络权限仍由宿主登记。
3. **资源与动效契约**：为图片、字体、动画、背景和页面过渡提供稳定 schema、验证器规则和降级策略。

建议保留 `UI_DESIGN_SPEC_V3_THEME_SYSTEM.md` 作为产品设计基线，新增本文件作为审计与实施提案；在下一轮整理时，把落地规则回写到 V3 的第 4、5、8、10、19–23 节。协议版本可定义为 `theme-protocol 3.1`，现有 `schemaVersion: 3` 主题继续读取。

---

## 6. 更易用的主题包形态

### 6.1 目录建议

```text
my-theme.hdsitheme
├─ manifest.json              # 包身份、类型、版本、能力声明
├─ theme.json                 # token、表面、字体、动效引用
├─ assets/
│  ├─ preview.svg
│  ├─ background/
│  │  ├─ studio.webp
│  │  └─ timeline.webp
│  ├─ icons/
│  │  └─ mark.svg
│  └─ fonts/
│     └─ ui.woff2
├─ motion/
│  └─ presets.json            # 受控动效定义
├─ pages/
│  ├─ overview.json
│  ├─ timeline.json
│  └─ mixer.json
└─ README.md
```

### 6.2 为什么增加 `manifest.json`

当前 `theme.json` 同时承担身份、版本、token、预览图和兼容信息，UI 包还要额外表达页面覆盖范围。拆出轻量 `manifest.json` 后，安装器无需解析完整主题即可完成：

- 包类型识别；
- 版本和兼容性判断；
- 能力提示；
- 预览卡片信息；
- 权限审查；
- 安装前冲突检查。

为保持兼容，旧包可以由适配器生成虚拟 manifest。新包要求 manifest 与 theme.json 的 `id`、`version`、`schemaVersion` 对齐。

示例：

```json
{
  "$schema": "https://hdsi.local/theme-manifest.schema.v3.1.json",
  "protocol": "theme-protocol",
  "schemaVersion": 3,
  "id": "community-washi-night",
  "version": "1.2.0",
  "kind": "declarative-ui-pack",
  "displayName": "和纸夜色",
  "author": { "name": "Example Studio" },
  "license": "CC-BY-4.0",
  "entry": "theme.json",
  "capabilities": ["tokens", "assets", "motion", "pages"],
  "permissions": [],
  "compatibility": { "minAppVersion": "0.0.1", "maxAppVersion": "*" },
  "preview": "assets/preview.svg"
}
```

### 6.3 面向作者的三层工作流

1. **主题编辑器工作流**：调整颜色、字体、密度、圆角、背景和动效等级，实时预览并导出。
2. **声明式页面工作流**：用 JSON 页面节点重排官方组件，通过 View Model 和 Action Registry 读取状态、触发动作。
3. **开发者 sandbox 工作流**：在明确启用后编写独立页面，使用宿主公开的只读数据和受控动作。页面不能触碰 Electron API、文件系统和任意网络。

这三层可以共享同一个主题包格式，作者根据能力声明决定使用深度。

---

## 7. 图片资源设计

### 7.1 支持范围

建议支持：

- SVG：图标、线稿、装饰图；
- PNG：透明图、纹理、静态插画；
- WebP：背景和大图；
- WOFF2：本地字体；
- 后续可评估 AVIF，取决于 Electron 版本和解码稳定性。

所有资源必须位于包内，引用使用稳定的包内 URI：

```text
asset://background/studio.webp
asset://icons/mark.svg
asset://fonts/ui.woff2
```

运行时将 `asset://` 解析为已验证的安装目录文件，不允许把任意本地路径和 `file://` 交给渲染层。

### 7.2 `theme.json` 表面定义

```json
{
  "surfaces": {
    "studio": {
      "background": {
        "image": "asset://background/studio.webp",
        "position": "center",
        "size": "cover",
        "overlay": "rgba(15, 17, 22, 0.42)",
        "fallback": "color.canvas"
      },
      "texture": {
        "image": "asset://background/washi-noise.webp",
        "opacity": 0.08,
        "blend": "soft-light"
      }
    }
  }
}
```

### 7.3 安全与性能规则

- SVG 禁止 script、事件属性、外链、foreignObject；
- 图片只能引用包内资源；
- 主题包总大小建议维持 5MB，背景图单项建议不超过 1.5MB；
- 安装时读取像素尺寸，限制超大图片解码风险；
- 首屏背景可以延迟加载，必须有纯色 fallback；
- 资源加载失败不阻塞应用启动；
- 主题卸载时清理 object URL、ImageBitmap 和字体加载句柄；
- 资源缓存按 `packId/version/hash` 隔离，避免不同主题共享错误缓存。

---

## 8. 动效设计

### 8.1 动效分层

动效需要同时满足视觉表达、性能和无障碍要求。建议分为：

| 层级 | 内容 | 典型用途 |
|---|---|---|
| Token | 时长、缓动、动效等级 | 控件 hover、展开、状态变化 |
| Preset | 宿主认可的命名动效 | page-enter、panel-expand、toast-in |
| Page transition | 页面进入、模式切换 | overview ↔ timeline、连接向导步骤 |
| Sandbox motion | sandbox 内局部动画 | 卡片重排、背景偏移、局部装饰 |

### 8.2 推荐 schema

```json
{
  "motion": {
    "level": "expressive",
    "presets": {
      "panel-expand": {
        "type": "transition",
        "duration": "motion.normal",
        "easing": "standard",
        "properties": ["transform", "opacity", "clip-path"]
      },
      "page-enter": {
        "type": "keyframes",
        "name": "hdsi-page-enter-soft",
        "duration": "motion.slow",
        "easing": "decelerate"
      }
    },
    "bindings": {
      "timeline.expand": "panel-expand",
      "page.enter": "page-enter"
    }
  }
}
```

### 8.3 约束

- 只允许预定义 property 白名单；
- 禁止主题包注册任意 CSS `@keyframes` 文本和任意脚本定时器；
- 系统 `prefers-reduced-motion: reduce` 时，页面过渡缩短、取消位移和持续循环；
- 动效等级提供 `off`、`subtle`、`expressive`；
- 持续循环必须显式声明，默认禁止；
- 主题编辑器显示动效对 CPU/GPU 的预算提示；
- 页面切换动效必须支持中断，避免连续点击造成队列堆积；
- 动画失败后保持最终状态，不能让页面停在透明或不可点击状态。

当前 `theme-runtime.js` 已经有 motion level 和 reduced-motion 基础，因此该扩展可以建立在现有 theme 基座上。新增内容主要集中在动效 schema 解析、CSS 生成、验证器和页面 runtime 的绑定。

---

## 9. 页面自定义与完全重构边界

### 9.1 五级能力模型

| 等级 | 能力 | 默认状态 | 说明 |
|---|---|---|---|
| L0 | Token 皮肤 | 开启 | 颜色、字体、密度、圆角、阴影、动效等级 |
| L1 | 本地资源 | 开启 | 图片、字体、纹理、图标 |
| L2 | 声明式动效 | 开启 | 命名 preset、页面过渡、状态变化 |
| L3 | 页面重组 | 开启 | 官方组件、slot、布局 DSL、官方动作 |
| L4 | Sandbox 页面 | 用户启用 | 自定义页面结构和局部交互，受控数据与命令 |
| L5 | 本地开发扩展 | 开发者模式 | 仅面向本机开发，明确提示风险，不作为社区主题分发能力 |

### 9.2 “完全重构”的可验收定义

社区主题可以重新定义页面的：

- 信息架构；
- 区域顺序、栅格、轨道、面板和导航；
- 组件组合和显示条件；
- 字体、颜色、图片、纹理和动效；
- 文字标签、图标和视觉层级；
- 页面之间的进入方式；
- 官方动作在页面中的位置和触发方式。

宿主继续掌握：

- Electron 窗口和生命周期；
- 文件系统与密钥库；
- 故事数据读写；
- 网络连接器；
- 安全确认和危险动作；
- Action Registry、View Model 和可用组件注册表。

L4 sandbox 可以让社区实现全新的页面代码，页面只能使用宿主公开的 RPC。该边界让社区获得高开放度，同时让主题包保持可卸载、可回退、可审计。

### 9.3 当前实现与目标的差距

当前 DSL 已经足以实现 V3 风格的页面重排。要实现更深的自定义，需要继续补齐：

1. 官方组件的稳定 schema 与版本兼容声明；
2. `slot` 的区域级约束和 fallback；
3. 主题包能够查询的 View Model 字段清单；
4. Action Registry 的动作参数 schema、确认策略和错误反馈；
5. sandbox 的来源校验、消息限额和销毁清理；
6. 页面失败时自动回退到内置页面；
7. 主题升级后页面定义的迁移工具。

---

## 10. 验证、安装、预览和回退流程

建议把主题生命周期固定为以下状态：

```text
picked
  → unpacked
  → manifest-validated
  → assets-validated
  → pages-validated
  → previewed
  → installed
  → registered
  → active
```

任何一步失败都回到当前稳定主题，保留诊断信息。安装动作使用临时目录和原子替换：

1. 读取包并限制总大小；
2. 规范化 entry 名称，拒绝绝对路径和 `..`；
3. 解析 manifest；
4. 验证资源、token、动效和页面；
5. 生成预览快照；
6. 写入临时安装目录；
7. 完成索引后原子替换；
8. renderer 注册主题和页面；
9. 试运行关键页面；
10. 失败时卸载临时目录并保持旧主题。

当前主题 runtime 已经具备安全主题回退逻辑，可以继续复用。需要把回退原因、失败文件和诊断代码传给 UI。

---

## 11. 文档更新建议

建议对 `UI_DESIGN_SPEC_V3_THEME_SYSTEM.md` 做一次 3.1 修订，重点调整以下章节：

- 第 4 节：补充 `manifest.json`、资源 URI 和安装记录；
- 第 5 节：把 motion token 和 motion preset 分开；
- 第 8 节：明确资源安全、图片尺寸、字体加载和缓存规则；
- 第 10 节：把页面重组能力与 sandbox 页面能力分开验收；
- 第 13 节：加入资源解码、首屏加载和动画预算；
- 第 19 节：把 L0–L5 能力定义与实际代码绑定；
- 第 20–23 节：补充 IPC、source 校验、销毁清理和页面回退；
- 第 17 节：增加主题包重启恢复、坏包安装中断、卸载当前主题、资源加载失败等验收项。

建议新协议标识：

```text
theme-protocol: 3.1
legacy schemaVersion: 3 继续读取
```

迁移原则：

- 旧主题包无需重新制作即可继续使用；
- 旧 `theme.json` 在加载时生成虚拟 manifest；
- 新字段全部可选，缺失时使用内置安全值；
- 页面验证失败只回退该页面，主题 token 仍可保留；
- 动效和图片加载失败时回退到纯色和静态状态；
- 协议升级不修改故事目录和用户配置。

---

## 12. 推荐实施顺序

### 阶段 A：先修闭环和边界

1. 补齐主题包 preload/main IPC；
2. 增加安装目录、路径、原子写入和卸载校验；
3. 修复 `event.source` 校验；
4. 增加主题包 IPC 集成测试；
5. 将验证器异常输入改成结构化诊断。

### 阶段 B：协议 3.1 基础

1. 引入 manifest 适配器；
2. 增加 `asset://` 解析器和资源清单；
3. 加入图片尺寸、字体、SVG 安全规则；
4. 建立资源缓存和失效机制；
5. 为页面错误增加精确路径诊断。

### 阶段 C：动效扩展

1. 设计 motion preset schema；
2. 将 preset 绑定到页面和组件状态；
3. 接入 reduced-motion；
4. 增加动画中断和最终状态保护；
5. 为持续循环和大面积滤镜增加预算检查。

### 阶段 D：高开放度 UI

1. 稳定官方组件和 View Model schema；
2. 完善 slot 和页面 fallback；
3. 加固 sandbox RPC；
4. 增加主题作者预览工具和示例包；
5. 将 L4 sandbox 作为可选能力发布。

### 阶段 E：开发者模式

L5 只提供给本机开发者。它可以加载未打包的本地扩展，必须显示风险提示、独立开关和错误隔离。L5 产物不进入社区主题市场，也不参与普通主题包的自动安装流程。

---

## 13. 最终建议

1. **继续使用当前 theme 基座**。`theme-runtime`、token 体系、布局 DSL、page runtime、View Model 和 Action Registry 已经形成可扩展的核心。
2. **优先补主题包 IPC 和 sandbox source 校验**。这两项决定社区协议是否真正可用和是否具备完整消息边界。
3. **把协议升级为“manifest + theme + assets + motion + pages”的组合**。作者可以从简单换肤开始，逐步进入图片、动效、页面重排和 sandbox 页面。
4. **图片可以正式纳入主题能力**。采用包内 `asset://`、安全 SVG、大小限制、纯色 fallback 和缓存隔离。
5. **动画可以开放，采用声明式 preset**。主题作者获得可控的页面过渡和状态动效，宿主保留 reduced-motion、性能和可中断性保障。
6. **完全重构可以实现为 L3 + L4 的组合能力**。社区可以重构信息架构和页面表达，宿主继续控制数据、动作、安全和生命周期。
7. **V3 文档需要修订一次**。修订重点放在实现差距、资源契约、动效 schema、IPC 生命周期和 L0–L5 的准确边界。

当前建议的优先级为：

```text
P1 主题包 IPC + sandbox source 校验
P2 验证器诊断 + safeStorage 可观测性
P2 协议 3.1 manifest/asset/motion 设计
P3 主题作者工具、示例包和 L4 sandbox 完整化
```

---

## 附：关键文件索引

- [主题包管理器](C:/dev/HDSI-desktop-typ-0/desktop/src/renderer/theme/pack-manager.js)
- [主题包验证器](C:/dev/HDSI-desktop-typ-0/desktop/src/renderer/theme/pack-validator.js)
- [主题运行时](C:/dev/HDSI-desktop-typ-0/desktop/src/renderer/theme/theme-runtime.js)
- [布局 DSL](C:/dev/HDSI-desktop-typ-0/desktop/src/renderer/semantics/layout-dsl.js)
- [页面运行时](C:/dev/HDSI-desktop-typ-0/desktop/src/renderer/semantics/page-runtime.js)
- [Sandbox 宿主](C:/dev/HDSI-desktop-typ-0/desktop/src/renderer/semantics/sandbox-host.js)
- [preload API](C:/dev/HDSI-desktop-typ-0/desktop/src/preload/preload.ts)
- [main IPC](C:/dev/HDSI-desktop-typ-0/desktop/src/main/main.ts)
- [V3 主题系统规范](C:/dev/HDSI-desktop-typ-0/UI_DESIGN_SPEC_V3_THEME_SYSTEM.md)

---

## 10. 首轮构建落地状态

本节记录审计之后已经写入桌面端的最小可运行实现，前文的问题清单保留为审计时点的历史记录。

### 10.1 已闭环

- 主进程主题包存储：`.hdsitheme` 读取、写入、安装、替换回滚、卸载和启动恢复。
- `themePacks:pickRead/listInstalled/install/write/uninstall` IPC，以及 preload 的 `hdsiDesktop.packs` API。
- sandbox RPC 的 `MessageEvent.source` 校验与 call id 边界校验。
- `manifest.json`、`asset://`、`motion.level`、motion preset、页面覆盖声明的静态校验。
- 旧主题包兼容：缺失 `manifest.json` 时仍按原 `theme.json` 读取。
- 主题资源运行时消费：图片、SVG、字体等包内资源转为 data URL，并通过 `--hdsi-asset-*`、`--hdsi-surface-*` CSS 变量提供给主题样式；动效 preset 的 duration/easing/delay 进入受控变量。
- 损坏的已安装主题在启动恢复时单独跳过，不阻塞其它主题。

### 10.2 资源和动效的当前契约

```text
asset://hero.svg
→ data:image/svg+xml;charset=utf-8,...
→ --hdsi-asset-hero-svg: url("...")
```

主题页面或 `surfaces` 中引用 `asset://...` 时，验证器要求对应文件位于包内 `assets/`。远程 URL、脚本、外链 CSS 和任意 Electron API 仍然被拒绝。

### 10.3 尚未完成的后续工作

- 主题编辑器和导入预览界面；
- 其余页面组件的资源语义消费映射；
- motion preset 的页面级调用点和 Electron 真实窗口 reduced-motion 验收；
- Electron 真实文件选择、重启恢复和导入失败保持当前主题的端到端测试；
- 主题包 hash、版本升级提示和损坏包的可视化诊断。

首轮构建只扩展主题层，不改变故事目录、剧本正文、账号绑定、密钥存储和 Worker 生命周期。


## 14. 协议 3.1 第二轮构建（2026-10-03）

第二轮把图片、字体和动效声明进一步接入宿主运行时：

- `surfaces` 标准 key：`shell`、`topbar`、`browser`、`inspector`、`timeline`、`canvas`、`detail`、`dialog`。桌面端现有对应区域通过 CSS 自定义属性消费背景资源；未声明时维持原有背景。
- `fonts` 支持 `ui`、`mono` 和受限命名键。`src` 必须指向包内 WOFF/WOFF2；weight、style、display 均有静态校验。运行时生成单个受管 `@font-face` 样式节点，并在切换主题时清理节点和字体变量。
- motion preset 支持 `from` / `to` 帧、属性白名单、duration、delay、easing 和有限重复次数；运行时增加 `applyMotion(element, presetName)`，通过 Web Animations API 执行动画，`off` 和系统 reduced motion 直接到达目标状态。
- 协议测试覆盖字体远程引用、缺失资源、非法关键帧、资源清理及动效执行。

第二轮没有开放任意 CSS 或主题脚本。后续仍需把受控 motion API 接入合适的页面交互点，并在 Electron 窗口中检查字体回退、资源可读性和系统 reduced motion。

## 15. 操作性界面协议（Interaction Surface Protocol，协议 3.2）

### 15.1 目标

操作性界面协议用于描述主题对宿主界面动作的视觉响应。主题只声明“某种宿主意图使用哪个动效 preset”，宿主决定意图发生的时机、目标 DOM 节点和业务状态变更顺序。

协议覆盖以下场景：

- 页面进入与离开；
- 面板展开与收起；
- HUD 与 Timeline 视图切换；
- 连接向导步骤切换；
- Mixer 进入；
- 主题预览的成功与失败反馈。

协议只影响视觉层。动效失败、主题没有对应声明或浏览器不支持 Web Animations API 时，宿主继续执行页面、故事、账号和连接状态流程。

### 15.2 主题声明结构

主题包可以在 `theme.json` 中增加 `motion` 与 `interactions`：

```json
{
  "motion": {
    "level": "subtle",
    "presets": {
      "page-enter": {
        "from": { "opacity": 0, "transform": "translateY(6px)" },
        "to": { "opacity": 1, "transform": "translateY(0)" },
        "properties": ["opacity", "transform"],
        "duration": 180,
        "easing": "cubic-bezier(.2,.8,.2,1)"
      },
      "timeline-switch": {
        "from": { "opacity": 0.9, "transform": "scaleY(.98)" },
        "to": { "opacity": 1, "transform": "scaleY(1)" },
        "properties": ["opacity", "transform"],
        "duration": 220,
        "easing": "cubic-bezier(.2,.8,.2,1)"
      }
    }
  },
  "interactions": {
    "page": { "enter": "page-enter" },
    "hudTimeline": { "switch": "timeline-switch" },
    "panel": { "expand": "panel-expand", "collapse": "panel-collapse" },
    "wizard": { "switch": "wizard-switch" },
    "mixer": { "enter": "mixer-enter" },
    "themePreview": { "success": "preview-success", "error": "preview-error" }
  }
}
```

`motionSpec` 是兼容字段。运行时读取顺序为 `motionSpec` → `motion`；新包建议使用 `motion`，迁移工具可以写入 `motionSpec`。

### 15.3 固定意图与触发器

意图名称和触发器均为固定枚举，主题包不能新增宿主意图：

| 意图 | 触发器 | 宿主目标 | 典型调用点 |
|---|---|---|---|
| `page` | `enter` / `exit` | 当前页面 surface | 页面切换、主题切换重挂载 |
| `panel` | `expand` / `collapse` | 对应面板根节点 | Inspector、侧栏、配置区展开收起 |
| `hudTimeline` | `switch` | `#studio-mode-viewport` | Overview/HUD 与 Timeline 切换 |
| `wizard` | `switch` | 当前向导步骤节点 | 向导步骤推进或回退 |
| `mixer` | `enter` | Mixer 工作区根节点 | 进入 Mixer 视图 |
| `themePreview` | `success` / `error` | 主题预览容器 | 导入、预览、验证结果反馈 |

触发器的语义由宿主维护。主题包只提供视觉响应，不能改变触发器的业务含义。

### 15.4 页面与节点级声明

页面 JSON 可以为页面根节点声明动效：

```json
{
  "page": {
    "id": "connect-main",
    "motion": {
      "enter": "page-enter",
      "exit": "page-exit"
    },
    "layout": {
      "type": "row",
      "motion": { "enter": "layout-enter" },
      "children": []
    }
  }
}
```

节点 `motion` 支持两种形式：

- 字符串：仅绑定 `enter`；
- 对象：绑定固定触发器到 preset 名。

渲染器把声明保存为受控元数据 `element.__hdsiMotion`，并写入 `data-hdsi-motion-*` 属性。主题包无法借此注册监听器、查询任意 DOM 或执行脚本。

### 15.5 宿主触发流程

1. 宿主先完成业务状态变更或确定状态变更可以提交。
2. 宿主解析固定意图对应的目标节点。
3. 宿主调用 `HDSIThemeV3.applyInteraction(target, kind, trigger)`。
4. 主题运行时从当前已验证主题的 `interactions` 找到 preset。
5. `applyMotion()` 校验关键帧属性，取消该元素上一个 motion session，并执行新 preset。
6. 动画完成、被取消、超时或发生异常后，宿主继续页面生命周期。

页面运行时另外提供 `HDSIPageRuntime.trigger(element, trigger, kind, preset)`，供页面声明和官方宿主动作复用。页面离开动效最多等待约 900ms，超时后立即卸载；页面进入动效不会阻塞页面可用状态。

### 15.6 动效 preset 的安全边界

允许属性：

```text
opacity
transform
clip-path
filter
background-color
color
border-color
box-shadow
```

属性值只接受字符串或数字。验证器拒绝 `url()`、`javascript:`、`expression()`、分号注入和大括号内容。主题包不能声明任意 CSS 规则、关键帧样式表、选择器、脚本或事件处理器。

`duration`、`delay`、`iterationCount` 和 `easing` 由验证器限制范围。循环动效只适合短时状态反馈，页面常驻区域不应使用无限循环。

### 15.7 中断、reduced motion 与失败隔离

- 同一元素只保留一个活动 motion session。
- 新动效开始时取消旧动效，旧 Promise 不得覆盖新状态。
- `prefers-reduced-motion: reduce` 或用户选择 `off` 时跳过插值，直接写入目标帧。
- Web Animations API 不可用时直接写入目标帧。
- 主题 preset 不存在时返回 `false`，宿主继续执行。
- 动效等待超时只影响视觉过渡，不影响页面挂载、卸载和业务事务。
- 主题包校验失败时不安装，不替换当前主题。

### 15.8 旧主题兼容

旧主题可以继续只声明 token、颜色、字体和 `motion.level`。没有 `interactions` 或页面 `motion` 时，宿主使用原有即时切换路径。`motionSpec`、缺失 preset 和未知交互都按安全回退处理，不要求旧包升级。

### 15.9 推荐作者约定

- 页面进入使用 120–240ms 的 opacity/translate 组合。
- 面板展开优先使用尺寸、透明度或裁剪过渡，避免大面积 blur。
- HUD/Timeline 切换保持同一目标节点的连续视觉关系，preset 只提供补充动效；几何布局由宿主和官方 CSS 负责。
- 向导切换使用方向一致的短过渡，错误状态使用颜色和边界强调，避免持续闪烁。
- 动效命名使用小写短横线，例如 `page-enter`、`wizard-switch`、`mixer-enter`。
- 主题预览必须在静态失败状态下仍然可读，动效只能补充状态表达。

### 15.10 当前实现状态

当前桌面端已经完成：

- Layout DSL 的 motion 声明和递归验证；
- 页面运行时 enter/exit 与 `trigger()`；
- Theme Runtime 的 `applyMotion()`、`cancelMotion()`、`applyInteraction()`；
- 页面、面板、HUD/Timeline、Wizard、Mixer 的宿主触发点；
- `motion` / `motionSpec` 兼容；
- interactions 与页面 preset 在主题包注册时传递；
- reduced-motion、取消、超时和异常隔离；
- 旧主题包回退。

后续可以增加主题预览界面、作者调试面板和真实 Electron 窗口的端到端动效验收。该协议的核心边界已经稳定，新增意图需要先更新枚举、验证器、宿主目标映射和测试矩阵。


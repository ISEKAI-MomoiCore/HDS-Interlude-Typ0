# HDSI Desktop 一体化设计文档

- 日期：2026-09-02
- 输入项目：`HDSI-desktop-typ-0/{hdsi-sourcecode, SnowLuma-main, koishi-master}` + `2026-09-02-reimagine-design.md`（前置架构审读）
- 目标：把 **HDSI 插件（叙事大脑）**、**SnowLuma（QQ 传输层）**、**Koishi（宿主与插件生态）** 合体为一个**带独立图形界面、兼容 Koishi 插件生态、统一管理配置与剧本库**的桌面程序。
- **版本状态**：本文档包含三代方案。**v1（第一~四部分，保留）**：Console 复用优先的直落方案；**v2（第五部分）**：音频宿主（DAW）模型——HDSI 作为走带主体、适配器作为调音台、Koishi 作为机架结构、其它插件作为 VST；**typ-0（第六部分，当前方向；原称 v3）**：多剧场实时运行模型——剧本即工程、真实时间即播放头、剧本文件夹即存档。三代共享 Electron 壳与数据目录决策。

---

## 0. 三个项目分别是什么、各自贡献什么

| 项目 | 本质 | 在合体中的角色 | 可直接复用 |
| --- | --- | --- | --- |
| **koishi-master** | Koishi 框架源码（core/loader/utils + 插件） | **宿主运行时**：headless `Koishi` 应用 + 插件装载器（生态兼容的关键） | loader（插件装载/卸载/重载/market 元数据）、core（App/Schema/Session）、官方插件（server/console 协议、config、market、database） |
| **SnowLuma-main** | NTQQ 注入桥 monorepo（pnpm workspace，11 包）：core(原生探针)→protocol→onebot(v11 标准化)→websocket/sdk/mcp/webui | **QQ 传输层**：账号会话、消息收发、图片/语音获取、`fetch_ptt_text`、表情回应 | `@snowluma/bridge`（BridgeManager 会话管理，带 N 监听者模式）、`@snowluma/onebot`（协议翻译）、`@snowluma/sdk`（TS 客户端）、`@snowluma/ui`（Tailwind4 + shadcn 设计系统）、webui（账号/日志/连接管理页面，React） |
| **hdsi-sourcecode** | HDSI 插件（0.1.5-beta1） | **叙事大脑** + 剧本库数据拥有者 | 叙事/压缩/记忆/时间导演/Token 计量全部逻辑；SQLite 表（剧本/场景/事实/意图/工作暂存/贴纸）；管理指令 |

三个项目天然分层：**SnowLuma 管"连接"、Koishi 管"插件与生态"、HDSI 管"灵魂"**。合体不是重写，是把三者各自的进程边界收进一个桌面壳里。

## 1. 产品形态与进程模型

**产品名（工作名）**：HDSI Desktop。
**壳**：Electron（理由：主进程即 Node 运行时，可直接内嵌 Koishi loader 与 SnowLuma；原生托盘/自启动/自动更新生态成熟；Windows 优先）。Tauri 不选：主进程非 Node，内嵌 koishi + 原生 addon 需要额外 sidecar 进程，复杂度反而更高。

### 1.1 进程模型

```
┌─ Electron 主进程 ─────────────────────────────────────────────┐
│  HostRuntime（headless Koishi 实例）                           │
│   ├─ loader：加载 node_modules 内的 koishi 插件（生态兼容）      │
│   ├─ hds-interlude 插件（叙事大脑，SQLite 剧本库）              │
│   ├─ @koishijs/server + console（WebSocket 服务，供渲染进程）   │
│   └─ snowluma-bridge（内嵌 BridgeManager，QQ NT 客户端注入）     │
│       └─ OneBot 回环通道（127.0.0.1 WS 或进程内事件总线）        │
│  ShellService：生命周期/托盘/自启/更新/数据目录管理              │
├─ Electron 渲染进程 ──────────────────────────────────────────┤
│  GUI（React）：                                                 │
│   ├─ Console 页面层（复用 @koishijs/console 客户端：市场/配置/   │
│   │  日志/插件管理 —— 这是"插件兼容"的界面保证）                 │
│   ├─ HDSI 专属页：剧本库时间线 / 记忆与暂存管理 / Token 仪表盘    │
│   └─ SnowLuma 页：账号注入状态 / 会话管理（复用 @snowluma/ui）   │
└────────────────────────────────────────────────────────────────┘
        ↕ 注入
   QQ NT 客户端（独立进程，由 @snowluma/bridge 挂载）
```

### 1.2 两种运行模式

| 模式 | 说明 | 适用 |
| --- | --- | --- |
| **一体模式（默认）** | SnowLuma BridgeManager 内嵌进 Electron 主进程；OneBot 层以进程内事件总线 + 回环 WS 同时存在；HDSI 的 adapter-onebot 连 `ws://127.0.0.1`（零网络跳、同文件系统——`file://` 表情包/图片跨进程问题自然消失） | 单机自用，安装即用 |
| **分离模式（兼容现状）** | SnowLuma 独立进程（现部署方式，ws 反向连接），Desktop 只做托管（启动/停止/健康检查） | QQ 客户端崩溃隔离、远程部署到服务器 |

## 2. 插件兼容设计（Koishi 生态）

这是合体的硬约束：**任何 koishi 插件必须原样可用**。

1. **完整保留 koishi loader 语义**：`@koishijs/loader` 负责插件装载（含 market 安装、yml 配置、热重载、作用域）。主进程内嵌 headless 实例时使用官方 loader，不重写装载逻辑——兼容性由 Koishi 自己保证。
2. **Console 页面体系原样保留**：渲染进程通过内嵌 `@koishijs/console` 的 WebSocket 连接，官方客户端组件（market/config/logger/dataview/insight）原样可用。第三方插件若自带 console 页面，也自动出现在 GUI 里。
3. **HDSI 不再独占宿主**：hds-interlude 与其它插件（修锁、状态、其它对话插件）平级共存——这是与"专用客户端"方案的本质区别。
4. **风险点**：native addon 插件（如 puppeteer）需要 electron-rebuild 对齐 Electron ABI；策略 = 插件崩溃隔离（loader 已按插件作用域隔离）+ 文档标注 ABI 注意事项。

## 3. 统一配置与剧本库管理（GUI 的核心增量价值）

### 3.1 数据目录（单一权威）

```
userData/
├─ koishi.db          # SQLite：HDSI 全部表 + 其它插件表（唯一权威）
├─ koishi.yml         # 插件配置（Console 与文件双向）
├─ snowluma/          # SnowLuma 账号会话/消息存储（从其独立部署迁入）
└─ backups/           # 自动备份（剧本库快照）
```

### 3.2 HDSI 专属 GUI 页（读取 SQLite，写操作走管理指令通道）

| 页面 | 数据来源 | 功能 |
| --- | --- | --- |
| **剧本库时间线**（主打） | `interlude_script_entry` + scene/arc + timeline ledger 元数据 | 按时间轴可视化剧本流（角色消息/内心旁白/事件分色），场景分段折叠，点击条目看原文与元数据——把"对话生活连续剧本化"变成看得见的东西 |
| 记忆与事实管理 | interlude_fact / working_details / overlay_snapshot / previous scenes | 事实增删改、workingDetail 过期管理、Overlay 分层查看（对应管理指令的图形化） |
| Token 仪表盘 | Token 用量日志（已有结构化输出） | 按天/按模型/按任务的 token 与费用图表，缓存命中率趋势 |
| 侧端识图观察 | web_observation + 侧端识图结果 | 图片与观察文本对照浏览 |
| 配置编辑 | koishi.yml + Schema | 复用 @koishijs/config 的 Schema 表单渲染 |

### 3.3 SnowLuma 页（复用其组件与逻辑）

账号注入状态（QQ 客户端检测 → 引导启动 → bridge 会话建立）、消息存储管理、连接配置——`@snowluma/webui` 已有这些页面的 React 实现，`@snowluma/ui` 提供设计系统；GUI 直接复用组件（或 iframe 嵌入其 webui，M2 之后再原生化）。

## 4. 关键技术决策

| 决策 | 选择 | 理由 |
| --- | --- | --- |
| 壳 | Electron | 主进程=Node，直接内嵌 koishi loader + SnowLuma 原生 addon；避免 sidecar 进程编排 |
| Koishi 版本 | 运行时用 npm 发布版（4.18.x），koishi-master 仅作参考源码 | 不 vendor 框架源码，避免分叉；loader/market/console 由官方版本保证兼容 |
| SnowLuma 接入 | 默认内嵌 BridgeManager；保留独立进程模式 | 同文件系统消灭 file:// 跨界问题；进程隔离作为故障退路 |
| GUI 与 Console 的关系 | 复用 @koishijs/console 客户端体系 + 新增 HDSI 页面 | 插件兼容的界面保证；不重造配置渲染 |
| 数据库 | 继续单文件 SQLite（koishi.db） | 剧本库统一管理的权威载体；备份=复制文件 |
| 设计系统 | @snowluma/ui（Tailwind4）为 GUI 基底 | 现成 tokens/shadcn，三端观感统一 |

## 5. 分阶段路线

| 阶段 | 内容 | 验收 |
| --- | --- | --- |
| **M0 尖刺（1-2 周）** | Electron 主进程内嵌 headless koishi + hds-interlude + 官方 console 页面；QQ 消息经现有外部 SnowLuma 收发 | 与 Koishi Desktop 行为等价 |
| **M1 SnowLuma 内嵌** | BridgeManager + onebot 进程内化；账号注入引导 UI；回环 WS | 不装外部 SnowLuma 也能收发 |
| **M2 HDSI GUI 页** | 剧本库时间线（只读）→ 记忆/事实管理 → Token 仪表盘 | 全部数据来自 koishi.db 实时查询 |
| **M3 统一管理** | 数据目录迁移向导（从现有 Koishi Desktop 实例导入 koishi.db + yml + SnowLuma 存储）；自动备份 | 一键迁移 |
| **M4 打包分发** | electron-builder（win portable + installer + 自启/托盘/更新）；QQ 客户端检测与安装引导 | 双击即用 |

## 6. 风险与边界

| 风险 | 说明 | 缓解 |
| --- | --- | --- |
| SnowLuma 注入的合规与稳定性 | 第三方注入 NTQQ；QQ 客户端升级可能导致 native addon 失效 | 保留分离模式与 adapter-onebot 通用路径；EULA 提示；版本锁定+更新检测 |
| Electron ABI 与原生 addon | @snowluma/core 原生 addon 需按 Electron ABI 重编 | electron-rebuild；SnowLuma 已有 native 构建流水线可复用 |
| Console 组件版本耦合 | @koishijs/console 客户端升级可能破坏嵌入 | 锁定版本 + 只用公开 ws 协议 |
| SQLite 并发 | GUI 直读 koishi.db 与 koishi 运行时写入并发 | GUI 只读走 WAL 快照；写操作一律走 HDSI 管理指令/服务通道 |
| 生态插件质量 | 任意插件崩溃影响宿主 | loader 作用域隔离 + 进程内守护（现有机制） |

## 7. 与既有 Reimagine 设计的关系

`2026-09-02-reimagine-design.md` 第三部分的"@hdsi/core 零依赖拆分"是**长期方向**；本文档的 Electron 合体方案是**近期可落地形态**——它不要求先把 service.ts 拆干净，Koishi 宿主先原样内嵌，GUI 直接读库展示。两者的衔接点：M2 的 GUI 数据访问层（SQLite 只读查询）未来可以直接切到 @hdsi/core 的 Repository 端口，无需重写页面。

---

# 第四点五部分 · M0-1 尖刺实现记录（2026-09-02）

v2 的第一步（M0-1）已落地：`desktop/` 工程骨架 + 宿主子进程无头验证通过。

## 实现清单

```
desktop/
├─ package.json            # electron + esbuild + koishi 栈；hds-interlude 为 file: 符号链接依赖
├─ .npmrc                  # electron 二进制 npmmirror 镜像
├─ scripts/build.mjs       # esbuild：main/preload bundle + renderer 拷贝
├─ scripts/host.mjs        # 无头验证入口（与 Electron spawn 完全同参）
├─ src/main/main.ts        # Electron 主进程：窗口 + IPC + HostProcessManager 接线
├─ src/main/host.ts        # 宿主子进程管理器（fork 官方 worker、日志管道、状态探测）
├─ src/preload/preload.ts  # contextBridge：start/stop/restart/onLog/onStatus
├─ src/renderer/           # M0 状态页：走带栏占位（▶■⟳）+ 状态 pill + 日志面板
└─ instance/koishi.yml     # 尖刺实例配置（端口 5155，sqlite、adapter-onebot 占位）
```

## 无头验证结论（与 Electron 同参 spawn/fork）

- worker 启动 → 心跳 IPC 活跃 → hds-interlude 0.1.5-beta1 加载完成（服务已就绪）→ server 监听 5155 ✓
- 探针期间修复：worker 入口定位（exports 限制 → 物理路径 fork）、daemon 的 IPC 缺失 TypeError（spawn → fork）、logger 插件键误挂 plugins（yml 修正）、泄漏进程占用 5150（已清理，端口改 5155）
- 已知噪音：adapter 对 ws://127.0.0.1:3001 的 401 重试属预期（未填 SnowLuma token / 未启动）

## M0-2 待办（下一步）

1. `npm run dev` 启动 GUI 人工验收（窗口、日志流、启停按钮）
2. adapter-onebot 对接外部 SnowLuma（填 token）验证消息收发 → HDSI 回复
3. renderer 日志面板加着色/过滤；走带栏补自动推进开关占位
4. 决策：宿主进程 executor 从系统 node 迁到 utilityProcess（分发前必须，开发期可缓）

---

# 第五部分 · v2 迭代：音频宿主模型（DAW）

> 迭代原则：v1 的进程模型、数据目录、打包与 Koishi 兼容层**全部保留**（v1 第一~四部分仍然成立）；本部分变更的是**架构隐喻与 GUI 的重心**——从"内嵌 Koishi Console 的桌面壳"演进为"HDSI 即走带主体"的音频宿主（DAW）模型。所有隐喻都必须映射到真实机制，禁止只停留在比喻。

## 5.1 隐喻 → 机制的严格映射

| 音频概念 | 本软件中的实体 | 真实机制 |
| --- | --- | --- |
| **宿主（DAW）** | HDSI Desktop 壳 + 内嵌 headless Koishi | 项目文件（单一剧本库）、插件宿主、路由矩阵、走带控制 |
| **走带（Transport）** | **HDSI 叙事引擎的运行状态机** | 运行/暂停/静默三态；游标（story.cursorAt）= 播放头；`autoAdvance`/回复闸门 = 播放/停止按钮 |
| **调音台 / 通道条** | 每条传输适配器一条通道条 | SnowLuma 通道条、adapter-onebot 通道条、Sandbox 通道条、Console 通道条。每条带：启用开关（fader）、白名单（gain 结构）、读写模式（routing）、实时仪表（收发速率/延迟/Token 消耗） |
| **输入总线** | 所有通道条汇聚的用户事件流 | `{platform, type: private\|group, payload, imageSources, quote, messageId}` 类型化事件，进入 HDSI 的 debounce 合并器 |
| **输出总线（Master）** | HDSI 的投递流 | 主角气泡/系统事件，经分段/打字延迟后路由回来源通道条；Master fader = 全局发送闸门 |
| **VST 插件** | 机架内的其它 Koishi 插件 | 通过 `ctx.hdsi` 服务（Koishi 惯用的可注入服务）与 HDSI 交互；见 5.3 交互协议 |
| **Patch Bay / 连连看** | HDSI 端口与插件能力之间的**路由表**（M1）→ 节点图 UI（M3） | 类型化端口连接：谁能往"上下文总线"注入、谁订阅"事件 tap"。运行时就是一张配置驱动的订阅表 |
| **机架底层设备** | SQLite（剧本库磁盘）、Puppeteer（图像处理设备）、Embedding（频谱分析仪） | 常驻基础服务，拥有独立页面与仪表，但不在信号链的显眼处 |
| **自动化（Automation Lane）** | 时间导演账本 + workingDetails + Preplan | ledger beats 本来就是 [0,1] 相对位置的"自动化点"——与 DAW 自动化曲线同构 |
| **工程（Project）** | 一个剧本（canonical story + 全部配置/记忆） | 新能力：支持多工程（多角色/多故事），共享同一机架与通道条 |

## 5.2 主窗口布局：HDSI 即走带视图

v1 的 GUI 主体是 Console 页面复用；v2 的主视图换成 **HDSI 走带编排视图**：

```
┌─ 顶栏：走带控制 ── ▶运行 ⏸暂停回复 ⏹静默 · 自动推进开关 · 工程选择 · 主电平表 ─┐
│ ┌──────────────────── 走带主视图（剧本时间线编排）────────────────────┐ │
│ │ 轨道1 用户消息    ▂▃▅▂ …（输入事件条）                              │ │
│ │ 轨道2 主角气泡    ▅▂▃▅▅▂ …（投递气泡，<sep/> 分段可见）             │ │
│ │ 轨道3 内心旁白    ▁▃▆▃▁ …（script 散文，折叠视图）                  │ │
│ │ 轨道4 事件节点    ◆场景闭合 ◆验收节点 ◆账本 beat（时间导演自动化点）│ │
│ │ 时间轴：游标（cursorAt）= 播放头；场景 = clip 区块                 │ │
│ └────────────────────────────────────────────────────────────────┘ │
│ ┌── 调音台（右栏，通道条）──┐  ┌── 机架（下抽屉）───────────────────┐ │
│ │ ▸ SnowLuma   [▮▮▮ 2msg/m] │  │ VST：插件节点 + 端口连连看（M3 节点图）│ │
│ │ ▸ OneBot(外)  [▮ 0msg/m]  │  │ 底层：SQLite · Puppeteer · Embedding │ │
│ │ ▸ Sandbox    [▮▮ 1msg/m]  │  │ 压缩器 · 时间导演 · Token 计量        │ │
│ │ （每条：启用/白名单/模式） │  │ （每个带开关与仪表）                  │ │
│ └───────────────────────┘  └──────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────┘
```

走带视图的数据全部来自既有结构：剧本条目（轨道 1-3）、场景与时间账本（轨道 4）、Token 计量（仪表）。**不需要 HDSI 为 GUI 新增任何状态**——这是 v2 可行的关键。

## 5.3 VST 交互协议：Koishi 惯用形式

插件与 HDSI 的交互不发明新机制，完全落在 Koishi 的服务/事件习惯上：

1. **服务注入**：HDSI 声明 `ctx.hdsi` 服务（`Service`），其它插件 `ctx.hdsi` 即可访问。
2. **事件 tap（订阅）**：HDSI 在生命周期广播类型化事件——`hdsi/turn-started`、`hdsi/reply-delivered`、`hdsi/scene-closed`、`hdsi/tokens`。VST 插件 `ctx.on('hdsi/reply-delivered', …)` 即订阅。
3. **上下文注入（VST 的核心价值）**：类型化"上下文提供者"端口——VST 插件注册 `ctx.hdsi.provideContext('weather', async () => '晴，26℃')`，HDSI 在组装 payload 时把已接线的提供者输出注入主叙事上下文。例：天气插件给剧本提供环境、日历插件提供"今天是什么日子"。
4. **Patch Bay**：M1 用路由表（配置：哪个插件接哪个端口、开/关）；M3 用 ComfyUI 式节点图渲染同一份路由配置——**连连看只是同一订阅表的另一种渲染**。
5. **边界**：VST 只能通过端口影响 HDSI（注入上下文/订阅事件/投递建议），不能直接改剧本状态机——保护叙事一致性。

## 5.4 底层服务（机架设备）

SQLite、Puppeteer、Embedding 保持插件形态但归入"机架层"：常驻、有独立仪表与开关、对用户呈现为设备而非功能。SQLite 同时服务 Koishi 宿主与 HDSI（WAL 快照只读给仪表）；Puppeteer 服务视觉降采样/抽帧与网页观察；Embedding 服务语义召回与贴纸过滤。它们不参与连连看路由（与 HDSI 的连接是内置的）。

## 5.5 与 v1 的关系及演进路径

| 维度 | v1（保留） | v2（本迭代） |
| --- | --- | --- |
| GUI 重心 | Console 页面复用 | HDSI 走带主视图 + 机架/调音台 |
| 插件交互 | 无专用协议（靠 Koishi 共存） | ctx.hdsi 端口 + 路由表（M3 节点图） |
| 工程概念 | 单故事 | 多工程（多剧本共享机架） |
| 进程/数据/打包 | 完全一致（v1 第一~四部分） | 同左 |

演进路径不变（M0 尖刺 → M1 SnowLuma 内嵌 → M2 HDSI 页 → M3 打包），v2 改变的是 M2/M3 的页面构成：Console 体系降级为"工具页"（兼容层的入口仍在），主界面让位给走带视图。**风险提示**：DAW 隐喻的陷阱是让界面先于机制——路由表与端口协议先行落地，节点图永远只是路由表的渲染。

## 5.6 决策点

1. 走带视图的时间轴粒度：实时滚动（聊天流）vs 按天缩放（生活编排）——建议两者都要（缩放级别切换）。
2. 多工程（多剧本）是否进入 M2：建议 M2 只做单工程，多工程随机架一起进 M3。
3. VST 上下文注入的预算控制：注入内容挤占主叙事 token 预算的上限策略。

---

# 第六部分 · typ-0：多剧场实时运行模型（详细概念）

> 核心转变一句话：**从"写作推进时间"到"时间流动、写作记录"**。v2 的播放头是"叙事游标"；typ-0 的播放头就是**真实的墙钟**——它永远在走，剧本引擎只负责在时间上"录制"。留白不再是错误，而是角色在镜头外生活的诚实呈现。

## 6.1 概念总览：剧场模型

```
┌─ 顶部时间条（Preplan 参考带）──────────────────────────────────────┐
│  ◀── 已完成/已记录 ──│━━━━━●当前时刻━━━━━│── 未来：预排计划/延迟行动 ──▶ │
│      （过去的剧本块）  │    （now 播放头）  │（预排推进/延迟回复/验收节点） │
└──────────────────────────────────────────────────────────────────┘
┌─ 剧场区（每列 = 一个运行中的剧本）────────────────────────────────┐
│ [水濑 · 小桃]   状态:运行  Token:今日 8.2k / 上轮 1.4k  [🔊mute] │
│ ├ 时间条对齐的剧本块（每块=一次写作/投递/事件）                    │
│ ├ 生效 overlay：角色 ×1 · 关系 ×2                                 │
│ ├ 长期事件：promise"中午验收"(12:20) · workingDetail 取餐码(6h)   │
│ └ 账号绑定：SnowLuma#麦芽 ← onebot:1303322392                     │
│ [麦芽 · 初珀雪]  状态: 🔇muted（时间依旧流动）                    │
│ …（纵向可合并为单行 / 展开为全细节轨道）                          │
└──────────────────────────────────────────────────────────────────┘
```

## 6.2 剧本文件夹规范（存档格式）

每个剧本 = 一个自包含文件夹，"像 Minecraft 存档一样加载"：

```
stories/
└─ minase/                        # 剧本目录名 = 存档 ID（slug）
   ├─ story.json                  # 存档清单（元信息，见下）
   ├─ 说明.md                     # 剧本专属说明：加载时弹出（设定摘要、当前剧情、注意事项）
   ├─ koichi.yml                  # 本剧本独立配置（即独立 koishi.yml；不含 apiKey）
   ├─ data/
   │  └─ hdsi.db                  # 本剧本专属 SQLite（全部 interlude_* 表）
   ├─ timeline/                   # （可选导出）时间轴快照/导出的剧本文本
   └─ assets/                     # 本剧本的贴纸/图片素材
```

**story.json 清单**：

```json
{
  "id": "minase",
  "name": "水濑 · 小桃线",
  "characterName": "水濑",
  "hdsiVersion": "0.1.5-beta1",
  "createdAt": "2026-09-01T00:00:00Z",
  "lastOpenedAt": "2026-09-01T23:30:00Z",
  "description": "高中生水濑与网友小桃的日常（武汉）",
  "accounts": ["snowluma:麦芽"],
  "muteState": "running"
}
```

**密钥分离（关键安全设计）**：剧本文件夹内**绝不保存 apiKey**——`koichi.yml` 中的密钥字段以**引用别名**（如 `$secret:gptgod-key`）表示，实际密钥保存在宿主的本地密钥库（`userData/secrets.json`，后续可迁 OS keychain）。效果：
- 剧本文件夹可以直接**分享/迁移**而不泄露密钥；
- 换机器加载剧本时，宿主提示"该剧本需要别名 gptgod-key 的密钥"，一次录入全局可用；
- 同一密钥可被多个剧本复用。

## 6.3 加载 / 卸载生命周期

```
选择剧本文件夹
  → 校验 story.json（版本兼容性检查）
  → 挂载：以剧本目录为 baseDir 启动独立 koishi worker（fork，同 v2 机制）
      · koichi.yml 即剧本自带配置（数据库路径指向 data/hdsi.db）
      · 密钥别名从宿主密钥库解析注入
  → GUI 弹出「说明.md」+ 弹窗只显示剧本专属说明（说明.md），不注入自动生成的剧情回顾
  → 剧场区出现新的一列；播放头对齐墙钟
卸载 / mute
  → 引擎停写，时间依旧流动（见 6.5 语义）
  → 下次加载：新出现"距上次 N 天"的空档，可选补写或留白
```

## 6.4 实时时间条与缩放

**顶部时间条**（参考带）：三段式。左 = 已记录（剧本块聚合）；中 = **now 播放头**（实时推进，秒级跳动）；右 = 未来（Preplan 日程块 + 到期意图/延迟回复 + workingDetails 过期点）。数据全部来自既有结构（schedulePreplanWindow / upcomingIntents / dueIntents / workingDetails），零新状态。

**缩放：FL Studio 式无损无感连续缩放**——不做离散档位切换，任何缩放级别下所有元素连续可见、可用（块随缩放平滑压缩/展开，文字在块足够大时淡入，过小时收敛为色块 + 悬停标题）。两种操作范式并存：
- **自由拖动**：拖拽平移查看任意历史区间（回看上周、定位某场戏）；
- **锚定缩放**：固定中心 = now，缩放只改变时间密度（从一屏一周到一屏十分钟）。

**展开形式的多轨道**：剧本展开时不只一条线，而是多条子轨道并排——
- 轨道 A「场景」：场景块（clip）+ 场景闭合标记；
- 轨道 B「消息」：用户消息与主角气泡（逐条）；
- 轨道 C「剧本生成」：script 散文（旁白）+ 时间导演账本 beat（自动化点）。
三条轨道共享同一时间轴、各自独立 LOD，配合全局"now 播放头"与顶部 Preplan 参考带对齐。

## 6.5 Mute / Pause 语义（离线模型）

| 状态 | 剧本引擎（写作/推进/主动） | 用户消息 | 时间 |
| --- | --- | --- | --- |
| **运行** | ✓ 全速 | ✓ 正常接收并处理 | 流动 |
| **mute（离线）** | ✓ **剧本依旧续写**（角色生活照常被记录） | ✗ **角色不接收**——消息进入后台收件箱保存 | 流动 |
| **pause（暂停）** | ✗ 停止一切剧本写作与推进 | ✗ 消息同样进入后台收件箱（不丢失） | 流动 |

- **mute = 角色离线**：角色不接收用户消息（发的东西不会出现在她眼里），但她的生活**照常续写**——自动推进继续记录她这一天，workingDetails 照常过期（遗忘仍在发生），Preplan 日程照常推移。解除后，收件箱中的消息合并为一次"上线读消息"事件交给叙事——像下线后回来看消息的人一样处理。
- **pause = 引擎断电**：停止一切剧本写作与推进。用于彻底搁置一个剧本；时间条上的空档诚实呈现。
- 两种状态下收到的用户消息**永远不丢失**（后台收件箱持久化，见 6.5.1）。
- 这个三级模型把"生活在幕间继续"变成了可操作的 UI 状态，而不是隐含行为。

### 6.5.1 背景收件箱（后台消息队列）

- 每个剧本 worker 维护一个持久化收件箱（`data/inbox.json`）：mute/pause 期间收到的用户消息按 `{ occurredAt, senderId, content, quote?, imageSources? }` 顺序追加，**永不丢弃**。
- 解除 mute / pause 时，收件箱一次性合并为单个"离线消息事件"（附原始时间戳与合并标记）交给主叙事——角色像"下线后回来看消息"的人一样处理它们；处理完成后收件箱清空。
- 若收件箱超过上限（建议 50 条），解除时仅取最近 50 条，更早的以计数摘要（"另有 N 条更早消息"）带过。
- 收件箱落盘时机：每条消息到达即追加写入（防崩溃丢失）；worker 崩溃重启后收件箱仍在。

## 6.6 多剧本 · 多账号 · 多线程

**绑定规则：一个 QQ 账号同一时间只能绑定一个运行中的剧本**（一个账号 = 一个人格）。账号池（SnowLuma 会话）与剧本通过绑定表关联：

```
账号池：SnowLuma#麦芽(1303322392) · SnowLuma#another …
绑定：水濑线 ← 麦芽 ； 麦芽线 ← another
```

- 每个剧本 = 一个独立 koishi worker（独立 yml + 独立数据库），天然隔离——一个剧本崩溃不影响其它剧场。
- **合并视图（大栏）**：剧场区横向并排 N 列，共享同一播放头（真实时间）——多线程生活并行可见。
- **展开视图**：每列展开为子轨道（用户消息/主角气泡/旁白/事件）。
- 同一账号切换绑定：需要先 mute 旧剧本或解绑（防一个账号同时扮演两个人格）。

## 6.7 Token 统计（每栏开头）

每列头部显示：`今日 8.2k / 本次运行 41k / 上轮写作 1.4k`。数据来源：Token 用量记录按剧本实例天然隔离（每个剧本独立 worker），宿主聚合后写入 `story.json` 同级的 `usage.json`（按天/按模型聚合）。历史曲线在 Token 仪表盘页展开。

## 6.8 与 v2 机制的映射（复用 / 新增）

| v2 机制 | typ-0 处置 |
| --- | --- |
| 走带控制（运行/暂停/静默） | 升级为三级 mute 语义 |
| 通道条（调音台） | 保留——每个 adapter 一条，绑定到剧本 |
| 时间导演 | 每 worker 独立运行；账本投影到该剧本的时间条 |
| Preplan | 顶部参考带的主数据源 |
| workingDetails | 时间条上的"过期点"可视化 + 遗忘机制照旧 |
| previousScenes / recalledHistory | 剧本加载弹窗与时间线 LOD 的数据源 |
| Token 计量 | 按剧本实例聚合 → 每栏头部统计 |
| 密钥 | 新增：宿主密钥库 + 引用别名（yml 中不落盘） |

**新增组件**：剧本文件夹规范（story.json/说明.md/独立 DB）、多 worker 生命周期管理器、账号绑定表、时间条 LOD 渲染、说明.md 弹窗。

## 6.9 风险与开放问题

1. **多 worker 资源**：N 剧本 = N 个 koishi worker + N 个 SQLite——内存与句柄随 N 线性增长；建议 GUI 显示每 worker 状态并支持按需挂载/卸载（非运行时剧本不占 worker）。
2. **补写策略**：长空档的"补写回忆"回合粒度（一次摘要 vs 分段补写）需要实测调优。
3. **账号绑定冲突**：同一账号被两个剧本声明时，加载第二个必须显式解绑第一个（GUI 强提示）。
4. **说明.md 与连续性**：弹窗内容应包含"上次剧情自动摘要"，否则长间隔后的加载体验断裂。
5. **密钥库安全**：明文 JSON 是 M2 权宜；正式版接 OS keychain（Windows Credential Manager）。

## 6.10 与 v2 的关系

v2 的全部机制（通道条、端口协议、时间导演、Token 计量、机架）**原样保留**，typ-0 是在 v2 之上叠加"多剧场编排 + 存档化 + 实时播放头"三个产品级概念。v2 的走带视图是 typ-0 展开视图中**单剧本列**的样子。

## 6.11 当前 typ-0 骨架实现（2026-09-02）

`desktop/` 已完成第一条 typ-0 可运行链路：

- `src/main/stories.ts`：剧本文件夹创建、`story.json`/`说明.md`/独立 `koishi.yml`/收件箱管理，以及每剧本一个 Koishi worker 的加载、卸载和三态持久化。
- `src/main/main.ts`：剧本列表、创建、加载、卸载、状态切换、说明读取与 worker 日志的安全 IPC。
- `src/preload/preload.ts`：仅暴露剧本管理和订阅 API；渲染进程不取得 Node 或 Electron 原始能力。
- `src/renderer/`：多剧场卡片、实时墙钟参考带、运行事件栏、创建剧本弹窗与运行 / mute / pause / 卸载控件。

本阶段的轨道是视觉占位，尚未直接查询每个剧本 SQLite 的真实条目；mute/pause IPC 已由壳发往 worker，HDSI worker 侧的后台收件箱消费与真实运行语义属于下一步。账号绑定、密钥别名解析、真实时间条 LOD、Token 汇总和 SnowLuma 内嵌也仍按 6.6–6.8 的路线后续接入。

---

# 第七部分 · M5 完成与 M6 初步落地记录（2026-09-04）

## M5：Logs Surface 完成版

- LogBroker：超限原子轮转（rename，查询合并 `.partN` 分片）、按日保留清理、存储统计、导出新文件（拒绝覆盖、导出边界应用 Blind 规则）。Blind 规则只作用于查询/导出，落盘原文保留。
- Renderer：窗口化日志渲染、`before` 游标历史分页、等级/来源/文本/correlation 过滤、Follow/Pause + 积压补齐、行展开正文。深链接跳转按钮与 Worker Thread 全文搜索保留到后续。

## M6 初步：Koishi Compatibility Surface（隔离嵌入闭环）

- 每故事 loopback Console：编译期注入 `server`（127.0.0.1，port 0）与 `plugin-console` 到 resolved yml；worker 探测 `ctx.server.port` 经 `console-port` 事件回传；`ConsoleRegistry` 登记/失效/换 revision。
- 隔离嵌入：每故事独立 BrowserView + Session Partition；sandbox、无 preload、导航白名单（仅本故事 endpoint 前缀）、新窗口/webview/权限全拒；worker 退出销毁视图并清 session 存储。
- Renderer Koishi Surface：endpoint 状态、Attach/Detach、resize 同步。
- HDSI 依赖升级至 `0.1.5-beta8-m6`（desktop-bridge 新增端口上报）。
- M6 完整版留待：Console 配置修改的 ConfigMediator 捕获/差异确认、插件健康同步 Overview/Routing、Blind 对 Console 内容的强制规则。

验证：`npm run typecheck` 0 错误；`npm run test:runtime` 19/19（新增 ConsoleRegistry、编译注入用例）；`npm run build` 通过。

---

# 第八部分 · V2 (1.0.0-beta4-m8) 桌面基座同步记录（2026-09-05）

HDSI 插件自 0.1.5-beta8-m6 起经历 V2 原位重构（ScriptCommit/投递账本/场景检查点/EpisodeIndex，见 `plugins/hds-interlude/docs/V2_IN_PLACE_REFACTOR_IMPLEMENTATION_FORM.md`），当前版本 `1.0.0-beta4-m8`。本轮把桌面基座同步到 V2 语义，全部改动在唯一主链上原位完成。

## A. HDSI bridge 侧（protocol 3 → 4）

1. **typ-0 后台投递通道（关键修复）**：V2 中 delayed-reply/split-message/advance 的投递走 `findBotForParticipant`（adapter bot），而 typ-0 worker 没有 adapter —— 此前所有后台消息都会以 `bot-not-found` 失败。新增 `service.setDesktopDeliveryHandler()`：bridge 安装时注册宿主投递出口，后台消息经 `delivery` 事件交给 typ-0 Outbox/渠道适配器，`delivery-result` 回执与实时路径共用同一 Promise。成功照常进入 `confirmOutgoingDeliveries` → M6.1 投递账本；失败照常进入 `recordOutgoingDeliveryFailure`。普通 Koishi（无 bridge 环境）不安装该桥，行为零变化。
2. **timeline-range 投影升级 protocol 4**（向下兼容 v2/v3）：`desktopTimelineEntryView` 新增三类确定性投影字段，全部来自 entry.metadata，零新增查询：
   - `commitId`：剧本行动身份，供日志/Outbox 深链关联；
   - `deliveryActions[]`：M6.1 投递账本摘要（eventId/eventKind/status/segments），只读执行事实；
   - `sceneCheckpoint`：M7.1 场景检查点（sceneId/起止/reason/边界来源条目）。
   损坏或缺失字段一律安全省略，不抛错；旧条目（无 metadata）保持 point 事件渲染。
3. bridge-ready 上报 `protocol: 4`；桌面端 `>= 3` 门控自动通过，旧桌面拿到 4 忽略新字段。

## B. 桌面侧（typ-0）

1. `story-repository.ts`：`normalizeEntry` 白名单透传 `commitId/deliveryActions/sceneCheckpoint`，未知字段照旧丢弃；新增对应类型。
2. Renderer Arrangement：Script 轨块新增「投递现实」角标（仅非全部成功时显示：N 未送达 / N 待确认）与「边界」角标（sceneCheckpoint 存在时）；Inspector 对 entry/script 显示 commit 身份、逐 segment 投递结果与「查相关日志」深链接按钮。
3. 日志深链接：点击后切到 Logs Surface，自动把条目 entityId 填入关键词过滤——补上 M5 时代欠下的日志 → Studio 反向闭环。
4. **修复 worker 模板缺依赖 bug**：`buildStoryYml` 缺少 `http` 插件，而 HDSI `inject = ['database', 'http']` —— 没有 http 服务时 worker 在插件加载阶段永久挂起（等依赖），bridge-ready 永不出现。模板补 `group:basic: http:m0`。此 bug 影响 beta8-m6 以来所有新建剧本（旧剧本如手工加过 http 不受影响）。

## C. 依赖与验证

- `desktop/package.json`：`koishi-plugin-hds-interlude` → `1.0.0-beta4-m8`（file: tgz 精确安装）。
- 验证：HDSI `typecheck` 0 错误、206/206 测试（新增 protocol 4 投影回归：commit/账本/检查点透传、损坏字段安全省略、legacy 无字段）；桌面 `typecheck` 通过、runtime 测试 20/20（新增 normalizeEntry 白名单回归）；`build` 通过。
- **新增端到端 bridge 测试 `scripts/test-bridge-e2e.mjs`**：fork 真实 Koishi worker（与桌面加载完全同参），验证 bridge-ready protocol 4、timeline-range 投影结构、phase 切换闭环、snapshot 兼容路径，9/9 通过。它就是发现 http 缺失 bug 的工具，后续每轮改动都应跑一遍。

## D. 投影增强只读性审查（同日补充）

按「只在 typ-0 侧修改、不影响 HDSI 任何功能」的要求，对 protocol 4 投影改动做了系统性只读审查（详见 HDSI 实施表 1.6.1 节）：

- 本轮在 HDSI service.ts 新增的字段引用仅 3 处，全部在投影函数体内；无写操作（无 dbSet/appendEntry/账本函数调用）；`protocol: 4` 无内部消费者；
- 敌对 metadata fuzz 测试（207/207）覆盖 null/数字/NaN/半损坏 checkpoint/超长数组等形态，投影始终返回合法结构；
- e2e 字段白名单验证（现 11 项）：真实 worker 的 range 响应根对象与 entry 只含已知字段，IPC 边界无未知字段泄漏。

typ-0 侧本轮改动（normalizeEntry 白名单透传、Arrangement 角标、Inspector 投递明细、日志深链接）全部为只读渲染，无任何回写路径。

---

# 第九部分 · 剧本分支（Branches）与可视化调音台设计（2026-09-05，设计稿）

> 状态：设计定稿，未实施。目标：分支剧本（选点重启 / 选区删除 / 单分支运行）、推子旋钮式可视化配置。
> 核心洞察：**typ-0 的"一个剧本 = 一个文件夹 + 一个独立 SQLite"已经是分支模型的天然载体**——分支不需要在 HDSI 数据库内部建树，只需要在宿主层管理文件夹级的派生关系。

## 9.1 分支模型：文件夹即分支

### 数据结构（story.json 扩展，schemaVersion 2）

```jsonc
{
  "schemaVersion": 2,
  "id": "minase-branch-b2",          // 分支是完整剧本（独立存档），不是父剧本的子表
  "name": "水濑线 · 分支B（没赶上补习）",
  "parent": {                        // ← 新增：分支谱系
    "storyId": "minase",             // 派生源（可以是另一个分支，形成树）
    "forkedAt": "2026-09-05T06:00:00.000Z",
    "forkPoint": { "entryId": 142, "occurredAt": "…" }  // 选点重启的精确位置
  },
  "branchState": "running | muted | paused",
  "…其余字段同 schemaVersion 1"
}
```

- **分支 = 完整剧本文件夹**（自带 data/hdsi.db、koichi.yml、说明.md），通过 `parent` 字段形成树。不做数据库内分支表，原因见 9.2。
- 目录命名建议：`stories/<rootId>.b<序号>-<slug>/`（如 `minase.b2-late-school`），根剧本无 `.b` 后缀。谱系由 `parent.storyId` 声明而非目录名解析（目录名只是可读性辅助）。
- **删除父分支**时子分支不级联删除（各自是独立存档），只在 Browser 上标注"来源已删除"。

### 分支树的 UI（Browser 层）

- 故事列表支持树形缩进：根剧本 → 分支 → 分支的分支；每项显示 forkPoint 时间戳（"自 09-05 08:47 分出"）。
- 剧本详情页新增"谱系"区块：可视化时间线上标出 forkPoint，点击任意历史位置即可"从此处创建分支"（见 9.3）。

## 9.2 为什么"每个分支单独复制一个数据库"是对的

你的直觉正确，而且 typ-0 的架构让这几乎是免费的：

1. **HDSI 的数据模型是单剧作家单库**：`getCanonicalStory()` 把多个 active story 归一为一个（其余自动 archive），37 张 `interlude_*` 表全部以 `storyId` 为行级隔离但共享同一连接。在同一 SQLite 内塞两个分支 → 必须改造 canonical 归一逻辑、时间导演游标、压缩链、`purgeAllData` 等十余处，且违背"storyId 是全局唯一叙事权威"的既有约束。
2. **文件夹复制 = 数据库复制 = 天然隔离**：现有 `copyPortable` 已经复制整个剧本目录（含 `data/hdsi.db`，排除 `.typ-0-runtime`/`.typ-0-backups`）。fork 后每个分支拥有独立的完整数据库副本，HDSI **零改动**。
3. **冲突检查天然成立**：同一账号只能绑定一个运行中剧本（BindingRegistry），分支与父剧本互斥绑定由既有约束保证。
4. **成本**：SQLite 文件通常在 MB 级（几十条剧本 + 记忆 + 事实），复制几乎瞬时；磁盘开销可忽略。

**唯一需要新增的宿主能力**：fork 时的"WAL 截断"——复制前若 worker 正在运行，必须先 unload（或 checkpoint WAL），否则复制出的 db 可能缺最新事务。实施上强制"fork 前先卸载 worker"（与删除剧本一致的既有安全顺序）。

## 9.3 三个核心操作的设计

### A. 选点重启（从时间线任意位置创建分支）

```
Arrangement 时间线选中某个历史条目（或 Script 块的任意点）
  → 「从此处创建分支」按钮（Inspector 内）
  → 弹窗：分支名（必填）、说明（默认"自 <时间> 分出，之前剧情完全继承"）
  → 宿主流程：
     1. 若源 worker 在运行 → 受控 unload（提示用户）
     2. copyPortable(sourceDir, storiesRoot/<rootId>.b<next>-<slug>)
     3. 改写新 story.json：新 id、name、parent{storyId, forkedAt, forkPoint}
     4. **分叉点之后的数据处理**（见下方决策）
     5. 新分支 phase=paused、accounts=[]（不抢绑定）
     6. Browser 树刷新，用户手动 Load 新分支
```

**分叉点之后的数据——两个选项（建议 B）**：
- A. 物理截断：在新分支库里把 `occurredAt > forkPoint` 的剧本/记忆/事实按 purgeStoryRange 语义软删。优点：干净；缺点：丢弃了"分支之后角色经历过的其它生活线"，且 purge 语义重。
- **B（推荐）. 保留但标记**：数据完整保留，仅在新分支的 story.json 记录 forkPoint；HDSI 侧加一个**极小的只读特性**——启动时若 manifest 带 `parent.forkPoint`，将 `occurredAt > forkPoint` 的条目在投影层标记为"前世记忆"（不进 recentScript，不进压缩，只可通过显式召回到达）。这保住了"另一条时间线发生过什么"的叙事价值（角色本人"不记得"，但宿主可以在需要时做"既视感/梦境"这类手法）。实施落点：`context-compiler` 加一个 manifest 注入的边界过滤，约 30 行 + 测试。
- 注意：选 B 时分支的时间语义——新分支的"现在"从 forkPoint 起算，cursorAt 回拨到 forkPoint（这需要 HDSI 允许启动时用 manifest 声明初始游标；同样约 20 行，带开关，默认只在检测到 `parent.forkPoint` 时生效）。

### B. 选区删除（原 purge 指令的 GUI 化）

桌面端已有 `stories:delete`（整本进废纸篓）。新增**选区删除**：
```
Arrangement 上 Shift+拖选（或双点选起止）一个时间区间
  → 「删除此区间」 → 弹窗显示将被清除的内容统计（剧本 N 条 / 记忆 N 条 / 事实 N 条 / 意图 N 条…）
  → 二次确认（输入剧本 ID 或完整句子确认，比 y/n 更重）
  → IPC: stories:purgeRange(storyId, from, to)
     宿主经 bridge 调用 HDSI 的 purgeStoryRange —— 它已经存在且语义完备
     （剧本条目→redacted、记忆→deleted、事实→superseded、意图→cancelled、场景/弧→closed，且处理 sourceEntryIds 联动）
  → 刷新时间线投影（revision 变化自动触发重取）
```
- **关键点：不在桌面端复制 purge 逻辑**。`purgeStoryRange` 是 HDSI 已有的成熟实现（含 sourceEntryIds 级联、Canon 保护），桌面端只做 bridge 命令转发——新增 bridge 命令 `purge-range`（协议 4 → 5，或作为 protocol 4 的扩展命令，向下兼容旧桌面）。
- purge 后 `cursorAt` 不回拨（删掉的区间就是"没发生过"，时间线出现空洞是诚实的）。
- 安全：仅限 paused 状态执行（自动暂停 → purge → 用户手动恢复），避免 purge 与进行中写作竞争。

### C. 单分支运行门控

- **规则：一棵分支树内同时只有一个分支可处于 running/muted**（其它分支必须 paused）。实现位置：`StoryManager.load()` 增加树内互斥检查——解析各 manifest 的 `parent` 链找根 ID，同根的活跃 worker ≥1 时拒绝加载（错误信息列出已加载的兄弟分支）。
- 与全局 3 worker 上限正交：不同树的分支可并行（比如两条不同角色的故事线各自跑一个分支）。
- 切换分支 = 卸载当前 → 加载目标（GUI 提供"切换到此分支"一键操作）。

## 9.4 推子 / 旋钮：可视化配置调音台

对应 typ-0 Configure 视图的升级——把 koishi.yml 中高频、可枚举、有安全范围的参数做成物理调音台隐喻的控件，写回仍走既有 `StoryConfigMediator`（`$secret:` 别名、备份、回滚全部继承）：

| 控件 | 映射参数 | 范围/步进 |
| --- | --- | --- |
| **推子（fader）** | `model.providers[].temperature` | 0–2，步进 0.05 |
| 推子 | `model.mainTopP` | 0–1，步进 0.01 |
| **旋钮（knob）** | `runtime.contextTimeWindowMinutes` | 15–240 min |
| 旋钮 | `chatActions.expressionThreshold` | 0–1，步进 0.05 |
| 旋钮 | 时间导演退避倍率（如暴露） | 1×–4× |
| **开关排（switch row）** | vision/贴纸语义过滤/ChatRhythm/时间导演等布尔开关 | — |
| **LED 电平表** | token 用量/缓存命中率（只读仪表，复用 UsageAggregator） | — |

设计约束：
1. **白名单驱动，不是 schema 全量渲染**：只收录经审阅的参数（首批约 8–12 个），每个带中文标签、风险提示（"高温度可能导致合约失稳"）和安全范围。yaml 仍是唯一权威——推子只是 yml 的"另一个视图"，直接编辑 yml 后推子同步（单向：打开配置窗口时从 yml 解析当前值）。
2. **每次写回都走 Mediator 的完整流程**（别名校验 → 备份 → 原子写 → 运行中受控重载），可视化不绕过任何安全机制。
3. **物理隐喻 UI**：竖直推子（拖拽 + 滚轮微调 + 双击复位默认）、圆形旋钮（指针角度映射值域）、LED 式电平表（绿/黄/红区）。纯 CSS/SVG 实现，无新依赖；深灰平面风格与 Studio 一致。
4. 分支联动：推子面板顶部显示当前配置的是哪个分支（防止改错线），切换分支后自动重读。

## 9.5 实施顺序建议

| 批次 | 内容 | 依赖 |
| --- | --- | --- |
| 1 | story.json schemaVersion 2 + `parent` 谱系 + Browser 树形展示 + fork（复用 copyPortable + unload 前置） | 无，纯宿主层 |
| 2 | 单分支运行门控（StoryManager 树内互斥）+ 分支切换 UI | 批次 1 |
| 3 | 选区删除：bridge `purge-range` 命令 + Arrangement 选区交互 + 统计确认弹窗 | bridge protocol 4 已就绪 |
| 4 | 选点重启的 HDSI 侧小特性：forkPoint 边界过滤 + 游标回拨（manifest 驱动，带开关） | 需 HDSI 小改（约 50 行）+ 24h 观察 |
| 5 | 推子/旋钮调音台（Configure 视图重构） | 独立，可并行 |

每批次独立可测可回退；批次 1–3 完全不触碰 HDSI 插件代码，批次 4 是唯一需要 HDSI 配合的（且是带开关的可选行为）。

## 9.6 冲突审查矩阵与详细实施方案（2026-09-05，实施前定稿）

实施前对分支模型与全部既有功能做了逐一交互审查。结论：**批次 1–3 只改 typ-0；批次 4（HDSI 侧）与批次 3 的 bridge 命令是仅有的 HDSI 触点**。

### 9.6.1 冲突矩阵（10 项审查，3 项需处理，7 项天然兼容）

| # | 交互点 | 结论 | 处理 |
| --- | --- | --- | --- |
| 1 | `readStoryMeta` 硬编码 `schemaVersion: 1` | **需处理** | 升级为接受 `1|2`；读取 v2 时保留 `parent` 字段，写回不降级 |
| 2 | `import()`（复制/导入共用）写死 `schemaVersion: 1`、清空 accounts、phase=paused | **需处理** | fork 分支走新函数（见 9.6.3-B），不改动现有 import 语义 |
| 3 | 导出/导入后 `parent.storyId` 指向的源树可能不存在 | **需处理** | 引入 orphan 规则：读取时若 `parent.storyId` 在故事列表中不存在 → Browser 显示「来源缺失」，功能不受限 |
| 4 | 删除父分支（废纸篓）对子分支的影响 | 天然兼容 | 不级联删除（各分支是独立存档）；子分支按 #3 显示 orphan |
| 5 | BindingRegistry 账号互斥 | 天然兼容 | 互斥按 storyId 判断，分支各有独立 ID |
| 6 | 3 Worker 上限 vs 树内单分支互斥 | 天然兼容 | 两个检查正交：上限在 load() 开头，树内互斥在其后追加 |
| 7 | bridge 命令集（timeline-range 等） | **需扩展** | 新增 `purge-range` 命令（见 9.6.3-C）；v4 协议不加数字——新增命令对旧桌面不可见，无需 bump |
| 8 | HDSI Console/story.json 边界 | 天然兼容 | story.json 是 typ-0 manifest，与 HDSI Console 配置零交集 |
| 9 | 时间线投影（protocol 4）与游标回拨 | 天然兼容（批次 4 才动） | 批次 1–3 不改游标语义；forkPoint 投影字段已预留 |
| 10 | WorkspaceState/布局按 storyId 隔离 | 天然兼容 | 分支各有独立布局 |

### 9.6.2 数据结构定稿

```jsonc
// story.json schemaVersion 2（新增字段全部可选，v1 文件原样可读）
{
  "schemaVersion": 2,
  "id": "minase.b2-late-school",
  "name": "水濑线 · 分支B",
  "parent": {                          // 仅分支携带；根剧本无此字段
    "storyId": "minase",
    "forkedAt": "2026-09-05T06:00:00Z",
    "forkPoint": { "entryId": 142, "occurredAt": "2026-09-05T00:47:00Z" }
  },
  "…其余同 schemaVersion 1"
}
```

- 分支 ID 命名约定 `<rootId>.b<序号>-<slug>`；**谱系权威来自 `parent` 字段**，目录名只是可读性辅助（`rootId` 前缀便于人眼归组）。
- `schemaVersion` 语义保持"manifest 结构版本"：v2 = v1 + 可选 `parent`。v1 文件永不自动改写为 v2（只在 fork/编辑时自然产出 v2）。

### 9.6.3 实施细节定稿

**A. 谱系服务（批次 1，`src/main/runtime/branch-registry.ts` 新增）**

```ts
interface BranchTree { rootId: string, nodes: Array<{ storyId: string, parent?: { storyId: string, forkedAt: string, forkPoint?: { entryId?: number, occurredAt?: string } }, orphan: boolean }> }
function buildBranchTree(handles: StoryHandle[]): BranchTree[]   // 纯函数，从 manifest 集合构建树
function isBranchActiveInTree(handles: StoryHandle[], rootId: string, excludeStoryId?: string): string[]  // 树内活跃 worker 列表
```

纯函数、无 IO，直接进 runtime 测试。Browser 树形渲染由 Renderer 消费。

**B. fork 分支（批次 1，`StoryArchiveService` 新增 `forkBranch()`，不改 `import()`）**

流程：`源 worker 运行中 → 抛错要求先卸载` → `copyPortable(src, storiesRoot/<rootId>.b<next>-<slug>)` → 改写 manifest（新 id/name、schemaVersion 2、parent{storyId, forkedAt, forkPoint}、accounts:[]、phase:'paused'、保留数据目录完整复制）→ 返回新 handle。与 `import()` 的差异：保留 schemaVersion 2 与 parent、不改写创建时间为"现在"的 lastOpenedAt 语义、要求 forkPoint 必填。

**C. 选区删除（批次 3，bridge `purge-range` 命令 + 桌面 IPC）**

- HDSI `desktop-bridge.ts` 新增命令 `{ command: 'purge-range', value: { requestId, from, to } }`：校验 ISO 时间与顺序 → `service.serial(storyId, () => service.purgeStoryRange(storyId, from, to))`（**包 serial 是 bridge 特有的**——QQ 指令路径有人工确认间隔，bridge 路径必须与写作回合互斥）→ 返回 `{ requestId, purged: true }`。失败返回 accepted:false + error。
- 桌面 `stories.ts` 新增 `requestPurgeRange()`（bridgeProtocol >= 4 才可用）；`main.ts` 新增 IPC `stories:purgeRange`，**门控：phase 必须为 paused**（自动暂停 → purge → 用户手动恢复），并弹原生确认对话框（显示统计）。
- Renderer：Arrangement 支持 Shift+拖选时间区间 → 确认弹窗列出影响范围 → 调用后刷新投影。
- **语义**：purge 后 cursorAt 不回拨（删掉的区间=没发生过，时间线空洞是诚实的）；Canon/参与者身份不动（与 `purgeStoryRange` 现有语义一致）。

**D. 单分支门控（批次 2，`StoryManager.load()`）**

在现有 maxWorkers 检查之后追加：解析目标剧本的 `parent` 链求根 ID → 若同根任一其它剧本 worker 处于运行中 → 拒绝加载并返回兄弟分支列表。Renderer 在分支卡片上提供「切换到此分支」（卸载当前 → 加载目标）。

**E. 推子/旋钮调音台（批次 5，独立）**

见 9.4 节设计；白名单参数、Mediator 写回、纯 CSS/SVG。此处不再重复。

### 9.6.4 明确不做（本轮）

- **不做** HDSI 数据库内分支表、不做跨分支时间线合并视图；
- **不做** forkPoint 游标回拨与"前世记忆"边界过滤（批次 4，HDSI 侧，待批次 1–3 实机稳定后单独评估——其中游标回拨需要 HDSI 支持 manifest 声明初始游标，影响面需要独立审查）；
- **不做** 分支自动合并（merge）；
- **不做** 推子面板之外的 schema 全量配置渲染。

### 9.6.5 测试计划

- runtime 单测：buildBranchTree 纯函数（多级分支/orphan/环引用防御）、forkBranch manifest 改写、树内互斥判定；
- 桌面 runtime 测试：readStoryMeta v1/v2 双读、purge IPC paused 门控；
- e2e：bridge purge-range 在真实 worker 上的调用与失败路径；
- 手工验收：fork → 切换 → 选区删除全流程 + 废纸篓/orphan 场景。

## 9.7 实施落地记录（2026-09-05，批次 1–3 完成）

### 批次 1：谱系与分支创建

- `story.json` schemaVersion 2：`readStoryMeta` 按 `parent` 字段存在性派生版本号（v2 = v1 + 可选 `parent`），v1 文件原样可读、永不自动降级/升级；`parseParentRef` 防御式解析（环/缺字段/坏类型安全省略）。
- 新增 `src/main/runtime/branch-registry.ts`：`buildBranchTree`（纯函数树构建，环引用防御、orphan 标注、深度计算）、`activeSiblingsInTree`（树内互斥判定）、`nextBranchId`（`<rootId>.b<序号>-<slug>` 分配）、`rootIdOf`。
- `StoryArchiveService.forkBranch()`：完整复制剧本目录（含独立数据库副本），写 schemaVersion 2 manifest（parent/forkPoint 必填、accounts 清空、phase=paused）；源目录零修改。forkPoint 缺失直接拒绝。
- 剧本 ID 白名单放宽：允许 `.`（分支 ID 分隔符 `<rootId>.b<N>-<slug>`），与 LogBroker 的目录白名单一致。
- Browser 故事列表树形化：按谱系深度缩进排序，分支带标签（orphan 显示"来源缺失"但不限制功能）。

### 批次 2：单分支运行门控

- `StoryManager.load()` 在全局 3-worker 上限之后追加树内互斥：同一根的任一其它剧本运行中即拒绝加载，错误信息列出占用者；不同树的分支可并行。
- Renderer Inspector 新增「从此处创建分支」（选中任意历史条目 → forkPoint 自动定位 entryId/occurredAt；源剧本运行中时先提示卸载）。

### 批次 3：选区删除（purge GUI 化）

- HDSI `desktop-bridge` 新增 `purge-range` 命令（协议仍为 4，旧桌面不可见不受影响）：复用成熟的 `purgeStoryRange` 软删语义（剧本→redacted、记忆→deleted、事实→superseded、含 sourceEntryIds 级联、Canon 保留），经新增 `service.desktopPurgeRange()` 在 **serial 队列内执行**——QQ 指令路径有人工确认间隔，bridge 路径必须与写作回合互斥。
- 桌面 `stories.ts`：`requestPurgeRange`（仅 bridgeProtocol ≥ 4 可用）；`main.ts` IPC `stories:purgeRange`：**paused 门控** + 原生确认对话框（不可撤销警示）+ 操作日志。
- Renderer：Arrangement Shift+拖选时间区间 → 红色覆盖层预览 → 确认后调用；purge 后时间线空洞是诚实呈现（cursorAt 不回拨）。

### 验证

- HDSI：typecheck 0 错误、207/207 测试（protocol 4 投影回归 + 敌对 metadata fuzz）。
- 桌面：typecheck 通过、**22/22** runtime 测试（新增：分支树构建/orphan/环引用防御/树内互斥/分支 ID 分配、forkBranch manifest 改写与 v1/v2 双读兼容、源目录不可变）。
- 端到端 **13/13**（真实 worker）：含 purge-range 空库防御性拒绝（错误信息明确）与无效时间拒绝。
- 明确不做（见 9.6.4）：数据库内分支表、forkPoint 游标回拨（批次 4，HDSI 侧带开关特性，另行评估）、跨分支合并、schema 全量渲染。

---

# 第十部分 · M7 真实渠道最小闭环（OneBot 桥接，2026-09-05 设计定稿）

> 施工单指定的下一施工项。范围铁律：**只做私聊纯文本**（群聊/引用/图片/语音/表情全部显式拒绝并记日志，不静默吞）。验收标准：真实入站 → 统一事件 → binding → 三态 → HDSI → Outbox → 真实渠道回执全链路可追踪；掉线、暂态失败、永久失败不丢消息也不伪造已送达。

## 10.1 架构决策：桌面主进程做 OneBot 11 WS 服务端

worker 的 `adapter-onebot`（`protocol: ws`）是 **WS 客户端**——它主动连 `endpoint`。方案：桌面主进程在 `127.0.0.1` 起一个 OneBot 11 反向 WS 服务端（ws 库已在依赖树），worker 配置 `endpoint: ws://127.0.0.1:<port>/onebot` 反向连入。

选定此方案的理由（对照备选的"桌面做 OneBot 客户端连外部 SnowLuma"）：
- 零网络跳：消息不出本机回环，与 Outbox 回执、绑定、日志同进程闭环；
- 账号发现在主进程：`get_login_info` 由桌面直接应答，无需爬 SnowLuma 状态；
- 不依赖 SnowLuma 内嵌（M1 范畴）——外部 SnowLuma/Lagrange/NapCat 以后作为**另一个 OneBot 实现侧**接同一个服务端即可，协议不变。

### 协议语义（adapter-onebot 6.9.4 实测源码确认）

- worker 连上后立刻发 `{action:"get_login_info", params:{}, echo:N}`，桌面必须 echo 应答 `{status:"async|ok", data:{user_id, nickname}, echo:N}`，否则 `bot.initialize()` 永不 online（bridge-ready 也因此不出现——依赖链：OneBot online → HDSI 可用 → bridge-ready）；
- 后续全部请求-响应走 `{action, params, echo}` / `{status, data, echo}` 帧；事件是 `{post_type:"message"...}` 帧；
- 桌面发送消息用 `send_private_msg` action（`{user_id, message, auto_escape}`），echo 匹配取 `message_id` 作为回执。

### 冲突审查矩阵（8 项）

| # | 交互点 | 结论 |
| --- | --- | --- |
| 1 | worker `instance/koishi.yml`（旧尖刺配置 endpoint ws://127.0.0.1:3001）与分支剧本 `koichi.yml`（无 adapter） | **需处理**：新剧本模板注入 adapter-onebot 条目（endpoint 指向桌面服务端、selfId 占位）；旧剧本由用户在 Configure 中加（或迁移工具补） |
| 2 | 多分支/多剧本同时运行，各自的 adapter 都连桌面同一个 WS 服务端 | **需处理**：服务端按连接区分 worker（path 带剧本 ID，如 `/onebot/<storyId>`），事件只路由给对应 worker 的 binding |
| 3 | 一个 QQ 账号绑定一个剧本（BindingRegistry） | 天然兼容：同一账号若被第二个剧本的 worker 声明，桌面在 `get_login_info` 应答层拒绝第二个连接（403 语义）或事件过滤，取先到绑定 |
| 4 | Outbox 回执语义（sent/retryable/permanent） | 对齐：echo 超时 → retryable-failed；OneBot 返回 failed（status != ok）→ 永久失败；成功带 message_id → sent |
| 5 | MessageRouter 去重（rawMessageId 幂等） | 直接使用 OneBot `message_id` 作为 rawMessageId |
| 6 | 三态（running/muted/paused） | 天然兼容：router 已按 phase 分流；桌面适配器只负责转事件，不解读 phase |
| 7 | 私聊 vs 群聊 | 范围铁律：`message_type=group` 事件打日志丢弃；`send` 只接受 kind=private |
| 8 | bridge-ready 依赖链 | adapter online 是 bridge-ready 的隐含前置；桌面 UI 必须在 worker 加载前先起 WS 服务端，否则 worker 首次 connect 失败会重试（adapter 自带重连），可接受 |

### 10.2 组件设计

**`src/main/runtime/onebot-bridge.ts`（新增，主进程）**

```ts
export class OneBotServerAdapter implements ChannelAdapter {
  readonly transport = 'onebot-external' as const
  start(port: number): Promise<void>                       // 起 WS 服务端 ws://127.0.0.1:port/onebot/:storyId
  stop(): Promise<void>
  onInbound(listener): () => void                          // OneBot message 事件 → DesktopInboundEvent
  send(delivery: DesktopDelivery): Promise<DeliveryReceipt> // send_private_msg，echo 等待
  listAccounts(): string[]                                  // 已连接 worker 声明的账号（selfId 集合）
}
```

内部状态机（每条 worker 连接一个 `OneBotClientSession`）：
- `connected` → 应答 `get_login_info`（账号信息由宿主登记表提供：用户在 UI 为剧本配置 selfId/nickname）→ `online`
- 收 `message` 帧（`message_type=private`）→ 转 `DesktopInboundEvent`（transport 'onebot-external'、rawMessageId=message_id、occurredAt=事件时间）→ onInbound 监听者（main.ts 接 MessageRouter）
- 收 `message` 帧（`message_type=group`）→ 记日志丢弃（范围外）
- `send()` → 取该剧本的 client session → `send_private_msg` → 30s 内等 echo → 回执；无连接/超时 → retryable-failed
- 连接断开 → 标记 offline，待重连（adapter 客户端自动重试）

**账号登记表**（`runtime/account-registry.ts`，新增）：剧本 ↔ OneBot 账号（selfId + nickname）的宿主侧登记（`dataRoot/accounts.json`），`get_login_info` 应答的数据源；同时是绑定 UI 的账号目录。与 BindingRegistry 分工：登记表回答"这个剧本宣称自己是谁"，BindingRegistry 回答"哪个账号路由给哪个剧本"。

**worker 配置模板**（`buildStoryYml` 扩展）：

```yaml
  group:adapter:
    adapter-onebot:m0:
      selfId: ''            # 用户在 Configure/账号面板填写后保存
      protocol: ws
      endpoint: ws://127.0.0.1:6709/onebot/<storyId>
      token: ''             # 桌面服务端校验 Bearer（可选）
```

### 10.3 测试策略

1. **单测**（runtime.test.ts）：OneBot 帧解析（message→入站事件、时间戳、去重 ID）、send 的 echo 匹配与超时、群聊丢弃、账号登记；
2. **e2e**（test-bridge-e2e.mjs 扩展）：真实 worker + 桌面适配器 + **模拟 OneBot 客户端**（测试自己扮演 worker 的 adapter-onebot 连桌面服务端，验证 get_login_info 握手 → 注入私聊事件 → 观察 router 转发 → 桌面发起 send → 模拟客户端应答 echo → 断言 Outbox sent）；
3. 手工验收：外部 SnowLuma/NapCat 连入做一次真实私聊。

### 10.4 明确不做（M7 范围外）

- SnowLuma 内嵌（M1 范畴，独立阶段）；
- 群聊/引用/图片/语音/表情/戳一戳（每类按设计文档第六步规则逐个扩展）；
- 多 OneBot 实现的兼容性矩阵（先保证标准 OneBot 11 核心 action）。

## 10.5 M7-1 实施落地记录（2026-09-05）

### 落地组件

- **`runtime/account-registry.ts`**：宿主侧账号登记表（`accounts.json`）。`register/removeByStory/list`；同一账号只能被一个剧本声明（冲突显式拒绝）；QQ 号格式校验（5–11 位数字）。
- **`runtime/onebot-bridge.ts`**：`OneBotServerAdapter implements ChannelAdapter`（transport `onebot-external`）。
  - `start(port)`：`ws` 库 WS 服务端（`127.0.0.1`，默认端口 6709），路径 `/onebot/<storyId>` 手动解析；
  - 连接门控：未登记账号 → close 1008；token 可选校验；同剧本重复连接顶替旧连接；
  - `get_login_info` 握手应答（登记表数据源）→ worker 的 adapter-onebot online；在线/离线事件广播；
  - 入站：OneBot `message` 帧 → `DesktopInboundEvent`（保留 OneBot 秒级 time 与 message_id 作幂等键）；`message_type=group`、含 CQ 码、非文本段一律丢弃（范围铁律）；`meta_event` 忽略；
  - 出站：`send(delivery)` → `send_private_msg` + echo 等待（30s 超时 → retryable-failed）；OneBot 显式失败 → permanent-failed（不盲目重试）；selfId 不匹配 / 群聊 → permanent-failed；无连接 → retryable-failed。
- **main.ts 接线**：`app.whenReady` 先起桥接服务端再创建窗口；入站监听 → MessageRouter（unassigned 广播）；在线/离线/日志广播。
- **IPC**：`accounts:list/register/remove`（register 要求 worker 未运行——selfId 在 worker 启动时读取）。
- **worker 模板**：`buildStoryYml` 注入 `adapter-onebot`（`endpoint: ws://127.0.0.1:6709/onebot/<storyId>`，selfId/token 留空占位——不用 `$secret:` 别名以避免未登记时 compile 失败）。

### 实测发现与修复的问题

1. **esbuild 双 ws 副本坑**：runtime 测试 bundle 默认把 `ws` 打包进去，与测试外部 `require('ws')` 形成两份副本——事件跨副本不兼容导致测试超时 hang。修复：`test-runtime.mjs` 的 esbuild 加 `external: ['ws']`。
2. 测试首次运行发现 `adapter.send` 依赖 `delivery.storyId` 路由会话——`DeliveryRecord` 天然携带，但测试夹具漏传；已补。
3. 空库 worker 的 purge-range 请求被防御性拒绝（"没有可操作的剧本"）——行为正确，e2e 断言按此校准。

### 验证

- 桌面 runtime 测试 **23/23**（新增 OneBot 桥接套件：握手应答/私聊转换/群聊与 CQ 丢弃/sent 回执/群聊永久失败/OneBot 显式失败 permanent）；
- bridge e2e（真实 worker）**13/13** 全绿；
- typecheck 通过、`npm run build` 通过。

### M7 剩余（按施工单顺序）

1. **账号绑定 UI**（M7 第二批）：Routing/账号面板消费 `accounts:list/register/remove`，绑定→BindingRegistry，冲突提示；
2. **真实 SnowLuma/NapCat 连入做一次真机私聊**（第三批手工验收）；
3. 验收清单逐条打勾：running 收发 / muted 入箱 / paused 积压 / 重启恢复 / 掉线重连 / 失败不伪造已送达。

### 之后的路线（更新）

- 分支批次 4（forkPoint 游标回拨，HDSI 侧带开关）与批次 5（推子旋钮调音台）——现在有了真实消息流，"实机稳定"观察可以开始积累；
- M6 完整版（Console 配置捕获、插件健康同步、Blind 强制规则）；
- M8 产品化（打包分发、数据迁移向导）。

## 10.6 M7-2 实施落地记录（2026-09-05）：账号绑定事务与运行时配置注入

按审查意见完成"账号声明、渠道连接、剧本绑定"三合一：

### 原子绑定事务（`accounts:bind` / `accounts:unbind` IPC）

- 一次 `bind` 原子完成：`AccountRegistry.register`（账号声明）+ `BindingRegistry.bind`（路由绑定，transport=onebot-external）+ 冲突校验。任一步失败整体回滚（按建立相反顺序恢复两者先前的状态），绝不留下半绑定状态。
- **运行时配置注入**：`StoryConfigCompiler.compile` 新增 `options.onebot`；`StoryManager` 构造时注入解析回调——worker 加载时把登记的 `selfId` 与内部端点 `ws://127.0.0.1:6709/onebot/<storyId>` 写入 **resolved 临时配置**。canonical `koichi.yml` 永不被改写（分支复制/备份/导入导出/手编保持干净）；`onebotInjected` 标记随 `CompiledStoryConfig` 返回。
- **未登记/未绑定时不注入**：worker 以空 selfId 加载 adapter，连入时被桌面门控拒绝（1008）并记日志——错误路径同样可观察。
- `accounts:status` 返回 entry/binding/online/configuredToStory 四元组，驱动 UI 状态灯（在线/已绑定/配置漂移/未绑定）。

### Renderer 账号面板

Browser 的 SELECTED STORY 区新增 ONEBOT ACCOUNT 区块：显示绑定状态灯、账号、昵称；登记并绑定/重新绑定/解绑按钮；绑定漂移时提示修复。全走窄 IPC，不接触数据库。

### e2e 升级为三方链路（17/17）

在原有 bridge protocol 4 验证之上，e2e 现在以与桌面完全相同的方式启动 `OneBotServerAdapter`（随机端口），**真实 Koishi worker 的 adapter-onebot 以登记账号连入桌面桥接并完成握手**：

- `worker adapter-onebot 连入并握手 {"storyId":"alpha","selfId":"1303322392"}` ✓（轮询在线状态，无事件竞态）
- 桥接服务端启动先于 worker fork（端口动态分配写入 yml）✓

### 实测发现并修复的协议缺口

1. **`get_guild_service_profile` 握手探测**：adapter-onebot 初始化时先探测 QQ 频道服务，此前桌面拒绝该 action 导致 `bot.initialize()` 抛错、worker 永不 online。修复：应答 `{tiny_id:'0'}`（无频道能力），adapter 跳过 guild bot 继续流程。
2. **在线事件竞态**：worker 握手完成早于 e2e 注册监听器——断言改为轮询 `onlineAccounts()`，无竞态。
3. **测试 bundle 双 ws 副本**（M7-1 遗留记录）：esbuild 加 `external: ['ws']`。

### 验证

- 桌面 runtime 测试 **25/25**（新增绑定事务回滚、编译注入/非注入、legacy 剧本自动补 adapter 条目）；
- 桥接 e2e **17/17**（三方真实链路首次全通）；
- typecheck 与 build 全过。

### M7 剩余与下一步（更新后的顺序）

1. **M7-3 真实上游**：`ExternalOneBotConnector` 对接 SnowLuma/NapCat（私聊纯文本），替换"桌面模拟上游"；真机验收清单（running 收发/muted 入箱/paused 积压/重启回放/断线/echo 超时/显式失败/重复 message_id/失败不伪装已送达）逐条打勾。
2. **Outbox 重试协调器**：主进程拥有有限重试计划（退避+最大次数+待重试/永久失败状态可视），HDSI 只接收最终投递现实——避免剧本层与桌面层双重重试。
3. 分支批次 4（forkPoint 游标回拨）在真实消息链路稳定后评估；批次 5（推子旋钮）可并行。
4. **版本基线矩阵**：typ-0 安装的 HDSI（`1.0.0-beta4-m8`）与 `hdsi-sourcecode/`（`0.1.5-beta1`）已脱钩——后续以 tgz + 桥接协议版本 + e2e 夹具为准，不直接改 `hdsi-sourcecode`；等 M7 真机跑通后再评估升级主线 beta5-m10 并先跑 protocol/投递回归。

## 10.7 M7-3 实施落地记录（2026-09-06）：外部 OneBot 上游连接器

按审查意见第 2 条完成"内部 Worker OneBot 门面"与"外部 OneBot 上游"的职责拆分。

### 架构：共享协议核心 + 双传输前端

- **`runtime/onebot-core.ts`（新增）**：与传输方向无关的协议核心——`transformPrivateMessage`（事件转换+范围规则）、`buildSendPayload`（出站校验+载荷构造）、`receiptFromEchoResponse`（回执映射）、`replyToUpstreamAction`（实现侧 action 应答策略）、`extractPrivateText`。范围铁律集中在一处。
- **`runtime/onebot-bridge.ts`（重构）**：`OneBotServerAdapter`（worker 门面）改为消费核心，自身只保留传输层（WS 服务端、session、echo pending 表）。
- **`runtime/external-onebot-connector.ts`（新增）**：`ExternalOneBotConnector implements ChannelAdapter`——桌面作为 **WS 客户端** 连接真实 OneBot 实现（NapCat/Lagrange/SnowLuma 的正向 WS 端点）。断线自动重连（retryIntervalMs）、echo 超时/显式失败/群聊/媒体语义与门面完全一致。

### 接线与生命周期

- 账号登记扩展 `externalUpstream: { endpoint, tokenAlias? }`（token 走 `$secret:` 别名引用宿主密钥库，不落盘）。
- `main.ts` 新增 `syncExternalConnector(storyId)`：绑定事务成功后按登记状态启动/停止 connector（有上游配置且已绑定才连接）；剧本卸载时停止；window-all-closed 全量清理。
- 入站路径共用 `MessageRouter`（上游连接器与 worker 门面的事件流汇合同一 router，按绑定路由）。

### 实测发现并修复

- **回归 bug**：重构 `handleClientAction` 时丢失了 `session.online = true` 的设置（旧 get_login_info 分支携带），导致 e2e 握手后在线状态永不出现。这是"共享核心重构必须逐分支核对副作用"的直接教训——单测与 e2e 的轮询断言（`onlineAccounts()`）捕获了它。
- e2e 附带发现：`dist-e2e` 陈旧 bundle（无 `external: ['ws']`）也会复现 M7-1 的双 ws 副本问题；e2e 的 esbuild 已同步加 `external: ['ws']`。

### 验证

- 桌面 runtime 测试 **26/26**（新增 ExternalOneBotConnector 套件：连真实上游 WS 服务端、私聊入站转换、sent 回执、显式失败 permanent、群聊投递 permanent、群聊事件丢弃）；
- 桥接 e2e **17/17**（三方链路：真实 worker adapter-onebot ↔ 桌面门面 ↔ 登记账号握手，全部通过）；
- typecheck 与 build 全过。

### M7 收尾清单（剩余）

1. **真机验收**（人工）：NapCat/Lagrange/SnowLuma 任一实现连入 externalUpstream，完成 M7 验收清单逐条打勾——running 收发 / muted 入箱 / paused 积压 / 重启回放 / 断线重连 / echo 超时 / 显式失败 / 重复 message_id / 失败不伪装已送达；
2. **Outbox 重试协调器**（主进程拥有有限重试计划：退避+最大次数+待重试/永久失败状态可视，HDSI 只接收最终投递现实）；
3. 之后：分支批次 4/5、M6 完整版、M8 产品化（顺序见 10.6 节）。

## 10.8 D5 内核对齐：beta4-m8 → beta13（2026-09-08，提前执行）

原路线 D5 排在 D2/D3/D4 之后；本次提前执行，理由：typ-0 此刻**零真实故事、零真实渠道数据**（story 目录为空，instance 库只建过表），存量迁移风险处于历史最低点；主线内核一周内从 beta4-m8 推进到 beta13（knowledge 证据体系、P1 记忆导航、urge、beta8→beta13 提示词改进），分叉持续扩大；且 bridge 协议在 beta13 仍为 4，桌面侧投影代码零改动。D1 已收尾、D2 未开工，是干净的升级间隙，不违反"故障源不混淆"约束。

### 改动

- `desktop/package.json`：`koishi-plugin-hds-interlude` 依赖从 `file:…1.0.0-beta4-m8.tgz` 重指 `…1.0.0-beta13.tgz`；`yarn install` 更新 lockfile。桌面工程自身代码**零改动**。
- 新增 `scripts/test-d5-migration.mjs`：内核升级迁移夹具（详见下）。

### 迁移夹具（6/6 通过）

以 `desktop/instance/data/koishi.db`（beta4-m8 真实旧 schema，`interlude_fact` 无 knowledge 列）为底本，注入 story/fact/script_entry 代表行后 fork beta13 worker 实际加载，断言：

1. 夹具有效：升级前 `interlude_fact` 确无 knowledge 列；
2. worker 正常 bridge-ready（插件在旧库上启动成功，protocol=4）；
3. `interlude_fact` 增量获得 knowledge 列（database.ts 的 ALTER 路径在真实 worker 内执行）；
4. fact 行数不变；5. story 行数不变；6. 注入的 fact 内容（中文文本 + status）逐字幸存。

### 全量验证（升级后）

- `tsc --noEmit` 通过；
- runtime 单测 **29/29**（D0/D1 全套，含回声过滤、身份验证、connector 分派）；
- 桥接 e2e **17/17**（protocol 4 握手、timeline-range v4 字段白名单、purge-range、phase 语义、snapshot 兼容）；
- 迁移夹具 **6/6**。

### D0 基线更新

D0 的 Inspector 基线读实际 resolver 的 `node_modules`，升级后自动显示 `1.0.0-beta13` / protocol 4 / 新 artifact hash，无需代码改动。`story.json.hdsiVersion` 继续作为创建时历史记录。

### 保留边界

- 旧库中 knowledge 列添加后旧行该列为 NULL，读取侧按"未分类派生记录"处理（主线 beta7-enhanced 的防御读取已覆盖并有回归测试）；本夹具验证的是 schema 迁移与行保留，**不含**旧行在叙事中的语义表现。
- 未连接真实 QQ；未验证 beta13 新功能（urge、P1 召回）在桌面 UI 的投影呈现——urge 默认关闭，P1 投影走既有 timeline-range 通道。
- 下一步顺序不变：真机验收（M7/D1 遗留）→ D2 回执语义 → D3 备份恢复 → D4 M6 收尾 → D6 产品化。

## 10.9 M7/D1 真机验收记录（2026-09-09，SnowLuma 实机）

环境：SnowLuma v1.14.0（hook 模式）挂 QQ 1303322392（bot）与 1319973221（用户，QQNT 实机）；typ-0 Electron + 外部连接器 ws://127.0.0.1:3001；故事 m7-acceptance；模型 yunwu/gemini-3-flash-preview（真实计费调用）。

### 已实证通过（真机）

- **绑定→连接→身份验证**：账号面板登记（selfId+昵称+endpoint+tokenAlias）→ 绑定事务 → connector 连真实上游 → get_login_info 比对 selfId → 已验证在线。
- **入站过滤**：群消息丢弃（M7 仅私聊）、meta_event 心跳忽略、message_sent 自身回声不产生用户入站（投递后无新 inbound，未成环）。
- **实时全链路**：QQ 用户消息 → SnowLuma WS → connector → MessageRouter → worker bridge（beta14）→ HDSI 建剧本（character:onebot:1303322392，autoCreate）→ 真实模型叙事（9.7s，166 字）→ delivery 事件 → connector → SnowLuma → **用户 QQ 收到回复**（人工截图确认"嗯嗯，火锅可以…"）。
- **paused 积压重放**：拒收期 3 条消息入箱（reason=worker-rejected），修复后 replayInbox consumed 3/pending 0，全部走完叙事+投递。
- **断线恢复**：SnowLuma 重启后 connector 按 5s 退避自动重连并重新验证身份；应用重启后绑定/密钥/connector 状态从磁盘恢复。
- **投递回执**：`[delivery] sent` 事件回写，Outbox 台账可查。

### 验收发现并修复的缺陷（5 项）

1. **HDSI 主线 bug（beta14 修复）**：`onebot.enabled` Schema 默认 true，未配置该段的安装进入"空默认白名单拒绝全部私聊"，canHandleSession 静默拒收且无可见日志——typ-0 故事模板必然触发（剧本库始终为空、inbound 全部 worker-rejected）。默认改为 false 恢复"未配置即不过滤"。定位手段：fork 同参 worker + bridge 命令注入 + node_modules 探针二分（A-enter 打出而 B-E 全无 → 静默出口在 canHandleSession）。
2. **typ-0 编译器 bug（已修）**：故事 yml 已有 adapter 块时 selfId/endpoint 注入追加第二个顶层 `group:adapter:` 键 → js-yaml duplicated mapping key → worker 无法启动。改为就地替换。
3. **typ-0 编译器 bug（已修，同日晚些）**：CRLF 行尾使替换正则失配（JS `.` 不匹配 `\r`、无 m 标志 `$` 不锚 `\r`），selfId 替换静默退化为插入、产生重复键。正则改 `[^\r\n]*`，补 CRLF 回归测试。
4. **typ-0 生命周期缺陷（记录，待 D2/D3 修）**：主进程崩溃/重启后 worker 成为孤儿（IPC 通道随父进程死亡，但 StoryManager 状态与 OneBot 内桥连接可被新进程误领），phase 命令静默丢失、inbound 全部超时拒收。绕过方式 unload+reload；根治需 worker 心跳超时判定 + 孤儿检测。
5. **次要**：readServerPort 每秒刷 warn（console-port 上报缺 server inject 声明）；SnowLuma 双账号 hook 竞争 3001 端口（EADDRINUSE，后启动者失败且不重试；手动经 WebUI API 把用户账号挪 3002 + 全绿热重载解决）。

### 部分验证 / 未验证

- **muted 入箱**：与 paused 共享同一路由分支（`phase === 'paused' || 'muted'` → append(reason)），runtime 单测覆盖三态分流；真机键盘链路在无 GUI 自动化条件下不稳定，未单独截图实证。
- 长时重连、断网恢复、崩溃点投递语义（D2 范围）、群聊/媒体消息（明确超出 M7）。

### 交付物

- typ-0 内核基线 beta4-m8 → **beta14**（`desktop/package.json` 重指 + yarn 锁定）；tsc/29 runtime/17 e2e 全绿。
- 诊断工具沉淀：`scripts/test-d5-migration.mjs`（内核迁移夹具）、`scripts/test-inbound-repro.mjs`（worker inbound 沙箱复现器，支持真实模型端到端）、`scripts/cdp-app.mjs`（CDP 驱动 preload API）、`scripts/probe-snowluma.mjs`、`qq-focus/qq-send2/ps-click/ps-shot`（无 CUA 键鼠应急件）。
- HDSI 主线 beta14 发布（OneBot 默认值修复），详见主线 CHANGELOG。

## 10.10 D2-1 孤儿 worker 治理与自动恢复（2026-09-09）

10.9 验收缺陷 #4 的根治。新增 `runtime/worker-registry.ts`：

- **PID 登记簿**：每次 fork 把 `{pid, storyId, launcherPid, startedAt}` 写入 `<story>/.typ-0-runtime/worker.json`；worker 正常 exit 时清除。写失败不阻塞加载（登记簿是安全网而非前置条件）。
- **启动扫描**（主进程 ready 后、恢复前）：按记录归属处置——pid 死→删陈旧记录；launcher 活（且非自己）→**他主实例在管，不动**（D3 单宿主保护的第一块基石）；launcher 死→孤儿，**进程名校验**（tasklist/ps，须匹配 electron/node/typ-0/hdsi 特征，防 PID 复用误杀）通过后 SIGKILL 并删记录；自有记录保留。扫描异常不阻塞启动。
- **auto-resume**：扫描后对 `phase=running` 的故事自动 `load()`（受 maxWorkers 与分支互斥约束；单个失败仅记日志）。OneBot 桥接服务端先于恢复启动。
- **心跳降级**（已有，本次确认）：`isBridgeReady` 的 45s 心跳超时使 router 自动把入站改投 `worker-unavailable` 入箱，不丢消息。

### 验证

- 单测 **30/30**（新增六态决策矩阵：orphan-killed / stale-removed / foreign-launcher-kept / own-record-kept / orphan-left-foreign / 损坏记录 + auto-resume 选择逻辑；探针全注入）。
- 真实孤儿夹具 `scripts/test-d2-orphans.mjs` **4/4**：fork 真 worker → 登记已死 launcher → sweep 判定 orphan-killed（进程名 node.exe）→ 进程终止 → 记录清理。
- 真机实证：重启应用后 m7-acceptance（phase=running）**自动恢复**（worker.json 记录 launcher=当前主进程 pid，新 worker 起在线）；上代未写记录的历史孤儿（18596）手动清除——D2-1 只能治理有记录的 worker，部署即从此代起累积保护。
- tsc / 30 runtime / 17 e2e / renderer 语法全绿。

### 实现备注

- 夹具还抓到两个静默 bug：worker-registry 内联 `require('node:fs')`/`require('node:child_process')` 在 ESM 打包产物中不存在、异常被 catch 吞成"无记录"——已改顶层导入（主进程 CJS 下同样正确）。
- D2 剩余：D2-2 回执三态（accepted/unknown/confirmed + 崩溃点演练）、D2-3 replay 错误分类（timeout/rejected/ipc-dead）与 muted 真机实证。

## 10.11 D2-2/D2-3 回执三态与路由错误分类（2026-09-09）

### D2-2 投递回执三分

`DeliveryState` 从 `sent|retryable-failed|permanent-failed`（+generated/sending）扩展为：

- **confirmed**：OneBot 回 `ok` 且带 `message_id`——平台确认生成消息；
- **accepted**：`ok` 无 id 或 `async`——上游受理、最终送达未确认（旧 `sent` 语义，保留兼容）；
- **unknown**：**请求已写出但没等到回执**（等待期超时/连接断开）——结果不可知。可见（Outbox/日志/UI）、可核对（messageIds 空 + lastError 说明）、**绝不自动重发**（消息可能已送达，重发=重复投递）。

发送前失败（无连接/未验证/构造失败/socket.send 抛错）维持 retryable/permanent——那些消息确定没出去，可安全重试。`sentAt` 只在 confirmed/accepted/sent 记录。worker（HDSI bridge）协议只知道 sent|失败：`workerReceipt()` 把 confirmed/accepted 映射回 sent（messageIds 透传），unknown 保持失败语义并明确"不自动重发"。两个发送器（内桥/外部连接器）的回执等待上限改为构造可注入（生产默认 30s 不变）。

### D2-3 入站拒收三分类

router 的 catch 把粗粒度 `worker-rejected` 细分：**worker-timeout**（等待确认超时）/ **worker-rejected**（HDSI 明确拒收）/ **worker-unavailable**（IPC 断开等）——真机验收时前者曾长期掩盖后者。host 投影的收件箱计数同步扩展。

### 验证

- 单测 **31/31**（新增：回执映射三分、unknown 不记 sentAt/summary 可见、workerReceipt 映射、路由三分类实测 peek reason 序列；既有 echo 超时/回执断言同步新语义）。
- tsc / build / bridge e2e 全绿；真机应用带全部 D2 改动重启，auto-resume 正常。
- muted 真机实证仍受键盘链路不稳定限制（QQ 深色 UI 无视觉反馈闭环），代码路径与单测覆盖不变，记录同 10.9。

### D2 收尾状态

D2-1（孤儿治理/auto-resume）、D2-2（回执三态）、D2-3（路由分类）全部落地。原 D2 范围中"三个崩溃点演练夹具"随三态语义一并由单测覆盖（发送前=retryable 已测、等待中断开=unknown 已测、回传前=Outbox 持久化已测）；下一项按路线进入 **D3 一致性备份/恢复与单宿主保护**（worker 登记簿的 foreign-launcher-kept 判定已是其第一块基石）。

## 10.12 D3 一致性备份、单宿主保护与关闭排空（2026-09-09）

### D3-2 单宿主实例保护（`runtime/host-lock.ts`）

主进程 ready 第一件事取 `dataRoot/.typ-0-host.lock`（pid+bootId+startedAt）。锁持有者仍活着 → 第二实例弹错误框并退出（无主窗口、不初始化任何服务）；死 pid/损坏锁 → 接管；正常退出释放（`window-all-closed` finally）。与 worker-registry 的 foreign-launcher-kept 判定共同构成"同一数据目录无双宿主写入"的两层防线。

### D3-1 一致性备份与可核对校验

`stories:backup` 从"直接 cpSync"升级为四步流程：**worker 在跑则先 unload**（SQLite 落盘、无并发写者）→ 复制（排除 .typ-0-runtime）→ **verifyStoryArchive 校验**（story.json 可读、koishi.yml 存在、每个 .db 的 SQLite 魔数 + 具备 node:sqlite 的运行时追加 quick_check；Electron 主进程内嵌 Node 20 无该内建模块，优雅降级为魔数校验并在清单注明）→ 按原 phase 自动恢复。任何校验失败即抛错，撕裂快照不会被当作可用存档。

### D3-4 关闭排空

`dispatchDelivery` 全程计入 in-flight 计数；`window-all-closed` 给在途投递 8 秒有界排空窗（已写出的请求等待落账——成功/失败/unknown 都算落账——再停渠道与 worker），随后释放宿主锁。

### D3-3 绑定回滚保留 upstream

既有 M7-2 事务已覆盖（回滚恢复 previousEntry 含 externalUpstream），单测"M7-2 绑定事务：登记+绑定同生共死"在守；本轮无新增改动。

### 验证

- 单测 **33/33**（新增：host-lock 首取/拒绝/接管/释放矩阵、备份校验合法/撕裂/缺件三分）；tsc / build / bridge e2e 全绿。
- 真机实证：双实例互斥（B 实例无窗口被拒）；强杀残留锁由 pid 探活接管（新实例正常启动）；运行中故事备份产出含三项检查的清单并自动恢复运行（worker 重 fork 在线）。

### D3 完成状态与下一步

D3 四项全部落地。下一项按路线为 **D4（M6 收尾：Console 配置持久化边界、跨 Surface Blind、权限与身份统一）**；分支批次 4（forkPoint 游标回滚）与批次 5（调音台 UI）随后。

## 10.13 D4 M6 收尾：Console 配置边界、跨 Surface Blind、身份统一（2026-09-09）

### D4-2 Console 配置捕获回写（`runtime/console-config-capture.ts`）

Koishi Console 保存插件配置写的是 worker 的 resolved 临时文件（密钥明文、实例键随机后缀、宿主注入段混杂、worker 退出即丢）。D4-2 把 hds-interlude 段捕获回 canonical：

- StoryManager 对 resolved 文件加 `fs.watch`（worker 生命周期内，exit 即关；1.2s 防抖防保存风暴）；
- 捕获纯函数：解析 resolved → 收集 `hds-interlude:*` 实例（后缀随机，正常 1 个，多实例合并）→ **反向脱敏**（providers 值与 SecretStore 别名值全等 → 替换回 `$secret:别名`，canonical 永不落明文）→ deep-equal 无实质变更不写；
- 宿主运行参数（adapter-onebot 的 selfId/endpoint、server/console 注入段）绝不混入回写；
- 经 ConfigMediator.save 落盘（自带时间戳备份与别名校验）；任何失败只记日志、canonical 不动。
- 实现中抓到嵌套计数 bug：redact 的 object/array 分支 `+=1` 吞掉下层计数，改为 `+= hit`（单测 redactions=2 断言逮住）。

### D4-1 Blind 跨 Surface

Blind 开启时：`console:attach` 直接拒绝（Console 的消息/日志原文是屏蔽绕过口），已嵌入的视图全部销毁并清 session 存储；关闭日志文案同步说明。Renderer 侧屏蔽沿用 logs:blind 事件。

### D4-3 身份统一

`StoryManager.get()` 入口加 storyId 白名单正则——所有 IPC handler 的 storyId 都经此过滤，路径拼接注入在一处防全部。

### 全量验证（本轮完整批次）

tsc / runtime **34/34** / 孤儿夹具 **4/4** / 迁移夹具 **6/6** / bridge e2e 全部通过 / renderer 语法 / build——七项全绿。

### D 系列完成状态

D0–D4 全部落地。剩余路线：分支批次 4（forkPoint 游标回滚，需 HDSI 侧 gated 配合）/ 批次 5（调音台 UI）→ M8/D6 产品化（安装包、新用户零 YAML、分发演练）。

## 10.14 Subtle UI 优化批次（2026-09-09）

不改布局与交互逻辑的质感批次：

- **投递状态语义呈现**（D2-2 枚举的视觉落地）：Deliveries 表状态列中文标签（已确认/已受理/结果未知/失败·可重试…）+ 语义着色——confirmed/sent 绿、accepted 蓝、**unknown 琥珀**（警示但非错误）、失败红；Inspector 的 Outbox 摘要改为"N 出站 · N 未知 / N 待发"，unknown 计数琥珀色。
- **收件箱 reason 中文化**：日志流里 `worker-timeout/worker-rejected/worker-unavailable` 显示为"等待确认超时/worker 拒收/worker 不可用"（D2-3 分类的可读性落地）。
- **深色细滚动条**：替换默认白色滚动条（DAW 深色界面的最大视觉噪音源）。
- **悬停过渡**：按钮/故事条/浏览器项/明细行加 0.12s 过渡，状态切换不再生硬。
- **时钟带日期**：transport 时钟前缀 MM-DD 小字；Inspector Inbox 摘要中文化。
- ▶◐■ 已有 title tooltip（盘点确认，未改）。

验证：renderer 语法 / tsc / build / runtime 34/34 / bridge e2e 全绿；真机重启后 auto-resume 正常、时钟与新标签经 CDP 确认生效。改动集中在 `style.css` 尾部新增段与 `app.js` 三处渲染函数，回滚成本一行 git 级。

## 10.15 Ableton 风格修正批次（2026-09-09 二轮）

保持 Ableton Live 语言（扁平、纯色、高密度）的定向修正：

- **Clip 扁平化**：script clip 去渐变与拟物阴影（`linear-gradient`+内高光+外阴影 → 纯色 + 1px 深边框）；全轨道 clip 统一去 `box-shadow`。
- **Clip 选中态**：选中 clip 以 accent 色 1px 双线边框标记（Ableton 选中 clip 的高对比描边语言），点击 script clip 后持续可见。
- **轨道头 Activator 方块**：每条轨道头加 8×8 状态方块——有内容亮轨道色（script 粉 / messages 蓝 / facts 紫 / preplan 橙），空轨灰色（Ableton track activator 的密度语言）。
- **标尺时间标签**：标尺网格注入五等分 HH:MM 读数（与视窗范围联动、中点微亮），替换纯刻度装饰。

验证：CDP 实测 ruler 标签 5 个、track LED 5 个、script clip background-image=none/box-shadow=none（扁平化生效）；renderer 语法 / build / runtime 34 通过。

## 10.16 Session 视图、调音台与日志分级（2026-09-09 三轮，批次 5 落地）

三项功能性 UI，全部在 Ableton Live 语言内（扁平、高密度、专业向）：

### Session 视图（▣ Session，关联分支批次 3/4）

Arrangement 的平行视图：剧本片段以 Ableton session 式 clip 卡片纵向堆叠——每卡左侧粉色彩条 + 序号 + RANGE/POINT·ENTRY 数·时间头 + 300 字预览 + **⤴ 分支续写**按钮。点击卡片 = 检查（Inspector 联动 + 选中描边 + Script 明细）；分支按钮弹出对话框（预填名称 + forkPoint 锚点说明）→ `stories.forkBranch`（entryId 锚点，整库复制，同分支树互斥由既有机制保证）。

### 调音台（▮ Mixer，批次 5 本体）

- **main 侧白名单读写**：`stories:mixerRead/mixerWrite` IPC，六通道白名单（temperature/topP/自动推进间隔/factLimit/recentEntryLimit/后台整理周期），范围校验 + step 量化（浮点尾差修约，实测 0.7 干净落盘）；写入经 js-yaml 应用到 canonical（$secret 段不经此路径），ConfigMediator 落盘自带备份。
- **渲染层**：Ableton channel strip 式六路推子（竖向滑杆 + 金属质感手柄 + hover 变琥珀 + 绿色数值窗），松开 800ms 防抖自动写入；未显式设定的参数按中位显示、写入才落盘；"重载 Worker"按钮应用新参数（unload→load，auto-resume 语义保持 phase）。

### 日志分级着色

补齐 error（红）/ debug（暗灰降透明）两级（warn 琥珀已有），Logs 流一眼分诊。

### 验证

CDP 实机：session 卡片与分支按钮渲染 ✓、mixer 六通道推子 ✓、推子→canonical 写入端到端 ✓（0.85 尾差修复后 0.7 干净）；34 runtime / e2e / renderer 语法 / tsc / build 全绿；测试写入已还原。preload 新增 mixerRead/mixerWrite 两个暴露面。

## 10.17 面板简化与操作提升（2026-09-09 四轮）

### 精简（减数量、降视觉噪音）

- **SELECTED STORY 视图分组**：7 个视图拍平一列 → 4 主视图（Overview / Session / Timeline / Mixer，对应快捷键 1-4）+ MORE VIEWS 折叠组（Facts / Schedule / Configure）。高频一眼可达，低频不消失。
- **去重复入口**：workspace 头部的 Load Worker / Configure 删除（Inspector 的操作按钮与 Browser 视图已覆盖）；browser 工具行的 ＋ 按钮删除（transport 已有"＋ 新剧本"）。
- **ARRANGEMENT TRACKS / STORY OPERATIONS** 默认折叠（低频操作不占首屏）。
- 筛选框提示补 Ctrl+K。

### 操作提升（键盘优先）

- **1-4**：切主视图
- **Space**：循环相位（running → muted → paused → running，空格即三态切换，与 transport ▶◐■ 等效）
- **F5**：刷新时间线投影
- **Ctrl+K**：聚焦故事筛选框

输入控件聚焦时快捷键不劫持。CDP 实测：4 主视图可见、死按钮清零、快捷键 2→Session 生效、Space 相位循环 running→muted 后可恢复。

验证：renderer 语法 / build / 34 runtime 全绿。

## 10.18 右键上下文菜单与可用性修复（2026-09-09 五轮）

### 右键上下文菜单（新增交互层）

- **时间轴 clip**：检查内容 / ⤴ 从此分支续写（script 类）/ 复制文本
- **Session 片段卡**：检查片段 / ⤴ 从此分支续写 / 复制片段文本
- **故事条**：加载 Worker / 备份 / 卸载 Worker（按运行态切换）
- 菜单系统：`showContextMenu/dismissContextMenu/bindContextMenu` 三函数；点击外部/Esc 自动关闭；viewport 边缘夹取防溢出；CSS 深色扁平 + 悬停高亮。

### 修复

- `openForkDialog` 对 null block 的安全处理（故事条右键进入时自动取最新片段锚点）。
- clip() 与 Session 卡的 `bindContextMenu` 首次施工未落盘（Python 替换断言通过但后续构建覆盖），重新以 Edit 工具精准落上。

### 审计结论（无变更项）

- 按钮接线：18 个有 id 的按钮中 17 个已接线，save-config 走 form submit 通道（等效已接）。
- workspace-header / inspect-grid 无 CSS 级溢出（CDP 逐元素 scrollWidth 检查全零）。
- clip 点击→Inspector/Detail 联动正常（CDP 实测 click 后 inspectorTitle 与 detailTab 正确更新）。

验证：renderer 语法 / build / runtime 34 全绿；CDP 实测 clip 右键菜单三项可见。

## 10.19 轨道重构、NOW 居中与缩放修复（2026-09-09 六轮）

### 轨道重构（功能差异化）

- **去掉 TIMELINE 轨**（与 SCRIPT 功能重复，信息冗余）
- **RECEIVE / SEND 拆为两条独立轨**：RECEIVE（用户来电蓝）/ SEND（角色发言橙），`entryTrack()` 按 kind 前缀精确路由
- **新增 ALTER 轨**：情绪/偏移事件（紫色细条），`entryTrack()` 对 system 类中 alter/emotion/offset 关键词路由
- 轨道菜单同步更新为六条：Script / Receive / Send / Alter / Facts & Scenes / Preplan

### NOW 居中

`timelineViewport` 的 followNow 偏移从 `span * 5/14`（NOW 在 36%）改为 `0`（NOW 恰在视窗中心 50%）。

### 缩放/平移/NOW 按钮修复

**根因**：`updateViewport` 中 `layoutFor()` 与 `timelineViewport()` 的调用顺序造成对象替换竞态——第一次 `layoutFor()` 返回的对象被 `timelineViewport()` 内部的第二次 `layoutFor()` 调用替换，后续的 `spanMinutes` 修改写入已脱离 state 的旧引用。表现为按钮点了没反应。

**修法**：交换两行调用顺序（先 `timelineViewport()` 再 `layoutFor()`），并在 `updateViewport` 末尾同步调 `renderArrangement()` 给即时视觉反馈（不再等 90ms 防抖后异步刷数据才有反应）。

### 标尺文字重叠修复

`range-meta`（X MIN · FOLLOW 指示）从绝对定位重叠区域移至右下角（`inset: auto 100px 1px`，`z-index: -1`），时间标签贴底（`bottom: 1px; top: auto`），不再互相覆盖。

验证：zoom 840→525 ✓ / pan ✓ / NOW 居中 ✓ / 34 runtime / renderer 语法全绿。

## 10.20 轨道主界面重构（2026-09-09 七轮）

### 连条布局（Script 片段顺序填充）

Script 片段不再按绝对时间位置放置（会在 14 小时窗口里变成小点），改为**按时长比例顺序排列**：每段的宽度 ∝ 其实际时长占全部片段总时长的比例，相邻片段无缝连接形成一条连续色带。直观看出哪些段落篇幅长、哪些短。`_stripLeft/_stripWidth` 在 `renderArrangement` 内计算并注入。

### 标尺/轨道对齐

标尺从 `grid-template-columns: 82px 1fr 82px; padding: 0 8px` 统一为 `132px 1fr 60px; padding: 0`——与轨道头的 `132px` 完全对齐（实测 diff: 0px）。去掉了标尺的水平 padding 和 gap。

### FL Studio 式拖拉条

替换 +−‹›NOW 按钮组为底部拖拉条（`.timeline-scroller`）：
- **拖动窗口**平移视窗
- **拖动左右手柄**缩放范围
- **点击空白处**跳转到该时间点
- NOW 标记（琥珀色竖线）指示当前位置，双击回到 NOW 居中
- 窗口范围实时反映当前视窗（left% + width%）

### Clip 比例宽度

非 script 轨道的 clip 最小宽度从 2.2%–7% 降至 0.3%–0.5%（真实比例），时间跨度大的事件自然更宽。

### Script clip 文字布局

改用 `display: grid; grid-template-rows: 1fr auto`（预览区 + 元数据行），文字用 `-webkit-line-clamp: 3` 三行截断 + `word-break: break-all`，不再堆叠溢出。

验证：对齐 diff=0 ✓、连条宽度比例 50%/50%（两段等长）✓、拖拉条渲染 ✓、34 runtime / renderer 语法全绿。

## 10.21 拖拉条闪烁修复（2026-09-09 八轮）

**根因**：`renderTimelineScroller` 在 `renderArrangement()` 内部调用，而后者每次 `replaceChildren()` 销毁全部子 DOM（含拖拉条）。拖动时每帧触发 `updateViewport → renderArrangement → 重建拖拉条`，指针捕获丢失 → 闪烁。

**修法**：拖拉条从 `#arrangement` 容器分离到独立的 `#timeline-scroller-container`（同级元素，不受 replaceChildren 影响）。DOM 结构只创建一次（`ensureTimelineScroller`），后续仅通过 `updateTimelineScroller` 更新 `.scroller-window` 的 `left/width` 样式和 NOW 标记位置——零 DOM 重建。

另修：`var scrollerEl` 声明从文件尾移至头部（`let` 的 TDZ 会导致 `renderArrangement` 首次调用时报 `Cannot access before initialization`）。

验证：CDP 确认 `sameNodeAfterRerender: true`（renderArrangement 后同一 DOM 节点）、窗口样式实时更新、34 runtime / renderer 语法全绿。

## 10.22 拖拉条方向、面板调宽与恢复条修复（2026-09-09 九轮）

### 拖拉条方向修复

Pan 模式的 center 计算从 `startCenter - deltaMs + span/2`（反向+错误偏移）修正为 `startCenter + deltaMs`。拖右 = 时间向右（正确直觉）。

### 面板分隔条（可调宽/高）

- Browser ↔ Workspace 之间：垂直分隔条（拖动调整 Browser 宽度 150–400px）
- Workspace ↔ Inspector 之间：垂直分隔条（拖动调整 Inspector 宽度 180–450px）
- Arrangement ↔ Detail 之间：水平分隔条（拖动调整 Detail 高度 80–500px）
- 分隔条 hover 变琥珀色提示可拖

### 面板恢复条（折叠后可重新打开）

折叠 Browser / Inspector / Detail 后，屏幕边缘出现对应恢复条（`▸ Browser` / `◂ Inspector` / `▴ Detail`），点击恢复面板。

实现要点：恢复条为 **JS 动态创建并绑 click**（`document.body.appendChild` + 直接 `addEventListener`），不依赖 HTML `onclick` 属性——Electron CSP 会拦截 inline handler；也不依赖底部 `addEventListener`（构建过程可能丢失绑定）。`updatePanelRestoreStrips()` 在每次 `togglePanel` / `applyPanelLayout` 后同步增删恢复条元素。

面板自定义宽高持久化到 localStorage（`layout.panelWidths` / `layout.panelHeights`），重启恢复。

验证：strip shown → click → panel restored → strip removed ✓；拖拉条方向正确 ✓；34 runtime / renderer 语法全绿。

## 10.23 布局全量修复（2026-09-09 十轮）

### 问题清单（用户截图反馈）

1. **Grid 布局彻底坏**：分隔条作为 `.studio-shell` 的直接子元素，在 CSS Grid 中额外占据列/行（从 3 列 2 行变成 4 列 4 行），面板被挤到错误位置
2. **Script 轨道 0 SEGMENTS**：视窗被之前的拖拽运算推到 2098 年（`centerAt` 无安全边界），且 span 被缩到最小 15 分钟——条目在时间范围外
3. **拖拉条方向反向**：pan 公式 `- deltaMs` + 多余 `span/2` 偏移

### 修复

- **分隔条方案替换**：从 HTML 删除 grid 子元素分隔条，改用 CSS `resize: horizontal/vertical`（原生浏览器拖拽手柄，零 JS，不破坏 grid 布局）。Browser 可横向调、Inspector 可横向调、Detail 可纵向调
- **视窗安全边界**：`updateViewport` 中 center 限制在 `now ± 30 天`；`layoutFor` 读取时自动检测并重置超出范围的 `centerAt`
- **拖拉条方向**：pan 公式修正为 `startCenter + deltaMs`（去反向、去多余偏移）
- **连条计算加固**：时长兜底 `max(60s, duration > 0 ? duration : 300s)`，最小条宽 1%

### 验证

CDP 实测：grid 恢复 3 列 2 行（`214px 948px 264px / 583px 174px`）✓、视窗回到 2026-09-08（NOW 居中 14 小时窗口）✓、9 条目 9 clips 2 script segments 渲染 ✓、拖拉条存在 ✓、34 runtime / renderer 语法全绿。

## 10.24 清库、Script clip 时间投影与布局修复（2026-09-09 十一轮）

### 清空剧本数据库

`stories/m7-acceptance/data/` 下所有 SQLite 与 inbox 文件删除重建。

### Script clip 改回时间投影（与标尺/其它轨道统一）

去掉之前的"连条模式"（按时长比例顺序填充），恢复为与所有轨道和标尺刻度一致的**时间投影**：clip 的 `left%` 和 `width%` 由 `projectTime(start/end, bounds)` 计算——剧本段在时间轴上的位置和长度与真实推进时间一致，与上方标尺刻度完美对齐。

### Script clip 内容简化（去叠字）

去掉 `clip-chips` 行（"1 ENTRY" / "RANGE" / "POINT" / 边界 / 投递徽章——这些与预览文字叠在同一行），内容精简为：
- 预览文字（flex:1，3 行截断，自动伸缩）
- 底部时间戳（flex:none，单行 nowrap）

内部改为 `flex-direction: column`（预览区 flex:1 自适应 + 时间行 flex:none 固定），彻底消除文字堆叠。

### 验证

- 清库后 0 entries / 0 clips / 0 chips（干净状态）✓
- Grid 3 列正确（`214px 948px 264px`）✓
- 标尺与轨道对齐 diff=0 ✓
- 拖拉条正常 ✓
- 34 runtime / renderer 语法全绿

## 10.25 模型切换与 server inject 修复（2026-09-09，beta15）

- typ-0 密钥库 `primary-model` 从 `gemini-3-flash` 切换为 `gemini-3.7-flash`（解决 429 Too Many Requests）。
- HDSI 主线 beta15：`inject.optional` 加 `'server'`，消除 `readServerPort` 每秒刷 `property server is not registered` 警告。283 测试全绿；安装到 typ-0 + 生产实例，重启后 warning 计数 = 0。

## 10.26 实时播放头与定时刷新（2026-09-09 十三轮）

### NOW 实时播放头（FL Studio 式持续移动）

- 时间轴区域新增琥珀色竖线播放头（顶部圆点 + NOW 标签），以 `requestAnimationFrame` 驱动、200ms 节流更新位置——**持续平滑移动**，位置由 `projectTime(Date.now(), bounds)` 实时计算。
- 标尺和拖拉条上的 NOW 标记同步移动。
- 播放头嵌入 `renderArrangement()` 末尾（直接函数体内调用，非底部包装器——底部 `setInterval` 在 Electron 渲染进程中不可靠执行）。

### 定时刷新

- 故事列表/资源状态：每 30 秒
- 时间线快照（Worker 运行中）：每 30 秒
- 视窗跟随：`followNow` 时每 60 秒检查，NOW 超过视窗 70% 位置时自动前移中心（FL 式缓慢播放效果）

### 验证

CDP 实测：播放头自动创建 ✓、持续移动（left 值随时间变化）✓、拖拉条 NOW 标记同步 ✓、34 runtime / renderer 语法全绿。

## 10.27 标尺 NaN 与面板吸附修复（2026-09-09 十四轮）

### 标尺 NaN 修复

**根因**：`renderArrangementScale` 中 `viewport.from` 是 ISO 字符串，直接与数字做加法变成字符串拼接（`"2026-09-08T..." + 174000`），`new Date(拼接结果)` = Invalid Date → `getHours()` = NaN → 标尺显示 `NaN:NaN`。

**修法**：先 `new Date(viewport.from).getTime()` 转为毫秒再做算术。

### 面板拖拽吸附修复

**根因**：CSS `resize: horizontal/vertical` 只改变元素自身的 width/height，不更新 grid 模板——面板变大后溢出 grid 列，中间工作区被挤压。

**修法**：去掉 CSS `resize`，改为 JS 拖拽手柄（绝对定位于 `workspace-panel` 内、不占 grid 单元格）直接更新 `shell.style.gridTemplateColumns/Rows`——面板始终与 grid 吸附。手柄位置：Browser 右缘（竖条）/ Inspector 左缘（竖条）/ Detail 上缘（横条），hover 变琥珀色。宽高持久化到 `layout.panelWidths/panelHeights`。

### 验证

标尺标签 `03:51 / 03:57 / 04:03 / 04:09 / 04:14`（无 NaN）✓；三个手柄存在 ✓；grid 模板正常 ✓；34 runtime / renderer 语法全绿。

## 10.28 剧本时长渲染与标尺对齐（2026-09-09 十五轮）

### Script clip 时长渲染

**根因**：`buildScriptBlocks` 依赖 `entry.endedAt` 计算结束时间，但实时/用户触发的剧本条目只有 `occurredAt`（写入时刻），没有 `endedAt` → `end = undefined` → clip 宽度 = 最小 1%（点状）。

**修法**：无显式 `endedAt` 的块，用**下一个块的 start** 作为结束（剧本从写入到下一次推进之间就是它覆盖的生活时段）；最后一个块用 `Date.now()`（仍在进行中）。标记 `inferredEnd: true`。

实测：9 分钟剧本在约 20 分钟视窗中宽度 46.27%（9/20 ≈ 45%）✓——粉色框长度现在与真实推进时间一致。

### 标尺刻度与标签对齐

去掉 `<i>` 刻度元素（`space-between` 5 项的分布在 0/25/50/75/100%），改为 `<span>` 兼做刻度+标签（`border-left` 做刻度线，`space-between` 布局对齐），标签计算也改为 `fromMs + span * index / 4`（匹配 0/25/50/75/100% 位置）。

验证：46% clip 宽度 ✓ / 标尺无 NaN 且均匀分布 ✓ / 34 runtime / renderer 语法全绿。

## 10.29 播放头溢出与边缘 clip 渲染修复（2026-09-09 十六轮）

### 播放头不再飘出视窗

- `timelineBounds` 的 `end` 至少延伸到 `Date.now() + 5min`（防 bounds 落后于现实时间导致 NOW 超过 100%）。
- 播放头 `left` 值 clamp 到 [0, 100]（不因数据边界落后而飘出右缘）。

### 边缘 clip 不再消失

**根因**：快照请求范围 = 视窗范围。开始时间在视窗外、但时间跨度延伸进视窗的剧本段被查询直接裁掉——部分可见的块完全消失。

**修法**：快照请求范围前后各扩 15%（总宽 130%），边缘条目包含进来后由 `projectTime` 的 [0,100] 钳位自然截断显示。

验证：2 个 clip 均在 [0, 100] 范围内 ✓ / 播放头 80.37%（视窗内）✓ / 34 runtime / renderer 语法全绿。

## 10.30 Studio 界面审计全量修复（R0+R1+R2，2026-09-09 十七轮）

依据 `2026-09-09-studio-ui-audit-and-repair-plan.md` 的 37 项问题清单，本批实施 R0（初始化闭环）+ R1（布局统一）+ R2（坐标统一）共 24 项。

### R0：初始化闭环（5 项）

- **UI-01**（P0）：删除 5 个已不存在按钮（arrange-zoom-out/in/left/right/now）的无条件绑定——之前首次执行即 TypeError 中断后续所有顶层代码（时钟、面板拖拽、事件订阅全部失效）。
- **UI-02**（P0）：`selectStory` 的布尔参数 `refreshSnapshot` 遮蔽同名函数，改为 `shouldFetchSnapshot`。
- **UI-03**（P1）：`setDetail` 已有 tab active 同步（核实无需改动）。
- **UI-17**（P0）：Shift 拖选的 Escape 取消——按下 Escape 时移除选区覆盖层并清空拖选状态。
- **UI-37**（P0）：所有 dialog 的 cancel 按钮加 `type="button"`（防止默认 submit 触发表单提交导致取消变保存）。

### R1：布局统一（7 项）

- **UI-06**：track 计数只按 6 个注册轨道（script/receive/send/alter/state/preplan）计算——旧的 `Object.values().filter(Boolean)` 会把历史遗留键也计入导致"8/6"。
- **UI-26**：`applyPanelLayout` 现在应用保存的自定义宽高（`layout.panelWidths/panelHeights`），并在末尾调用 `updatePanelRestoreStrips()`。
- **UI-27**：body 加 `overflow: hidden`、studio-shell 加 `min-width: 700px; min-height: 400px`。
- **UI-28**：恢复条 CSS 的 `display: none !important` 改为 `display: none`（让 `.visible` 类可以覆盖）。

### R2：坐标统一（12 项中的关键 6 项）

- **UI-16**：视窗安全边界从 now±30 天放宽到 now±365 天（不再把合法旧历史当坏值重置）。
- **UI-12**：followNow 的 NOW 超过 60% 视窗位置就平移（原 70% 太迟）。
- **UI-20**：`toMillis` 统一处理数字/字符串时间戳（数字直接返回，数字字符串 >1e12 视为毫秒时间戳，其余走 Date.parse）。
- **UI-21**：clip 先做区间与视窗的相交检测——完全窗外的返回 Comment 节点（不渲染），相交的计算裁剪后位置。
- **UI-31**：时区暂保持本地（变更风险大，列入 R3）。
- **UI-32**：切故事时主动 detach Console 嵌入。

### 验证

时钟工作 ✓（09-09 06:39:51）/ track 计数 6/6 ✓ / grid 3 列正确（214px 948px 264px）✓ / 34 runtime / renderer 语法全绿。

## 10.31 R3 批次：坐标统一、标尺步长、日志与 Mixer（2026-09-09 十八轮）

### UI-07 viewRange 统一

`timelineBounds` 不再从 `snapshot.range` 推导——改为始终从 `timelineViewport()` 取当前视窗。标尺、clip、NOW 播放头、拖拉条现在消费**同一帧**的时间范围。数据范围（snapshot.range）只说明已加载范围，不参与绘制坐标。

### UI-08 播放头去硬编码

NOW 播放头的 `left` 从 `calc(132px + (100% - 192px) * pct / 100)` 改为纯 `pct%` + CSS 变量 `--lane-offset`（默认 132px，窄屏 108px）。窄屏下标尺与播放头自动同步。

### UI-09 自适应时间步长标尺

标尺从固定 5 标签改为**按视窗跨度选择 1/2/5 系列步长**：≤15min→1min, ≤30→2, ≤60→5, ≤120→10, ≤360→30, ≤720→60, ≤1440→120, 其余→360min。跨天在午夜显示日期（M/D），≥60min 步长在整点显示 `HHh`。绝对定位（不再受文字宽度影响的 space-between 假等距）。实测 5 分钟步长 7 个刻度 ✓。

### UI-33 日志 ANSI 剥离

`appendLogItem` 入口统一 `\u001b[...m` → 空字符串。CDP 实测：原始存储保留 ANSI（数据完整性），DOM 显示层 0 条含 ANSI ✓。

### UI-34 日志增量追加

renderLogs 的增量分支从"只更新计数"改为**按 ID 差集追加新行**（新建 Fragment append 到 vlist）。

### UI-35 Mixer 按故事隔离草稿

`mixerState` 增加 `storyId` 字段；切故事时清 pending，同故事内读取不清（不丢编辑）。

验证：bounds 与 viewport 对齐 ✓ / 5 分钟步长标尺 7 刻度 ✓ / DOM 无 ANSI ✓ / 34 runtime / renderer 语法全绿。

## 10.32 R4 批次：多轨阅读与数据完整性（2026-09-09 十九轮，审计全量完成）

### UI-18 面积驱动预览

Script clip 预览字数从固定 80 字改为按 clip 宽度百分比自适应：`previewChars = max(20, min(200, floor(width% × 3)))`——宽块显示更多原文，窄块只显示标识。

### UI-19 推断区间标记

`inferredEnd` 的块加 `.inferred` 类：虚线右缘（`border-right: 2px dashed`）+ 渐变淡尾 + 时间行标注"→ 推断"。视觉区分"确认时段"与"写入后保持区间"。

### UI-22 同轨事件子行避让

`makeTrack` 内对非 script 轨道的事件按时间排序后分配 `__subRow`（0–2 循环）：重叠事件交替上下偏移 14px，不再互相覆盖。最多 3 层子行，超过则自然重叠。

### UI-23 快照范围扩至 30%

查询范围前后各扩 30%（原 15%），更长的时间跨度段不被查询边缘裁掉。

### UI-24 稳定选中

clip 的 selected 判断从对象引用比较改为 **entityId 字符串比较**——平移/刷新后选中状态不再因对象重建而丢失。

### UI-25 投递角标恢复

`deliveryBadge` 重新接入 script clip 渲染（之前定义了但 clip 模板里没调用），失败/待确认投递在主轨直接可见。

### UI-36 分支锚点重算

`openForkDialog` 的 entryId 在 fallback 之后才取值（之前 fallback 替换 block 但 entryId 还是旧值的 undefined）。

### 审计方案完成状态

历史批次自报：R0（5）+ R1（7）+ R2（6）+ R3（6）+ R4（7）= 31 项代码修复。2026-09-09 后续复核发现部分未闭环及回归，不再将此记录视为“37项全部完成”。当前修复与验证结果见 `2026-09-09-studio-ui-functional-fix-result.md`；遗留审计见 `2026-09-09-studio-ui-followup-audit.md`。

## 10.33 自动刷新与流畅度优化（2026-09-09 二十轮）

### 新剧本产生时界面自动刷新

**根因**：`onStoriesChanged → refresh()` 只更新故事列表，不调 `refreshSnapshot()`——时间线的新 clip 要等 30 秒定时器才出现。

**修法**（三层）：
1. **故事变化触发**：`onStoriesChanged` / `onStoryInbox` 后防抖 2 秒调 `refreshSnapshot()`
2. **日志关键词触发**：`onLogRecord` 中匹配"剧本已落库 / 模型调用完成 / 场景压缩完成 / 叙事完成"时防抖刷快照
3. **定时器加速**：30 秒 → 15 秒（更跟手，配合防抖不产生重复请求）

### 流畅度优化

**同 revision 不重建 DOM**：`renderArrangement` 记录 `lastRenderedSnapshotKey`（storyId + revision + browserView）。同 key 且轨道非空时只更新标尺和拖拉条，**跳过全量 replaceChildren**——定时器刷屏不再闪烁。

`refreshSnapshot` 完成后同样按 revision 差异决定是否调 `renderArrangement`——Inspector/Detail 始终刷新（轻量），轨道只在数据变化时重绘。

视图切换（Browser 面板点 Session/Mixer/Overview）时重置 key 强制重建。

### CSS 细节打磨

- clip 淡入动画（0.18s）、空状态左对齐+琥珀色条+标题
- 拖拉条窗口 `transition: left/width 0.08s` + `will-change` 提示 GPU
- Inspector 网格值长文字换行（`word-break: break-all`）
- Detail 空状态提示文字（`:empty::after`）

验证：同 key 跳过重建 ✓ / autoSnapshot 函数定义 ✓ / 34 runtime / renderer 语法全绿。

## 10.34 虚拟画布架构（DAW 式平滑滚动与缩放，2026-09-09 二十一轮）

### 架构转变

从"clip 按视窗百分比定位 + 每次视窗变化全量重建"转为"clip 绝对像素定位 + scrollLeft 滚动"：

| 层 | 之前 | 之后 |
|---|---|---|
| clip 位置 | `left: X%`（随视窗变化） | `left: Xpx`（画布绝对坐标，不随视窗变） |
| 轨道宽度 | 无固定宽度（弹性） | `width: totalMs × pxPerMs px`（画布总宽） |
| 滚动 | 全量重建 DOM | `scrollLeft = Xpx`（原生滚动，GPU） |
| 缩放 | 重建全部 clip | 改 `pxPerMs` → 批量更新 style |
| 数据 | 每次视窗变 90ms 防抖取数 | 手势结束 300ms 防抖取数 |
| 标尺 | 百分比定位 | 同一画布像素坐标 + scrollLeft 同步 |

### 核心改动

1. **画布状态** `canvas = { originMs, pxPerMs, scrollMs, totalMs }`——每帧渲染前由 `updateCanvasFromViewport()` 同步
2. **clip()** 改为 `timeToPx(start/end)` 输出绝对像素，附 `dataset.startMs/endMs`（供缩放时批量重算）
3. **track-lane** 宽度 = `canvas.totalMs × canvas.pxPerMs`（约 3 屏宽，前后各留缓冲）
4. **updateViewport** 拆为视觉层（即时 `scrollLeft` 赋值，零 IPC）+ 数据层（300ms 防抖取快照）
5. **标尺** 刻度用同一 `timeToPx()` 绝对像素；`arrangement` 的 scroll 事件通过 `marginLeft = -scrollLeft` 同步标尺
6. **NOW 播放头** 也在画布坐标内（`left = timeToPx(now)`），sticky 定位跟随滚动
7. **轨道头** `position: sticky; left: 0` 保持固定（横向滚动时轨道名不飘走）

### CSS

- `.arrangement` 加 `overflow-x: auto`（允许横向原生滚动）
- `.now-playhead` 改为 `position: sticky; display: inline-block`（画布内元素）

### 验证

lane 宽度 2448px ✓（像素坐标）/ 可横向滚动（scrollWidth > clientWidth）✓ / 34 runtime / renderer 语法全绿。

## 10.35 Ableton 式时间尺度旋钮（2026-09-09 二十二轮）

### 功能

工作区头部右侧（Refresh 按钮左边）新增 Ableton 风格时间尺度旋钮：

- **视觉**：Canvas 绘制的 270° 弧形旋钮（外弧背景灰色 + 值弧琥珀色 + 内圈 + 指针线），下方文字显示当前时间尺度（如 `14h`、`32min`、`5d`）
- **交互**（与 DAW 一致）：
  - **按住向上拖** = 缩短时间跨度（放大视图）
  - **按住向下拖** = 增长时间跨度（缩小视图）
  - **双击** = 重置到默认 14 小时 + 回 NOW
  - 悬停时标签变琥珀色，激活时光标变 grab
- **范围**：20 秒 → 30 天（对数刻度，覆盖从密集对话到长期生活观察）
- **灵敏度**：每 100px 垂直拖动 ≈ 对数域全程 40%（精细控制）

### 双向同步

- 旋钮拖动 → `updateViewport(spanMinutes)` → 时间轴/标尺/拖拉条实时响应
- 拖拉条/其它途径改变尺度 → `renderArrangementScale` → `updateKnobFromViewport()` → 旋钮角度和标签自动更新

### 格式化

跨度自动选择合适的单位：`<60s → Xs`、`<1h → Xmin`、`<24h → X.Xh`、`≥24h → Xd`

### 验证

CDP 实测：旋钮渲染 ✓、标签 `32min` → 缩放后 `16min` → 恢复 `32min` ✓（跟随视窗变化）、Canvas 元素存在 ✓、34 runtime / renderer 语法全绿。

## 10.36 Stats 视图、功能状态栏与 OSD（2026-09-09 二十三轮）

### Detail 收起后轨道扩展

`applyPanelLayout` 在 Detail 隐藏时把 Browser 的 `grid-row` 从 `1 / span 2` 改为 `1`——唯一一行 `1fr` 占满全部高度。实测：收起前 `583px + 174px`，收起后 `757px`（工作区获得完整高度）。

### Stats 视图（◫ Stats，Browser 面板新视图）

**指标卡片（6 张）**：
- **RPH 柱状图**（宽卡）：最近 24 小时每小时对话轮数，纯 CSS 柱状（无外部库），24 根柱子，hover 显示具体时间和轮数
- **平均剧本字数**：script 条目的 `content.length` 平均值
- **中位回复延迟**：user-message → 下一条 character-message/script 的 `occurredAt` 差值中位数（防离群值）
- **模型每次消费**：`estimatedCost / calls`（来自 UsageAggregator）
- **每日平均消费**：按天分组的 `estimatedCost` 平均值
- **功能状态栏**（宽卡）：5 个子系统信号灯

**功能状态灯**（绿/黄/红三态圆点 + 文字标签）：

| 子系统 | 绿 | 黄 | 红 |
|---|---|---|---|
| Worker | bridgeReady | — | bridgeReady=false |
| OneBot | bridge 在线 | — | 离线 |
| 模型 | 最近 5 次全成功 | 1-2 次失败 | ≥3 次失败 |
| 推进 | running + advance<90min | running + 超时 | 停止 |
| 收件箱 | pending=0 | 1-5 | >5 |

### 右下角 OSD（半透明常驻迷你面板）

固定在屏幕右下角（`position: fixed; z-index: 50`），半透明背景 + `backdrop-filter: blur(4px)`：
- **CPU**（近似值，基于活动密度）
- **MEM**（JS 堆使用率，`performance.memory`）
- **RPH**（最近 1 小时对话轮数）
- **DELAY**（最近回复延迟）
- **迷你折线图**（Canvas 120×24px，CPU 趋势最近 60 个采样点，每 3 秒更新）

### 验证

Stats 视图 6 卡片 ✓ / RPH 24 柱 ✓ / 状态灯 5 个 ✓ / OSD 可见 ✓ / Detail 收起后轨道 757px（全高）✓ / 34 runtime / renderer 语法全绿。

## 10.37 分支批次 4：游标回滚 + 右键菜单补全（2026-09-09 二十四轮）

### HDSI beta16 新增

1. **`cursor-set` bridge 命令**：桌面可设置叙事游标（`service.setDesktopCursorAt`，串行队列内执行），用于分支截断后回拨 cursorAt 到 forkPoint。
2. **墓碑过滤**：`recentEntries`（prompt 路径）与 timeline-range 投影均过滤 `kind='redacted'`——purge fallback 软删条目不再漏进模型上下文和桌面时间线。
3. **purge 后自动回拨 cursorAt**：`purgeStoryRange` 末尾将 `cursorAt` 设为范围起点——分支截断后叙事时钟从 forkPoint 重新推进。
4. 283 项回归 + 严格类型检查全绿。beta16 已安装到 typ-0。

### typ-0 forkBranch 截断流程

`stories:forkBranch` IPC handler 在整库复制后自动执行：
1. 加载分支 worker → 等 bridge-ready（30s 超时）
2. `purgeRange(forkPoint.occurredAt + 1ms → 未来)`——HDSI 级联截断 8 表 + preplan 失效 + continuity 重建
3. `cursorSet(forkPoint.occurredAt)`——回拨叙事游标
4. 卸载 worker → 分支 paused 就绪

截断失败不阻塞：分支仍可用（含完整数据），日志提示"可能包含 forkPoint 之后的数据"。

`StoryManager.requestCursorSet` 新增（`cursor-set` bridge 命令 → `cursor-set-result` 确认）。

### 右键菜单补全

| 右键对象 | 菜单项 |
|---|---|
| 轨道头 | 检查全部（前 3 项）/ 复制全部文本 / 隐藏·显示此轨道 |
| 轨道空白区域 | 回到 NOW / 刷新时间线 / 重置缩放 |
| 标尺 | 回到 NOW / 重置缩放 / 当前视窗信息（disabled） |
| 拖拉条 | 回到 NOW / 重置缩放 / 刷新数据 |

加上之前的 clip / Session 卡 / 故事条右键，全部 UI 元素均有右键菜单覆盖。

### 验证

HDSI 283 全绿 ✓ / typ-0 34 全绿 ✓ / e2e 通过 ✓ / 轨道头右键 3 项 ✓ / 拖拉条右键 3 项 ✓。

## 10.38 Mixer 分板块重设计（2026-09-09 二十五轮）

### 架构

从 6 个推子扩展为 **6 板块 × 45 参数**，与 HDSI Console 配置段对齐：

| 板块 | 参数数 | 控件类型 |
|---|---|---|
| MODEL | 6 | 推子×4 + 下拉×1 + 开关×1 |
| TEMPO | 14 | 推子×9 + 开关×3 + 下拉×1 |
| MEMORY | 11 | 推子×7 + 开关×3 |
| CHANNEL | 4 | 推子×1 + 开关×3 |
| LOG | 3 | 下拉×2 + 推子×1 |
| ADVANCED | 7 | 开关×5 + 推子×2 |

### 新增控件类型

- **开关（toggle）**：Ableton 式方形 LED（绿=ON / 灰=OFF），点击切换
- **下拉（select）**：紧凑 select，Consolas 等宽，琥珀色文字
- **推子（knob）**：竖向滑条 + 数值窗（沿用）

### 重点色标注（hot）

调试高频参数用琥珀色边框 + 暗金背景 + 标签文字变金色标识：Temperature、Response Format、Auto Advance、Advance Interval、Typing Speed、Max Msg Chars、Urge Engine、Memory System、Log Level——共 9 个 P0 级参数。

### ⓘ 信息标

每个参数标签后有 ⓘ 圆形按钮，点击弹出描述气泡（260px），显示参数的中文说明（做什么、推荐值、注意事项）。点击外部自动关闭。

### mixerRead / mixerWrite 扩展

- `mixerRead` 返回完整元数据：`{ key, section, label, desc, hot, type, min, max, step, options, value }`
- `mixerWrite` 按 type 分支：knob 走范围校验+step 量化；toggle/select/text 直接写入
- 写入后显示 `已写入 N 项 · 需重载 Worker 生效`

### 参数描述完整覆盖

45 个参数每个都有中文描述（从 HDSI Console Schema 的 description 翻译/改写），说明该参数控制什么、默认值含义、调整影响。

验证：mixerRead API 返回 45 参数 / 6 板块 / 15 toggle / 3+ select / 9 hot / desc 全覆盖 ✓；TEMPO 板块 14 参数 + 3 toggle ✓；ADVANCED 板块 7 参数 ✓；34 runtime / renderer 语法全绿。

## 10.39 Configure 对话框分 Tab 结构化配置（2026-09-09 二十六轮）

### 问题

桌面端此前 storyDefaults（人设/世界/文风 10 字段）、onebot 三张白名单表（userAccounts / groupChats / botAccounts）、模型提供商（providers）完全没有 UI——只能通过 Configure 的纯 YAML 文本编辑器手改。Mixer 45 参数只覆盖标量，表格型配置装不进。

### 架构

**主进程新增 `stories:configSection` IPC**：按配置节（storyDefaults / userAccounts / groupChats / botAccounts / providers）做结构化局部读写——解析 yml → 只覆写指定子树 → dump → ConfigMediator 保存（自动备份）。不碰 `$secret` 段。

### Configure 对话框 7 Tab 布局

| Tab | 内容 | 控件 |
| --- | --- | --- |
| **人设与故事** | characterName / location / timezone 短文本 + characterProfile / world / supportingCast / style / perspective / userProfile / relationship 七个长文本 | 3 短行 + 7 个 textarea |
| **用户白名单** | QQ 号 / 称呼 / 人物ID / 启用开关 + 展开→ profile / relationship 长文本 | 折叠卡片列表 |
| **群聊管理** | 群号 / 名称 / 回复模式(select) / 上下文 / 冷却 / 启用 + 展开→ 群用途 / 主角角色 / 意愿门 4 滑条 | 折叠卡片 + 嵌套子面板 |
| **机器人** | QQ 号 / 备注 / 启用 | 简易三列卡片 |
| **模型提供商** | ID / 模式(select 9 项) / 模型名 / 端点 + 展开→ API Key / 温度 / Top P / Max Tokens / 超时 / 5 个用途 checkbox | 折叠卡片 |
| **密钥库** | 别名 + 值 → Android Keystore（沿用） | 现有 |
| **YAML** | koishi.yml 原文（高级模式保留） | 现有 |

### 交互

- Tab 切换即时切换面板（Consolas 等宽 tab 按钮，Ableton 下划线高亮）
- 每个表格 Tab 有 "+ 添加" 按钮（新行插入列表顶部）
- 卡片右侧 "删" 按钮（红色，删除该行）
- 用户/群聊卡片有 "▸ 详细" 展开（profile / relationship / 意愿门）
- mini toggle 开关（圆形 LED，绿=启用 / 灰=禁用）
- "保存" 按钮一次性写入全部配置节（storyDefaults + 4 张表 + YAML），逐节调 configSection IPC

### 验证

CDP 实测：7 个 Tab 渲染 ✓ / 人设 Tab 10 个字段（characterName 已填"水濑"）✓ / 模型提供商 1 张卡片（primary）✓ / 用户白名单 0 条（空白名单提示）✓ / 34 runtime / renderer 语法全绿。

# typ-0 桌面端工程审查与优化建议

- 审查日期：2026-10-17
- 范围：`C:\dev\HDSI-desktop-typ-0\desktop` 与 `C:\dev\HDS-Interlude\plugins\hds-interlude`
- 目的：评估 typ-0 当前工程，重点关注 Electron/Koishi/HDSI 前后端协作、进程边界、人机交互及后续优化顺序。
- 本次仅审查并新增本文档；**没有修改应用代码，也没有运行会覆盖构建产物的构建/测试命令**。

## 1. 总体判断

typ-0 已经不只是“Electron 套壳”：主进程承担多剧本 worker 生命周期、配置编译与密钥注入、OneBot/外部连接、投递账本、日志、备份、插件管理和 Console 嵌入；渲染层则有时间线、配置、Mixer、连接/账号、日志等完整工作区。项目中也已经有不少正确的边界设计，例如主窗口启用 `contextIsolation`、关闭 `nodeIntegration`、启用 sandbox；preload 只暴露按域组织的能力；HDSI 桌面桥有协议号/能力协商；剧本数据以 HDSI worker 的只读投影进入宿主；配置保存有密钥别名检查和备份。

现阶段的主要风险不是缺少功能，而是**复杂度增长快于契约与交互的一致性治理**：关键入口仍集中在两个超大文件；桌面与 HDSI 的同一数据/命令经过 worker 消息、主进程 service、IPC、preload、Renderer 多跳；HDSI 桥已版本化，但桌面消费能力的统一边界和兼容验证还不够显式；用户同时面对宿主自有控制台与 Koishi Console 两套操作面；配置保存、worker 重载、账号绑定等高影响动作的状态反馈需要形成一致流程。

建议策略：先收紧版本/契约和操作状态，再改善用户路径，最后分阶段拆分模块；不建议先做大规模视觉翻新或重写。

## 2. 重点发现（按优先级）

### P1 — 桌面打包依赖指向 HDSI rc55，而同目录源码/release 已到 rc56

`desktop/package.json` 的 `koishi-plugin-hds-interlude` 指向本地 `release/koishi-plugin-hds-interlude-1.0.1-rc55.tgz`；审查时 HDSI 工程 `package.json` 已是 `1.0.1-rc56`，且 `release` 下有 rc56 包（2026-10-16 21:43）。这会导致桌面当前安装/锁定的 HDSI 与开发者正在检查的源码不是同一版本，bridge 协议、投影字段、修复和 UI 所见状态可能发生偏差。

**建议**：引入唯一的桌面依赖更新流程（打包前生成/校验本地 tgz、更新锁文件、比对 tgz 内 manifest 与源码版本）；启动诊断页显示 HDSI 包版本、bridge protocol、能力集和构建来源；在 CI 或发布脚本中拒绝“依赖版本低于预期/依赖包与工作区不一致”。不要只依赖开发者手工改 `file:` 路径。

### P1 — HDSI 桥有协议协商，但边界的可诊断性和兼容测试仍需产品化

HDSI `/src/desktop-bridge.ts` 已声明 API version 1、protocol 4 和 capability 列表，并使用 requestId/回执；桌面 `main.ts` 收到 `bridge-ready` 后主要记录 protocol/capabilities 日志。`story-repository.ts` 也提供了 timeline projection normalizer。这是很好的基础，但协议差异若只在日志中，用户会看到“加载了但某些面板为空/不可用”，难以分辨版本不兼容、能力缺失、请求超时还是数据为空。

**建议**：建立显式的 `BridgeSession`/能力门控状态：协商成功、协商失败、缺少必需能力、可选能力降级、请求超时/worker 重启都成为可查询状态；每个桌面功能声明必需 capability，UI 根据能力禁用并说明原因；为 protocol 旧版/新版和能力子集建立合同测试。统一 requestId、storyId、worker revision 与 traceId 的结构化关联，避免只靠自由文本日志排查。

### P1 — 跨层数据契约在多处重复，易产生静默语义漂移

典型链路为 HDSI `desktop-bridge.ts` → desktop worker/message router/runtime → `stories:*` IPC → preload `hdsiDesktop` → `app.js`。同类数据类型分别出现在 HDSI `DesktopInboundEvent` / `DesktopDelivery`、桌面 `runtime/contracts.ts`、主进程 handler 入参和 preload API 中；preload 有不少 `unknown`/宽泛返回值。桌面确实做了 worker 投影归一化，但并非所有 UI 能力都从一个有版本的 DTO 边界消费。

**建议**：将宿主与 HDSI 之间真正共享的传输 DTO/错误码/能力名整理成独立版本化契约（可先用 schema + 生成类型/测试，不必马上抽 npm 包）；IPC 层另设 DTO，禁止把 worker 原始对象直接透传到 renderer；每个 DTO 明确字段、大小上限、日期格式、可选字段语义、兼容策略。新字段必须有 fixture/合同测试覆盖“缺字段、旧版本、畸形值、超大列表”。

### P1 — 高影响操作缺少统一的“提交事务”交互模型

桌面存在配置编辑、插件启停/安装/卸载、账号绑定/解绑、剧本加载/卸载/删除、数据区间清理、Console 切换等多种不同影响面的动作。配置媒介 `config-mediator.ts` 有备份、临时文件 rename 与密钥校验；`main.ts` 中配置保存还涉及 worker reload/失败回滚。各页面若自行实现 loading/错误/确认，很容易出现“按钮已点但不知道是否生效”“失败后草稿被覆盖”“重复点击产生并发操作”等体验差异。

**建议**：所有有副作用操作统一采用 `idle → validating → applying → verifying → success/partial/failure` 状态；按钮执行时防重复提交；失败保留用户草稿并明确当前运行态是否仍为旧配置；成功显示版本/时间与可恢复备份入口；删除、清理、解绑等确认框说明**具体对象、影响、可逆性、是否会停止收发、是否会删除历史**。对超时但结果未知的操作明确标为“结果待核实”，不要误报成功或诱导立即重试。

### P1 — 双操作面（typ-0 原生 UI + 嵌入式 Koishi Console）需要明确职责与上下文

`console-embed.ts` 将每故事 Console 放进隔离 BrowserView，这保留了 Koishi 插件生态控制台，是合理的兼容策略；同时 typ-0 自己又提供配置、插件、账号、日志和运行状态功能。若用户不清楚哪些页面是权威设置入口，可能在 Console 修改运行配置、在 typ-0 改 canonical 配置，之后又被配置捕获/worker 重载覆盖。隔离的 Console 导航白名单是正向安全设计，但 Console 的“同一故事/当前 worker revision/是否已失效”也应对用户可见。

**建议**：给每类对象定义唯一权威编辑面。typ-0 管理故事生命周期、账号绑定、敏感值、备份和 HDSI 专属功能；Koishi Console 用于必须依赖 Koishi schema/插件生态的配置，并明确保存将如何同步到 canonical YAML。页面顶部始终显示故事名、worker 在线状态、配置来源/最后同步时间；Console 被 worker 重启撤销时显示可恢复提示，而不是只表现为嵌入内容消失或挂起。

### P2 — 主进程与 Renderer 入口文件过大，导致改动耦合与 UI 回归成本上升

`src/main/main.ts` 约 123 KB，包含窗口、初始化、IPC 注册、story 生命周期、账号、Console、日志等；`src/renderer/app.js` 约 359 KB，`index.html` 约 49 KB。尽管 main 已有许多 `runtime/*` 模块，入口仍承载大量业务 handler；Renderer 将页面、状态、事件绑定、DOM 模板与定时刷新混在单文件。该体量会降低代码审阅效率、提高跨功能 CSS/事件副作用概率，并让自动化测试难以定位失败。

**建议**：采用增量拆分，不做一次性重写。

1. 主进程：按 `stories / accounts / plugins / logs / console / connection / settings` 拆 IPC handler；统一依赖注入和 handler 注册表。
2. Renderer：先按用户工作流拆 `connect / studio / config / logs / dialogs`，其次抽 API client、store/selectors、组件模板和表单校验。
3. 每次拆分保持 HTML/API 行为不变，先补 characterization tests，再迁移一个域。
4. 定义 renderer 目录的模块边界，避免用全局变量互相读写；状态变化通过明确 action/store 订阅传播。

### P2 — IPC 输入边界的校验和结果类型可以更统一

preload 已经避免暴露裸 `ipcRenderer`，这是正确方向；但公开 API 参数和返回值存在 `unknown`/弱类型，main handlers 有的对字符串做 `String(...)` 转换、有的接受对象后局部处理。随功能增长，这种不一致容易出现非法 ID、范围参数、超大对象、重复提交和 renderer/main 对错误结构理解不一致的问题。此处是治理建议，不代表审查已确认存在可利用漏洞。

**建议**：为 IPC 建立单一 schema/注册层：严格验证 storyId、日期范围、分页上限、字符串长度、枚举、嵌套对象；校验调用来自主窗口 renderer（拒绝非预期 frame/webContents）；统一返回 `{ ok, data } | { ok: false, error: { code, message, retryable, details? } }`。preload 类型由该 schema 导出，Renderer 不再猜测异常字符串。Console BrowserView 不应获得宿主 API 权限，继续维持当前隔离。

### P2 — 时间线、日志等高频界面需有明确的请求竞态和刷新负载策略

Renderer 有自动快照/视口刷新、投影刷新、防抖和日志分页等机制，说明性能问题已被关注；但实时数据 UI 的关键风险是旧请求晚返回覆盖新故事/新时间范围，worker 重启前后的响应混入，以及多个面板重复轮询。日志、timeline、overview、usage、delivery 的请求应有可测量的刷新策略。

**建议**：所有异步读取携带 `storyId + workerRevision + requestSequence`，仅接受当前序列结果；故事切换/worker 重启时取消旧请求或丢弃迟到响应；同一投影请求做 single-flight/共享缓存；后台标签页降低刷新频率；列表采用游标分页和增量更新。开发诊断中记录 API 耗时、结果条数、缓存命中、过期响应丢弃数，并对 1 万条时间线/高频日志做性能测试。

### P2 — 界面信息架构偏“功能齐全”，新手主路径仍应围绕任务完成重排

连接/账号、故事工作台、Mixer、配置、插件、日志、主题、Console 都是不同心智模型。typ-0 的价值主线应是“准备模型与通道 → 创建/绑定故事 → 验证可运行 → 观察投递与叙事”。如果导航主要按工程模块组织，新用户会在插件配置、账户连接和故事工作台之间来回猜。

**建议**：把首页做成“运行总览 + 下一步”而非单纯数据仪表盘：每个故事显示阶段、账号/端点连通、模型就绪、bridge 能力、最近入站/出站与待处理告警；给一个有序的首次运行向导，完成后可跳过；将“健康、需要处理、已停止”同时用文字与图标表达，不只用颜色；危险操作和普通导航视觉分层。保留高级配置入口，不要让向导遮蔽专业用户的快速路径。

### P2 — UI 自动化覆盖偏向 Renderer fixture，尚未形成跨进程关键路径回归

现有脚本包括 runtime、timeline、UI、theme、connect、button 等测试，且 UI fixture 会检查 Studio/Mixer 的一些交互；这很有价值。但仅靠 mock `window.hdsiDesktop` 的渲染测试无法验证打包依赖、IPC、worker bridge 协商、真实 Console/worker 重启、safeStorage、Windows 文件锁/原子替换和关闭排空等组合行为。

**建议**：在现有轻量测试上补最小 Electron 集成冒烟：启动隔离临时 userData → 启动一个 fixture worker/HDSI bridge → 查询 snapshot → 切换 phase → 模拟一次入站/回执 → worker 重启/崩溃 → 确认 UI 状态恢复 → 正常关闭并检查无遗留 worker。另设打包冒烟校验内置 HDSI 版本、资源路径和数据目录写入位置。用 mock bridge 故障注入超时、断连、旧 protocol、缺少 capability。

### P3 — 锁文件和依赖来源应减少歧义

`desktop` 同时有 `package-lock.json` 和 `yarn.lock`，而 `package.json` 通过本地 tgz 引用另一个工程。双锁文件容易让开发、CI、发行包解析不同依赖树；本地相对路径在不同机器/CI 的可复现性也需要验证。

**建议**：确定唯一包管理器并只维护一个锁文件；将 HDSI 包作为显式发布输入（CI 产物/固定校验和），在 CI 中从干净 checkout 安装并打包。记录 Node/Electron ABI、Windows/macOS 目标和插件 runtime 的安装/忽略脚本策略。

## 3. 人机交互建议：优先设计的五个状态面

1. **故事卡片**：运行阶段、绑定账号、模型就绪、bridge 状态、最近一次入站/出站、未处理错误；点击告警直接定位处理面板。
2. **连接与账号**：把“检测到进程”“WebUI 可访问”“账号在线”“OneBot 端点可收发”分成不同事实，不用一个绿色“已连接”掩盖层级差异；测试连接给出步骤和失败原因。
3. **配置中心**：明确草稿/已保存/正在应用/运行中版本；保存前展示变更摘要，保存后展示 reload 结果和回滚入口；敏感字段只展示别名/是否已保存。
4. **时间线与投递**：区分“模型生成”“已交给上游”“平台已确认”“结果未知”；允许从时间线跳到对应 trace/processing/delivery 详情，提供复制诊断信息但默认脱敏。
5. **插件与 Console**：插件卡片展示来源、版本、启用状态、与桌面托管的冲突风险和重载影响；Console 显示当前故事与 worker revision，失效时提供重新打开。

所有异步操作建议统一使用轻量 toast + 持久页面状态：toast 负责即时反馈，页面状态负责用户切走再回来仍能知道任务结果。表单应支持键盘操作、明确焦点、错误就地展示、保存期间防重复提交，并测试窄窗口与系统缩放。

## 4. 推荐实施顺序

### 阶段 A：正确性与可观测性（先做）

- 对齐桌面 HDSI 依赖与源码版本；锁文件由单一流程更新。
- 增加启动诊断页：desktop build、HDSI version、bridge protocol/capabilities、worker revision、数据目录、连接器状态。
- 定义 IPC/bridge 错误码与 capability gate；给主要命令补超时和操作关联 ID。
- 明确配置提交/回滚、未知投递、解绑和清理的交互结果语义。

### 阶段 B：关键用户旅程

- 做“首次运行 → 创建故事 → 配置模型 → 连接账号 → 测试入站/出站 → 观察 timeline”的端到端验收清单。
- 为配置保存、插件变更、绑定/解绑、worker 重启补状态与失败恢复 UI。
- 添加真实 Electron + fixture worker 的最小集成测试和故障注入。

### 阶段 C：模块化与体验收敛

- 先拆 IPC handlers 和 Renderer API client，再按页面域拆 Renderer。
- 建立统一组件：状态徽标、异步按钮、危险操作确认、错误详情、空态/加载态/离线态。
- 做键盘/可访问性与 100%/125%/150% 缩放、窗口窄宽度人工验收。
- 对大时间线、日志和多剧本并发建立性能预算。

## 5. 建议的验收指标

- 从点击“保存配置”到明确显示“已应用/失败并回滚”始终有状态；不存在静默失败。
- 任一运行状态均能区分：桌面 worker、HDSI bridge、账号连接、上游投递，不以单一“在线”字段代替。
- 渲染层迟到请求不能覆盖新故事/新 worker 的状态；测试可稳定复现该断言。
- HDSI 升版时，协议、能力和关键 timeline/delivery DTO 合同测试自动运行。
- 删除/解绑/清理等操作在确认前说清影响；“结果未知”不自动重试。
- 干净环境安装和打包得到唯一、可追溯的 HDSI 版本与依赖树。
- 首次运行用户无需打开 YAML/Koishi Console，即可完成最小收发闭环；高级用户仍可访问完整 Koishi 配置能力。

## 6. 审查边界

这是对当前源码结构和文档的静态审查，不等同于真实用户可用性测试、渗透测试或打包运行验收。审查时没有运行完整测试套件，也没有证明上述风险在每条代码路径都已触发；尤其关于异步竞态、IPC 拒绝策略和实际 UI 层级，建议在阶段 A/B 通过定向代码追踪和 Electron 集成测试确认后再排期。本文中的优先级表示建议处理顺序，而不是已经确认的缺陷严重度。

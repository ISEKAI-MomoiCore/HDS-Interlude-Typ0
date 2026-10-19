# Artifact Provenance — typ0 0.0.1-m4

> 唯一构建来源：`C:\dev\HDS-Interlude\plugins\hds-interlude`（插件主仓库）。
> `hdsi-sourcecode/` 是过期快照（0.1.5-beta1），已废弃，禁止作为构建或审计依据。

## 当前锁定 artifact

| 字段 | 值 |
|---|---|
| plugin package | `koishi-plugin-hds-interlude` |
| plugin version | `1.0.1-rc57` |
| 本地构建标识 | `rc57`（rc55 + rc56 全量静态审查修复批：群超时/动作 ambiguous→pending 语义、Console 配置面审计重排、SHARE_SECTIONS 补 weather；rc57：Overlay 单场景演化修复（issue #8）、presetSync 前置 Console 首位、默认值基线对齐） |
| package 文件 | `desktop/vendor/koishi-plugin-hds-interlude-1.0.1-rc57.tgz`（自 0.0.1-m4 起随仓库自带；同目录附 .sha256。上源为插件主仓库 `plugins/hds-interlude/release/`，内容哈希一致） |
| package SHA256 | `4dc868cf2bb892e425ba9eb65bf917eaab05af9fb835abd21d00ab2d9c7e8dff`（与 release/ 附带 .sha256 一致） |
| bundle SHA256（package/lib/index.js） | `d4d4e9c8a93aab0edc84361d6fd6474a12b8bdf122c23a47254541d2fe3e6842` |
| 桌面安装位置校验 | `desktop/node_modules/koishi-plugin-hds-interlude/lib/index.js` 哈希一致（2026-10-18 验证；npm 安装） |
| src 树指纹（src/**/*.ts 排序哈希） | `4a90ba926410b19e6d6d1a622b107d06f56c1c3388eac76594cc7878dc471708`（方法：`find src -name '*.ts' | sort | xargs sha256sum | sha256sum`） |
| plugin package.json SHA256 | `81593421ca60f435dc2ebb125fdea1342edc97c1284325cf5099cd156974e475` |
| desktop version | `0.0.1-m4`（自 m4 起托管于 github.com/ISEKAI-MomoiCore/HDS-Interlude-Typ0） |
| build timestamp | 2026-10-17（tgz）；桌面安装与适配 2026-10-18 |
| node | v24.19.0 |
| electron | ^33.0.0 |

> rc57 同步适配说明（2026-10-18，rc55→rc57）：桥接协议无版本变化（rc56 的群超时 `transport-timeout:` 前缀与贴纸/表情 ambiguous→pending 均为插件侧记账语义，消费的正是宿主自 rc53 起输出的 `ambiguous: true` 契约，桌面无需改动）。桌面侧本轮改动三处：①Mixer「费用优先」预设重标定到 rc57 默认基线（均衡档原写 `ctxWindow:45/recentEntryLimit:35` 自称"默认参数"，rc57 真实默认为 6/30——不修则一键"均衡"反把上下文窗口抬高 7.5 倍；现改 3/6/45 三档）；②mixer 参数描述同步（Context Entries"默认 35"→17、Max Msg Chars/Max Script Chars 补新默认 1500/1400、特化档位去掉 rc12 历史坐标）+ 新增「合约自动裁剪」开关（rc57 新键 `model.specializationAutoTrim`，默认开）；③依赖与哈希链更新（package.json → rc57.tgz，node_modules bundle 哈希 = tgz 内 bundle 哈希 = `d4d4e9c8…`）。rc56 的 Console 配置面重排（presetSync 前置、weather 移位重编号、假旋钮 hidden）与 rc57 默认值变化经内嵌 Console/继承语义自动生效，桌面无感；`presetSync` 分区不做桌面结构化 UI（沿用 m2 惯例，经 Console 编辑）。

> m4 适配说明（2026-10-19）：插件 artifact 仍锁定 rc57（双哈希不变）。桌面侧 m4 为主题系统、迁移与可用性批次：主题包作者指南 + JSON Schema（theme.schema.v3.json）+ 结构化诊断 + 导入预览与失败包可视化；「从 koishi.yml 导入 HDSI 配置」向导（模块选择/密钥迁移/账号转移与 Idle 标记/旧版 useForMain 自动修复）；就绪检查 needs-reload 改为真正的 unload+load 重载并新增运行相位检查；window.prompt 全量替换为宿主输入对话框（Electron 渲染层不渲染原生 prompt）；NOW 播放头几何 ResizeObserver 重测；账号卡网格 min-width 稳定化；诊断日志等级下拉化；时间尺度旋钮方向修正。仓库化：插件 tgz 入 `desktop/vendor/`（package.json 改 `file:./vendor/...`），AGPL-3.0 LICENSE 与 README 建立，文档归档 docs/design 与 docs/history。

> m3 适配说明（2026-10-15，全量代码审查批次）：四路并行审查（主进程/支撑模块/渲染层/rc52 冲突面）共 60 项发现，逐条核实后修复桌面侧 20+ 项与插件侧 1 项协议缺陷（即 rc53 的内容）。桌面侧要点：stories.list 损坏 story.json 不再令启动无窗口；worker 退出身份守卫 + per-child killed 标记（迟到的 exit 不误报 crash/不误删新 worker 登记）；replayInbox 按故事串行化（并发整批双发）；Blind 模式掩码补 story:log 第二通道；桥接 token 读写失败显式告警（不再静默零鉴权）；桥服务端 await 启动 + 关停时显式 stop；unassigned 收件箱 5000 条上限；outbox/inbox 账本滚动裁剪（未结记录保留）+ 损坏文件隔离（不再静默清史重写）；account-registry 原子写 + 损坏隔离；config-compiler token 探测限定 adapter 块内 + 缩进无关检测（防重复键崩溃）；mediator 敏感键变体表扩展；主题包流式解压（zip 炸弹防护 + 条目数上限）；渲染层：accountKindLabel 未定义（绑定账号的连接页崩溃）、action-registry 字符串 confirm 保留、willingness 合并保留子字段 + willingnessPreset 档位选择（rc52 数值门仅 custom 生效）、配置节加载失败不再跨故事误写、数字输入非法值不再静默落 0、步骤卡/账号面板转义与迟到响应守卫、语义分析面板文案纠正；buildSendPayload 支持 replyTo → OneBot `[reply,id=]` 段并剥离 `<quote/>` 序列化标记（QQ 回复引用恢复）；mixer 补 Agency Window 总开关（rc50 起插件默认关）、Audio Understanding 旋钮改接 model.audio；故事模板 mainResponseFormat/vision 落到实际生效位置。

> m2 适配说明（2026-10-15）：rc52 的 bridge protocol 仍为 4（协商不变）；桌面配置节写边界（configSection / mediator / Console 捕获）全部 schema 无关，未知字段经 `{...loaded}` 展开在保存往返中保留。本轮桌面侧适配两处配置面：providers 模式下拉补 `gemini-interactions`（此前 UI 保存会把该模式静默改写为 openai-compatible——rc37 起即存在）；群编辑器补 `assignee`（rc50 跟进新增的群受理人字段，留空 = Koishi 原生路由）。rc52 新增的 `urge.advanced.*`、`compaction.sideTaskMaxTokens`、`weather` 等配置节经 Studio YAML 面板或 Console 编辑，不做结构化 UI。

> 溯源备注（2026-10-04）：`release-local/` 已并入 `release/`（单目录）。rc33 定名时 src 树指纹相对 `-4` 有变化（`11dd721f…` → `c8c3112b…`），但 emitted bundle 与 `-4` 仅差 `HDS_INTERLUDE_VERSION` 常量一行——源码 delta 为类型/注释级（或未引用文件），无行为差异。

## 本构建相对 rc32+local.20261003（首包）的源码差异

- `src/service.ts`：`persistDecision` 尾部的 `void this.longHorizonSweep(...)` 增加 `.catch`（P0-6，防 unhandledRejection）；构造期长线指导预加载空 catch 补 debug 日志。
- P1-1 投递幂等：`desktopDeliveryHandler` 增加 `intentKey`（scriptEvent.eventId + bubbleIndex），重试间稳定，宿主 outbox 跨 deliveryId 去重。
- P1-2 qzone 一致性：被评论感知改为逐条提交（先基线后条目、预算外 delta 不推进基线、保留非增量帖基线初始化）；好友动态改为先落账本再写条目；三处静默 catch 补日志。
- P1-3 原生表情：桌面模式改走宿主动作代理（`[CQ:face,id=N]` + auto_escape=false），不再访问合成 session 不存在的 `session.bot`。
- P1-4 目标 ID：`onebotTargetId()`——纯数字串转 number，其余（wxid/@chatroom）原样传 string，杜绝 NaN 直发上游。
- `src/desktop-bridge.ts`：dispose 分支在途动作改按 `ambiguous: true` 保守结算（P1-5）。
- P2-4 关键失败升 error：主叙事失败（私聊/群聊）、消息投递失败（私聊/群聊）、SQLite 连续失败、后台推进/整理失败；"主剧本归档完成/账号自愈"Puppeteer 提示等正向/重复事件归位 info/单次。
- P2-5 日志隐私：summary 级入站消息行 QQ 号尾 4 位脱敏（`maskQqIds`）；无回复 interaction JSON 预览纳入 `logScriptPreview` 门控；token 用量行并入 standard verbosity。
- P2-7 合并转发：整体失败带回原因、嵌套失败计数（`nestedFailed`），调用方记 warn。

## 再构建流程（保持溯源）

```bash
cd C:\dev\HDS-Interlude && npx yakumo build          # prepack 校验 bundle 新鲜度
cd plugins\hds-interlude && npm pack --pack-destination .
mv koishi-plugin-hds-interlude-<version>.tgz release/<新构建标识>.tgz
# 更新 desktop/package.json 依赖文件名 → npm install → 校验 node_modules 内 bundle 哈希
# → 桌面侧 npm run test:bridge 必须通过（桥合同：能力面/协议号变化先更新
#   bridge-session.test.ts 的 HISTORICAL_FIXTURES 与 BRIDGE_PROTOCOL.md §2/§3）
# → 桌面全量测试套件 → 更新本表
```

> P1 桥可诊断性批次（2026-10-18，随 rc57 同步实施）：协商结果从日志行升级为可查询状态机（`desktop/src/main/runtime/bridge-session.ts`：ready/degraded/stale/failed/closed + 协议过旧/过新分类），worker 退出时在途桥请求按 `bridge-worker-exited` 立即结算（不再幽灵超时），状态栏新增桥会话 chip（降级时 tooltip 列受限功能与降级路径），时间线兼容快照模式显性化（detail-status 常驻"兼容快照"标记），每次桥请求终态落 `[bridge] trace` 结构化行（requestId/traceId 经 log-broker correlation 可串全链）。协议版本纪律与帧清单见根目录 `BRIDGE_PROTOCOL.md`；合同测试 `npm run test:bridge`（fixture 取自 beta10/rc25/rc33/rc48/rc57 真实发布包）。
>
> P1 IPC 投影收口批次（2026-10-18，保守 scope）：最后三条 worker→renderer 裸透传路径改显式 DTO 投影（`desktop/src/main/runtime/worker-projections.ts`）——`runtime-snapshot`→`story:runtime`（白名单+stories≤20）、`token`→`story:token` 与 UsageAggregator 单一边界两处消费（token≤1e12/单价≤1e6/负数 NaN 丢弃）、`semanticAnalysis` 序列化安全边界（≤2MB 深拷贝）。行为等价：已知字段透传、畸形值降级、未知字段丢弃，投影永不抛错（analysis 序列化边界除外）。合同测试并入 `npm run test:bridge`（畸形/超大/缺字段矩阵，12 项）。刻意不做：共享 npm 包（违背 tgz 哈希锁定纪律）、schema 代码生成、preload 类型化（app.js 无类型 JS，运行时无效果）。
>
> P1 副作用操作交互公约批次（2026-10-18，保守 scope）：现有确认框五要素/防重复提交/草稿保留/needsReload 措辞已达标（解绑文案为范本），本轮只补两件事——①`UI_ACTION_CONVENTION.md` 把既有纪律形式化为五条检查单（防未来漂移，非新框架；统一状态机明确不做及理由在档）；②"结果待核实"语义落地：桥请求超时类型化为 `BridgeRequestTimeoutError`（消息保留"确认超时"字样——message-router 的 /超时/ 分类依赖），选区删除 60s 回执超时翻译为"结果不可知（可能已删除），先刷新时间线核对再决定重试"，插件安装/更新/卸载 npm 超时改"结果不可知（可能部分写入），重试安全，可先核对已装版本"。合同测试补 3 项（`npm run test:bridge` 共 14 项）：类型化超时 + router 兼容字样、purge 翻译路径、非超时错误原样透传。
>
> P2 结构批次第一步（2026-10-18）：主进程 IPC 注册按域拆分——main.ts 从 1799 行降至 1149 行，70 余个 ipcMain.handle 迁入 `src/main/ipc/` 十个域模块（theme-packs/logs/connection/runtime/stories/mixer/plugins/accounts/console/secrets，共 56 channel），`registerIpc()` 改为依赖装配编排器；`IpcContext`（ipc/context.ts）统一注入：服务按引用、Map 按引用、可变原语（window/blindMode/lastSnowLumaDetection）经访问器；`syncExternalConnector`/`reconcileExternalConnector` 自 registerIpc 嵌套声明提升为顶层（仅引用模块级状态，无行为差异；wanted 构造逐字对照拆分前 dist 编译产物校正）。行为保证：channel 名/校验/错误文案/广播/返回形状逐字迁移，preload invoke 面 ↔ 注册面程序化对照 56=56 零缺失零孤儿；typecheck/build/test:bridge 14 项/test:runtime 75 项/全部 UI 套件绿。后续步骤（Renderer 拆分/状态边界）另行批次。
>
> P2 输入边界批次（2026-10-18，保守 scope）：①调用方门控——全部 56 channel 改经 `ipc/register.ts` 的 `registerHandle` 包装，分派前校验 `event.sender` 为主窗口 webContents（`ipc/sender-guard.ts` 纯谓词：同一性放行、非信任源拒绝、信任源缺失 fail-closed、窗口重建后旧引用失效；Console BrowserView 由"恰好打不进来"（sandbox+无 preload）升级为"被拒绝"）；②上限缺口审计补齐六处——logs:query 与 deliveries 的 NaN limit 归默认（原 NaN 会静默切空结果）、searchMarket 查询截 200 字符、secrets.set 值 16KB 上限、probe-upstream 入参 2048/512 钳制、configSection 写入在 yaml.dump 前加 1MB+循环引用尺寸门（mediator 的 1MB 检查作用在 dump 后）。既有防线确认在位：storyId 咽喉点正则（StoryManager.get）、mediator 1MB/敏感键、theme-packs 5MB/2MB/256 条、usage 366、outbox 500。合同测试补 3 项（test:bridge 共 17 项）。刻意不做（挂到 Renderer TS 迁移条件）：schema 注册层、{ok,error} 返回信封、schema 导出 preload 类型——大爆炸式 API 破坏 + 无类型 JS 下零运行时收益。
>
> P2 竞态/刷新批次（2026-10-18，保守 scope）：提案中约四分之三为既有现实（timeline 的 snapshotRequestRevision 序号守卫、snapshotFlight single-flight、投影 120ms 尾随防抖、状态栏/stats/mixer 的 storyId 守卫、15s 定时刷新的 document.hidden 跳过、游标分页、[bridge] trace 耗时行）。本轮补三件：①worker 重启混入的最后缺口——readSnapshot 加 pid 身份锚点（请求发起记 pid，落地/分页循环/错误路径三处不一致即丢弃；同故事 worker 重启时 storyId/revision 都不变，pid 必变）。宿主投影刻意**不加** pid 锚点：其数据源为宿主文件（outbox/inbox/logs），worker 重启不失效，加了反而错误丢弃有效数据；②stale 丢弃计数（`staleDropCounters` + devtools console.debug，不进日志页防刷屏）；③test:timeline 补 10k 条目行分配/视口剔除性能回归用例（rows 预算 500ms/interval 300ms，防 O(n²) 回归；含打乱确定性断言）。全部套件绿。
>
> P2 测试批次（2026-10-18，A/B/C 三档）：**A** `npm run verify:core`（scripts/verify-runtime-core.mjs）——把本表"再构建流程"的手工哈希校验变成命令：tgz↔sidecar SHA256、tgz 内 bundle↔node_modules 安装产物哈希、版本号一致性（内置极简 tar 读取，无外部依赖）；当前 rc57 五项全过。**B** `npm run test:smoke`——Electron 主进程自检冒烟（`electron . --typ0-self-test`）：隔离 userData/数据根/HostLock 至临时目录，断言 IPC 注册面↔preload invoke 面程序化对照（56=56 零缺失零孤儿）、preload 真实加载 + sender 守卫对真实窗口 invoke 放行（关闭输入边界批次承认的自动化缺口）、隔离数据根、HostLock 持有、干净退出。首跑即抓到并修复真实缺陷：initializeRuntime 的 dataRoot 重赋值会覆盖自检隔离（现已 selfTestRoot 优先）。刻意弹真实窗口，不进默认测试循环。**C** `npm run test:stale`——pid 守卫行为级验证（puppeteer + mock bridge，与 test-studio-ui 同 harness）：在飞 timelineRange 期间 pid 变化→迟到响应丢弃且不写回 state.snapshot、计数恰好一次；pid 稳定→同一响应正常接受（守卫不误伤）。刻意不做（挂条件"CI 基建/打包管线建立时"）：真 worker/HDSI 全链集成（需密钥 fixture、model readiness 旁路、headless CI）、打包冒烟（无打包管线）。
>
> 前端审查修复批次（2026-10-19，随用户 V4/V7 多轮改版）：①V7 状态机面板 CHANNEL/MODEL 恒"—"修复——渲染层读的 `hostOverview.channel/model/updatedAt` 此前是不存在的字段；`ipc/runtime.ts` 的 runtime:overview 现聚合主进程现成状态源（channel=故事级 externalConnectionStates rollup，model=复用 buildFirstRunReadiness 的 model 检查带 15s 缓存防高频投影刷新反复读配置，updatedAt=ISO 时间戳入 V7 渲染 key）；②V7 对宿主状态变化不敏感修复——refreshHostProjection 末尾在 v7-profile-active 时触发 renderArrangement（V7 分支自带 key 记忆化，无变化不重绘；V4 Arrangement 不消费投影故不在触发之列）；③死 CSS 清理约 110 行（workspace-layout 的旧 overview rail 族+shared-rail V4.2 块+孤儿注释/空 media、hud-item-route、config-help、:is() 中的 wizard-desc 半选择器、style.css 的 unknown-hint）。防误删核查救回两处假阳性：`ext-ok/warn/err` 经 `ext-${led}` 模板动态构造（accounts-v3 保留）、`wizard-hint` 在静态 HTML 活着（仅 wizard-desc 半个死）。全套件回归绿（含 16 主题兼容档案）。

## 历史记录

| 构建标识 | bundle SHA256 | 备注 |
|---|---|---|
| `rc32+local.20261003` | `AB8CE41B424AC7ED7441AE7FCCAEAC5E61BBF1D1A3416EB9BD3C2248C94CD20` | 首包（人工复核时桌面实际加载版本） |
| `rc32+local.20261003-2` | `2db8d41dc53b0e0ec671e2e04c5fbeca73c33a3a853f972f57814e7939ed2b48` | 含 P0-6 |
| `rc32+local.20261003-3` | `59e8afb21d160dda02434fb4e5ee814bdf33d1ad8b1d8690eb63054649184ce5` | 含 P0-6 + P1 批次 |
| `rc32+local.20261003-4` | `3f54cea55e783c4ff2722d4c5416dde9ef22c127572d55e55579a1fc3b7fa560` | P0-6 + P1 + P2 批次 |
| `rc33` | `83cb90991a5cbdf9aac32dd93baf9fb7722c691c239f02bed3a1073f785a97e3` | 正式定名（= `-4` + 版本常量），2026-10-04 起 release-local 并入 release |
| `rc34` | `4c3bb6c4d2cea91b77441a016295873f0e3793e090e69f9149593f2501f7de55` | rc33 + 权限门可诊断性修复（manageSessionDenialReason 区分两层拒绝）；内部构建，文档随 rc35 补齐 |
| `rc35` | `0b5dd38f3d7da89345161db0f3a75b39471df404e256d93f41b75b13e039b4fd` | rc34 + contextEntryLimit 硬地板移除（小模型可调小历史条目） |
| `rc36` | `799ec4726d9718aee8eeceb672cce48679578a4adca22ce6090836429ffc4213` | 小模型换行分句开关；已发布 gitee（commit `46190cb`，Release id 1183061） |
| `rc37` | `dda432cea03d5a67bc795247ea7f714ddc249bfec9a44742fb95c7be2b8467e3` | Gemini Interactions API 传输（新预设 `gemini-interactions`，+8 单测）；内部构建 |
| `rc38` | `4bbb0b56fa0ffa7a3a47a751c92cc355d21235d33ac5be6137ed972af896f407` | rc37 + proxyAgent + fetch 可诊断；内部构建 |
| `rc39` | `d7cd55efdd93490d41adcae32881146010693f200ab3fb03c3ddb16098f50608` | rc38 + 审计修复批；已含用户批（投递恢复/长线空窗口，rc40/41 未单独出版） |
| `rc42` | `f299f964e2dfe2a54e6d5e2cd9b06a753efa0f393038283e4d0936c5fcd75a1e` | 截断重试正则 + 失败冷却（独立潜在 bug，保留） |
| `rc43` | `ea2e33aa1196deb25aacc865c8b440ee1f94cd68f9d3ab46243a975463320455` | cannot modify primary key 根因修复 |
| `rc44` | `0f9a9dc390a00afa8eadbe4f463464be93bfa7f8565771a86a15db8474455be7` | 合并转发内图片读取修复（imageRefs → 视觉管线） |
| `rc45` | `9af1b7c1c018f5110339f4ac1a1a4cddc8ac9c770a3b73af3c41c25b1c0244e6a` | 贴纸投递基址漏拷修复 + 14 配置缓存全量审计 |
| `rc46` | `2371cfb4e40c5c8de75cbc9e1e69bc73da91c73d43658ab0686d02a2db0e74318` | 双时钟修复（session.timestamp 优先）+ 群消息离线补拉（offlineGroupCatchup） |
| `rc57` | `d4d4e9c8a93aab0edc84361d6fd6474a12b8bdf122c23a47254541d2fe3e6842` | 当前桌面锁定；含 rc56 审查修复批（桌面桥接语义/Console 配置面重排/SHARE_SECTIONS 补 weather）与 rc57（Overlay 单场景演化修复、presetSync 前置、默认值基线对齐）。桌面同步适配见上"rc57 同步适配说明"（2026-10-18 安装验证） |

# typ-0 桌面工程现状审查与下一步施工建议

日期：2026-09-06；2026-09-07 已实施 D0 + D1。范围：`desktop/` 的 Electron 主进程、preload、Renderer、Worker 管理、渠道、投递、存档、投影和现有设计文档。

typ-0 是独立工程，不是 `%APPDATA%/Koishi/Desktop` 实例；两者不能共用安装与恢复操作。D0/D1 的实际改动、边界与验证见 [D0 + D1 实现记录](2026-09-07-d0-d1-implementation.md)；未升级内核、未打包、未连接真实 QQ 或修改既有故事数据库。

## 1. 结论

**方向是对的，下一步应完成 M7 的真实渠道与恢复闭环，而不是先扩展界面、媒体能力或重新做一套叙事核心。**

现有结构已经具备很好的分工：HDSI 维护原始剧本与角色生活；每个故事由独立 Koishi Worker 运行；Electron 主进程持有账号、路由、Inbox／Outbox、配置与存档；Renderer 消费只读投影。这些边界值得保留。

当前主要短板不是“功能少”，而是若干部件已经存在，却没有在真实生产装配路径中形成同一个闭环。单测分别通过，并不能证明账号绑定、Worker 门面、真实上游和回执协作正确。尤其是把自己的消息当用户输入，会在内核写作质量正常时也制造剧情幻觉。

## 2. 先澄清版本基线

用户将此工程描述为基于 M10 改造；本次检查不能把这个设计来源直接等同于实际运行包：

| 位置 | 当前观察 |
| --- | --- |
| `desktop/package.json` | 桌面仍标记 `0.0.1-m0`；HDSI 依赖指向 `1.0.0-beta4-m8.tgz`。 |
| `desktop/node_modules/koishi-plugin-hds-interlude/package.json` | 实际安装包版本为 `1.0.0-beta4-m8`。 |
| 同包 `lib/index.js` | 内嵌版本常量也是 beta4-m8，bridge-ready 为 protocol 4。 |
| 从 `desktop/package.json` 建立的 Node resolver | 解析至上述本工程 node_modules 包，不是主仓库最新源码。 |
| `desktop/src/main/runtime/` | 已有 protocol 4 投影、分支谱系、M7-1／2／3 相关代码。 |
| 根目录 `hdsi-sourcecode/` | 旧参考源码，不应视为 Worker 的当前运行内核。 |

因此，准确表述是：**桌面侧已有后续适配，但本次确认的默认安装内核仍是 beta4-m8，尚无证据证明此目录的实际 Worker 已使用 M10。**没有启动所有用户故事，也不排除另有未检查的自定义插件覆盖路径。

先建立 `desktopVersion + coreVersion + coreArtifactHash + bridgeProtocol + capabilities` 的启动自报与界面展示。内核来自可回退的固定发布产物，不让 typ-0 直接追随主仓库未发布 P1 源码。是否升级到 beta7-enhanced 应作为独立兼容验收批次，不在修渠道时顺便切换。

## 3. 保留的架构成果

- 每故事 Worker、故事目录与数据库隔离；同分支树运行互斥，防止两个分支同时代表同一段生活。
- running／muted／paused 和入站持久化、稳定渠道消息 ID 去重；相同文本的新消息不是重复事件。
- 宿主 Outbox 独立于生成正文，角色写出回复不直接等于渠道成功。
- protocol 4 中已有 commit／行动关联与投递、场景检查点投影；不靠正文长度估算真实经过的时间。
- 配置经主进程中介、密钥别名和运行期 resolved 文件；Renderer 无 Node，Console 分故事隔离。
- 原始剧本仍由 HDSI 保存；桌面不直接替代其记忆整理、剧情弧或写作判断。

这些是桌面化最有价值的部分，不建议为了统一代码外观而推倒重写。

## 4. 发现的问题与影响

“确认”指代码或离线夹具已能证明；“风险／未闭环”不代表用户已经发生了数据损坏。

| 优先级 | 观察与证据入口 | 对实际使用的影响 | 建议 |
| --- | --- | --- | --- |
| A，确认 | `runtime/onebot-core.ts` 的 `transformPrivateMessage()` 同时接受 `message` 和 `message_sent`，并以 `user_id` 生成 senderId。 | 上游提供自发消息回声时，自己的台词会成为用户输入，产生自我回应、虚假互动与错误学习。 | 自发回声进入投递关联／诊断支路，不进入用户入站；真实对方的 message 才是互动证据。不要用相同文本粗暴去重。 |
| A，确认 | `main.ts` 仅将 `OneBotServerAdapter` 和 sandbox 注册到 ChannelAdapterRegistry；前者与 ExternalOneBotConnector 都声明 `onebot-external`。外部 connector 只放进另一张 Map。 | Outbox 实际会找到内部门面，而非真实上游；门面 `send()` 向 Worker 连接发送渠道 action，方向错位，可能超时。 | 门面只做 Worker 适配；另设按 story／account 分派的外部渠道服务。不能简单注册多个同 transport connector，否则后一个会覆盖前一个。 |
| A，确认 | Main 的 `accounts:bind` 接受 upstream 参数，但 preload 的 `accounts.bind()` 和 Renderer 只传三个参数。 | 普通用户无法从当前界面完成上游端点／tokenAlias 配置闭环。 | 增加一份共享的绑定请求类型，连通 UI → preload → Main；用真实 IPC 装配测试验收，不只测登记类。 |
| A，确认 | `syncExternalConnector()` 只在绑定／解绑调用；`stories:load` 未恢复 connector，卸载却会停止它；existing 分支直接返回。 | 重启、卸载后重载或配置变更不能可靠重建上游；持久化“已配置”与运行状态不一致。 | 生命周期协调器根据账号、配置修订和宿主状态 reconcile，区分未加载、暂停、静音与故障。是否在 Worker 未加载时保持渠道收件应明确，推荐有绑定时继续入箱。 |
| A，确认 | `accounts:status` 使用 `onebot.onlineAccounts()`，即内部门面连接；外部 connector 的 online/offline 回调未装配。 | Worker 连上门面被当作真实 QQ 在线，排错方向会错。 | 分别展示 Worker-ready、内部桥接、外部连接、账号验证、可发送、积压状态。 |
| A，确认／风险 | `receiptFromEchoResponse()` 把 `async` 直接变成 sent；超时／断线统一 retryable-failed；Outbox 没有 unknown 状态与恢复核对。 | “请求受理”可能被当作完成；未来自动重试可能重复发送；崩溃残留 sending 不知道该补发还是核对。 | 保留 accepted/pending 与 outcome-unknown；明确完成证据后再 sent，未知结果先核对，不盲目重发。具体上游是否给最终回执须适配验收，不能仅凭 status 猜测。 |
| A，风险 | `stories:backup` 直接调用 `StoryArchiveService.create()`，后者 cpSync 故事目录，没有停止 Worker 或取得数据库一致性快照。 | 运行中复制成功不代表数据库与宿主账本同一时点，恢复后可能出现缺口。 | 先实现受控静止点／排空边界；第一版可要求卸载后备份，后续再加内核一致性快照命令。不能声称已经发生损坏。 |
| B，确认 | `meta_event` 返回无 event、无 drop 的对象，两种连接器却只判断 drop 后就传递 event。 | 心跳可能被当成 undefined 入站，制造异常日志。 | 用 `ignore / inbound / self-echo / unsupported` 明确区分事件结果；在账号映射前验证 self_id 与绑定一致。 |
| B，未闭环 | Console 配置编辑的中介捕获与 canonical 写回仍是设计待办；当前主要是受控 YAML 编辑路径。 | Console 看似修改成功，可能与编译期 resolved 配置及重启后的配置不一致。 | 在捕获协议完善前明确兼容 Surface 的写入能力，不承诺任意插件修改自动持久化；差异确认后走同一个配置提交入口。 |
| B，确认 | Blind 只对日志查询／导出及视图缓冲有明确处理；`broadcast()` 仍向 Renderer 推送原日志，Studio／Console 没有统一宿主策略。 | 当前不能宣称完整失明模式。 | Main 在发布事件及查询边界应用策略；Blind 开启时限制 Console 显示，原始存档与用户可见投影分离。 |
| B，确认 | `outbox.ts` 每次读取／写入整个 JSON，`json-file.ts` JSON 解析失败返回空缺省。 | 大历史增加主线程停顿；关键账本损坏若等同于“空”，会丢失去重依据。 | 先区分不存在、损坏、有效空账本；损坏保留并进入可诊断状态。再按基准决定追加日志／宿主独立数据库，不借用 HDSI 业务表。 |
| B，确认 | LogBroker `exportLogs()` 只查询最多 2,000 条；日志读取为异步文件 I/O，但解析、排序仍在 Main。 | “导出所选范围”可能实际上只是部分结果；大文件处理仍会影响交互。 | 导出必须有完整性说明或流式游标；先测大文件解析和事件循环延迟，再迁后台线程。不要沿用旧文档“同步文件读取”的过时描述。 |
| B，部分完成 | forkBranch 复制完整存档、保存 forkPoint；注释明确选点语义由后续消费。 | 谱系分支不等于还原到选中时刻；不能把带未来记忆的副本叫作历史回滚。 | 当前 UI 标为“复制并记录分叉点”；真正选点回滚必须由内核处理状态／事实／意图／学习与外部投递边界，另立任务。 |

补充连接安全：tokenAlias 解析失败当前会尝试无 token 连接，建议改为明确的配置错误；日志不要输出带认证参数的完整 endpoint。先验证账号身份，再宣布可路由，不只以 WS open 判定账号正确。

## 5. 推荐架构修正：收拢协作入口，不重写核心

### 5.1 ChannelCoordinator：让连接成为宿主的明确职责

增加一个轻量的主进程协调服务，拥有“期望绑定、配置修订、真实连接、健康状态”之间的对应关系。Renderer 只提交绑定意图；登记、路由、创建／停止 connector、错误回滚和状态推送由它协调。

生产路径应明确为：外部 OneBot → 规范化真实用户事件 → MessageRouter／Inbox → HDSI Worker → bridge delivery → Outbox → 外部渠道分派 → 回执 → HDSI。内部 OneBot 门面服务 Worker 的会话适配需求，不能再次充当外部发送端。

此处只是宿主职责整理，不新建叙事引擎或平行的角色状态。

### 5.2 DeliveryCoordinator：恢复也必须有证据

把 `main.ts` 的发送装配提取成可单独测试的服务，继续复用现有 Outbox 和同 deliveryId 的 in-flight 合并。

至少区分：待发、发送中、受理待确认、已确认、可重试失败、永久失败、结果未知。按消息片段保留 deliveryId 与平台 messageId；`sent` 在 UI 中解释为已获得发送成功证据，不是用户已读或同意。

断线和崩溃后先恢复账本；已发结果若尚未成功回传 HDSI，应重传回执而不是重发正文。上游不支持查询／幂等时，明确保留 unknown 并供用户处理，不能承诺外部网络端到端 exactly-once。

### 5.3 Evidence Projection：让人能看懂拟真度问题

现有 protocol 4 的行动与投递身份是很好的基础。下一步以可选能力扩展只读投影，让 Inspector 能区分：原始剧本、真实用户消息、已发送台词、角色想法、未确认提议、条件、已确认结果、未来预案。

`story-repository.ts` 的事实投影目前主要保留 content／confidence／unresolved 等字段；将来升级 beta7 类内核时，需要显式透传其已有 knowledge／sourceEntryIds／关联来源，而不是 Renderer 自行从 prose 推断。

第一步只做“点击事实 → 查看已有证据原文 → 跳到投递／日志”，不要求额外模型评分或生成诊断摘要。UI 中预案仍显示为预案；不能因内核版本变化把它画成已发生的生活。

## 6. 下一步施工顺序

这里的 D 编号是桌面施工批次，**不是 HDSI 内核 M7／M8／M10 的重新编号**。

| 顺序 | 范围 | 主要改动位置 | 完成标准 |
| --- | --- | --- | --- |
| D0，已完成 | 版本与能力自报；整理现有／计划状态，锁定内核产物 | package 元数据、StoryManager、bridge-ready、Overview、Inspector、文档 | 实际包路径／版本／hash／协议可见；不顺便升级内核。 |
| D1，已完成（真机验收 2026-09-09 完成，内核同步升至 beta14） | 收尾 M7 入站和生产接线：自发回声、心跳、身份、upstream IPC、外部分派、连接恢复、真实在线状态 | onebot-core、preload、main、ChannelAdapterRegistry、ExternalOneBotConnector | 本机模拟上游经实际装配收发；Worker 门面不选作外发 action；自身回声不进入 HDSI。真实 QQ 与长时重连仍待验收。 |
| D2，紧接真机验收（**真机验收已于 2026-09-09 完成，见 DESKTOP-DESIGN 10.9**） | 回执语义、unknown、失败与崩溃恢复、结果回传 | contracts、Outbox、DeliveryCoordinator、WorkerControl | 发送前／上游受理后／回传前故障分别演练；已确认消息不重发；不确定状态可见。 |
| D3，可靠性门槛 | 一致性备份／恢复；绑定回滚保留完整 upstream；关闭／重启排空；单宿主实例保护 | archive、Main 生命周期、AccountRegistry、配置中介 | 恢复的是可读且账本可核对的存档；不自动重放已确认发送；同一个数据目录无双宿主写入。 |
| D4，M6 收尾 | Console 配置持久化边界、跨 Surface Blind、权限与身份统一 | ConfigMediator、console-embed、IPC 发布／查询边界 | UI 承诺的配置在重启后仍生效；Blind 下 Renderer 和 Console 无可绕过的原文入口。 |
| D5，**已提前完成（2026-09-08，见 DESKTOP-DESIGN 10.8）**，内核对齐 | 从 D0 确认的实际基线评估升级到 beta7-enhanced；若另有 M10 包也须单独记录；同时加证据投影，不直接引入未发布 P1 | 内核能力检查、story-repository、Inspector、兼容夹具 | 新旧存档、protocol 4 降级、分段投递和恢复对照通过；升级前后同一原文记录含义不变。 |
| D6，M8 产品化 | 角色／模型／渠道分区表单、兼容导入报告、密钥绑定、诊断深链、性能基准、分发演练 | Renderer 拆分、配置服务、日志／资源服务、发布脚本 | 新用户无需改 YAML 完成首个私聊；断网／重启可解释；干净环境可重建安装产物。 |

**建议下一轮只做 D0 + D1，并补 D2 所需的状态契约设计。**如果同时重写回执、换内核和加媒体，故障来源会再次难以区分。D1 仍只承诺私聊纯文本；群聊、图片、语音后移。

## 7. 性能与拟真度验收

性能上先处理消息路径上的同步全量账本、日志解析和重复 UI 刷新，不急着把整个 Arrangement 改成 Canvas。当前限量投影与索引可以保留；增加 1k／10k 时间线、跨日日志、多个 Worker 的可重复基准后再决定虚拟化、后台检索与资源预算。

资源调度优先保证真实用户输入与发送结果；限制低优先级整理任务并发，但不要通过改变角色时间、减少原始剧本或人为丢掉消息来降负载。

拟真度必须同时看渠道真实性与剧本连续性：

1. 用户说一句，入站恰好一个事件；角色回两段，出站恰好对应两段，自发回声不产生第三个“用户回复”。
2. 用户说“如果电影好看再一起看”，UI 和新内核均保留条件，不因显示成一条 promise 而变成已约好。
3. 静音期间原始消息保留时间与来源，恢复后不会被伪装成用户刚刚说话。
4. 已写出但未投递、已受理但结果未知、已获得成功回执三种情形，在 UI、宿主账本和 HDSI 中可区分。
5. 重启后昨天的原文与已确认结果仍可检索；备份恢复后没有“忘了但已发过”的投递分歧。
6. 无消息推进仍由 HDSI 承接角色生活与未解决联系；桌面不能为刷新 UI／健康检查伪造一个聊天事件。

## 8. 本次验证与证据范围

- 阅读主设计、typ-0 专项设计、T3.5～T6 完成计划及上述运行代码；没有把旧文档的“下一项”当作当前代码状态。
- `node node_modules/typescript/bin/tsc --noEmit`：通过。
- `node scripts/test-runtime.mjs`：26／26 通过；测试临时目录与本机模拟 WS 上游，**不是实际 QQ 验收**。该脚本主要测试部件，没有覆盖 Electron 主进程完整装配。
- 内存编译 onebot-core 后做三个离线夹具：`message_sent` 确实得到用户格式入站；`meta_event` 得到无 event 的空结果；`async` 回执得到 sent 且 messageIds 为空。未发送任何真实消息。
- 未运行 Electron 实机、真实账号 E2E、长时性能或破坏性恢复演练。本文所列恢复／备份风险需要后续夹具验证，不等同于已发生用户数据损坏。

主要证据入口：`desktop/src/main/main.ts`（装配／IPC／备份）、`desktop/src/preload/preload.ts`、`desktop/src/renderer/app.js`、`desktop/src/main/stories.ts`，以及 `desktop/src/main/runtime/{onebot-core,onebot-bridge,external-onebot-connector,channel-adapter,outbox,contracts,story-archive,story-repository,config-mediator,log-broker,runtime.test}.ts`。

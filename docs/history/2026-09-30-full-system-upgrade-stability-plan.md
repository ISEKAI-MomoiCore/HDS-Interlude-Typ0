# HDSI Desktop typ-0 × HDS-Interlude 全系统升级稳定计划

**审查日期：** 2026-09-30  
**审查范围：** `C:\dev\HDSI-desktop-typ-0` 桌面端，与 `C:\dev\HDS-Interlude\plugins\hds-interlude` 插件主仓  
**计划性质：** 升级实施与稳定性门禁；本文件是审查后的计划，不代表已经执行升级。当前未改动源码、依赖锁文件或用户故事数据。

---

## 1. 执行摘要

当前桌面应用安装并声明的插件为 **`1.0.1-rc25`**，插件主仓和最新本地 release 包为 **`1.0.1-rc28`**。两者存在实质代码和声明差异，并非单纯版本号落后。rc25→rc28 涉及多通道/endpoint、参与者链接、世界事件播种、QQ 空间等领域；桌面端配置、桥接和运行时不能仅通过替换 tarball 就视为完成升级。

**建议结论：有条件升级，不建议直接将桌面依赖改为 rc28 并覆盖现有运行环境。** 先完成协议与功能门禁、隔离数据迁移验证和真实 OneBot 回归，再进行小范围灰度。关键阻断项如下：

1. 桌面以 `bridge protocol >= 4` 推断 `semantic-analysis` 能力，但 rc28 主线桥接没有该命令；可能出现错误解锁/超时。
2. 桌面端已解析 `bridge-ready.capabilities`，插件主线却未发送能力列表，协商实际未闭环。
3. `cursor-set` 错误响应未映射为对应结果事件，失败时桌面可能等待到超时。
4. delivery 状态映射和 `accountKey` 命名在 Worker、桌面 Host、OneBot connector 之间不完全一致。
5. 配置面板对 rc28 新字段/领域覆盖不完整，必须证明未知字段在编辑保存往返中不丢失。
6. 目前桌面测试通过的是 **rc25 安装环境**，并不构成 rc28 兼容或数据迁移证明。

## 2. 系统结构与运行模型

### 2.1 桌面端

主要代码位于 `C:\dev\HDSI-desktop-typ-0\desktop`：

- `src/main/main.ts`：Electron 主进程、IPC 及应用服务装配。
- `src/main/stories.ts`：故事/Worker 生命周期、bridge 请求与响应、能力和状态管理。
- `src/main/runtime/`：OneBot 接入、路由、Inbox/Outbox、delivery ledger、配置编译/密钥、时间线 projection、日志与用量等运行时模块。
- `src/preload/preload.ts`：受控的 renderer IPC API。
- `src/renderer/app.js`、`index.html`、`style.css`：Studio/配置/时间线界面。
- `stories/<storyId>/`：故事元数据、Koishi 配置及数据目录；通常包含 SQLite 和 inbox/outbox 文件。

一个故事由独立 Koishi Worker 运行。主进程负责 Worker 生命周期、桥接通信、消息收发和持久化，renderer 通过 preload 暴露的 IPC API 操作故事与查看投影。当前默认最多并发 3 个 Worker，并限制同一分支树并发运行。

### 2.2 插件主仓

主仓：`C:\dev\HDS-Interlude\plugins\hds-interlude`。`src/desktop-bridge.ts` 是桌面 Worker IPC 入口，配合 `service.ts`、`database.ts`、`story-state.ts`、`types.ts` 等实现故事服务、数据库和领域功能。Worker 经 stdout/IPC 协议向桌面报告 bridge-ready、心跳、投影和 delivery 结果。

### 2.3 当前依赖基线

- 桌面 `package.json` 依赖本地 release tarball：`koishi-plugin-hds-interlude-1.0.1-rc25.tgz`。
- 桌面当前安装包版本：`1.0.1-rc25`。
- 插件主仓版本：`1.0.1-rc28`；release 目录已有 rc25–rc28 tarball。
- rc25 与 rc28 的 `package.json`、`lib/index.js` 及多份类型声明存在差异。

## 3. 审查验证记录与边界

审查过程中已运行并记录以下检查：

| 范围 | 检查 | 结果 | 解释 |
|---|---|---|---|
| 插件主仓 rc28 | `npm run typecheck` | 通过 | 仅证明主仓当前类型检查通过 |
| 插件主仓 rc28 | `npm test` | 501 通过、4 跳过、0 失败 | 不等同于桌面跨仓集成验证 |
| 插件主仓 rc28 | `npm run test:model` | 4 项跳过 | 需要生产模型条件，模型行为未被验证 |
| 桌面当前环境 rc25 | `npm run typecheck` | 通过 | 对应当前 rc25 依赖 |
| 桌面当前环境 rc25 | runtime / timeline / UI / bfixes 测试 | 34 + 8 项通过；UI、bfixes PASS | 证明当前测试基线，不证明 rc28 兼容 |
| 桌面实机历史验收 | 2026-09-09 报告 | 核心真消息往返等通过 | 验收环境为旧 Core/artifact，不能替代本次 rc28 灰度 |

**尚未完成：** 本计划不宣称 rc28 已在桌面中启动成功；未在生产故事目录上执行迁移；未证明旧 SQLite 可回退。所有迁移验证须使用副本。

## 4. 风险与代码同步清单

### P0 — 升级前必须关闭

#### P0.1 semantic-analysis 能力误判

桌面 `desktop/src/main/stories.ts` 将 `protocol >= 4` 当作语义分析可用条件，并向 `semantic-analysis` 发命令。桌面页面也暴露 Analysis 入口；但插件主线 `src/desktop-bridge.ts` 没有该 command，主线 changelog 说明该能力不在主线。

**处置：** 在插件主线正式实现并测试此能力之前，桌面应隐藏/禁用该入口，并拒绝仅凭 protocol 数值发起请求。之后只有 Worker 明确声明 `semantic-analysis` capability 才可启用。

#### P0.2 bridge capabilities 协商未闭环

桌面读取并保存 `bridge-ready` 的 `capabilities`，插件当前 ready payload 主要包含 protocol 和 phase，没有发送能力清单。因此桌面能力集合通常为空；同时代码仍有基于 protocol 的功能门控，形成两套不一致机制。

**处置：** 定义统一的 bridge manifest：`protocol`（消息封装/基础 schema 版本）、`apiVersion`、`phase`、`capabilities[]`。桌面所有可选功能都以 capability 为门控；未知能力忽略，缺少能力时降级或明确禁用，不得超时式探测。

### P1 — 灰度前必须关闭或有明确兼容策略

#### P1.1 request 错误响应不完整

插件成功路径已有 `cursor-set-result`，但 catch 错误映射未覆盖 `cursor-set`，失败会落入通用 `error`。桌面等待特定响应时可能无法及时结束请求。

**处置：** 每类 request command 均定义成功/失败同型响应，包含 `requestId`、`ok`、结构化 `error`；确保请求能立即 resolve/reject，所有路径都有超时清理和 pending 清理测试。

#### P1.2 delivery 语义、状态与重试边界

桌面 ledger 有 `generated / sending / sent / confirmed / accepted / unknown / retryable-failed / permanent-failed`；插件 bridge 类型主要是 `sent / retryable-failed / permanent-failed`。桌面把 `confirmed/accepted` 映射为 sent，把 `unknown` 保留为未知/错误。必须区分 Host transport receipt 与 Worker bridge receipt；unknown 不能因超时而被自动重发，否则可能重复发消息。需覆盖 Worker 重启、重复 deliveryId、断线和迟到回执。

#### P1.3 accountKey 命名分歧

插件后台 delivery 使用 `desktop:<selfId>`，桌面 OneBot connector/绑定常用 `onebot:<selfId>`。当前 resolver 可能通过 storyId 绕过该差异，但多账号展示、路由及未来严格校验存在风险。

**处置：** 优先统一为 `onebot:<selfId>`；若确需 desktop 专用命名，必须在协议中定义其含义，并在唯一边界显式规范化/校验。不可静默混用。

#### P1.4 入站合同需跨仓测试

双方共有 transport/account/platform/selfId/sender/channel/kind/content/time 等字段，但校验范围和媒体转换细节不完全一致。需明确 quote、voice、图片、时间戳、缺省 senderName、空 rawMessageId、guild/channel 语义与图片 URL 安全约束。尤其验证 rc25 不识别字段时的兼容行为。

#### P1.5 配置 UI/schema 覆盖不足

结构化配置 UI 覆盖 providers、用户、群聊、Bot 等部分字段，但 rc28 schema 还有 protocol、Anthropic cache、extra headers/body、vision/world-seeding 用途、价格字段等。多通道 endpoint、participant link/unlink、Qzone 等新领域也不能假定旧 UI 可编辑。结构化保存虽然会基于原始 row 合并字段，仍须验证数组项、根级未知字段和 YAML/表单来回切换不会删除新字段。

**处置：** YAML 必须保留未知字段；结构化表单只修改明确支持的字段；对不可编辑的新字段提供保留/只读提示。对保存前后配置做 YAML 语义 diff 和字段保留断言。

#### P1.6 数据库/state/分支迁移风险

rc28 新增或调整 endpoint、works、world-seeder、qzone、group willingness、model routing、story state 等功能。需在数据副本上验证 SQLite schema 增量迁移、story-state v4、分支/fork、备份恢复以及 inbox/outbox 与 SQLite 一致性。禁止在没有快照和回滚验证时直接让生产故事由新版本打开。

## 5. 升级原则

1. **先稳定接口，再升级二进制。** P0 闭环前不进入生产灰度。
2. **版本与能力分离。** protocol 版本代表协议结构兼容，不代表可选业务功能存在。
3. **数据只向前试迁移副本。** 新版本打开过的数据不保证旧版本可直接读；回滚优先恢复升级前完整快照，不尝试盲目降级 schema。
4. **可观测、可幂等、可降级。** 每个 bridge 请求有 requestId、超时、错误、能力门控与日志；delivery unknown 不自动重发。
5. **锁文件可复现。** 更新 `package.json` 后同步 npm/yarn 锁文件，记录 tarball SHA256、版本和构建来源。
6. **灰度与全量分离。** 先用专门测试故事和少量非关键故事，验收后才扩大范围。

## 6. 分阶段执行计划

### 阶段 0：冻结和基线盘点

- 保留当前 rc25 安装包、三个依赖定义/锁文件和可启动安装产物。
- 导出故事 ID、分支关系、启停状态、各故事数据库及 inbox/outbox 路径；盘点 secrets/config 的安全备份位置。
- 记录每个故事的插件版本、bridge protocol、数据库 schema/state 版本、最近备份时间和关键外部连接。
- 在升级窗口前停止写入或制定一致性快照方法；SQLite 使用一致性备份，不在活动写入时仅复制主 db 文件。
- 生成清单与校验和。密钥备份加密并限制访问，禁止把密钥写入日志或计划附件。

**退出门禁：** 所有目标故事均有可校验的完整恢复点；rc25 回退安装物可用。

### 阶段 1：协议与接口修复

- 完成 `bridge-ready` manifest：`protocol`、`apiVersion`、`phase`、`capabilities`。
- 桌面改为能力门控；semantic-analysis 未实现时禁用入口，禁止发送命令。
- 为所有 request/response 定义共享 schema 和错误包络，修复 `cursor-set` 错误响应映射。
- 明确 delivery 状态含义、unknown 重试政策、重复 deliveryId 幂等规则。
- 统一/规范化 accountKey；完善入站消息字段和媒体约束。
- 将合同示例或 schema 放入双方可共同使用的 fixture，并添加兼容性测试。

**退出门禁：** P0 全关；关键 P1 有实现和回归测试，不存在 silent fallback 或等待到超时才发现不支持的路径。

### 阶段 2：隔离构建与类型兼容

- 使用 rc28 发布 tarball 建立临时验证副本，不覆盖桌面当前 `node_modules`。
- 更新临时分支/副本依赖，分别运行桌面 typecheck、runtime、timeline、UI 和 bfixes 测试。
- 确认 Electron 打包产物实际携带目标 rc28 文件，记录依赖树、tarball SHA256 和构建日志。
- 验证 capability 缺失时的旧 Worker 降级：新桌面+旧插件、旧桌面+新插件都要有预期结果；不支持组合必须明确拒绝或降级。

**退出门禁：** 构建可复现；类型和现有测试全过；兼容矩阵结果经人工确认。

### 阶段 3：副本数据迁移与功能回归

使用已脱敏或测试故事副本覆盖：

- rc25 数据由 rc28 首次打开：SQLite 自动迁移、重启、重复启动。
- story-state v4、历史 snapshot/timeline-range projection、cursor、purge。
- branch/fork 产生的新故事数据是否隔离，父子分支关系与时间线是否正确。
- 备份、导入、导出和从备份完整恢复；验证 SQLite、inbox、outbox、story metadata 和配置的一致性。
- providers/groups/users/bots/endpoints 新旧字段在 YAML 与结构化表单间往返保存不丢失。
- 插件新表/新字段与空数据库、已有数据库、部分迁移失败场景。

**退出门禁：** 全量副本可启动、消息历史与时间线可读、迁移可重复、备份能恢复；失败时能恢复升级前副本。任何数据丢失或不可逆迁移缺陷均阻断。

### 阶段 4：消息链路和故障注入

- 实际 OneBot 入站：私聊/群聊、引用、图片、语音、缺失字段、重复事件。
- 出站：即时 Session 投递、后台主动 delivery、显式 endpoint、多账号。
- 故障：连接断开/重连、Host 超时、Worker 崩溃与重启、bridge 请求乱序/迟到、同 deliveryId 重放、未知回执。
- 验证 Inbox 去重、Outbox 状态迁移、ledger 与实际上游回执一致；unknown 不重发且 UI 明确提示人工核验。
- 验证 phase 切换、heartbeat、runtime snapshot、console-port、日志和用量统计。

**退出门禁：** 不出现消息静默丢失或自动重复发送；故障状态能诊断；恢复后故事与 ledger 状态一致。

### 阶段 5：小范围灰度

- 选择一个可丢弃/可恢复测试故事及一个低风险真实故事；其余故事保持停止或留在 rc25。
- 灰度期间保留旧包和快照，观察至少一个完整业务周期（含主动推进/定时任务与跨日逻辑）。
- 记录 Worker 重启、bridge 错误/超时、投递 unknown/失败、数据库迁移、UI 配置保存等指标。
- 发生数据不一致、投递重复/丢失、持续 Worker 崩溃或无法恢复时，立即停止扩大灰度并执行回滚。

**退出门禁：** 灰度观察期内无 P0/P1 事件；关键用户流程验收签字；备份恢复演练成功。

### 阶段 6：正式升级与稳定观察

- 只在门禁全部通过后，更新桌面依赖版本并重建锁文件与发行包。
- 按故事批次升级，每批前确认快照和目标插件版本，批次间做健康检查。
- 保留至少一个发布周期的 rc25 回滚包、升级前配置和快照，不自动删除备份。
- 稳定期结束后，才考虑清理临时验证产物及过期快照（遵从数据保留策略）。

## 7. 兼容性/验收矩阵

| Desktop | Plugin | 预期 | 必测重点 |
|---|---|---|---|
| 旧版 | rc25 | 当前基线 | 回归参照，不应被升级过程破坏 |
| 旧版 | rc28 | 仅在确认向后兼容时支持 | 未知字段/命令、bridge-ready、消息投递 |
| 新版 | rc25 | 明确兼容或拒绝启动可选功能 | capability 缺失降级，不误发不支持命令 |
| 新版 | rc28 | 目标组合 | 完整协议、数据迁移、消息与 UI 回归 |

### 必需验收场景

- bridge-ready 与心跳：能力集合、phase、过期/重连。
- 所有请求成功和失败响应：phase、inbound、replay-inbox、snapshot、timeline-range、purge-range、cursor-set、delivery-result；semantic-analysis 仅在真正实现后测试。
- 图片/语音/引用入站合同；OneBot 多账号和 endpoint 投递。
- delivery 状态转换、unknown 不自动重试、重复 ID 幂等。
- timeline projection 边界数据、时间范围、cursor 与 purge。
- 配置未知字段保留、YAML/结构化编辑互不覆盖。
- rc25 数据副本迁移、重启、备份恢复、分支 fork。
- Worker crash/restart、bridge 超时、断线重连及日志可诊断性。

## 8. 回滚方案

1. **触发条件：** 任一故事迁移失败；核心数据/时间线损坏；入站消息丢失；重复出站；Worker 持续崩溃；或 bridge 故障导致核心流程中断。
2. 暂停该批次所有 Worker 和外部自动投递，避免故障期间继续写数据。
3. 保存故障日志、ledger、版本和校验信息用于诊断；不要覆盖唯一的升级前快照。
4. 回退桌面发行物和依赖到 rc25 对应版本。
5. 对升级前快照完整恢复故事元数据、SQLite、inbox/outbox 和关联配置；**不要假设旧 rc25 可安全打开 rc28 已迁移的数据库，也不要只换回插件包而保留新 schema 数据。**
6. 先在恢复副本验证，再恢复生产故事；验证消息游标、ledger、外部连接和时间线。
7. 暂停后续批次，完成根因分析与修复后重新从阶段 2 开始。

## 9. 监控指标与发布验收

灰度和正式升级至少记录：

- Worker 启动成功率、启动耗时、崩溃/重启次数。
- bridge-ready 成功率、声明 protocol/apiVersion/capabilities、心跳延迟与超时数。
- request 超时/错误率，按 command 和错误码分组。
- inbound 接收、去重、写 Inbox、交给 Worker 的数量及延迟。
- delivery 各状态计数；unknown 数量和持续时间；重复 deliveryId 数量。
- SQLite migration 结果、schema/state 版本、数据库完整性检查。
- timeline revision 更新、snapshot/range 查询错误。
- 配置保存前后未知字段保留断言及结构化/YAML 写入失败数。

**正式验收标准：** P0=0；未处理 P1=0；必需回归全过；灰度期无消息丢失/重复、无不可恢复数据错误；每个升级故事有验证成功的回滚点；包版本、锁文件、artifact hash、测试报告可追溯。

## 10. 跨仓发布与长期治理

- 将 bridge contract（schema/fixtures/能力清单/状态映射）作为明确版本化资产，避免桌面和插件各自维护隐式类型。
- 每次插件 release 记录：版本、commit、artifact SHA256、数据库迁移说明、bridge protocol/apiVersion、capabilities、向后兼容窗口。
- 每次桌面依赖更新必须以 release tarball 为输入，CI 校验包内版本与 hash，并阻止锁文件遗漏。
- CI 维护新桌面×旧插件、旧桌面×新插件、新桌面×新插件的合同测试；对不支持组合显式失败。
- 数据库迁移采用可重复、幂等测试；提供备份恢复测试，不把“migration 执行成功”当作“回滚安全”。
- 保持 changelog 描述与实际 capability 一致；任何实验分支功能必须标识为非主线能力，桌面不以 protocol 数字猜测其存在。

## 11. 建议执行顺序速览

```text
冻结 rc25 基线与数据快照
  → 修复能力协商、错误响应、delivery/accountKey 合同
  → rc28 隔离构建与兼容矩阵
  → 副本数据库/state/配置迁移验证
  → OneBot 全链路与故障注入
  → 小范围灰度并完成恢复演练
  → 分批正式升级
  → 稳定观察后结束升级窗口
```

**当前建议状态：** 保持生产桌面在 rc25；先实施 P0/P1 合同修复，再用 rc28 做隔离验证。此计划不授权直接覆盖现有安装、用户数据或正式故事目录。


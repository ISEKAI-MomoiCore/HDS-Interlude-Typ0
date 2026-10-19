# HDSI Desktop typ-0 × HDS-Interlude rc28
# 剩余门禁、灰度与正式升级执行文档

**文档日期：** 2026-09-30  
**适用版本：** `koishi-plugin-hds-interlude@1.0.1-rc28`  
**当前生产版本：** `koishi-plugin-hds-interlude@1.0.1-rc25`  
**文档状态：** 待执行清单；阶段 0–2 已完成，阶段 3–6 按本文件推进  
**关联计划：** `C:\dev\HDSI-desktop-typ-0\2026-09-30-full-system-upgrade-stability-plan.md`  
**后继计划：** 2026-10-02-rc29-sync-plan.md（锚点提升至 rc29，纳入 W2 多账号 / W3 动作代理 / UI 冻结令；本文阶段 3-6 门禁模型被其沿用）  
**当前验证报告：** `C:\dev\HDSI-desktop-typ-0\upgrade-validation\2026-09-30-rc28\validation-report.md`

---

## 1. 文档目的

本文件把 rc25 → rc28 的剩余工作拆成可以逐项执行、复核和回滚的任务。它解决三个问题：

1. 明确哪些工作已经完成，哪些工作仍然阻断正式升级。
2. 为真实故事副本、真实 OneBot 上游和灰度故事提供统一执行步骤。
3. 为每一个阶段定义证据、通过标准、停止条件和回滚点。

本文件不授权跳过门禁。任何一项 P0、未处理 P1、数据不一致、消息丢失、重复投递或无法恢复的问题，都必须停止后续阶段。

---

## 2. 当前基线

### 2.1 已完成内容

以下工作已在隔离环境完成：

- 插件 bridge manifest：`apiVersion=1`、`protocol=4`、capabilities。
- bridge request 成功/失败响应包络统一。
- `cursor-set` 专用失败响应。
- 后台 delivery 的 `accountKey` 统一为 `onebot:<selfId>`。
- 桌面 Host 保存并使用 bridge capability。
- semantic-analysis 未声明时不发送命令且隐藏入口。
- rc28 release artifact 已重新生成。
- release 包与隔离验证包 SHA256 一致：

```text
AF576E32A5D65ECBEF04D4ED1DE01D73B9EECD36B62FCE35CC6F123A0C29B828
```

- 插件 typecheck、501/4 测试和主仓 build 通过。
- 隔离桌面 typecheck、runtime、timeline、UI、bfixes、build 通过。
- D5 SQLite 增量迁移 6/6 通过。
- D2 orphan worker 清理 4/4 通过。
- bridge OneBot E2E 全部通过。

### 2.2 当前生产保护状态

正式桌面仍使用：

```text
C:\dev\HDSI-desktop-typ-0\desktop\package.json
→ koishi-plugin-hds-interlude-1.0.1-rc25.tgz
```

以下内容在正式升级前不得覆盖：

- `desktop/node_modules`
- `desktop/package-lock.json`
- `desktop/yarn.lock`
- `desktop/stories/`
- 正式账号绑定和密钥文件
- 正式运行中的 Worker

### 2.3 回滚资产

- 桌面代码和锁文件快照：
  `C:\dev\HDSI-desktop-typ-0\desktop\backup\2026-09-30-before-full-system-upgrade\`
- 插件旧 release 包和主仓升级前快照：
  `C:\dev\HDS-Interlude\plugins\hds-interlude\dustbin\2026-09-30-before-full-system-upgrade\`
- rc28 隔离验证副本：
  `C:\dev\HDSI-desktop-typ-0\upgrade-validation\2026-09-30-rc28\`

---

## 3. 总体门禁模型

升级只能按以下顺序推进：

```text
阶段 3：真实故事副本迁移
  ↓
阶段 3B：配置往返与备份恢复
  ↓
阶段 4：真实消息链路与故障注入
  ↓
阶段 5：一个测试故事 + 一个低风险真实故事灰度
  ↓
阶段 6：分批正式升级
```

任何阶段失败时：

1. 停止启动新的 Worker。
2. 停止外部自动投递和主动联系。
3. 保存日志、版本、artifact hash、ledger、数据库校验信息。
4. 在副本中定位问题。
5. 必要时恢复该阶段开始前的完整快照。
6. 修复后从失败阶段重新开始，不能直接跳到下一阶段。

---

# 4. 阶段 3：真实故事副本迁移

## 4.1 目标

证明 rc25 创建或维护的故事数据可以由 rc28 打开、迁移、重启和继续使用；迁移失败时可以从升级前快照恢复。

## 4.2 故事抽样

至少准备以下三类副本：

| 副本 | 内容 | 目的 |
|---|---|---|
| Empty | 空故事或最小故事 | 验证首次启动和空数据库迁移 |
| Typical | 有消息、facts、timeline、配置和账号绑定的普通故事 | 验证常规迁移 |
| Complex | 有分支、fork、较长时间线、inbox/outbox、delivery ledger 的故事 | 验证边界和恢复 |

副本必须脱敏。不得把真实 API key、token、cookie 或私聊隐私内容复制到测试目录。

## 4.3 迁移前快照

每个故事执行以下清单：

- [ ] 停止该故事 Worker。
- [ ] 确认没有待写入的 bridge request。
- [ ] 确认没有正在发送的 delivery。
- [ ] 记录故事 ID、分支父子关系、当前 phase。
- [ ] 记录插件版本、bridge protocol、schema/state 版本。
- [ ] 复制 story metadata。
- [ ] 使用 SQLite 一致性备份，不只复制活动中的 `.db` 文件。
- [ ] 复制 inbox/outbox、ledger、配置和分支注册数据。
- [ ] 为快照生成 SHA256 清单。
- [ ] 在恢复副本中至少打开一次快照，确认快照可读。

推荐快照目录：

```text
C:\dev\HDSI-desktop-typ-0\upgrade-validation\2026-09-30-rc28\data-snapshots\<storyId>\before-rc28\
```

快照清单至少包含：

```text
story.json
koishi.yml
SQLite 数据库
inbox/
outbox/
ledger/
branch metadata
SHA256SUMS.txt
manifest.json
```

## 4.4 首次打开迁移

对每个副本：

1. 使用隔离桌面副本和 rc28 artifact 启动。
2. 检查 bridge-ready。
3. 等待数据库迁移完成。
4. 检查 schema 版本和新增列/表。
5. 读取旧有 facts、story rows、timeline entries。
6. 关闭 Worker。
7. 再次启动同一副本。
8. 重复检查 schema、历史内容和 bridge 状态。

必须记录：

- 启动耗时。
- 迁移前后表/列清单。
- 迁移前后 row count。
- 迁移日志中的错误和 warning。
- 第二次启动是否重复迁移或改变数据。

## 4.5 迁移验收标准

全部满足才算通过：

- [ ] Worker 能启动并发送正确的 bridge-ready。
- [ ] SQLite integrity check 通过。
- [ ] 原有 story、fact、message、timeline 行数没有非预期减少。
- [ ] 原有内容、时间戳、来源和关联 ID 保留。
- [ ] 新迁移重复执行是幂等的。
- [ ] Worker 重启后数据仍可读。
- [ ] 迁移失败时原始 rc25 快照仍然可由隔离 rc25 环境打开。
- [ ] 没有把新 schema 写回唯一的 rc25 原始数据。

## 4.6 阻断条件

出现以下任意情况必须阻断：

- SQLite integrity check 失败。
- 历史消息、facts 或 story rows 减少。
- 迁移第二次启动产生重复数据。
- 迁移过程覆盖未知字段或删除未知表/列。
- 旧快照无法由 rc25 副本恢复。
- Worker 启动成功但 bridge-ready 不完整或 phase 错误。

---

# 5. 阶段 3B：分支、备份与配置往返

## 5.1 Branch/Fork 验证

对 Typical 和 Complex 副本分别执行：

1. 从父故事创建一个新分支。
2. 在子分支写入一条不会发送到真实上游的测试事件。
3. 确认父分支内容没有变化。
4. 关闭并重新打开子分支。
5. 检查父子关系、story ID、timeline revision 和消息游标。
6. 删除测试分支或移入测试废纸篓。
7. 确认父分支仍可正常启动。

验收：

- [ ] 子分支拥有唯一 ID。
- [ ] 父分支数据没有被反向写入。
- [ ] 子分支历史包含继承内容和新增测试事件。
- [ ] 分支重启后关系不丢失。
- [ ] 删除/恢复操作不损坏父分支。

## 5.2 备份与恢复验证

备份范围必须包含：

- story metadata
- SQLite
- inbox/outbox
- delivery ledger
- branch metadata
- canonical 配置
- 配置备份目录

不得把宿主密钥库和运行期 resolved 配置当作普通故事数据打包。

执行步骤：

1. 对迁移后的副本创建完整备份。
2. 在副本中制造一条可识别的测试变化。
3. 从备份恢复到全新的目录。
4. 启动恢复目录。
5. 检查历史、游标、ledger、配置和分支关系。
6. 检查恢复目录与备份 manifest 的 hash。

验收：

- [ ] 备份完整性校验通过。
- [ ] 恢复目录可以启动。
- [ ] 恢复后不出现测试变化。
- [ ] SQLite、inbox/outbox、ledger 和 metadata 相互一致。
- [ ] 恢复过程不会触碰正式故事目录。

## 5.3 YAML 与结构化配置往返

准备包含以下字段的测试配置：

- providers
- users
- groups
- bots
- endpoints
- protocol
- Anthropic cache
- extra headers/body
- vision/world-seeding 用途
- price 字段
- participant link/unlink
- Qzone 相关字段
- 根级未知字段
- 数组项未知字段

执行三条路径：

```text
canonical YAML
  → 结构化编辑保存
  → YAML

YAML
  → 不修改的结构化打开/关闭
  → YAML

YAML
  → 修改一个已支持字段
  → YAML
```

每次保存前后做语义 diff：

- 支持编辑的字段可以按预期变化。
- 未支持字段必须保留。
- 数组项顺序和 ID 不得无故改变。
- secret 仍通过别名保存，不写入原始明文。
- resolved 配置中的宿主注入字段不得写回 canonical 文件。

验收：

- [ ] 根级未知字段保留。
- [ ] provider/endpoint 数组中的未知字段保留。
- [ ] YAML 和结构化编辑互不覆盖彼此的新字段。
- [ ] 保存失败时原始配置仍可恢复。
- [ ] 配置自动备份可找到并能恢复。

---

# 6. 阶段 4：真实消息链路与故障注入

## 6.1 测试环境边界

必须使用：

- 独立测试 OneBot 账号或低风险账号。
- 独立 endpoint。
- 隔离故事副本。
- 可观察的测试群和测试私聊。
- 可清空的测试 inbox/outbox/ledger。

禁止直接把故障注入到正式账号、正式群或不可恢复故事。

## 6.2 入站合同测试

覆盖：

### 私聊

- [ ] 普通文本。
- [ ] 缺失 senderName。
- [ ] 缺失 rawMessageId。
- [ ] 重复 messageId。
- [ ] 时间戳缺失或格式异常。
- [ ] senderId 非数字或带平台前缀。

### 群聊

- [ ] 普通文本。
- [ ] 群 ID 与 sender ID 同时存在。
- [ ] 缺失群名。
- [ ] 缺失 senderName。
- [ ] 回复引用。
- [ ] at 片段。
- [ ] 重复事件。

### 媒体

- [ ] 图片 URL。
- [ ] 图片 file token。
- [ ] 语音文件 token。
- [ ] 无 URL 但有文件名的媒体。
- [ ] 空附件。
- [ ] 不安全或不可访问的 URL。

每条入站事件检查：

- transport
- accountKey
- platform
- selfId
- senderId
- channel
- kind
- content
- occurredAt
- rawMessageId
- quote
- attachment metadata

验收：

- [ ] 合法事件只入站一次。
- [ ] 重复事件被去重。
- [ ] 缺省字段不会导致 Worker 崩溃。
- [ ] 媒体不会退化成危险 URL 污染叙事文本。
- [ ] 群/私聊语义保持正确。

## 6.3 出站链路测试

覆盖以下投递路径：

- [ ] 当前 Session 即时回复。
- [ ] 后台主动 delivery。
- [ ] 私聊目标。
- [ ] 群聊目标。
- [ ] 多账号。
- [ ] 模型指定显式 endpoint。
- [ ] endpoint 不存在。
- [ ] endpoint 平台与目标不匹配。
- [ ] accountKey 需要规范化的场景。

特别检查：

- `endpointId` 是否真正被群消息投递消费。
- fallback endpoint 是否只在显式 endpoint 不可用时触发。
- 一个消息不会因为 fallback 再发一次。
- delivery ledger 和上游回执一致。

## 6.4 Delivery 状态测试

至少验证：

| 场景 | 预期 |
|---|---|
| 上游同步返回 message ID | `confirmed` 或等价成功状态 |
| 上游接受但没有 message ID | `accepted`，等待后续回执 |
| 请求超时但可能已到达 | `unknown`，禁止自动重发 |
| 明确权限错误 | `permanent-failed` |
| 短暂连接错误 | `retryable-failed` |
| 相同 deliveryId 重放 | 幂等，不重复发送 |
| 迟到成功回执 | 更新原记录，不创建新发送 |
| unknown 状态恢复 | UI 明确提示人工核验 |

## 6.5 Worker 和 bridge 故障注入

逐项执行并保留日志：

- [ ] Worker 启动后立即退出。
- [ ] Worker 在 bridge request 中途退出。
- [ ] Host request 超时。
- [ ] bridge response 乱序。
- [ ] bridge response 迟到。
- [ ] OneBot WS 断开后重连。
- [ ] 外部上游短暂不可用。
- [ ] Worker 重启后恢复 inbox。
- [ ] Worker 重启后恢复 outbox ledger。
- [ ] 重复发送相同 `deliveryId`。
- [ ] 收到未知 delivery 状态。

验收：

- [ ] 不出现静默丢消息。
- [ ] 不出现自动重复发送。
- [ ] unknown 不自动重发。
- [ ] 失败原因可从日志和 UI 定位。
- [ ] 重启后 ledger 与实际状态保持可解释的一致性。
- [ ] bridge pending request 最终会清理，不会永久挂起。

---

# 7. 阶段 5：小范围灰度

## 7.1 灰度对象

选择：

1. 一个可丢弃、可完整恢复的测试故事。
2. 一个低风险真实故事。

其他故事保持停止或继续使用 rc25。

不得选择：

- 无可靠备份的故事。
- 有重要不可重复主动任务的故事。
- 仍有未知数据迁移风险的故事。
- 账号或 endpoint 无法独立隔离的故事。

## 7.2 灰度前检查

每个灰度故事必须完成：

- [ ] 完整快照和 SHA256 清单。
- [ ] 已验证快照可以恢复。
- [ ] 已记录当前 rc25 版本和 schema/state。
- [ ] 已记录账号、endpoint 和外部连接。
- [ ] 已确认没有未处理的 unknown delivery。
- [ ] 已确认没有未完成的迁移。
- [ ] 已准备 rc25 回滚安装物。
- [ ] 已准备停止外部投递的操作步骤。

## 7.3 灰度观察周期

至少覆盖一个完整业务周期，包括：

- 普通入站消息。
- 私聊回复。
- 群聊回复。
- 主动推进或定时任务。
- Worker 重启。
- 跨日时间线读取。
- 配置读取和一次安全配置保存。
- 一次 snapshot/timeline-range 查询。

观察指标：

- Worker 启动成功率。
- Worker 崩溃和重启次数。
- bridge-ready 成功率。
- bridge request 超时/错误率。
- delivery 状态分布。
- unknown 数量。
- 重复 deliveryId 数量。
- inbox 去重数量。
- timeline revision 是否连续。
- SQLite integrity check。
- 配置保存前后未知字段保留结果。

## 7.4 灰度停止条件

出现以下任意一项，立即停止扩大灰度并进入回滚评估：

- 消息丢失。
- 消息重复发送。
- 数据库损坏。
- 时间线 revision 回退或跳变且无法解释。
- Worker 持续崩溃。
- unknown delivery 被自动重发。
- 配置保存删除未知字段。
- 无法从快照恢复。
- bridge 请求永久 pending。
- 外部账号或 endpoint 发生错误路由。

## 7.5 灰度通过标准

- [ ] 完整周期内无 P0。
- [ ] 无未处理 P1。
- [ ] 无消息丢失和重复。
- [ ] 所有异常都有日志和 UI 反馈。
- [ ] 至少一次恢复演练通过。
- [ ] 低风险真实故事负责人确认核心流程正常。
- [ ] 所有证据归档到升级验证目录。

---

# 8. 阶段 6：正式升级

只有阶段 3、4、5 全部通过，才允许执行。

## 8.1 升级前冻结

- [ ] 发布窗口内暂停非必要写入。
- [ ] 停止所有目标故事 Worker。
- [ ] 停止外部主动投递。
- [ ] 完成每个故事的一致性快照。
- [ ] 生成故事清单和版本清单。
- [ ] 保存 rc25 artifact、package-lock、yarn.lock、配置和完整快照。
- [ ] 确认 rc28 artifact hash：

```text
AF576E32A5D65ECBEF04D4ED1DE01D73B9EECD36B62FCE35CC6F123A0C29B828
```

## 8.2 正式依赖同步

只在冻结完成后：

1. 修改正式桌面 `package.json`，将 rc25 指向 rc28 artifact。
2. 重新生成并检查 `package-lock.json`。
3. 检查 `yarn.lock` 是否需要同步。
4. 清理或隔离旧依赖缓存，避免装入错误包。
5. 安装依赖。
6. 检查 `node_modules/koishi-plugin-hds-interlude/package.json` 版本为 rc28。
7. 对安装包执行 SHA256 或包内容核对。
8. 运行 typecheck、build 和最小回归测试。

正式升级前必须检查：

```text
package.json → rc28
package-lock.json → rc28
node_modules → 1.0.1-rc28
artifact hash → 与发布记录一致
```

## 8.3 分批启动

按故事批次执行，每批完成后再进入下一批：

1. 启动一个故事。
2. 等待 bridge-ready。
3. 检查 protocol、apiVersion、capabilities。
4. 执行 timeline-range 和 snapshot。
5. 发送一条受控测试入站。
6. 确认出站和 ledger。
7. 观察日志和 Worker 状态。
8. 通过后启动下一批。

禁止一次性启动全部故事。

## 8.4 正式升级通过标准

- [ ] 每个故事都有对应快照和 artifact 记录。
- [ ] 所有目标故事 bridge-ready 正常。
- [ ] 所有目标故事数据库完整性检查通过。
- [ ] 核心入站、出站和 timeline 查询通过。
- [ ] 无 P0、无未处理 P1。
- [ ] 无消息丢失、重复和错误账号路由。
- [ ] 回滚路径仍然可用。
- [ ] 发行包和锁文件已归档。

---

# 9. 回滚操作手册

## 9.1 触发条件

满足以下任一条件即可触发回滚：

- 数据损坏或不可读。
- 入站消息丢失。
- 出站消息重复。
- Worker 持续崩溃。
- bridge 协议不兼容。
- 无法解释的时间线或 ledger 不一致。
- 备份恢复失败。

## 9.2 回滚步骤

1. 停止所有已升级故事 Worker。
2. 停止外部 OneBot 投递和主动任务。
3. 保存当前故障目录，不要覆盖。
4. 保存日志、ledger、版本和 hash。
5. 将正式桌面依赖恢复到 rc25。
6. 恢复 rc25 对应的 package-lock、yarn.lock 和发行物。
7. 从升级前完整快照恢复故事目录。
8. 恢复 SQLite、inbox/outbox、ledger、metadata 和配置。
9. 在独立恢复副本中用 rc25 启动并验证。
10. 验证通过后再替换正式故事目录。
11. 验证消息游标、账号绑定、外部连接和时间线。
12. 暂停后续升级，记录根因。

## 9.3 回滚禁止事项

- 不能只把 rc28 tarball 替换回 rc25。
- 不能让 rc25 直接打开已经迁移过且没有快照的数据库。
- 不能删除故障目录和日志。
- 不能在故障未定位时继续升级其他故事。
- 不能重发 unknown delivery 中的消息，除非人工确认上游未收到。

---

# 10. 证据归档规范

每个阶段至少归档：

```text
<validation-root>/evidence/<stage>/<timestamp>/
  manifest.json
  commands.txt
  stdout.txt
  stderr.txt
  test-results.json
  SHA256SUMS.txt
  screenshots/                 # 如涉及 UI
  story-snapshot-manifest.json # 如涉及故事副本
  incident.md                  # 如有失败或异常
```

`manifest.json` 至少记录：

- 日期和时区。
- 执行人。
- 桌面版本。
- 插件版本。
- artifact 路径和 SHA256。
- 故事 ID（脱敏或内部 ID）。
- bridge protocol/apiVersion/capabilities。
- 测试命令。
- 结果。
- 是否修改数据。
- 是否可恢复。

不得在日志和报告中记录：

- API key。
- access token。
- cookie。
- 私聊原文（除非已脱敏且确实用于合同测试）。
- 完整外部账号凭据。

---

# 11. 最终执行清单

## 阶段 3：数据副本

- [ ] Empty 副本迁移
- [ ] Typical 副本迁移
- [ ] Complex 副本迁移
- [ ] 重启和重复迁移
- [ ] SQLite integrity check
- [ ] branch/fork
- [ ] backup/restore

## 阶段 3B：配置

- [ ] 根级未知字段保留
- [ ] 数组项未知字段保留
- [ ] endpoint 新字段保留
- [ ] YAML → 结构化 → YAML
- [ ] 结构化无修改往返
- [ ] secret 别名不泄露
- [ ] 保存失败可恢复

## 阶段 4：消息和故障

- [ ] 私聊入站
- [ ] 群聊入站
- [ ] 引用和 at
- [ ] 图片
- [ ] 语音
- [ ] 缺省字段
- [ ] 重复事件
- [ ] 多账号
- [ ] 显式 endpoint
- [ ] 群 endpoint 选择
- [ ] delivery unknown
- [ ] duplicate deliveryId
- [ ] late receipt
- [ ] Worker restart
- [ ] WS reconnect
- [ ] bridge timeout

## 阶段 5：灰度

- [ ] 测试故事快照
- [ ] 低风险真实故事快照
- [ ] 完整业务周期
- [ ] 指标观察
- [ ] 恢复演练
- [ ] 负责人验收

## 阶段 6：正式升级

- [ ] 冻结写入
- [ ] 全量快照
- [ ] package.json 切换
- [ ] package-lock/yarn.lock 同步
- [ ] 依赖 hash 校验
- [ ] 分批启动
- [ ] 分批健康检查
- [ ] rc25 回滚资产保留
- [ ] 稳定观察期开始

---

# 12. 完成定义

本次升级只有在以下条件全部满足时才算完成：

1. 阶段 3 数据副本迁移、分支和恢复全部通过。
2. 阶段 3B 配置未知字段和 secret 保护全部通过。
3. 阶段 4 真实消息链路和故障注入全部通过。
4. 阶段 5 灰度周期无 P0、无未处理 P1、无消息丢失或重复。
5. 阶段 6 正式升级按批次完成。
6. 每个故事都有可验证回滚点。
7. artifact、版本、锁文件、测试日志和快照清单完整归档。

在此之前，正确状态是：

```text
生产继续使用 rc25
隔离环境验证 rc28
继续完成剩余门禁
```

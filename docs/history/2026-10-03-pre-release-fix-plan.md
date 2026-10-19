# HDSI 1.0.1 发行前修复计划（插件 rc32 / 桌面 0.0.1-m1）

> 合并来源：ZCode 全量审计（2026-10-03）+ 人工 artifact 复核（2026-10-03）
> 复核基线：桌面实际加载 `koishi-plugin-hds-interlude@1.0.1-rc32+local.20261003`（bundle SHA256 `AB8CE41B…C94CD20`）；desktop `0.0.1-m1`，typecheck 通过，runtime 测试 48/48
> 用法：工作检查清单。完成一项勾一项；全部勾选并用统一 artifact 跑完第五节验收之前，不标记正式发行。

## 0. 结论

核心叙事链路（写作、投递、账本）稳定。发行差距集中在四类：

1. **溯源**：桌面实际运行的 rc32 artifact 与旁边源码树不是同一版本体系；
2. **崩溃诊断**：主进程/renderer/worker 三层退出都留不下原因；
3. **边界一致性**：分段重试可重复投递、qzone 增量可丢失或重复；
4. **失败反馈**：多处用户可见的失败无 UI 呈现。

首轮审计有 6 项被复核推翻（第四节，只补回归测试，不改代码）。

**待产品决策（阻塞对应项开工）**：

- D1：本版是否宣称微信支持（决定 P0-7 与 P1-3/P1-4 的优先级）；
- D2：连接向导四个断头按钮——补齐、摘除还是禁用（UI freeze 期间默认摘除/禁用）；
- D3：贴纸/表情发送失败后的用户侧语义——补发文本、写"她想发但没发出去"叙事条目、还是仅记日志。

---

## 一、P0 发行阻塞（第一批）✅ 已全部完成（2026-10-03，见各项尾注）

### [x] P0-1 插件 artifact 与源码溯源锁定 ✅

- **问题**：桌面依赖 rc32 tgz，`hdsi-sourcecode/` 树是 `0.1.5-beta1` 且无法独立 typecheck，qzone/longHorizon/M4 channel 逻辑在 artifact 中存在但源码树不对应。"源码审计通过"不能代表"桌面实际运行插件通过"。
- **修复**：以 `C:\dev\HDS-Interlude\plugins\hds-interlude`（插件主仓库）为唯一构建来源；重新构建 tgz 并安装到桌面；删除或明确废弃 `hdsi-sourcecode/` 快照；随发布生成 provenance 文件（plugin version / source commit / bundle SHA256 / package SHA256 / desktop commit / build timestamp / node+electron version）。
- **验收**：桌面 node_modules 内 bundle hash 与 provenance 一致；测试在同一 artifact 上运行通过。
- **完成情况**：新构建 `rc32+local.20261003-2`（含 P0-6），package/bundle 双 SHA256 已记录于 `PROVENANCE.md`；安装后 bundle 哈希校验一致；`hdsi-sourcecode/DEPRECATED.md` 已放置。仓库无 git，溯源以源码树指纹（src/**/*.ts 排序哈希）替代 commit。

### [x] P0-2 主进程与渲染进程崩溃诊断 ✅

- **问题**：`desktop/src/main/main.ts` 无 `process.on('uncaughtException'/'unhandledRejection')`、无 crashReporter、无 `render-process-gone`。打包版崩溃 = 窗口消失 + 零诊断（250ms flush 窗口内日志还会丢）。
- **修复**：挂全局异常处理器写入 LogBroker（error 级）；`window.webContents.on('render-process-gone', …)` 记录 reason/exitCode 并提供受控重载。
- **验收**：手动制造主进程异常与渲染进程崩溃，日志目录留有原因、堆栈与上下文。
- **完成情况**：`installProcessDiagnostics()`（uncaught/unhandledRejection + child-process-gone，均落盘并 drain）随 initializeRuntime 挂载；createWindow 增加 render-process-gone 处理（记录 + 60s 内 3 次崩溃起停止自动重载防循环）。**实机制造崩溃验证留待灰度**。

### [x] P0-3 连接向导 IPC 断裂（D2）✅

- **问题**：renderer 调用 `desktop.connection.testMessage / launchSnowluma / snowlumaPath / probeUpstream`（app.js:721/734/804/920），preload 只暴露 `detect / readyCheck`，main 也只注册两个 handler。四个按钮必然报 `undefined is not a function`。
- **修复**：按 D2 决策——补齐 main IPC + preload + 测试，或摘除/禁用按钮并给出状态说明。UI freeze 期间不做新功能，默认摘除或禁用。
- **验收**：连接页每个可见按钮要么完成真实调用，要么不出现。
- **完成情况（D2 已落地）**：`probeUpstream` 属当前账号绑定向导的核心步骤，**补齐实现**——抽取为 `runtime/probe-upstream.ts`（裸 WS 取 get_login_info，echo 过滤事件帧噪声，8s 超时，含单测）；`launchSnowluma / snowlumaPath / testMessage` 属 SnowLuma 集成半成品，**摘除**（按钮、handler、pollSnowlumaRunning、promptSnowlumaPath、connectTestRecord 一并清理，文案改为"手动运行 launcher.bat"）。IPC 契约核查：renderer 51 处调用全部有 preload 暴露。

### [x] P0-4 Worker 退出状态与 UI 反馈 ✅

- **问题**：`stories.ts:324` exit handler 不记 exit code/signal、不重启；main 未监听 `story-exit`；preload/renderer 无退出事件。`meta.phase` 不随 exit 回写 → 列表徽章仍显示"运行"，状态栏显示"离线"，自相矛盾；消息静默进 inbox，角色"假死"无提示。
- **修复**：结构化退出事件 `{ storyId, exitKind: 'crash'|'normal'|'killed'|'error', exitCode, signal, recoverable }`；main 记日志；phase 回写；renderer 呈现 toast + "重新加载 Worker"入口 + 待处理收件箱提示。
- **验收**：kill worker / worker 崩溃 / 正常停止三种场景，UI 均给出正确状态与恢复入口。
- **完成情况**：exit handler 捕获 code/signal 并分类（unload 流程经 `stoppingWorkers` 标记区分主动停止；`erroredWorkers` 捕获 spawn 失败）；main 监听并落 LogBroker（crash/error 记 error 级）+ 广播 `story:exit`；preload 暴露 `onStoryExit`；renderer 崩溃 toast（含恢复指引）+ 故事徽章 OFFLINE（悬停显示上次运行状态）+ phase readout 同步。**保留 phase 恢复语义**（meta.phase 仍用于下次加载恢复，显示层不再误读）。kill/崩溃实机场景留待灰度。

### [x] P0-5 日志 retention 接线 ✅

- **问题**：`log-broker.ts:184` 的 `applyRetention()` 从未被生产代码调用（仅测试引用）；单日超 8MB 轮转的 `.partN` 无数量上限。日志目录无限增长。
- **修复**：启动时执行一次 + 每日定时；当天 part 数量上限 + 总容量上限；清理失败写 warn；retention 结果进诊断日志。
- **验收**：构造超期/超量日志目录后启动，旧文件被清理且有日志记录。
- **完成情况**：`runLogRetention()` 随启动执行 + 24h 定时；applyRetention 扩展为三段策略（按天过期 / 单日 part 上限默认 12 / 总容量预算默认 256MB，超限从最旧的天开始整日删除）；清理量与失败均落日志。新增单测覆盖 part 上限与预算（含轮转编号语义）。

### [x] P0-6 longHorizonSweep 未处理异常 ✅

- **问题**：`service.ts:5174` `void this.longHorizonSweep(...)` 浮动调用，函数体只有 try/finally 无 catch（artifact `lib/index.js` 约 12004 / 14837-14890）。DB 读写任一失败 → unhandledRejection，可能击穿 worker。
- **修复**：调用点 `.catch(error => this.reportStandalone('error', '长线扫描失败：%s', error))`，或函数内统一 catch。顺带扫一遍 service 内其他裸 `void` 浮动调用（已知：`service.ts:847` 构造期预加载的空 catch 至少补 debug 日志）。
- **验收**：注入 DB 异常，worker 存活且日志出现 error 记录。
- **完成情况**：调用点加 `.catch`（warn 级，与相邻 longHorizonGenerate 一致；error 级提升归 P2-4 统一处理）；构造期预加载空 catch 补 debug 日志。其余裸 `void`（Alter 分析 / 历史嵌入 / 事实嵌入回填）核实均已有下一行 `.catch`。已包含在 `rc32+local.20261003-2` artifact 中，插件回归 524/0。

### [ ] P0-7（条件，随 D1）微信绑定链路完整性 —— 未开工，等待 D1 决策

---

## 二、P1 消息一致性（第二批）✅ 已完成（2026-10-03，见各项尾注）

### [x] P1-1 分段消息重复投递窗口 ✅

- **问题**：split/delayed intent 失败或 45s 未确认后延 30s 重试（artifact 约 10901/12639），但 bridge 每次用新 `deliveryId`（`desktop-bridge.ts:224`，artifact 约 17642），宿主 outbox 仅按 deliveryId 去重 → 上游慢于 45s 时同一内容发两遍。迟到回执落到已删 pending 被静默丢弃（`settleDelivery`/`settleAction` 返回 false 无日志），worker 侧还会写下"未投递"证据条目，叙事与现实分叉。
- **修复**：intent 增加稳定业务幂等键（intentId），retry 复用；outbox 按 `deliveryId + intentId` 双键去重；`unknown` 明确区分"禁止自动重试"与"等待确认"；迟到回执打 debug 日志。
- **验收**：覆盖"上游已收、回执延迟"场景不重复发送；同 deliveryId 重放不重复发送。
- **完成情况**：幂等键取 `scriptEvent.eventId + bubbleIndex`（无需新增 intent 字段，重试间天然稳定），经 `desktopDeliveryHandler.intentKey` → bridge → `DesktopDelivery.intentKey` 透传；宿主 `dispatchDeliveryOnce` 在同键记录为 sent/confirmed/accepted/sending/unknown 时按已投递回结 worker（幂等命中留日志）。新增 `findByIntentKey` 单测。**迟到回执 debug 日志与"上游已收、回执延迟"端到端场景留待灰度实测。**

### [x] P1-2 qzone 增量感知一致性 ✅

- **问题**（artifact 约 14070-14089）：① `deltas.slice(0, 3)` 只入账前 3 条，基线却全量前移 → 第 4 条起永久丢失；② 基线回写 `.catch(() => void 0)` 吞失败 → 下轮用旧基线重算出相同 delta，产生重复感知条目；③ `get_qzone_msg_list` 失败 `catch { return }` 零日志。
- **修复**：基线只推进已入账项，或逐条维护处理状态；`slice` 只作单轮预算、不得提前推进未处理项；所有失败写日志；`totalNew` 与实际入账一致。
- **验收**：1/3/>3 条 delta、基线写失败、单条入账失败重试、不重复写入已确认事件。
- **完成情况**：被评论感知重构为逐条提交——先推进该帖基线再写条目；预算（3）外的 delta 不推进基线（下轮重新发现）；基线回写失败即中止本轮；条目写入失败该增量让位不回滚基线；**保留非增量帖（含 commentNum=null 首次观察）的基线初始化**，否则增量感知永久失效。好友动态改为先落 feed-seen 账本再写条目。三处静默 catch 全部补日志（warn/debug）。日志改为"入账帖数 X/Y（预算 Z）"与实际一致。**>3 条/写失败场景的轮询级验证留待灰度。**

### [x] P1-3 原生表情桌面路径必然失败 ✅

- **问题**：`sendNativeFace` 调 `session.bot.sendMessage`，而 `desktopSession()` 合成 session 无 `bot` 字段（artifact 约 9691-9727 / 17608-17635）→ TypeError → 被外层 catch 吞掉。
- **修复**：桌面模式改走 `desktopOnebotActionHandler`，或在桌面/非 QQ 端点的能力探测中不暴露 native face（配合 D1）。
- **验收**：桌面模式下模型不产出或成功投递原生表情，无 TypeError。
- **完成情况**：桌面分支走宿主动作代理（`[CQ:face,id=N]` + auto_escape=false，与贴纸同型）；独立部署仍走 `session.bot`。实机验证留待灰度。

### [x] P1-4 贴纸目标 ID 类型（D1、D3）✅（D 无关部分）

- **问题**：`Number(channelId)` 把 `wxid_xxx` / `@chatroom` 变 NaN 直发上游。失败路径已有日志与账本 failed 记录（复核确认，不再是"完全静默"），但无文本降级、无重试，私聊调用点忽略返回值。
- **修复**：建立平台目标 ID 类型规则（`string | number`，由平台适配器决定）；失败降级语义按 D3 落地。
- **验收**：字符串目标 ID 全链路有效；失败场景符合 D3 语义。
- **完成情况**：`onebotTargetId()`——纯数字串转 number（QQ 规范类型），其余原样传 string；贴纸与原生表情桌面分支共用。**D3（失败降级语义）与私聊调用点返回值消费仍待决策后处理。**

### [x] P1-5 ambiguous / unknown / retryable 语义统一 ✅

- **问题**：① 宿主侧靠错误文本正则 `/超时|timeout|断开|closed/i` 判定 ambiguous（`main.ts:352`），脆弱；② 账号未验证与上游真失败共用 `upstream-failed`，插件侧不可区分；③ worker 侧 `desktop-bridge.ts:390-394` dispose 分支 resolve 缺 `ambiguous: true`，与"结果不可知即保守"原则矛盾（宿主 connector 侧已按 unknown 处理——复核确认，此处仅指 worker 内桥的关闭分支）。
- **修复**：connector/宿主返回结构化 `{ ok, ambiguous, errorCode }`；新增独立 errorCode 区分"账号离线"；dispose 分支补 ambiguous。
- **验收**：插件能按 errorCode 而非文本区分：超时/断开（保守）、离线（可提示）、明确失败（可降级）。
- **完成情况**：connector 引入 `OnebotActionError`（kind: not-verified / upstream-rejected / receipt-timeout / disconnected / send-failed）；宿主映射 `account-offline` / `upstream-failed` / `transport-ambiguous`（ambiguous=true）/ `send-failed`，正则降级为未分类错误兜底；worker 桥 dispose 分支改 `ambiguous: true`。新增结构化分类单测（not-verified / upstream-rejected / 成功路径）。**插件侧按新 errorCode 的差异化处理（如离线提示）属后续 P2 交互项。**

---

## 三、P2 交互与可观测性（第三批）✅ 已完成（2026-10-03，见各项尾注）

### [x] P2-1 readyCheck 的 models action 与密钥健康呈现 ✅

- **完成情况**：renderer 支持 `models` action（"去录入"→ openConfigTab('providers')），非 ok 检查项的 `detail` 以小字渲染；main 侧密钥检查从"仅 undecryptable"扩展为三态——`undecryptable`（重录指引）/ `missing`（配置引用未录入别名，含 yml `$secret:` 扫描）/ `unavailable`（无 keyring 指引安装 gnome-keyring），各带明确 detail 与 models action。

### [x] P2-2 未绑定账号消息不可见 ✅

- **完成情况**：preload 暴露 `onRouterUnassigned`；renderer 收到事件即 toast（含账号与"到连接页绑定"指引）并在状态栏追加"未分配 N"计数。消息查看/标记已处理面板留待后续（当前最小可见性闭环已建立）。

### [x] P2-3 preload 缺失导致白屏 ✅

- **完成情况**：app.js 启动即校验 `window.hdsiDesktop` 完整性（含 stories.list 探测）；缺失时渲染本地错误页（说明影响范围 + 日志位置 + 重新加载按钮）并 halt 脚本，不再无声白屏。

### [x] P2-4 日志级别：关键失败升 error ✅

- **完成情况**：升 error——主叙事失败（私聊 4722 / 群聊 2438）、消息投递失败（私聊/群聊）、SQLite 写入连续失败、后台推进/整理失败。归位——"主剧本归档完成""投递账号已自愈"warn→info；Puppeteer 缺失提示改进程内单次。

### [x] P2-5 日志隐私 ✅

- **完成情况**：`maskQqIds()`（5-12 位数字段保留尾 4 位）应用于 summary 级两条入站消息行（群/私聊收到，verbosity 关不掉的那两条）；standard/diagnostic 级完整 ID 维持原样（已有 verbosity 门控）。无回复 interaction JSON 预览纳入 `logScriptPreview` 门控（源码确认此前确实绕过门控）。token 用量行并入 standard verbosity。

### [x] P2-6 HDSI_TEST_MODE 收紧 ✅

- **完成情况**：`!app.isPackaged && HDSI_TEST_MODE === '1'`——打包版忽略该变量；启动日志记录明文测试模式与 safeStorage 可用性（不含密钥内容）。

### [x] P2-7 forward-message 零日志 ✅

- **完成情况**：复核修正——顶层失败本就有调用点 warn（2968），真正的缺口是嵌套失败静默占位。模块返回 `cause`（整体失败原因）与 `nestedFailed`（嵌套失败计数），调用方据此记 warn；适配器不支持 `_request` 也带原因。

### [x] P2-8 已知边界（发行说明言明）✅

- **完成情况**：[RELEASE-NOTES.md](RELEASE-NOTES.md) 建立——日志原文落盘、retention 参数、脱敏边界、safeStorage/TEST_MODE 行为、OS/供应商边界、SnowLuma 启动集成未提供、连接器无退避、贴纸降级待 D3、微信待 D1。清理：M0 死代码 `src/main/host.ts`（HostProcessManager，零引用）删除；connector `stop()` 兜底 timer 正确清除。

---

## 四、复核确认已修复 / 首轮误判（不修代码，只补测试）

| 项 | 复核结论 | 待补回归测试 |
|---|---|---|
| 群消息 `endpointId` | rc32 已实现（lookup + story-role/owner/目标群校验 + 门控 + 注入 delivery） | 合法 story-role 端点 / 合法 group owner 端点 / 错群 / 不存在 / 平台不匹配 |
| `_channelBatchMultiEndpoint` | 赋值链已接通 | 同回合多端点 vs 同批次多端点 vs 两规则同时命中的区分 |
| narrator `endpointId` 契约 | 已有明确模型契约 + 仅多端点时暴露候选列表 | 单平台不出现 `availableOutgoingEndpoints`；单平台输出 endpointId 被安全忽略/拒绝；多平台合法/非法/重复 endpointId |
| `lastEntryChannel [-2]` | 已按 `activeBatchMessageCount` 部分修复 | 剩余边界：batch >1 时只跳 1 条，应按完整 batch 数量跳过；单条/双条/跨端点/continuation/群批量用例 |
| bridge/connector 关闭语义 | 宿主侧超时与断开已返回 `unknown`（不自动重发） | 例外：worker 内桥 dispose 分支见 P1-5③ |
| sticker 静默失败 | 已有失败日志 + delivery outcome（不再是零观测） | 剩余问题归 P1-4 / D3 |

---

## 五、发行前验收测试（统一 artifact 上执行）

### Worker 生命周期
- [ ] 正常退出 / 被 kill / 崩溃 / 启动失败
- [ ] 自动恢复与恢复失败
- [ ] renderer 收到退出原因并可恢复

### IPC 契约
- [ ] preload 暴露集与 renderer 调用集一致（自动比对，防再出现断头按钮）
- [ ] 连接向导每个按钮完成真实调用；缺失 API 显示友好错误页
- [ ] `models` action 跳转到正确配置页

### 消息投递
- [ ] 成功 / 上游明确失败 / 上游超时
- [ ] 回执延迟但消息已成功（不重复发送）
- [ ] bridge 断开 / worker 投递中退出
- [ ] split retry 复用幂等键；同 deliveryId 重放不重复

### 多平台
- [ ] 单 QQ endpoint 走轻量协议；QQ+微信出现多平台契约
- [ ] 模型可选合法 endpoint；非法 endpoint 被拒绝
- [ ] `wxid` 私聊、`@chatroom` 群聊、字符串目标 ID 的贴纸/动作
- [ ] QQ 专属能力（原生表情/合并转发/Qzone/成员信息）不暴露给微信端点

### qzone
- [ ] 1 / 3 / >3 条 delta
- [ ] 基线写失败不产生重复感知
- [ ] 单条入账失败下轮重试；不重复写入已确认事件

---

## 六、执行顺序与完成标准

1. **第一批（P0）**：✅ 完成（2026-10-03，P0-1 ~ P0-6，详见各项尾注）。P0-7 待 D1。
   - D2 已落地：probeUpstream 补实现（属当前绑定流程），launchSnowluma/snowlumaPath/testMessage 摘除（半成品）。
   - 桌面回归：typecheck ✓，runtime 测试 50/50（新增 retention part/预算 + probe 两测）；插件回归 524/0（P0-6 已进 `rc32+local.20261003-2` artifact，bundle 哈希锁定于 PROVENANCE.md）。
   - 实机验证项（代码完成，留待灰度）：主进程异常注入、渲染进程崩溃恢复、worker kill/崩溃三场景。
2. **第二批（P1）**：✅ 完成（2026-10-03）。五项全做，D 无关部分落地：
   - P1-1 幂等键取 `scriptEvent.eventId + bubbleIndex`（天然稳定，零新增字段），宿主跨 deliveryId 去重；
   - P1-2 qzone 逐条提交 + 保留非增量帖基线初始化（防增量感知永久失效）；
   - P1-3 native face 走动作代理；P1-4 `onebotTargetId` 类型规则（NaN 防护）；
   - P1-5 `OnebotActionError` 结构化分类（account-offline / transport-ambiguous / send-failed），正则降为兜底；worker 桥 dispose 补 ambiguous。
   - 回归：桌面 typecheck ✓ + 52/52（新增 findByIntentKey、OnebotActionError 分类两测）；插件 524/0；新 artifact `rc32+local.20261003-3` 哈希锁定（PROVENANCE.md）。
   - 遗留：D3 语义（贴纸失败降级 + 私聊调用点返回值消费）、插件侧按新 errorCode 的差异化提示（归 P2 交互）；"上游已收、回执延迟"端到端场景留灰度。
3. **第三批（P2）**：✅ 完成（2026-10-03）。八项全做：readyCheck 三态密钥检查 + models 按钮 + detail 渲染；unassigned toast + 状态栏计数；preload 白屏守卫 + 本地错误页；四类关键失败升 error + 三处级别归位；summary 级 QQ 脱敏 + interaction 门控（源码确认绕过属实）+ token 行门控；TEST_MODE 打包版失效；forward-message 嵌套失败可见化；RELEASE-NOTES.md 建立 + host.ts 死代码删除 + stop() timer 清理。
   - 回归：桌面 typecheck ✓ + 52/52；插件 524/0；新 artifact `rc32+local.20261003-4` 哈希锁定（PROVENANCE.md）。
   - 遗留：unassigned 消息的查看/已处理面板（最小可见性已闭环）、连接器退避与 hung-socket 检测（发行说明已言明）。
4. 第四节回归测试与对应批次同批补充。IPC 契约一致性核查已随 P0-3 完成（renderer 51 处调用全部有暴露）。
5. **完成标准**：全部勾选 + 从锁定源码重建 artifact 重跑第五节全量验收 + provenance 文件随发布。三者齐备前不标记正式发行版。

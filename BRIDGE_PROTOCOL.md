# typ-0 ↔ HDSI 桥协议规范与版本纪律

- 日期：2026-10-18（P1 桥可诊断性产品化批次）
- 实现锚点：插件侧 `HDS-Interlude/plugins/hds-interlude/src/desktop-bridge.ts`；桌面侧 `desktop/src/main/runtime/bridge-session.ts`（状态机）、`desktop/src/main/stories.ts`（协商/在途/中止）、`desktop/src/main/main.ts`（广播与日志）。
- 合同测试：`desktop/src/main/runtime/bridge-session.test.ts`（`npm run test:bridge`），fixture 取自真实历史发布包。

## 0. 为什么要有这份文档

rc32 → rc57 期间桥接语义至少改了三轮（rc53 协议缺陷、rc56 群超时/ambiguous 记账语义），而 protocol 号一直是 4、capability 清单也没动。**协商机制防不住不诚实的版本纪律**——这是本仓库真实发生过的故障模式，不是假设。本文档的规则就是为下一次"想改桥接行为"的人立的。

## 1. 三层版本纪律（改动前先对号入座）

| 层 | 载体 | 什么改动必须动它 | 两侧义务 |
|---|---|---|---|
| **protocol**（信封/schema 版本） | `DESKTOP_BRIDGE_PROTOCOL` | 既有帧的**语义**变更：字段含义变化、状态机变化（如 rc56 的 delivery 状态语义）、删除字段、改变错误分类 | 插件 bump 版本号；桌面 `HOST_PROTOCOL_RANGE.max` 跟进认证，未认证前新协议以 degraded 呈现（放行但可见） |
| **capability**（可选行为位） | `DESKTOP_BRIDGE_CAPABILITIES` | 新增**可选**行为/帧：新命令、新事件流（如 multi-account、onebot-action） | 插件声明能力位；桌面在 `BRIDGE_FEATURES` 表补一行 + 合同测试补 fixture；旧桌面不识别新位必须无副作用 |
| **可选字段**（帧内 additive） | 帧载荷 | 纯增量、旧侧可忽略的字段（如 `traceId?`、`intentKey?`） | 双侧容忍缺失；桌面读取一律 `?.` + 缺省语义；不要求 bump |

**判定口诀**：改老帧语义 → 升 protocol；加新帧/新行为 → 加 capability；加可忽略字段 → 都不动，但两侧代码要防御缺失。

## 2. 帧清单（protocol 4 全集）

### 宿主 → worker（command，requestId 关联，全部有 `-result` 回执）

| 命令 | capability 位 | 桌面消费方 | 超时 | 备注 |
|---|---|---|---|---|
| `phase` | phase | 状态切换（running/muted/paused） | 15s | |
| `inbound` | inbound | 实时入站投递 | 30s | 载荷带 `traceId`；回执含 `processingId` |
| `replay-inbox` | replay-inbox | 收件箱回放 | 60s | m3 起按故事串行化 |
| `snapshot` | snapshot | 兼容快照（timeline-range 缺失时的回退） | 8s | |
| `timeline-range` | timeline-range | Arrangement 主数据源 | 10s | 缺失时桌面退回 snapshot（"兼容快照"标记） |
| `purge-range` | purge-range | 选区删除 | 60s | paused 门控在桌面侧 |
| `cursor-set` | cursor-set | 分支截断后回拨游标 | 30s | |
| `endpoint-health` | endpoint-health | 端点健康 | — | |
| `delivery-result` | delivery | 投递回执（无 requestId；按 deliveryId 结算） | — | status: sent/retryable-failed/permanent-failed/**unknown**（unknown=传输超时，插件按 pending 记账，rc56 语义） |
| `onebot-action-result`（事件推送） | onebot-action | 动作代理回执（requestId 结算） | — | ambiguous=true 时调用方禁止自动重试 |

### worker → 宿主（事件）

| 事件 | 触发 | 载荷要点 |
|---|---|---|
| `bridge-ready` | 插件就绪 | `apiVersion`/`protocol`/`phase`/`capabilities[]`——协商唯一入口 |
| `heartbeat` | 每 10s | phase + at；宿主 45s 窗判活 |
| `delivery` | 角色 发消息 | deliveryId、traceId?、processingId?、intentKey?（幂等键）、endpointId? |
| `onebot-action-request` | qzone/贴纸/内部动作 | requestId、accountKey、action（宿主侧白名单）、params |
| `console-port` | loopback server 就绪 | port、uiPath |
| `token` | 模型调用计量 | 用量记录（宿主 usage-aggregator） |
| `runtime-snapshot` | 运行态快照 | phase 等 |
| `error` | 处理失败 | command + message |
| `*-result`（8 种） | command 回执 | ok/requestId/accepted/error/errorCode |

## 3. 能力位历史演变（从真实发布包提取）

| 版本 | protocol | apiVersion | capabilities | 桌面判定 |
|---|---|---|---|---|
| beta10 / rc25 | 4 | — | **无清单** | degraded：全部 11 项声明功能受限（时间线走兼容快照） |
| rc33 | 4 | — | 11 项（无 processing-context） | degraded：缺处理上下文关联 |
| rc48 | 4 | — | 12 项 | ready（缺 apiVersion 仅记录 warning） |
| **rc57（当前锁定）** | 4 | 1 | 12 项 | ready |

> 历史包袱说明：beta10/rc25 时代桌面曾有"空清单隐含主线三命令"的兼容逻辑，已随死代码清理移除——空清单现在按"全部受限"如实呈现，这正是本批次"可诊断性优先于静默兼容"的立场。

## 4. 桌面侧会话状态模型（bridge-session.ts）

```
connecting ──bridge-ready──▶ ready / degraded
    │ 30s 未协商                  │ 45s 无心跳
    ▼                             ▼
failed(negotiation-timeout)   stale ──心跳恢复──▶ ready/degraded
                                   │
协议不可读/过旧 ──▶ failed         ▼
worker 退出（normal/killed/crash/error）──▶ closed
```

- **查询面**：IPC `stories:bridgeStatus`（拉）/ `story:bridge` 事件（推）；渲染层状态栏 chip + tooltip 列受限功能与降级路径。
- **在途请求**：worker 退出时全部按 `BridgeRequestAbortedError`（code=`bridge-worker-exited`，消息含 exitKind）立即结算——不再等到各自超时误报 timeout。
- **协议前向**：protocol > 宿主已认证 max → degraded + `protocol-ahead-of-host` 警告（放行但可见，沿用既有容忍行为）。
- **结构化 trace**：每次 command 终态落一行 `[bridge] trace command=… outcome=… requestId=… durationMs=… [protocol=…] [traceId=…] [error=…]`，并挂 log-broker correlation（requestId 为主键）——日志页可按 correlationId 串起 入站→请求→投递 全链。

## 5. 案例：规则若早存在会发生什么

- **rc53（协议缺陷）**：桌面桥接 20+ 修复 + 插件侧协议缺陷。若当时有合同测试，插件侧改动会在桌面 test:bridge 先红。
- **rc56（delivery 语义）**：`unknown` 状态语义、群超时前缀、ambiguous→pending——**这是"改老帧语义"，按 §1 应升 protocol**。当时没升（m2 备注"协商不变"），靠人工审查兜底。下次同类改动：升 protocol 5，桌面认证前以 degraded 提示"协议超出已认证范围"。

## 6. 再构建流程中的位置

插件升级同步（PROVENANCE §再构建流程）新增固定步骤：**桌面 `npm run test:bridge` 必须通过**——能力面/协议号变化时，先更新 `HISTORICAL_FIXTURES`（新版本 + 修订历史演变表 §3），再更新 `BRIDGE_FEATURES` 与本档 §2 帧清单，最后才允许更新 PROVENANCE 锁定表。

## 7. IPC 层 DTO 投影（worker → renderer，2026-10-18 保守批次）

**规则：worker 原始对象不直传 renderer。** 时间线（normalizeTimelineSnapshot/Range）、Mixer（MIXER_PARAMS 白名单）、桥会话（BridgeSessionSnapshot）之外，本批次收口了最后三条裸透传路径，实现于 `desktop/src/main/runtime/worker-projections.ts`：

| 路径 | 投影 | 钳制 |
|---|---|---|
| `runtime-snapshot` 事件 → `story:runtime` | `projectRuntimeSnapshot` | 字段白名单（storyId/phase/stories[].{id,status,cursorAt,updatedAt}）；stories ≤20（与插件侧同界）；字符串长度钳制；畸形条目丢弃 |
| `token` 事件 → `story:token` + UsageAggregator | `projectTokenRecord` | 白名单 9 字段（task/providerLabel/model/input/output/cachedInput/price×3）；token 数 ≤1e12、单价 ≤1e6、负数/NaN 丢弃；**同一 DTO 喂聚合器与渲染层（单一边界两处消费）** |
| `stories:semanticAnalysis` 返回 | `projectAnalysisResult` | 序列化安全边界：可序列化 + ≤2MB + 深拷贝隔离（未来插件才有真实形状，不发明字段） |

投影原则与全档一致：**降级不拒绝**——畸形值降级为安全缺省，投影函数永不抛错（analysis 的序列化边界是唯一例外：只读面板取数，超限即错误）。合同测试：`worker-projections.test.ts`（缺字段/旧形态/畸形值/超大列表/未知字段矩阵，`npm run test:bridge` 一并运行）。插件侧新增字段时的义务：先在投影白名单补字段 + 测试，再依赖它做 UI。

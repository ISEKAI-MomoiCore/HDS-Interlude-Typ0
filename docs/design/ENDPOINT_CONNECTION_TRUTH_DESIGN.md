# 端点连接真相:宿主权威推送设计(ENDPOINT_CONNECTION_TRUTH)

- 日期:2026-10-28
- 状态:**草案备用,未排期**(issue #2 热修后的中期规划;实现前提 = rc58 插件批次 + 桌面 m6)
- 背景:[issue #2] 周期同步把端点连接状态写成离线 → 主动消息必失败;桌面侧已于 m5 热修根因(config-compiler 空 token 注入 + 模板清理 + 就绪检查盲区),本设计解决的是**修复后仍然存在的语义错位**
- 实现锚点:
  - 插件侧:`HDS-Interlude/plugins/hds-interlude/src/service.ts`(`syncCurrentBotConnections` / `noteEndpointConnection` / `liveBotForEndpoint` / `isEndpointDeliverable`)、`src/desktop-bridge.ts`(`installDesktopBridge` 消息入口、`DESKTOP_BRIDGE_CAPABILITIES`)
  - 桌面侧:`desktop/src/main/main.ts`(连接器状态机 `externalAccountStates`、就绪检查)、`desktop/src/main/runtime/external-onebot-connector.ts`、`desktop/src/main/runtime/onebot-bridge.ts`(`onlineAccounts()`)、`desktop/src/main/stories.ts`(`sendDesktopCommand` / `sendToWorker`)、`desktop/src/main/runtime/bridge-session.ts`(`BRIDGE_FEATURES`)
- 协议纪律依据:[BRIDGE_PROTOCOL.md](../../BRIDGE_PROTOCOL.md) §1(新增事件流 = capability 位,不动 protocol)、§6(能力位变更的固定流程)

## 1. 背景与问题

### 1.1 端点"连接在线"的三个现存信号

插件 rc57 里 `interlude_endpoint_state.connection.online` 由三处写入,全部源自 worker 进程内部视角:

| 信号 | 写入点 | 实际测量的东西 |
|---|---|---|
| ① 周期巡检 | `syncCurrentBotConnections()`,每 `sweepIntervalMinutes`(默认 5 分钟)读 `ctx.bots` 的 `bot.status` | worker 内 adapter-onebot ↔ **内部桥**(127.0.0.1:6709)的 loopback socket |
| ② 发送时自愈 | 投递门控入口:`if (!state.connection.online) { if (liveBotForEndpoint(...)) 翻回在线; else return 'endpoint-offline' }` | 同上——按 `ctx.bots` 里是否存在在线 bot 自愈 |
| ③ 入站证据 | `touchEndpointStateInbound` → `stateAfterInbound`(online=true) | "刚收到过消息"——真实但滞后的证据 |

### 1.2 m5 热修后剩余的问题

m5 修好了"内部桥 socket 从未连上"(token 注入 bug),信号 ①② 从**恒假**变成**恒真**——issue #2 的症状消失。但架构错位仍在:

1. **假在线(新问题显形)**:真实上游(SnowLuma / NapCat / 自建 OneBot)掉线时,内部桥 socket 依旧健康 → 信号 ①② 恒真 → 插件认为端点在线 → 主动/延迟/跟随补写照常出队 → 经宿主 outbox 投递失败 → retryable-failed 账本累积、重试空转。真实上游健康度目前只通过投递失败冷却(`stateAfterOutbound`)间接泄漏,滞后一个完整投递周期。
2. **语义错位**:bot.status 的语义在独立 Koishi 部署里 = 真实渠道,在 typ0 桌面模式里 = 内部回环。①②是独立部署形态的遗产,桌面模式下测量对象错误。
3. **观测分裂**:宿主手里有每账号真实状态(`externalAccountStates`:`connecting/online/offline/configuration-error` + 错误码),就绪检查、连接页、状态栏都吃它;插件手里的端点状态却是另一个信号源。两端各说各话,排障时要人工对账。

## 2. 目标 / 非目标

**目标**

- G1 桌面模式下,插件端点 `connection.online` 以**宿主的外部上游连接器状态**为唯一权威来源(真上游断 → 插件在秒级翻转离线 → 主动投递在门控处被拒,不再空转);
- G2 真上游恢复 → 秒级翻回在线,并触发既有的 `recoverPendingDeliveries` 补偿;
- G3 双向版本安全:新桌面 × 旧插件、旧桌面 × 新插件都自动回落到 m5 后的现状(能力位协商 + TTL 兜底),零配置;
- G4 遵守 BRIDGE_PROTOCOL 三层纪律:新增事件流走 capability 位,protocol 维持 4。

**非目标**

- 不改独立 Koishi 部署的行为(无 desktop bridge 时巡检逻辑原样);
- 不重设计投递状态机的 deliverable/cooldown 维(`stateAfterOutbound`、`ENDPOINT_DELIVERABLE_TTL_MS` 等原样);
- 不做上游健康监测本身(宿主连接器状态机已存在,本设计只负责把状态"送达"插件);
- 不改入站路径与 `stateAfterInbound`(入站是真实证据,保留;见 §11-Q1)。

## 3. 连接语义模型

把"端点连接"显式分三层,各自有独立观测面,投递判定取 L2:

| 层 | 测量对象 | 权威方 | 桌面侧既有信号 | 插件侧用途 |
|---|---|---|---|---|
| **L1 内部桥会话** | worker adapter ↔ 桥 loopback WS(含 get_login_info 握手) | 桥 `OneBotServerAdapter.onlineAccounts()` | 就绪检查「内部桥会话」层(m5 新增) | 降级为诊断信号;不再驱动 connection.online |
| **L2 外部上游连接器** | 宿主 ↔ SnowLuma/NapCat forward WS(含身份验证) | 宿主 `ExternalOneBotConnector` 状态机 | `externalAccountStates` / 连接页 / 状态栏 | **connection.online 唯一权威** |
| **L3 入站证据** | "刚收到过该账号消息" | 消息本身 | InboundReceiptLedger | 保留 `stateAfterInbound` 翻在线(真实但滞后的兜底证据) |

推论:L1 断(worker 重启窗口)而 L2 在线时,投递会经宿主 outbox 正常完成——消息通路本就不走 L1,L1 只剩"worker 里 adapter 还活着"的诊断意义。这就是 ①② 信号降级的理由。

## 4. 方案对比

| 方案 | 思路 | 取舍 | 结论 |
|---|---|---|---|
| **A. 宿主推送(本设计)** | 宿主在 L2 状态变化时经桥协议推送每账号状态;插件声明能力位后停用 ① 的 bot-status 写入 | 秒级生效、权威单一;需双侧发版(rc58 + m6) | ✅ 推荐 |
| B. 插件轮询拉取 | 插件在 sweep 里发 `endpoint-connection-query` 命令拉宿主状态 | 单侧(插件)即可动;但保留 5 分钟级滞后,且把巡检周期和连接真相耦合 | ❌ 滞后不可接受 |
| C. 插件停写 | 桌面模式下 ① 只在"找到在线 bot"时写 true、永不写 false | 改动最小;但 L2 断线时插件永远认为在线,假在线问题原样保留 | ❌ 只解决一半 |
| D. 传导断连 | 宿主在 L2 掉线时主动断开该剧本的 L1 socket,让 bot.status 自然变 offline | 零协议改动;但把传输层两个无关通道耦合(L1 还承担 onebot-action 代理路径),断连还会触发 adapter 重连风暴,且 worker 内状态机复杂化 | ❌ 脆弱 |

## 5. 协议设计

### 5.1 版本纪律定位

按 BRIDGE_PROTOCOL §1 判定口诀:**加新帧/新行为 → 加 capability**。本设计新增:

- worker 能力位:`endpoint-connection`(插件在 `DESKTOP_BRIDGE_CAPABILITIES` 声明,bridge-ready 上报);
- 宿主侧 `BRIDGE_FEATURES` 补一行 `{ key: 'endpoint-connection', label: '端点连接推送', capability: 'endpoint-connection', fallback: '插件侧 bot 巡检(m5 语义)' }`;
- protocol 维持 **4**,apiVersion 维持 1。

### 5.2 帧形态

复用 `delivery-result` 已确立的"**按名消费、无 requestId、无回执**"的宿主→worker 单向帧模式(§2 帧清单同款),经既有 `sendDesktopCommand(metaId, 'endpoint-connection', value)` 通道发送:

```jsonc
// 宿主 → worker,单帧(全量快照)或单帧(增量)
{
  "type": "hdsi-desktop",
  "command": "endpoint-connection",
  "value": {
    "snapshot": true,                  // true = 全量(bridge-ready 后 / 重绑后);缺省 = 单账号增量
    "at": "2026-10-28T12:00:00.000Z",  // 宿主观测时间,仅诊断用
    "accounts": [                      // 快照:该剧本全部账号;增量:单元素
      {
        "accountKey": "onebot:123456",
        "state": "online",             // online | offline | connecting | configuration-error
        "detail": "上游回执验证通过",    // 可选;configuration-error 时给原因(脱敏)
        "at": "2026-10-28T12:00:00.000Z"
      }
    ]
  }
}
```

**前向安全**(G3 关键,已被 rc57 代码核实):旧插件的 `handle` 对未知 `command` 走 if-chain 不命中即静默返回,无副作用;新插件对旧宿主则因收不到快照走 TTL 兜底(§5.5)。

### 5.3 状态映射(插件侧)

宿主四态映射到插件 `noteEndpointConnection(key, online)` 的布尔 + 观测注记:

| 宿主 state | 插件动作 | 理由 |
|---|---|---|
| `online` | 写 `online=true` | 解锁主动投递;并触发 `recoverPendingDeliveries(true)`(对齐既有 bot 上线路径) |
| `offline` | 写 `online=false` | 真上游断——主动投递在门控处被拒,不再空转 |
| `configuration-error` | 写 `online=false`,note=detail | 配置缺陷等效不可投递,显式带原因 |
| `connecting` | **不写**(保持现状) | 避免 5 秒重连间隔造成的在线抖动;连接中既非证据也非反证 |

可选增补(不阻塞首版):`interlude_endpoint_state.connection` 增加 additive 字段 `source: 'host-push' | 'bot-sweep' | 'inbound'` 与 `detail?`,供端点健康面板与日志区分信号来源(纯增量字段,§1 纪律"可选字段"层,不 bump)。

### 5.4 触发时机(宿主侧)

1. **bridge-ready 后**:全量快照(每剧本;worker 重启后插件状态清零,必须重发);
2. **L2 状态变化**:`setExternalAccountState` 写入即推送该账号增量;
3. **账号绑定变化**:`accounts:bind` / `unbind` / 转移成功后,对新剧本推全量(旧剧本随 worker 卸载自然失效);
4. **L1 变化不推送**(仅诊断层,§3)。

**防抖**:连接器断线重连固定 5 秒间隔,直接透传会造成每 5 秒一帧的抖动流。规则:**online 迁移立即推**(尽快解锁补偿投递,这是收益方向),**非 online 迁移按 accountKey 尾随防抖 2 秒**(吸收 connecting↔offline 抖动)。IPC 每进程内保序,快照与增量无乱序风险;`at` 仅供诊断。

### 5.5 插件侧 TTL 兜底

能力位声明了不代表宿主一定会推(旧宿主 × 新插件组合)。插件规则:

- 装有 desktop bridge 且**曾收到过本剧本的快照** → 走推送模式:巡检 ① 与 `bot-status-updated` 监听**停写** connection(仅保留日志);
- **从未收到快照**(或距上一帧 > `2 × sweepIntervalMinutes` 且心跳正常)→ 回落 m5 语义(bot-status 巡检照写)。这是防御宿主推送链路整体失效的保险丝,不是常态路径;
- 回落与恢复的切换各留一条 warn 日志,防静默降级。

## 6. 插件侧改动清单(rc58)

1. `desktop-bridge.ts`:`DESKTOP_BRIDGE_CAPABILITIES` 增补 `endpoint-connection`;`handle` 增补 `command === 'endpoint-connection'` 分支——载荷校验(accountKey 形态、state 枚举、数组上限 = 剧本账号数上限)后调 `service.noteEndpointConnection` / 快照批量应用;校验失败静默丢弃 + error 日志,**绝不回执、绝不抛出**(单向帧纪律);
2. `service.ts`:
   - `syncCurrentBotConnections()` 与 `bot-status-updated` 监听:按 §5.5 的开关门控(桌面模式且推送生效时停写);
   - 快照应用器:全量帧按 accountKey 集合 diff——消失的账号(解绑)按 offline 处理;
   - `liveBotForEndpoint` 发送时自愈:桌面推送模式下同样停用(它测的是 L1);
   - 可选:connection 增加 `source`/`detail` additive 字段,`desktopEndpointHealthSnapshot` 透出;
3. 在线推送 → `recoverPendingDeliveries(true)` 复用既有 bot 上线钩子逻辑;
4. 测试:插件套件(当前 907 项基线)新增——帧校验矩阵(畸形载荷/超长数组/未知 state)、快照 diff、TTL 兜底往返、门控下巡检停写、独立部署(无 bridge)行为不变。

## 7. 宿主侧改动清单(m6)

1. `bridge-session.ts`:`BRIDGE_FEATURES` + `KNOWN_BRIDGE_CAPABILITIES` 补 `endpoint-connection`;`HISTORICAL_FIXTURES` 增 rc58 fixture(§6 流程:先 fixture 后锁定表);
2. `main.ts`:
   - 新增推送出口 `pushEndpointConnection(storyId, snapshot?)`:按剧本 worker 的能力位过滤(未声明 `endpoint-connection` 的 worker 不发,省 IPC),经 `sendDesktopCommand` 发送;
   - `setExternalAccountState` 与 `bridge-ready` 事件(stories.on('bridge-ready'))接入 §5.4 触发点;防抖按 §5.4 规则;
   - 就绪检查「账号」层与「内部桥会话」层文案微调:标注插件端点视图来源(L2 权威);
3. 日志:每次推送落一行 debug 级 `[bridge] endpoint-connection accountKey=… state=…`(挂 log-broker correlation,traceId 复用连接器的);
4. 测试:`runtime.test.ts` 新增——状态变化→帧发出(含防抖窗口)、快照在 bridge-ready 后必发、能力位缺失不发、旧插件静默(rc57 fixture 实测无回执无错误)。

## 8. 兼容矩阵

| 组合 | 行为 | 依据 |
|---|---|---|
| m6 宿主 + rc58 插件 | **新路径**:L2 推送驱动端点状态 | 能力位双向就位 |
| m6 宿主 + rc57 插件(含 m5 热修后的存量) | 帧被静默忽略,插件维持 bot 巡检(m5 语义) | 未知 command 静默(rc57 已核实);宿主按能力位过滤后实际不发送 |
| m5 宿主 + rc58 插件 | 能力位被宿主记为"清单外前向兼容位"(记录、不降级);插件收不到快照 → TTL 兜底回落 m5 语义 | §5.5;BRIDGE_PROTOCOL §4 |
| m5 宿主 + rc57 插件 | 现状(m5 热修后已无 issue #2 症状) | — |

推论:**两端可独立发版、任意顺序上线**,不存在必须同步的窗口——这是选 capability 位而非 protocol bump 的直接收益。

## 9. 端到端验收场景

1. **真上游掉线**:断开 SnowLuma/NapCat 的 WS 服务端 → (防抖 2s 内)插件端点翻离线 → 主动/延迟消息在门控处返回 `endpoint-offline`(不再是出队后投递失败);端点健康面板显示 host-push 来源的 offline;
2. **真上游恢复**:重连 + get_login_info 验证通过 → 秒级翻在线 → `recoverPendingDeliveries` 把断线窗口内的待投递补出;
3. **配置错误**:上游 token 配错(configuration-error)→ 端点离线且 note 带原因;
4. **worker 重启**:bridge-ready 后收到全量快照,端点状态不经历 fresh-start 空窗;
5. **降级兜底**:人为禁用宿主推送(或旧宿主)→ 插件 TTL 到期回落 bot 巡检,warn 日志各一条;恢复推送后回到新路径;
6. **独立部署回归**:无 desktop bridge 的 Koishi 实例上,巡检/自愈/入站三信号行为与 rc57 完全一致。

## 10. 发布流程(对齐 PROVENANCE §再构建 / BRIDGE_PROTOCOL §6)

1. 插件仓 rc58 分支实现 §6 → 全量套件绿 → 打 tgz(双 SHA-256);
2. 桌面仓先更新 `HISTORICAL_FIXTURES`(rc58 fixture)→ `BRIDGE_FEATURES`/`KNOWN_BRIDGE_CAPABILITIES` → 本档 §5.2 帧清单同步进 BRIDGE_PROTOCOL.md §2 帧 2 表与 §3 能力位演变表;
3. `desktop/vendor/` 换 rc58 tgz,PROVENANCE 锁定表更新;
4. `npm run test:bridge` 合同测试必须先行绿(纪律固定步骤),随后全量桌面套件 + §9 场景实测;
5. 版本:桌面 `0.0.1-m6`,发行说明补"端点连接真相"条目与已知边界(连接器 connecting 态不写、防抖窗口内最多 2 秒滞后)。

## 11. 开放问题(实现批次前拍板)

- **Q1 `stateAfterInbound` 翻在线是否保留?** 倾向保留:入站是真实证据,且上游真断时不会再有入站,L3 只会滞后不会说谎。但推送模式下 L3 与 L2 短暂不一致(上游重连中、旧消息回放)值得在端点健康面板标注来源。→ 随 §6-2 的 `source` 字段一并落。
- **Q2 sandbox 通道语义**:sandbox 账号无外部连接器,宿主对它推什么?倾向:不推(插件侧该 accountKey 无推送记录 → 不在快照 diff 里 → 维持 L3 证据驱动),避免给沙箱造一个永远 online 的假权威。
- **Q3 connecting 抖动阈值**:2 秒尾随防抖是否足够(上游重连是固定 5 秒间隔,理论无重叠)?实现时用连接器实测校准,必要时改为"offline 立即、connecting 防抖"(反转方向)。
- **Q4 快照触发是否需要宿主侧重放按钮**:就绪检查已有「重载 Worker」;若出现"插件状态与宿主对不上"的现场,增加一个 IPC 级"重发快照"诊断动作的成本很低,倾向顺手加。
- **Q5 L1 信号的去留**:内部桥会话在推送模式下只剩诊断价值(就绪检查层项)。是否在 rc58 里把 `liveBotForEndpoint` 完全移除(而非门控停用)以减少代码路径?倾向 m6 先门控、观察一个版本再清理。

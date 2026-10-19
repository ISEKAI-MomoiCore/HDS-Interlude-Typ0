# Trace ID 与 Worker/HDSI 全链路关联改造分析

- **日期**：2026-10-04
- **适用项目**：HDSI-desktop-typ-0
- **文档性质**：架构分析与实施建议
- **当前结论**：建议采用“轻量级多 ID 关联模型”，先完善 Desktop、Worker bridge 与 HDSI 之间的协议和持久化链路，不立即引入完整 OpenTelemetry。

---

## 1. 文档结论

当前项目已经在 Desktop 主进程侧为入站消息建立了 `traceId`，并将它串联到路由、收件箱、Worker 接收和出站投递。这是正确的第一步，但还不能保证一条消息在 **Worker → HDSI → 模型处理 → 延迟/拆分任务 → 出站投递** 的每个阶段都保持同一个可检索身份。

最适合当前项目的方案是：

```text
一条用户消息
  └─ traceId：整条业务链路的总编号
       ├─ requestId：某一次 Desktop ↔ Worker IPC 请求
       ├─ processingId：某一次 Worker/HDSI 处理回合
       ├─ deliveryId：某一次具体出站投递
       └─ intentKey：某个出站业务意图的幂等键
```

这套方案有三个好处：

1. **专业上足够清晰**：能够区分业务链路、IPC 请求、模型处理和具体投递；
2. **实现上不过度复杂**：不需要马上引入完整分布式追踪系统；
3. **用户上容易理解**：普通界面只显示“消息追踪码”“处理详情”“投递记录”，不要求用户理解 `spanId`、`requestId` 等内部术语。

建议将改造分为四个阶段：

```text
P0 统一协议和 Worker bridge 边界
P1 补齐处理上下文、延迟任务和拆分消息
P2 提供日志检索与面向用户的处理详情
P3 再评估是否需要 OpenTelemetry 或更完整的可观测性平台
```

---

## 2. 为什么当前 Trace ID 还不够

### 2.1 当前已经解决的问题

当前 Desktop 侧已经具备以下能力：

- 在消息路由入口自动生成 `msg-<UUID>` 形式的 `traceId`；
- 已有合法 `traceId` 时不覆盖，兼容旧调用方；
- 收件箱记录、未绑定消息和路由结果保留该 ID；
- 内置 OneBot 与外部 OneBot 统一进入 Main 的入站处理流程；
- 出站投递继承 Worker 提供的 `traceId`；
- 旧 Worker 未返回 `traceId` 时使用 `delivery:<deliveryId>` 作为兼容兜底；
- 入站、路由、Worker 接收、出站创建、发送和结算日志已经可以使用 `correlation.traceId` 关联。

当前实现主要位于：

```text
C:\dev\HDSI-desktop-typ-0\desktop\src\main\runtime\trace.ts
C:\dev\HDSI-desktop-typ-0\desktop\src\main\runtime\contracts.ts
C:\dev\HDSI-desktop-typ-0\desktop\src\main\runtime\message-router.ts
C:\dev\HDSI-desktop-typ-0\desktop\src\main\runtime\inbox-replay.ts
C:\dev\HDSI-desktop-typ-0\desktop\src\main\main.ts
C:\dev\HDSI-desktop-typ-0\desktop\src\main\runtime\outbox.ts
```

### 2.2 当前仍可能断链的位置

从系统结构看，真正完整的一条消息链路通常是：

```text
外部平台
  ↓
Desktop Main 接收入站事件
  ↓
MessageRouter 路由到 Story
  ↓
Inbox 或 Worker bridge
  ↓
Worker 接收事件
  ↓
HDSI 处理本轮消息
  ↓
模型请求、重试或取消
  ↓
生成一条或多条出站消息
  ↓
立即投递、拆分投递或延迟投递
  ↓
DeliveryOutbox
  ↓
OneBot / 其他外部平台
  ↓
投递回执
```

目前最需要重点确认的是中间部分：

- Desktop 的 `requestId` 是否被误当成整条消息的业务 ID；
- Worker 是否总是把入站 `traceId` 传给 HDSI；
- HDSI 生成延迟 intent 时，是否持久化了 `traceId`；
- 消息拆分后，每一段是否保留同一个 `traceId`，同时拥有独立的 `deliveryId`；
- 模型重试时，是否能区分“同一处理回合的重试”和“新的业务处理”；
- Worker 重启后，从数据库恢复的延迟任务是否仍然能找到原始消息链路；
- 出站失败重试是否保持业务幂等，而不是简单生成一条无法解释的新消息。

因此，当前的 Trace ID 改造可以准确描述为：

> Desktop 主机侧的关联链路已经建立；Worker/HDSI 内部的处理上下文和持久化传播仍需要补齐。

这一区分很重要。否则日志中可能出现：入站消息有 `msg-xxx`，出站消息也有 `delivery-xxx`，但中间的模型调用、延迟任务和重试记录无法确认是否属于同一条消息。

---

## 3. 当前系统链路说明

### 3.1 入站链路

当前 Desktop 侧的逻辑可以概括为：

```text
OneBot / 外部连接器
        │
        ▼
Main.handleInboundEvent()
        │ 生成或补齐 traceId
        ▼
MessageRouter.route()
        │
        ├─ 找到 Story → Worker bridge
        ├─ Worker 暂不可用 → Inbox
        ├─ 账号未绑定 → unassigned-inbox
        └─ 重复事件 → 忽略或返回已有结果
```

关键原则是：`traceId` 应在最早能够识别“这是一条新的入站业务消息”的边界生成，之后只允许传递，不应在下游随意重新生成。

### 3.2 Desktop 与 Worker 的 IPC 链路

当前 Desktop 到 Worker 的 IPC 请求会生成 `requestId`。它的正确含义是：

> 这是一次宿主进程与 Worker 之间的技术请求和响应关联。

它不适合替代 `traceId`，因为一条用户消息可能经历：

- 一次入站请求；
- 多次模型调用；
- 多个延迟任务；
- 多条拆分后的出站消息；
- 多次投递重试。

这些操作可能对应多个 IPC 请求，但仍然属于同一条业务消息。

### 3.3 Worker/HDSI 处理链路

HDSI 的业务代码已经包含一些天然会造成链路延长的能力，例如：

- 接收私聊或群聊消息；
- 生成模型请求；
- 模型失败后重试或取消；
- 生成出站消息；
- 发送消息拆分；
- 延迟回复；
- 持久化 intent；
- 后台唤醒并处理到期 intent。

这些能力决定了 `traceId` 不能只放在当前函数的内存变量里。只要链路可能跨越数据库、定时器、进程重启或新的 Worker 回合，就必须把关联信息写入可恢复的数据结构。

### 3.4 出站链路

当前出站链路可以概括为：

```text
HDSI / Worker
      │ worker-message: delivery
      ▼
Main.dispatchDelivery()
      ▼
DeliveryOutbox
      ▼
ChannelAdapter
      ▼
OneBot / 外部平台
      ▼
DeliveryReceipt
      ▼
Worker delivery-result
```

一条业务回复可能产生多个 `deliveryId`：

```text
同一 traceId
  ├─ delivery-1：第一段即时回复
  ├─ delivery-2：第二段拆分回复
  └─ delivery-3：延迟任务到期后的回复
```

这是正常情况，不应为了“看起来简单”而强行让多个投递共用一个 `deliveryId`。

---

## 4. 几个 ID 的职责必须分清

### 4.1 `traceId`：整条业务消息的总编号

**定义**：从一条入站消息开始，贯穿路由、Worker/HDSI 处理和所有相关出站结果的业务关联 ID。

**适用范围**：

- 入站事件；
- 路由结果；
- Inbox 记录；
- Worker 处理上下文；
- 延迟 intent；
- 拆分消息；
- 出站投递；
- 失败记录和处理详情。

**示例**：

```text
traceId = msg-2f15c4e0-...
```

**不应包含**：消息正文、账号名、token、API Key 或其他敏感信息。

### 4.2 `requestId`：一次 IPC 技术请求

**定义**：一次 Desktop ↔ Worker 请求的编号。

**适用范围**：

- 请求发送；
- 请求响应；
- 超时；
- IPC 错误；
- 请求级别的性能统计。

**不应承担**：整条用户消息的业务关联。

### 4.3 `processingId`：一次 Worker/HDSI 处理回合

也可以在实现上称为 `turnId`，但建议项目内部统一选一个名字。本文推荐 `processingId`，因为它比“对话轮次”更能覆盖：

- 用户消息触发的处理；
- 延迟 intent 到期后的处理；
- 自动推进；
- 模型重试；
- Worker 恢复后的重新处理。

**示例**：

```text
processingId = proc-7b7e...
```

同一个 `traceId` 可以出现多个 `processingId`。例如：

```text
traceId = msg-abc
  ├─ processingId = proc-1：首次处理
  └─ processingId = proc-2：Worker 重启后的恢复处理
```

如果产品团队更偏好叙事领域的术语，也可以在 UI 中把它显示为“处理回合”，但协议字段仍建议使用稳定的英文名。

### 4.4 `deliveryId`：一次具体出站投递

**定义**：一条具体出站消息在 Outbox 中的唯一记录。

它应当用于描述：

- 投递状态；
- 投递次数；
- 平台回执；
- 外部平台 message ID；
- 失败原因。

一次重试可以生成新的 `deliveryId`，但必须保留稳定的 `intentKey` 来避免重复业务发送。

### 4.5 `intentKey`：业务幂等键

**定义**：一个“应该只完成一次”的出站业务意图的稳定编号。

例如，某个 HDSI 脚本事件拆成三段：

```text
intentKey = scriptEvent-123:part-1
intentKey = scriptEvent-123:part-2
intentKey = scriptEvent-123:part-3
```

如果某一段投递失败后重试，新的 `deliveryId` 可以变化，但对应的 `intentKey` 应保持不变。

### 4.6 关系示例

```text
traceId = msg-abc
│
├─ requestId = req-inbound-1
│    └─ Desktop 将入站消息交给 Worker
│
├─ processingId = proc-1
│    └─ HDSI 执行本次模型处理
│
├─ deliveryId = delivery-1
│    └─ 第一段即时回复
│
├─ deliveryId = delivery-2
│    └─ 第二段拆分回复
│
└─ processingId = proc-2
     └─ 延迟 intent 到期后的后续处理
          └─ deliveryId = delivery-3
```

---

## 5. 设计目标与原则

### 5.1 专业性

- 业务链路 ID 与技术请求 ID 分离；
- 明确重试、延迟、拆分和投递的语义；
- 所有持久化任务能够恢复关联关系；
- 日志字段稳定、可检索、可聚合；
- 协议升级具有向后兼容策略。

### 5.2 易懂性

普通用户不需要看到下面这些内部概念：

```text
traceId
requestId
processingId
spanId
```

普通界面可以使用：

```text
消息追踪码
处理记录
处理回合
投递记录
查看处理详情
复制诊断信息
```

在高级日志、导出诊断文件和开发者模式中，再展示完整的内部字段。

### 5.3 可恢复性

不能只依赖 Node.js 的 `AsyncLocalStorage`。它适合在当前异步调用栈中方便读取上下文，但无法独立解决：

- 延迟任务跨越多个事件循环；
- 数据库重新加载；
- Worker 进程重启；
- 消息拆分后的独立投递；
- 失败后的重试；
- Outbox 的恢复。

因此，必须同时做到：

```text
内存上下文：方便当前函数和日志读取
持久化元数据：保证延迟、重启和重试后仍能恢复
```

### 5.4 隐私与安全

Trace 相关日志不应记录：

- 完整消息正文；
- Prompt；
- 模型原始响应；
- Token 数量以外的敏感模型细节；
- API Key；
- OneBot access token；
- secret；
- 完整账号凭据。

建议只记录：

```text
traceId
processingId
requestId
deliveryId
intentKey 的非敏感形式
storyId
阶段
状态
错误码
开始时间和结束时间
```

---

## 6. 方案比较

### 6.1 方案 A：继续只扩展 `traceId`

#### 做法

所有阶段都只传一个 `traceId`，不区分 IPC 请求、模型处理和出站投递。

#### 优点

- 代码改动最少；
- 日志字段简单；
- 初期容易理解。

#### 缺点

- 无法区分一次 IPC 超时与模型处理失败；
- 一条消息的多个模型处理回合会混在一起；
- 多条出站消息的投递状态难以独立分析；
- 重试、延迟和拆分的关系表达不完整；
- 未来如果接入性能统计或分布式追踪，需要再次重构。

#### 结论

可作为当前已完成的过渡状态，但不建议作为最终模型。

### 6.2 方案 B：轻量级多 ID 关联模型

#### 做法

保留 `traceId` 作为业务总 ID，同时增加 `processingId`，并继续使用已有的 `requestId`、`deliveryId` 和 `intentKey`。

#### 优点

- 能解释完整链路；
- 对现有代码侵入性较低；
- 不要求立刻部署新的日志平台；
- 兼容旧 Worker；
- 能支持重试、延迟、拆分和进程重启；
- 用户界面可以只展示友好术语。

#### 缺点

- 协议和持久化字段会增加；
- Worker bridge 需要明确字段继承规则；
- 需要增加一批针对恢复和幂等的测试。

#### 结论

**推荐方案。** 这是当前项目在专业性、实施成本和可维护性之间最合适的平衡。

### 6.3 方案 C：立即引入完整 OpenTelemetry

#### 做法

为每次进程、IPC、模型调用和出站投递创建完整的 trace/span，并接入 OTLP、Jaeger 或其他观测平台。

#### 优点

- 标准化程度高；
- 可以观察跨进程和跨服务性能；
- 适合大型、多服务、远程部署系统。

#### 缺点

- 对当前桌面应用来说成本较高；
- 需要解决本地数据存储、用户隐私和离线场景；
- span 生命周期容易与 HDSI 业务语义混淆；
- 不能替代业务上的幂等键和持久化 intent；
- 会增加打包体积、配置和排障复杂度。

#### 结论

现阶段不建议立即采用。未来如果出现以下需求，再评估引入：

- 多个独立远程服务共同参与一次处理；
- 需要持续分析模型耗时和 IPC 性能；
- 已经有集中式日志或观测平台；
- 本地隐私和离线存储策略已经明确。

---

## 7. 推荐的协议设计

### 7.1 入站事件

建议保持当前 `DesktopInboundEvent.traceId` 为可选，以兼容旧 Worker 和旧调用方；但在新的运行链路中，Main/Router 必须保证它在进入 Worker 前已经存在。

示例：

```ts
interface DesktopInboundEvent {
  traceId?: string
  transport: DesktopTransport
  accountKey: string
  platform: string
  selfId: string
  senderId: string
  senderName?: string
  channelId?: string
  kind: 'private' | 'group'
  content: string
  occurredAt: string
  rawMessageId?: string
}
```

协议规则：

1. 如果外部连接器没有提供 `traceId`，由 Desktop 生成；
2. 如果上游提供合法非空 `traceId`，Desktop 保留它；
3. `traceId` 不根据消息正文生成；
4. Router、Inbox 和 Worker bridge 不得无故重置它；
5. 旧版本调用方没有该字段时，仍然可以正常工作。

### 7.2 Worker 处理上下文

建议在 Worker bridge 进入 HDSI 的边界处构建统一上下文：

```ts
interface ProcessingContext {
  traceId: string
  processingId: string
  requestId?: string
  storyId: string
  receivedAt: string
}
```

处理步骤可以抽象为：

```ts
const context = {
  traceId: inbound.traceId ?? createTraceId(),
  processingId: createProcessingId(),
  requestId,
  storyId,
  receivedAt: new Date().toISOString(),
}

await traceContext.run(context, async () => {
  await processInboundMessage(inbound)
})
```

这里的 `AsyncLocalStorage` 只用于当前异步调用栈内的便捷访问。凡是要进入数据库、intent、Outbox 或跨进程消息的字段，都必须显式写入数据。

### 7.3 出站消息

建议新的 Worker 在每个 `DesktopDelivery` 中都返回：

```ts
interface DesktopDelivery {
  traceId?: string
  processingId?: string
  deliveryId: string
  intentKey?: string
  accountKey: string
  transport: DesktopTransport
  platform: string
  selfId: string
  channelId: string
  kind: 'private' | 'group'
  content: string
  occurredAt: string
}
```

其中：

- `traceId`：继承入站业务链路；
- `processingId`：表示生成这条出站消息的处理回合；
- `deliveryId`：本次 Outbox 投递记录的唯一 ID；
- `intentKey`：同一个业务意图在重试时保持稳定。

如果为了兼容旧 Worker 暂时不能增加 `processingId`，至少要保证 `traceId` 和 `deliveryId` 的规则稳定。

### 7.4 处理结果和失败事件

如果 Worker 会回传 `inbound-result` 或 `delivery-result`，建议统一包含以下公共字段：

```ts
interface CorrelatedResult {
  traceId?: string
  processingId?: string
  requestId?: string
  status: string
  errorCode?: string
  occurredAt: string
}
```

注意：`requestId` 是请求级信息，不应覆盖业务层的 `traceId`；结果中缺少 `traceId` 时，Main 可以按当前请求上下文兜底，但不能把兜底逻辑长期当成新协议的正常路径。

---

## 8. Worker/HDSI 侧的传递方式

### 8.1 在 bridge 边界统一接管

目前从 HDSI 主业务源码中可以看到 `receive`、`receiveGroup`、`sendOutgoingMessages`、intent、延迟回复和消息拆分等业务能力，但没有明显看到 `hdsi-desktop`、`inbound-result`、`delivery-result` 或 `traceId` 的完整协议实现。

因此不建议把 Trace ID 逻辑散落到 HDSI 的所有业务函数中。更合适的边界是：

```text
Desktop IPC
   ↓
Worker bridge / adapter
   ↓
HDSI service
```

在 bridge/adapter 中完成：

1. 读取或补齐 `traceId`；
2. 生成 `processingId`；
3. 建立当前处理上下文；
4. 将必要字段传入 HDSI；
5. 从 HDSI 生成的出站草稿中带回关联信息；
6. 向 Desktop 输出完整的 `DesktopDelivery`。

这样做的好处是：协议关注点集中，HDSI 核心业务不会被 Desktop 特有字段污染。

### 8.2 立即处理

对于同步或立即处理的消息，推荐：

```text
DesktopInboundEvent.traceId
        ↓
ProcessingContext.traceId
        ↓
模型调用日志 / 业务日志
        ↓
DesktopDelivery.traceId
```

`processingId` 在 Worker 开始处理这一回合时生成，并在模型重试期间保持不变，除非系统定义重试为新的处理回合。

建议区分：

- **同一处理回合内的技术重试**：保留同一个 `processingId`；
- **Worker 重启后重新恢复处理**：可以生成新的 `processingId`，但保留同一个 `traceId`；
- **用户再次发送一条新消息**：必须生成新的 `traceId`。

### 8.3 延迟消息

延迟消息是最容易丢失关联的地方。

生成 delayed intent 时，应把以下字段写入 intent payload 或等价的内部 metadata：

```ts
{
  traceId: 'msg-abc',
  sourceProcessingId: 'proc-1',
  intentKey: 'story-event-123:delayed-reply-1',
  createdAt: '2026-10-04T10:00:00.000Z'
}
```

到期唤醒时：

1. 从持久化 intent 读取 `traceId`；
2. 生成新的 `processingId`；
3. 在新的 Worker/HDSI 处理上下文中运行；
4. 生成的出站消息继承原 `traceId`；
5. 如果产生新业务意图，生成新的 `intentKey`；
6. 如果只是投递重试，保持原 `intentKey`。

不能只依赖创建 intent 时的内存变量，也不能只靠故事 ID 推断原始消息，因为同一个 Story 可能连续处理多条消息。

### 8.4 消息拆分

一条较长回复被拆成多段时，建议：

```text
相同 traceId
相同 processingId
不同 deliveryId
不同或可区分的 intentKey
```

示例：

```text
traceId = msg-abc
processingId = proc-1

part 1: delivery-1, intentKey = reply-123:part-1
part 2: delivery-2, intentKey = reply-123:part-2
part 3: delivery-3, intentKey = reply-123:part-3
```

这样用户看到的是同一条处理链路，运维人员仍可以分别定位每一段投递。

### 8.5 模型重试和取消

模型调用重试不应自动生成新的 `traceId`。建议语义如下：

| 场景 | traceId | processingId | requestId |
|---|---|---|---|
| 同一次模型调用的网络重试 | 不变 | 不变 | 可变 |
| 取消后重新发起同一处理回合 | 不变 | 可按实现决定是否变更 | 可变 |
| Worker 重启后恢复原任务 | 不变 | 新建 | 新建 |
| 用户发送新消息 | 新建 | 新建 | 新建 |

如果模型提供商的请求 ID未来需要记录，可以单独增加 `modelRequestId`，不要复用 Desktop 的 `requestId`。

---

## 9. 用户界面如何表达

### 9.1 普通模式

用户真正需要知道的通常不是某个内部 UUID，而是：

- 消息有没有收到；
- 是否正在处理；
- 是否已经生成回复；
- 回复是否已经交给外部平台；
- 出错时应该做什么。

建议使用以下文案：

| 内部概念 | 普通用户看到的文案 | 适用位置 |
|---|---|---|
| `traceId` | 消息追踪码 | 处理详情、复制诊断信息 |
| `processingId` | 处理回合 | 高级详情 |
| `requestId` | 请求记录 | 技术详情或日志 |
| `deliveryId` | 投递记录 | 回复状态详情 |
| `intentKey` | 业务记录 | 仅高级诊断，不建议默认显示 |

### 9.2 推荐的处理状态

普通用户可以看到：

```text
已收到
正在处理
已生成回复
正在发送
已交给平台
平台已确认
等待重试
需要检查连接
处理失败
```

不建议默认显示：

```text
traceId=msg-...
requestId=req-...
span=...
worker ack timeout
```

这些内容可以通过“查看处理详情”或“复制诊断信息”提供给技术人员。

### 9.3 诊断详情建议

用户点击“查看处理详情”后，可以看到一条简化时间线：

```text
10:20:01  已收到消息
10:20:01  已交给故事「示例 Story」处理
10:20:04  模型处理完成
10:20:04  生成 2 条回复
10:20:05  第 1 条已交给平台
10:20:06  第 2 条等待发送
```

高级模式中再附加：

```text
消息追踪码：msg-abc
处理回合：proc-1
投递记录：delivery-1, delivery-2
```

### 9.4 “复制诊断信息”而不是复制原始日志

建议提供结构化、脱敏的诊断信息：

```text
项目版本：...
Story：...
消息追踪码：msg-abc
处理状态：已交给平台
处理回合：proc-1
投递记录：delivery-1
错误码：ONEBOT_ENDPOINT_UNREACHABLE
时间：2026-10-04T10:20:06.000Z
```

不要把完整消息正文、Prompt、密钥或 token 拼入诊断文本。

---

## 10. 分阶段实施计划

### P0：协议和 Worker bridge

**目标**：保证新链路从入口到 Worker 的上下文不丢失。

建议工作项：

1. 明确 `traceId`、`requestId`、`processingId`、`deliveryId`、`intentKey` 的定义；
2. 在 Worker bridge 入口生成或验证 `processingId`；
3. 保证入站事件进入 HDSI 前拥有合法 `traceId`；
4. 保证 Worker 发出的每条新 `DesktopDelivery` 继承 `traceId`；
5. 增加协议版本或能力标识，例如 bridge v5；
6. 旧 Worker 没有 `traceId` 时继续走兼容兜底，不破坏当前版本。

**完成定义**：

- 新 Worker 可以将入站 `traceId` 回传到出站；
- Main 不需要依赖 `delivery:<deliveryId>` 作为正常路径；
- 旧 Worker 仍可启动、接收消息和投递消息。

### P1：处理上下文与持久化任务

**目标**：保证延迟、拆分、重试和 Worker 重启后仍可关联。

建议工作项：

1. 增加 Worker 内部 `ProcessingContext`；
2. 使用 `AsyncLocalStorage` 辅助当前调用链日志；
3. 将 `traceId` 写入延迟 intent payload；
4. 将 `traceId` 与 `processingId` 写入出站草稿或等价 metadata；
5. 统一拆分消息的 `intentKey` 规则；
6. 明确模型重试、投递重试和收件箱回放的 ID 继承规则；
7. Worker 重启后恢复任务时重新生成 `processingId`，但保留原 `traceId`。

**完成定义**：

- 延迟任务跨进程重启后仍能找到原始 `traceId`；
- 拆分消息共享正确的 `traceId`；
- 投递重试不会因为新的 `deliveryId` 造成重复业务发送。

### P2：日志检索和用户可见详情

**目标**：让技术人员能查，让普通用户不被技术细节打扰。

建议工作项：

1. 统一日志事件名称和字段；
2. 支持按 `traceId` 查询相关事件；
3. 将 `processingId`、`deliveryId` 和错误码聚合成处理时间线；
4. 在 UI 中提供“处理详情”；
5. 提供脱敏的“复制诊断信息”；
6. 普通模式隐藏内部字段，高级模式可查看完整关联信息。

**完成定义**：

- 用户能够判断消息卡在哪个阶段；
- 支持人员只凭消息追踪码即可定位整条链路；
- 诊断信息不包含敏感内容。

### P3：评估完整可观测性

**目标**：根据实际规模决定是否引入 OpenTelemetry。

只有当以下需求真实出现时，才建议推进：

- 需要跨远程服务查看完整耗时；
- 需要统一分析模型、IPC 和平台投递性能；
- 已有安全的集中式日志/观测系统；
- 已经定义本地隐私、离线和数据保留策略。

---

## 11. 测试与验收标准

### 11.1 基本链路

- 新入站消息生成一个 `traceId`；
- Router、Inbox、Worker 接收和出站投递使用同一个 `traceId`；
- 同一次处理生成明确的 `processingId`；
- 每一条出站记录拥有独立 `deliveryId`。

### 11.2 旧版本兼容

- 旧 Worker 不提供 `traceId` 时，Main 仍能完成投递；
- 旧 Worker 不理解新增字段时，不应因为未知字段崩溃；
- 旧 Inbox 数据可以读取；
- 旧 delivery 记录可以展示和重试。

### 11.3 延迟任务

- 生成延迟任务时保存 `traceId`；
- 重启 Desktop 或 Worker 后再执行，`traceId` 不变；
- 延迟任务可以拥有新的 `processingId`；
- 延迟任务的出站消息可以找到原始入站消息。

### 11.4 拆分与多投递

- 一条长回复拆分成多条时，所有片段使用同一个 `traceId`；
- 每个片段具有独立 `deliveryId`；
- 同一业务片段重试时 `intentKey` 不变；
- Outbox 不会因为重试生成重复业务消息。

### 11.5 失败和恢复

- IPC 超时能通过 `requestId` 定位；
- 模型失败能通过 `processingId` 定位；
- 平台投递失败能通过 `deliveryId` 定位；
- 从任一阶段的日志都能回查到 `traceId`；
- 未绑定、暂停、静音、Worker 不可用等分支不丢失 `traceId`。

### 11.6 隐私检查

- 日志不包含消息正文；
- 日志不包含 Prompt 和模型原始响应；
- 日志不包含 token、API Key 和 secret；
- 诊断导出不泄露账号凭据；
- trace ID 本身不能反推出消息内容或账号秘密。

---

## 12. 风险与边界

### 12.1 Worker bridge 位置需要进一步确认

当前已检查 HDSI 主业务文件 `C:\dev\HDSI-desktop-typ-0\hdsi-sourcecode\src\service.ts`，可以确认其中存在接收、模型处理、延迟 intent、消息拆分和出站生成等业务能力，但未看到完整的 Desktop IPC 协议字段。

这意味着 Trace ID 传播的实际改造点，很可能位于 Worker bridge、适配层、编译产物或运行时注入层，而不是单独的 HDSI service 文件。进入实现阶段前，应先定位该边界，避免把同一套字段重复实现多次。

### 12.2 不能把 Story ID 当成 Trace ID

一个 Story 可以连续处理多条用户消息。Story ID 能说明“哪个故事”，但不能说明“哪一条消息”。两者必须同时保留：

```text
storyId：业务容器
traceId：单条消息链路
```

### 12.3 不能把 deliveryId 当成消息 ID

一条消息可能拆成多个 delivery，也可能延迟发送。`deliveryId` 只能描述一次投递，不能代表整个业务链路。

### 12.4 不能只靠日志文本拼接链路

如果字段没有进入事件、intent、Outbox 和回执结构，只在日志字符串中写出来，重启和恢复后仍然无法可靠关联。因此关联 ID 必须优先进入协议和持久化数据，再由日志投影出来。

### 12.5 兼容字段可选，但新路径必须有规则

当前 `traceId` 在接口中保持可选是合理的兼容策略，但新 Worker/bridge 的规范应明确：

```text
新入站：必须有 traceId
新处理上下文：必须有 traceId + processingId
新出站：必须继承 traceId，并有 deliveryId
```

“可选”只表示可以兼容旧数据，不表示新代码可以随意省略。

---

## 13. 建议的最终决策

建议批准以下技术决策：

1. **保留当前 Desktop 侧 Trace ID 改造，不回退；**
2. **采用 `traceId + processingId + requestId + deliveryId + intentKey` 的轻量级关联模型；**
3. **在 Worker bridge/adapter 边界统一建立和传递上下文；**
4. **在 HDSI 的延迟 intent、拆分消息和出站草稿中持久化必要关联字段；**
5. **使用 `AsyncLocalStorage` 辅助日志读取，但不把它当作持久化方案；**
6. **对旧 Worker 保持兼容，逐步升级到新协议；**
7. **普通用户看到“消息追踪码”和处理时间线，高级诊断才显示完整 ID；**
8. **暂不立即引入 OpenTelemetry；先把业务语义和数据边界做正确。**

一句话概括：

> 先让系统在业务上知道“这一条消息经历了什么”，再让监控系统知道“每个技术步骤耗时多少”。当前最重要的不是增加更多日志，而是让 `traceId` 能够跨越 Worker、HDSI、模型处理、延迟任务和出站投递，并在重启和重试后仍然保持正确。

---

## 14. 参考文件

以下是本次分析直接参考的项目文件：

```text
C:\dev\HDSI-desktop-typ-0\desktop\src\main\runtime\trace.ts
C:\dev\HDSI-desktop-typ-0\desktop\src\main\runtime\contracts.ts
C:\dev\HDSI-desktop-typ-0\desktop\src\main\runtime\message-router.ts
C:\dev\HDSI-desktop-typ-0\desktop\src\main\runtime\inbox-replay.ts
C:\dev\HDSI-desktop-typ-0\desktop\src\main\runtime\outbox.ts
C:\dev\HDSI-desktop-typ-0\desktop\src\main\stories.ts
C:\dev\HDSI-desktop-typ-0\desktop\src\main\main.ts
C:\dev\HDSI-desktop-typ-0\desktop\src\main\runtime\runtime.test.ts
C:\dev\HDSI-desktop-typ-0\hdsi-sourcecode\src\service.ts
C:\dev\HDSI-desktop-typ-0\2026-10-05-new-user-first-run-improvement-plan.md
```

---

## 15. 与当前实施进度的关系

本文不是对已完成代码的否定，而是对下一阶段边界的明确：

```text
已完成：Desktop 主机侧的 traceId 建立与基础串联
下一步：Worker bridge 和 HDSI 处理上下文的显式继承
再下一步：延迟/拆分/重试的持久化关联
最后：面向用户的处理详情和脱敏诊断
```

在没有先定位 Worker bridge 和明确协议入口之前，不建议继续把 Trace ID 逻辑分散地添加到更多业务函数中。最稳妥的做法是先完成 P0 的协议和边界确认，再进入 P1 的持久化传播改造。


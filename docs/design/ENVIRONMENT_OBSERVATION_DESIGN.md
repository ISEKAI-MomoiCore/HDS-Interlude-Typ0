# 环境观察与共享环境共处：叙事配置实验设计

> 状态：实验性前瞻设计，尚未实现
> 适用项目：`HDSI-desktop-typ-0`（桌面壳）+ `koishi-plugin-hds-interlude`（插件）
> 关联架构：vision / video vision、advance 叙事推进、desktop-bridge、持续写作、世界事件播种、SV34 Agency Core
>
> 本文描述一种由 HDSI 自然生成叙事结果的环境观察机制。观察材料进入写作上下文，叙事模型决定主角注意什么、如何理解、是否提及以及如何行动。
>
> “副本环境”在这里指主角与用户共同生活的叙事环境。它主要通过主提示词、故事设定和持续剧本实现。摄像头提供主角可以感知和活动的空间范围，视频或关键帧提供时间连续的观察材料。系统不需要为第一阶段新增独立的空间引擎、行为评估器或物品数据库。

---

## 1. 设计命题

HDSI 的环境观察为角色提供一段连续发生的环境经验，角色在写作中自然形成与用户共处同一空间的感受。

用户的真实环境是一个持续变化的外部世界。主角生活在这个环境对应的叙事空间里，摄像头覆盖范围构成她可以感知和活动的范围。她可以看见用户在房间里走动、蹦跳、离开又返回，甚至看见用户从自己所在的位置穿过。双方没有物理碰撞、触摸或物品操作逻辑，只有持续的共处、观察和写作。

副本环境的边界来自非对称交互：

- 主角和用户处于同一个叙事环境，用户对她保持不可见、不可触的状态。
- 主角可以观察用户的桌子、房间、光线、姿态和移动轨迹。
- 用户的身体活动可以经过主角所在的位置，主角不因此获得碰撞或阻挡用户的能力。
- 主角可以在自己的位置活动、等待、写字、整理物品和改变属于自己的局部空间。
- 用户现实桌面上的物品属于用户的环境，主角可以感知其状态，无法移动、拿取或改变。
- 主角拥有的笔记本、纸张、杯子、照片和收纳物只存在于叙事空间，用户无法直接看见或触摸。
- 主角与用户之间的直接联系仍然只有现有消息渠道。

对用户来说，这是一位一直在身边共同生活、共同做事，却看不见也摸不到的伴侣。对主角来说，用户才是这个空间中持续活动的另一个存在。这个方向构成“副本环境”的双向性。

## 2. 一个共享空间与一个叙事接口

### 2.1 外部环境

外部环境指摄像头和视频观察模型得到的用户现实空间。它包含用户可见的桌面、房间、设备、姿态、光线和活动，也包含一段时间内可以被观察到的变化。

外部环境是写作材料的来源。它可以受到视角、遮挡、画面质量和模型能力影响，观察结果需要携带时间范围和不确定性。

### 2.2 共享环境是一种叙事设定

共享环境的第一实现形式是一个可以启用或关闭的叙事配置。配置向主模型说明：

- 主角与用户生活在同一个叙事环境中；
- 摄像头覆盖范围是主角当前可以感知和在叙事中活动的空间范围；
- 主角能够感知用户在这个范围内的移动、姿态、活动和变化；
- 用户可以经过主角的位置，双方没有碰撞、触摸、阻挡或物理交互逻辑；
- 主角无法移动、拿取或改变用户现实环境中的物品；
- 主角拥有自己的叙事物品、位置和活动空间；
- 用户无法直接看见或触摸只存在于叙事空间中的主角物品；
- 主角只能通过现有消息渠道与用户联系；
- 主角是否注意、如何理解、是否提及以及如何行动，都在持续写作中自然形成。

这组设定构成角色所处的世界条件。主角在桌边写字、用户从她身边经过、她停下手里的事看向用户，或她继续做自己的事情，均由模型根据当前观察、剧本历史和角色状态自然写出；宿主侧没有“进入桌边”“避开用户”“穿过房间”一类的结构化动作层。

现实物体和主角物品在叙事中具有不同的所有权。现实物体可以被观察和描述；主角物品可以被主角使用和改变。双方共享空间位置，交互权限保持分离。

### 2.3 叙事接口

观察结果、副本环境规则和剧本历史共同进入主叙事模型。主模型仍然以作者视角工作：它书写主角的感知、理解、情感和行为，并决定哪些内容进入剧本。

系统提供世界条件与观察材料，心理判断由主模型的写作完成。副本环境的空间连续性优先来自剧本写作中的反复出现、物品痕迹、活动习惯和场景记忆。

### 2.4 实现层级

| 层级 | 实现方式 | 是否为第一阶段必需 |
|---|---|---|
| 世界观 | 主提示词、故事设定、角色设定 | 是 |
| 观察材料 | 单帧、关键帧或视频摘要 | 视 vision 能力启用 |
| 空间连续性 | 剧本历史和持续写作 | 是 |
| 结构化空间状态 | 可选的辅助摘要或 UI 展示 | 否 |
| 三维/可视化副本 | 后续实验能力 | 否 |

第一阶段应先验证“仅通过叙事设定，主角是否能够自然地生活在副本环境中”。结构化空间层只在写作实践证明需要时加入。

## 3. 连续观察流

### 3.1 观察单位从单帧改为时间窗口

环境观察的基本单位是 `ObservationWindow`，对应一段真实时间和一段叙事推进时间：

```ts
interface ObservationWindow {
  windowId: string
  startedAt: string
  endedAt: string
  durationMs: number
  trigger: 'user-message' | 'advance' | 'timer' | 'manual' | 'resume'
  source: 'video-native' | 'keyframes' | 'single-frame'
  frames?: ObservationFrameRef[]
  clipRef?: EphemeralClipRef
  clock: {
    narrativeTurnId?: string
    narrativeFrom?: string
    narrativeTo?: string
  }
}
```

`startedAt` 与 `endedAt` 表示现实视频时间；`narrativeFrom` 与 `narrativeTo` 表示这段观察对应的叙事推进区间。两组时间不要求相同单位，但必须可以追溯对应关系。

### 3.2 录制方式

宿主可以持续录制短时间视频，并使用内存环形缓冲保存最近窗口。录制内容仅在观察触发时按窗口截取上传，其余始终停留在内存缓冲中。默认策略如下：

1. 摄像头打开后，宿主建立有限长度的内存环形缓冲。
2. 观察触发时，截取与当前叙事推进对应的时间段。
3. 优先将短视频段交给支持视频解析的模型。
4. 视频模型不可用时，从同一时间段提取关键帧，交给图片识别模型。
5. 两种路径都生成带时间范围的观察结果。
6. 当前观察事务结束后，释放原始视频和帧引用。

环形缓冲的长度由配置决定，建议初始范围为 10 至 60 秒。更长的视频用于观察趋势和动作连续性，短窗口用于响应用户消息和即时推进。

### 3.3 视频模型与图片模型的能力协商

宿主在建立观察请求时读取 vision 能力清单：

```ts
interface VisionCapability {
  acceptsVideo: boolean
  acceptsImages: boolean
  maxClipDurationMs?: number
  maxFrames?: number
  supportsTemporalEvents?: boolean
  supportsObjectTracking?: boolean
}
```

选择规则：

- 支持视频且允许当前窗口长度时，发送短视频段；
- 支持视频但窗口超限时，裁剪为多个连续片段或降级为关键帧；
- 仅支持图片时，按运动变化、场景切换和固定时间间隔提取关键帧；
- 两种能力都不可用时，观察事务结束，不向叙事上下文注入虚构结果。

观察接口需要保留 `source`，使叙事上下文知道结果来自连续视频还是离散帧。主模型可以自然地理解“她看见了一个动作过程”和“她只看到几个时刻”。

### 3.4 关键帧提取

关键帧提取由宿主或 vision sidecar 完成。建议结合三类采样点：

- 时间采样：按固定间隔提取；
- 变化采样：光线、人体姿态、物体位置出现明显变化时提取；
- 边界采样：观察窗口开始和结束各保留一帧。

关键帧结果应携带原始时间戳：

```ts
interface ObservationFrameRef {
  capturedAt: string
  relativeMs: number
  imageRef: string
  reason: 'interval' | 'scene-change' | 'motion-change' | 'window-boundary'
}
```

图片识别模型可以根据多帧描述变化，也可以只返回当前状态；变化结论是否进入剧本，由叙事写作决定。

## 4. 观察策略与推进对齐

### 4.1 ObservationPolicy

观察频率需要适应叙事节奏和隐私选择：

| 策略 | 行为 |
|---|---|
| `disabled` | 不启用观察 |
| `manual` | 用户明确触发时采样 |
| `on-user-message` | 用户消息进入时采样一个窗口 |
| `on-advance` | 每次叙事推进采样一个窗口 |
| `adaptive` | 根据叙事活动、上次观察时间和用户设置选择窗口 |

`adaptive` 允许持续存在场景拥有更自然的时间感。它可以在用户长期停留时使用低频观察，在用户主动发消息或场景发生明显变化时提高采样频率。策略只决定何时获取材料，主叙事模型决定材料在故事中的意义。

### 4.2 推进时间映射

每个观察窗口要绑定一个 `turnId` 或 `advanceId`。当一个叙事回合对应较长现实时间时，窗口可以包含多个片段；当多个叙事回合发生在同一现实时间内，系统可以复用同一事务中的观察摘要，但不重复发送原始帧。

推荐的时间关系：

```text
现实视频时间轴：  [t0 -------- t1 -------- t2]
                     \         |
叙事推进时间轴：       [advance N / scene interval]
                                      ↓
                         observation window
                                      ↓
                           narrative writing
```

观察结果必须标明“观察发生的时间段”，避免模型把一段视频中的先后顺序误写成当前状态。

## 5. 副本环境模型

### 5.1 主提示词中的世界条件

第一阶段可以用一段稳定、简短的世界观规则启用共享环境。示例：

```text
SHARED ENVIRONMENT — SCRIPTING CONDITIONS:

You are the author of an ongoing script about a protagonist and a user who inhabit the same narrative environment.
Treat the following as setting and continuity conditions for authored scenes. Do not adopt the protagonist's identity, do not speak as the protagonist by default, and do not simulate a live agent. Describe scenes, actions, dialogue, perception, memory, and emotion according to the active output contract.

The protagonist and the user occupy the same narrative space.
For the current scene, the camera-visible area defines the space in which the protagonist's perception and presence can be established. Observation material describes what can be known about the user's movement, posture, activity, and the visible environment during its stated time window.

The user may move through the protagonist's position. The script contains no collision, touch, blocking, or direct physical interaction between them.
The protagonist cannot move, pick up, or change objects that belong to the user's physical environment.
The protagonist may have personal objects, places, and private traces within the shared narrative space. These objects can be used and changed through authored events.
The user cannot directly see or touch those protagonist-owned objects in the physical environment. They may become known to the user only through narration or messages written into the story.
The available messaging channel is the only direct channel through which the protagonist can contact the user.

Use these conditions to maintain spatial continuity while writing scenes, actions, dialogue, perception, memory, and emotion. Let attention, emotion, activity, and decisions emerge from the ongoing script. Do not force the protagonist to mention every observation, and do not add a separate action or state report unless the output contract requests one.
```

这段规则只定义共同处境、感知范围、空间共处、所有权和通信方式。角色每次观察后的反应由持续写作产生，状态报告仅在输出契约要求时出现。

### 5.2 角色物品由写作产生

角色可以在剧本中自然获得和持续使用自己的物品：

- 一台只有她能使用的笔记本；
- 写满内容的纸张和便签；
- 位于副本桌角的杯子、照片或收纳盒；
- 她用来整理生活的抽屉、盒子或小空间；
- 只在副本环境中存在的灯、窗帘或其他生活物件。

这些物品的状态首先属于剧本事实和角色经历。角色可以写字、整理、移动、损坏、保存或丢失它们。系统不需要为每件物品建立专门的数据库记录，除非未来的 UI、检索、跨设备同步或可视化功能提出明确需求。

### 5.3 用户与现实物体的叙事边界

观察到的用户桌子、屏幕、杯子和房间属于共享环境中的现实部分。主提示词只需保持以下世界条件：

- 主角可以感知用户在可见范围内的状态和移动；
- 用户可以经过主角所在的位置，主角不会阻挡用户，也不会被用户碰撞；
- 主角可以描述、记住或忽略现实物体；
- 主角无法直接改变现实物体；
- 用户对现实物体的操作会在后续观察材料中体现；
- 主角可以在自己的对应位置形成情感、空间关系和生活习惯。

主角可以在现实桌面的对应位置拥有自己的笔记本。她可以在自己的笔记本上写字，同时知道用户现实画面中看不见这本笔记本。这个状态通过叙事逻辑成立，不需要宿主执行物理模拟。

### 5.4 何时需要结构化状态

当出现以下需求时，可以增加可选的 `ReplicaEnvironmentState`：

- 用户需要在 UI 中查看主角的副本空间；
- 需要跨设备同步角色物品；
- 需要对物品进行检索、回放或版本控制；
- Agency Event 需要引用副本中的具体对象；
- 多个模型或多个叙事线程需要共享空间状态。

结构化状态是剧本的辅助索引和工具视图，来源仍然是 ScriptCommit 与持续写作；第一阶段无需它即可运行。

## 5.5 观察材料、角色认知与叙事事实

环境观察最重要的边界是：**看到的内容、模型对内容的解释、角色当前可以使用的认知，以及已经写入剧本的事实，不应被视为同一层东西。**

可以把它理解成一个逐步收敛的过程：

```text
原始材料
  ↓
观察结果：画面中出现了什么、发生了什么变化
  ↓
角色可用认知：她现在可以注意到、相信或怀疑什么
  ↓
叙事解释：她如何理解这些材料，并是否让它影响自己的情绪与行动
  ↓
ScriptCommit：哪些内容被写成可持续的剧本事实
```

例如，“桌面右侧似乎有一个杯子”不等于“用户经常使用这个杯子”，更不等于“她已经知道这个杯子对用户很重要”。后者需要通过持续观察、上下文、角色理解和叙事写作逐步形成。

因此，观察结果适合携带以下几类语义：

- **时间范围**：观察发生在什么时候，描述覆盖了多长时间；
- **来源**：来自视频、关键帧、图片、用户明确说明，还是已有副本环境记忆；
- **确定程度**：明确看见、模型推测、无法确认、被遮挡或已经过期；
- **变化关系**：相对于之前的观察，什么保持稳定，什么发生了变化；
- **叙事可用性**：它可以作为当前写作材料，还是只能作为低置信度背景；
- **保留边界**：它是否只在当前观察窗口有效，是否允许进入副本环境摘要，是否已经被主叙事吸收。

这不是为了把叙事写作变成一个僵硬的知识图谱，而是为了避免视觉模型的一次猜测直接变成世界事实。观察应当给主叙事提供“可以如何理解”的材料，而不是代替主叙事决定“世界究竟是什么”。

## 6. 数据生命周期

环境观察需要区分原始材料、观察解释、可选辅助状态和剧本事实。

### L0：原始视频与关键帧

- 仅存在于摄像头采集、编码、上传和解析事务中；
- 使用内存环形缓冲或临时传输流；
- 默认不落盘、不进入故事数据库、不写入业务日志；
- 观察事务结束后释放应用层引用。

### L1：观察结果

```ts
interface ObservationResult {
  observationId: string
  window: ObservationWindow
  scene?: string
  visibleSignals?: string[]
  temporalChanges?: string[]
  objects?: Array<{
    label: string
    state?: string
    relativePosition?: string
    confidence?: number
  }>
  uncertainty?: string[]
  source: 'video-native' | 'keyframes' | 'single-frame'
}
```

L1 是 vision 模型对观察材料的叙述性摘要。它进入当前写作上下文，主模型可以使用、忽略、误解或延后处理。

### L2：可选的副本环境辅助状态

第一阶段不要求 L2。主角的副本空间由提示词、剧本历史和持续写作维持。

未来如果需要 UI 展示、对象检索、跨设备同步或 Agency Event 引用，可以从 ScriptCommit 中提取空间摘要、角色物品和活动痕迹，形成可重建的辅助状态。L2 的任何内容都应可由剧本重新推导，不能成为叙事唯一来源。

### L3：剧本写作与叙事事实

只有叙事模型在 ScriptCommit 或其他正式写作结果中写下的内容，才进入剧本历史和事实系统；观察结果仅作为写作材料进入上下文。

```text
L0 原始视频 / 帧
        ↓
L1 观察摘要与时间变化
        ↓
主提示词 + 剧本历史 + 持续写作
        ↓
L2 可选空间索引 / 辅助状态
        ↓
L3 剧本文字、角色经历、叙事事实
```

L2 可以缺席，HDSI 仍然可以运行完整的副本环境叙事。

## 7. 叙事集成

### 7.1 上下文注入

建议向 narrator 提供两个并列字段：

```json
{
  "observation": {
    "window": {
      "startedAt": "2026-10-03T10:00:00Z",
      "endedAt": "2026-10-03T10:00:18Z",
      "source": "video-native"
    },
    "scene": "桌面位于窗边，屏幕光照在木质桌面上",
    "visibleSignals": ["用户坐在桌前", "右手持续移动"],
    "temporalChanges": ["用户从屏幕前短暂离开又返回"],
    "uncertainty": ["屏幕内容不可读"]
  },
  "replicaEnvironment": {
    "space": "窗边桌面",
    "texture": "浅色木质桌面，局部被冷白屏幕光覆盖",
    "observedObjects": [
      { "label": "台灯", "interaction": "observe-only", "state": "亮着" }
    ],
    "ownedObjects": [
      { "label": "她的黑色笔记本", "interaction": "read-write", "state": "摊开在桌角" }
    ],
    "currentActivity": "她可以在自己的笔记本上继续写字"
  }
}
```

字段提供作者可用的材料和空间条件。主模型决定角色是否进入场景、是否关注物体、是否发生情感反应、是否把活动写入剧本。

### 7.2 写作中的空间一致性

常设叙事规则可以保持简洁：

- 主角与用户处在同一个共享叙事环境中；
- 摄像头覆盖范围构成主角当前可以感知和活动的空间范围；
- 主角可以看见用户移动，用户可以经过主角所在的位置；
- 双方没有碰撞、触摸、阻挡和现实物理交互；
- 现实物体可以被看见和描述，主角物品可以被主角使用和改变；
- 主角无法直接改变用户现实空间；
- 观察结果带有时间窗口，主角理解到的是当时可见的环境；
- 观察结果可以被注意、忽略、误解或延后写入，叙事结果由持续写作产生。

这些规则描述世界条件，不规定角色每一轮应该采取的情绪或行为。

### 7.3 场景变化的写作

视频窗口提供连续变化线索，例如用户离开、光线变暗、杯子被拿起、门打开。变化线索进入作者上下文后，模型可以把它写成：

- 角色观察到变化并作出回应；
- 角色只记录变化，不立即说出；
- 角色在副本中继续自己的活动；
- 角色因遮挡或间隔产生不确定理解；
- 角色在后续回合才回忆起这段变化。

这些选项之间的取舍由持续写作本身形成。

### 7.4 typ0 的 Presence 视图

typ0 可以提供一个独立的 Presence 界面，用来显示主角当前在共享环境中的叙事活动。这个界面属于观察和呈现层，不承担动作控制。

建议显示：

- 当前摄像头可见范围的简化环境图；
- 主角当前所在的叙事位置或活动区域；
- 主角正在做的事情，例如写字、阅读、整理物品、等待或看向用户；
- 用户当前可见的移动状态；
- 主角自己的物品和局部生活痕迹；
- 最近一次观察窗口和观察质量；
- “可见”“超出范围”“暂时未知”等空间状态。

界面可以采用平面示意、照片叠加、轨道式位置标记或简化房间卡片，三维渲染和主角操控属于后续可选能力。Presence 视图的作用是让用户看到“她此刻正在环境中做什么”，从而把持续写作中的共处关系呈现出来。

主角在 Presence 视图中的位置和活动应当来自当前剧本写作或可选的叙事摘要。界面不应反过来强迫模型生成动作。模型写出“她回到桌边继续写字”后，界面可以呈现这一状态；没有写作依据时，界面显示未知或上一状态的低置信度延续。

## 8. 用户知情、隐私与权限

### 8.1 明确授权

- 环境观察默认关闭，启用需要明确 opt-in；
- 宿主界面显示摄像头状态、当前观察策略和最近观察时间段；
- 摄像头工作时显示系统级或应用级指示；
- 用户可以随时暂停观察，暂停后不再创建新的观察窗口；
- 视频默认不采集音频，音频观察需要单独授权；
- 屏幕共享、窗口捕获和摄像头观察分开授权。

### 8.2 数据边界

建议提供全局、故事和设备三个层级：

| 层级 | 控制内容 |
|---|---|
| 全局 | 摄像头授权、音频授权、默认观察策略、数据保留策略 |
| 故事 | 是否允许共享环境、主角可见范围、是否允许形成空间记忆 |
| 设备 | 摄像头来源、最大窗口、模型能力、遮罩区域 |

### 8.3 遮罩与敏感区域

用户可以设置固定屏幕遮罩、区域遮罩和临时暂停。屏幕文字、文件名、密码输入、第三方在场和私密物品可以从观察视频或关键帧中被遮挡。遮罩应在发送给模型前执行，确保模型无法读取被遮挡内容。

### 8.4 生命周期承诺

系统可以明确承诺：

- HDSI 不将原始视频写入故事数据库；
- HDSI 不把原始视频写入业务日志；
- 观察事务完成后释放应用层引用；
- 副本环境和剧本条目只保存必要的叙事状态；
- 用户可以删除副本环境状态和由观察产生的剧本条目。

操作系统缓存、模型供应商短期处理和硬件驱动行为超出应用层控制范围，需要在部署说明中单独列出。

## 9. 技术实现轮廓

### 9.1 桌面侧

```ts
interface EnvironmentObservationRequest {
  requestId: string
  policy: 'manual' | 'on-user-message' | 'on-advance' | 'adaptive'
  window: { startedAt: string; endedAt: string }
  capability: VisionCapability
  masks?: Array<{ x: number; y: number; width: number; height: number }>
}

interface EnvironmentObservationResponse {
  requestId: string
  status: 'ready' | 'disabled' | 'permission-denied' | 'expired' | 'unavailable'
  source?: 'video-native' | 'keyframes' | 'single-frame'
  clipRef?: EphemeralClipRef
  frames?: ObservationFrameRef[]
  expiresAt?: string
}
```

宿主维护采集权限和短时缓冲。桥接层传递一次性引用或受时限保护的流，不建议把完整视频 base64 长期塞入 `advance-trigger` payload。插件通过 request/response 消费观察事务，消费结束后引用失效。

### 9.2 插件侧

```ts
async function observeEnvironment(
  request: EnvironmentObservationRequest,
): Promise<ObservationResult | null> {
  const material = await observationProvider.consume(request)
  if (!material) return null

  return vision.describeTemporalScene(material)
}
```

插件侧负责调用已有 vision 通道或视频 sidecar，解析时间窗口和观察来源，并将 L1 观察结果注入 narrator。第一阶段不要求插件维护独立的副本环境服务。

### 9.3 主提示词配置

副本环境可以作为故事级或角色级实验选项：

```ts
interface NarrativeEnvironmentProfile {
  enabled: boolean
  promptBlock: string
  observationPolicy: 'disabled' | 'manual' | 'on-user-message' | 'on-advance' | 'adaptive'
  allowSharedPresence: boolean
  allowPrivateObjects: boolean
  allowPresenceView: boolean
}
```

启用时，`promptBlock` 进入主提示词或故事设定上下文。观察材料通过现有 narrator payload 进入写作。主角的存在位置、活动和物品变化直接由 ScriptCommit 记录；Presence 视图可以读取这些写作结果。

### 9.4 可选的辅助索引

当 UI 或 Agency Core 需要读取副本空间时，可以从剧本条目异步生成摘要：

```text
ScriptCommit
  → optional narrative extractor
  → optional ReplicaEnvironmentIndex
  → UI / search / Agency Event
```

这个索引属于派生数据，可以重建、失效和删除；主叙事没有它也能继续运行。

### 9.5 视频与图片模型的统一适配

建议定义统一的 `describeTemporalScene(material)` 接口。视频模型和图片模型都返回 `ObservationResult`，差异保留在 `source` 与可选字段中。这样可以先使用关键帧路径验证叙事设定，再接入支持视频的模型，不需要改动 narrator 的叙事接口。

## 9.6 从环境观察到 HNSU 在场的可行连接

环境观察首先服务于 HDSI 的 Narrative Core：观察材料进入主叙事后，角色可以选择注意、忽略、误解、记住，或者在之后的剧情中重新提及。它不要求每一个观察窗口都产生消息，也不要求每一次变化都成为剧情。

当 HNSU 在场模式启用时，观察还可以被 Agency Core 作为实时上下文消费：

```text
环境观察窗口
    ↓
可用的当前环境上下文
    ↓
HNSU Agency Core 判断在场反应
    ↓
姿态 / 视线 / 动作 / 声音 / Presence 事件
    ↓
（可选）形成候选经验，回到 HDSI Narrative Core 重新理解
```

这里的回流是“经验材料回流”，不是“实时动作直接改写剧本”。例如，HNSU 可以根据用户回到房间这一变化让角色抬头、停下手里的动作，甚至产生一句临时的声音回应；至于这件事是否成为她之后会记住的“用户回来了”“她等待过用户”或关系上的新事实，仍由 HDSI 的叙事核心在合适的时机处理。

同样，Presence 也不应反向成为现实世界的强制物理层。角色在画面中的位置、姿态和光影是对叙事状态的显形；用户是否注视、靠近或移动摄像头，可以成为新的观察材料，但不应自动等同于角色已经被触碰、回应或改变了某个长期关系事实。

## 10. 与现有系统的关系

| 系统 | 关系 |
|---|---|
| 离线注意力 | 观察提供用户环境材料，离线注意力决定消息是否进入角色可见范围 |
| 世界事件播种 | 观察提供现实环境线索，世界事件提供虚构世界事件；两者可以在写作中交织 |
| agency / urge | 观察可以成为角色欲望和行动的叙事材料，联系门控仍由现有系统处理 |
| 事实系统 | 只接收 ScriptCommit 或正式叙事条目，不直接接收原始观察 |
| vision | 复用图片识别和新增视频解析能力，统一为时间窗口观察结果 |
| SV34 Agency Core | 共享环境为持续存在提供共处场景，后续 Agency Event 可以表达主角在可见范围内的叙事活动 |
| desktop bridge | 提供观察请求、一次性媒体引用、能力协商和状态回报 |

## 11. 边界情况

| 情况 | 处理 |
|---|---|
| 观察暂停 | 不创建新窗口；叙事上下文标记观察已暂停，是否写入故事由模型决定 |
| 摄像头权限被拒 | 返回 `permission-denied`，不伪造场景描述 |
| 视频模型不可用 | 降级关键帧；关键帧也不可用时结束观察事务 |
| 关键帧数量超限 | 优先保留边界帧和变化帧，记录采样降级 |
| 用户离开画面 | 作为观察结果提供，不要求生成特定解释 |
| 现实物体被遮挡 | 将对应投影标记为 `occluded` 或 `unknown` |
| 现实物体长期未出现 | 保留副本中的历史投影并标记过期，不自动删除角色相关叙事 |
| 用户移动现实物体 | 后续观察更新投影，角色可以在写作中理解变化 |
| 角色物品不在现实画面中 | 保留在副本环境中，标记为角色拥有物体 |
| 连续窗口画面无变化 | 返回稳定状态，是否被角色注意由写作决定 |
| 多个叙事回合复用窗口 | 复用 L1 摘要，避免重复传输 L0 原始素材 |
| 多人进入画面 | 只提供可见信号和不确定性，第三方识别与记忆需要额外授权 |
| 黑屏、镜头遮挡或过曝 | 返回观测质量状态，不替模型生成房间事实 |
| 副本空间与现实空间关系改变 | 由后续观察和叙事写作逐步重建，不强制瞬时重置 |

## 12. 开放问题

1. 视频窗口的默认长度应根据模型成本、用户设备和叙事节奏自适应到什么范围？
2. Presence 视图应当以平面示意、照片叠加还是简化房间卡片呈现主角活动？
3. 用户是否可以向共享环境中的主角设定只属于她的初始物品？
4. 角色物品是否可以通过文本、图像或其他输出方式向用户展示？
5. 现实空间发生长期迁移时，剧本如何保留主角对旧空间的生活痕迹？
6. 视频观察是否需要独立的时间回放层，供主角在叙事中回想一段观察窗口？
7. Presence 视图如何表达主角超出摄像头范围、暂时未知或正在进行非公开活动？
8. 在群聊或多用户环境中，共享环境的观察主体和授权边界如何确定？

这些问题属于后续叙事和产品实验，不应提前固化为限制主模型的规则。

## 13. 可行路径（非冻结式）

以下顺序只是为了说明能力之间的依赖关系，不是版本承诺、接口冻结或必须遵守的项目排期。任何一项能力都可以根据真实体验、模型能力和设备条件前后调整。

| 方向 | 内容 | 主要验证问题 |
|---|---|---|
| 观察协议 | 定义 `ObservationPolicy`、时间窗口、能力协商和一次性引用协议 | 观察边界、权限和降级是否清楚 |
| 合成材料 | 使用合成视频或本地测试片段，完成关键帧提取和统一观察结果 | 时间对齐、不确定性和降级路径是否可靠 |
| 叙事共处 | 编写共享环境主提示词配置，使用合成观察数据进行持续写作测试 | 主角能否自然与用户共处、注意或忽略环境 |
| 连续窗口 | 接入单次视频窗口或关键帧窗口，注入 narrator 上下文 | 连续观察如何影响写作节奏 |
| 空间连续性 | 根据 ScriptCommit 观察角色物品、空间痕迹和活动是否自然持续，并验证 Presence 视图读取路径 | 是否可以先依靠叙事而不是独立空间引擎维持连续性 |
| 辅助索引 | 按实际需求增加可选空间索引、用户查看和删除能力 | 哪些空间状态值得结构化保存 |
| HNSU 连接 | 与 SV34 Agency Core 对接，将副本环境中的叙事活动映射到 Agency Event | 观察、在场表达和叙事回流能否保持边界 |

一个较稳妥的可行方向是先使用合成观察数据验证协议、时间轴、提示词和持续写作逻辑，暂时不需要启用真实摄像头，也不会引入用户隐私数据；但这只是低风险起点，不构成固定的实施顺序。

## 14. 设计结论

副本环境的核心实现是给 HDSI 的主叙事模型补充一组稳定的共享环境条件：主角与用户生活在同一空间，主角可以感知摄像头覆盖范围内的用户和环境，用户可以在她身边活动甚至穿过她所在的位置，双方保持不可见、不可触的非对称共处，主角无法改变用户现实，只能通过消息联系用户。

这组设定一旦进入持续写作，主角就可以自然地产生“她在桌边写字”“用户从她身边跑过去”“她看见用户在房间里来回走动”“她继续做自己的事情并等待用户回来”等剧情。物品、空间、行动和情感都由剧本逐步建立，HDSI 的 ScriptCommit 负责保留这些结果。

连续视频观察解决“她获得的是一个瞬间还是一段经历”的问题。它属于观察材料管线，能够增强叙事的时间感。共享环境世界观解决“她和用户如何同时生活在这里”的问题。它属于主提示词和故事设定，能够直接作为实验性剧情配置启用。

Presence 视图可以把剧本中的活动呈现给用户，让用户看到主角此刻在环境中做什么。结构化空间索引、物品检索和 Agency Event 适配都可以在后续按需求增加，主角与用户的共享环境叙事无需等待这些能力。



---

## 15. 最新技术实现澄清：HNSU 的动作后用户视角观察闭环（2026-10-05）

本节不删除前文关于环境观察、连续窗口、视频模型、隐私边界和共享环境叙事的任何设计；它补充一个面向 HNSU 在场模式的特殊观察路径。普通 HDSI 环境观察与 HNSU 动作后观察可以并存，服务于不同的时间尺度和叙事目标。

### 15.1 HNSU 不以持续上传完整视频为核心机制

环境观察文档前文讨论的连续视频窗口仍然是可行的观察材料路径，但对于 HNSU 的初始 AR 在场闭环，默认不需要持续上传完整视频。HNSU 的观察由 Agency Action Frame 驱动：一次 Agency Core 调用生成一帧动作，呈现后拍摄一张用户视角图片，再将图片与结构化数据交给下一次 Agency Core。

```text
当前用户视角
    ↓
结构化场景数据 + 视角图片
    ↓
Agency Core 生成一个动作帧
    ↓
呈现动作帧
    ↓
动作后用户视角图片 + 动作结果
    ↓
下一次 Agency Core
```

这种方式保留了“bot 活在用户可视视角中”的核心设定，同时避免默认把完整视频流持续上传给模型。持续窗口、关键帧窗口和视频模型可以作为后续按需启用的增强材料，而不是 HNSU 最小闭环的必要前提。

### 15.2 AgencyObservationPackage：图片与数据共同构成叙事观察

HNSU 的一次观察包可以包含：

```ts
type AgencyObservationPackage = {
  viewImage: ImageRef
  viewTimestamp: string
  cameraPose?: CameraPose
  fieldOfView?: FieldOfView
  sceneDelta?: SceneDelta
  visibleUserState?: UserState
  lightingState?: LightingState
  spatialRelations?: SpatialRelation[]
  previousFrameId?: string
  previousActionStatus?: ActionStatus
  viewSemantics?: {
    cameraOwner: 'user'
    selfPresenceIncluded: boolean
    selfPresenceFrameId?: string
    selfPresenceRegion?: Region
  }
}
```

图片不只是用于识别物体，也提供用户实际看到的画面关系、光照、细节、Presence 外观、遮挡和距离感。结构化数据用于稳定地表达位置、变化、空间关系、动作是否完成以及观察质量。两者共同进入 Agency Core 的叙事上下文；具体字段可随设备和模型能力调整。

### 15.3 bot 出现在用户视角中是连续性材料，不是反馈污染

HNSU 的提示词应明确告诉模型：它以叙事者视角工作，输入是用户看到的视角，画面中的 bot 是叙事主体自身在上一帧动作中的显形。模型不需要把 bot 识别为一个外部陌生角色，也不需要删除或隔离 Presence 区域。

这意味着以下链路是有意设计的：

```text
上一帧 Agency Action
    ↓
bot 在用户视角中的实际显形
    ↓
动作后观察包
    ↓
Agency Core 继续写下一帧剧本
```

可选的 `viewSemantics.selfPresenceFrameId` 和区域信息只用于帮助模型对齐自身显形与上一帧，不是为了构造另一套无 Presence 的原始输入。

### 15.4 与普通环境观察层级的关系

前文的 L0 原始材料、L1 观察结果、L2 辅助索引、L3 叙事事实仍然成立。HNSU 动作后观察可以映射为一个特殊的观察事务：

- L0：动作后用户视角图片，以及设备允许时的局部短窗口或关键帧；
- L1：从图片和结构化数据得到的场景变化、空间关系、光照、遮挡和动作结果；
- L2：可选的设备/空间索引，用于快速读取上一帧与当前帧的关系；
- L3：Agency Core 通过极短剧本片段产生的在场叙事结果；是否进入长期 ScriptCommit，仍由共享叙事机制和具体写作策略决定。

因此，动作后图片不是绕过叙事直接写入事实账本的通道。它是下一次叙事的材料；图片中“看见了什么”与剧本中“角色如何理解和记住”仍然保持区分。

### 15.5 观察包与动作帧的轮次关联

为了支持连续性，观察包应当能够引用上一帧动作，并记录动作的真实呈现状态：

```text
AgencyTurn
  ├─ inputView: 当前用户视角观察包
  ├─ actionFrame: 本次 Agency Core 生成的一个动作帧
  ├─ presentationStatus: 呈现 / 中断 / 失败 / 完成
  └─ outputView: 动作后用户视角图片
```

`outputView` 成为下一轮的 `inputView`。如果动作被中断、设备不可用或视角捕获失败，也应如实记录状态，让下一次叙事知道上一帧没有按计划完成，而不是将设备失败伪装成剧情成功。

### 15.6 不冻结的观察实现路径

1. 先使用合成图片与结构化数据验证观察包和提示词语义；
2. 在桌面固定机位上验证“单帧动作—动作后捕获—下一帧叙事”的循环；
3. 在 AR 设备上以用户视角单帧捕获作为默认观察方式；
4. 当某些场景确实需要时间信息时，再按需加入短时视频窗口或关键帧集合；
5. 继续保留前文的连续观察、视频模型和隐私设计，把它们作为增强能力与实验路径，而不是删除或否定。

本节只说明 HNSU 的最小动作后观察闭环，不冻结媒体协议、采样频率、模型供应商或最终硬件方案。

---

## 16. 概念一致性补充：HNSU 的观察是“动作后用户视角回合”（技术路径，不删改前文）

> 本节补充 HNSU 专用的观察闭环，不删除前文关于 L0–L3 分层、连续视频窗口、隐私边界、普通 HDSI 观察、共享环境和后续视频模型的任何内容。它只说明在场模式下的一条更贴合当前构想的实现路径。

### 16.1 环境观察不必以持续完整视频作为最小闭环

HNSU 的核心观察节奏可以由 Agency Action Frame 驱动，而不是由持续上传完整视频驱动：

```text
当前用户视角图片 + 结构化环境数据
        ↓
Agency Narrative Core
        ↓
一个极短剧本片段 + 一个 Agency Action Frame
        ↓
Presence / Voice / World Action 呈现
        ↓
拍摄动作后的用户视角图片
        ↓
图片 + 结构化数据 + 上一帧呈现状态
        ↓
下一次 Agency Core
```

持续视频、短时窗口和关键帧集合仍可以在“需要时间信息”的场景中按需启用，但它们不是 HNSU 最小动作—观察—续写回路的必要前提。

### 16.2 AgencyObservationPackage 是图片与结构化叙事材料的组合

观察包的字段定义以 §15.2 为准（EO 内单一权威定义；SV34 §11.4 的同构副本随其概念模型阅读）。要点复述：图片提供用户实际看到的空间关系、光照、遮挡、物体细节和 Presence 外观；结构化数据提供稳定的位置、变化、动作结果、设备状态和观察质量；上一帧引用（previousFrameId / previousActionStatus）把观察材料和剧本动作连接起来。具体字段可以随硬件、模型和隐私策略调整。

### 16.3 一次 Agency Turn 只形成一个动作帧

HNSU 的轮次不是“模型先规划许多低级动作，再由执行器逐个播放”，而是一次调用对应一个 `Agency Action Frame`：

```text
AgencyTurn
  ├─ inputView: 当前用户视角观察包
  ├─ actionFrame: 本次 Agency Core 生成的一帧动作
  ├─ presentationStatus: 呈现 / 中断 / 失败 / 完成
  └─ outputView: 动作后用户视角图片
```

`outputView` 成为下一轮的 `inputView`。动作帧内部可以有动画过渡，但其叙事来源只有一次 Agency Core 调用。动作未完成、设备不可用或捕获失败时，必须如实记录，让下一次叙事知道真实世界发生了什么。

### 16.4 视角图片包含 Presence 是有意的连续性材料

HNSU 的提示词应说明：模型作为叙事者工作，输入是用户看到的视角，画面中的 bot 是叙事主体上一帧动作后的显形。因此 bot 出现在图片里不是“模型看到自己后造成反馈污染”，而是角色连续存在于用户视角中的设计前提。

```text
上一帧动作
        ↓
bot 在用户视角中的显形
        ↓
动作后观察包
        ↓
Agency Core 续写下一帧剧本
```

不需要强制删除 Presence，不需要强制提供无 bot 的 raw image，也不需要把这一条回路解释成外部角色识别。可选的 `viewSemantics` 只帮助模型识别相机归属和自身显形来源。

### 16.5 HDSI / HNSU 的单主动核心假设

共享叙事账本可以被两个运行表面读取，但在当前技术路径假设下，HDSI 与 HNSU 分开运行，同一时刻只运行一个主动叙事核心：

```text
共享叙事世界
        ↓
当前运行表面
  ├─ HDSI：Narrative Core → 对话 / 消息
  └─ HNSU：Agency Narrative Core → 动作帧 / Presence / 语音 / 世界动作
```

因此这里主要要解决的是单回合的中断、恢复、呈现状态和观察回传，而不是两个模型同时写入账本产生的并发冲突。若未来产品形态真的允许双面同时运行，再单独讨论仲裁；当前文档不以双面并发为实现前提。

### 16.6 观察事实与叙事理解仍然分层

动作后图片和结构化数据是观察材料，不等同于角色已经形成的长期事实。可以继续保持：

- L0：动作后用户视角图片、设备原始测量、按需短窗口；
- L1：物体、空间、光照、遮挡、用户状态和动作结果等观察结果；
- L2：用于比较前后帧的空间索引、缓存和辅助特征；
- L3：Agency Core 通过极短剧本片段形成的在场叙事理解，以及在合适时机回流共享叙事世界的候选材料。

这一分层不是为了削弱剧本化，而是为了让“看见”“如何理解”和“如何长期记住”仍然由不同的叙事层次负责。

### 16.7 不冻结的验证路径

1. 先用合成用户视角和结构化数据验证 Agency Core 的提示词与动作帧输出；
2. 在 typ0 固定机位验证一帧动作呈现和动作后捕获；
3. 注入动作中断、设备故障、视角捕获失败，验证状态如实回传；
4. 在 AR 中使用用户视角单帧捕获作为默认观察方式；
5. 只有在具体场景需要时间连续信息时，再加上短窗口或关键帧集合；
6. 继续保留前文的普通环境观察与视频方案作为增强路径，不把本节固化为唯一媒体协议。

本节是技术实现思路与概念补充，不是工程阶段表、最终接口或设备规格。
---

## 17. Agency Core 低延迟路径对观察包组装的补充

> 本节是与 Agency Core 低延迟设计相配套的观察侧技术路径，不删除前文关于 L0–L3、连续视频、短窗口、隐私、视频模型或普通 HDSI 观察的任何内容。Agency Core 的结构比较见 `SV34_AGENCY_CORE_VISION.md` 的相关新增章节。

### 17.1 观察包组装应尽量避免无必要的串行模型链

动作后的图片捕获、设备姿态读取、时间戳、空间关系、上一帧状态和本地可确定的场景差分，可以并行或尽早准备。除非具体场景确实需要视觉模型提取额外语义，否则不应默认采用：

```text
先调用视觉模型总结图片
        ↓
再把总结交给 Agency Core
        ↓
再生成动作帧
```

更短的默认路径是：

```text
动作后用户视角图片 + 本地 / 已有结构化数据
        ↓
一次 Agency Core 叙事调用
```

视觉模型或短时视频分析仍可作为按需增强，但其是否加入应由信息价值和端到端延迟共同决定。

### 17.2 观察材料的缓存与新鲜度

上一帧引用、稳定的空间锚点、角色 Presence 元数据和不变设备信息可以缓存；当前用户视角、动作呈现状态、用户状态和场景变化必须标明所属回合与时间。缓存的目的只是减少重复准备，不是让 Agency Core 读取过期的世界状态。

观察包若因捕获失败、设备延迟或图像编码失败而不完整，应明确记录缺失状态，让 Agency Core 以不完整观察继续叙事或选择保守动作；不能把“没有捕获到”伪装成“没有发生变化”。
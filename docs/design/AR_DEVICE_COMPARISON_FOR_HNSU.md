# AR 设备对比：HNSU 开发功能完备性（2026-09 时点）

> 对照 `SV34_AGENCY_CORE_VISION.md` 的 AR 路径构想，评估四台设备的**开发者 API 完备性**——不做硬件情怀对比，只看 HNSU 要用的部分。
> 参评版本取 2026 年 9 月各自最佳：Apple Vision Pro（visionOS 26）、Samsung Galaxy XR（Android XR）、Meta Quest 3（Horizon OS，Quest 4 最早 2027 底）、PICO（现售 PICO 4 Ultra + 2026 PICO Space 系列）。

---

## 一、HNSU 从设备侧需要的六项能力

从 SV34 的动作帧循环提炼（一次 Agency Core 调用 = 一帧动作 → 呈现 → 拍用户视角 → 下一帧）：

| # | 能力 | SV34 依据 |
|---|---|---|
| C1 | **用户视角捕获**：每帧动作后拿到一张 POV 图（含她在画面里的显形），作为下一帧叙事材料 | "动作完成或达到适合观察的节点后，再拍摄一张用户视角图片" |
| C2 | **场景校准 + 锚点持久**：她出现在固定锚点，跨会话位置稳定 | "回家戴上 AR → 场景校准 → 她出现在锚点" |
| C3 | **她的显形渲染**：3D 角色锚点渲染、被真实家具/人体遮挡、与环境光照融合 | PRESENCE_RENDER_DESIGN + "姿态、视线、表情、声音、光影" |
| C4 | **注意力/视线输入**：用户 gaze/头部朝向作为观察材料（她是否被看着） | "用户与角色的空间关系" + 视线由潜流接管（她的视线是渲染输出；用户的视线是输入） |
| C5 | **语音双工 + 空间音频**：IM 协议的语音通道 | "语音 + 动作 + 空间存在" |
| C6 | **联网 Agency Core**：WebSocket/HTTP 到桌面主机；离线降级本地轻量模式 | "渲染执行（AR 端）只是 IM 协议的薄客户端" |

全天佩戴不在本轮评分——SV34 已明确那是 2027-2028 消费级的事，四台都不及格，不构成区分度。

---

## 二、核心对比矩阵

评分：✅ 完备可用｜⚠️ 存在但有限制｜❌ 无路径

| 能力 | Vision Pro (visionOS 26) | Galaxy XR (Android XR) | Quest 3 (Horizon OS) | PICO 4 Ultra / Space |
|---|---|---|---|---|
| **C1 用户视角捕获（原始相机帧）** | ⚠️ App 内原始帧仅企业授权（个人开发者无路径）；**但 AirPlay 镜像抓帧是消费级可用旁路**（见 §三） | ⚠️ **政策开放但实机未验证**：2025-02 Google 官方确认 Camera2/CameraX 可取 `camera_id=0`（世界向主相机流）；但 2026-06 设备级证据显示零售 Galaxy XR 上无公开文档化的原始透视相机路径，Unity AR Foundation 明确"Image capture is not supported"，且无实机报告验证——**买回来第一步跑 Camera2 帧测试才能定论**（详见 §五） | ⚠️ Passthrough Camera API（Camera2）存在，但需 Meta entitlement + 隐私审核，消费级 App 不可用 | ⚠️ 透视为合成器层级（video see-through layer），原始帧无公开文档路径 |
| **C1b 结构化场景观察（无像素替代路径）** | ✅✅ 最强：ARKit 场景重建 mesh、平面、光照估计、WorldAnchor 全量开放 | ✅ **文档化最全的实时感知栈**：深度图（raw/smooth/confidence）、平面检测、锚点+跨会话持久、手部网格、面部混合形状、眼动、光照估计（球谐）、raycast、物体跟踪——无世界网格（mesh），但深度+平面的组合覆盖同一需求（详见 §五） | ✅ Scene API 带语义标签（墙/桌/沙发），Depth API | ✅ 基础 6DoF + 空间锚点（OpenXR vendor 扩展） |
| **C2 锚点持久** | ✅ WorldAnchor 跨会话持久，场景重建质量最高 | ✅ ARCore anchors + 持久化 | ✅ Spatial Entities 持久化 + 共享锚点 | ⚠️ 企业路径宣称跨会话持久；消费级文档薄 |
| **C3 显形渲染（遮挡/光照）** | ✅✅ RealityKit 实时光照 + 场景 mesh 遮挡，四台里渲染质量天花板 | ✅ Unity/OpenXR + ARCore 深度；Likeness 系统头像可参照 | ✅ Depth 遮挡 + 合成器 pass-through 分层成熟 | ✅ MR layer 基础可用 |
| **C4 眼动/注视输入** | ⚠️ 硬件有；App 只拿到粗粒度 focus/hover（隐私设计），够用做注意力信号 | ✅ `XR_ANDROID_eye_tracking` OpenXR 扩展 + AndroidX EyeTrackingMode，gaze 数据可拿 | ❌ Quest 3/3S 无眼动硬件 | ❌ 4 Ultra 无眼动 |
| **C5 语音 + 空间音频** | ✅ | ✅ + Gemini 系统级语音入口 | ✅ | ✅ |
| **C6 联 Agency Core（WS/HTTP）** | ✅ | ✅ | ✅ | ✅ |
| **本地 AI（离线降级）** | ⚠️ M2 强但无第三方端侧 LLM 通道；Visual Intelligence 是系统级不给 App | ✅✅ 系统级 Gemini 含视觉理解；端侧 AI 是平台一等公民 | ⚠️ Meta AI 系统级，第三方不可调用 | ⚠️ 豆包生态潜在，无公开 API |
| **开发迭代自由度** | ⚠️ TestFlight/开发者设备，审核严 | ✅ Android Studio/adb，Android 生态直接复用 | ✅✅ sideload + App Lab 最自由 | ✅ 企业分发/侧载容易 |
| **国内可得性** | ✅ 国行在售 | ⚠️ 美韩首发无国行；海淘可用，首次激活需 Google 服务，日常侧载运行无碍 | ❌ 无国行（灰市） | ✅✅ 字节国内主场 |

---

## 三、逐台评估

### Vision Pro —— 渲染与场景理解最强；POV 像素有一条消费级旁路

**App 内直接拿原始相机帧：消费级确实无路径。** visionOS 26 把 `CameraFrameProvider` 解放到沉浸空间外、新增 `CameraRegionProvider`（稳定感兴趣区域视频流）和立体深度，但主相机访问依然只对企业授权开放——而 Apple 企业开发者计划要求组织身份（D-U-N-S），个人开发者拿不到。这条路是死的。

**但"把用户视角实时传出去"不等于"App 读相机"。AirPlay 镜像抓帧是消费级可用旁路**：Vision Pro 原生支持把佩戴者完整视野（透视 + App 内容 + 注视指示）通过 AirPlay 镜像到局域网任意接收端（Mac、装接收软件的 PC），延迟约 0.1-0.5s。接收端抓一帧，就是一张含她显形的合成 POV 图——恰好符合 SV34"用户视角图片可以包含 bot 自身的 Presence"的要求。Apple 自己在 WWDC26 的 Group Lab 就用这招看用户视野；2026-09 的 AVP-Inspect 论文用同一路径做自动化采集。代价：画质有损（压缩 + 降分辨率）、多一台局域网接收机、镜像画面是系统合成的（App 无法程序内触发精确取帧，需在接收端定时/触发抓帧）。对 HNSU 按帧拍照（非连续视频）的循环，延迟完全可接受。

**结构化观察这条路则全量开放**：场景 mesh、光照估计、锚点、平面普通 App 都能拿——「她看不见像素，但完全知道你在哪、房间什么样、被什么挡住」的版本随时可跑，且是四台里最干净的隐私合规路线。

加分项：国行在售；RealityKit 渲染质量四台最高；锚点持久与场景重建最成熟。另注：Apple 无公开 MRC（混合现实录制）开发者 API，系统 MRC 走 Final Cut Camera，不构成第三条路径。

### Galaxy XR（Android XR）—— 文档化感知栈最全；相机像素处于"政策开放、实机未验证"状态

**文档化确定可用的**（官方 OpenXR 扩展表，2026-05 更新）：深度图（`XR_ANDROID_depth_texture`，raw/smooth/confidence）、平面检测（`XR_ANDROID_trackables`）、锚点 + **跨会话/跨应用持久化**（`XR_ANDROID_device_anchor_persistence`）、手部追踪与手部网格、眼动（`XR_ANDROID_eye_tracking` + 交互用 `XR_EXT_eye_gaze_interaction`）、面部混合形状、光照估计（球谐）、raycast、物体跟踪。这套感知栈是四台里文档化程度最高的——见 §五的技术深潜。

**相机像素：⚠️ 修正此前"完全可用"的结论。** 证据链分两层：
- **政策层（2025-02，Google 官方口径）**：Android XR 应用可经标准 Camera2/CameraX 取 `camera_id=0`（世界向主相机流，对应手机后置相机语义），走普通 CAMERA 权限；`camera_id=1` 是重建头像流（类似 Persona，非原始内向图像）。设计意图是"相机语义与手机完全一致"。
- **设备层（2026-06，Galaxy XR 零售机）**：[Android XR 帮助社区的产品专家回复](https://support.google.com/android-xr/thread/440703881)明确说"目前**没有公开文档化的 API** 向第三方应用（含企业部署）提供对原始透视/世界相机流的**无限制访问**"，WebXR 不暴露像素，MediaProjection 不含透视画面；[Unity Android XR 相机子系统文档](https://docs.unity3d.com/Packages/com.unity.xr.androidxr-openxr@1.1/manual/features/camera.html)写明 "Image capture is not supported"；官方 OpenXR 扩展表里也只有 `XR_ANDROID_passthrough_camera_state`（仅开/关/初始化状态，无帧）。且**找不到任何实机报告**验证 `camera_id=0` 在零售机上返回真实像素（对比：Quest 3 的 Camera2 路径有大量实机黑帧/受限讨论）。

两种可能：预览期承诺的开放在量产前收紧了；或路径存在但未写入公开文档（"unrestricted" 措辞留了缝隙）。**只能用机器定论：到手第一步跑一个 Camera2 枚举 + 取帧测试 app。** 延迟预期也要修正：即便可用，走的是标准 Android 相机管线（约 30fps、几十 ms 级送达，支持 HardwareBuffer 零拷贝 GPU 共享），不是"零延迟"——对 HNSU 按帧拍照循环依然足够。

**开发与运行依然零 Google/Gemini/互联网依赖**（2025-02 确认的开发者口径不变）：Android XR SDK 是纯开发框架；HNSU MR 端 = 渲染 + SLAM + 采集 + 局域网 WebSocket 到桌面 Agency Core，全本地。国内使用成本 = 海淘 $1,799 + 首次激活梯子 + 无保修。

### Quest 3 —— 迭代最自由，相机有一条窄门

Horizon OS 的 Scene API（带语义标签的房间理解）和 Depth 遮挡是量产最成熟的 MR 开发栈；Passthrough Camera API（走 Android Camera2）是四台里唯一**存在正式申请通道**的相机访问路径——但需要 Meta 的 entitlement 审核 + 隐私理由，面向的是特定用例而非消费 App，个人开发者能否通过没有保证。无眼动硬件是硬伤（C4 直接出局）。无国行。

它最强的其实是工程属性：sideload/App Lab 免审核、$500 档、社区与文档最厚。适合做**相机 entitlement 试验田**和算法原型机（如果能接受灰市购入），不适合做 HNSU 的最终形态验证。

### PICO —— 国内可得性最好，API 开放度是短板但值得观望 2026 新机

现售 4 Ultra：透视停在合成器层级（video see-through layer），原始相机帧没有公开文档路径；无眼动；空间锚点走 OpenXR vendor 扩展，跨会话持久主要在企业叙事里。C1/C4 双缺。

变化在 2026：PICO Spatial SDK（Kotlin/Android 原生）已发布，Unity Integration SDK v3.4（2026-02）仍在活跃迭代，PICO Space 系列（含 4K micro-OLED + 专用 MR 芯片的旗舰）年内落地。字节有国内最强的端侧多模态 AI 资源（豆包），如果 PICO Space 开放相机 + AI 框架，国内 HNSU 路径会突然变宽。**当前是"最实用的日常实验机"，不是"完备性最好的验证机"。**

---

## 四、结论

**纸面完备性排名：Galaxy XR > Vision Pro > Quest 3 > PICO。**
**国内实际可用性排名（修正后）：Vision Pro ≈ PICO > Galaxy XR（海淘+激活摩擦）> > Quest 3。**

HNSU 当前阶段（SV3 末→SV4 初，语义验证优先）的建议：

1. **维持 SV34 既定的桌面/手机先行验证**——四台设备都不改变"先验证动作帧结构与快速叙事提示词，再迁移 AR"的路径排序。设备选型影响的只是 SV4 的迁移目标。
2. **有海淘渠道且接受"相机待验证"风险 → Galaxy XR**：文档化感知栈（深度/平面/锚点持久/眼动/手网格/光照）依然是四台最全且全部确定可用；唯一不确定项是相机像素。**到手验收顺序**：① Camera2 枚举 + `camera_id=0` 取帧测试（像素是否为黑帧/受限）；② `XR_ANDROID_depth_texture` 出图验证；③ 锚点持久化跨会话验证。相机若确实被封，HNSU 在其上跑「结构化观察 + 深度图」版本，POV 像素退回桌面/手机固定机位路径——依然优于其他三台的文档化能力。
3. **国行路线选 Vision Pro，双轨材料**：结构化观察（mesh/光照/锚点）驱动她的显形与空间感知；POV 图像走 AirPlay 镜像抓帧旁路（局域网 Mac 接收，按帧抓取，延迟 0.1-0.5s 对动作帧循环无碍）。渲染质量天花板保证"她的显形"这块最难的经验问题最先得到回答。
4. **PICO 做国内日常实验机 + 观望 PICO Space**：一旦字节开放相机/AI 框架，它同时满足可得性和完备性，届时升级为首选。
5. **Quest 3 只在两种情况下入手**：已有灰市机器，或想提前走一遍 Meta 相机 entitlement 流程。

一个跨设备的架构提醒：C1 在四台上的四种开放度（全开/企业/审核/无）恰恰证明 SV34 的设计是对的——**Agency Core 不应把核心机制建立在持续上传完整视频或保证拿到相机帧之上**。POV 图像是"最好的观察材料"而不是"必需的观察材料"，结构化空间数据是兜底。这个分层让 HNSU 的叙事核心在四台设备上都是可运行的，差别只在观察材料的丰度。另一个已确认的架构事实：**HNSU 的 MR 端不需要互联网**——渲染、SLAM、采集全部本地，唯一网络依赖是到局域网桌面主机的 WebSocket；这让"离线降级"问题从"断网怎么办"收窄为"断连桌面怎么办"。

---

## 五、Android XR 技术深潜（2026-09 核实）

### 5.1 相机帧：能拿到什么、怎么拿、多快

**官方路径（若可用）**：标准 Android Camera2/CameraX，`camera_id=0` = 世界向主相机流（手机后置相机语义），普通 `CAMERA` 权限弹窗；`camera_id=1` = 重建头像流（系统用头/手/眼/面追踪合成的 avatar，非原始内向图像，不可用于环境观察）。OpenXR 层**没有**相机帧扩展——`XR_ANDROID_passthrough_camera_state` 只提供开/关/初始化状态；帧只可能从 Android 相机栈来。

**限制与不确定性**（见 §三 Galaxy XR 节的证据链）：零售 Galaxy XR 上此路径无公开文档、无实机验证；Unity AR Foundation 的相机图像接口（`XRCameraImage`）在 Android XR 包里明确不支持；官方通用指引甚至提醒"部分 XR 设备录制 Passthrough 层会返回黑帧"。**结论：这是"买回来第一小时测试"项，不是规划可依赖项。**

**延迟特性（若可用）**：标准相机管线，约 30fps 级、几十 ms 级送达；支持 `HardwareBuffer` 零拷贝 GPU 共享（图像直接留在 GPU，经 AHardwareBuffer 传入渲染管线，避免 CPU 拷贝）；帧时钟需与 HMD 位姿同步（官方 XR 相机开发指引：运动到光子 < 20ms 是管线设计约束）。"几乎无延迟"的准确表述是：**管线是零拷贝的，送达是几十毫秒级的**——对 HNSU 每帧一张 POV 图的节奏完全够用，对"连续视频流上传"则本来就不是设计目标。

### 5.2 深度图：XR_ANDROID_depth_texture 的传输实现

- **交付形态**：不是 CPU 字节数组，是 **OpenXR 可读 swapchain（GPU 纹理）**——应用调 `xrEnumerateDepthResolutionsANDROID` 查询支持的分辨率（引擎默认档 320×320），再用 `xrCreateEnvironmentDepthSwapchainANDROID` 创建，每帧拿 `RAW` / `SMOOTH` 两个变体（+置信度数组，设计同 Meta 的 `XR_META_environment_depth`；精度特性类比 ARCore Raw Depth：高精度、部分覆盖）。
- **消费方式（两条）**：① **留在 GPU 做遮挡**——把深度重投影进渲染深度缓冲（Godot 的 Android XR 环境深度就是这么实现的），或提交 `XR_KHR_composition_layer_depth` 深度合成层让运行时替你做真实物体遮挡她的身体；② **读回 CPU 传给 Agency Core**——320×320 的深度图做一次 `glReadPixels`/PBO 回读只有几百 KB，按帧节奏（每动作帧一次，非逐渲染帧）传桌面完全可行，桌侧重建她的空间关系（"她在沙发后面""你离她 1.8 米"）。
- **注意**：没有世界网格（`world mesh` 不在 Android XR 扩展表里）——场景几何 = 平面检测 + 深度图的组合，语义标签（墙/地板/天花板/桌）来自 `XR_ANDROID_trackables` 的平面类型。

### 5.3 渲染管线：HNSU 的显形跑在哪一层

Android XR 的应用模型分两个空间：
- **Live Space**（常态主屏）：应用以 2D 面板（SpatialPanel，Jetpack Compose XR）存在，多窗口共存——HNSU 的"待机界面"（她的消息面板）可以住在这里。
- **Full Space**（独占沉浸）：应用接管全视野，**透视由系统合成器作为底衬继续运行**——应用永远不自己合成透视像素，只在其上渲染投影层（OpenXR GLES/Vulkan swapchain，或 Unity/Unreal）。HNSU 的"她显形"跑在这里：透视底衬（系统）+ 她的 3D 存在（投影层，锚定在持久锚点）+ 深度合成层（真实家具遮挡她）。
- 运动到光子 < 20ms 的合成器约束保证她的位置稳定性由运行时兜底；应用帧时钟与 HMD 位姿同步是官方指引的硬要求。

### 5.4 实时可拿数据清单（全部文档化确定可用）

| 数据 | 接口 | 更新率 | HNSU 用途 |
|---|---|---|---|
| 头部位姿 | OpenXR 基础 | 每帧（72Hz+） | 用户在哪、朝向哪、距离她多远 |
| 手部追踪 + 手部网格 | `XR_ANDROID_hand_tracking` / `XR_ANDROID_hand_mesh` | 每帧 | 挥手/指向等手势观察 |
| 眼动注视 | `XR_ANDROID_eye_tracking` + `XR_EXT_eye_gaze_interaction` | 每帧 | 她是否被看着（注意力材料）；注意官方限定 avatar 用途，交互走 gaze interaction 扩展 |
| 面部混合形状 | `XR_ANDROID_face_tracking` | 每帧 | （可选）用户表情观察 |
| 环境深度图 | `XR_ANDROID_depth_texture` | 每帧（GPU swapchain） | 遮挡 + 空间关系（§5.2） |
| 平面 + 类型 | `XR_ANDROID_trackables` | 事件驱动 | 房间布局理解 |
| 锚点 + 跨会话持久 | `XR_ANDROID_device_anchor_persistence` | 持久 | 场景校准：她锚在哪（跨会话稳定） |
| 光照估计（球谐+主光） | `XR_ANDROID_light_estimation` | 每帧 | 她的光影与环境融合 |
| raycast | `XR_ANDROID_raycast` | 按需 | 视线落在什么上 |
| 物体跟踪 | `XR_ANDROID_trackables_object` | 事件驱动 | 键盘/鼠标等已知物体 |
| 透视状态 | `XR_ANDROID_passthrough_camera_state` | 状态 | 透视是否开启 |
| 相机帧 | Camera2/CameraX（`camera_id=0`） | ~30fps | **⚠️ 未文档化/未验证**（§5.1） |

这份清单里除最后一行外的全部，就是 HNSU 在 Galaxy XR 上**不依赖任何运气**就能拿到的实时观察材料——已经足够跑通「结构化观察驱动」的动作帧循环；相机像素若验证通过则是锦上添花。

---

## 六、终局对比：Galaxy XR vs Vision Pro（2026-09，按演化后的 HNSU 架构）

> 标尺 = 本对话演化出的完整架构：观察包（前方照片/全景/presenceSnapshot/spatialFrame）+ 语义场景图（RoomPlan/ConceptGraphs）+ 放置三通道 + R3 全实时三渲二 + 立牌坐标系 + 家具层新鲜度。

### 6.1 逐组件对照

| HNSU 组件 | Galaxy XR | Vision Pro | 优势方 |
|---|---|---|---|
| 度量基础（位姿/锚点/持久锚点） | ARCore 锚点 + `device_anchor_persistence` 跨会话/跨应用 | WorldAnchor + 场景重建，最成熟 | 平手（VP 略优：重建质量） |
| 深度/几何 | 每帧深度纹理（raw/smooth/confidence，320×320 档） | **全房间场景重建 mesh**（持久、免逐帧重建） | 各有形态：Galaxy 逐帧精细，VP 全房间持久 |
| 眼动注视（`lookingAtHer`） | `XR_ANDROID_eye_tracking` 真 gaze 数据 | 仅粗粒度 focus/hover | **Galaxy XR** |
| **语义场景图**（椅子还是箱子） | 无内建，自建 ConceptGraphs 管线（**依赖相机帧验证**） | **RoomPlan 原生**（16 类家具级 + 父子关系 + 房间分区，**不消耗相机授权**） | **Vision Pro** |
| 校准全景 + 每帧照片 | 原生 Camera2（若验证通过：内参+位姿时间戳同步，反投影精确） | AirPlay 镜像抓帧旁路（0.1-0.5s 延迟、无内参/位姿元数据——**只能近似反投影**，照片当"她的眼睛"合格，做空间引用指认勉强） | **Galaxy XR**（若相机验证通过） |
| 像素指认放置的精度 | 原生帧 = 精确反投影 | AirPlay 帧 ≈ 头部位姿按时间戳对齐的近似 unproject（房间级放置误差可接受，精细指认退化） | Galaxy XR（条件成立时） |
| R3 三渲二渲染生态 | Unity/Android 一等公民，MToon/lilToon 直接用，three-vrm 同栈可预研 | RealityKit 原生质感最佳；Unity 走 polySpatial 移植（MToon 适配成本） | **Galaxy XR**（工程便利）；VP 渲染上限略高 |
| 遮挡（她被家具挡） | 深度合成层 / 深度纹理 shader 重投影 | 场景 mesh 自动遮挡（系统级） | 平手 |
| 光照估计（赛璐璐基调） | 球谐（`XR_ANDROID_light_estimation`） | 环境光估计成熟 | 平手 |
| 开发迭代 | adb 侧载即时、Android Studio/Kotlin/Unity 全开 | Xcode/Swift/polySpatial，TestFlight，企业授权流程 | **Galaxy XR** |
| 显示/佩戴 | 4K/眼 micro-OLED，545g + 外置电池 2h | ~3.4K/眼，~620g 一体，2h | Galaxy XR 略轻；VP 生态成熟度补偿 |
| 国内可得性 | 海淘 $1,799 + 一次性激活梯子 + 无保修 | 国行在售（~¥29,999） | **Vision Pro**（省心）/ Galaxy XR（便宜一半） |
| 平台成熟度 | Android XR 一代（SDK 仍在 DP 迭代） | visionOS 三年成熟（26 版） | Vision Pro |

### 6.2 决定性不对称：相机风险的兜底结构

两台机器的相机问题**风险性质不同**：

- **Vision Pro 相机被封，但有系统级兜底链**：语义 → RoomPlan（原生，免授权）；外观/照片 → AirPlay 旁路（近似但可用）；几何/度量 → ARKit 全开。**每一层损失都有替代物**，全管线可跑，代价是照片通道降级为近似。
- **Galaxy XR 相机若验证失败，语义层全失且无兜底**：Android XR 没有 RoomPlan 等价物——没有相机帧就没有 ConceptGraphs、没有校准全景、没有每帧照片，只剩平面+深度+锚点的"无语义几何"。全管线塌掉一半。

即：**Galaxy XR 是"全有或全无"的赌注（买回来第一小时定生死），Vision Pro 是"处处降级但处处能跑"的保底**。反之，Galaxy XR 相机一旦验证通过，它就是唯一全原生精确管线（内参+位姿同步帧 → 精确反投影 + 真眼动 + Unity/MToon 一等公民）。

### 6.3 结论

- **要"现在就能跑通全架构、且在国内省心"→ Vision Pro**：RoomPlan 撑起语义层，AirPlay 撑起照片层，ARKit 撑起度量层，R3 渲染走 RealityKit 或 polySpatial。每层都有答案，无赌注。
- **要"管线原生干净 + 工程迭代最快 + 预算一半"且接受赌注 → Galaxy XR**：到手验收三步（Camera2 取帧 → 深度出图 → 锚点持久化），全过 = 最优解；相机失败 = 语义层归零，需回落 VP 或等待 Android XR 开放。
- **最优现实路径仍是双机**（若预算允许）：VP 做语义/渲染/在场体验的基准机（国行、无赌注），Galaxy XR 做相机/眼动/Unity 迭代的实验机（海淘、一小时验收）。HNSU 的架构是设备无关的（观察包契约 + 放置通道 + R3 标准 VRM/MToon 资产），双机共享同一套资产与叙事核心，恰好验证"渲染器可换"的架构承诺。

---

## 附：事实来源

- visionOS 主相机企业限定：[Accessing the main camera（Apple）](https://developer.apple.com/documentation/visionos/accessing-the-main-camera)、[WWDC24 enterprise APIs](https://developer.apple.com/videos/play/wwdc24/10193/)
- Vision Pro AirPlay 镜像采集：[visionOS Group Lab WWDC26（Apple，用 AirPlay 看用户视野）](https://developer.apple.com/videos/play/wwdc26/)、[AVP-Inspect（arXiv 2026-09，AirPlay→Mac 自动化采集）](https://arxiv.org)、[Vision 辅助功能实测](https://zmknox.com)
- Android XR 透视相机开放：[Meta/Android XR 相机生态报道](https://www.roadtovr.com/android-xr-passthrough-camera-access/)、[Android XR Camera2 实践](https://mike.gold/androidxr_passthrough_camera_access)
- Android XR 眼动扩展：[XR_ANDROID_eye_tracking（Android Developers）](https://developer.android.com/develop/xr/openxr/extensions/XR_ANDROID_eye_tracking)
- Meta Passthrough Camera API：[Camera API（Meta Horizon OS 文档）](https://developers.meta.com/horizon/resources/cameraapiandroid)、[社区反馈 entitlement 门槛](https://communityforums.atmeta.com/t5/Quest-Development/Passthrough-camera-data-is-not-available-on-Quest-3/td-p/1054669)
- Quest 4 时点：[VR Expert：2026 无 Quest 4](https://vr-expert.com/)
- Galaxy XR 规格/上市/无国行：[Samsung Galaxy XR（Wikipedia）](https://en.wikipedia.org/wiki/Samsung_Galaxy_XR)、[Forbes 上市报道](https://www.forbes.com/sites/paulmonckton/2025/10/22/samsung-galaxy-xr-release/)
- PICO 2026 产品线与 SDK：[PICO Space vs PICO 5（VR Expert）](https://vr-expert.com/en-us/pico-space-pro-vs-pico-5-vs-project-swan-what-is-actually-launching-in-2026)、[PICO Unity Integration SDK v3.4](https://github.com/Pico-Developer/PICO-Unity-Integration-SDK/releases)、[PICO Spatial SDK](https://developer.picoxr.com/document)
- PICO 锚点持久（企业）：[VR Vision Group 企业指南](https://www.vrvisiongroup.com)
- Android XR 官方 OpenXR 扩展表：[Build with supported OpenXR extensions（含深度/锚点持久/眼动/手网格/光照估计）](https://developer.android.com/develop/xr/openxr/extensions)
- Android XR 相机政策（2025-02 开放口径）：[SkarredGhost 与 Google 的确认（camera_id=0/1、Camera2/CameraX）](https://skarredghost.com/2025/02/07/android-xr-camera-access-2)、[Road to VR 报道](https://www.roadtovr.com/android-xr-passthrough-camera-access/)
- Galaxy XR 相机现状（2026-06 未文档化证据）：[Android XR 帮助社区帖](https://support.google.com/android-xr/thread/440703881/camera-access-on-galaxy-xr-or-aura-in-future-for-webxr-native-apps)、[Unity Android XR Camera 子系统（Image capture is not supported）](https://docs.unity3d.com/Packages/com.unity.xr.androidxr-openxr@1.1/manual/features/camera.html)、[xr-samples issue #7](https://github.com/android/xr-samples/issues/7)
- XR 相机开发通用指引（帧同步/零拷贝/黑帧提醒）：[Extended reality camera development（Android Developers）](https://developer.android.com/agents/skills/camera/camerax/references/xr)
- 深度图实现：[XR_ANDROID_depth_texture 扩展规范](https://developer.android.com/develop/xr/openxr/extensions/XR_ANDROID_depth_texture)、[Godot Android XR 环境深度（raw/smooth、遮挡重投影）](https://godotvr.github.io/godot_openxr_vendors/manual/androidxr/environment_depth.html)

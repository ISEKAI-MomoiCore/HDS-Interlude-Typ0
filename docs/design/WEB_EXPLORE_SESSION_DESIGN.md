# 网页探索会话：从浏览意图到持续探索（SV3 方向）

> 状态：设计草案——基于现有 BrowserIntent/WebObservation 管线的升级方向，参考 YesImBot World 浏览器实现
> 前置：HDSI 已有 Puppeteer 只读浏览（`collectWebObservation`）、安全域名过滤、缓存、webContext 注入
> 参考：YesImBot World `src/apps/browser.ts`（会话化浏览器 + 分屏 + 编号链接）

---

## 1. 设计目标

让她从"提出浏览意图、等一轮拿到文本快照"升级为**持续探索一个网页会话**：

```
叙事判断她要查东西
  ↓
开一个探索会话（search 或 visit）
  ↓ 返回页面快照（标题/正文分屏/编号链接/图片标注）
她决定下一步（当轮或下轮）
  ↓ open_link(3) / scroll_down / new_search
  ↓ 返回新快照
探索结束（她关闭/切换/超时）
  ↓
探索轨迹成为 WebObservation，进入剧本事实
  ↓
下一次写作基于这些事实
```

## 2. 与现状的差异（三件事）

### 2.1 会话化：从一次性快照到持续探索

现状 `collectWebObservation` 每次开新页、读完即关。升级为：

```ts
interface WebSession {
  sessionId: string
  storyId: string
  /** 谁在探索——探索结果归属此关系分支 */
  participantId: string
  /** 当前页面状态 */
  current: {
    url: string
    title: string
    /** 分屏正文（第 N 屏） */
    screenIndex: number
    totalScreens: number
    /** 页面快照：文本 + 编号链接 + 编号图片 */
    snapshot: WebPageSnapshot
  }
  /** 导航历史（可后退） */
  history: Array<{ url: string; title: string; screenIndex: number }>
  /** 探索轨迹：从开到关的全部快照（供剧本事实沉淀） */
  trail: Array<WebPageSnapshot>
  openedAt: string
  lastActiveAt: string
  /** 超时自动关闭 */
  expiresAt: string
}
```

同一时间一个故事最多一个活跃会话（对齐 YesImBot 的"一次只开一个 App"）。会话有超时（如 5 分钟不活动自动关闭，轨迹入库）。

### 2.2 操作粒度：从 search/visit 到编号导航

页面快照返回给叙事模型的结构（对齐 YesImBot 的 BrowserSnapshot 精简版）：

```ts
interface WebPageSnapshot {
  url: string
  title: string
  /** 当前屏正文（2600 字符/屏，scroll_down 翻页） */
  screenText: string
  /** 编号链接：正文里 [1][2] 标注对应此列表 */
  links: Array<{ n: number; url: string; text: string }>
  /** 编号图片：正文里 {图1} 标注 */
  images: Array<{ n: number; url: string; alt: string }>
  /** 页面元描述（首屏时给，翻屏后省略） */
  description?: string
}
```

叙事模型可产出的探索意图（扩展 `BrowserIntentDraft`）：

```ts
type WebExploreAction =
  | { kind: 'search'; query: string }          // 开新搜索
  | { kind: 'visit'; url: string }              // 开指定 URL
  | { kind: 'open-link'; n: number }            // 点编号链接
  | { kind: 'scroll-down' }                     // 翻下一屏
  | { kind: 'back' }                            // 后退
  | { kind: 'close' }                           // 关闭会话（轨迹入库）
```

**安全边界不变**：只读、公开域名、不登录不填表不下载；`open-link` 只能点快照里存在的编号（不能凭空猜 URL）；每步复用现有的 `isSafePublicWebUrl` 域名过滤。

### 2.3 闭环时机：当轮快照 + 异步事实

两段式（折中 HDSI 的叙事架构与 YesImBot 的当轮闭环）：

- **快照层（快）**：探索动作执行后，页面快照**立即**注入下一次叙事请求的 webContext——即使她没说"关闭"，最新的页面状态也会出现在下一轮写作中。这比现状（必须等完整 observation 完成才能注入）粒度更细；
- **事实层（慢）**：会话关闭（超时/她主动关/叙事推进）时，**探索轨迹**——她去了哪些页、看了什么、翻了多深——沉淀为一条完整的 `WebObservation`（复用现有表和缓存机制），成为正式的剧本证据条目。

这意味着：
- 当轮：她在搜"今天的天气"→ 下轮写作时 webContext 里有搜索结果第一屏
- 她点开第 2 条 → 再下轮里有那页的正文
- 会话关闭 → 一条"她在 [时间段] 探索了 [主题]，看了 [页面数] 页"的完整观察入库

## 3. 上下文注入格式

快照注入 webContext 时用紧凑的叙事化格式（不是原始 JSON）：

```text
[网页探索·进行中] 她正在搜索"上海 明天天气"。
当前页面：DuckDuckGo 搜索结果（第 1/3 屏）
正文：...（2600 字符）
可点链接：[1] 上海天气预报-中国天气网 [2] 明天上海天气... [3] ...
```

叙事模型据此决定：继续 open_link(1)？scroll_down？还是已经够了，基于已有信息回应？

## 4. 叙事模型的探索提示词

扩展 narrator 的 system prompt（webContext 指令处）：

```text
webContext 可能包含一个进行中的网页探索会话。她打开着浏览器，正在逐屏阅读或点击链接。你可以：
- 基于当前屏内容回应或行动（继续对话/引用信息/做判断）
- 产出 webExplore 动作继续探索：open-link(n) 点编号链接、scroll-down 翻下一屏、back 后退、close 关闭浏览器
- 探索是可选的——信息足够时可以不产出任何动作，她会自然合上手机
不要在一轮里产出多个探索动作；每轮最多一步（翻一屏或点一个链接），模拟真实的阅读节奏。
```

## 5. 与现有系统的关系

| 系统 | 关系 |
|---|---|
| BrowserIntentDraft | 扩展为 WebExploreAction（search/visit 向后兼容，新增 open-link/scroll-down/back/close） |
| WebObservation | 快照层新增"进行中"条目（短 TTL）；事实层沿用现有表，会话关闭时写入完整轨迹 |
| webContext 注入 | 新增"进行中会话"段（当前屏 + 可点链接），与现有已完成观察并列 |
| 安全策略 | isSafePublicWebUrl 域名过滤、请求拦截、只读约束全部沿用，open-link 编号校验新增 |
| 缓存 | 搜索结果缓存沿用；会话内翻页/点链接不走缓存（每次都是真实操作） |
| 副本环境（EO） | 现实侧用真实 Puppeteer（本设计）；虚构侧可由主叙事模型生成"她看到的网页"（对齐 YesImBot 双模式，后续） |

## 6. 实施分期

| 阶段 | 内容 | 依赖 |
|---|---|---|
| WE-0 | WebPageSnapshot 提取器：从现有 Puppeteer 页面提取正文+编号链接+图片（复用 collectWebObservation 的开页/拦截逻辑，改为返回快照而非纯文本） | 无 |
| WE-1 | 会话管理：开/关/超时/单活跃；快照注入 webContext（"进行中"格式） | WE-0 |
| WE-2 | 探索动作：open-link / scroll-down / back / close 的执行 + 编号校验 | WE-1 |
| WE-3 | 叙事模型提示词 + 探索意图解析（扩展 BrowserIntentDraft schema + L1 输出格式） | WE-2 |
| WE-4 | 轨迹沉淀：会话关闭时生成完整 WebObservation + 剧本证据条目 | WE-3 |
| WE-5（后续） | 虚构世界双模式（World 侧生成网页内容） | 副本环境设计落地后 |

## 7. 开放问题

1. 探索动作的产出是在主叙事输出里（NarrativeDecision 扩展），还是作为独立侧任务？前者当轮闭环但增加输出复杂度；后者简洁但延迟多一步。
2. 群聊场景是否开放探索会话？（现状 allowGroupTriggeredResearch 默认关；会话化后群聊探索的噪音/成本问题更突出）
3. 会话超时设多久？太短她读不完长页，太长上下文窗口里一直挂着旧页面。建议 3-5 分钟 + 快照只保留当前屏（旧屏不注入）。
4. 她合上手机/睡觉/离开时是否自动关闭会话？（叙事状态变化触发关闭）
5. 视觉感知：探索中的图片编号是否可进侧端识图管线（现有 NarrativeImage 通路）？如果是，她"看"网页里的图比只读 alt 文字更真实。

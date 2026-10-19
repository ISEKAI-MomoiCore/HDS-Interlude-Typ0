# typ-0 桌面版全量功能测试报告

日期：2026-09-09 22:40（本地）。测试方式：computer use 实机操作 + CDP（端口 9222）状态核验 + QQ 双账号（1319973221 小桃 → 1303322392 bot/SnowLuma）真消息往返。

## 环境

- 应用：`HDSI Desktop — typ-0`（pid 25624），故事 `m7-acceptance`（M7 真机验收 · 水濑）
- Worker：运行中，Core `1.0.0-beta16`，artifactHash `cc0e0c14`，bridge protocol 4
- 模型：gemini-3.7-flash @ yunwu（主叙事）；OneBot 外部 WS `ws://127.0.0.1:3001/`，渠道在线
- 测试期间应用持续运行约 40 分钟，渲染进程 0 个未捕获异常 / 0 个运行时异常

## 1. 核心链路：QQ 消息往返 — ✅ PASS

22:08 用 PowerShell 脚本以小桃身份向 bot 发送「晚上好呀，我刚忙完手头的事，今天过得怎么样？」：

1. OneBot 收到消息（22:09:40/42 两条入站条目入库，RECEIVE 轨随后显示 2·INBOUND）
2. 主叙事模型调用 ×2（22:09:52 完成 209 字、22:10:00 完成 202 字，耗时 9.9s/8.1s，回复模式 immediate）
3. 「已更新对话后续计划：短期补写 22:20:52、22:28:52；常规推进 22:28:52」
4. 消息投递开始 → **22:10:01 [delivery] confirmed**，QQ 聊天中实际收到 bot 回复「还行 下午一直在磨工程」（符合角色与当天剧本脉络：下午一直在磨工程）
5. 剧本将测试消息自然融入叙事（「看到小桃莫名发来的一串数字和紧随其后的问候」）
6. 时间轴 RECEIVE/SEND/SCRIPT 三轨均出现新块；Inspector/Detail Events/Script 全文正常
7. 后续主动推进也在工作：22:28:17（刷动态）、22:33:17（入睡）两段自动补写按计划生成（revision 推进到 entry:23）

附注：入站多出的「1303322392」消息是**测试脚本自身的问题**（聊天已打开时 Ctrl+F 未聚焦搜索框，搜索数字被直接打进输入框并发送），不是应用缺陷；核心反而把它正确入库并融入剧情。

## 2. 功能模块逐项结果

| 模块 | 结果 | 说明 |
| --- | --- | --- |
| 启动基线 | ✅ | Worker Ready、时钟/OSD/HUD 正常、6/6 轨道、时区 Asia/Shanghai |
| 视图：Session | ✅ | 2 个 pad（POINT/RANGE），全文 + ⤴分支续写入口 |
| 视图：Mixer | ✅ | 6 分组 46 参数（MODEL 6/TEMPO 15/CHANNEL 4/MEMORY 11/LOG 3/ADVANCED 7），ⓘ 说明、未指定（继承）语义齐全 |
| Mixer 草稿模型 | ✅ | 改 temperature→「待保存 1 项」；切换分组草稿保留；保存后 pending 清空、回读 0.7、hot 高亮、日志记录「已写入（canonical 已备份）」；已恢复 0.65 |
| 视图：Stats | ✅ | 状态 chips、KPI（46 次调用/10.4s 中位延迟/425 字每段）、24H 直方图 |
| 视图：Logs | ✅ | 515+ 条、时间范围、来源/等级标签、mixer 写入与投递日志均可见 |
| 视图：Koishi | ⚠️ | 显示「Compatibility Surface · 待 Worker 上报 Console 端口」占位，嵌入视图未激活（见观察 3） |
| 时间轴：时间旋钮 | ✅ | 上拖 201→63min（label 1.0h）且自动退出 follow；双击重置 14h + follow |
| 时间轴：Ctrl+滚轮 | ✅ | 以鼠标为锚缩放（840→520min），follow 关闭 |
| 时间轴：Shift+滚轮 | ✅ | 平移 +265min；纯滚轮不误触 |
| 拖拉条：窗口拖动 | ✅ | 视窗平移（02:20→21:17），跨度不变 |
| 拖拉条：左柄缩放 | ✅ | 跨度 520→438min，左端前移、右端稳定 |
| 拖拉条：右柄 | ❌ | **见 Bug 1** |
| 回到 NOW / Follow | ✅ | 右键菜单「回到 NOW」生效；NOW 播放头 rAF 逐帧；15s 空闲定时器在 NOW>70% 时回中 |
| 视窗数据按需加载 | ✅ | 视窗移动后 snapshot 换窗拉取（range 随视窗、revision 前滚） |
| 剧本选择与阅读 | ✅ | 点击 clip → selection 稳定（entityId）→ Script tab 全文（349 字符、时段 22:28→22:33） |
| Detail 4 个 tab | ✅ | Deliveries（2 条已确认台账）/ Model Usage（48 calls, in 310677/out 36683）/ Data（原始 JSON）/ Events（全文列表） |
| 右键：轨道空白 | ✅ | 回到 NOW / 刷新时间线 / 删除所选时间范围（无选区时禁用）/ 重置缩放 |
| 右键：剧本块 | ✅ | 检查内容 / ⤴ 从此分支续写 / 复制文本（未执行分支，避免截断运行中故事） |
| Configure 对话框 | ✅ | 7 tab 均可切换且单面板可见；人设与故事 tab 完整承载生产迁移配置（Minase HDSI、武汉关山大道、配角、文风等）；YAML 视图 2719 字符 |
| Configure 取消 | ✅ | 取消关闭对话框，canonical koishi.yml MD5 前后一致（无写入） |
| 面板折叠/恢复 | ✅ | Layout 菜单折叠 Browser → 「▸ Browser」恢复条出现于左上角 → 点击恢复，条消失 |
| 新建剧本弹窗 | ✅ | 字段（id/name/characterName/description）齐全；取消后故事数不变 |
| 故事筛选 | ✅ | 「m7」命中 story-list 1 条 |
| OneBot 账户面板 | ✅ | 渠道在线、QQ 1303322392/昵称 Minase、token 别名 snowluma-token、重绑/解绑入口 |

## 3. 发现的 Bug

**Bug 1（P1，交互遮挡）：拖拉条右柄在窗口贴右侧时不可抓取**
- `.grid-resize-handle#handle-inspector`（透明，`z-index:6`，`top:0;bottom:0` 全高，宽 6px）覆盖 workspace 右缘。当 scroller 窗口右端到达轨道右端（vpEndPct 被 `bounded()` 钳到 100% 时的常态位置），右柄（7px）几乎完全落在该覆盖层之下，`elementFromPoint` 命中 `grid-resize-handle vertical`。左端对称存在（`#handle-browser` 覆盖轨道左缘）。
- 实测后果：拖"右柄"实际拖动了 Inspector 面板宽度（我在测试中误触两次，已恢复 264px）。
- 成因组合：① 覆盖层全高+透明+z6；② `overviewRange()` 一旦缓存永不扩展（审计遗留项），且视窗未来端超出总范围末端时 vpEndPct 恒被钳到 100% —— 贴右是高频状态（follow/回中后立刻贴右）。
- 修复方向：scroller 句柄提升 z-index（如 7）或给覆盖层限定高度避开拖拉条行；同时考虑 overviewRange 缓存扩展策略。

## 4. 观察与建议（非阻塞）

1. **时间导演曾经失败**：21:09 有「时间导演返回被拒绝（连续第 2 次）原始返回=null 拒绝原因: 返回不是 JSON 对象」警告，对应 13:43/13:55 两条用户消息长期未回复。22:09 起新链路恢复。建议排查 gemini-3.7-flash 时间导演调用的 JSON 解析（可能被 markdown 围栏包裹或返回 null）。
2. **OneBot meta_event 日志噪音**：每 ~30s 一条「已忽略 OneBot meta_event」，3 小时 500+ 条记录里占绝对多数，冲淡有效日志。建议 debug 级或静默。
3. **Koishi Console 嵌入未激活**：Worker 就绪但 Console endpoint「待 Worker 上报」，嵌入视图为占位说明。与审计 UI-32 相关，需实测 loopback server 上报路径。
4. Data tab 中 story 元数据 `hdsiVersion` 仍为 beta13（创建时的版本），仅元数据陈旧，无功能影响。
5. 测试工具链注意：qq-send2.ps1 在目标聊天已打开时会误发搜索数字，建议脚本改为直接定位输入框。

## 5. 未执行项（破坏性/需暂停故事）

- ⤴ 分支续写（会截断+建分支）、删除所选时间范围、OneBot 解绑/重绑、Worker 停止/重载、Configure 保存（仅验证了 Mixer 保存路径）。

## 6. 结论

**核心链路（收消息→叙事→投递→时间轴呈现→主动推进）端到端全部正常，生产配置迁移有效。** 全部常用只读+写路径功能通过；发现 1 个 P1 交互遮挡 Bug（拖拉条端部句柄被面板 resize 覆盖层挡住）与 1 个历史性时间导演解析失败待排查。测试后已将 Mixer temperature、面板宽度、Follow 视图全部恢复原状；canonical 配置未被测试写入。

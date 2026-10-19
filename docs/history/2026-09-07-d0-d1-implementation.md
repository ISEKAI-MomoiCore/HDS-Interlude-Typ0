# typ-0 D0 + D1 实现记录：运行基线与 OneBot 生产接线

日期：2026-09-07。范围为 `desktop/`；未升级 HDSI 内核、未打包、未连接真实 QQ、未修改既有故事数据库。源码备份位于 `desktop/backup/2026-09-06-before-d0-d1/`。

## D0：实际运行基线可见

- 主进程从 **实际 Node resolver 所在的** `node_modules/koishi-plugin-hds-interlude/package.json` 读取版本与 main artifact；对 artifact 生成截短 SHA-256 标识。
- 每个 `StoryHandle` 与 Host Overview 现在带 runtime core version、artifact path/hash、bridge protocol 和 worker 声明 capabilities。`story.json.hdsiVersion` 保留为创建／导入时的历史记录，不再被误解为当前 Worker 事实。
- Inspector 显示实际 core 版本、bridge protocol 与 artifact hash；bridge-ready 会刷新故事投影并记录协议能力。
- 当前本工程解析到的默认内核仍是 `1.0.0-beta4-m8`，bridge protocol 4；本次不把未发布 P1 或其他目录源码偷偷装入 typ-0。

## D1：真实渠道最小闭环

### 入站边界

- `message_sent` 与 sender 等于登记 selfId 的异常普通 `message` 均标为自身回声，绝不形成用户入站；没有按文本内容去重。
- `meta_event` 显式忽略；群聊、媒体-only、未知 post_type 与 selfId 不匹配事件显式拒绝／记录。调用者只有在 `transform.event` 存在时才会进入 MessageRouter，消除了原先对不存在 event 的非空断言。
- 外部上游在 WebSocket open 后先发送 `get_login_info`。仅返回的 `user_id` 与绑定 selfId 一致，才标记渠道在线并允许发送；身份错误会关闭连接并重连，不降级成无认证连接。

### 发送与生命周期

- `OneBotServerAdapter` 改为 Worker 的 loopback 协议门面，不再注册为真实 transport sender。
- `ChannelAdapterRegistry` 增加 per-delivery resolver；`onebot-external` 发送按 `storyId` 找对应 `ExternalOneBotConnector`，不会因为同 transport 的后注册覆盖而发送到 Worker loopback。未配置上游会得到明确失败回执。
- 账号面板可提交 ws/wss endpoint 与可选 token 密钥别名；Main 校验 URL、拒绝 URL 中凭据／fragment，tokenAlias 必须存在于宿主安全存储。
- 外部连接状态分为未配置、连接中、已验证在线、离线、配置错误；UI 区分 Worker 内部桥接和真实渠道。配置更新会停止旧 connector 并按新登记重建；Desktop 重启与故事重新加载会恢复已配置 connector。Worker 卸载后 connector 保持，以便消息按 paused／muted 语义进入 Inbox。
- 端点和 token 不写入日志；未能解析 token alias 时不尝试无 token 降级连接。

## 保留的边界

- D1 仍只支持 OneBot 私聊纯文本；群聊、图片、语音、引用未加入范围。
- `ok`／`async` 的 OneBot 回执仍沿用当前 Outbox 的 sent 映射；“上游受理”与“最终确认”、`sending` 崩溃恢复、unknown 状态和重试核对属于 **D2**，尚未声称解决。
- connector 的真实账号验证依赖上游支持 `get_login_info`；不支持该 action 的实现会保持离线，而不是猜测其身份。
- 内核不改变原始剧本、事实、记忆、剧情弧、自动推进或 HDSI 对话提示词。桌面只处理真实外部事件和投递回执。

## 验证

- `node node_modules/typescript/bin/tsc --noEmit`：通过。
- `node scripts/test-runtime.mjs`：**29 / 29 通过**。新增覆盖自发回声／心跳／错误 selfId、错误上游账号不在线、按故事的真实 connector 选择。
- `node scripts/test-bridge-e2e.mjs`：通过。使用临时目录、真实 Koishi Worker 和本机模拟 OneBot 上游，验证 protocol 4 bridge-ready、内部 adapter 握手、timeline-range、phase、snapshot 与 purge-range 边界。
- `node --check src/renderer/app.js` 与 `npm run build`：通过。

上述验证不包含真实 QQ、长期重连、应用崩溃中断、跨版本升级或安装包环境。下一项是 D2：将 Outbox 收据从“已发送／失败”扩展为可恢复的已受理、未知与明确确认状态，并针对崩溃点做夹具演练。

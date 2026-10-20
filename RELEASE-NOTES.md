# 已知边界与发行说明 — typ0 0.0.1-m4 / HDSI 1.0.1-rc57

> 初版随 2026-10-03 发行前修复批次（P0/P1/P2）整理；0.0.1-m4（2026-10-19）为首次入库 GitHub 版本。正式发行时随包附带。

## 0.0.1-m4 变更摘要（2026-10-19）

- **主题系统补全**：主题包作者指南（`THEME-PACK-AUTHOR-GUIDE.md`）、`theme.schema.v3.json`（draft-07）、导入前结构化诊断（errors/warnings + 逐条 hint）、预览与失败包可视化；L0–L3 开放，L4/L5 沙箱层不开放（CSP 边界见下）。
- **「从 koishi.yml 导入 HDSI 配置」**：连接页一键导入插件版配置（人设/关系/账号/状态机/模型配置 + 可选主提示词 + 行为节）；密钥迁移进 SecretStore（`migrated-*` 别名，值同复用）；账号跨剧本自动转移（占用方卸载、转移失败回滚）；旧版配置无 `useForMain` 时自动标记主叙事；支持删除既有剧本选项。
- **剧本数据库整库导入**：向导新增「剧本数据库」模块——按 yml 内 `database-sqlite` 路径探测插件版 koishi.db，文件级替换为新剧本的 `data/hdsi.db`（两边同为 rc57 插件 schema，无需转译；db+wal+shm 三件套随迁，AUTOINCREMENT 与行 id 保真）。预览仅显示表级计数；库内 story 账号与导入账号不一致时给警告；analytics 等无关表原样保留。
- **应用图标 ☕**：基于 Twemoji 2615（CC-BY 4.0，README 署名），窗口/任务栏/安装包统一（`desktop/scripts/make-icon.cjs` 再生成）。
- **可用性修复批（2026-10-19 五联修）**：就绪检查 needs-reload 提供「重载 Worker」（真正 unload→load，不再对运行中 worker 做幂等 no-op 假装修复）；新增「运行相位」检查（暂停/静音 warn + 一键切回运行）；`window.prompt` 全量替换为宿主输入对话框（Electron 渲染层不渲染原生 prompt，此前删除剧本/创建分支/自定义时间范围/导入剧本目录五个流程静默失效）；NOW 播放头几何改为 ResizeObserver 重测（HUD↔Timeline 切换后不再出现半截竖线）；账号卡网格 `min-width:0` 稳定化（长 endpoint URL 不再把轨道撑爆、缩放不再乱跳）。
- **审计批修复（2026-10-20）**：插件更新/卸载/复制/安装的包名双拼（完整名原样、裸短名才拼前缀）；插件面板与市场安装的三处跨剧本竞态（面板级序号 / 安装目标快照）；同名插件分组定位（块级 (rawKey, group) 定位，IPC 增加可选 group 参数）；配置双编辑器保存前过期守卫（YAML 副本对比来源快照、结构化节对比基线，过期即确认，不再静默回滚已保存修改）；就绪检查迟到响应不再污染状态栏；声明式 Button 的 args 契约统一（对象解包 + 标量直传，内置动作两形态兼容）。
- **界面细节**：诊断日志等级筛选改为普通单选下拉（全部/仅 debug/info 及以上/warn 及以上/仅 error，选中即生效）；时间尺度旋钮拖拽方向修正为旋钮惯例（上拉顺时针=范围增大）；连接页/配置页多处滚动截断修复。
- **仓库化**：插件 tgz 入 `desktop/vendor/`（哈希不变，见 `PROVENANCE.md`）；AGPL-3.0 LICENSE；文档归档 `docs/design/` 与 `docs/history/`；版本统一 `0.0.1-m4`。
- **rc57 同步**（2026-10-18）：Mixer「费用优先」预设重标定到 rc57 默认基线；`model.specializationAutoTrim` 开关接入；Console 配置面重排自动生效（详见 `PROVENANCE.md` m4/rc57 说明）。

## 数据与日志边界（用户应知晓）

- **日志落盘保留消息原文**：桌面端 NDJSON 日志（`<数据目录>/logs/`）与 Koishi 插件日志按原文记录运行事件；Blind/盲区模式的脱敏仅在查询与导出边界生效，磁盘文件本身不加密。不要把日志目录分享给不信任的对象。
- **日志保留策略**：启动时与每日执行清理——超过 14 天的日志文件、单日超过 12 个轮转分片的旧分片、总量超过 256MB 时从最旧的日期开始整日删除。
- **叙事内容预览默认关闭**：`logScriptPreview` / `logMessageContent` 默认 false；无可见回复回合的 interaction JSON 预览同样受 `logScriptPreview` 门控。
- **入站消息行的账号脱敏**：summary 级（无法通过 verbosity 关闭）的"收到群聊/私聊消息"行中 QQ 号仅保留尾 4 位；verbosity 调到 summary 以下可关闭 standard/diagnostic 级的完整 ID 输出。
- **导入向导的密钥处理**：分析/预览阶段只显示密钥别名与去向，明文密钥仅直达 SecretStore，不进入日志、报告或渲染层持久状态。
- **密钥存储**：打包版强制 Electron safeStorage；`HDSI_TEST_MODE=1` 明文模式仅在未打包（开发）环境生效。无 keyring 的 Linux 环境无法解密密钥，就绪检查会给出指引。
- **操作系统与供应商边界**：应用层"释放引用"不能覆盖操作系统缓存、模型供应商的短期处理与硬件驱动行为，这些超出应用控制范围。

## 功能边界

- **SnowLuma 为进程级协作、不随 typ0 分发**：typ0 检测本机 SnowLuma 安装/进程/WebUI 状态并在连接页展示，账号可指向 SnowLuma 的 OneBot 上游；但 typ0 不启动、不内嵌、不分发 SnowLuma（其许可证为源码可见非商业许可，与 AGPL 不兼容，见仓库 README「SnowLuma 边界」）。请手动运行 SnowLuma 的 launcher.bat 后回应用内重新检测。账号向导的"测试连接"（上游探测）可用。
- **外部 OneBot 连接器**：forward WebSocket 客户端（连接上游 WS 服务端）可用；reverse WebSocket（上游主动连 typ0）暂不支持，但 typ0 内部桥监听 127.0.0.1:6709 供插件侧 adapter-onebot 反向连接。外部上游重连固定 5 秒间隔、无指数退避；连续动作超时（上游假死）不触发主动重连。配错账号会持续重试并留日志。
- **贴纸/原生表情发送失败**：记录日志与账本 failed 条目，无自动重试与文本降级（降级语义待后续产品决策 D3）。
- **微信通道**：桌面绑定入口已完成通道字段（channelKind），但目标 ID 全链路（含贴纸/动作参数）按 D1 决策后才正式支持；QQ 通道不受影响。
- **Blind 沉浸模式开关在日志页工具栏（m3 清理接线）**：此前主进程机制完整但无 UI 可达；现可直接切换。磁盘 NDJSON 仍保留原文（导出/查询边界脱敏），不要把日志目录分享给不信任对象。
- **语义沙箱包脚本被页面 CSP 阻断（m3 审查确认，宿主模块已随死代码清理移除）**：index.html 的 CSP（`default-src 'self'`）会继承进 srcdoc 沙箱 iframe，主题包内的 `<script>` 无法执行、就绪握手超时后整包被安全回收——失败模式安全，但沙箱脚本能力整体不可用。需为沙箱 guest 设计独立 CSP 策略（nonce/header 方案）后才能启用，属后续工作。主题包静态资源 data: URL 同受 CSP 限制（img-src 未放开），主题资产能力待 CSP 决策。
- **插件市场与官方配置页（Phase 3 已交付）**：插件面板内置市场搜索（npmmirror 源，含与当前 Koishi 版本的兼容性判定）与「启用 Console 配置页」按钮（@koishijs/plugin-config 随 typ0 附带，重载后嵌入式 Console 提供官方插件配置表单）。
- **第三方插件受控安装（Phase 2 已交付）**：插件面板可一键安装/更新/卸载（npmmirror 源；--ignore-scripts 不执行第三方安装脚本，原生依赖类插件因此不可用；--legacy-peer-deps 保证与宿主同一 koishi 实例）。插件安装于 <数据目录>/plugins-runtime，多剧本共享（全局单版本）。打包版需系统 PATH 可用 npm，否则安装按钮报错并给出手动命令。
- **投递回执 pending 补偿（需 rc53+ 插件）**：宿主 echo 超时的"结果未知"回执要按 pending（等待补偿确认）而非终态失败记账；m4 锁定 rc57，语义已随版本对齐。
- **从 koishi.yml 导入仅覆盖配置**：不迁移插件版数据库（剧本条目/记忆/事实留在原实例）；导入生成的是新剧本，首相位为 paused，就绪检查会提示一键切运行。

## 修复批次索引

历史修复批次清单见 `docs/history/`（含 2026-10-03 发行前修复计划、UI 审计日志与各批次落地记录）；开发同步日志见 `docs/history/LOCAL-SYNC-LOG.md`；artifact 溯源见 `PROVENANCE.md`；桥协议版本政策见 `BRIDGE_PROTOCOL.md`。

# 第二轮 UI 修复：建立信息层级

日期：2026-10-19  
工程：`C:\dev\HDSI-desktop-typ-0`  
依据：原始审查 `UI_THEME_CHANGE_1019.md`、第一轮修复记录，以及 `C:\dev\typ0-v3-interface.html`。

## 1. 本轮范围

保留清澄纸面工作台的颜色、细线、直角与技术标注，不做全局换皮。本轮重点是重新分配注意力和可用空间：

- 总览偏叙事，Session 偏阅读，Mixer 偏编辑，Logs 偏诊断。
- 标题、正文、元信息和技术数据分工明确；减少同权重边框与重复摘要。
- 自动收起与当前任务无关的侧栏和详情，同时保留用户主动展开与 Timeline 原有布局。
- 将共享排版规则应用于子页，复核配置、向导、详情及辅助弹窗。

本轮不是“原审查所有问题已清零”。配置工作流、字段结构、空状态和 Facts / Schedule 的主视图重构仍有后续工作，见第 7 节。

## 2. 具体修改

### 2.1 字体、间距与视觉权重

新增最后加载的 `desktop/src/renderer/ui-hierarchy.css`，集中管理本轮层级，继续使用现有主题 token：

- 工作区标题 18px；常规正文至少 13px；阅读正文至少 14px；字段标签至少 12px；主要元信息至少 11px。窄窗标题 16px。
- 中文正文使用 UI sans 字体，时间、编号、模型数值、代码使用 mono；mono 的中文 fallback 补入 Noto Sans SC / Microsoft YaHei，避免落入不协调字体。
- 主要区块使用 20–28px 留白、12–16px 组内间距；弱化重复卡框、装饰编号和无业务含义的强调。
- 导航以中文主名为先，英文作为辅助标注；保留原入口、ID 和功能。
- 补统一的键盘焦点指示，Session 片段可以通过 Enter / Space 打开详情。

### 2.2 按任务分配面板空间

| 场景 | 本轮默认行为 |
|---|---|
| 总览 / Session / Mixer / Stats / Analysis | 收起右侧 Inspector 和底部 Detail，主区优先 |
| Connect / Logs / Console | 同样收起重复 Inspector / Detail |
| Timeline / Facts / Schedule | 保留持久化的完整工作台布局 |
| 主动检查条目 / 打开详情 / 面板开关 | 可恢复对应面板，功能不删除 |
| 日常模式 | 总览，隐藏 Browser / Inspector / Detail |
| 工作台模式 | Studio，恢复完整面板 |
| 诊断模式 | Logs，隐藏 Inspector / Detail |

focused task 的面板选择以“故事 + surface + view”为键，仅保存在当前窗口内存中，不覆盖 Timeline 的持久布局；Browser 仍遵循原来的持久化偏好。自动收起不生成浮动恢复条，主动收起才提供对应恢复入口。

同时修复两处布局正确性问题：

1. `panel-collapsed` 原先没有真正让元素退出 grid，可能留下隐式行列。现在隐藏折叠项、显式定位 Workspace / Inspector / Detail，grid 尺寸统一由 JS 管理，移除冲突的 CSS 强制尺寸。
2. 窗口跨断点但不导航时，原先可能保留约 214px 空栏。新增 resize 的 rAF 布局同步，并补“不切页直接缩放”的断言。

窄窗 Inspector 通过抽屉 / FAB 保持可访问；V7 不显示旧侧栏 FAB。标题预留两侧按钮空间，避免被浮动导航遮挡。

冷启动补充：恢复上次 active detail tab 不等于用户要求展开详情。初始化使用 `setDetail(..., { reveal: false })`，正常点击仍可展开；新增总览、Session、Mixer 持久化后 reload 测试。

### 2.3 四个主要页面

| 页面 | 修改 |
|---|---|
| Overview / 故事总览 | 场景放左、最近叙事放右；桌面场景卡至少 200px 高，标题 21px、正文 14px / 1.8；摘要弱分隔，事实 / 最近条目正文可显示两行。保留可导航的三条预览轨和原 34px 几何契约。 |
| Session / 剧本阅读 | 展示完整片段，不再截为 300 字预览；保留换行；内容区最多 880px，正文最多 72ch；正文 14px、行高约 27.3px；片段间使用留白和弱分隔；保留分支续写。 |
| Mixer / 行为设置 | 摘要压缩，快速预设默认折叠；七组中文导航可换行；移除重复英文分组前缀和 M4 开发标记；参数卡改为“完整说明 + 下方控件 / 有效值”，长文本独占一行；有效值可换行。 |
| Logs / 诊断日志 | 中文日志正文使用 13px UI 字体，时间 / source 使用 11px mono；筛选输入约 32px 高；清空降为次要操作；日志区 flex 填满剩余高度并独立滚动，footer 留在底部。 |

Mixer 仅调整布局与已有语义说明，没有改后端保存协议：群聊范围预设仍为原来的即时写配置，其余预设仍进入草稿；未把即时动作伪装为未保存草稿。

### 2.4 其他子页与弹窗

| 范围 | 本轮处理 / 复核边界 |
|---|---|
| Timeline / Facts / Schedule | 应用共享标题和字体规则；保留时间线交互、轨道开关与持久布局，不在本轮重构为可读列表 / 日程摘要。 |
| Stats | 主值 28px、单位 11px、标签 12px，弱化卡片装饰，梳理指标与元信息字级。 |
| Analysis | 应用共享标题和元信息排版；未重做未提供 / 失败 / 无数据状态。 |
| Connect | 自动收起重复面板，释放中列；保留宽度 clamp 与原连接操作；复验已有窄窗卡片修复。 |
| Koishi Console | 给嵌入区域留足宿主空间，复验等待 / 就绪容器；未验证运行中的 Console 内部网页。 |
| 配置八个 tab | 人设、用户、群聊、机器人、提供商、密钥、插件、YAML 全部复核；统一分组标题、间距、输入高度、长文本字号。YAML 保持 mono。 |
| 配置展开区域 | 桌面和 760px 下额外展开用户、群聊、提供商、插件，检查容器边界及内容滚动；并不代表每个字段截断均已消除。 |
| 创建故事向导 | 六步骤 × 1440 / 1280 / 760 复核字号、说明及已有窄窗行为，不创建真实故事。 |
| 分支续写 | 从真实 Session 按钮打开，在三个尺寸检查弹窗边界，不提交分支。 |
| 详情五 tab | Script / Events / Deliveries / Model Usage / Data 复核，共享字号与说明层级；技术数据保持 mono。 |
| 辅助弹窗 | 主题、帮助、全局搜索、账号向导均截图复核。 |

## 3. 隔离验证与测量

测试使用真实 renderer 源码、headless Edge、隔离 preload fixture。Mixer 字段元信息从工程 `src/main/ipc/mixer.ts` 的真实 `MIXER_PARAMS` 通过 TypeScript AST 提取安全字面量，不执行 IPC 代码：覆盖 65 个参数及人设速编，共七个分组，不以空白页代替复杂表单。

| 实测项 | 结果 |
|---|---|
| Session 首篇测试正文 | 310 字，全文一致；14px / 27.3px，`pre-wrap`，无最大高度裁切 |
| Logs | 220 条有实际中文正文的记录；1440×900 下滚动视窗 671px，内容约 9336px |
| Mixer 分组卡数 | 人物 1、连接 5、模型 11、节奏 22、记忆 11、扩展 13、高级 3 |
| 视口 | 核心页 1440×900 / 1280×768 / 760×600；Inspector 1000 / 760；另有第一轮多尺寸回归 |
| 配置 | 八 tab × 桌面 / 760，另含四类展开区域 |
| 页面错误 | 新增层级回归要求 `pageerror` 为空 |

测试夹具覆盖继承 / 显式值、多段中文长文、warn / error 日志及配置字段。没有读取或改写用户真实账号、故事配置、密钥、数据库；没有启动 Worker。测试中的保存 / 预设交互只作用于内存 fixture。

## 4. 验收命令与证据

在 `C:\dev\HDSI-desktop-typ-0\desktop` 运行：

```text
npm run typecheck
npm run test:theme
npm run test:interactions
npm run test:compat-themes
npm run test:timeline
npm run test:ui
npm run test:ui-correctness
npm run test:connect
npm run test:buttons
npm run test:bfixes
npm run test:ui-hierarchy
npm run build
```

构建后以 `UI_TEST_DIST=1` 重跑 `test:ui`、`test:ui-correctness`、`test:ui-hierarchy`、`test:buttons`、`test:bfixes`。冷启动修复后再次重跑 typecheck、上述五项 source / dist 回归及 build。

**验收状态：以上完整回归、build，以及冷启动修复后的 source / dist 复验均通过。源码与 dist 的 40 个 renderer 文件 SHA-256 全部一致，无多余产物文件。**现有 `.npmrc` 的 electron mirror 配置会产生 npm deprecation warning，不是本轮新增错误。

证据目录：`C:\dev\hdsi-ui-audit-20261019\round2-after`：

- `final-tests.txt`：完整源码回归、构建与 dist 回归。
- `cold-start-final-tests.txt`：最后补入冷启动恢复修复后的 source / dist 复验。
- `hierarchy-measurements.json`、`dist\hierarchy-measurements.json`：真实 DOM 测量。
- `hierarchy-*.png`：源码逐页截图；`dist\hierarchy-*.png`：构建产物逐页截图。
- `contact-main.jpg`：四个主要页面；另有 config、mixer、wizard、utility、other-pages 联系表。
- `changes.patch`：仅本轮源码、测试与文档的统一 diff，不包含大体积 dist 产物。
- `renderer-hash-verification.json`：源码 renderer 与 dist renderer 的逐文件哈希校验。

## 5. 文件与回退

Renderer：`app.js`、`index.html`、新增 `ui-hierarchy.css`、`responsive-fix.css`、`host-v3-unify.css`、`theme/tokens.js`。

测试：新增 `scripts/test-ui-hierarchy.cjs`、`scripts/fixtures/ui-hierarchy.cjs`；更新 `scripts/test-button-interactions.cjs`、`scripts/test-connect-layout.cjs`、`scripts/test-b-fixes.cjs`；`package.json` 新增层级测试入口。

没有修改业务 IPC、preload、数据协议或依赖版本。构建会按原脚本更新 dist。

修改前备份：`C:\dev\hdsi-ui-audit-20261019\round2-before`。Renderer 完整备份；测试备份只有原有顶层 cjs，不包含未修改的 fixture / mjs，不要把它当作整个 scripts 目录镜像。回退时只恢复本轮列出的旧文件，并移除本轮新文件，再重新 build；不要整目录覆盖其他工作。

## 6. 验证边界

本次不是启动真实 Electron 并联调全部业务：没有验证原生 WebContentsView、真实 IPC、Worker、OneBot、模型请求、插件安装和运行中 Koishi Console 内页。测试可以确认 DOM 布局、真实渲染代码、面板行为、页面错误和 fixture 交互，不能据此宣称所有真实业务链路通过。

没有制作 / 安装新的发行包。已更新本地 dist，退出并重新启动本地工程应用可加载新产物；已有安装版不会自动更新。

## 7. 第三轮及后续保留项

1. **配置弹窗固定结构**：统一各 tab 的高度、头部 / 内容 / footer 关系，减少切换跳动。
2. **常驻字段标签**：白名单 / 机器人 / 提供商等不依赖 placeholder；复杂卡片拆分身份、连接、用途和危险动作。
3. **保存语义**：保存当前 / 全部 / 密钥 / 插件即时操作分层，明确草稿和已生效状态，本轮未统一工作流。
4. **字段级窄窗收口**：提供商 `openai-compatible` 类型仍可能在窄字段中截断；配置展开项、工具条和极端低高度需要细化，而非只检查整页无横向溢出。
5. **状态设计**：Analysis 未提供 / 失败、Stats 0 / 未采样 / 不可用、日志空态 / 无匹配分别设计原因和下一步。
6. **内容结构后续**：Facts 的可读事实列表、Schedule 的计划摘要、Timeline 小事件表达、空轨默认策略仍需专门设计；未因完成本轮共享样式而视为解决。
7. **辅助区精修**：Events / Deliveries / Usage / Data 的内容结构、复制辅助、分支弹窗中的 `forkPoint` 等开发词汇仍需梳理。
8. **真实运行抽查**：在用户选择的测试账号 / 故事环境中验证 Electron 原生嵌入和实际数据长文本，再决定是否补充平台专属布局修复。



---

## 第三轮修复已完成（2026-10-19）

保留以上历史审查正文。第三轮已落实简洁无衬线正文与局部日式 Gothic 标题、底部常驻面板开关、右侧摘要/下方详情的可折叠与记忆行为、配置固定框架/常驻字段标签/保存分层、窄窗和 Analysis / Stats / Logs 状态收口。

- 完整记录：`C:\dev\HDSI-desktop-typ-0\UI_THEME_ROUND3_1019.md`
- 最终日志、截图、测量、补丁：`C:\dev\hdsi-ui-audit-20261019\round3-after`
- 修改前备份：`C:\dev\hdsi-ui-audit-20261019\round3-before`

最终源码回归、build 和关键 dist 复验通过；41 个 renderer 文件逐项哈希一致。所有业务写入仅发生在隔离 fixture，没有操作真实账号、配置、密钥或 Worker。V7 保持独立工作台；Facts / Schedule 主视图、Timeline 小事件表达及真实 Electron 原生嵌入仍是后续项。

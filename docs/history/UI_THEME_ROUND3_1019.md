# 第三轮 UI 修复：简洁字体、可折叠面板与配置收口

日期：2026-10-19  
工程：`C:\dev\HDSI-desktop-typ-0`  
依据：`C:\dev\HDSI-desktop-typ-0\UI_THEME_CHANGE_1019.md`、`C:\dev\HDSI-desktop-typ-0\UI_THEME_ROUND2_1019.md`、`C:\dev\typ0-v3-interface.html`。

## 1. 本轮结果

沿用清澄纸面配色、细线和克制的强调色，没有全局换皮。本轮落实第三轮配置工作流、字段和状态收口，同时补上用户要求的简洁字体与常驻面板入口。

| 项目 | 实施结果 |
| --- | --- |
| 字体 | 常规界面采用 Segoe UI / Noto Sans SC / 系统无衬线回退；标题、配置导航和分区标题局部采用 Yu Gothic / Hiragino Kaku Gothic 字体栈。数字、时间、ID、YAML 保留等宽职责。 |
| 右侧与下方栏 | 新增底部常驻“工作区”栏，提供故事浏览、右侧摘要、下方详情的展开/收起按钮及文字状态。收起后入口仍在，不依赖临时悬浮恢复条。 |
| 面板记忆 | 手动选择按故事和当前任务保存，重启后恢复；不会覆盖 Timeline 原有布局偏好。原有宽高拖拽继续可用。 |
| 小窗口 | 右侧摘要以覆盖层呈现，点外关闭后可再次打开；覆盖层不会遮住底部开关。下方详情保留独立区域，低高度时约束可用高度。 |
| 配置框 | 固定标题、八个标签页、保存范围提示和底部操作区，仅中间内容滚动。切换 tab 不再改变弹窗外框。 |
| 配置字段 | 用户、群聊、机器人、提供商的身份字段补常驻标签；提供商接口类型不再挤在窄字段中。详细项、用途勾选、插件名称与搜索框补足布局或标签。 |
| 保存 | 一个主操作“保存全部草稿”，次操作“仅保存本页”。只提交有修改的结构化分区；YAML 与表单同时修改时阻止混合写入，要求明确选择来源。 |
| 保存反馈 | 草稿 tab 标记、保存范围提示、进行中防重复提交；保存期间禁止继续编辑或关闭。部分失败保留未成功分区的草稿，不宣称全部成功。 |
| 即时操作 | 密钥与插件维持原协议的即时操作，并明确标注；这两页不再显示不适用的“仅保存本页”，没有其他草稿时也不显示草稿主保存按钮。 |
| Analysis | 区分 Worker 未加载、能力未提供、读取失败与无样本；有明确原因、技术信息及下一步。修复重新读取被渲染缓存拦截、晚到结果覆盖离线状态的问题。 |
| Stats | 区分合法 0、未采样、接口未返回统计；缺失消费字段不参与平均值，不再被当作 0。 |
| Logs | 区分空日志与无筛选匹配，提供重新读取/清除筛选；有新记录后移除空态。 |
| 可访问性 | 配置 tab 关联 panel，支持方向键/Home/End；账号开关支持键盘；面板按钮同步展开状态和控制对象。 |

### 字体选择边界

没有下载、安装或打包新的字体资源，也不依赖在线字体服务。本机 Edge 实际使用的字体已通过 Chromium 平台字体信息核实：中文正文为 Noto Sans SC，英文正文为 Segoe UI，局部标题使用 Yu Gothic 并对缺字回退。其他机器按本机已有字体回退，不能假定所有平台的字形完全相同。

共享正文仍走 `--hdsi-font-ui`，保留主题字体的覆盖能力；日式 Gothic 栈只用于少数标题与导航层级，不用于整段叙事正文。

### 面板使用与兼容约定

- 点击底部“右侧摘要”或“下方详情”即可展开，再点击收起；各栏原有收起按钮仍保留。
- 宽窗口下保留分隔线拖拽，大小继续使用原布局数据。
- Overview / Session / Mixer / Stats / Analysis 等任务仍默认优先给主内容留空间，但用户主动选择会被记住。其他任务与 Timeline 的偏好分开保存。
- 小窗口的侧栏“布局允许显示”与“覆盖层当前已打开”分开处理；按钮状态反映实际展开情况。
- V7 仍是独立工作台 Profile，不强制加入旧三栏和新底部 dock，避免破坏前两轮确认的独立布局约定。

## 2. 验收范围与结果

**最终源码回归、build 和关键 dist 复验均通过。41 个 renderer 源文件与构建产物 SHA-256 一致，dist 无多余 renderer 文件。**

新增 `test:ui-refinement`：

1. 底部真实鼠标点击展开/收起/重开、拖拽调整、刷新恢复、任务与 Timeline 隔离。
2. 760×600 / 760×500 覆盖层点外关闭与重开、底部入口不被遮挡；V7 不显示旧面板 dock。
3. 八个配置 tab × 1440×900 / 1280×768 / 760×600 / 480×500 / 360×560：共 40 组测量，外框在视口内、内容无横向溢出、底部操作可达；最小内容区高度 220px。另检查账户、提供商、插件详细展开项。
4. 常驻标签、完整提供商模式字段、键盘 tab 导航/开关、增删行后已有草稿保留。
5. 只保存脏分区、本页保存不影响其他草稿、混合 YAML 零写入、部分失败保留、保存锁防双写，以及密钥/插件即时操作。
6. Analysis 的四类状态、真实按钮重试与晚到请求保护；Logs 空/无匹配/清除筛选/新记录；Stats 缺失与合法零。
7. 页面运行错误 `pageerror` 必须为空。

继续运行第二轮完整子页面回归：核心页、Connect、Logs、Console 容器、七个 Mixer 分组、八个配置 tab、六步向导、五类详情、主题/帮助/搜索/账号等辅助弹窗，以及主题和响应式布局。上述配置极窄尺寸测试不等于承诺整个桌面工作台已适配手机。

### 命令

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
npm run test:ui-refinement
npm run build
```

构建后设置 `UI_TEST_DIST=1`，复验 `test:ui`、`test:ui-correctness`、`test:ui-hierarchy`、`test:ui-refinement`、`test:buttons`、`test:bfixes`，全部通过。npm 原有 electron mirror 配置仍产生 warning，不是新增测试错误。

## 3. 文件与证据

修改文件：

- `C:\dev\HDSI-desktop-typ-0\desktop\src\renderer\app.js`
- `C:\dev\HDSI-desktop-typ-0\desktop\src\renderer\index.html`
- `C:\dev\HDSI-desktop-typ-0\desktop\src\renderer\style.css`
- `C:\dev\HDSI-desktop-typ-0\desktop\src\renderer\theme\tokens.js`
- 新增 `C:\dev\HDSI-desktop-typ-0\desktop\src\renderer\ui-refinement.css`
- 更新 `C:\dev\HDSI-desktop-typ-0\desktop\scripts\test-ui-hierarchy.cjs`，将恢复条断言改为常驻 dock；无显式偏好的冷启动测试与手动记忆测试分开。
- 新增 `C:\dev\HDSI-desktop-typ-0\desktop\scripts\test-ui-refinement.cjs`
- 新增 `C:\dev\HDSI-desktop-typ-0\desktop\scripts\fixtures\ui-refinement.cjs`
- `C:\dev\HDSI-desktop-typ-0\desktop\package.json` 增加测试入口。

证据根目录：`C:\dev\hdsi-ui-audit-20261019\round3-after`。

- `final-source-status.txt`、`final-dist-status.txt`：最终验收命令退出状态。
- `final-source`、`final-dist`：最终分项日志、逐页截图与测量。
- `final-source\test-ui-refinement\refinement-measurements.json`：40 组配置框测量。
- `final-source\test-ui-refinement\font-evidence.json`：实际平台字体信息。
- `contact-main.jpg`、`contact-config.jpg`、`contact-states.jpg`：截图联系表。
- `changes.patch`：第三轮源码、测试、文档差异，不包含生成的 dist。
- `renderer-hash-verification.json`：41 个文件逐项哈希验证。
- `ROUND3_FIXES.md`：本记录的审查目录副本。

修改前完整备份：`C:\dev\hdsi-ui-audit-20261019\round3-before`，包含 renderer、scripts、package.json 与前两份审查文档。回退时只恢复上述本轮改动文件，移除本轮新增文件，再重新 build；不要覆盖其他后续工作。前两份文档仅在末尾追加第三轮索引，历史正文原字节保留。

## 4. 验证边界及后续项

- 没有操作真实账号、故事配置、密钥或数据库；所有保存测试仅写浏览器内存 fixture，没有启动 Worker。
- 未修改业务 IPC、preload、后端协议或依赖版本；未安装插件、调用外部模型或制作发行安装包。
- 验证采用 headless Edge 隔离渲染，不代表已联调真实 Electron WebContentsView、OneBot、Koishi Console 内页和生产数据。原生嵌入仍需在用户指定测试环境抽查。
- 本地 `dist` 已更新；退出并重新启动本地工程应用可加载。已有安装版不会因此自动更新。
- Facts 可读事实列表、Schedule 计划主视图、Timeline 小事件表达/空轨策略、详情数据组织仍留待后续，不因完成字体与共享控件调整而算作解决。

## 最后设计微调索引（2026-10-19）

主区与左/右/下方面板的细边线、常驻拖拽带、统一边距及窄栏让位，另记于 `C:\dev\HDSI-desktop-typ-0\UI_THEME_FINAL_POLISH_1019.md`。本节以前的第三轮记录保持原文。

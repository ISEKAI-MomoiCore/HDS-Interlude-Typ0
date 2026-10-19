# UI 最后微调：主区与三侧面板的交界、边距及窄栏

日期：2026-10-19  
工程：`C:\dev\HDSI-desktop-typ-0`  
范围：延续第三轮字体、折叠面板与配置框方案，仅处理共享工作台的设计细节，不改变业务流程。

## 1. 问题与修复

| 问题 | 本次处理 |
| --- | --- |
| 左、右侧栏与主区连成同一平面，分隔线不清楚 | 侧栏交界补 1px 语义强边线，保留纸面配色，不使用厚边框和卡片阴影。 |
| 拖拽柄默认透明，只在悬停时出现，用户不易辨认可调区域 | 左、右、下方采用 6px 窄拖拽带，中央有短握柄；悬停/按下才使用强调色。 |
| 分隔带可能盖住正文或时间线边缘 | 在主区盒内预留对应 padding，拖拽带不盖正文；原 grid 外框尺寸、存储宽高与 JS 布局预算保持不变。 |
| 两侧标题栏高度、标题和按钮不统一 | 侧栏标题高度统一为 56px，与常规桌面主标题对齐；统一 16px 水平内边距、28px 折叠按钮与 8px 间隔。去除重复的 Browser/Inspector 英文副标题。 |
| 右侧内容同时受外层 14px 与内层 11px 缩进，标题和内容不在同一基线 | 移除右侧面板外层 padding，标题/内容均为 16px 横向缩进，内容上/下留白为 16/20px。 |
| 左栏搜索与分组边缘不一致 | 搜索框和分组统一 16px 横向缩进，搜索区上下 12px。 |
| 下方详情贴着主区，标签页与行文字略挤 | 强边线 + 主区底部拖拽带划分层次；标签栏 38px、按钮最小 36px，数据行横向内边距 16px。 |
| 拖到最小宽度时中英文标题换行、摘要值被挤成碎字 | 左栏不超过 190px 时隐藏计数和次要英文导航；右栏不超过 220px 时隐藏标题元信息、摘要网格变单列。只隐藏辅助标记，不删业务内容。 |
| 小窗口覆盖层仍留有网格调宽柄 | 1120px 及以下隐藏右侧网格调宽柄；860px 及以下隐藏左侧网格调宽柄。覆盖层保留边线与原有打开/关闭交互。 |
| 折叠后可能留下空缝 | 只有面板实际占据网格时才预留横向拖拽带；下栏收起时主区底部 padding 归零。V7 完全排除本次工作台样式。 |

所有新增颜色使用现有 `--hdsi-color-*` 语义变量；没有引入图片、字体资源、依赖或新业务 IPC。

## 2. 修改文件

- `C:\dev\HDSI-desktop-typ-0\desktop\src\renderer\ui-refinement.css`：追加最后微调层，原第三轮正文保留。
- `C:\dev\HDSI-desktop-typ-0\desktop\scripts\test-ui-panel-polish.cjs`：新增隔离面板布局回归。
- `C:\dev\HDSI-desktop-typ-0\desktop\package.json`：新增 `test:ui-panel-polish`。
- `C:\dev\HDSI-desktop-typ-0\UI_THEME_ROUND3_1019.md`：仅追加本轮文档索引。
- 本文档及生成的本地 `desktop\dist`。

## 3. 验收

新增回归：

- Overview / Session / Timeline / Mixer / Stats / Analysis × 1440×900、1280×768、1024×768、860×600、760×500，共 30 组页面/尺寸组合。
- 检查工作台无视口横向溢出、详情与底部 dock 不越界、主区实际留出拖拽带、边线/握柄存在、侧栏标题可用。
- 左/右/下栏全部 8 种展开组合，无折叠残留 padding 或幽灵拖拽柄。
- 真鼠标拖窄两个侧栏到最小宽度；验证辅助标记让位、标题与关闭按钮可用。
- 1024/760 覆盖层打开、点外关闭与重开；V7 无新 padding、无旧 dock。
- 页面 `pageerror` 为空。

继续执行前几轮子页回归，涵盖配置八 tab、Mixer 分组、向导与辅助弹窗、五种详情，以及 Connect / Logs / Console 容器。

源码命令：`typecheck`、`test:theme`、`test:interactions`、`test:compat-themes`、`test:timeline`、`test:ui`、`test:ui-correctness`、`test:connect`、`test:buttons`、`test:bfixes`、`test:ui-hierarchy`、`test:ui-refinement`、`test:ui-panel-polish`、`build`。

构建后使用 `UI_TEST_DIST=1` 复验：`test:ui`、`test:ui-correctness`、`test:buttons`、`test:bfixes`、`test:ui-hierarchy`、`test:ui-refinement`、`test:ui-panel-polish`。

**最终源码 14 项（含 build）和 dist 7 项全部通过；41 个 renderer 源文件与 dist 的 SHA-256 一致，无多余 renderer 文件。**

最终结果与证据见下方目录中的 `source-status.txt`、`dist-status.txt`、`renderer-hashes.json` 及分项日志。以最终状态文件为准。

## 4. 备份与证据

- 备份：`C:\dev\hdsi-ui-audit-20261019\final-polish\before`，含原 CSS、package.json、第三轮文档。
- 最终证据：`C:\dev\hdsi-ui-audit-20261019\final-polish\after`。
- 主工作台截图：`C:\dev\hdsi-ui-audit-20261019\final-polish\after\dist\test-ui-panel-polish\overview-final-1440.png`。
- 尺寸与折叠组合测量：上述 `test-ui-panel-polish` 目录下的 `panel-measurements.json`。
- 原有第三轮历史文档保持不改，只追加索引。

## 5. 验证边界

测试采用 headless Edge 和隔离 fixture，未启动 Worker，未写入真实配置、账号、密钥或数据库。没有验证真实 Electron WebContentsView、原生 Koishi Console 内页或生产数据；新增留白作用于宿主容器，真实嵌入仍应实机抽查。

这是局部收尾，不把 Facts/Schedule 等信息组织待办计为完成。没有制作安装包；本地工程重新启动可加载更新后的 dist，已有安装版不会自动变化。


## 后续：文字与边框间距微调（2026-10-19）

本轮组件级内留白调整、子页验收与证据见 `C:\dev\HDSI-desktop-typ-0\UI_THEME_SPACING_1019.md`。本节仅追加索引，以上历史正文不变。

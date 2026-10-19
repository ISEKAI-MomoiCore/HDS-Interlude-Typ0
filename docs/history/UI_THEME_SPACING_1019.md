# UI 文字与边框间距微调 · 2026-10-19

本轮针对「文字离边框太近」做组件级修整，延续前三轮的纸面、细线、简洁字体与面板结构，不更换字体、颜色或扩大所有控件。上轮面板分界、6px 拖拽带、折叠交互和窄窗覆盖层保持不变。

## 1. 具体修正

以下 padding 用「上下 / 左右」表述；数据来自同一隔离 fixture 下禁用/启用 `ui-spacing.css` 的实测对照。

| 部位 | 原留白 | 本轮处理 |
| --- | --- | --- |
| 右侧摘要信息格 | 四边 5px | 四边 10px；标签与值相隔 6px |
| 右侧摘要操作按钮 | 5 / 8px | 7 / 10px；最小高度 34px，可换行；底部操作区对齐侧栏 16px 内边距 |
| 工作区刷新等文字按钮 | 0 / 8px | 6 / 12px；最小高度 32px |
| 下方详情行 | 9 / 16px | 12 / 16px |
| 下方原始数据阅读区 | 四边 9px | 16 / 20px；原已宽松的剧本正文保持不变 |
| 配置普通字段 | 6 / 9px | 8 / 12px；高度 38px |
| 配置展开后的字段 | 4 / 8px | 与普通字段一致，避免展开前后变拥挤 |
| 配置卡片及操作 | 局部不统一 | 卡片 18px、窄窗 16px；添加/删除/展开/启用及页脚按钮补齐内留白 |
| Mixer 数值、下拉框 | 局部偏紧 | 8 / 12px、高度 38px；数值框宽 76px，避免 padding 挤掉数值 |
| 下拉框 | 文字与箭头容易挤在一起 | 右侧单独保留 32px |
| 多行文本 | 部分紧凑 | 通常 12 / 14px；YAML 编辑区 16 / 18px |
| 外观主题卡片 | 8 / 10px | 四边 16px，卡片内容间隔 10px；分区标题上下各留 8px，避免标题贴住卡片顶边 |
| 主题包导入/导出按钮 | 4 / 10px | 8 / 12px、最小高度 36px；窄窗允许换行 |

另外统一了左侧导航条目、过滤搜索框、日志筛选控件、故事/账号向导与分支表单的文字控件留白。导航行加高后，浏览栏改为内部滚动，避免在 1280×768 等尺寸向下溢出到 dock。

全局搜索原本的 12 / 16px 与剧本正文原本的 16 / 20px 已合适，本轮保留。没有把时间线片段、图标按钮、range/checkbox 或拖拽柄当成普通文字按钮放大。

## 2. 改动文件

- `C:\dev\HDSI-desktop-typ-0\desktop\src\renderer\ui-spacing.css`：新增独立、组件级间距修正层。
- `C:\dev\HDSI-desktop-typ-0\desktop\src\renderer\index.html`：在 `ui-refinement.css` 后引入本轮样式。
- `C:\dev\HDSI-desktop-typ-0\desktop\scripts\test-ui-spacing.cjs`：新增隔离间距回归与截图。
- `C:\dev\HDSI-desktop-typ-0\desktop\package.json`：新增 `test:ui-spacing`。
- 本文档、上轮文档的追加索引及本地 `desktop\dist` 构建产物。

原 `ui-refinement.css`、业务 JavaScript、IPC、账号/数据库/配置数据均未修改。工作台面板专属规则排除 V7；配置、Mixer 等共享表单的留白修正有意跨 profile 生效，因此不宣称 V7 所有子页视觉完全不变。

## 3. 本轮验收范围

新回归检查：

- 摘要信息格、文字按钮、详情行的 computed padding；文字按钮另测真实文字 Range 到边框的净距，四边不少于 5.5px。
- Mixer 7 个参数分组，覆盖 1440px 与 760px 窗口；检查字段留白与分组容器无横向溢出。
- 配置 8 个 tab，覆盖 1440×900、1280×768、760×600、480×500、360×560；检查普通/展开字段、下拉箭头空间、页脚可达及内容无横向溢出。
- 故事向导 6 步、账号向导、主题卡片与全局搜索；页面无 `pageerror`。
- 继续运行前几轮回归，覆盖各 Studio 子页、Connect/Logs/Console 宿主容器、侧栏最小宽度、8 种面板折叠组合和窄窗覆盖层。

源码命令：`typecheck`、`test:theme`、`test:interactions`、`test:compat-themes`、`test:timeline`、`test:ui`、`test:ui-correctness`、`test:connect`、`test:buttons`、`test:bfixes`、`test:ui-hierarchy`、`test:ui-refinement`、`test:ui-panel-polish`、`test:ui-spacing`、`build`。

构建后使用 `UI_TEST_DIST=1`：`test:ui`、`test:ui-correctness`、`test:buttons`、`test:bfixes`、`test:ui-hierarchy`、`test:ui-refinement`、`test:ui-panel-polish`、`test:ui-spacing`。

**源码 15 项（含 build）与最终 dist 8 项全部通过；最后的主题分区标题留白修正另追加通过 6 项相关源码检查/构建，记录在 `source-final-appearance-status.txt`。42 个 renderer 源文件与 dist 的 SHA-256 一致，无多余文件。**

## 4. 备份与证据

根目录：`C:\dev\hdsi-ui-audit-20261019\spacing-pass`。

- `before`：原 index.html、package.json、ui-refinement.css 和上轮文档原字节备份。
- `before\measurements`：禁用本轮样式的基线截图与 `spacing-measurements.json`。
- `after\source` / `after\dist`：最终分项日志、截图与测量数据。
- `after\source-status.txt` / `after\dist-status.txt`：最终命令退出码，以这两份最终状态为准。
- `after\spacing-comparison.json`：前后间距实测对照。
- `after\renderer-hashes.json`：源码与构建产物逐文件 SHA-256。

`focused`、`check-*` 及初次失败记录属于调试阶段；最终验收使用 `source` / `dist` 目录。初次检查发现的浏览栏纵向溢出已经修复并由最终回归覆盖。临时诊断脚本已删除。

已人工查看工作台摘要、配置普通/展开字段、桌面和窄窗 Mixer、最小宽度侧栏等截图。

## 5. 验证边界与使用

测试为 headless Edge + 隔离 preload fixture，未启动真实 Worker，未写入真实账号、密钥、配置或数据库；不代表已经验证真实 Electron WebContentsView、原生 Koishi Console 内页或生产数据。

本地 dist 已重建。重新启动本地工程窗口即可加载新样式；未制作安装包，已安装版本不会自动更新。

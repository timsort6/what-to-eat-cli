# 食见 Web Design System

## 0. Research Log
- Embedded refs: 运营型工具采用 `taste-skill.md`，应用壳采用 `layout-skill.md`；没有复用品牌标识。
- StyleGallery: 未联网抓取；采用 `sidebar` + `stack` 的固定侧栏、单滚动主体结构。
- Skipped lanes: Lazyweb / Imagen — 本任务是最小可用工具，不需要外部素材或营销页面。

## 1. Atmosphere & Identity
这是一个安静、可靠的本地美食工作台。浅灰绿背景、深橙重点色和纸张般的分层表面让定位与推荐内容易于扫描。登录只有一张操作表单，没有宣传区。产品使用明亮主题，跟随系统深色设置时也保持一致。

## 2. Color
| Role | Token | Light | Usage |
|---|---|---|---|
| Surface/primary | --surface-primary | #F6F7F3 | 页面背景 |
| Surface/secondary | --surface-secondary | #FFFFFF | 工作区表面 |
| Surface/elevated | --surface-elevated | #FBFCF9 | 输入与结果 |
| Text/primary | --text-primary | #1E2824 | 主文字 |
| Text/secondary | --text-secondary | #536158 | 辅助说明、占位与元数据 |
| Border/default | --border-default | #D3DBD4 | 分隔线 |
| Border/subtle | --border-subtle | #EAF0EA | 细分隔 |
| Accent/primary | --accent-primary | #A94319 | 主要操作 |
| Accent/hover | --accent-hover | #893412 | 操作悬停 |
| Status/success | --status-success | #286C4C | 成功 |
| Status/error | --status-error | #A72D2D | 错误 |
| Surface/error | --error-surface | #FFF1EF | 错误背景 |
| Surface/accent | --accent-surface | #FBEDE6 | 控件交互背景 |
| Focus | --focus | #A94319 | 3px 可见键盘焦点 |

## 3. Typography
- Primary: `"Segoe UI", "Microsoft YaHei", "PingFang SC", system-ui, sans-serif`，无需下载字体。
- Mono: `ui-monospace, Consolas, monospace`
- 需求标题 clamp(24px,3vw,32px)；区块标题 22px/1.4；正文 16px/1.6；辅助 14px/1.5；标签 12px/1.6。
- CSS 字号 token：--text-xs .75rem、--text-sm .875rem、--text-base 1rem、--text-heading 1.375rem。

## 4. Spacing & Layout
- Base unit: 4px；常用间距为 8、12、16、20、24、32px。
- 最大内容宽度 1180px；桌面为 280px 侧栏 + 流动主体，`minmax(min(18rem, 100%), 1fr)`；窄屏单列。
- 页面使用 `100dvh`；文档是唯一滚动容器，没有内部滚动条。桌面侧栏采用 sticky-aside，820px 以下单列并取消 sticky；520px 以下缩小外边距。
- CSS 间距 token --space-1/2/3/4/5/6/8/12 分别为 4/8/12/16/20/24/32/48px。

## 5. Components
### Panel
- Structure: 标题、说明、内容的垂直 stack。
- States: default, loading, empty, error；用色调和文字表达状态，不使用彩色边条。
- Accessibility: 标题层级清晰，内容可键盘到达。

### Control
- Structure: 上置 label + input/button。
- States: default, hover, active, focus, disabled, loading, error。
- Accessibility: 原生控件、可见 focus ring、禁用时保留可读对比度。

### Address row
- Structure: 位置标签、地址摘要、坐标元数据、选择按钮。
- States: default, selected, empty, error。
- Accessibility: 整行可通过按钮选择，选中使用勾号和浅色背景。

## 6. Motion & Interaction
- 原生焦点和即时 hover 反馈；请求期间禁用提交、显示状态文字。按钮按压有 1px 位移，`prefers-reduced-motion` 下取消。没有装饰性动画。

## 7. Depth & Surface
- Strategy: tonal-shift + subtle shadow。面板用白色表面和 `0 1px 2px rgba(30,40,36,.05)`，不堆叠卡片。
- Radius: --radius-sm 8px 输入与小控件、--radius-md 12px 面板、50% 圆形位置符号。

## 8. Accessibility Constraints & Accepted Debt
- WCAG 2.2 AA；正文至少 14px；所有交互可键盘访问；错误在相关控件附近；尊重 reduced motion。
- Accepted debt: 无地图和反向地理编码，因当前 API 未提供且不属于本次范围；定位失败始终提供地址簿回退。

# Smriti 只读看板（`public/ui/`）

> 交付物：`public/ui/index.html`、`public/ui/styles.css`、`public/ui/app.js`，产品与视觉记录在 `PRODUCT.md`、`DESIGN.md`。本文记录设计取向、实现约束、验证过程与未验证项。

## 1. 记录方式（先说清替代了什么）

本轮没有人工访谈：

- `/impeccable context --target /ui` 返回 `NO_PRODUCT_MD` / `PRODUCT_INIT_REQUIRED`，本应按 init 的三轮访谈取产品事实。任务 brief（`docs/ui-plan.md` + 任务说明）已经给出产品、用户、范围、术语、视觉承诺与技术约束，且本会话是子智能体、无提问通道，因此按 init 的「无回答机制时仅从 brief 推断，并标注假设」条款执行：`PRODUCT.md` 末尾明确标注了推断来源与无访谈这一事实。
- 视觉世界由 brief 钉死（「档案 / 图书馆的克制气质——纸墨底色、衬线标题、清晰的数据表；不要紫色渐变、玻璃拟态、大圆角卡片堆砌」），因此走 new-work 的「方向被整体钉住」路径：不做 concept-seed 摇号与选择页，方向契约记为 `seed: none (pinned)`（正文见 `DESIGN.md` 末尾 `## Direction contract`）。
- 表面是 **Operate**（只读仪表盘），按契约走 **code-led**：不做 comp、不做图像生成，野心落在方向契约的首屏条款与签名交互上。
- 方向契约本应写入 `.impeccable/surfaces/ui.md`，但本次允许写入的文件只有 `PRODUCT.md` / `DESIGN.md` / `docs/ui.md`，所以契约落在 `DESIGN.md` 里，未创建 `.impeccable/`。

## 2. 文件与结构

```
public/ui/
  index.html   静态骨架：装订页头、吸顶导航、四个区块、骨架占位、页脚
  styles.css   全部样式与 token（深浅两套）、响应式、动效、打印
  app.js       取数、渲染、筛选/检索、复制、滚动高亮；零依赖
docs/ui.md     本文
```

页面只有一个 `<h1>`（品牌）与四个 `<h2>`（概览 / 记忆 / 待裁决 / 主题），区块内的小标题是 `<h3>`。没有构建步骤，没有 `innerHTML`，没有外部字体/脚本/图标请求（favicon 是内联 data-URI SVG）。

## 3. 后端契约映射

| 区块 | 端点 | 用法 |
|---|---|---|
| 概览·统计 | `GET /v1/stats` | `totals.{memories,pending,topics}`、`health.aiSearch` |
| 概览·最近更新 | `GET /v1/stats` | `recent[]`（取前 5 条） |
| 概览·运行状态 | `GET /v1/stats` + `GET /v1/health` | `health.{instance,authMode}`；健康检查取 `/v1/health` 是否 2xx |
| 记忆·列表 | `GET /v1/memories?limit=200` | `items[]`（`topic/statement/version/updatedAt`） |
| 记忆·检索 | `POST /v1/recall` `{query,limit:50}` | 命中项按 `id` 与已加载列表水合，补回 `version`/`updatedAt` |
| 待裁决 | `GET /v1/pending` | `pending[]`（`changeId/kind/topic/current/proposed/createdAt`） |
| 主题 | `GET /v1/topics` | `topics[]`（`label/description/count`），同时喂主题筛选下拉 |

全部为同源请求、`credentials: 'same-origin'`，前端不处理 token；没有调用任何写入 / 审批 / 删除端点。

与 edge-fix 的最终实现已对表（其确认与 `docs/ui-plan.md` §2 一致）：`totals.topics` 是固定词表大小（12），不是「有记忆的主题数」，与页面写的「固定词表」一致；`byTopic` 恒含 12 项（含 `count: 0`），正好喂满主题区；`recent` 只有 `{id,topic,statement,updatedAt}`（无 version），所以最近更新不显示版本；401 返回 JSON `{error:{code:'unauthorized'}}`，前端按状态码判定、不看响应体；`/ui` 自身也在鉴权之后，`/ui` 与 `/ui/` 都直接返回 `index.html`，静态资源以绝对路径 `/ui/styles.css`、`/ui/app.js` 原样转发给 `ASSETS`；无 `ASSETS` 绑定时 `/ui` 返回 503 `{error:{code:'assets_unavailable'}}`。

## 4. 设计取向（详见 `DESIGN.md`）

- **世界**：装订与纸页。深绿布面页头（`#24483a`）压住纸面（`#f2f3ed`），衬线只出现在品牌、区块标题、统计数字与主题名；正文/控件全部系统无衬线；主题标识符与 changeId 用等宽。
- **拒绝的仪表盘常态**：卡片网格、大圆角、渐变、玻璃拟态、投影、彩色左边框、kicker、分区编号、emoji 图标，一个都没有。结构由 1px 细线、留白与纸/面 2% 明度差完成。
- **颜色有职责**：绿 = 可操作/已完成（链接、主按钮、计数条、选中）；黄铜 `#6f4f16` **只**给「待裁决」积压；砖红只给错误；焦点环在纸面上是校对蓝 `#1e5f8c`，在页头上换成黄铜 `#e7d6a2`（保证任何底上都能看见）。
- **签名交互**：待裁决的**勘误单**。头行是类型标记 + 主题 + 创建时间；对勘区左「现行（· vN）」右「提议（置信度 0.61）」，中间一条 1px 竖线；尾行是等宽 changeId（`user-select: all`）与复制按钮。窄屏竖线转横线后上下叠放。全页只有这一处「有性格」的版式，其余按平台惯例。
- **密度**：表格行 14px 上下内边距、13px 主题/版本/时间、15px 陈述；统计带 4 格 + 竖线分栏；主题区是「标签+标识符 / 说明 / 计数条 / 数字」四列网格。
- **数字与时间稳定**：千分位手工分组、时间固定 `YYYY-MM-DD HH:mm`（本地时区，手工补零），不用 `toLocaleString` 的区域数据；`font-variant-numeric: tabular-nums` 贯穿表格与统计。
- **深浅色**：纸面是默认，`prefers-color-scheme: dark` 换成墨底 `#131611`（重新取的一组值，不是自动反转），页头转为更深的布面绿。`<meta name="theme-color">` 两套。

## 5. 状态矩阵

| 状态 | 表现 |
|---|---|
| 加载 | 骨架块：统计数字 `—`、表格 5 行、最近更新 5 行、勘误单 2 张、主题 6 行；`aria-busy="true"`；骨架 1.5s 呼吸（`reduced-motion` 下停止） |
| 空·无记忆 | 「还没有记忆」+ 一句「dsh 通过 memory_upsert 写入偏好」；统计归零，主题仍列 12 行 0 计数 |
| 空·无待裁决 | 「没有待裁决」+ 说明下一次分歧会出现在这里 |
| 空·筛选无结果 | 「「代码评审」还没有记忆 / 换一个主题…」+ 清除主题筛选 |
| 空·检索无结果 | 「没有命中的记忆」+ 清除搜索；若命中存在但被主题筛掉，文案改为「检索命中 N 条，都不在「X」下」+ 清除主题筛选 |
| 错误·单区块 | 一行 `inline-error`：红点 + 标题（如「网关返回了错误（HTTP 500）」）+ · + 恢复提示 + 重试 |
| 错误·401/403/网络 | 页头下红色横幅说明一次（Access 鉴权 / 无权限 / 网关不可达）+ 一处重试；各区块只留「读取失败 · 原因见页面顶部提示」 |
| 鉴权提示 | 文案给两条路径：刷新重新登录、确认 Access 策略覆盖当前身份（含 service token 场景） |
| 搜索中 | 按钮变「搜索中…」并禁用，`aria-busy` 上到表体 |
| 复制 | 成功「已复制」（4s 后清除），失败「复制失败，请手动选中」并把 changeId 设为可整段选中；两者都通过 `role="status"` 播报 |

## 6. 安全实现

- 后端文本一律 `textContent`（含表格、勘误单、错误信息、状态值）；全文件无 `innerHTML` / `outerHTML` / `insertAdjacentHTML` / `document.write` / `eval`。
- 复制的 changeId 只来自 `/v1/pending`，写剪贴板走 `navigator.clipboard.writeText`（要求 secure context），失败降级到隐藏 `<textarea>` + `document.execCommand('copy')`，再失败就提示手动选中，不弹窗。
- 没有本地存储、没有第三方请求、没有 token 处理、没有客户端路由。

## 7. 无障碍

- 语义：`main` / `nav`（`aria-label="页面区块"`）/ `header` / `footer`、四个 `<section aria-labelledby>`、`<table>` 带 `<caption>` 与 `scope="col"`、`<dl>` 统计与状态、`<ol>` 列表；区块容器有 `tabindex="-1"` 让锚点跳转移动焦点；跳过链接在首次 Tab 出现。
- 焦点：全局 `:focus-visible` 2px 环 + 2px 偏移；输入框焦点态边框同色；页头内焦点环换黄铜以保证在绿底上可见。实测（CDP）首次 Tab 落在「跳到主要内容」，`outline: solid 2px rgb(30,95,140)`；搜索框 `:focus-visible` 为真；页头「刷新」为 `rgb(231,214,162)`。
- 对比度：手工计算 21 组前景/背景，浅色最低 **4.93:1**（`ink-muted` on `row-hover`），深色最低 **5.19:1**；正文、次要、说明、页头、按钮文字、错误文字、焦点环全部 ≥4.5:1。
- 动效：只有两处——骨架呼吸与数据到达时 180ms 淡入（表格只淡入，不做 transform）；`prefers-reduced-motion: reduce` 下 `transition/animation` 归 0.01ms、`scroll-behavior: auto`（实测）。
- 375px：无横向溢出（实测 `scrollWidth === innerWidth === 375`）；表格在 620px 以下转为堆叠行（主题+版本 / 陈述 / 时间），表头视觉隐藏但保留给辅助技术。
- 其他浏览器表面：`::selection`、`caret-color`、`scrollbar-color`、`text-underline-offset` 都按纸墨配色定义；打印样式去掉页头/导航/按钮，用 `Canvas`/`CanvasText` 系统色。

## 8. 验证过程

没有真实后端可连，验证用两个临时工具（都在 `%TEMP%`，未进入仓库、已随会话结束废弃）：

1. 一个 Node mock 服务，按本文件 §3 的契约返回 14 条合成记忆、3 条待裁决、12 个主题，并有 `empty` / `error(500)` / `auth(401)` 三种模式。合成数据只用于截图，**没有写进任何交付文件**。
2. 用 CDP 驱动 headless Chrome（`Chrome/158`），在 1280×900 与 375×812、浅色与深色下整页截图，并回读 DOM/计算样式做行为验证。

截图（留在 `%TEMP%\smriti-ui-review\`，未提交）：`desktop-light.png`、`desktop-dark.png`、`mobile-light.png`、`mobile-dark.png`、`mobile-dark-top.png`、`search.png`、`filter-empty.png`、`search-filter-empty.png`、`empty.png`、`empty-mobile.png`、`error.png`、`auth.png`、`sticky.png`、`focus-input.png`、`copy.png`、`copy-ok.png`、`scrolled.png`。最后的字体级差收敛与底色修法之后重新截了一轮，上面的结论都基于最终版本。

实测结论：

- 正常模式四次取数全部成功，DOM 中无残留骨架、无 `aria-busy="true"`、控制台无错误（favicon 补 data-URI 前有过一次 404，已修）。
- 粘性导航与粘性表头对齐：`nav.bottom = 48`、`thead th top = 48`，无缝隙；滚动到表格时导航高亮为「记忆」，回到页首为「概览」。
- 检索：`pnpm 包管理器` 命中 2 条，命中项的版本/更新时间由已加载列表水合补回；主题筛选在检索态生效且文案解释「命中 N 条 / 当前筛选 0 条」。
- 复制：授予剪贴板权限后点「复制 changeId」→ 就地「已复制」+ `aria-live` 播报；不授权时走降级路径 → 「复制失败，请手动选中」。
- `empty` / `error` / `auth` 三种模式截图与 §5 的文案一致；500/401 模式下控制台的 `Failed to load resource` 是预期的请求失败日志，不是脚本错误。
- 键盘：Tab 顺序 跳过链接 → 导航四项 → 刷新 → 检索输入 → 搜索 → 清除 → 主题 → 表格（表格行不可聚焦）→ 勘误单复制按钮；所有可聚焦元素有可见环。

## 9. `impeccable detect` 结果

命令：`impeccable detect --json C:\Code\Smriti\public\ui`，**最终输出 `[]`（无发现）**。

过程中的发现与处理（留档，便于复现）：

1. `low-contrast`（3 条 warning）：报的是深色方案的 token（`#e7e9e0`、`#8f9587`、`#b7bdb0`）与 `#ffffff` 的对比。原因是 `body` 上写的是 `background: var(--paper)` 简写，检测器无法解析该简写带来的底色，回退到白色地面，于是浅色地面上的深色文字被判不达标。用三个最小样例复现确认：`@media` 里覆盖变量、在媒体查询外用 var 时会被误判；媒体查询内直接写颜色、或使用 `light-dark()` 都判定正确。修法是把 `body` 改成 `background-color: var(--paper)` 并同样给 `html` 上底色（这本身也更精确，不会重置其他 background 属性）——检测器随即能解析真实底色，全部通过。反向核对：手工算的 21 组对比度全部 ≥4.5:1，与检测器结果一致。
2. `design-system-color`（advisory）：`#fff` / `#000` 来自打印样式，已改成 `Canvas` / `CanvasText`；深色 `--rule-soft` 等未登记的色值，已补进 `DESIGN.md` 的 token 清单（浅深两套都列全）。
3. `design-system-font-size`（advisory，12 条）：CSS 里存在 11px / 14px / 1.0625rem / 1.3rem / 1.75rem / 1.75rem 等不在级差里的字级。这不是检测器的问题，是级差不够收敛：已把字级压缩到 **12 / 13 / 15 / 18 / 22 / 24 / 32** 七步（并删掉两处仅在 400px 断点生效的尺寸覆盖），同时把七步写进 `DESIGN.md` 的 typography 前端元数据。

## 10. 未验证项与已知限制

**未验证（需要真实环境）**

- 没有连接真实 Worker：响应形状已由 edge-fix 逐字段确认（见 §3），但仍是按契约与 mock 验证，没有在真实部署上跑过；分页/上限语义按实现方说明（`limit` 默认 200、上限 500、非法值 400），前端固定发 200。
- 没有在 Cloudflare Access 后面跑过：401 分支只用 mock 401 验证。真实 Access 在请求未被放行时通常直接拦截（`/ui` 本身也鉴权，会拿到 JSON 401 而不是页面）；页面内横幅覆盖的是「页面已加载但 API 会话失效」这一场景。若 Access 对未登录请求做 302 跳转而不是 401，前端会落到「响应不是有效的 JSON」分支（文案已给出提示），未实测跳转行为。
- 没有真实 AI Search：`/v1/recall` 的相关度排序、`aiSearch: false` 时的降级行为、语义检索返回条目的稳定性都未验证。
- 没有在 Safari / Firefox / 真机 iOS / 真实屏幕阅读器（NVDA、VoiceOver）上跑过；无障碍结论来自 CDP 计算样式、键盘事件模拟与对比度计算，不等于真机读屏验证。
- 没有做真实打印预览（打印样式只有 CSS，未截图验证）。
- 深色模式只验证了 `prefers-color-scheme` 自动切换，没有做手动主题切换开关（brief 未要求）。
- 未做「200 条上限」以外的分页：`/v1/memories` 一次取 200 条，超过部分不显示（页面上会写出「最多 200 条」，但不提供翻页）。

**已知限制 / 后续**

- 页面依赖 `/ui` 路由与 `ASSETS` 绑定（edge-fix 负责）。静态资源用绝对路径 `/ui/styles.css`、`/ui/app.js`，所以 `/ui` 不带斜杠直接服务即可，不要 302 到 `/ui/`。
- 前端不做排序/分页/批量操作——这是「只读、裁决只在命令」的刻意结果。
- 时间显示为浏览器本地时区（`datetime` 属性保留原始 ISO），跨时区阅读时以页面底部「数据获取时间（本地时区）」为准。
- 如果团队希望检测器与 token 结构进一步合并成单一声明，可把深色调色板迁移到 `light-dark()`（检测器正确处理该函数、且 CSS 会少一个重复块），代价是浏览器下限抬到 Chrome 123 / Safari 17.5 / Firefox 120；本次选择保留 `@media` 变量覆盖，兼容性优先。

## 11. 变更文件清单

- 新增 `public/ui/index.html`、`public/ui/styles.css`、`public/ui/app.js`
- 新增 `PRODUCT.md`、`DESIGN.md`
- 新增 `docs/ui.md`（本文）

未改动 `src/`、`wrangler.jsonc`、`package.json`；没有 git commit / push。

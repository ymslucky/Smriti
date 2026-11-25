# `/mcp` 的 405 教程页（`public/ui/mcp.*`）

> 交付物：`public/ui/mcp.html`、`public/ui/mcp.css`、`public/ui/mcp.js`，本文为设计与验证记录。产品的视觉世界与令牌沿用 `DESIGN.md` / `public/ui/styles.css`，没有另起一套设计语言。

## 1. 页面是什么、由谁返回

- Worker 的 `GET /mcp`（以及其它非 `POST` 方法）返回 **`405 Method Not Allowed`**，响应头固定声明 `Allow: POST`；浏览器的 `Accept` 含 `text/html` 时，响应体是从 `ASSETS` 取出的本页（`src/http/app.ts` 的 `mcpMethodNotAllowed` / `MCP_TUTORIAL_HEADERS`）。页面不改变状态码语义：客户端读到的仍是 405 + `Allow: POST`。
- 页面路径是 `/ui/mcp.html`，因此样式与脚本用绝对路径 `/ui/styles.css`、`/ui/mcp.css`、`/ui/mcp.js` 引用；浏览器地址栏显示的是 `/mcp`。
- 本轮只新增了 `public/ui/mcp.html`、`public/ui/mcp.css`、`public/ui/mcp.js` 与本文。`src/`、`wrangler.jsonc`、其它 `public/` 文件未改动；上述 Worker 侧逻辑在仓库既有提交（`5713580`）里已存在，本页只是它的正文。
- 鉴权顺序在路由之前：未登录 Access 的浏览器打开 `/mcp` 会先被拦成 401 / 登录流程，看不到本页；本页面向已登录的浏览器（或 `AUTH_MODE=dev`）。MCP 客户端与 curl 看到的仍是原 JSON `method_not_allowed`。

## 2. 内容结构与事实来源

| 区块 | 内容 | 事实来源 |
|---|---|---|
| 页头 | 品牌 Smriti + 「MCP 接入教程」+ 徽标「HTTP 405 · 预期行为」+「返回看板」`/ui` | 任务约束、`styles.css` 的 `.binding` / `.brand` / `.btn--onbind` |
| 这个端点是什么 | Streamable HTTP / JSON-RPC 2.0 / POST only，八个工具与用途，`/ui` 与 `/mcp` 的分工 | `src/mcp/server.ts` 的 `toolSchemas`、`DEFAULT_*_LIMIT`、工具描述 |
| 为什么是 405 | GET 是页面导航不是 MCP 调用；405 + `Allow: POST`；两种响应体；健康检查用 `/healthz` | `src/http/app.ts` 的 `MCP_TUTORIAL_HEADERS`、`mcpMethodNotAllowedJson`、`/healthz` 路由 |
| 30 秒验证 | `/ui` Console 的 `fetch('/mcp', …)`、带 service token 的 curl、initialize 顺序 | `src/http/app.ts` 的 MCP 头约定；`docs/deploy.md` §7；`test/edge/app.test.ts` 的 initialize → initialized → tools/call |
| 常见错误码 | 401 / 500 / 405 / 404 / 503 五行，含含义与排查方向 | `src/auth/access.ts`、`src/http/app.ts` 的 `serveUi` / `jsonError` 路由；`README.md` |
| 接下来 | 装插件、`mcp__smriti__*`、裁决仍走 `/memory`；链接 `/ui` 与 GitHub README | `docs/deploy.md` §8–9、`README.md`、仓库 remote `ymslucky/Smriti`（`master`） |
| 页脚 | 405 与 `Allow: POST` 的注脚 | 同上 |

文案坚持三件事：405 是预期协议语义而非故障；`POST` 是唯一方法；写入与裁决不在网页里进行。

## 3. 设计决策

- **模式**：这是一个 **Read** 表面（教程 / 说明），落在既有 Operate 世界的装订记录册里。按 new-work 的「既有世界中的新表面」处理：不换世界、不改 `DESIGN.md`、不做 concept-seed 摇号；本表面按既有的 code-led 路径构建，没有 comp。
- **复用而非重画**：`styles.css` 的 `:root` 令牌、`.binding`、`.brand`、`.sections` 粘性导航、`.btn` / `.btn--onbind` / `.btn--copy`、`.skip`、`.colophon`、`:focus-visible`、深浅色、`reduced-motion` 全部直接继承；`mcp.css` 只加文档排版（事实带、两栏分工、文档表格、代码块、步骤列表）。没有新增颜色值、没有阴影、没有渐变、没有卡片网格、没有彩色左边框。
- **状态徽标用装订色**：405 既不是积压（黄铜只属于待裁决），也不是可操作状态（绿色只表示可交互 / 已完成），所以徽标用页头的 `bind-rule` 边 + `bind-ink` 字 + 一个 `bind-ink-2` 小方块，写在页头而不是内容区。它陈述「预期行为」，不做红色告警。
- **首屏即答案**：页头下第一屏就是「这个端点是什么」+ 三格事实带（传输 / 协议 / 方法），第三格直接给出 `Allow: POST`；随后是八个工具的表，再往下才是分工。信息顺序对应读者的三个问题：这是什么 → 为什么坏不了 → 怎么接。
- **分区不编号**：DESIGN.md 明确禁止 kicker 与分区编号，因此章节用导航名（这个端点是什么 / 为什么是 405 / 30 秒验证 / 错误码 / 接下来），不写「01」「§1」。有序列表的编号只用于真正的步骤序列（initialize 顺序、接入顺序）。
- **表格**：两个 `<table>` 都用 1px 细线 + 可见 `<caption>` + `scope="col"`，复用记录册的表格密度；窄屏（≤620px）表头视觉隐藏但保留给辅助技术，行转为单列堆叠，单元格按「状态码 → 含义 → 排查方向」顺序读。
- **代码块**：卡片式边框在此只用于「粘贴的文稿」：`surface` 底 + 1px `rule-strong` 边 + 2px 圆角，头行是语言标签（12px、`ink-3`）+ 复制按钮（复用 `.btn--copy`），正文等宽 13px、`white-space: pre`、容器 `overflow-x: auto`；滚动容器 `role="region"` + `tabindex="0"` + `aria-labelledby`，键盘可聚焦并有 2px 焦点环。窄屏只让代码块内部横向滚动，页面本身不产生横向溢出。
- **复制反馈**：`mcp.js` 只用 `navigator.clipboard.writeText`，失败降级到隐藏 `<textarea>` + `execCommand('copy')`，再失败就把代码文本选中并显示「复制失败，请手动选中」——不弹窗、不覆盖内容、无依赖、无 `innerHTML`。每个代码块有自己的 `role="status"` 反馈位。
- **响应式**：1280 / 768 / 375 三档都实测（见 §6）。820px 断点收紧表格首列宽度，700px 分工变单列，620px 事实带与两个表格堆叠；375px 为设计下限。
- **浏览器表面**：沿用 `styles.css` 对 `::selection`、`caret-color`、`scrollbar-color`、`text-underline-offset` 的定义；`<meta name="theme-color">` 浅深两套；`<title>` 与描述独立于卡片页。

## 4. 无障碍

- 语义：一个 `<h1>`（品牌 + 页名）、每个区块一个 `<h2>`、验证小节用 `<h3>`；`<nav aria-label="本页章节">`、`<main tabindex="-1">`、`<dl>` 事实带与分工、`<ol>` 步骤、`<table>` 带 `<caption>` 与 `scope="col"`、`<footer>`。
- 跳过链接为全页第一个 Tab；页头内焦点环自动换成 `focus-on-bind`。代码块滚动区可聚焦，默认焦点环可见（实测 `solid 2px rgb(30,95,140)`；页头链接为 `rgb(231,214,162)`）。
- 对比度：所有颜色取自 `styles.css` 已实测 ≥4.5:1 的令牌组合；本页新增的只是 12px 的 `ink-3` 标签（浅色 `#5f665b`、深色 `#8f9587`，均已在 `DESIGN.md` 记录为合规）。
- 动效：本页不新增动画；`prefers-reduced-motion` 的全局规则照常生效。复制反馈仅改变文本。
- 表格窄屏堆叠时表头视觉隐藏但保留给辅助技术，不用 CSS `content` 伪造列名。

## 5. 检测结果

命令：`impeccable detect --json C:\Code\Smriti\public\ui`。

处理过程中出现并已修掉（留档）：

1. `cramped-padding`（2 条 warning）：≤620px 时事实带单元格的 `padding` 被收成左右 0，且它有 `border-top/left`。已删除该覆盖，窄屏保留 `14px 20px 16px` 内边距（与首页统计带一致）。
2. `wide-tracking`（2 条 warning）：`.code__lang` 与 `.doc-table th` 的 `letter-spacing: 0.06em`。已收到 `0.04em`。

最终输出只剩 **1 条 advisory**：

```json
{
  "antipattern": "flat-type-hierarchy",
  "severity": "advisory",
  "snippet": "Role sizes: body 15px, h3 18px, h2 22px (largest adjacent step 1.22:1; target 1.25:1; weight separates headings from body text)"
}
```

这是 `DESIGN.md` 七步印刷级差（12 / 13 / 15 / 18 / 22 / 24 / 32）的直接结果：h3 18px 与 h2 22px 的相邻比是 1.22。要消掉它必须改字号级差（例如把区块标题提到 24px 或去掉 18px 小标题），那会与既有 `DESIGN.md` 和 `/ui` 的级差冲突；本页选择保留 advisory，靠字重、衬线字体与留白区分层级，而不是为检测器另造一套尺度。

## 6. 渲染验证（headless Chrome，CDP）

用 Node 内置 `http` 起一个临时静态服务（`%TEMP%`，未进仓库），把 `public/` 挂在根路径，并让 `GET /mcp` 返回 `public/ui/mcp.html` + **405 / `Allow: POST` / `content-type: text/html; charset=utf-8` / `cache-control: no-store`**，模拟 Worker 的内容协商。用 headless Chrome（`--headless=new`）+ CDP 在 1280×900、768×1000、375×812 下，浅色与深色各截整页图并回读 DOM / 计算样式。

证据文件（留在 `%TEMP%\smriti-mcp-review\`，未提交）：

- `final-desktop-light.png`、`final-desktop-dark.png`（1280）、`final-tablet-768.png`、`final-mobile-375.png`、`final-mobile-375-dark.png`。

实测结论：

- 三个宽度下 `document.documentElement.scrollWidth === innerWidth`（1280/768/375），页面无横向溢出；窄屏只有代码块内部出现横向滚动（375 下 3 个代码块、768 下 1 个长 JSON 行），符合「代码块可横向滚动」的要求。
- 页面在 `/mcp` 上拿到 `status 405`、`allow: POST`、`content-type: text/html`；页面文本包含「HTTP 405 / 预期行为」、`/healthz` 与八个工具名；静态 HTML / CSS / JS 中没有 `innerHTML` / `outerHTML` / `insertAdjacentHTML` / `document.write`。
- 深浅色：`body` 背景/前景分别为 `rgb(242,243,237)` / `rgb(22,26,22)` 与 `rgb(19,22,17)` / `rgb(231,233,224)`，即 `paper` / `paper-dark` 与 `ink` / `ink-dark` 两套令牌。
- 结构：`lang="zh-CN"`；标题顺序为 H1「Smriti MCP 接入教程」→ 五个 H2 → 五个 H3，没有跳级；无重复 `id`；页内 `#` 锚点全部能解析；2 个 `<caption>`、5 个 `th[scope="col"]`、4 个代码滚动区（`role="region"`）与 4 个复制反馈位（`role="status"`）、4 个复制按钮。
- 键盘：Tab 顺序为「跳到主要内容 → 返回看板 → 五个章节链接 → 复制按钮 → 代码滚动区 → 下一个复制按钮…」；跳过链接与页头链接的焦点环分别为 `rgb(30,95,140)` 与 `rgb(231,214,162)`（装订上的黄铜焦点），代码滚动区为 2px 蓝色焦点环。
- 复制：注入 stub 验证成功分支 → 就地「已复制」并在 4s 后清空；同时让 `navigator.clipboard.writeText` 与 `execCommand` 都失败 → 「复制失败，请手动选中」且选中代码文本（实测选中 138 字符）。headless 中真实点击的 `clipboard.writeText` 返回的 promise 不落地，无法直接读回系统剪贴板，因此真实点击只验证了「不报错、无错误反馈」，成功/失败分支用 stub 覆盖。
- 表格窄屏：≤620px 时 `caption` 占满内容宽（343px），`td` 宽度均为 343px，表头是 1×1 视觉隐藏但仍可被读屏访问；三列表格按「状态码 → 含义 → 排查方向」竖向堆叠。

## 7. 未验证项与已知限制

- **未在真实 Cloudflare 部署 / Access 后面验证**：没有可用的域名与 service token；405 页面、`Allow: POST`、`no-store`、`nosniff` 是按 `src/http/app.ts` 的既有实现用本地服务模拟的，真实 Worker 上的内容协商（`Accept` 含 `text/html`）未实跑。
- **未验证未登录时的表现**：鉴权在 `/mcp` 路由之前，未登录用户应看到 Access 的 401 / 登录跳转而不是本页；这条路径只有代码阅读，没有真实 Access 环境实测。
- **真实剪贴板未端到端验证**：headless 无法稳定读回写入内容（见 §6），真实浏览器中的一次点击需要人工确认；降级路径已用 stub 验证。
- **浏览器同源 Origin 的结论**：`§3` 里「自定义域名上 Console 的 fetch 会 403 `Invalid Origin`」来自对 `agents@0.33.0` 的 `createStatelessMcpHandler` / `originValidationResponse` 源码阅读，并用独立探针（同样的 handler + 带 `Origin` 头的 Request）复现了 403；它没有在真实部署上复跑。若后续给 `/mcp` 配置 `corsOptions.origin`，该提示需同步更新。
- **未在 Safari / Firefox / 真机 iOS / NVDA / VoiceOver 上验证**；无障碍结论来自 CDP 计算样式、键盘事件与对比度令牌，不等于真机读屏验证。
- **未做真实打印预览**：打印样式只有 CSS（隐藏复制按钮与反馈、代码 `pre-wrap`）。
- **未在 1440 / 1600 宽度截图**：版式上限是 `max-width: 1200px`，按既有 `styles.css` 的行为应一致，但没有截图证据。
- **深色只验证了 `prefers-color-scheme` 自动切换**，没有手动主题开关（与 `/ui` 一致）。

## 8. 变更文件

- 新增 `public/ui/mcp.html`
- 新增 `public/ui/mcp.css`
- 新增 `public/ui/mcp.js`
- 新增 `docs/mcp.md`（本文）

未改动 `src/`、`wrangler.jsonc`、其它 `public/` 文件；没有 git commit / push。

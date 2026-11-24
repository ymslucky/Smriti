# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

原生静态 HTML/CSS/JS，无框架、无构建步骤、无外部字体或网络依赖（`public/ui/` 三个文件，由 Worker 以 `ASSETS` 绑定直出）。依据：`docs/ui-plan.md` §3 与任务 brief 的明确指定。

## Users

单用户：Smriti 的部署者本人（`README.md`：单用户、Access 保护），同时也是 dsh 的使用者。使用场景是工作间隙用桌面或手机浏览器打开 `/ui`，核对「记忆现在是什么样、有没有东西卡在待裁决、语义检索是否还活着」——不是来编辑内容的。写入与裁决由 dsh 内的 MCP 工具和 `/memory` 命令完成（`docs/ui-plan.md`：「裁决入口仅命令」）。

## Product Purpose

Smriti 是给 dsh 的永久记忆网关：R2 存真源，Cloudflare AI Search 提供混合检索，MCP 暴露读写工具。它让模型跨会话记住人的精炼偏好，而不是每次从头推断。成功意味着：偏好被正确记住、旧版本可追溯、同主题的分歧不会在无人察觉时被静默覆盖。

## Positioning

「只存精炼偏好 + 主题由 AI 命名与分层 + 槽位分歧交给人裁决」——不是让模型自由追加记忆。没有子主题的 topic 是槽位，新陈述不直接覆盖现有陈述，而是进入 `_pending` 等人工裁决；有子主题的 topic 是分类，可容纳多条互不冲突的陈述。记录带版本号与 `supersedes` 链，删除是保留 30 天历史的软删除。相邻产品能抄走向量检索，抄不走「主题由写入方按层级声明、同槽位冲突必须由人裁决」这条治理路径。

## Operating Context

- 数据真源是 R2（`memories/active/`、`_pending`、历史、journal）；AI Search 只从 R2 同步，索引滞后最多一个同步周期；
- 模型通过 MCP 工具（`memory_search` / `memory_get` / `memory_topics` / `memory_upsert` / `memory_list` / `memory_forget`）读写；人通过 `/memory review`、`/memory approve <id>` 裁决；
- `/ui` 在 Cloudflare Access 之后，同源 cookie 鉴权，前端不处理 token；本地 `AUTH_MODE=dev` 时直接可访问；
- 看板是只读的：不提供写入、审批、删除按钮。

## Capabilities and Constraints

- 只读视图，四个区块：概览（记忆总数 / 待裁决数 / 已用主题数 / AI Search 是否就绪 + 最近更新 5 条）、记忆（表格 + 主题筛选 + 关键词搜索）、待裁决（只读对比 + changeId）、主题（由数据推导的主题树与计数）；主题没有固定词表，点分表示层级；
- 可用只读端点：`GET /v1/stats`、`GET /v1/memories?topic=&limit=`、`GET /v1/topics`、`GET /v1/pending`、`POST /v1/recall`、`GET /v1/health`；
- 术语固定：**记忆 / 主题 / 待裁决**。`topic` 是写入方声明的层级标识（如 `identity.role`），展示名优先用 `topic_label`，其次用种子提示的中文名，最后回退到 id；
- 状态必须齐备：加载骨架、空状态（无记忆 / 无待裁决）、错误态（网关不可达 / 401 鉴权）、窄屏 ≥375px 单列；
- 深浅色都可用（`prefers-color-scheme`），焦点可见、键盘可达、`prefers-reduced-motion` 生效；
- 中文文案；数字与时间格式稳定；
- 所有后端文本只用 `textContent` 渲染，禁止 `innerHTML` 拼接；复制 changeId 用 `navigator.clipboard` 并有降级。

## Brand Commitments

- 产品名 **Smriti**（梵语「记忆」），不译、不改写；
- 视觉承诺（brief 明示）：档案 / 图书馆的克制气质——纸墨底色、衬线标题、清晰的数据表；**不要**紫色渐变、玻璃拟态、大圆角卡片堆砌；
- 语气克制、陈述事实，不推销、不玩梗、不用 emoji；错误文案要说清问题与恢复路径。

## Evidence on Hand

仓库里没有真实记忆数据、没有截图、没有统计数据。任何演示数据都是合成的，必须标注或在使用说明里注明；不能编造记忆条数、主题分布或检索能力。

## Product Principles

1. **只读就是只读。** 页面不提供任何写入路径；需要改动时指向命令，而不是模拟按钮。
2. **先回答「现在是什么样」。** 首屏先给数量与状态，再给明细；每条信息都能在几秒内找到。
3. **旧版本与新版本同时在场。** 版本号、更新时间、旧→新对比是核心信息，不做隐藏或折叠。
4. **克制不是没有观点。** 视觉个性来自字体、排版密度、表格纪律与一次记忆点（勘误式对比），不来自装饰。
5. **失败要说清哪里断了。** 网关不可达、Access 未通过、AI Search 未就绪是三种不同状态，文案不混用。

## Accessibility & Inclusion

brief 明确要求：键盘可达、焦点可见、`prefers-reduced-motion` 生效、深浅色皆可读、375px 宽单列可用；正文对比度按 WCAG AA（≥4.5:1）执行。

---

> 记录方式：本文件由 subagent 依据 `docs/ui-plan.md`、`README.md`、`src/types.ts`、`src/topics.ts` 与任务 brief 推断填写，没有人工访谈轮（见 `docs/ui.md` §记录方式）。上文未标注来源的结论均直接来自这四个文件；`## Stack` 是 brief 与计划的指定，不是访谈结论。

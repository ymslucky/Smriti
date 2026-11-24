# Smriti WebUI 与第一轮修复计划

> 注：本文件是当时那一轮的计划口径。之后主题词表已改为「由 AI 在写入时创建、点分层级」，见 `docs/design.md` 的「主题词表」一节；这里的「12 个固定主题」只反映当时状态。

> 目标：先修上一轮评审确认的 P0/P1 问题，再叠加只读 WebUI。UI 信息范围按已确认决策收敛：**裁决入口仅命令**，WebUI 只做展示，不提供审批/写入按钮（后续要加再说）。

## 1. 范围

### 先修（P0/P1）

| 编号 | 问题 | 处理 |
|---|---|---|
| P0-1 | AI Search 命中解析用了顶层 `key`，真实结构是 `item.key` | 修 `ai-search.ts`，兼容 `item.key`/顶层 key、带/不带 `memories/active/` 前缀；补真实形状测试 |
| P0-2 | 缺 `nodejs_compat` | `wrangler.jsonc` 加 flag |
| P0-3 | 写入/裁决/删除后不触发同步 | `handle` 成功路径 `ctx.waitUntil(search.sync())` |
| P1-1 | `updated_at` 元数据 ISO 与 AI Search number 冲突 | R2 元数据写 epoch 毫秒字符串，`parseBody` 兼容；文档统一 |
| P1-2 | 召回/检索返回已删除或旧版本 | 命中后按 `store.getActive` 水合，缺失丢弃，文本用 R2 最新 |
| P1-3 | approve 先移历史后写新记录，失败丢记忆 | 先写新 active，再移旧版，最后删 pending |
| P1-4 | 近重复只查滞后索引 | 增加本地 active 的归一化精确比对兜底 |
| P2-1 | 一条坏对象拖垮 listActive | 逐条容错跳过 |

### 新增（WebUI）

只读仪表盘，一个页面四个区块：

1. **概览**：记忆总数、待裁决数、主题数；AI Search 绑定是否就绪；最近更新的 5 条记忆。
2. **记忆**：表格（topic、陈述、版本、更新时间），支持 topic 筛选与关键词搜索（语义走 `/v1/recall`，本地过滤走列表）。
3. **待裁决**：只读列表，展示「旧 → 新」对比与 changeId（复制后到 `/memory approve` 执行）。
4. **主题**：12 个固定主题的计数条。

无写入、无审批、无删除。空状态、加载态、错误态、窄屏布局都要有。

## 2. 新增 API（保持现有契约不变，只加只读端点）

| 方法 | 路径 | 响应 |
|---|---|---|
| GET | `/v1/stats` | `{ totals:{memories,pending,topics}, byTopic:[{topic,label,count}], recent:[{id,topic,statement,updatedAt}], health:{aiSearch:boolean,instance:string,authMode:string,searchError?:string} }`（`aiSearch` 是对 AI Search 的真实探活，`searchError` 仅在不健康时出现） |
| GET | `/v1/memories?topic=&limit=` | `{ items: MemoryRecord[] }`，limit 默认 200、上限 500 |
| GET | `/ui`、`/ui/*` | 静态资源（先鉴权，再 `env.ASSETS.fetch`） |

`/v1/topics`、`/v1/pending`、`/v1/recall`、`/v1/health` 复用。

## 3. UI 架构

- 静态资源放 `public/ui/`：`index.html`、`styles.css`、`app.js`，无构建步骤。
- `wrangler.jsonc` 增加：
  ```jsonc
  "assets": { "directory": "./public", "binding": "ASSETS", "run_worker_first": true, "not_found_handling": "none" }
  ```
- Worker 路由 `/ui` 与 `/ui/*`：先 `authenticate`，再 `env.ASSETS.fetch('/ui/index.html')` 或原请求。
- 设计执行 `/impeccable`：Operate 模式，克制的档案/纸墨气质，系统字体栈 + 一个衬线标题，浅色为主并支持 `prefers-color-scheme: dark`；对比度、焦点态、reduced motion 必须过。

## 4. 子智能体分工

| 智能体 | 文件范围 | 任务 |
|---|---|---|
| search-fix | `src/search/**`、`test/search/ai-search.test.ts` | P0-1 + 真实响应测试 |
| memory-fix | `src/service.ts`、`src/recall.ts`、`src/storage/body.ts`、`test/service/**`、`test/search/recall.test.ts` | P1-1/2/3/4 |
| storage-fix | `src/storage/r2-store.ts`、`test/storage/**` | P2-1 容错 |
| edge-fix | `src/http/**`、`src/index.ts`、`src/env.ts`、`wrangler.jsonc`、`test/edge/**` | P0-2/3、`/v1/stats`、`/v1/memories`、`/ui` 路由与 ASSETS |
| ui | `public/**`、`docs/ui.md` | 只读仪表盘 + 设计文档 |

契约文件 `src/types.ts`、`src/contracts.ts`、`src/topics.ts` 由 lead 冻结，子智能体只读。

## 5. 验收

- `tsc --noEmit` 0 错误；
- 现有 147 个测试全过，新增测试覆盖：真实命中形状、水合、approve 失败、元数据 epoch、损坏对象、stats/memories、`/ui` 鉴权；
- `wrangler deploy --dry-run` 通过，assets 识别；
- UI 在 1280/768/375 三个宽度可用，键盘可操作，无控制台错误；
- 用 `impeccable detect` 跑一遍变更目标。

## 6. 已知假设

- UI 只读，因为“裁决入口仅提供命令”是已确认决策；
- 单用户，不做登录页（Access 负责）；
- `AUTH_MODE=dev` 时 `/ui` 直接可访问，便于本地开发。

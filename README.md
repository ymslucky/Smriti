# Smriti

> 给 dsh 的永久记忆网关：R2 存真源，Cloudflare AI Search 做检索，MCP 暴露读写工具。

状态：M0–M4 完成，已部署（`typecheck` + 207 个测试通过，`wrangler deploy --dry-run` 通过）。设计见 [docs/design.md](docs/design.md)，计划见 [docs/plan.md](docs/plan.md)，WebUI 见 [docs/ui.md](docs/ui.md)，MCP 教程页见 [docs/mcp.md](docs/mcp.md)，部署见 [docs/deploy.md](docs/deploy.md)。

## 它做什么

- 模型通过 MCP 工具 `memory_search` / `memory_get` / `memory_topics` / `memory_upsert` / `memory_list` / `memory_forget` 读写偏好；
- 只存精炼偏好，主题限定为 12 个固定值；
- 同主题的新陈述不直接覆盖，进 `_pending` 等人工裁决；
- 新偏好直接生效；删除是软删除，旧版本保留 30 天；
- 人用 `/memory review` 批准或拒绝冲突。

## 架构

```
dsh 插件 ──MCP/REST──▶ Worker（本仓库）
                        ├─ R2：active / pending / history / journal
                        └─ AI Search 实例：索引 memories/active/，混合检索
                             ├─ Vectorize（AI Search 托管）
                             └─ BM25
```

写入只经过 Worker；AI Search 只从 R2 同步，Vectorize 不接受外部写入。

## WebUI

`/ui` 是一个只读仪表盘（Operate 模式）：概览统计、最近更新、记忆表格与主题筛选、语义/本地检索、待裁决的旧→新对比、12 个固定主题计数。没有写入、审批、删除按钮——裁决仍在 dsh 里用 `/memory` 命令完成。

- 资源：`public/ui/{index.html,styles.css,app.js}`，零依赖、无构建步骤。
- 设计：`PRODUCT.md`、`DESIGN.md`、`docs/ui.md`（令牌、状态矩阵、对比度与验证记录）。
- 路由：`GET /ui`、`/ui/*`，先过 Access 鉴权，再由 `ASSETS` 绑定提供静态文件；`GET /` 会 302 到 `/ui`。
- `/mcp` 只有 `POST` 可用：浏览器直接打开时仍是 405，但按 `Accept: text/html` 返回教程页（`public/ui/mcp.html`，ASSETS 缺失时回退内联页），其它客户端仍收到 405 JSON。
- 注意：`workers.dev` 域名不经过 Access，直接访问会得到 401；请使用绑定了 Access 的自定义域名，或在本地/临时部署时用 `AUTH_MODE=dev`。

## API

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/mcp` | MCP 工具（Streamable HTTP） |
| POST | `/v1/recall` | 插件召回 |
| POST | `/v1/extract` | 自动捕获候选 |
| GET | `/v1/pending` | 待裁决列表 |
| POST | `/v1/pending/:id/approve` | 批准 |
| POST | `/v1/pending/:id/reject` | 拒绝 |
| GET | `/v1/stats` | WebUI 概览聚合（只读） |
| GET | `/v1/memories?topic=&limit=` | WebUI 记忆列表（只读，limit 默认 200 / 上限 500） |
| GET | `/ui`、`/ui/*` | WebUI 静态资源（先鉴权，再由 `ASSETS` 绑定提供） |
| GET | `/v1/health` | 健康检查（需鉴权） |
| GET | `/healthz` | 存活探针（免鉴权） |

## 本地开发

```sh
node <path-to-pnpm.mjs> install
node <path-to-pnpm.mjs> typecheck
node <path-to-pnpm.mjs> test
```

本地开发设 `AUTH_MODE=dev` 跳过 Access 校验：

```sh
node <path-to-pnpm.mjs> exec wrangler dev --var AUTH_MODE:dev
```

`AUTH_MODE=dev` 下 `http://localhost:8787/ui` 可直接访问（WebUI 仅做展示，裁决仍走命令 / MCP）。

AI Search 没有本地模拟，`wrangler dev` 下绑定会走远程实例（`remote: true`）。

## 部署

1. 建 R2 桶 `smriti-memory`；
2. 建 AI Search 实例 `memory`，数据源选该桶，path filtering 只放 `memories/active/**`，同步间隔设 15 分钟；
3. 配置实例元数据字段：`topic`（string）、`updated_at`（number）、`version`（number）；
4. `wrangler deploy` 后绑定自定义域名 `smriti.<你的域名>`；
5. Cloudflare Access 建应用：策略允许 `ymslucky@163.com`（One-time PIN）；再建 service token 给 agent；
6. `wrangler secret put ACCESS_TEAM_DOMAIN`、`ACCESS_AUD`。

`wrangler.jsonc` 里的 `assets` 会把 `public/` 下的 WebUI 静态资源一起上传（绑定 `ASSETS`，`run_worker_first: true`，未匹配资源交回 Worker）；`compatibility_flags: ["nodejs_compat"]` 提供 MCP SDK / jose 需要的 Node 内置能力。部署后访问 `https://smriti.<你的域名>/ui`（Access 登录后）。

## 目录

```
src/
  index.ts          Worker 入口（fetch + scheduled）
  http/app.ts       路由（含 /ui、stats、memories）
  auth/access.ts    Access JWT 校验
  mcp/server.ts     MCP 工具
  service.ts        记忆服务（冲突、裁决、删除）
  capture.ts        自动捕获启发式
  recall.ts         召回合并与水合
  search/           AI Search 适配
  storage/          R2 存储层
  topics.ts         固定主题词表
public/ui/          WebUI 静态资源
test/
```

## 非目标

多租户、Web 裁决页（第二期）、直接管理 Vectorize。

# 部署与 Cloudflare 配置

> 目标：把 Worker 部署到 `smriti.<你的域名>`，由 Access 保护，dsh 用 service token 访问。

## 0. 前置

- 域名已托管在同一 Cloudflare 账户；
- 已开通 R2；
- 已安装依赖并 `wrangler login`。

## 1. R2 桶

```sh
wrangler r2 bucket create smriti-memory
```

`wrangler.jsonc` 已绑定 `MEMORY` → `smriti-memory`。

## 2. AI Search 实例

在 Dashboard → AI Search：

1. 新建实例，命名 `memory`（default namespace）；
2. 数据源选 R2 桶 `smriti-memory`；
3. Path filtering：include `memories/active/**`，其它全部 exclude；
4. Sync interval：15 分钟（写入后网关还会尽力触发一次）；
5. Metadata schema 增加三个字段：`topic`（string）、`updated_at`（number）、`version`（number）；
6. 检索保持默认混合检索。

> 实例创建后，账户里会出现一个由 AI Search 管理的 Vectorize 索引，无需手工创建。

## 3. 部署 Worker

```sh
wrangler deploy
```

首次部署先设 `AUTH_MODE=dev` 验证链路：

```sh
wrangler deploy --var AUTH_MODE:dev
curl https://smriti.<域名>/healthz
curl https://smriti.<域名>/v1/health
```

确认后再在 `wrangler.jsonc` 中把 `AUTH_MODE` 改回 `access` 并重新部署。

## 4. 自定义域名

Dashboard → Workers → smriti → Settings → Domains & Routes → 添加自定义域名 `smriti.<你的域名>`。

## 5. Cloudflare Access

1. Zero Trust → Access → Applications → 新建 Self-hosted：
   - 域名：`smriti.<你的域名>`；
   - Session 时长按需；
   - Policy：Allow，Include → Emails → `ymslucky@163.com`；
   - 登录方式：One-time PIN（无需外部 IdP）。
2. 同一应用再加一条 Policy：Service Auth → 选择刚创建的 service token（或先建 token 再回来选）。
3. Service Tokens → 新建 `dsh-smriti`，保存 `Client ID` / `Client Secret`（只显示一次）。
4. 取 Access 的 Audience（Application → Overview → `AUD`）与团队域名（`<team>.cloudflareaccess.com`）。

## 6. Secrets

```sh
wrangler secret put ACCESS_TEAM_DOMAIN   # 例如 myteam.cloudflareaccess.com
wrangler secret put ACCESS_AUD           # Access 应用的 Audience
```

## 6.1 MCP 来源（可选）

`/mcp` 默认放行同源（请求的 Host）。如果还有其他前端域名要直接调用 MCP，加一个变量：

```sh
wrangler secret put MCP_ALLOWED_ORIGINS  # 逗号分隔，如 https://admin.example.com,https://smriti.example.com
```

不配也没关系；浏览器从 `/ui` 页面发起的同源 `fetch('/mcp', ...)` 会自动放行，跨源会返回 403 `Invalid Origin`。

## 7. 验证

```sh
# 未带凭证应 401
curl -i https://smriti.<域名>/v1/health

# 带 service token 应 200
curl -i https://smriti.<域名>/v1/health \
  -H "CF-Access-Client-Id: <id>" \
  -H "CF-Access-Client-Secret: <secret>"

# MCP 工具列表
curl -s https://smriti.<域名>/mcp \
  -H "CF-Access-Client-Id: <id>" \
  -H "CF-Access-Client-Secret: <secret>" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

## 8. dsh 侧

1. `Smriti-DSH` 构建：`pnpm run build`；
2. 把插件装进目标 profile：`dsh plugin add <本机路径或 GitHub 仓库>`；
3. 在 profile 的 `cordis.patch.yml` 或插件配置里填 `gatewayUrl`；
4. 把 `dsh-smriti` 的 Client ID/Secret 写入 credentials（名称 `CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET`）；
5. 重启 dsh，确认出现 `mcp__smriti__*` 工具。

## 9. 首次冒烟

```text
/memory topics
/memory save tooling.package-manager 项目统一使用 pnpm
/memory search pnpm
```

再在对话里说“以后都用 pnpm”，确认下一轮上下文出现 `<memory_context>`。

## 故障排查

| 现象 | 检查 |
|---|---|
| 401 | Access 应用是否覆盖该域名；token 是否属于该应用 |
| 403 | Access policy 是否包含邮箱 / service token；strict service token 模式下**必须**是 `Service Auth` 动作的策略 |
| MCP 连不上 | `AUTH_MODE` 是否仍为 dev；`/mcp` 是否被 Access 拦截 |
| `memory_search` 报 `ai_search_not_found` | 实例名与命名空间：控制台 AI Search 里是否真有 `AI_SEARCH_INSTANCE`（默认 `memory`）这个实例；命名空间里只剩一个实例时 Worker 会自动改用它（日志有 warn） |
| `/v1/stats` 显示 `aiSearch: false` | 看同响应里的 `searchError`：`AI_SEARCH` 绑定未配置 / 实例不存在 / `info()` 失败，三种原因文案不同 |
| 检索为空 | AI Search 实例是否连桶、path filter 是否放行 `memories/active/` |
| `memory_search` 带 topic 报 `metadata_filter_unknown_field` | 实例 metadata schema 缺少 `topic` 字段（应是 string）；Worker 已自动回退为本地精确过滤（日志有 warn），补 schema 后过滤会重新下推 |
| 召回只剩"最近 N 条" | 日志里找 `smriti: recall 降级为 recent 兜底`；说明检索后端不可用，不是没有数据 |
| 刚写入却搜不到 | 写入后已在 `waitUntil` 里触发一次 `jobs.create()`，但 AI Search 建索引还要几十秒；`memory_get` 立即可读，`memory_search` 会滞后 |
| 写入不生效 | R2 对象是否生成；同步是否在冷却 |

# Smriti 设计

## 一句话

R2 是唯一真源，AI Search 是可重建的派生索引，Worker 网关是唯一写入口，dsh 插件负责自动召回与冲突裁决入口。

## 数据流

**写入**：模型调 MCP `memory_upsert` → 网关校验 topic 与正文 → 查同 topic 的 active：

- 无冲突：写 `memories/active/{topic}/{id}.md` → 审计 → 触发 AI Search 同步 → 返回 `applied`；
- 同 topic 不同陈述，或检索到高分近重复：写 `_pending/` → 返回 `pending_review`，active 不动。

**裁决**：人执行 `/memory review` → 网关返回旧/新对比 → 批准时旧版移入 `_history/`、新版写 active（`supersedes` 指向旧 id）→ 同步；拒绝时归档 pending，active 不变。

**读取**：`memory_search` 调 AI Search（混合检索 + topic 过滤），命中后按 `topic`+`id` 用 `memory_get` 水合到 R2 现行记录（索引正文是渲染后的 `# statement`，且可能滞后于删除/改写）；已删除或读不到的命中直接丢弃。`memory_get` 直读 R2，绕过索引滞后；召回时把检索结果与最近写入合并去重。

**自动召回**：dsh 插件在 `agent/pre-step` 调 `/v1/recall`，把命中偏好格式化为 `<memory_context>` 注入本步消息，同一 turn+step 只注入一次。

**自动捕获**：`agent/turn-stopping` 用启发式规则识别偏好句式，命中才调 `/v1/extract`；候选经过词表映射与去重后写入，或进入 pending。

## 存储布局

```
memories/active/{topic}/{id}.md          # 唯一被 AI Search 索引的前缀
memories/_pending/{changeId}.json        # 待人工裁决
memories/_history/{topic}/{id}.md        # 被取代/删除的旧版本（30 天后清理）
memories/_journal/{yyyy}/{mm}/{dd}/{id}.json
memories/_index/recent.json              # 最近写入索引，用于召回合并
```

对象元数据：`topic`、`updated_at`（epoch 毫秒数字字符串，读取兼容旧 ISO）、`version`（数字字符串）。正文是自描述的短 Markdown。

## 主题词表

固定 12 个 topic（见 `src/topics.ts`）。未知 topic 一律拒绝，写入返回 `unknown_topic` 与可用列表；新增主题只能改代码并部署。

## 一致性

写成功 = R2 落盘成功；索引状态单独返回。AI Search 同步默认 24 小时，部署时设 `sync_interval=900`（15 分钟）。写路径在落盘后**尽力**触发一次 `jobs.create()`：REST 的 `/v1/extract` 与 pending approve 走 `ctx.waitUntil`，MCP 的 `memory_upsert`（`applied`）与 `memory_forget`（命中）同样在 `ctx.waitUntil` 里触发；没有本地冷却，重复触发由 AI Search 侧的 429 自然节流（`sync()` 吞掉 429）。索引滞后期间由 `memory_get` 与 `_index/recent.json` 兜底。

## 鉴权

Cloudflare Access 挡在自定义域名前：

- 人：浏览器 SSO（邮箱 One-time PIN），用于将来的裁决页；
- agent：Access service token，请求头 `CF-Access-Client-Id` / `CF-Access-Client-Secret`；
- Worker 再校验 `Cf-Access-Jwt-Assertion` 的 audience（`ACCESS_AUD`），作为纵深防御；
- 本地开发用 `AUTH_MODE=dev` 跳过。

## 失败语义

- Access token 过期：401，MCP 连接断开，插件只告警不阻塞对话；
- 同步冷却 429：吞掉并等下次；
- AI Search 不可用：`memory_search` 返回空并在结果里带 `degraded: true` + `reason`（不伪装成"没有记忆"），`memory_get` 仍可用；`/v1/stats` 的 `health.aiSearch` 做真实探活并带 `searchError`，`/v1/recall` 降级为 recent 兜底时写一条 error 日志；
- AI Search 实例名与配置不一致：命名空间里只有一个实例时自动改用它（写 warn），否则降级并报出可见实例名；
- R2 写冲突：单写者，重试一次。

## 非目标

- 多租户、每用户实例、命名空间隔离（单用户自用）；
- 直接写 Vectorize（索引由 AI Search 托管）；
- Web 裁决页（第二期，接口已预留）。

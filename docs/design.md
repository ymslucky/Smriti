# Smriti 设计

## 一句话

R2 是唯一真源，AI Search 是可重建的派生索引，Worker 网关是唯一写入口，dsh 插件负责自动召回与冲突裁决入口。

## 数据流

**写入**：模型调 MCP `memory_upsert` → 网关校验 topic 与正文 → 查同 topic 的 active：

- 无冲突：写 `memories/active/{topic}/{id}.md`（带 `valid_from`）→ 审计 → 触发 AI Search 同步 → 返回 `applied`（分类主题可多条并存）；
- 槽位主题已有不同陈述：`CONFLICT_POLICY=manual`（默认）写 `_pending/` 返回 `pending_review`；`auto` 且置信度达标则旧版标失效进 history、新版生效并返回 `applied` + `autoApplied: true`；
- 跨主题近似（本地文本相似度 ≥ 0.72，或检索候选 ≥ 0.5）写 `_pending/` 返回 `pending_review`。

**裁决**：人执行 `/memory review` → 网关返回旧/新对比 → 批准时旧版 `valid_to = 批准时间` 并移入 `_history/`、新版写 active（`supersedes` 指向旧 id）→ 同步；拒绝时归档 pending，active 不变。

**删除与回滚**：`memory_forget` 不再物理删除——把记录的 `valid_to` 设为当前时间并移入 history；`GET /v1/history` 可查归档与「某时刻有效的事实」，`POST /v1/history/{topic}/{id}/restore` 把归档记录恢复为新的现行版本（当前 active 同时被取代进 history）。

**读取**：`memory_search` 调 AI Search（混合检索 + topic 过滤），命中后按 `topic`+`id` 用 `memory_get` 水合到 R2 现行记录（索引正文是渲染后的 `# statement`，且可能滞后于删除/改写）；已删除或读不到的命中直接丢弃。`memory_get` 直读 R2，绕过索引滞后；召回时把 core 记忆、检索结果与最近写入合并去重。

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

对象元数据：`topic`、`updated_at`（epoch 毫秒数字字符串，读取兼容旧 ISO）、`version`（数字字符串）、`valid_from` / `valid_to`（ISO；`valid_to` 仅历史记录有）、`topic_label`（可选）。正文是自描述的短 Markdown。

## 时间维度与历史

- 每条记录有 `validFrom`（缺省按 `createdAt`）与可选 `validTo`；`validTo` 为空表示仍然有效；
- `forget` / 被取代 → `valid_to = 操作时间`，对象移到 `_history/`，`moved_at` 记录归档时间，`reason` 记录原因；
- `GET /v1/history` 不带 `at` 返回归档记录（按失效时间倒序）；带 `at=ISO` 时把 active 与 history 合并，按 `validFrom ≤ at < validTo` 过滤，回答「那个时刻什么是真的」；
- `POST /v1/history/{topic}/{id}/restore` 恢复一条归档记录：版本号 +1、`supersedes` 指向当前 active，当前 active 被取代进 history，归档副本删除；
- 30 天清理只删 `_history/` 对象；恢复窗口与历史查询窗口一致。

## 冲突策略

| 配置 | 行为 |
|---|---|
| `CONFLICT_POLICY=caller`（默认） | 槽位冲突 / 疑似重复返回 `pending_review` 与 `changeId`，由**调用方模型**调用 `memory_resolve` 裁决（replace / merge / keep），裁决立即生效，不经过人工 |
| `CONFLICT_POLICY=server` | 服务端直接按"新覆盖旧"生效（旧版进 history，可 restore）；疑似重复则跳过写入并记 journal |
| `CONFLICT_POLICY=manual` | 返回 pending，等人工 approve / reject（兼容旧行为） |

`memory_resolve` 的三种决定：

- **replace**：提议取代现行，旧版失效进 history（可 restore 回滚）；
- **merge**：把提议与现行合并成一条新陈述（必须提供 `statement`）；
- **keep**：保留现行、丢弃提议，记 `reject` journal。

裁决写进 journal（`resolve:replace|merge|keep`），审计可查；pending 在裁决后立即删除。

## 常驻记忆（core）

`CORE_TOPIC_PREFIXES`（默认 `identity`）下的记录视为常驻记忆。`/v1/recall` 每次先带最多 `CORE_RECALL_LIMIT`（默认 5）条 core，再合并检索命中与最近写入，按 id 去重；core 项在返回里带 `core: true`。这让「角色 / 语言 / 硬约束」不依赖检索命中率也始终在场。

## 主题词表

**没有固定词表**：topic 由 AI 在写入时创建，`memory_upsert` 只校验语法 —— 小写字母 / 数字 / 连字符，点分最多 3 段（`identity`、`identity.role`、`project.smriti.stack`），首次写入即成为主题。

- **层级由数据推导**：某个 topic 一旦出现 `a.b`，`a` 就是分类；分类可容纳多条，没有子主题的 topic 是槽位（一条 active），槽位冲突仍进 `_pending` 等裁决；
- **展示名**：`topic_label` 可选，同一主题以最近一次带 label 的写入为准；没有 label 时回退到 `src/topics.ts` 的种子提示（中文名 + 说明），再回退到 id；
- **种子提示不是白名单**：`TOPIC_HINTS` 只用于展示名、说明与自动捕获关键词，AI 可以创建任意其它合法 id；
- **读取按子树**：`memory_list` / `/v1/memories` 传分类主题时返回整棵子树；`memory_search` 传分类主题时先放大取回数量再在内存里按子树过滤（AI Search 的 filter 只做精确匹配）；
- **一致性**：父 / 子主题已有归一化后相同的陈述时返回 `unchanged`，同一偏好不会在不同粒度重复落库；
- 主题在没有任何记录时不出现在 `memory_topics` 里；删掉最后一条记录后主题自然消失。

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
- AI Search 不接受 `topic` 过滤（线上报 `metadata_filter_unknown_field`，通常是实例 metadata schema 没建 `topic` 字段）：`memory_search` 自动退回"放大取回 + 本地精确过滤"，只写一条 warn，检索保持可用；
- 写入去重：本地文本相似度（字符二元组 Jaccard）为准，检索只做候选召回；检索故障时退化为只做本地判定，不阻塞写入；
- 自动生效（`auto`）在移旧版失败时抛错：新记录已落盘（不丢记忆），旧版仍在 active，可重试或 restore；
- R2 写冲突：单写者，依赖幂等键与 restore 兜底，不做自动重试。

## 非目标

- 多租户、每用户实例、命名空间隔离（单用户自用）；
- 直接写 Vectorize（索引由 AI Search 托管）；
- Web 裁决页（第二期，接口已预留）。

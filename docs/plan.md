# Smriti 实施计划

> 永久记忆网关 + dsh 插件。设计见 `docs/design.md`（待补），本文件只列工作包、分工与验收。

## 背景

- 单用户自用；只存精炼偏好；冲突由人工裁决；固定主题词表；历史保留 30 天；自动捕获默认开启。
- 存储：R2 为真源，AI Search（R2 数据源）提供混合检索，Vectorize 由 AI Search 托管。
- 身份：Cloudflare Access（邮箱 OTP），agent 用 Access service token。
- 仓库：`Smriti`（Worker 网关）、`Smriti-DSH`（dsh 插件）。

## 里程碑

| 里程碑 | 内容 | 验收 |
|---|---|---|
| M0 | 骨架、契约、两个仓库可 typecheck | `pnpm typecheck` 通过 |
| M1 | 只读链路：topics / list / get / search | 单测通过；部署后手工 seed 可召回 |
| M2 | 写入与裁决：upsert / pending / approve / reject | 冲突进 pending；批准后 active 切换、旧版进 history |
| M3 | 自动化：recall / extract / 插件召回与捕获 | 回合结束产生候选；下一步注入 `<memory_context>` |
| M4 | 收尾：cron 清理、runbook、CI | 30 天清理生效；文档齐全 |

## 工作包与文件所有权

| 包 | 负责 | 文件范围 |
|---|---|---|
| G0 骨架 | Lead | `Smriti/{package.json,tsconfig.json,wrangler.jsonc,src/types.ts,src/contracts.ts,src/env.ts,src/topics.ts,src/index.ts}`、`Smriti-DSH/{package.json,tsconfig.json,cordis.patch.yml}` |
| G1 存储 | 子智能体 storage | `Smriti/src/storage/**`、`Smriti/test/storage/**` |
| G2 检索 | 子智能体 search | `Smriti/src/search/**`、`Smriti/src/recall.ts`、`Smriti/test/search/**` |
| G3 冲突/捕获 | 子智能体 memory | `Smriti/src/service.ts`、`Smriti/src/capture.ts`、`Smriti/test/service/**` |
| G4 HTTP/MCP | 子智能体 edge | `Smriti/src/auth/**`、`Smriti/src/http/**`、`Smriti/src/mcp/**` |
| P1 插件 | 子智能体 plugin | `Smriti-DSH/src/**`（除骨架文件）、`Smriti-DSH/{README.md,docs/**}` |
| T1 测试/文档 | 第二批 | `Smriti/{README.md,docs/runbook.md,test/e2e/**}` |

## 接口契约（G0 固化，其他包只读）

- `MemoryRecord` / `PendingChange` / `SearchHit` / `UpsertResult` 见 `src/types.ts`。
- `MemoryStore`、`SearchIndex`、`MemoryService` 见 `src/contracts.ts`。
- R2 路径：`memories/active/{topic}/{id}.md`、`memories/_pending/{changeId}.json`、`memories/_history/{topic}/{id}.md`、`memories/_journal/{yyyy}/{mm}/{dd}/{eventId}.json`。
- 正文 Markdown：`# {statement}` + 可选 `## 理由` + rationale。
- R2 自定义元数据：`topic`、`updated_at`（epoch 毫秒数字字符串，读取兼容旧 ISO）、`version`（数字字符串）。
- 主题词表固定 12 个，见 `src/topics.ts`；未知 topic 拒绝。

## 对外 API

| 方法 | 路径 | 用途 |
|---|---|---|
| POST | `/mcp` | MCP 工具：search/get/topics/upsert/list/forget |
| POST | `/v1/recall` | 插件召回，返回精简条目 |
| POST | `/v1/extract` | 自动捕获候选 |
| GET | `/v1/pending` | 待裁决列表 |
| POST | `/v1/pending/:id/approve` | 批准 |
| POST | `/v1/pending/:id/reject` | 拒绝 |
| GET | `/v1/health` | 健康检查 |
| GET | `/healthz` | 免鉴权存活探针 |

## 验收命令

```sh
node <pnpm.mjs> install
node <pnpm.mjs> typecheck
node <pnpm.mjs> test
```

## 风险

- 免费计划 AI Search 超额行为未知（12-01 后验证）。
- AI Search 绑定无本地模拟，集成测试用 fake `SearchIndex`，真实链路靠部署后冒烟。
- Workers AI 不进入 MVP，捕获先用启发式规则，后续可替换。

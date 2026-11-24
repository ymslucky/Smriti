/**
 * MCP 入口：把 MemoryService 暴露成 6 个工具，挂在 `/mcp`（Streamable HTTP）。
 *
 * 结构分三层，便于在不联网的情况下测试 schema：
 * - `toolSchemas`：纯 zod schema，可直接单测；
 * - `createSmritiMcpServer(service)`：把工具注册到 McpServer，不碰绑定；
 * - `buildServer(env)` / `createMcpFetchHandler(getEnv)`：组装真实依赖并交给
 *   `createMcpHandler`（来自 `agents/mcp/server`，每次请求构造一个新实例）。
 */

import { createMcpHandler } from 'agents/mcp/server'
import { McpServer } from '@modelcontextprotocol/server'
import type { CallToolResult } from '@modelcontextprotocol/server'
import { z } from 'zod'
import type { MemoryService } from '../contracts'
import type { Env } from '../env'
import { createAiSearch } from '../search/ai-search'
import { createMemoryService } from '../service'
import { createR2Store } from '../storage/r2-store'
import { TOPIC_NAMES } from '../topics'
import type { SearchHealth, SearchHit, UpsertResult } from '../types'

/** 固定主题词表：未知 topic 在 schema 层就被拒绝。 */
const topicSchema = z.enum(TOPIC_NAMES)

/** 检索默认返回条数（与 service 的 DEFAULT_SEARCH_LIMIT 对齐）。 */
const DEFAULT_SEARCH_LIMIT = 10
const MAX_SEARCH_LIMIT = 50
const DEFAULT_LIST_LIMIT = 50
const MAX_LIST_LIMIT = 200

/**
 * 工具输入 schema。注册与测试共用这一份定义，避免两处漂移。
 * 注意：调用方传 snake_case，内部映射到 MemoryService 的 camelCase 参数。
 */
export const toolSchemas = {
  memory_search: z.object({
    query: z.string().min(1, 'query 不能为空'),
    topic: topicSchema.optional(),
    limit: z.number().int().min(1).max(MAX_SEARCH_LIMIT).optional(),
  }),
  memory_get: z.object({
    topic: topicSchema,
    id: z.string().min(1, 'id 不能为空'),
  }),
  memory_topics: z.object({}),
  memory_upsert: z.object({
    topic: topicSchema,
    statement: z.string().min(1, 'statement 不能为空'),
    rationale: z.string().optional(),
    confidence: z.number().min(0).max(1).optional(),
    idempotency_key: z.string().min(1).optional(),
    /** 来源定位，便于审计；插件会带 `{ session }`。 */
    source: z
      .object({
        session: z.string().optional(),
        message: z.string().optional(),
      })
      .optional(),
  }),
  memory_list: z.object({
    topic: topicSchema.optional(),
    limit: z.number().int().min(1).max(MAX_LIST_LIMIT).optional(),
  }),
  memory_forget: z.object({
    topic: topicSchema,
    id: z.string().min(1, 'id 不能为空'),
    reason: z.string().min(1, 'reason 不能为空'),
  }),
} as const

function textResult(value: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] }
}

function toolError(message: string): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify({ error: { code: 'tool_error', message } }) }],
    isError: true,
  }
}

/** 统一把 handler 抛出的异常转成 `isError: true` 的工具结果。 */
async function guarded(run: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await run()
  } catch (error) {
    return toolError(error instanceof Error ? error.message : String(error))
  }
}

/**
 * `memory_search` 的返回体。
 *
 * 空结果有两种完全不同的原因：真的没有记忆，或检索后端不可用（实例缺失/限流）。
 * 后者以前会直接抛成 `isError`，或者被吞成"空"——模型无法区分"不知道"和
 * "没有"。这里把已知的不健康状态显式标成 `degraded`，让调用方自己决定是否采信。
 */
export function memorySearchPayload(
  hits: SearchHit[],
  health?: SearchHealth,
): Record<string, unknown> {
  if (hits.length > 0 || health === undefined || health.ok) return { hits }
  return { hits, degraded: true, reason: health.reason ?? 'AI Search unavailable' }
}

/**
 * 写入成功后是否值得触发一次索引同步。
 *
 * 只有真正落盘（`applied`）或删掉（forget 命中）才改变 `memories/active/**` 的内容；
 * `pending_review` / `unchanged` / `rejected` 不动索引，不必浪费一次 job。
 */
export function shouldSyncAfterWrite(result: UpsertResult): boolean {
  return result.status === 'applied'
}

/** 由调用方注入的写入后钩子（HTTP 入口里是 `ctx.waitUntil(search.sync())`）。 */
export interface McpWriteHooks {
  afterWrite?: () => void
}

/**
 * 把 MemoryService 注册成 MCP 工具。
 * 不触碰 env / 绑定，因此可以在单测里用假 service 直接构造。
 */
export function createSmritiMcpServer(service: MemoryService, hooks: McpWriteHooks = {}): McpServer {
  const afterWrite = (): void => {
    try {
      hooks.afterWrite?.()
    } catch (error) {
      // 同步只是"尽力而为"，不能因为钩子抛错把写入结果打成失败。
      console.error('smriti: 写入后触发索引同步失败：', error instanceof Error ? error.message : String(error))
    }
  }

  const server = new McpServer({ name: 'smriti', version: '0.1.0' })

  server.registerTool(
    'memory_search',
    {
      description: '在已保存的持久偏好中做检索。query 必填，topic 用于限定固定主题词表，limit 默认 10。',
      inputSchema: toolSchemas.memory_search,
    },
    async ({ query, topic, limit }) =>
      guarded(async () => {
        const hits = await service.search(query, {
          limit: limit ?? DEFAULT_SEARCH_LIMIT,
          ...(topic !== undefined ? { topic } : {}),
        })
        // 只有空结果且服务提供探活时才多花一次（缓存过的）调用。
        const health =
          hits.length === 0 && service.health
            ? await service.health().catch(() => undefined)
            : undefined
        return textResult(memorySearchPayload(hits, health))
      }),
  )

  server.registerTool(
    'memory_get',
    {
      description: '按 topic 与 id 读取一条持久偏好；不存在时 memory 为 null。',
      inputSchema: toolSchemas.memory_get,
    },
    async ({ topic, id }) => guarded(async () => textResult({ memory: await service.get(topic, id) })),
  )

  server.registerTool(
    'memory_topics',
    {
      description: '列出固定主题词表及每个主题的条目数。',
      inputSchema: toolSchemas.memory_topics,
    },
    async () => guarded(async () => textResult({ topics: await service.topics() })),
  )

  server.registerTool(
    'memory_upsert',
    {
      description:
        '写入一条持久偏好。冲突或近似重复时返回 status=pending_review 并生成待裁决变更，不会直接覆盖。' +
        'idempotency_key 可用同一键安全重试。',
      inputSchema: toolSchemas.memory_upsert,
    },
    async ({ topic, statement, rationale, confidence, idempotency_key, source }) =>
      guarded(async () => {
        const result = await service.upsert({
          topic,
          statement,
          rationale,
          confidence,
          idempotencyKey: idempotency_key,
          source,
        })
        if (shouldSyncAfterWrite(result)) afterWrite()
        return textResult(result)
      }),
  )

  server.registerTool(
    'memory_list',
    {
      description: '列出持久偏好；topic 可选，limit 默认 50、上限 200。',
      inputSchema: toolSchemas.memory_list,
    },
    async ({ topic, limit }) =>
      guarded(async () => {
        const memories = await service.list(topic)
        return textResult({ memories: memories.slice(0, limit ?? DEFAULT_LIST_LIMIT) })
      }),
  )

  server.registerTool(
    'memory_forget',
    {
      description: '遗忘一条持久偏好：移入 history（保留 30 天）并返回是否命中。',
      inputSchema: toolSchemas.memory_forget,
    },
    async ({ topic, id, reason }) =>
      guarded(async () => {
        const forgotten = await service.forget(topic, id, reason)
        // 删除也要让索引尽快收敛，否则被删的条目在检索里还能命中一段时间。
        if (forgotten) afterWrite()
        return textResult({ status: forgotten ? 'forgotten' : 'not_found', forgotten })
      }),
  )

  return server
}

/**
 * 用 Worker 绑定组装 MemoryService，再构造 MCP server（每次请求一个新实例）。
 *
 * `ctx` 可选：MCP 写路径（`memory_upsert` / `memory_forget`）成功后用它
 * `waitUntil` 触发一次 AI Search 同步，否则新写入要等数据源的 15 分钟同步窗口
 * 才能被检索到——这正是冒烟测试里"写得进去、搜不出来"的原因。REST 入口
 * （`/v1/extract`、approve）在 `http/app.ts` 里有同样的处理。
 */
export function buildServer(env: Env, ctx?: ExecutionContext): McpServer {
  const store = createR2Store(env.MEMORY)
  const search = createAiSearch(env.AI_SEARCH, {
    instance: env.AI_SEARCH_INSTANCE ?? 'memory',
  })

  const hooks: McpWriteHooks = ctx
    ? {
        afterWrite: () => {
          ctx.waitUntil(
            search.sync().catch((error: unknown) => {
              console.error(
                'smriti: MCP 写入后同步 AI Search 失败：',
                error instanceof Error ? error.message : String(error),
              )
            }),
          )
        },
      }
    : {}

  return createSmritiMcpServer(createMemoryService({ store, search }), hooks)
}

/** 把一个 hostname 或 URL 规范成 hostname；非法值返回 undefined。 */
function normalizeHostname(value: string): string | undefined {
  const trimmed = value.trim()
  if (trimmed === '') return undefined
  try {
    const url = new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`)
    return url.hostname
  } catch {
    return undefined
  }
}

/** 同源总是放行；额外来源来自 `MCP_ALLOWED_ORIGINS`（逗号分隔）。 */
function allowedMCPHosts(request: Request, env: Env): string[] {
  const hosts = new Set<string>()
  const self = normalizeHostname(new URL(request.url).hostname)
  if (self !== undefined) hosts.add(self)
  for (const item of (env.MCP_ALLOWED_ORIGINS ?? '').split(',')) {
    const host = normalizeHostname(item)
    if (host !== undefined) hosts.add(host)
  }
  return [...hosts]
}

/**
 * `/mcp` 的 fetch handler。
 *
 * `getEnv` 由调用方提供（HTTP 入口里就是当前请求的 env），这样
 * `createMcpHandler` 的工厂签名保持无参，同时能拿到请求级绑定。
 *
 * handler 按请求构造：`createMcpHandler` 的 Origin/Host 白名单是静态的，
 * 而自定义域名只能从请求 URL 推导；同源放行，额外来源用
 * `MCP_ALLOWED_ORIGINS` 追加。
 */
export function createMcpFetchHandler(
  getEnv: () => Env,
): (request: Request, env: Env, ctx: ExecutionContext) => Promise<Response> {
  return (request: Request, env: Env, ctx: ExecutionContext): Promise<Response> => {
    const hosts = allowedMCPHosts(request, getEnv())
    const handler = createMcpHandler(() => buildServer(getEnv(), ctx), {
      allowedOriginHostnames: hosts,
    })
    return handler(request, env, ctx)
  }
}

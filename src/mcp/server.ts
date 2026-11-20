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
 * 把 MemoryService 注册成 MCP 工具。
 * 不触碰 env / 绑定，因此可以在单测里用假 service 直接构造。
 */
export function createSmritiMcpServer(service: MemoryService): McpServer {
  const server = new McpServer({ name: 'smriti', version: '0.1.0' })

  server.registerTool(
    'memory_search',
    {
      description: '在已保存的持久偏好中做检索。query 必填，topic 用于限定固定主题词表，limit 默认 10。',
      inputSchema: toolSchemas.memory_search,
    },
    async ({ query, topic, limit }) =>
      guarded(async () =>
        textResult({
          hits: await service.search(query, {
            limit: limit ?? DEFAULT_SEARCH_LIMIT,
            topic,
          }),
        }),
      ),
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
      guarded(async () =>
        textResult(
          await service.upsert({
            topic,
            statement,
            rationale,
            confidence,
            idempotencyKey: idempotency_key,
            source,
          }),
        ),
      ),
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
        return textResult({ status: forgotten ? 'forgotten' : 'not_found', forgotten })
      }),
  )

  return server
}

/** 用 Worker 绑定组装 MemoryService，再构造 MCP server（每次请求一个新实例）。 */
export function buildServer(env: Env): McpServer {
  const store = createR2Store(env.MEMORY)
  const search = createAiSearch(env.AI_SEARCH, {
    instance: env.AI_SEARCH_INSTANCE ?? 'memory',
  })
  return createSmritiMcpServer(createMemoryService({ store, search }))
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
    const handler = createMcpHandler(() => buildServer(getEnv()), {
      allowedOriginHostnames: hosts,
    })
    return handler(request, env, ctx)
  }
}

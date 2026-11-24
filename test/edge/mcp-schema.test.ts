import { describe, expect, it } from 'vitest'
import { McpServer } from '@modelcontextprotocol/server'
import type { MemoryService } from '../../src/contracts'
import type { Env } from '../../src/env'
import { buildServer, createSmritiMcpServer, memorySearchPayload, toolSchemas } from '../../src/mcp/server'

const TOOL_NAMES = [
  'memory_search',
  'memory_get',
  'memory_topics',
  'memory_upsert',
  'memory_list',
  'memory_forget',
] as const

function fakeService(): MemoryService {
  return {
    upsert: async () => ({ status: 'applied' }),
    get: async () => null,
    list: async () => [],
    search: async () => [],
    forget: async () => false,
    topics: async () => [],
    recall: async () => [],
    pending: async () => [],
    approve: async () => ({ status: 'applied' }),
    reject: async () => false,
    extract: async () => [],
  }
}

/** 满足 R2Like 结构的最小桶；buildServer 只做接口校验，不会真的读写。 */
function fakeBucket() {
  return {
    get: async () => null,
    put: async () => undefined,
    delete: async () => {},
    list: async () => ({ objects: [] }),
  }
}

const env: Env = { MEMORY: fakeBucket(), AUTH_MODE: 'dev' }

describe('MCP 工具 schema', () => {
  it('memory_search 只接受固定 topic 且限制 limit 范围', () => {
    expect(toolSchemas.memory_search.safeParse({ query: '缩进' }).success).toBe(true)
    expect(
      toolSchemas.memory_search.safeParse({ query: '缩进', topic: 'code.style', limit: 5 }).success,
    ).toBe(true)
    expect(toolSchemas.memory_search.safeParse({ query: '' }).success).toBe(false)
    expect(toolSchemas.memory_search.safeParse({ query: 'x', topic: 'made.up' }).success).toBe(false)
    expect(toolSchemas.memory_search.safeParse({ query: 'x', limit: 0 }).success).toBe(false)
    expect(toolSchemas.memory_search.safeParse({ query: 'x', limit: 51 }).success).toBe(false)
  })

  it('memory_get / memory_forget 要求 topic 与 id/reason', () => {
    expect(toolSchemas.memory_get.safeParse({ topic: 'code.style', id: 'mem_1' }).success).toBe(true)
    expect(toolSchemas.memory_get.safeParse({ topic: 'code.style' }).success).toBe(false)
    expect(toolSchemas.memory_get.safeParse({ topic: 'nope', id: 'mem_1' }).success).toBe(false)

    expect(
      toolSchemas.memory_forget.safeParse({
        topic: 'code.style',
        id: 'mem_1',
        reason: '过时',
      }).success,
    ).toBe(true)
    expect(toolSchemas.memory_forget.safeParse({ topic: 'code.style', id: 'mem_1' }).success).toBe(
      false,
    )
  })

  it('memory_upsert 校验 confidence 与 idempotency_key', () => {
    expect(
      toolSchemas.memory_upsert.safeParse({
        topic: 'workflow.git',
        statement: '用 rebase 保持线性历史',
      }).success,
    ).toBe(true)
    expect(
      toolSchemas.memory_upsert.safeParse({
        topic: 'workflow.git',
        statement: 'x',
        confidence: 0.5,
        idempotency_key: 'abc',
        source: { session: 'sess_1' },
      }).success,
    ).toBe(true)
    expect(
      toolSchemas.memory_upsert.safeParse({
        topic: 'workflow.git',
        statement: 'x',
        confidence: 1.5,
      }).success,
    ).toBe(false)
    expect(
      toolSchemas.memory_upsert.safeParse({
        topic: 'workflow.git',
        statement: 'x',
        idempotency_key: '',
      }).success,
    ).toBe(false)
  })

  it('memory_list / memory_topics 接受空参数', () => {
    expect(toolSchemas.memory_list.safeParse({}).success).toBe(true)
    expect(toolSchemas.memory_list.safeParse({ topic: 'code.testing' }).success).toBe(true)
    expect(toolSchemas.memory_list.safeParse({ limit: 201 }).success).toBe(false)
    expect(toolSchemas.memory_topics.safeParse({}).success).toBe(true)
  })
})

describe('McpServer 构建', () => {
  it('注册全部 6 个工具并暴露 JSON Schema（不触发网络）', () => {
    const server = createSmritiMcpServer(fakeService())
    expect(server).toBeInstanceOf(McpServer)

    for (const name of TOOL_NAMES) {
      const schema = server.toolInputSchemaJson(name) as
        | { type?: string; properties?: Record<string, unknown> }
        | undefined
      expect(schema, `tool ${name} should be registered`).toBeDefined()
      expect(schema?.type).toBe('object')
    }

    const searchSchema = server.toolInputSchemaJson('memory_search') as {
      properties?: Record<string, unknown>
    }
    expect(Object.keys(searchSchema.properties ?? {}).sort()).toEqual(['limit', 'query', 'topic'])
  })

  it('buildServer(env) 用绑定组装真实 service', () => {
    const server = buildServer(env)
    expect(server).toBeInstanceOf(McpServer)
    expect(server.toolInputSchemaJson('memory_topics')).toBeDefined()
  })
})

describe('memory_search 返回体', () => {
  const hit = { id: 'mem_1', topic: 'code.style', statement: '使用 2 空格缩进', score: 0.9 }

  it('检索后端健康或状态未知时只返回 hits', () => {
    expect(memorySearchPayload([])).toEqual({ hits: [] })
    expect(memorySearchPayload([], { ok: true, instance: 'memory' })).toEqual({ hits: [] })
    expect(memorySearchPayload([hit], { ok: false, instance: 'memory' })).toEqual({ hits: [hit] })
  })

  it('空结果且后端不健康时显式标记 degraded，避免被当成"没有记忆"', () => {
    expect(
      memorySearchPayload([], { ok: false, instance: 'memory', reason: 'ai_search_not_found' }),
    ).toEqual({
      hits: [],
      degraded: true,
      reason: 'ai_search_not_found',
    })
    // reason 缺失时给出兜底文案，不出现 undefined。
    expect(memorySearchPayload([], { ok: false, instance: 'memory' })).toEqual({
      hits: [],
      degraded: true,
      reason: 'AI Search unavailable',
    })
  })
})

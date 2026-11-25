import { describe, expect, it, vi } from 'vitest'
import { McpServer } from '@modelcontextprotocol/server'
import type { MemoryService } from '../../src/contracts'
import type { Env } from '../../src/env'
import {
  buildServer,
  createSmritiMcpServer,
  hydrateSearchHits,
  memorySearchPayload,
  shouldSyncAfterWrite,
  toolSchemas,
} from '../../src/mcp/server'

const TOOL_NAMES = [
  'memory_search',
  'memory_get',
  'memory_topics',
  'memory_upsert',
  'memory_list',
  'memory_forget',
  'memory_history',
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
    history: async () => [],
    restore: async () => null,
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
  it('memory_search 的 topic 只做语法校验，不限词表', () => {
    expect(toolSchemas.memory_search.safeParse({ query: '缩进' }).success).toBe(true)
    expect(
      toolSchemas.memory_search.safeParse({ query: '缩进', topic: 'code.style', limit: 5 }).success,
    ).toBe(true)
    // 自由主题（尚未写入过）也应接受；这是"AI 管主题"的前提。
    expect(toolSchemas.memory_search.safeParse({ query: 'x', topic: 'identity.role' }).success).toBe(
      true,
    )
    expect(toolSchemas.memory_search.safeParse({ query: '' }).success).toBe(false)
    expect(toolSchemas.memory_search.safeParse({ query: 'x', topic: 'Bad Topic' }).success).toBe(
      false,
    )
    expect(toolSchemas.memory_search.safeParse({ query: 'x', topic: 'a.b.c.d' }).success).toBe(false)
    expect(toolSchemas.memory_search.safeParse({ query: 'x', limit: 0 }).success).toBe(false)
    expect(toolSchemas.memory_search.safeParse({ query: 'x', limit: 51 }).success).toBe(false)
  })

  it('memory_get / memory_forget 要求 topic 与 id/reason', () => {
    expect(toolSchemas.memory_get.safeParse({ topic: 'code.style', id: 'mem_1' }).success).toBe(true)
    expect(toolSchemas.memory_get.safeParse({ topic: 'code.style' }).success).toBe(false)
    expect(toolSchemas.memory_get.safeParse({ topic: 'Bad Topic', id: 'mem_1' }).success).toBe(false)

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
    // 自由主题 + 展示名：主题由 AI 管理，schema 不做词表枚举。
    expect(
      toolSchemas.memory_upsert.safeParse({
        topic: 'identity.role',
        topic_label: '角色',
        statement: '用户是软件开发工程师',
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

  it('memory_history 校验 at 与 limit', () => {
    expect(toolSchemas.memory_history.safeParse({}).success).toBe(true)
    expect(
      toolSchemas.memory_history.safeParse({
        topic: 'identity.role',
        at: '2026-01-01T00:00:00.000Z',
        limit: 10,
      }).success,
    ).toBe(true)
    expect(toolSchemas.memory_history.safeParse({ at: 'not-a-date' }).success).toBe(false)
    expect(toolSchemas.memory_history.safeParse({ limit: 201 }).success).toBe(false)
    expect(toolSchemas.memory_history.safeParse({ topic: 'Bad Topic' }).success).toBe(false)
  })
})

describe('McpServer 构建', () => {
  it('注册全部 7 个工具并暴露 JSON Schema（不触发网络）', () => {
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

describe('写入后的索引同步判定', () => {
  it('只有真正落盘（applied）才触发同步', () => {
    expect(shouldSyncAfterWrite({ status: 'applied' })).toBe(true)
    expect(shouldSyncAfterWrite({ status: 'pending_review' })).toBe(false)
    expect(shouldSyncAfterWrite({ status: 'unchanged' })).toBe(false)
    expect(shouldSyncAfterWrite({ status: 'rejected' })).toBe(false)
    expect(shouldSyncAfterWrite({ status: 'invalid_topic' })).toBe(false)
  })
})

describe('检索命中水合', () => {
  const rawHit = {
    id: 'mem_1',
    topic: 'code.style',
    // 索引里的正文带 Markdown 标题前缀，直接返回会污染模型看到的陈述。
    statement: '# 使用 2 空格缩进\n\n## 理由\n\n团队约定',
    score: 0.8,
  }

  it('用 R2 现行记录替换索引正文，保留 score', async () => {
    const get = vi.fn(async () => ({
      id: 'mem_1',
      topic: 'code.style',
      statement: '使用 2 空格缩进',
      confidence: 0.8,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      version: 1,
    }))

    await expect(hydrateSearchHits({ get }, [rawHit])).resolves.toEqual([
      { id: 'mem_1', topic: 'code.style', statement: '使用 2 空格缩进', score: 0.8 },
    ])
    expect(get).toHaveBeenCalledWith('code.style', 'mem_1')
  })

  it('记录已被删除（null）或读取抛错时丢弃该命中，不拖垮整次检索', async () => {
    const get = vi.fn(async (topic: string, id: string) => {
      if (id === 'mem_gone') return null
      if (id === 'mem_boom') throw new Error('r2 exploded')
      return {
        id,
        topic,
        statement: '仍在的记录',
        confidence: 0.8,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        version: 1,
      }
    })

    const hits = [
      { id: 'mem_gone', topic: 'code.style', statement: '已删除', score: 0.9 },
      { id: 'mem_boom', topic: 'code.style', statement: '读失败', score: 0.8 },
      { id: 'mem_ok', topic: 'code.style', statement: '旧正文', score: 0.7 },
    ]

    await expect(hydrateSearchHits({ get }, hits)).resolves.toEqual([
      { id: 'mem_ok', topic: 'code.style', statement: '仍在的记录', score: 0.7 },
    ])
  })

  it('没有命中时不读 R2', async () => {
    const get = vi.fn()
    await expect(hydrateSearchHits({ get }, [])).resolves.toEqual([])
    expect(get).not.toHaveBeenCalled()
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

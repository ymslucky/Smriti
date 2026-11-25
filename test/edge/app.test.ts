import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Env } from '../../src/env'
import type { MemoryRecord } from '../../src/types'

/** 三个模块工厂全部用假实现替换，避免测试依赖真实 R2 / AI Search / service 行为。 */
const fake = vi.hoisted(() => {
  const service = {
    upsert: vi.fn(),
    get: vi.fn(),
    list: vi.fn(),
    search: vi.fn(),
    forget: vi.fn(),
    topics: vi.fn(),
    recall: vi.fn(),
    pending: vi.fn(),
    history: vi.fn(),
    restore: vi.fn(),
    approve: vi.fn(),
    reject: vi.fn(),
    extract: vi.fn(),
  }
  const store = {}
  const search = { search: vi.fn(), sync: vi.fn() }
  return { service, store, search }
})

vi.mock('../../src/storage/r2-store', () => ({
  createR2Store: vi.fn(() => fake.store),
}))
vi.mock('../../src/search/ai-search', () => ({
  createAiSearch: vi.fn(() => fake.search),
}))
vi.mock('../../src/service', () => ({
  createMemoryService: vi.fn(() => fake.service),
}))

const { handle } = await import('../../src/http/app')

/** waitUntil 用 spy：P0-3 的索引同步断言依赖它被调用。 */
const waitUntil = vi.fn()
const ctx = {
  waitUntil,
  passThroughOnException: () => {},
} as unknown as ExecutionContext

/** 取出 scheduleSearchSync 交给 waitUntil 的 promise 并等待落定。 */
async function settleWaitUntilCall(index = 0): Promise<void> {
  const call = waitUntil.mock.calls[index] as unknown as [Promise<unknown>] | undefined
  await call?.[0]
}

function devEnv(overrides: Partial<Env> = {}): Env {
  return { MEMORY: {} as Env['MEMORY'], AUTH_MODE: 'dev', ...overrides }
}

function accessEnv(overrides: Partial<Env> = {}): Env {
  return {
    MEMORY: {} as Env['MEMORY'],
    AUTH_MODE: 'access',
    ACCESS_TEAM_DOMAIN: 'smriti-test.cloudflareaccess.com',
    ACCESS_AUD: 'smriti-test-aud',
    ...overrides,
  }
}

function jsonRequest(path: string, method: string, body?: unknown): Request {
  return new Request(`https://smriti.example.com${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

async function bodyOf(response: Response): Promise<unknown> {
  return response.json()
}

const topicsFixture = [
  { topic: 'code.style', label: '代码风格', description: '命名与格式', count: 2 },
]

beforeEach(() => {
  vi.clearAllMocks()
  // 同步实现必须是返回 Promise 的 mock（scheduleSearchSync 会调用 .catch）。
  fake.search.sync = vi.fn(async () => {})
  Object.assign(fake.service, {
    upsert: vi.fn(async () => ({ status: 'applied' })),
    get: vi.fn(async () => null),
    list: vi.fn(async () => []),
    search: vi.fn(async () => []),
    forget: vi.fn(async () => false),
    topics: vi.fn(async () => topicsFixture),
    recall: vi.fn(async () => [
      { id: 'mem_1', topic: 'code.style', statement: '使用 2 空格缩进' },
    ]),
    pending: vi.fn(async () => []),
    history: vi.fn(async () => []),
    restore: vi.fn(async () => null),
    approve: vi.fn(async () => ({ status: 'applied' })),
    reject: vi.fn(async () => true),
    extract: vi.fn(async () => [{ status: 'applied' }]),
  })
})

describe('GET /healthz', () => {
  it('免鉴权返回 {ok:true}', async () => {
    const response = await handle(new Request('https://smriti.example.com/healthz'), accessEnv(), ctx)
    expect(response.status).toBe(200)
    await expect(bodyOf(response)).resolves.toEqual({ ok: true })
  })
})

describe('GET /', () => {
  it('免鉴权重定向到 /ui', async () => {
    const response = await handle(new Request('https://smriti.example.com/'), accessEnv(), ctx)
    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe('https://smriti.example.com/ui')
  })

  it('GET /index.html 同样重定向', async () => {
    const response = await handle(
      new Request('https://smriti.example.com/index.html'),
      accessEnv(),
      ctx,
    )
    expect(response.status).toBe(302)
    expect(response.headers.get('location')).toBe('https://smriti.example.com/ui')
  })
})

describe('健康检查与 404', () => {
  it('GET /v1/health（dev）返回 200', async () => {
    const response = await handle(new Request('https://smriti.example.com/v1/health'), devEnv(), ctx)
    expect(response.status).toBe(200)
    await expect(bodyOf(response)).resolves.toEqual({ ok: true })
  })

  it('未知路由返回 404 JSON 错误', async () => {
    const response = await handle(
      new Request('https://smriti.example.com/v1/unknown'),
      devEnv(),
      ctx,
    )
    expect(response.status).toBe(404)
    await expect(bodyOf(response)).resolves.toEqual({
      error: { code: 'not_found', message: expect.any(String) },
    })
  })

  it('方法不匹配同样返回 404', async () => {
    const response = await handle(jsonRequest('/v1/topics', 'POST'), devEnv(), ctx)
    expect(response.status).toBe(404)
  })
})

describe('鉴权失败', () => {
  it('access 模式无 JWT 时 /v1/health 返回 401', async () => {
    const response = await handle(new Request('https://smriti.example.com/v1/health'), accessEnv(), ctx)
    expect(response.status).toBe(401)
    const body = (await bodyOf(response)) as { error: { code: string } }
    expect(body.error.code).toBe('unauthorized')
  })

  it('access 模式无 JWT 时 /mcp 同样返回 401，不会进入 MCP handler', async () => {
    const response = await handle(
      jsonRequest('/mcp', 'POST', { jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      accessEnv(),
      ctx,
    )
    expect(response.status).toBe(401)
  })
})

describe('/v1 REST', () => {
  it('GET /v1/topics 返回主题词表', async () => {
    const response = await handle(new Request('https://smriti.example.com/v1/topics'), devEnv(), ctx)
    expect(response.status).toBe(200)
    await expect(bodyOf(response)).resolves.toEqual({ topics: topicsFixture })
    expect(fake.service.topics).toHaveBeenCalledTimes(1)
  })

  it('GET /v1/pending 返回待裁决列表', async () => {
    const response = await handle(new Request('https://smriti.example.com/v1/pending'), devEnv(), ctx)
    expect(response.status).toBe(200)
    await expect(bodyOf(response)).resolves.toEqual({ pending: [] })
  })

  it('POST /v1/recall 使用默认 limit=10', async () => {
    const response = await handle(
      jsonRequest('/v1/recall', 'POST', { query: '缩进' }),
      devEnv(),
      ctx,
    )
    expect(response.status).toBe(200)
    await expect(bodyOf(response)).resolves.toEqual({
      items: [{ id: 'mem_1', topic: 'code.style', statement: '使用 2 空格缩进' }],
    })
    expect(fake.service.recall).toHaveBeenCalledWith('缩进', 10)
  })

  it('POST /v1/recall 透传 limit', async () => {
    await handle(jsonRequest('/v1/recall', 'POST', { query: '缩进', limit: 3 }), devEnv(), ctx)
    expect(fake.service.recall).toHaveBeenCalledWith('缩进', 3)
  })

  it('POST /v1/recall 缺少 query 返回 400', async () => {
    const response = await handle(jsonRequest('/v1/recall', 'POST', {}), devEnv(), ctx)
    expect(response.status).toBe(400)
    const body = (await bodyOf(response)) as { error: { code: string } }
    expect(body.error.code).toBe('invalid_request')
  })

  it('POST /v1/recall 非法 JSON 返回 400', async () => {
    const request = new Request('https://smriti.example.com/v1/recall', {
      method: 'POST',
      body: '{not json',
    })
    const response = await handle(request, devEnv(), ctx)
    expect(response.status).toBe(400)
    const body = (await bodyOf(response)) as { error: { code: string } }
    expect(body.error.code).toBe('invalid_json')
  })

  it('POST /v1/extract 从 messages 生成候选并写入', async () => {
    const response = await handle(
      jsonRequest('/v1/extract', 'POST', {
        sessionId: 'sess_1',
        messages: [{ role: 'user', content: '我习惯用 pnpm 安装依赖。' }],
      }),
      devEnv(),
      ctx,
    )
    expect(response.status).toBe(200)

    expect(fake.service.extract).toHaveBeenCalledTimes(1)
    const [candidates] = fake.service.extract.mock.calls[0] as unknown as [
      Array<{ topic: string; statement: string; confidence: number; source?: unknown }>,
    ]
    expect(candidates).toHaveLength(1)
    expect(candidates[0]?.topic).toBe('tooling.package-manager')
    expect(candidates[0]?.statement).toContain('pnpm')
    expect(candidates[0]?.source).toEqual({ session: 'sess_1', message: '0' })

    await expect(bodyOf(response)).resolves.toEqual({
      candidates,
      results: [{ status: 'applied' }],
    })
  })

  it('POST /v1/extract 没有偏好句式时返回空候选且不写库', async () => {
    const response = await handle(
      jsonRequest('/v1/extract', 'POST', {
        sessionId: 'sess_1',
        messages: [{ role: 'user', content: '今天天气不错。' }],
      }),
      devEnv(),
      ctx,
    )
    expect(response.status).toBe(200)
    await expect(bodyOf(response)).resolves.toEqual({ candidates: [], results: [] })
    expect(fake.service.extract).not.toHaveBeenCalled()
  })

  it('POST /v1/extract 也接受调用方已提取的 candidates', async () => {
    const response = await handle(
      jsonRequest('/v1/extract', 'POST', {
        candidates: [{ topic: 'code.style', statement: ' 使用单引号 ' }],
      }),
      devEnv(),
      ctx,
    )
    expect(response.status).toBe(200)
    expect(fake.service.extract).toHaveBeenCalledWith([
      { topic: 'code.style', statement: '使用单引号', confidence: 0.8 },
    ])
    const body = (await bodyOf(response)) as { candidates: unknown[] }
    expect(body.candidates).toHaveLength(1)
  })

  it('POST /v1/extract 拒绝语法不合法的 topic', async () => {
    const response = await handle(
      jsonRequest('/v1/extract', 'POST', {
        candidates: [{ topic: 'Bad Topic', statement: 'x', confidence: 0.5 }],
      }),
      devEnv(),
      ctx,
    )
    expect(response.status).toBe(400)
  })

  it('POST /v1/extract 接受尚未写入过的自由 topic', async () => {
    const response = await handle(
      jsonRequest('/v1/extract', 'POST', {
        candidates: [{ topic: 'identity.role', statement: '用户是工程师', confidence: 0.8 }],
      }),
      devEnv(),
      ctx,
    )
    expect(response.status).toBe(200)
    expect(fake.service.extract).toHaveBeenCalledWith([
      { topic: 'identity.role', statement: '用户是工程师', confidence: 0.8 },
    ])
  })

  it('POST /v1/extract 缺少 messages/candidates 返回 400', async () => {
    const response = await handle(jsonRequest('/v1/extract', 'POST', {}), devEnv(), ctx)
    expect(response.status).toBe(400)
  })

  it('POST /v1/pending/:id/approve 调用 service.approve 并返回顶层状态', async () => {
    const response = await handle(
      jsonRequest('/v1/pending/chg_1/approve', 'POST'),
      devEnv(),
      ctx,
    )
    expect(response.status).toBe(200)
    await expect(bodyOf(response)).resolves.toEqual({ status: 'applied' })
    expect(fake.service.approve).toHaveBeenCalledWith('chg_1')
  })

  it('POST /v1/pending/:id/reject 透传 reason', async () => {
    const response = await handle(
      jsonRequest('/v1/pending/chg_1/reject', 'POST', { reason: '不需要' }),
      devEnv(),
      ctx,
    )
    expect(response.status).toBe(200)
    await expect(bodyOf(response)).resolves.toEqual({ status: 'rejected', applied: false })
    expect(fake.service.reject).toHaveBeenCalledWith('chg_1', '不需要')
  })

  it('POST /v1/pending/:id/reject 未命中返回 404', async () => {
    fake.service.reject.mockResolvedValueOnce(false)
    const response = await handle(
      jsonRequest('/v1/pending/chg_missing/reject', 'POST', {}),
      devEnv(),
      ctx,
    )
    expect(response.status).toBe(404)
    expect(fake.service.reject).toHaveBeenCalledWith('chg_missing', 'rejected')
  })

  it('非 POST 的 approve 路径不触发裁决操作', async () => {
    const response = await handle(
      new Request('https://smriti.example.com/v1/pending/chg_1/approve'),
      devEnv(),
      ctx,
    )
    expect(response.status).toBe(404)
    expect(fake.service.approve).not.toHaveBeenCalled()
    expect(fake.service.reject).not.toHaveBeenCalled()
  })

  it('service 抛错时返回 500 且不泄露内部错误', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    fake.service.recall.mockRejectedValueOnce(new Error('r2 exploded'))
    const response = await handle(
      jsonRequest('/v1/recall', 'POST', { query: 'x' }),
      devEnv(),
      ctx,
    )
    expect(response.status).toBe(500)
    await expect(bodyOf(response)).resolves.toEqual({
      error: { code: 'internal_error', message: 'Internal server error' },
    })
    errorSpy.mockRestore()
  })
})

describe('GET /mcp', () => {
  it('返回 405 并提示使用 POST', async () => {
    const response = await handle(new Request('https://smriti.example.com/mcp'), devEnv(), ctx)
    expect(response.status).toBe(405)
    expect(response.headers.get('allow')).toBe('POST')
    await expect(bodyOf(response)).resolves.toEqual({
      error: { code: 'method_not_allowed', message: expect.stringContaining('POST') },
    })
  })

  it('curl 默认 Accept: */* 仍得到 405 JSON（不改 MCP 客户端语义）', async () => {
    const response = await handle(
      new Request('https://smriti.example.com/mcp', { headers: { accept: '*/*' } }),
      devEnv(),
      ctx,
    )
    expect(response.status).toBe(405)
    expect(response.headers.get('allow')).toBe('POST')
    expect(response.headers.get('content-type')).toContain('application/json')
    await expect(bodyOf(response)).resolves.toEqual({
      error: { code: 'method_not_allowed', message: expect.stringContaining('POST') },
    })
  })

  it('浏览器 Accept: text/html 时返回 405 + ASSETS 里的 /ui/mcp.html 教程页', async () => {
    const { fetchMock, binding } = fakeAssets(async () =>
      new Response('<html>MCP 教程</html>', {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      }),
    )
    const response = await handle(
      new Request('https://smriti.example.com/mcp', {
        headers: { accept: 'text/html,application/xhtml+xml,*/*;q=0.8' },
      }),
      devEnv({ ASSETS: binding }),
      ctx,
    )

    expect(response.status).toBe(405)
    expect(response.headers.get('allow')).toBe('POST')
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    await expect(response.text()).resolves.toBe('<html>MCP 教程</html>')

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [assetRequest] = fetchMock.mock.calls[0] as unknown as [Request]
    expect(assetRequest.method).toBe('GET')
    expect(new URL(assetRequest.url).pathname).toBe('/ui/mcp.html')
    expect(assetRequest.headers.get('accept')).toContain('text/html')
  })

  it('ASSETS 缺失时浏览器请求回退为内联 HTML（405，绝不 500）', async () => {
    const response = await handle(
      new Request('https://smriti.example.com/mcp', {
        headers: { accept: 'text/html' },
      }),
      devEnv(),
      ctx,
    )
    expect(response.status).toBe(405)
    expect(response.headers.get('allow')).toBe('POST')
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8')
    const body = await response.text()
    expect(body).toContain('POST')
    expect(body).toContain('href="/ui"')
    expect(body).toContain('MCP')
    expect(body).not.toContain('internal_error')
  })

  it('assets 取页抛错时同样回退为 405 HTML 而不是 500', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { binding } = fakeAssets(async () => {
      throw new Error('assets exploded')
    })
    const response = await handle(
      new Request('https://smriti.example.com/mcp', {
        headers: { accept: 'text/html' },
      }),
      devEnv({ ASSETS: binding }),
      ctx,
    )
    expect(response.status).toBe(405)
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(await response.text()).toContain('href="/ui"')
    expect(errorSpy).toHaveBeenCalledWith(
      'smriti: failed to serve /mcp tutorial asset',
      expect.any(Error),
    )
    errorSpy.mockRestore()
  })

  it('非 POST 的其它方法（PUT/OPTIONS/DELETE）也走同一内容协商与 405', async () => {
    for (const method of ['PUT', 'OPTIONS', 'DELETE']) {
      const response = await handle(
        new Request('https://smriti.example.com/mcp', { method }),
        devEnv(),
        ctx,
      )
      expect(response.status, method).toBe(405)
      expect(response.headers.get('allow'), method).toBe('POST')
      await expect(bodyOf(response)).resolves.toEqual({
        error: { code: 'method_not_allowed', message: expect.stringContaining('POST') },
      })
    }
  })

  it('POST /mcp 不受内容协商影响，仍进入 MCP handler', async () => {
    const response = await handle(
      new Request('https://smriti.example.com/mcp', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      }),
      devEnv(),
      ctx,
    )
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).not.toContain('text/html')
  })
})

describe('POST /mcp', () => {
  const MCP_HEADERS = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  }

  function mcpPost(env: Env, payload: unknown): Promise<Response> {
    return handle(
      new Request('https://smriti.example.com/mcp', {
        method: 'POST',
        headers: MCP_HEADERS,
        body: JSON.stringify(payload),
      }),
      env,
      ctx,
    )
  }

  function mcpPostWithOrigin(env: Env, origin: string, payload: unknown): Promise<Response> {
    return handle(
      new Request('https://smriti.example.com/mcp', {
        method: 'POST',
        headers: { ...MCP_HEADERS, origin },
        body: JSON.stringify(payload),
      }),
      env,
      ctx,
    )
  }

  it('接受同源 Origin（浏览器 fetch）', async () => {
    const response = await mcpPostWithOrigin(
      devEnv(),
      'https://smriti.example.com',
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    )
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).not.toContain('text/html')
  })

  it('拒绝跨源 Origin', async () => {
    const response = await mcpPostWithOrigin(
      devEnv(),
      'https://evil.example.com',
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    )
    expect(response.status).toBe(403)
    await expect(response.text()).resolves.toContain('Invalid Origin')
  })

  it('MCP_ALLOWED_ORIGINS 可追加额外来源', async () => {
    const response = await mcpPostWithOrigin(
      devEnv({ MCP_ALLOWED_ORIGINS: 'https://admin.example.com' }),
      'https://admin.example.com',
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    )
    expect(response.status).toBe(200)
  })

  /** 兼容 JSON 与 SSE 两种响应形态，抽出与请求 id 匹配的 JSON-RPC 消息。 */
  function parseRpc(text: string, contentType: string): Record<string, unknown> | undefined {
    if (contentType.includes('text/event-stream') || text.trimStart().startsWith('data:')) {
      for (const line of text.split(/\r?\n/)) {
        if (!line.startsWith('data:')) continue
        const data = line.slice('data:'.length).trim()
        if (data === '' || data === '[DONE]') continue
        try {
          return JSON.parse(data) as Record<string, unknown>
        } catch {
          // 忽略心跳
        }
      }
      return undefined
    }
    return JSON.parse(text) as Record<string, unknown>
  }

  async function initialize(env: Env): Promise<void> {
    const response = await mcpPost(env, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'smriti-dsh', version: '0.1.0' },
      },
    })
    expect(response.status).toBe(200)
    const text = await response.text()
    expect(text).toContain('smriti')
  }

  it('路由到 MCP handler 并完成 initialize 握手', async () => {
    await initialize(devEnv())
  })

  it('插件式三次 POST（initialize → initialized → tools/call）可调用 memory_upsert', async () => {
    const env = devEnv()
    await initialize(env)

    const notified = await mcpPost(env, { jsonrpc: '2.0', method: 'notifications/initialized' })
    expect([200, 202, 204]).toContain(notified.status)
    await notified.text()

    const callResponse = await mcpPost(env, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'memory_upsert',
        arguments: {
          topic: 'workflow.git',
          statement: '用 rebase 保持线性历史',
          confidence: 0.8,
          source: { session: 'sess_1' },
        },
      },
    })
    expect(callResponse.status).toBe(200)
    const payload = parseRpc(
      await callResponse.text(),
      callResponse.headers.get('content-type') ?? '',
    )
    expect(payload?.error).toBeUndefined()

    const result = payload?.result as {
      content?: Array<{ type: string; text: string }>
      isError?: boolean
    }
    expect(result.isError).toBeUndefined()
    const text = result.content?.[0]?.text ?? ''
    expect(JSON.parse(text)).toEqual({ status: 'applied' })
    const [input] = fake.service.upsert.mock.calls[0] as unknown as [
      Record<string, unknown>,
    ]
    expect(input.topic).toBe('workflow.git')
    expect(input.statement).toBe('用 rebase 保持线性历史')
    expect(input.confidence).toBe(0.8)
    expect(input.source).toEqual({ session: 'sess_1' })
  })

  it('tools/list 在无 session 的 Streamable HTTP 下返回全部工具', async () => {
    const env = devEnv()
    await initialize(env)

    const response = await mcpPost(env, { jsonrpc: '2.0', id: 4, method: 'tools/list' })
    expect(response.status).toBe(200)
    const payload = parseRpc(await response.text(), response.headers.get('content-type') ?? '')
    const result = payload?.result as { tools?: Array<{ name: string }> } | undefined
    const names = (result?.tools ?? []).map((tool) => tool.name).sort()
    expect(names).toEqual([
      'memory_forget',
      'memory_get',
      'memory_history',
      'memory_list',
      'memory_search',
      'memory_topics',
      'memory_upsert',
    ])
  })

  it('tools/call 未知工具返回 isError 而不是崩溃', async () => {
    const env = devEnv()
    const response = await mcpPost(env, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'memory_nope', arguments: {} },
    })
    expect(response.status).toBe(200)
    const payload = parseRpc(await response.text(), response.headers.get('content-type') ?? '')
    expect(payload?.error).toBeDefined()
  })
})

function memoryFixture(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: 'mem_fixture',
    topic: 'code.style',
    statement: '使用 2 空格缩进',
    confidence: 0.9,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    version: 1,
    ...overrides,
  }
}

/** 构造 assets 绑定的假实现，并暴露 fetchMock 以便断言转发的路径。 */
function fakeAssets(impl?: (request: Request) => Promise<Response>) {
  const fetchMock = vi.fn(
    impl ??
      (async (request: Request) =>
        new Response(`asset:${new URL(request.url).pathname}`, {
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        })),
  )
  return { fetchMock, binding: { fetch: fetchMock } as unknown as Env['ASSETS'] }
}

describe('GET /v1/stats', () => {
  it('聚合总数、主题计数、最近更新与健康信息', async () => {
    fake.service.list.mockResolvedValueOnce([
      memoryFixture({ id: 'mem_old', updatedAt: '2026-01-01T00:00:00.000Z' }),
      memoryFixture({ id: 'mem_new', updatedAt: '2026-03-01T00:00:00.000Z' }),
      memoryFixture({ id: 'mem_mid', updatedAt: '2026-02-01T00:00:00.000Z' }),
    ])
    fake.service.pending.mockResolvedValueOnce([{ changeId: 'chg_1' }])

    const response = await handle(
      new Request('https://smriti.example.com/v1/stats'),
      devEnv(),
      ctx,
    )
    expect(response.status).toBe(200)

    const recent = (id: string, updatedAt: string) => ({
      id,
      topic: 'code.style',
      statement: '使用 2 空格缩进',
      updatedAt,
    })
    await expect(bodyOf(response)).resolves.toEqual({
      totals: { memories: 3, pending: 1, topics: 1 },
      byTopic: [{ topic: 'code.style', label: '代码风格', count: 2 }],
      recent: [
        recent('mem_new', '2026-03-01T00:00:00.000Z'),
        recent('mem_mid', '2026-02-01T00:00:00.000Z'),
        recent('mem_old', '2026-01-01T00:00:00.000Z'),
      ],
      health: { aiSearch: false, instance: 'memory', authMode: 'dev' },
    })
  })

  it('recent 只取 updatedAt 倒序前 5 条', async () => {
    fake.service.list.mockResolvedValueOnce(
      Array.from({ length: 6 }, (_, index) =>
        memoryFixture({
          id: `mem_${index + 1}`,
          updatedAt: `2026-01-0${index + 1}T00:00:00.000Z`,
        }),
      ),
    )

    const response = await handle(
      new Request('https://smriti.example.com/v1/stats'),
      devEnv(),
      ctx,
    )
    const body = (await bodyOf(response)) as { recent: Array<{ id: string }> }
    expect(body.recent.map((item) => item.id)).toEqual([
      'mem_6',
      'mem_5',
      'mem_4',
      'mem_3',
      'mem_2',
    ])
  })

  it('health 反映 AI_SEARCH 绑定与实例名', async () => {
    const env = devEnv({
      AI_SEARCH: { get: () => ({ search: async () => ({}) }) },
      AI_SEARCH_INSTANCE: 'memory-eu',
    })

    const response = await handle(new Request('https://smriti.example.com/v1/stats'), env, ctx)
    const body = (await bodyOf(response)) as { health: unknown }
    expect(body.health).toEqual({ aiSearch: true, instance: 'memory-eu', authMode: 'dev' })
  })

  it('检索后端不健康时 health 报 false 并带 searchError（不再假阳性）', async () => {
    const health = vi.fn(async () => ({
      ok: false,
      instance: 'memory',
      reason: 'ai_search_not_found',
    }))
    const searchWithHealth = fake.search as unknown as { health?: unknown }
    searchWithHealth.health = health
    try {
      const env = devEnv({ AI_SEARCH: { get: () => ({ search: async () => ({}) }) } })

      const response = await handle(new Request('https://smriti.example.com/v1/stats'), env, ctx)
      const body = (await bodyOf(response)) as { health: unknown }
      expect(body.health).toEqual({
        aiSearch: false,
        instance: 'memory',
        authMode: 'dev',
        searchError: 'ai_search_not_found',
      })
      expect(health).toHaveBeenCalledTimes(1)
    } finally {
      delete searchWithHealth.health
    }
  })

  it('health 使用探活回报的实际实例名（自愈后与配置名不同）', async () => {
    const searchWithHealth = fake.search as unknown as { health?: unknown }
    searchWithHealth.health = vi.fn(async () => ({ ok: true, instance: 'smriti-memory' }))
    try {
      const env = devEnv({
        AI_SEARCH: { get: () => ({ search: async () => ({}) }) },
        AI_SEARCH_INSTANCE: 'memory',
      })

      const response = await handle(new Request('https://smriti.example.com/v1/stats'), env, ctx)
      const body = (await bodyOf(response)) as {
        health: { instance: string; aiSearch: boolean }
      }
      expect(body.health).toEqual({ aiSearch: true, instance: 'smriti-memory', authMode: 'dev' })
    } finally {
      delete searchWithHealth.health
    }
  })

  it('access 模式未鉴权返回 401 且不读取记忆', async () => {
    const response = await handle(
      new Request('https://smriti.example.com/v1/stats'),
      accessEnv(),
      ctx,
    )
    expect(response.status).toBe(401)
    expect(fake.service.list).not.toHaveBeenCalled()
    expect(fake.service.topics).not.toHaveBeenCalled()
  })
})

describe('GET /v1/memories', () => {
  it('无 topic 时返回全部记忆（原样 items）', async () => {
    const memories = [
      memoryFixture({ id: 'mem_1' }),
      memoryFixture({ id: 'mem_2', topic: 'workflow.git' }),
    ]
    fake.service.list.mockResolvedValueOnce(memories)

    const response = await handle(
      new Request('https://smriti.example.com/v1/memories'),
      devEnv(),
      ctx,
    )
    expect(response.status).toBe(200)
    await expect(bodyOf(response)).resolves.toEqual({ items: memories })
    expect(fake.service.list).toHaveBeenCalledWith(undefined)
  })

  it('topic 过滤透传给 service.list', async () => {
    const response = await handle(
      new Request('https://smriti.example.com/v1/memories?topic=code.style'),
      devEnv(),
      ctx,
    )
    expect(response.status).toBe(200)
    expect(fake.service.list).toHaveBeenCalledWith('code.style')
  })

  it('topic 为空串时视为不过滤（UI 的 ?topic= 调用形态）', async () => {
    const response = await handle(
      new Request('https://smriti.example.com/v1/memories?limit=200&topic='),
      devEnv(),
      ctx,
    )
    expect(response.status).toBe(200)
    expect(fake.service.list).toHaveBeenCalledWith(undefined)
  })

  it('topic 语法不合法返回 400 且不读存储', async () => {
    const response = await handle(
      new Request('https://smriti.example.com/v1/memories?topic=Bad%20Topic'),
      devEnv(),
      ctx,
    )
    expect(response.status).toBe(400)
    const body = (await bodyOf(response)) as { error: { code: string } }
    expect(body.error.code).toBe('invalid_request')
    expect(fake.service.list).not.toHaveBeenCalled()
  })

  it('limit 截断结果', async () => {
    fake.service.list.mockResolvedValueOnce(
      Array.from({ length: 5 }, (_, index) => memoryFixture({ id: `mem_${index}` })),
    )
    const response = await handle(
      new Request('https://smriti.example.com/v1/memories?limit=2'),
      devEnv(),
      ctx,
    )
    const body = (await bodyOf(response)) as { items: MemoryRecord[] }
    expect(body.items.map((item) => item.id)).toEqual(['mem_0', 'mem_1'])
  })

  it('默认 limit 为 200（超出部分截断）', async () => {
    fake.service.list.mockResolvedValueOnce(
      Array.from({ length: 250 }, (_, index) => memoryFixture({ id: `mem_${index}` })),
    )
    const response = await handle(
      new Request('https://smriti.example.com/v1/memories'),
      devEnv(),
      ctx,
    )
    const body = (await bodyOf(response)) as { items: MemoryRecord[] }
    expect(body.items).toHaveLength(200)
  })

  it('非法 limit 返回 400', async () => {
    for (const raw of ['0', '501', 'abc', '1.5']) {
      const response = await handle(
        new Request(`https://smriti.example.com/v1/memories?limit=${raw}`),
        devEnv(),
        ctx,
      )
      expect(response.status, `limit=${raw}`).toBe(400)
    }
    expect(fake.service.list).not.toHaveBeenCalled()
  })

  it('access 模式未鉴权返回 401', async () => {
    const response = await handle(
      new Request('https://smriti.example.com/v1/memories'),
      accessEnv(),
      ctx,
    )
    expect(response.status).toBe(401)
    expect(fake.service.list).not.toHaveBeenCalled()
  })
})

describe('GET /ui 静态资源', () => {
  it('/ui 与 /ui/ 映射到 index.html，其余路径原样转发', async () => {
    for (const [requestPath, assetPath] of [
      ['/ui', '/ui/index.html'],
      ['/ui/', '/ui/index.html'],
      ['/ui/app.js', '/ui/app.js'],
      ['/ui/assets/styles.css', '/ui/assets/styles.css'],
    ] as const) {
      const { fetchMock, binding } = fakeAssets()
      const response = await handle(
        new Request(`https://smriti.example.com${requestPath}`),
        devEnv({ ASSETS: binding }),
        ctx,
      )
      expect(response.status, requestPath).toBe(200)
      expect(fetchMock).toHaveBeenCalledTimes(1)
      const [assetRequest] = fetchMock.mock.calls[0] as unknown as [Request]
      expect(assetRequest.method).toBe('GET')
      expect(new URL(assetRequest.url).pathname, requestPath).toBe(assetPath)
    }
  })

  it('透传 assets 返回的状态码与 content-type', async () => {
    const { binding } = fakeAssets()
    const response = await handle(
      new Request('https://smriti.example.com/ui'),
      devEnv({ ASSETS: binding }),
      ctx,
    )
    expect(response.headers.get('content-type')).toContain('text/html')
    await expect(response.text()).resolves.toBe('asset:/ui/index.html')
  })

  it('AUTH_MODE=dev 下 UI 无需请求头即可访问', async () => {
    const { fetchMock, binding } = fakeAssets()
    const response = await handle(
      new Request('https://smriti.example.com/ui'),
      devEnv({ ASSETS: binding }),
      ctx,
    )
    expect(response.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('AUTH_MODE=access 无 JWT 时 401 HTML 提示，且不访问静态资源', async () => {
    const { fetchMock, binding } = fakeAssets()
    const response = await handle(
      new Request('https://smriti.example.com/ui'),
      accessEnv({ ASSETS: binding }),
      ctx,
    )
    expect(response.status).toBe(401)
    expect(response.headers.get('content-type')).toContain('text/html')
    await expect(response.text()).resolves.toContain('Cloudflare Access')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('未配置 ASSETS 绑定时返回 503 {error}', async () => {
    const response = await handle(new Request('https://smriti.example.com/ui'), devEnv(), ctx)
    expect(response.status).toBe(503)
    await expect(bodyOf(response)).resolves.toEqual({
      error: { code: 'assets_unavailable', message: expect.any(String) },
    })
  })

  it('assets 抛错时返回 503 而不是 500', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { binding } = fakeAssets(async () => {
      throw new Error('assets exploded')
    })
    const response = await handle(
      new Request('https://smriti.example.com/ui'),
      devEnv({ ASSETS: binding }),
      ctx,
    )
    expect(response.status).toBe(503)
    const body = (await bodyOf(response)) as { error: { code: string } }
    expect(body.error.code).toBe('assets_unavailable')
    errorSpy.mockRestore()
  })

  it('POST /ui 不命中静态资源路由', async () => {
    const { fetchMock, binding } = fakeAssets()
    const response = await handle(jsonRequest('/ui', 'POST'), devEnv({ ASSETS: binding }), ctx)
    expect(response.status).toBe(404)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('P0-3 写入后同步 AI Search 索引', () => {
  function extractCandidateRequest() {
    return jsonRequest('/v1/extract', 'POST', {
      candidates: [{ topic: 'code.style', statement: '使用 2 空格缩进' }],
    })
  }

  it('extract 有 applied 结果时通过 waitUntil 触发同步', async () => {
    fake.service.extract.mockResolvedValueOnce([{ status: 'applied' }])

    const response = await handle(extractCandidateRequest(), devEnv(), ctx)
    expect(response.status).toBe(200)
    expect(waitUntil).toHaveBeenCalledTimes(1)
    expect(fake.search.sync).toHaveBeenCalledTimes(1)
    await settleWaitUntilCall()
  })

  it('extract 结果全部 pending_review/unchanged 时不同步', async () => {
    fake.service.extract.mockResolvedValueOnce([
      { status: 'pending_review' },
      { status: 'unchanged' },
    ])

    const response = await handle(extractCandidateRequest(), devEnv(), ctx)
    expect(response.status).toBe(200)
    expect(waitUntil).not.toHaveBeenCalled()
    expect(fake.search.sync).not.toHaveBeenCalled()
  })

  it('extract 没有候选时不同步', async () => {
    const response = await handle(
      jsonRequest('/v1/extract', 'POST', {
        sessionId: 'sess_1',
        messages: [{ role: 'user', content: '今天天气不错。' }],
      }),
      devEnv(),
      ctx,
    )
    expect(response.status).toBe(200)
    expect(waitUntil).not.toHaveBeenCalled()
    expect(fake.search.sync).not.toHaveBeenCalled()
  })

  it('approve 成功（applied）后同步', async () => {
    fake.service.approve.mockResolvedValueOnce({ status: 'applied' })

    const response = await handle(
      jsonRequest('/v1/pending/chg_1/approve', 'POST'),
      devEnv(),
      ctx,
    )
    expect(response.status).toBe(200)
    expect(waitUntil).toHaveBeenCalledTimes(1)
    expect(fake.search.sync).toHaveBeenCalledTimes(1)
    await settleWaitUntilCall()
  })

  it('approve 未命中（rejected）时不同步', async () => {
    fake.service.approve.mockResolvedValueOnce({
      status: 'rejected',
      message: '待裁决变更不存在：chg_missing',
    })

    const response = await handle(
      jsonRequest('/v1/pending/chg_missing/approve', 'POST'),
      devEnv(),
      ctx,
    )
    expect(response.status).toBe(200)
    expect(waitUntil).not.toHaveBeenCalled()
    expect(fake.search.sync).not.toHaveBeenCalled()
  })

  it('reject 不改动索引，因此不同步', async () => {
    const response = await handle(
      jsonRequest('/v1/pending/chg_1/reject', 'POST', { reason: '不需要' }),
      devEnv(),
      ctx,
    )
    expect(response.status).toBe(200)
    expect(waitUntil).not.toHaveBeenCalled()
    expect(fake.search.sync).not.toHaveBeenCalled()
  })

  it('同步失败只记录日志，不影响已成功的写入响应', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    fake.search.sync.mockRejectedValueOnce(new Error('sync exploded'))

    const response = await handle(extractCandidateRequest(), devEnv(), ctx)
    expect(response.status).toBe(200)
    await settleWaitUntilCall()
    expect(errorSpy).toHaveBeenCalledWith(
      'smriti: AI Search sync after write failed',
      expect.any(Error),
    )
    errorSpy.mockRestore()
  })
})

describe('GET /v1/history 与回滚', () => {
  it('返回归档记录，topic 与 limit 透传给 service', async () => {
    const archived = memoryFixture({
      id: 'mem_old',
      topic: 'identity.role',
      validFrom: '2026-01-01T00:00:00.000Z',
      validTo: '2026-02-01T00:00:00.000Z',
    })
    fake.service.history.mockResolvedValueOnce([archived])

    const response = await handle(
      new Request('https://smriti.example.com/v1/history?topic=identity.role&limit=5'),
      devEnv(),
      ctx,
    )

    expect(response.status).toBe(200)
    await expect(bodyOf(response)).resolves.toEqual({ items: [archived] })
    expect(fake.service.history).toHaveBeenCalledWith({ topic: 'identity.role', limit: 5 })
  })

  it('带 at 时回显时间点并透传', async () => {
    fake.service.history.mockResolvedValueOnce([])
    const at = '2026-01-01T00:00:00.000Z'

    const response = await handle(
      new Request(`https://smriti.example.com/v1/history?at=${encodeURIComponent(at)}`),
      devEnv(),
      ctx,
    )

    expect(response.status).toBe(200)
    await expect(bodyOf(response)).resolves.toEqual({ at, items: [] })
    expect(fake.service.history).toHaveBeenCalledWith({ at, limit: 100 })
  })

  it('at 非法或 topic 语法不合法时返回 400', async () => {
    const badAt = await handle(
      new Request('https://smriti.example.com/v1/history?at=not-a-date'),
      devEnv(),
      ctx,
    )
    expect(badAt.status).toBe(400)

    const badTopic = await handle(
      new Request('https://smriti.example.com/v1/history?topic=Bad%20Topic'),
      devEnv(),
      ctx,
    )
    expect(badTopic.status).toBe(400)
    expect(fake.service.history).not.toHaveBeenCalled()
  })

  it('POST /v1/history/:topic/:id/restore 恢复记录并同步索引', async () => {
    const record = memoryFixture({ id: 'mem_restored', topic: 'identity.role' })
    fake.service.restore.mockResolvedValueOnce(record)

    const response = await handle(
      new Request('https://smriti.example.com/v1/history/identity.role/mem_old/restore', {
        method: 'POST',
      }),
      devEnv(),
      ctx,
    )

    expect(response.status).toBe(200)
    await expect(bodyOf(response)).resolves.toEqual({ status: 'restored', memory: record })
    expect(fake.service.restore).toHaveBeenCalledWith('identity.role', 'mem_old')
    await settleWaitUntilCall()
  })

  it('恢复不存在的归档记录返回 404', async () => {
    const response = await handle(
      new Request('https://smriti.example.com/v1/history/identity.role/mem_missing/restore', {
        method: 'POST',
      }),
      devEnv(),
      ctx,
    )

    expect(response.status).toBe(404)
    const body = (await bodyOf(response)) as { error: { code: string } }
    expect(body.error.code).toBe('not_found')
  })

  it('GET 不走回滚路由', async () => {
    const response = await handle(
      new Request('https://smriti.example.com/v1/history/identity.role/mem_old/restore'),
      devEnv(),
      ctx,
    )
    expect(response.status).toBe(404)
    expect(fake.service.restore).not.toHaveBeenCalled()
  })
})


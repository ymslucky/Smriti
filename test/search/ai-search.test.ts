import { describe, expect, it, vi } from 'vitest'
import type { AiSearchBinding } from '../../src/env'
import { createAiSearch } from '../../src/search/ai-search'

interface SearchPayload {
  messages: { role: string; content: string }[]
  ai_search_options: {
    retrieval: {
      max_num_results: number
      filters?: { topic?: string }
    }
  }
}

interface FakeInstance {
  search: (input: unknown) => Promise<unknown>
  jobs?: { create: () => Promise<unknown> }
}

function activeKey(topic: string, id: string): string {
  return `memories/active/${topic}/${id}.md`
}

/**
 * 真实 AI Search（R2 数据源）chunk 形状：
 * `{ id, type, score, text, item: { key }, scoring_details }`——R2 key 在 `item.key`。
 * `id`/`type`/`scoring_details` 不参与解析，保留它们是为了防止实现误读顶层 `id` 当记忆 id。
 */
function realChunk(
  topic: string,
  id: string,
  text: string,
  score: number,
): Record<string, unknown> {
  return {
    id: `chunk_${id}`,
    type: 'text',
    score,
    text,
    item: { key: activeKey(topic, id) },
    scoring_details: [{ id: 'semantic', score }],
  }
}

function fakeBinding(instance: FakeInstance): { binding: AiSearchBinding; get: ReturnType<typeof vi.fn> } {
  const get = vi.fn(() => instance)
  return { binding: { get } as unknown as AiSearchBinding, get }
}

describe('createAiSearch', () => {
  it('把真实 chunks 响应（R2 key 在 item.key）解析为 SearchHit[]，并带上检索参数', async () => {
    const payloads: SearchPayload[] = []
    const search = vi.fn(async (input: unknown) => {
      payloads.push(input as SearchPayload)
      return {
        object: 'list',
        chunks: [
          realChunk('tooling.package-manager', 'mem_1', '默认使用 pnpm', 0.93),
          realChunk('code.testing', 'mem_2', '单元测试用 vitest', 0.71),
          // 真实响应里也可能夹带脏数据：缺 item / 非字符串 text。
          { id: 'chunk_bad_1', score: 0.5, text: '没有 item' },
          { id: 'chunk_bad_2', item: { key: activeKey('code.testing', 'mem_3') }, text: 42 },
        ],
      }
    })
    const { binding, get } = fakeBinding({ search })

    const index = createAiSearch(binding, { instance: 'memory' })
    expect(get).not.toHaveBeenCalled()

    const hits = await index.search('包管理器', { limit: 5 })

    expect(get).toHaveBeenCalledWith('memory')
    expect(search).toHaveBeenCalledTimes(1)
    expect(payloads).toHaveLength(1)
    expect(payloads[0]).toEqual({
      messages: [{ role: 'user', content: '包管理器' }],
      ai_search_options: {
        retrieval: { max_num_results: 5, filters: undefined },
      },
    })
    expect(hits).toEqual([
      { id: 'mem_1', topic: 'tooling.package-manager', statement: '默认使用 pnpm', score: 0.93 },
      { id: 'mem_2', topic: 'code.testing', statement: '单元测试用 vitest', score: 0.71 },
    ])
  })

  it('topic 过滤不被后端支持时回退为本地精确过滤', async () => {
    const payloads: SearchPayload[] = []
    const search = vi.fn(async (input: unknown) => {
      const payload = input as SearchPayload
      payloads.push(payload)
      if (payload.ai_search_options.retrieval.filters !== undefined) {
        // 线上真实报错：AiSearchError: metadata_filter_unknown_field
        throw { name: 'AiSearchError', message: 'metadata_filter_unknown_field' }
      }
      return {
        chunks: [
          realChunk('code.testing', 'mem_1', '单元测试用 vitest', 0.9),
          realChunk('tooling.package-manager', 'mem_2', '默认使用 pnpm', 0.8),
        ],
      }
    })
    const { binding } = fakeBinding({ search })
    const index = createAiSearch(binding, { instance: 'memory' })

    const hits = await index.search('测试', { limit: 3, topic: 'code.testing' })

    expect(hits).toEqual([
      { id: 'mem_1', topic: 'code.testing', statement: '单元测试用 vitest', score: 0.9 },
    ])
    expect(payloads).toHaveLength(2)
    expect(payloads[0].ai_search_options.retrieval.filters).toEqual({ topic: 'code.testing' })
    // 回退请求不带 filter，并放大取回数量后再本地精确过滤。
    expect(payloads[1].ai_search_options.retrieval.filters).toBeUndefined()
    expect(payloads[1].ai_search_options.retrieval.max_num_results).toBe(15)
  })

  it('兼容顶层 key 的旧响应形状（chunks/data 两种包装都识别）', async () => {
    for (const wrapper of ['chunks', 'data'] as const) {
      const search = vi.fn(async (_input: unknown) => ({
        [wrapper]: [
          { key: activeKey('code.testing', 'mem_top_1'), text: '顶层 key 命中', score: 0.66 },
        ],
      }))
      const { binding } = fakeBinding({ search })
      const index = createAiSearch(binding, { instance: 'memory' })

      await expect(index.search('测试', { limit: 3, topic: 'code.testing' })).resolves.toEqual([
        { id: 'mem_top_1', topic: 'code.testing', statement: '顶层 key 命中', score: 0.66 },
      ])
    }

    const payloads: SearchPayload[] = []
    const search = vi.fn(async (input: unknown) => {
      payloads.push(input as SearchPayload)
      return {
        data: [{ key: activeKey('code.testing', 'mem_9'), text: '覆盖率不是目标', score: 0.66 }],
      }
    })
    const { binding } = fakeBinding({ search })
    const index = createAiSearch(binding, { instance: 'memory' })

    await index.search('测试习惯', { limit: 3, topic: 'code.testing' })

    expect(payloads[0]?.ai_search_options.retrieval.filters).toEqual({ topic: 'code.testing' })
    expect(payloads[0]?.ai_search_options.retrieval.max_num_results).toBe(3)
  })

  it('兼容不带 memories/active/ 前缀的裸 key：{topic}/{id}.md', async () => {
    for (const wrapper of ['chunks', 'data'] as const) {
      const search = vi.fn(async (_input: unknown) => ({
        [wrapper]: [
          { item: { key: 'code.testing/mem_bare.md' }, text: '裸 key 命中', score: 0.5 },
        ],
      }))
      const { binding } = fakeBinding({ search })
      const index = createAiSearch(binding, { instance: 'memory' })

      await expect(index.search('裸 key', { limit: 3 })).resolves.toEqual([
        { id: 'mem_bare', topic: 'code.testing', statement: '裸 key 命中', score: 0.5 },
      ])
    }
  })

  it('item.key 优先于顶层 key；item.key 不可解析时回退顶层 key', async () => {
    const search = vi.fn(async (_input: unknown) => ({
      chunks: [
        {
          id: 'chunk_dual',
          key: activeKey('code.testing', 'mem_stale'),
          text: 'item.key 优先',
          score: 0.8,
          item: { key: activeKey('tooling.package-manager', 'mem_fresh') },
        },
        {
          key: activeKey('code.testing', 'mem_fallback'),
          text: '回退顶层 key',
          score: 0.6,
          item: { key: 'not/a/valid/key.md' },
        },
      ],
    }))
    const { binding } = fakeBinding({ search })
    const index = createAiSearch(binding, { instance: 'memory' })

    const hits = await index.search('优先级', { limit: 5 })

    expect(hits).toEqual([
      {
        id: 'mem_fresh',
        topic: 'tooling.package-manager',
        statement: 'item.key 优先',
        score: 0.8,
      },
      { id: 'mem_fallback', topic: 'code.testing', statement: '回退顶层 key', score: 0.6 },
    ])
  })

  it('拒绝 _history 前缀、坏 topic 与坏 id，保留同批合法命中', async () => {
    const search = vi.fn(async (_input: unknown) => ({
      chunks: [
        // _history 前缀（完整路径 / 裸路径 / 顶层 key）都应被拒。
        { item: { key: 'memories/_history/code.testing/mem_h1.md' }, text: '历史', score: 0.99 },
        { item: { key: '_history/code.testing/mem_h2.md' }, text: '裸历史', score: 0.98 },
        { key: 'memories/_history/code.testing/mem_h3.md', text: '顶层历史', score: 0.97 },
        // topic 不匹配 ^[a-z0-9._-]+$。
        { item: { key: activeKey('Code.Testing', 'mem_bad_1') }, text: '大写 topic' },
        { item: { key: activeKey('code testing', 'mem_bad_2') }, text: '空格 topic' },
        { item: { key: activeKey('主题', 'mem_bad_3') }, text: '非 ASCII topic' },
        { item: { key: 'Bad.Topic/mem_bad_4.md' }, text: '裸 key 坏 topic' },
        // 路径穿越用的点段 topic。
        { item: { key: activeKey('.', 'mem_bad_5') }, text: '点 topic' },
        { item: { key: activeKey('..', 'mem_bad_6') }, text: '双点 topic' },
        // id 段非法：空 id、点段 id、含斜杠的多段 id、尾随斜杠。
        { item: { key: 'memories/active/code.testing/.md' }, text: '空 id' },
        { item: { key: activeKey('code.testing', '..') }, text: '点 id' },
        { item: { key: 'memories/active/code.testing/sub/mem_bad_7.md' }, text: '多段 id' },
        { item: { key: `${activeKey('code.testing', 'mem_bad_8')}/` }, text: '尾随斜杠' },
        // key 缺失 / 非字符串 / item 非对象。
        { text: '没有 key', score: 0.4 },
        { key: 42, text: 'key 不是字符串', score: 0.3 },
        { item: 'memories/active/code.testing/mem_bad_9.md', text: 'item 不是对象', score: 0.2 },
        { item: null, text: 'item 为 null', score: 0.1 },
        // 同批合法命中必须保留，证明上面的拒绝是个体级的。
        realChunk('code.testing', 'mem_ok', '合法命中', 0.5),
      ],
    }))
    const { binding } = fakeBinding({ search })
    const index = createAiSearch(binding, { instance: 'memory' })

    const hits = await index.search('测试', { limit: 10 })

    expect(hits).toEqual([
      { id: 'mem_ok', topic: 'code.testing', statement: '合法命中', score: 0.5 },
    ])
  })

  it('text 缺失/非字符串时丢弃；score 缺失或非法记 0，数字字符串照常解析', async () => {
    const search = vi.fn(async (_input: unknown) => ({
      data: [
        { item: { key: 'code.testing/mem_s1.md' }, text: '缺 score' },
        { item: { key: 'code.testing/mem_s2.md' }, text: '数字 score', score: 0.4 },
        { item: { key: 'code.testing/mem_s3.md' }, text: '字符串 score', score: '0.42' },
        { item: { key: 'code.testing/mem_s4.md' }, text: '非法字符串 score', score: 'abc' },
        { item: { key: 'code.testing/mem_s5.md' }, text: '空白字符串 score', score: '   ' },
        { item: { key: 'code.testing/mem_s6.md' }, text: 'NaN score', score: Number.NaN },
        { item: { key: 'code.testing/mem_s7.md' }, text: 'Infinity score', score: Number.POSITIVE_INFINITY },
        { item: { key: 'code.testing/mem_s8.md' }, text: 'null score', score: null },
        { item: { key: 'code.testing/mem_s9.md' }, text: 'boolean score', score: true },
        // 以下 text 非法，整条丢弃。
        { item: { key: 'code.testing/mem_t1.md' }, score: 0.5 },
        { item: { key: 'code.testing/mem_t2.md' }, text: 42, score: 0.5 },
        { item: { key: 'code.testing/mem_t3.md' }, text: null, score: 0.5 },
        { item: { key: 'code.testing/mem_t4.md' }, text: ['x'], score: 0.5 },
      ],
    }))
    const { binding } = fakeBinding({ search })
    const index = createAiSearch(binding, { instance: 'memory' })

    const hits = await index.search('score', { limit: 20 })

    expect(hits).toEqual([
      { id: 'mem_s1', topic: 'code.testing', statement: '缺 score', score: 0 },
      { id: 'mem_s2', topic: 'code.testing', statement: '数字 score', score: 0.4 },
      { id: 'mem_s3', topic: 'code.testing', statement: '字符串 score', score: 0.42 },
      { id: 'mem_s4', topic: 'code.testing', statement: '非法字符串 score', score: 0 },
      { id: 'mem_s5', topic: 'code.testing', statement: '空白字符串 score', score: 0 },
      { id: 'mem_s6', topic: 'code.testing', statement: 'NaN score', score: 0 },
      { id: 'mem_s7', topic: 'code.testing', statement: 'Infinity score', score: 0 },
      { id: 'mem_s8', topic: 'code.testing', statement: 'null score', score: 0 },
      { id: 'mem_s9', topic: 'code.testing', statement: 'boolean score', score: 0 },
    ])
  })

  it('响应形状无法识别时返回空数组', async () => {
    for (const response of [undefined, null, {}, { chunks: 'nope' }, { data: 3 }, 42, 'text']) {
      const search = vi.fn(async (_input: unknown) => response)
      const { binding } = fakeBinding({ search })
      const index = createAiSearch(binding, { instance: 'memory' })

      await expect(index.search('任意查询', { limit: 3 })).resolves.toEqual([])
    }
  })

  it('顶层数组响应也按命中列表解析', async () => {
    const search = vi.fn(async (_input: unknown) => [
      realChunk('code.testing', 'mem_arr', '数组命中', 0.33),
    ])
    const { binding } = fakeBinding({ search })
    const index = createAiSearch(binding, { instance: 'memory' })

    await expect(index.search('数组', { limit: 3 })).resolves.toEqual([
      { id: 'mem_arr', topic: 'code.testing', statement: '数组命中', score: 0.33 },
    ])
  })

  it('binding 缺失时返回空数组，不抛错', async () => {
    const index = createAiSearch(undefined, { instance: 'memory' })

    await expect(index.search('任意查询', { limit: 5 })).resolves.toEqual([])
    await expect(index.sync()).resolves.toBeUndefined()
  })

  it('实例缺失时同样降级为空数组', async () => {
    const get = vi.fn(() => undefined)
    const binding = { get } as unknown as AiSearchBinding
    const index = createAiSearch(binding, { instance: 'memory' })

    await expect(index.search('任意查询', { limit: 5 })).resolves.toEqual([])
    await expect(index.sync()).resolves.toBeUndefined()
  })

  it('sync 在实例暴露 jobs.create() 时触发一次', async () => {
    const create = vi.fn(async () => ({ id: 'job_1' }))
    const search = vi.fn(async (_input: unknown) => ({ chunks: [] }))
    const { binding } = fakeBinding({ search, jobs: { create } })
    const index = createAiSearch(binding, { instance: 'memory' })

    await index.sync()

    expect(create).toHaveBeenCalledTimes(1)
  })

  it('sync 吞掉 429，但其它错误继续抛出', async () => {
    const create = vi.fn(async () => {
      throw Object.assign(new Error('Too Many Requests'), { status: 429 })
    })
    const search = vi.fn(async (_input: unknown) => ({ chunks: [] }))
    const { binding } = fakeBinding({ search, jobs: { create } })
    const index = createAiSearch(binding, { instance: 'memory' })

    await expect(index.sync()).resolves.toBeUndefined()

    const boom = new Error('boom')
    create.mockImplementation(async () => {
      throw boom
    })
    await expect(index.sync()).rejects.toBe(boom)
  })

  it('sync 也识别错误消息中的 429', async () => {
    const create = vi.fn(async () => {
      throw new Error('AI Search: 429 rate limited')
    })
    const search = vi.fn(async (_input: unknown) => ({ chunks: [] }))
    const { binding } = fakeBinding({ search, jobs: { create } })
    const index = createAiSearch(binding, { instance: 'memory' })

    await expect(index.sync()).resolves.toBeUndefined()
  })

  it('sync 在缺少 jobs.create() 时是 no-op', async () => {
    const search = vi.fn(async (_input: unknown) => ({ chunks: [] }))
    const { binding } = fakeBinding({ search })
    const index = createAiSearch(binding, { instance: 'memory' })

    await expect(index.sync()).resolves.toBeUndefined()
  })
})

describe('createAiSearch 实例解析与探活', () => {
  function notFoundError(): Error {
    return Object.assign(new Error('ai_search_not_found'), { name: 'AiSearchNotFoundError' })
  }

  it('配置实例不存在但命名空间只有一个实例时自动改用该实例', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const search = vi.fn(async (_input: unknown) => ({
      chunks: [realChunk('code.style', 'mem_1', '使用 2 空格缩进', 0.9)],
    }))
    const get = vi.fn(() => ({ search }))
    const list = vi.fn(async () => ({ result: [{ id: 'smriti-memory' }] }))
    const index = createAiSearch({ get, list } as unknown as AiSearchBinding, {
      instance: 'memory',
    })

    await expect(index.search('缩进', { limit: 3 })).resolves.toEqual([
      { id: 'mem_1', topic: 'code.style', statement: '使用 2 空格缩进', score: 0.9 },
    ])
    expect(get).toHaveBeenCalledWith('smriti-memory')
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })

  it('实例在解析后消失：降级为空结果，health 转为不健康，且只报一次错', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const search = vi.fn(async (_input: unknown) => {
      throw notFoundError()
    })
    const get = vi.fn(() => ({ search }))
    const list = vi
      .fn()
      // 首次解析：配置名存在。
      .mockResolvedValueOnce({ result: [{ id: 'memory' }] })
      // 失败后强制重解析：实例已被删除。
      .mockResolvedValueOnce({ result: [] })
      .mockResolvedValue({ result: [] })
    const index = createAiSearch({ get, list } as unknown as AiSearchBinding, {
      instance: 'memory',
    })

    await expect(index.search('缩进', { limit: 3 })).resolves.toEqual([])

    const health = await index.health!()
    expect(health.ok).toBe(false)
    expect(health.instance).toBe('memory')
    expect(health.reason).toContain('没有任何 AI Search 实例')
    expect(error).toHaveBeenCalledTimes(1)
    error.mockRestore()
  })

  it('非"实例不存在"的错误继续抛给调用方，不静默降级', async () => {
    const boom = new Error('network down')
    const search = vi.fn(async (_input: unknown) => {
      throw boom
    })
    const get = vi.fn(() => ({ search }))
    const index = createAiSearch({ get } as unknown as AiSearchBinding, { instance: 'memory' })

    await expect(index.search('x', { limit: 3 })).rejects.toBe(boom)
  })

  it('health 走真实探活（列表 + info）并按 TTL 缓存', async () => {
    const info = vi.fn(async () => ({}))
    const get = vi.fn(() => ({ search: vi.fn(), info }))
    const list = vi.fn(async () => ({ result: [{ id: 'memory' }] }))
    const index = createAiSearch({ get, list } as unknown as AiSearchBinding, {
      instance: 'memory',
      healthTtlMs: 60_000,
    })

    const first = await index.health!()
    expect(first.ok).toBe(true)
    expect(first.instance).toBe('memory')

    const second = await index.health!()
    expect(second).toBe(first)
    expect(list).toHaveBeenCalledTimes(1)
    expect(info).toHaveBeenCalledTimes(1)
  })

  it('info() 探活失败不把实例判死（存在性由列表保证）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const info = vi.fn(async () => {
      throw new Error('info temporarily unavailable')
    })
    const get = vi.fn(() => ({ search: vi.fn(), info }))
    const list = vi.fn(async () => ({ result: [{ id: 'memory' }] }))
    const index = createAiSearch({ get, list } as unknown as AiSearchBinding, {
      instance: 'memory',
    })

    const health = await index.health!()
    expect(health.ok).toBe(true)
    expect(health.instance).toBe('memory')
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })

  it('绑定缺失时 health 明确报不可用，而不是假装健康', async () => {
    const index = createAiSearch(undefined, { instance: 'memory' })

    const health = await index.health!()
    expect(health.ok).toBe(false)
    expect(health.instance).toBe('memory')
    expect(health.reason).toContain('AI_SEARCH')
  })

  it('列表不可用且没有 info 探针时 health 报不健康（不冒充健康）', async () => {
    const list = vi.fn(async () => {
      throw new Error('no permission')
    })
    const get = vi.fn(() => ({ search: vi.fn() }))
    const index = createAiSearch({ get, list } as unknown as AiSearchBinding, {
      instance: 'memory',
    })

    const health = await index.health!()
    expect(health.ok).toBe(false)
    expect(health.instance).toBe('memory')
    expect(health.reason).toContain('no permission')
  })

  it('sync 遇到实例不存在时吞掉错误（cron 不反复失败）', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const create = vi.fn(async () => {
      throw Object.assign(new Error('ai_search_not_found'), { code: 7002 })
    })
    const search = vi.fn(async (_input: unknown) => ({ chunks: [] }))
    const get = vi.fn(() => ({ search, jobs: { create } }))
    const index = createAiSearch({ get } as unknown as AiSearchBinding, { instance: 'memory' })

    await expect(index.sync()).resolves.toBeUndefined()
    expect(create).toHaveBeenCalledTimes(1)
    expect(error).toHaveBeenCalledTimes(1)
    error.mockRestore()
  })
})

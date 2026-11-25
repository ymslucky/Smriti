import { describe, expect, it, vi } from 'vitest'
import type { MemoryStore, SearchIndex } from '../../src/contracts'
import { createRecall } from '../../src/recall'
import { labelForTopic } from '../../src/topics'
import type { MemoryRecord, SearchHit } from '../../src/types'

function item(id: string, topic: string, statement: string, extra: Record<string, unknown> = {}) {
  return { id, topic, topicLabel: labelForTopic(topic), statement, ...extra }
}

function record(id: string, topic: string, statement: string): MemoryRecord {
  return {
    id,
    topic,
    statement,
    confidence: 0.8,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    version: 1,
  }
}

function fakeSearch(
  impl: (query: string, options: { limit: number; topic?: string }) => Promise<SearchHit[]>,
): { search: SearchIndex; searchSpy: ReturnType<typeof vi.fn> } {
  const searchSpy = vi.fn(impl)
  const search = {
    search: searchSpy,
    sync: vi.fn(async () => {}),
  } as unknown as SearchIndex
  return { search, searchSpy }
}

interface FakeStore {
  store: MemoryStore
  recentSpy: ReturnType<typeof vi.fn>
  getActiveSpy: ReturnType<typeof vi.fn>
}

/** recent 返回给定记录；getActive 在记录集中按 topic + id 查找（模拟 R2 真源）。 */
function fakeStore(records: MemoryRecord[]): FakeStore {
  const recentSpy = vi.fn(async (_limit: number) => records)
  const getActiveSpy = vi.fn(async (topic: string, id: string) => {
    return records.find((item) => item.id === id && item.topic === topic) ?? null
  })
  return {
    store: { recent: recentSpy, getActive: getActiveSpy } as unknown as MemoryStore,
    recentSpy,
    getActiveSpy,
  }
}

describe('createRecall', () => {
  it('检索命中按 R2 水合成最新陈述，已删除命中的丢弃，recent 去重后截断', async () => {
    const records = [
      record('mem_2', 'workflow.git', 'R2 最新版本'),
      record('mem_3', 'tooling.shell', '最近写入 3'),
      record('mem_4', 'environment.os', '最近写入 4'),
    ]
    const hits: SearchHit[] = [
      // 索引里是同一 id 的旧文本，且另一条命中已被删除。
      { id: 'mem_2', topic: 'workflow.git', statement: '索引里的旧文本', score: 0.9 },
      { id: 'mem_deleted', topic: 'code.style', statement: '已删除记录', score: 0.8 },
    ]
    const { search, searchSpy } = fakeSearch(async () => hits)
    const { store, recentSpy, getActiveSpy } = fakeStore(records)
    const recall = createRecall({ store, search })

    const items = await recall('怎么测', 3)

    expect(searchSpy).toHaveBeenCalledWith('怎么测', { limit: 3 })
    expect(recentSpy).toHaveBeenCalledWith(3)
    // mem_2 用 R2 文本；mem_deleted 找不到 active 被丢弃；mem_3 由 recent 补齐。
    expect(getActiveSpy).toHaveBeenCalledWith('workflow.git', 'mem_2')
    expect(getActiveSpy).toHaveBeenCalledWith('code.style', 'mem_deleted')
    expect(items).toEqual([
      item('mem_2', 'workflow.git', 'R2 最新版本'),
      item('mem_3', 'tooling.shell', '最近写入 3'),
      item('mem_4', 'environment.os', '最近写入 4'),
    ])
  })

  it('hydrate:false 时不读 R2，直接使用检索返回的文本', async () => {
    const hits: SearchHit[] = [
      { id: 'mem_1', topic: 'code.testing', statement: '索引文本', score: 0.9 },
    ]
    const { search } = fakeSearch(async () => hits)
    const { store, getActiveSpy } = fakeStore([])
    const recall = createRecall({ store, search, hydrate: false })

    const items = await recall('测试', 5)

    expect(getActiveSpy).not.toHaveBeenCalled()
    expect(items).toEqual([item('mem_1', 'code.testing', '索引文本')])
  })

  it('默认水合：R2 中不存在的命中被丢弃', async () => {
    const { search } = fakeSearch(async () => [
      { id: 'mem_gone', topic: 'code.style', statement: '索引残留', score: 0.9 },
    ])
    const { store } = fakeStore([record('mem_7', 'communication.format', '回答保持简洁')])
    const recall = createRecall({ store, search })

    const items = await recall('风格', 5)

    expect(items).toEqual([
      item('mem_7', 'communication.format', '回答保持简洁'),
    ])
  })

  it('单条水合读取失败时丢弃该命中，不阻塞召回', async () => {
    const { search } = fakeSearch(async () => [
      { id: 'mem_bad', topic: 'code.style', statement: '脏 id', score: 0.9 },
    ])
    const recentSpy = vi.fn(async (_limit: number) => [record('mem_ok', 'code.style', '正常记录')])
    const getActiveSpy = vi.fn(async () => {
      throw new Error('invalid id')
    })
    const store = { recent: recentSpy, getActive: getActiveSpy } as unknown as MemoryStore
    const recall = createRecall({ store, search })

    const items = await recall('风格', 3)

    expect(getActiveSpy).toHaveBeenCalledTimes(1)
    expect(items).toEqual([item('mem_ok', 'code.style', '正常记录')])
  })

  it('检索结果内部重复 id 只保留第一条', async () => {
    const hits: SearchHit[] = [
      { id: 'mem_1', topic: 'code.testing', statement: '第一次命中', score: 0.9 },
      { id: 'mem_1', topic: 'code.testing', statement: '重复命中', score: 0.5 },
    ]
    const { search } = fakeSearch(async () => hits)
    const { store } = fakeStore([])
    const recall = createRecall({ store, search, hydrate: false })

    const items = await recall('测试', 5)

    expect(items).toEqual([item('mem_1', 'code.testing', '第一次命中')])
  })

  it('检索抛错时只返回 recent，不阻塞召回', async () => {
    const { search, searchSpy } = fakeSearch(async () => {
      throw new Error('AI Search 429 rate limited')
    })
    const { store, recentSpy, getActiveSpy } = fakeStore([
      record('mem_7', 'communication.format', '回答保持简洁'),
    ])
    const recall = createRecall({ store, search })

    const items = await recall('回答风格', 5)

    expect(searchSpy).toHaveBeenCalledWith('回答风格', { limit: 5 })
    expect(recentSpy).toHaveBeenCalledWith(5)
    expect(getActiveSpy).not.toHaveBeenCalled()
    expect(items).toEqual([
      item('mem_7', 'communication.format', '回答保持简洁'),
    ])
  })

  it('检索无结果时回退到 recent', async () => {
    const { search } = fakeSearch(async () => [])
    const { store } = fakeStore([record('mem_8', 'tooling.runtime', '使用 Node 22')])
    const recall = createRecall({ store, search })

    await expect(recall('运行时', 4)).resolves.toEqual([
      item('mem_8', 'tooling.runtime', '使用 Node 22'),
    ])
  })

  it('合并后仍超过 limit 时按顺序截断', async () => {
    const records = [
      record('mem_a', 'code.style', 'A'),
      record('mem_b', 'code.style', 'B'),
      record('mem_c', 'code.style', 'C'),
    ]
    const hits: SearchHit[] = [
      { id: 'mem_a', topic: 'code.style', statement: 'A 旧文本', score: 0.9 },
      { id: 'mem_b', topic: 'code.style', statement: 'B 旧文本', score: 0.8 },
      { id: 'mem_c', topic: 'code.style', statement: 'C 旧文本', score: 0.7 },
    ]
    const { search } = fakeSearch(async () => hits)
    const { store, recentSpy } = fakeStore(records)
    const recall = createRecall({ store, search })

    const items = await recall('风格', 2)

    expect(recentSpy).toHaveBeenCalledWith(2)
    expect(items).toEqual([
      item('mem_a', 'code.style', 'A'),
      item('mem_b', 'code.style', 'B'),
    ])
  })

  it('limit 非正数时直接返回空数组且不访问依赖', async () => {
    const { search, searchSpy } = fakeSearch(async () => [])
    const { store, recentSpy, getActiveSpy } = fakeStore([record('mem_9', 'code.style', 'X')])
    const recall = createRecall({ store, search })

    await expect(recall('任意查询', 0)).resolves.toEqual([])
    expect(searchSpy).not.toHaveBeenCalled()
    expect(recentSpy).not.toHaveBeenCalled()
    expect(getActiveSpy).not.toHaveBeenCalled()
  })
})

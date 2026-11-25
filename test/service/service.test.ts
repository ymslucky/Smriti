/**
 * `service.ts` 单元测试：用内存 fake 覆盖写入 / 冲突 / 近似 / 幂等 / 裁决 / 查询状态机。
 *
 * 所有时间与 id 都通过依赖注入固定，断言不依赖真实时钟或随机数。
 */

import { describe, expect, it } from 'vitest'

import type { MemoryStore, SearchIndex } from '../../src/contracts'
import {
  createMemoryService,
  DEFAULT_CONFIDENCE,
  DEFAULT_SEARCH_LIMIT,
  LOCAL_DUPLICATE_SIMILARITY,
  normalizeStatement,
  statementHash,
  statementSimilarity,
} from '../../src/service'
import type { MemoryServiceDeps } from '../../src/service'
import type {
  ArchivedRecord,
  JournalEvent,
  MemoryRecord,
  PendingChange,
  SearchHit,
} from '../../src/types'

const FIXED_NOW = new Date('2026-01-02T03:04:05.000Z')
const ISO = FIXED_NOW.toISOString()

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

interface HistoryEntry {
  record: MemoryRecord
  reason: string
  archivedAt?: string
}

interface RecordedSearch {
  query: string
  options: { limit: number; topic?: string }
}

/** 内存版 MemoryStore：与 R2 实现共享同一窄接口语义。 */
class FakeStore implements MemoryStore {
  readonly active = new Map<string, MemoryRecord>()
  readonly bodies = new Map<string, string>()
  readonly pendingChanges = new Map<string, PendingChange>()
  readonly historyEntries: HistoryEntry[] = []
  readonly journal: JournalEvent[] = []

  /** 故障注入：非 null 时对应写入操作抛错，用于验证 approve 的失败语义。 */
  failPutActiveWith: Error | null = null
  failMoveWith: Error | null = null
  /** 一次性故障：deletePending 第一次调用抛错，之后恢复正常。 */
  failDeletePendingOnce: Error | null = null

  constructor(private readonly now: () => Date = () => new Date(FIXED_NOW)) {}

  get history(): HistoryEntry[] {
    return this.historyEntries
  }

  private key(topic: string, id: string): string {
    return `${topic}/${id}`
  }

  async putActive(record: MemoryRecord, body: string): Promise<void> {
    if (this.failPutActiveWith) throw this.failPutActiveWith
    this.active.set(this.key(record.topic, record.id), clone(record))
    this.bodies.set(this.key(record.topic, record.id), body)
  }

  async getActive(topic: string, id: string): Promise<MemoryRecord | null> {
    const record = this.active.get(this.key(topic, id))
    return record ? clone(record) : null
  }

  async listActive(topic?: string): Promise<MemoryRecord[]> {
    return [...this.active.values()]
      .filter((record) => !topic || record.topic === topic)
      .map((record) => clone(record))
  }

  async moveToHistory(topic: string, id: string, reason: string): Promise<void> {
    if (this.failMoveWith) throw this.failMoveWith
    const key = this.key(topic, id)
    const record = this.active.get(key)
    if (record) {
      const at = this.now().toISOString()
      const archived = clone(record)
      archived.validFrom = archived.validFrom ?? archived.createdAt
      archived.validTo = at
      this.historyEntries.push({ record: archived, reason, archivedAt: at })
    }
    this.active.delete(key)
    this.bodies.delete(key)
  }

  async getHistory(topic: string, id: string): Promise<ArchivedRecord | null> {
    const entry = this.historyEntries.find(
      (item) => item.record.topic === topic && item.record.id === id,
    )
    if (entry === undefined) return null
    return {
      ...clone(entry.record),
      ...(entry.archivedAt !== undefined ? { archivedAt: entry.archivedAt } : {}),
      archiveReason: entry.reason,
    }
  }

  async listHistory(topic?: string): Promise<ArchivedRecord[]> {
    return this.historyEntries
      .filter((item) => !topic || item.record.topic === topic)
      .map((item) => ({
        ...clone(item.record),
        ...(item.archivedAt !== undefined ? { archivedAt: item.archivedAt } : {}),
        archiveReason: item.reason,
      }))
  }

  async deleteHistory(topic: string, id: string): Promise<void> {
    const index = this.historyEntries.findIndex(
      (item) => item.record.topic === topic && item.record.id === id,
    )
    if (index >= 0) this.historyEntries.splice(index, 1)
  }

  async putPending(change: PendingChange): Promise<void> {
    this.pendingChanges.set(change.changeId, clone(change))
  }

  async getPending(changeId: string): Promise<PendingChange | null> {
    const change = this.pendingChanges.get(changeId)
    return change ? clone(change) : null
  }

  async listPending(): Promise<PendingChange[]> {
    return [...this.pendingChanges.values()].map((change) => clone(change))
  }

  async deletePending(changeId: string): Promise<void> {
    if (this.failDeletePendingOnce) {
      const error = this.failDeletePendingOnce
      this.failDeletePendingOnce = null
      throw error
    }
    this.pendingChanges.delete(changeId)
  }

  async appendJournal(event: JournalEvent): Promise<void> {
    this.journal.push(clone(event))
  }

  async cleanupHistory(_before: Date): Promise<number> {
    return 0
  }

  async recent(limit: number): Promise<MemoryRecord[]> {
    const list = [...this.active.values()]
    return list
      .slice(Math.max(0, list.length - limit))
      .reverse()
      .map((record) => clone(record))
  }
}

/** 可编排的 SearchIndex：hits 决定近似判定结果，calls 记录入参。 */
class FakeSearch implements SearchIndex {
  hits: SearchHit[] = []
  calls: RecordedSearch[] = []
  failWith: unknown = undefined
  syncCount = 0

  async search(query: string, options: { limit: number; topic?: string }): Promise<SearchHit[]> {
    this.calls.push({ query, options })
    if (this.failWith !== undefined) throw this.failWith
    return this.hits.slice(0, options.limit)
  }

  async sync(): Promise<void> {
    this.syncCount += 1
  }
}

interface Harness {
  store: FakeStore
  search: FakeSearch
  service: ReturnType<typeof createMemoryService>
}

/** 固定时钟 + 递增 16 位 hex id；`now` 可注入以实现时间线断言。 */
function harness(
  options: { now?: () => Date; service?: Partial<MemoryServiceDeps> } = {},
): Harness {
  let sequence = 0
  const now = options.now ?? (() => new Date(FIXED_NOW))
  const store = new FakeStore(now)
  const search = new FakeSearch()
  const service = createMemoryService({
    store,
    search,
    now,
    newId: () => (sequence++).toString(16).padStart(16, '0'),
    ...options.service,
  })
  return { store, search, service }
}

function recordId(sequence: number): string {
  return `mem_${sequence.toString(16).padStart(16, '0')}`
}

describe('normalizeStatement / statementHash', () => {
  it('合并空白并去掉句末多余标点', () => {
    expect(normalizeStatement('  统一用   pnpm 安装依赖。。。 ')).toBe('统一用 pnpm 安装依赖')
    expect(normalizeStatement('Always use pnpm!!!')).toBe('Always use pnpm')
    expect(normalizeStatement(' \n\t ')).toBe('')
  })

  it('归一化后相同则哈希相同', () => {
    expect(statementHash(normalizeStatement('统一用 pnpm。'))).toBe(
      statementHash(normalizeStatement('  统一用    pnpm！！！')),
    )
    expect(statementHash('a')).not.toBe(statementHash('b'))
  })
})

describe('MemoryService.upsert', () => {
  it('无冲突时写入 active 并返回 applied', async () => {
    const { store, search, service } = harness()

    const result = await service.upsert({
      topic: 'tooling.package-manager',
      statement: '  统一用   pnpm 安装依赖。 ',
      rationale: 'lockfile 一致',
      source: { session: 'sess-1', message: 'msg-1' },
    })

    expect(result.status).toBe('applied')
    expect(result.memory).toEqual({
      id: recordId(0),
      topic: 'tooling.package-manager',
      statement: '统一用 pnpm 安装依赖',
      rationale: 'lockfile 一致',
      confidence: DEFAULT_CONFIDENCE,
      source: { session: 'sess-1', message: 'msg-1' },
      createdAt: ISO,
      updatedAt: ISO,
      version: 1,
      supersedes: null,
      validFrom: ISO,
    })
    expect(store.active.size).toBe(1)

    const body = store.bodies.get(`tooling.package-manager/${recordId(0)}`)
    expect(body).toContain('# 统一用 pnpm 安装依赖')
    expect(body).toContain('## 理由')
    expect(body).toContain('lockfile 一致')

    expect(store.journal).toHaveLength(1)
    expect(store.journal[0]).toMatchObject({
      action: 'upsert',
      topic: 'tooling.package-manager',
      id: recordId(0),
      at: ISO,
    })

    // 无同 topic active 时才做跨 topic 近似检查。
    expect(search.calls).toHaveLength(1)
    expect((await service.get('tooling.package-manager', recordId(0)))?.statement).toBe(
      '统一用 pnpm 安装依赖',
    )
  })

  it('未给 rationale 时正文不包含理由小节，confidence 可覆盖', async () => {
    const { store, service } = harness()

    const result = await service.upsert({
      topic: 'tooling.editor',
      statement: '统一用 vscode',
      confidence: 0.65,
    })

    expect(result.status).toBe('applied')
    expect(result.memory?.confidence).toBe(0.65)
    expect(result.memory?.rationale).toBeUndefined()
    const body = store.bodies.get(`tooling.editor/${recordId(0)}`)
    expect(body).not.toContain('## 理由')
  })

  it('topic 语法不合法返回 invalid_topic 且不写任何东西', async () => {
    const { store, service } = harness()

    const result = await service.upsert({ topic: 'Bad Topic', statement: '统一用 pnpm' })

    expect(result.status).toBe('invalid_topic')
    expect(result.message).toContain('topic')
    expect(store.active.size).toBe(0)
    expect(store.pendingChanges.size).toBe(0)
    expect(store.journal).toHaveLength(0)
  })

  it('自由主题首次写入即创建，并保存 topicLabel', async () => {
    const { store, service } = harness()

    const result = await service.upsert({
      topic: 'identity.role',
      topicLabel: '角色',
      statement: '用户是软件开发工程师',
    })

    expect(result.status).toBe('applied')
    expect(result.memory?.topicLabel).toBe('角色')
    expect(store.active.size).toBe(1)
  })

  it('归一化后为空返回 rejected 且不落盘', async () => {
    const { store, service } = harness()

    const result = await service.upsert({
      topic: 'tooling.package-manager',
      statement: '   。。。！  ',
    })

    expect(result.status).toBe('rejected')
    expect(result.message).toBeTruthy()
    expect(store.active.size).toBe(0)
    expect(store.journal).toHaveLength(0)
  })

  it('同 topic 同陈述（仅空白/标点差异）返回 unchanged', async () => {
    const { store, service } = harness()

    const first = await service.upsert({
      topic: 'tooling.package-manager',
      statement: '统一用 pnpm。',
    })
    const again = await service.upsert({
      topic: 'tooling.package-manager',
      statement: '  统一用   pnpm！！！ ',
    })

    expect(first.status).toBe('applied')
    expect(again.status).toBe('unchanged')
    expect(again.memory?.id).toBe(first.memory?.id)
    expect(store.active.size).toBe(1)
    expect(store.journal).toHaveLength(1)
  })

  it('同 topic 不同陈述进入 conflict pending，active 不动', async () => {
    const { store, service } = harness()

    const first = await service.upsert({
      topic: 'tooling.package-manager',
      statement: '统一用 pnpm',
    })
    const result = await service.upsert({
      topic: 'tooling.package-manager',
      statement: '统一用 npm',
    })

    expect(result.status).toBe('pending_review')
    const change = result.change
    expect(change).toBeDefined()
    expect(change?.changeId).toMatch(/^chg_[0-9a-f]{16}$/)
    expect(change?.kind).toBe('conflict')
    expect(change?.topic).toBe('tooling.package-manager')
    expect(change?.current).toEqual(first.memory)
    expect(change?.proposed).toEqual({ statement: '统一用 npm', confidence: DEFAULT_CONFIDENCE })
    expect(change?.createdAt).toBe(ISO)

    expect(store.pendingChanges.size).toBe(1)
    expect(store.active.size).toBe(1)
    expect((await service.get('tooling.package-manager', first.memory!.id))?.statement).toBe(
      '统一用 pnpm',
    )
    expect(store.journal.at(-1)).toMatchObject({
      action: 'upsert',
      topic: 'tooling.package-manager',
      changeId: change?.changeId,
    })
  })

  it('pending 中已有相同 idempotencyKey 时原样返回原 change', async () => {
    const { store, service } = harness()

    await service.upsert({ topic: 'tooling.package-manager', statement: '统一用 pnpm' })
    const conflict = await service.upsert({
      topic: 'tooling.package-manager',
      statement: '统一用 npm',
      idempotencyKey: 'turn-42',
    })
    const again = await service.upsert({
      topic: 'tooling.package-manager',
      statement: '统一用 yarn',
      idempotencyKey: 'turn-42',
    })

    expect(conflict.status).toBe('pending_review')
    expect(again.status).toBe('pending_review')
    expect(again.change?.changeId).toBe(conflict.change?.changeId)
    expect(again.change?.proposed.statement).toBe('统一用 npm')
    expect(store.pendingChanges.size).toBe(1)
    expect(store.journal).toHaveLength(2)
  })

  it('pending 存进了 idempotencyKey 便于日后重放', async () => {
    const { service } = harness()

    await service.upsert({ topic: 'tooling.package-manager', statement: '统一用 pnpm' })
    const result = await service.upsert({
      topic: 'tooling.package-manager',
      statement: '统一用 npm',
      idempotencyKey: 'turn-7',
    })

    expect(result.change?.idempotencyKey).toBe('turn-7')
  })

  it('检索候选按文本相似度判定：分数很低但陈述相同也算可能重复', async () => {
    const { search, service } = harness()
    search.hits = [
      {
        id: 'mem_elsewhere',
        topic: 'tooling.package-manager',
        // 索引里存的是渲染后的正文，判定前要剥掉 Markdown 标题。
        statement: '# 统一用 pnpm\n\n## 理由\n\nlockfile 一致',
        score: 0.1,
      },
    ]

    const result = await service.upsert({
      topic: 'tooling.runtime',
      statement: '统一用 pnpm',
    })

    expect(result.status).toBe('pending_review')
    expect(result.change?.kind).toBe('possible-duplicate')
    expect(result.change?.topic).toBe('tooling.runtime')
    expect(result.change?.current).toBeNull()
    expect(result.change?.proposed.statement).toBe('统一用 pnpm')
    expect(search.calls).toEqual([{ query: '统一用 pnpm', options: { limit: 3 } }])
  })

  it('检索分数很高但文本不相似时不判重复（分数不再是门槛）', async () => {
    const { search, service } = harness()
    search.hits = [
      { id: 'mem_x', topic: 'code.testing', statement: '统一用 vitest', score: 0.99 },
    ]

    const result = await service.upsert({ topic: 'tooling.runtime', statement: '统一用 Node 22' })

    expect(result.status).toBe('applied')
    expect(result.memory?.version).toBe(1)
  })

  it('本地相似度达到阈值即判可能重复，且不依赖检索分数', async () => {
    const { search, service } = harness()
    const base = '统一用 pnpm 安装依赖'
    const variant = '统一用 pnpm 安装依赖（推荐）'
    expect(statementSimilarity(variant, base)).toBeGreaterThanOrEqual(LOCAL_DUPLICATE_SIMILARITY)

    await service.upsert({ topic: 'tooling.package-manager', statement: base })
    search.hits = []

    const result = await service.upsert({ topic: 'tooling.runtime', statement: variant })

    expect(result.status).toBe('pending_review')
    expect(result.change?.kind).toBe('possible-duplicate')
    expect(result.change?.current).toBeNull()
    expect(result.change?.proposed.statement).toBe(variant)
  })

  it('近似命中同 topic 时不进入 pending（同 topic 由冲突分支处理）', async () => {
    const { search, service } = harness()
    search.hits = [
      { id: 'mem_x', topic: 'tooling.runtime', statement: '用 Node 20', score: 0.99 },
    ]

    const result = await service.upsert({ topic: 'tooling.runtime', statement: '统一用 Node 22' })

    expect(result.status).toBe('applied')
  })

  it('近似命中同 topic 时不进入 pending（同 topic 由冲突分支处理）', async () => {
    const { search, service } = harness()
    search.hits = [
      { id: 'mem_x', topic: 'tooling.runtime', statement: '用 Node 20', score: 0.99 },
    ]

    const result = await service.upsert({ topic: 'tooling.runtime', statement: '统一用 Node 22' })

    expect(result.status).toBe('applied')
  })

  it('检索故障不阻塞写入', async () => {
    const { search, service } = harness()
    search.failWith = new Error('AI Search unavailable')

    const result = await service.upsert({ topic: 'tooling.runtime', statement: '统一用 Node 22' })

    expect(result.status).toBe('applied')
  })

  it('本地兜底：索引滞后时跨 topic 归一化相同陈述进入 possible-duplicate pending', async () => {
    const { store, search, service } = harness()

    const first = await service.upsert({
      topic: 'tooling.package-manager',
      statement: '统一用 pnpm。',
    })
    // 索引尚未同步：AI Search 对新写入记录不可见。
    search.hits = []
    const searchCallsBefore = search.calls.length

    const result = await service.upsert({
      topic: 'tooling.runtime',
      statement: '  统一用   pnpm！！！ ',
    })

    expect(result.status).toBe('pending_review')
    expect(result.change?.kind).toBe('possible-duplicate')
    expect(result.change?.topic).toBe('tooling.runtime')
    expect(result.change?.current).toBeNull()
    expect(result.change?.proposed.statement).toBe('统一用 pnpm')
    // 本地已命中时不再调用 AI Search（省一次检索）。
    expect(search.calls).toHaveLength(searchCallsBefore)
    expect(store.active.size).toBe(1)
    expect(store.active.has(`tooling.package-manager/${first.memory!.id}`)).toBe(true)
    expect(store.journal.at(-1)).toMatchObject({
      action: 'upsert',
      topic: 'tooling.runtime',
      changeId: result.change?.changeId,
    })
    expect(store.journal.at(-1)?.detail).toContain('本地')
    expect(store.journal.at(-1)?.detail).toContain(first.memory!.id)
  })

  it('本地兜底：陈述不同或同 topic 时不进入 possible-duplicate', async () => {
    const { store, search, service } = harness()

    await service.upsert({ topic: 'tooling.package-manager', statement: '统一用 pnpm' })
    search.hits = []

    // 同 topic 相同陈述：unchanged（不是 possible-duplicate）。
    const sameTopic = await service.upsert({
      topic: 'tooling.package-manager',
      statement: '统一用 pnpm！',
    })
    // 跨 topic 但陈述不同：applied。
    const otherStatement = await service.upsert({
      topic: 'tooling.runtime',
      statement: '统一用 Node 22',
    })

    expect(sameTopic.status).toBe('unchanged')
    expect(otherStatement.status).toBe('applied')
    expect(store.pendingChanges.size).toBe(0)
    expect(store.active.size).toBe(2)
  })

  it('默认依赖生成 mem_ + 16 hex 的 id', async () => {
    const service = createMemoryService({
      store: new FakeStore(),
      search: new FakeSearch(),
    })

    const result = await service.upsert({
      topic: 'tooling.package-manager',
      statement: '统一用 pnpm',
    })

    expect(result.status).toBe('applied')
    expect(result.memory?.id).toMatch(/^mem_[0-9a-f]{16}$/)
  })

  it('相同 idempotencyKey 但已 applied 的重复请求返回 unchanged', async () => {
    const { service } = harness()
    const input = {
      topic: 'tooling.package-manager',
      statement: '统一用 pnpm',
      idempotencyKey: 'turn-1',
    }

    const first = await service.upsert(input)
    const again = await service.upsert(input)

    expect(first.status).toBe('applied')
    expect(again.status).toBe('unchanged')
    expect(again.memory?.id).toBe(first.memory?.id)
  })

  it('写入子主题后父主题自动成为分类', async () => {
    const { service } = harness()

    const child = await service.upsert({
      topic: 'identity.role',
      statement: '是软件开发工程师',
    })
    const parent = await service.upsert({ topic: 'identity', statement: '需要中文回答' })

    expect(child.status).toBe('applied')
    expect(parent.status).toBe('applied')

    const summaries = await service.topics()
    expect(summaries.find((item) => item.topic === 'identity')).toMatchObject({
      count: 2,
      directCount: 1,
    })
    expect(summaries.find((item) => item.topic === 'identity.role')).toMatchObject({
      parent: 'identity',
      depth: 1,
    })
  })

  it('approve 保留 proposed 的 topicLabel', async () => {
    const { service } = harness()

    await service.upsert({
      topic: 'identity.role',
      topicLabel: '角色',
      statement: '是软件开发工程师',
    })
    const conflict = await service.upsert({
      topic: 'identity.role',
      topicLabel: '身份',
      statement: '是架构师',
    })
    const result = await service.approve(conflict.change!.changeId)

    expect(result.status).toBe('applied')
    expect(result.memory?.topicLabel).toBe('身份')
  })

  it('分类主题可以容纳多条互不冲突的陈述', async () => {
    const { store, service } = harness()

    // 先写一条细分主题，让 code.style 成为"分类"（有子主题）。
    await service.upsert({ topic: 'code.style.indent', statement: '使用 2 空格缩进' })
    const first = await service.upsert({ topic: 'code.style', statement: '统一用 prettier' })
    const second = await service.upsert({ topic: 'code.style', statement: '注释统一写中文' })

    expect(first.status).toBe('applied')
    expect(second.status).toBe('applied')
    expect(store.active.size).toBe(3)
    expect(store.pendingChanges.size).toBe(0)
  })

  it('细分（叶子）主题仍是槽位：同主题不同陈述进入 conflict pending', async () => {
    const { service } = harness()

    await service.upsert({ topic: 'code.style.indent', statement: '使用 2 空格缩进' })
    const result = await service.upsert({
      topic: 'code.style.indent',
      statement: '使用 tab 缩进',
    })

    expect(result.status).toBe('pending_review')
    expect(result.change?.kind).toBe('conflict')
    expect(result.change?.topic).toBe('code.style.indent')
    expect(result.change?.current?.statement).toBe('使用 2 空格缩进')
  })

  it('父 / 子主题已有相同陈述时返回 unchanged，不重复落库', async () => {
    const { store, service } = harness()

    const applied = await service.upsert({
      topic: 'code.style.indent',
      statement: '使用 2 空格缩进',
    })
    const fromParent = await service.upsert({
      topic: 'code.style',
      statement: '使用 2 空格缩进！',
    })

    expect(applied.status).toBe('applied')
    expect(fromParent.status).toBe('unchanged')
    expect(fromParent.memory?.id).toBe(applied.memory?.id)
    expect(store.active.size).toBe(1)
  })
})

describe('陈述相似度', () => {
  it('归一化后相同为 1，无关文本接近 0', () => {
    expect(statementSimilarity('统一用 pnpm。', '统一用 pnpm')).toBe(1)
    expect(statementSimilarity('统一用 pnpm', '今天天气不错')).toBeLessThan(0.2)
    expect(statementSimilarity('', '统一用 pnpm')).toBe(0)
  })
})

describe('时间维度与历史', () => {
  it('新记录带 validFrom；forget 后进入历史并带 validTo', async () => {
    const { service } = harness()

    const applied = await service.upsert({ topic: 'identity.role', statement: '是工程师' })
    expect(applied.memory?.validFrom).toBe(ISO)
    expect(applied.memory?.validTo).toBeUndefined()

    const id = applied.memory!.id
    expect(await service.forget('identity.role', id, '测试删除')).toBe(true)

    const archived = await service.history()
    expect(archived).toHaveLength(1)
    expect(archived[0]).toMatchObject({
      id,
      topic: 'identity.role',
      validFrom: ISO,
      validTo: ISO,
      archiveReason: '测试删除',
    })
    expect(await service.history({ topic: 'identity.role' })).toHaveLength(1)
    expect(await service.history({ topic: 'tooling.runtime' })).toHaveLength(0)
  })

  it('history 带 at 时返回该时刻有效的事实', async () => {
    let clock = Date.parse('2026-01-01T00:00:00.000Z')
    const { service } = harness({ now: () => new Date(clock) })

    const oldRole = await service.upsert({ topic: 'identity.role', statement: '旧角色' })
    clock += 1000
    await service.forget('identity.role', oldRole.memory!.id, '换角色')
    clock += 1000
    const newRole = await service.upsert({ topic: 'identity.role', statement: '新角色' })

    const during = await service.history({
      at: new Date(clock - 1500).toISOString(),
    })
    expect(during.map((record) => record.id)).toEqual([oldRole.memory!.id])

    const now = await service.history({ at: new Date(clock + 1).toISOString() })
    expect(now.map((record) => record.id)).toEqual([newRole.memory!.id])
    expect(now[0].validTo).toBeUndefined()
  })

  it('restore 把归档记录恢复为新的现行版本并删除归档', async () => {
    const { store, service } = harness()

    const applied = await service.upsert({ topic: 'identity.role', statement: '是工程师' })
    await service.forget('identity.role', applied.memory!.id, '误删')

    const restored = await service.restore('identity.role', applied.memory!.id)

    expect(restored).not.toBeNull()
    expect(restored?.statement).toBe('是工程师')
    expect(restored?.version).toBe(2)
    expect(restored?.supersedes).toBeNull()
    expect(await service.history()).toHaveLength(0)
    expect((await service.list('identity.role')).map((record) => record.id)).toEqual([
      restored!.id,
    ])
    expect(store.journal.at(-1)).toMatchObject({ action: 'restore', topic: 'identity.role' })
    expect(await service.restore('identity.role', 'mem_missing')).toBeNull()
  })
})

describe('冲突策略', () => {
  it('默认 caller：冲突返回 pending 与模型裁决提示', async () => {
    const { service } = harness()

    await service.upsert({ topic: 'identity.role', statement: '是工程师' })
    const second = await service.upsert({ topic: 'identity.role', statement: '是架构师' })

    expect(second.status).toBe('pending_review')
    expect(second.change?.kind).toBe('conflict')
    expect(second.message).toContain('memory_resolve')
  })

  it('server：直接覆盖，旧版进 history 且可 restore', async () => {
    const { store, service } = harness({ service: { conflictPolicy: 'server' } })

    const first = await service.upsert({ topic: 'identity.role', statement: '是工程师' })
    const second = await service.upsert({ topic: 'identity.role', statement: '是架构师' })

    expect(second.status).toBe('applied')
    expect(second.autoApplied).toBe(true)
    expect(second.memory?.version).toBe(2)
    expect(second.memory?.supersedes).toBe(first.memory!.id)
    expect(store.pendingChanges.size).toBe(0)
    expect(store.history).toHaveLength(1)
  })

  it('manual：默认队列，等待人工 approve / reject', async () => {
    const { service } = harness({ service: { conflictPolicy: 'manual' } })

    await service.upsert({ topic: 'identity.role', statement: '是工程师' })
    const second = await service.upsert({ topic: 'identity.role', statement: '是架构师' })

    expect(second.status).toBe('pending_review')
    expect(second.message).toContain('人工')
  })

  it('server 模式下疑似重复跳过写入并记 journal', async () => {
    const { store, service } = harness({ service: { conflictPolicy: 'server' } })

    const first = await service.upsert({
      topic: 'tooling.package-manager',
      statement: '统一用 pnpm 安装依赖',
    })
    const duplicate = await service.upsert({
      topic: 'tooling.runtime',
      statement: '统一用 pnpm 安装依赖（推荐）',
    })

    expect(duplicate.status).toBe('unchanged')
    expect(duplicate.memory?.id).toBe(first.memory!.id)
    expect(store.pendingChanges.size).toBe(0)
    expect(store.journal.at(-1)).toMatchObject({
      action: 'reject',
      detail: expect.stringContaining('dedupe'),
    })
  })
})

describe('模型裁决 resolve', () => {
  async function conflict(service: ReturnType<typeof createMemoryService>) {
    const current = await service.upsert({ topic: 'identity.role', statement: '是工程师' })
    const pending = await service.upsert({ topic: 'identity.role', statement: '是架构师' })
    return { current, changeId: pending.change!.changeId }
  }

  it('replace：提议取代现行，旧版进 history', async () => {
    const { store, service } = harness()
    const { current, changeId } = await conflict(service)

    const result = await service.resolve(changeId, {
      decision: 'replace',
      reason: '用户后来更正了角色',
    })

    expect(result.status).toBe('applied')
    expect(result.resolved).toBe('replace')
    expect(result.memory?.statement).toBe('是架构师')
    expect(result.memory?.version).toBe(2)
    expect(result.memory?.supersedes).toBe(current.memory!.id)
    expect(store.pendingChanges.size).toBe(0)
    expect(store.history).toHaveLength(1)
  })

  it('merge：写入合并陈述并取代现行', async () => {
    const { service } = harness()
    const { changeId } = await conflict(service)

    const result = await service.resolve(changeId, {
      decision: 'merge',
      statement: '是工程师，同时负责架构决策',
      rationale: '两个身份都成立',
    })

    expect(result.status).toBe('applied')
    expect(result.resolved).toBe('merge')
    expect(result.memory?.statement).toBe('是工程师，同时负责架构决策')
    expect(result.memory?.rationale).toBe('两个身份都成立')
  })

  it('merge 缺 statement 时拒绝且 pending 保留', async () => {
    const { store, service } = harness()
    const { changeId } = await conflict(service)

    const result = await service.resolve(changeId, { decision: 'merge' })

    expect(result.status).toBe('rejected')
    expect(store.pendingChanges.has(changeId)).toBe(true)
  })

  it('keep：保留现行、丢弃提议并清空 pending', async () => {
    const { store, service } = harness()
    const { current, changeId } = await conflict(service)

    const result = await service.resolve(changeId, { decision: 'keep', reason: '新说法不准确' })

    expect(result.status).toBe('unchanged')
    expect(result.resolved).toBe('keep')
    expect(result.memory?.id).toBe(current.memory!.id)
    expect(store.pendingChanges.size).toBe(0)
    expect(store.journal.at(-1)).toMatchObject({
      action: 'reject',
      detail: expect.stringContaining('resolve:keep'),
    })
  })

  it('疑似重复也可以裁决：replace 写入新记录', async () => {
    const { service } = harness({ service: { conflictPolicy: 'caller' } })

    await service.upsert({ topic: 'tooling.package-manager', statement: '统一用 pnpm 安装依赖' })
    const pending = await service.upsert({
      topic: 'tooling.runtime',
      statement: '统一用 pnpm 安装依赖（推荐）',
    })

    const result = await service.resolve(pending.change!.changeId, {
      decision: 'replace',
      reason: '确实是同一条，但写到更合适的主题',
    })

    expect(result.status).toBe('applied')
    expect(result.memory?.topic).toBe('tooling.runtime')
  })

  it('变更不存在时返回 rejected', async () => {
    const { service } = harness()
    const result = await service.resolve('chg_missing', { decision: 'keep' })
    expect(result.status).toBe('rejected')
    expect(result.message).toContain('chg_missing')
  })
})

describe('core 常驻召回', () => {
  it('core 前缀的记录排在召回最前并带 core 标记', async () => {
    const { service } = harness({
      service: { coreTopicPrefixes: ['identity'], coreRecallLimit: 2 },
    })

    const role = await service.upsert({ topic: 'identity.role', statement: '是工程师' })
    const language = await service.upsert({
      topic: 'communication.language',
      statement: '用中文回答',
    })
    await service.upsert({ topic: 'tooling.package-manager', statement: '统一用 pnpm' })

    const items = await service.recall('任意', 5)

    expect(items[0]).toMatchObject({ id: role.memory!.id, core: true })
    expect(items.some((item) => item.id === language.memory!.id && item.core !== true)).toBe(true)
    expect(items).toHaveLength(3)
  })
})

describe('MemoryService.approve', () => {
  it('批准 conflict：旧记录入 history，新记录 version+1 且 supersedes 旧 id', async () => {
    const { store, service } = harness()

    const current = await service.upsert({
      topic: 'code.testing.framework',
      statement: '统一用 vitest 写测试',
    })
    const conflict = await service.upsert({
      topic: 'code.testing.framework',
      statement: '测试统一用 jest',
      rationale: 'jest 生态更成熟',
    })
    const changeId = conflict.change!.changeId

    const result = await service.approve(changeId)

    expect(result.status).toBe('applied')
    // 第一个 upsert 用掉 id 0，conflict 的 changeId 用掉 token 1，批准后用 token 2。
    expect(result.memory).toEqual({
      id: recordId(2),
      topic: 'code.testing.framework',
      statement: '测试统一用 jest',
      rationale: 'jest 生态更成熟',
      confidence: DEFAULT_CONFIDENCE,
      createdAt: ISO,
      updatedAt: ISO,
      version: 2,
      supersedes: current.memory!.id,
      validFrom: ISO,
    })

    expect(store.history).toHaveLength(1)
    expect(store.history[0].record.id).toBe(current.memory!.id)
    expect(store.history[0].reason).toContain(changeId)

    expect(store.pendingChanges.size).toBe(0)
    expect(await service.get('code.testing.framework', current.memory!.id)).toBeNull()
    expect(await service.get('code.testing.framework', result.memory!.id)).not.toBeNull()
    expect(store.journal.at(-1)).toMatchObject({
      action: 'apply',
      topic: 'code.testing.framework',
      id: result.memory!.id,
      changeId,
    })
  })

  it('批准 possible-duplicate：无 current 时写 version 1 且不产生 history', async () => {
    const { store, search, service } = harness()
    search.hits = [
      {
        id: 'mem_elsewhere',
        topic: 'tooling.package-manager',
        statement: '# 统一用 Node 22',
        score: 0.2,
      },
    ]

    const pending = await service.upsert({
      topic: 'tooling.runtime',
      statement: '统一用 Node 22',
    })
    const result = await service.approve(pending.change!.changeId)

    expect(result.status).toBe('applied')
    expect(result.memory?.version).toBe(1)
    expect(result.memory?.supersedes).toBeNull()
    expect(store.history).toHaveLength(0)
    expect(store.active.size).toBe(1)
    expect(store.pendingChanges.size).toBe(0)
  })

  it('变更不存在时返回 rejected', async () => {
    const { service } = harness()

    const result = await service.approve('chg_missing')

    expect(result.status).toBe('rejected')
    expect(result.message).toContain('chg_missing')
  })
})

describe('MemoryService.approve 失败语义', () => {
  /** 造一条 conflict pending：current=旧的 vitest，proposed=新的 jest。 */
  async function conflictPending(): Promise<{
    store: FakeStore
    service: ReturnType<typeof createMemoryService>
    currentId: string
    changeId: string
  }> {
    const { store, service } = harness()
    const current = await service.upsert({
      topic: 'code.testing.framework',
      statement: '统一用 vitest 写测试',
    })
    const conflict = await service.upsert({
      topic: 'code.testing.framework',
      statement: '测试统一用 jest',
    })
    return {
      store,
      service,
      currentId: current.memory!.id,
      changeId: conflict.change!.changeId,
    }
  }

  it('putActive 失败：抛错，旧记录与 pending 原样保留', async () => {
    const { store, service, currentId, changeId } = await conflictPending()
    store.failPutActiveWith = new Error('R2 putActive failed')

    await expect(service.approve(changeId)).rejects.toThrow('R2 putActive failed')

    expect(store.active.size).toBe(1)
    expect(store.active.has(`code.testing.framework/${currentId}`)).toBe(true)
    expect(store.history).toHaveLength(0)
    expect(store.pendingChanges.has(changeId)).toBe(true)
    expect(store.journal.some((event) => event.action === 'apply')).toBe(false)
  })

  it('新记录写入后 moveToHistory 失败：抛错，但新记录已生效（不丢记忆）', async () => {
    const { store, service, currentId, changeId } = await conflictPending()
    store.failMoveWith = new Error('R2 moveToHistory failed')

    await expect(service.approve(changeId)).rejects.toThrow('R2 moveToHistory failed')

    const active = await store.listActive('code.testing.framework')
    const applied = active.find((record) => record.statement === '测试统一用 jest')
    // 新记录先落盘：即使移历史失败，新的偏好也已生效。
    expect(applied).toMatchObject({ version: 2, supersedes: currentId })
    // 旧记录仍在 active（没有丢），pending 保留，也没有写 apply journal。
    expect(active.some((record) => record.id === currentId)).toBe(true)
    expect(store.history).toHaveLength(0)
    expect(store.pendingChanges.has(changeId)).toBe(true)
    expect(store.journal.some((event) => event.action === 'apply')).toBe(false)
  })

  it('移历史失败后重试：复用已写入的新记录，不产生重复版本', async () => {
    const { store, service, currentId, changeId } = await conflictPending()
    store.failMoveWith = new Error('R2 moveToHistory failed')
    await expect(service.approve(changeId)).rejects.toThrow('R2 moveToHistory failed')
    const appliedId = (await store.listActive('code.testing.framework')).find(
      (record) => record.statement === '测试统一用 jest',
    )!.id

    store.failMoveWith = null
    const retried = await service.approve(changeId)

    expect(retried.status).toBe('applied')
    expect(retried.memory?.id).toBe(appliedId)
    // 只有一条新版本 active，旧版进 history，pending 清空。
    expect(store.active.size).toBe(1)
    expect(store.active.has(`code.testing.framework/${appliedId}`)).toBe(true)
    expect(store.history.map((entry) => entry.record.id)).toEqual([currentId])
    expect(store.pendingChanges.size).toBe(0)
    expect(store.journal.filter((event) => event.action === 'apply')).toHaveLength(1)
  })

  it('deletePending 失败后重试：同样复用新记录，不重复写入', async () => {
    const { store, service, changeId } = await conflictPending()
    store.failDeletePendingOnce = new Error('R2 deletePending failed')

    await expect(service.approve(changeId)).rejects.toThrow('R2 deletePending failed')
    expect(store.pendingChanges.has(changeId)).toBe(true)

    const retried = await service.approve(changeId)

    expect(retried.status).toBe('applied')
    expect(store.active.size).toBe(1)
    expect(store.pendingChanges.size).toBe(0)
    expect(store.history).toHaveLength(1)
  })
})

describe('MemoryService.reject', () => {
  it('删除 pending、保留 active 并记 journal reject', async () => {
    const { store, service } = harness()

    const current = await service.upsert({
      topic: 'tooling.package-manager',
      statement: '统一用 pnpm',
    })
    const conflict = await service.upsert({
      topic: 'tooling.package-manager',
      statement: '统一用 npm',
    })
    const changeId = conflict.change!.changeId

    expect(await service.reject(changeId, '旧规则优先')).toBe(true)

    expect(store.pendingChanges.size).toBe(0)
    expect(store.active.size).toBe(1)
    expect((await service.get('tooling.package-manager', current.memory!.id))?.statement).toBe(
      '统一用 pnpm',
    )
    expect(store.journal.at(-1)).toMatchObject({
      action: 'reject',
      topic: 'tooling.package-manager',
      changeId,
      detail: '旧规则优先',
    })
  })

  it('变更不存在时返回 false', async () => {
    const { service } = harness()
    expect(await service.reject('chg_missing', '无')).toBe(false)
  })
})

describe('MemoryService.forget', () => {
  it('存在则移入 history、记 journal 并返回 true', async () => {
    const { store, service } = harness()

    const applied = await service.upsert({
      topic: 'tooling.editor',
      statement: '统一用 vscode',
    })
    const id = applied.memory!.id

    expect(await service.forget('tooling.editor', id, '用户要求删除')).toBe(true)

    expect(store.active.size).toBe(0)
    expect(store.history).toHaveLength(1)
    expect(store.history[0].record.id).toBe(id)
    expect(store.journal.at(-1)).toMatchObject({
      action: 'forget',
      topic: 'tooling.editor',
      id,
      detail: '用户要求删除',
    })
    expect(await service.forget('tooling.editor', id, 'again')).toBe(false)
  })
})

describe('MemoryService 查询面', () => {
  it('get / list 透传 store', async () => {
    const { service } = harness()

    const pnpm = await service.upsert({
      topic: 'tooling.package-manager',
      statement: '统一用 pnpm',
    })
    await service.upsert({ topic: 'code.testing', statement: '统一用 vitest' })

    expect(await service.list()).toHaveLength(2)
    expect(await service.list('tooling.package-manager')).toHaveLength(1)
    expect(await service.get('tooling.package-manager', pnpm.memory!.id)).toEqual(pnpm.memory)
    expect(await service.get('tooling.package-manager', 'mem_missing')).toBeNull()
  })

  it('search 默认 limit、topic 过滤与非法 limit', async () => {
    const { search, service } = harness()
    search.hits = [
      { id: 'hit-1', topic: 'tooling.package-manager', statement: '统一用 pnpm', score: 0.9 },
    ]

    expect(await service.search('pnpm')).toHaveLength(1)
    expect(search.calls.at(-1)).toEqual({ query: 'pnpm', options: { limit: DEFAULT_SEARCH_LIMIT } })

    await service.search('pnpm', { limit: 3 })
    expect(search.calls.at(-1)).toEqual({ query: 'pnpm', options: { limit: 3 } })

    await service.search('pnpm', { limit: 3, topic: 'tooling.package-manager' })
    expect(search.calls.at(-1)).toEqual({
      query: 'pnpm',
      options: { limit: 3, topic: 'tooling.package-manager' },
    })

    expect(await service.search('pnpm', { limit: 0 })).toEqual([])
  })

  it('topics 由数据推导：主题、标签、层级与子树计数', async () => {
    const { service } = harness()

    await service.upsert({ topic: 'tooling.package-manager', statement: '统一用 pnpm' })
    await service.upsert({
      topic: 'code.testing.framework',
      topicLabel: '框架',
      statement: '统一用 vitest',
    })
    await service.upsert({ topic: 'code.testing', statement: '测试先写失败用例' })

    const summaries = await service.topics()

    expect(summaries.map((item) => item.topic)).toEqual([
      'code.testing',
      'code.testing.framework',
      'tooling.package-manager',
    ])
    expect(summaries.find((item) => item.topic === 'tooling.package-manager')).toEqual({
      topic: 'tooling.package-manager',
      label: '包管理器',
      description: 'pnpm / npm / yarn 的选择、lockfile 与依赖安装习惯',
      parent: null,
      depth: 1,
      count: 1,
      directCount: 1,
    })
    expect(summaries.find((item) => item.topic === 'code.testing')).toMatchObject({
      parent: null,
      depth: 1,
      count: 2,
      directCount: 1,
    })
    expect(summaries.find((item) => item.topic === 'code.testing.framework')).toMatchObject({
      label: '框架',
      parent: 'code.testing',
      depth: 2,
      count: 1,
      directCount: 1,
    })
  })

  it('list 父主题返回整棵子树', async () => {
    const { service } = harness()

    await service.upsert({ topic: 'code.style.indent', statement: '使用 2 空格缩进' })
    await service.upsert({ topic: 'code.style', statement: '统一用 prettier' })
    await service.upsert({ topic: 'tooling.package-manager', statement: '统一用 pnpm' })

    const style = await service.list('code.style')
    expect(style.map((record) => record.topic).sort()).toEqual([
      'code.style',
      'code.style.indent',
    ])
    expect(await service.list('code.style.indent')).toHaveLength(1)
  })

  it('search 分类主题在子树内过滤并截断', async () => {
    const { search, service } = harness()
    // 先让 code.style 成为分类（数据里有子主题）。
    await service.upsert({ topic: 'code.style.indent', statement: '使用 2 空格缩进' })
    search.hits = [
      { id: 'hit-a', topic: 'code.style.indent', statement: '使用 2 空格缩进', score: 0.9 },
      { id: 'hit-b', topic: 'code.style.comment', statement: '注释写中文', score: 0.8 },
      { id: 'hit-c', topic: 'tooling.package-manager', statement: '统一用 pnpm', score: 0.7 },
    ]

    const hits = await service.search('风格', { limit: 2, topic: 'code.style' })

    expect(hits.map((hit) => hit.id)).toEqual(['hit-a', 'hit-b'])
    // 分类主题不能下推到索引过滤，先放大取回数量（max*5 与 max+10 取大，上限 200）。
    expect(search.calls.at(-1)).toEqual({ query: '风格', options: { limit: 12 } })
  })

  it('pending 返回待裁决列表', async () => {
    const { service } = harness()

    await service.upsert({ topic: 'tooling.package-manager', statement: '统一用 pnpm' })
    await service.upsert({ topic: 'tooling.package-manager', statement: '统一用 npm' })

    const pending = await service.pending()
    expect(pending).toHaveLength(1)
    expect(pending[0].kind).toBe('conflict')
  })
})

describe('MemoryService.recall', () => {
  it('检索命中按 R2 水合成最新陈述，再合并 recent 并按 id 去重', async () => {
    const { search, service } = harness()
    const pnpm = (
      await service.upsert({ topic: 'tooling.package-manager', statement: '统一用 pnpm' })
    ).memory!
    const vitest = (
      await service.upsert({ topic: 'code.testing', statement: '统一用 vitest' })
    ).memory!

    // 索引里是同一 id 的旧文本：召回必须用 R2 的最新 statement。
    search.hits = [
      { id: pnpm.id, topic: pnpm.topic, statement: 'pnpm 旧文本', score: 0.92 },
    ]

    const merged = await service.recall('pnpm', 5)

    expect(merged).toEqual([
      { id: pnpm.id, topic: pnpm.topic, statement: '统一用 pnpm' },
      { id: vitest.id, topic: vitest.topic, statement: '统一用 vitest' },
    ])
  })

  it('命中已删除或不存在时丢弃，不把旧版本带回召回结果', async () => {
    const { search, service } = harness()
    const kept = (await service.upsert({ topic: 'tooling.editor', statement: '统一用 vscode' }))
      .memory!
    const gone = (await service.upsert({ topic: 'code.testing', statement: '统一用 vitest' }))
      .memory!
    expect(await service.forget('code.testing', gone.id, '用户要求删除')).toBe(true)

    search.hits = [
      { id: gone.id, topic: gone.topic, statement: gone.statement, score: 0.9 },
      { id: 'mem_missing', topic: 'code.style', statement: '索引幽灵记录', score: 0.8 },
    ]

    const items = await service.recall('vitest', 5)

    expect(items).toEqual([{ id: kept.id, topic: kept.topic, statement: kept.statement }])
  })

  it('limit 截断，limit <= 0 返回空', async () => {
    const { service } = harness()
    await service.upsert({ topic: 'tooling.package-manager', statement: '统一用 pnpm' })
    await service.upsert({ topic: 'code.testing', statement: '统一用 vitest' })

    expect(await service.recall('任何', 1)).toHaveLength(1)
    expect(await service.recall('任何', 0)).toEqual([])
  })

  it('检索故障时退化为 recent 兜底', async () => {
    const { search, service } = harness()
    const applied = await service.upsert({
      topic: 'tooling.package-manager',
      statement: '统一用 pnpm',
    })
    search.failWith = new Error('AI Search unavailable')

    const items = await service.recall('pnpm', 3)
    expect(items.map((item) => item.id)).toEqual([applied.memory!.id])
  })
})

describe('MemoryService.extract', () => {
  it('逐个 upsert 并透传 source / confidence，返回同序结果', async () => {
    const { store, service } = harness()
    const source = { session: 'sess-9', message: 'msg-9' }

    const results = await service.extract([
      {
        topic: 'tooling.package-manager',
        statement: '统一用 pnpm',
        confidence: 0.9,
        source,
      },
      {
        topic: 'tooling.package-manager',
        statement: '统一用 npm',
        confidence: 0.75,
      },
      {
        topic: 'Bad Topic',
        statement: '未知主题',
        confidence: 0.6,
      },
    ])

    expect(results.map((item) => item.status)).toEqual([
      'applied',
      'pending_review',
      'invalid_topic',
    ])
    expect(results[0].memory?.source).toEqual(source)
    expect(results[0].memory?.confidence).toBe(0.9)
    expect(results[1].change?.kind).toBe('conflict')

    expect(store.active.size).toBe(1)
    expect(store.pendingChanges.size).toBe(1)
  })

  it('空候选数组返回空结果', async () => {
    const { service } = harness()
    expect(await service.extract([])).toEqual([])
  })
})

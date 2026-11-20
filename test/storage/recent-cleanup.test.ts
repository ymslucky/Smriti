import { afterEach, describe, expect, it, vi } from 'vitest'

import { serializeBody } from '../../src/storage/body'
import { createR2Store } from '../../src/storage/r2-store'
import type { MemoryRecord } from '../../src/types'
import { FakeR2 } from '../support/fake-r2'

const TOPIC = 'communication.format'
const RECENT_KEY = 'memories/_index/recent.json'

function makeRecord(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: 'mem-1',
    topic: TOPIC,
    statement: '回答保持简洁。',
    confidence: 0.9,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    version: 1,
    ...overrides,
  }
}

async function readJson(bucket: FakeR2, key: string): Promise<unknown> {
  const object = await bucket.get(key)
  if (object === null) return null
  return JSON.parse(await object.text())
}

describe('recent', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns the latest records from memories/_index/recent.json', async () => {
    const bucket = new FakeR2()
    const store = createR2Store(bucket)
    const a = makeRecord({ id: 'a', updatedAt: '2026-03-01T00:00:00.000Z' })
    const b = makeRecord({ id: 'b', updatedAt: '2026-03-02T00:00:00.000Z' })
    const c = makeRecord({ id: 'c', updatedAt: '2026-03-03T00:00:00.000Z' })
    for (const record of [a, b, c]) {
      await store.putActive(record, serializeBody(record))
    }

    const latest = await store.recent(2)
    expect(latest.map((record) => record.id)).toEqual(['c', 'b'])

    const index = (await readJson(bucket, RECENT_KEY)) as unknown[]
    expect(index).toHaveLength(3)
    expect(index[0]).toMatchObject({
      id: 'c',
      topic: TOPIC,
      updatedAt: '2026-03-03T00:00:00.000Z',
    })
  })

  it('moves an updated record to the front instead of duplicating it', async () => {
    const bucket = new FakeR2()
    const store = createR2Store(bucket)
    const a1 = makeRecord({ id: 'a', updatedAt: '2026-03-01T00:00:00.000Z' })
    const b = makeRecord({ id: 'b', updatedAt: '2026-03-02T00:00:00.000Z' })
    const a2 = makeRecord({ id: 'a', updatedAt: '2026-03-03T00:00:00.000Z' })
    for (const record of [a1, b, a2]) {
      await store.putActive(record, serializeBody(record))
    }

    const index = (await readJson(bucket, RECENT_KEY)) as { id: string }[]
    expect(index.map((entry) => entry.id)).toEqual(['a', 'b'])
    expect((await store.recent(2)).map((record) => record.id)).toEqual(['a', 'b'])
  })

  it('keeps at most 50 entries in the recent index', async () => {
    const bucket = new FakeR2()
    const store = createR2Store(bucket)
    for (let i = 0; i < 55; i += 1) {
      const record = makeRecord({
        id: `m-${String(i).padStart(2, '0')}`,
        updatedAt: `2026-03-01T00:00:${String(i).padStart(2, '0')}.000Z`,
      })
      await store.putActive(record, serializeBody(record))
    }

    const index = (await readJson(bucket, RECENT_KEY)) as unknown[]
    expect(index).toHaveLength(50)
    const recent = await store.recent(100)
    expect(recent).toHaveLength(50)
    expect(recent[0]?.id).toBe('m-54')
  })

  it('falls back to listActive sorted by updatedAt when the index is missing or corrupt', async () => {
    const bucket = new FakeR2()
    const store = createR2Store(bucket)
    const a = makeRecord({ id: 'a', updatedAt: '2026-03-01T00:00:00.000Z' })
    const b = makeRecord({ id: 'b', updatedAt: '2026-03-02T00:00:00.000Z' })
    for (const record of [a, b]) {
      await store.putActive(record, serializeBody(record))
    }

    await bucket.delete(RECENT_KEY)
    expect((await store.recent(1)).map((record) => record.id)).toEqual(['b'])
    expect(bucket.has(RECENT_KEY)).toBe(false)

    await bucket.put(RECENT_KEY, 'not-json')
    expect((await store.recent(5)).map((record) => record.id)).toEqual(['b', 'a'])
  })

  it('skips a corrupt record referenced by the recent index instead of failing recall', async () => {
    const bucket = new FakeR2()
    const store = createR2Store(bucket)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const healthy = makeRecord({ id: 'healthy', updatedAt: '2026-03-01T00:00:00.000Z' })
    const corrupt = makeRecord({ id: 'corrupt', updatedAt: '2026-03-02T00:00:00.000Z' })
    await store.putActive(healthy, serializeBody(healthy))
    await store.putActive(corrupt, serializeBody(corrupt))

    // 索引保存了 corrupt 条目；随后对象被写坏（缺 updated_at），parseBody 会抛错。
    const corruptKey = `memories/active/${TOPIC}/corrupt.md`
    await bucket.put(corruptKey, '# broken\n', { customMetadata: { topic: TOPIC } })

    const recent = await store.recent(5)
    expect(recent.map((record) => record.id)).toEqual(['healthy'])
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]?.[0])).toContain(corruptKey)
  })

  it('excludes records that moved to history and ignores non-positive limits', async () => {
    const bucket = new FakeR2()
    const store = createR2Store(bucket)
    const record = makeRecord()
    await store.putActive(record, serializeBody(record))
    expect(await store.recent(1)).toHaveLength(1)

    await store.moveToHistory(TOPIC, record.id, 'forgotten')
    expect(await store.recent(5)).toEqual([])
    expect(await store.recent(0)).toEqual([])
    expect(await store.recent(-3)).toEqual([])
  })
})

describe('cleanupHistory', () => {
  it('deletes only history objects uploaded before the cutoff', async () => {
    let clock = Date.parse('2026-01-01T00:00:00.000Z')
    const bucket = new FakeR2({ now: () => new Date(clock) })
    const store = createR2Store(bucket)

    const oldKey = `memories/_history/${TOPIC}/old.md`
    const newKey = `memories/_history/${TOPIC}/new.md`
    const activeKey = `memories/active/${TOPIC}/live.md`

    await bucket.put(oldKey, '# old\n')
    clock = Date.parse('2026-02-01T00:00:00.000Z')
    await bucket.put(newKey, '# new\n')
    await bucket.put(activeKey, '# live\n')

    const removed = await store.cleanupHistory(new Date('2026-01-15T00:00:00.000Z'))
    expect(removed).toBe(1)
    expect(bucket.has(oldKey)).toBe(false)
    expect(bucket.has(newKey)).toBe(true)
    expect(bucket.has(activeKey)).toBe(true)
  })

  it('does not delete objects uploaded exactly at the cutoff', async () => {
    const uploadedAt = '2026-01-01T00:00:00.000Z'
    const bucket = new FakeR2({ now: () => new Date(uploadedAt) })
    const store = createR2Store(bucket)
    await bucket.put(`memories/_history/${TOPIC}/edge.md`, '# edge\n')

    expect(await store.cleanupHistory(new Date(uploadedAt))).toBe(0)
    expect(await store.cleanupHistory(new Date('2026-01-02T00:00:00.000Z'))).toBe(1)
    expect(bucket.keysWithPrefix('memories/_history/')).toEqual([])
  })

  it('walks every list page when deleting stale history', async () => {
    const bucket = new FakeR2({
      pageSize: 1,
      now: () => new Date('2026-01-01T00:00:00.000Z'),
    })
    const store = createR2Store(bucket)
    for (const id of ['a', 'b', 'c']) {
      await bucket.put(`memories/_history/${TOPIC}/${id}.md`, `# ${id}\n`)
    }

    expect(await store.cleanupHistory(new Date('2026-02-01T00:00:00.000Z'))).toBe(3)
    expect(bucket.keysWithPrefix('memories/_history/')).toEqual([])
  })

  it('rejects an invalid cutoff date', async () => {
    const store = createR2Store(new FakeR2())
    await expect(store.cleanupHistory(new Date('not-a-date'))).rejects.toThrow(/valid Date/)
  })
})

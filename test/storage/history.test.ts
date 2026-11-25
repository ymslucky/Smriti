/** `_history/` 的读取面：moveToHistory 写入时间维度，get/list/delete 可回读。 */

import { describe, expect, it } from 'vitest'

import { serializeBody } from '../../src/storage/body'
import { createR2Store } from '../../src/storage/r2-store'
import type { MemoryRecord } from '../../src/types'
import { FakeR2 } from '../support/fake-r2'

const TOPIC = 'identity.role'

function makeRecord(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: 'mem_old',
    topic: TOPIC,
    statement: '用户是软件开发工程师',
    confidence: 0.9,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    version: 1,
    validFrom: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('history storage', () => {
  it('moveToHistory 记录 valid_to / moved_at / reason，并能读回与删除', async () => {
    const bucket = new FakeR2()
    const store = createR2Store(bucket)
    const record = makeRecord()
    await store.putActive(record, serializeBody(record))

    await store.moveToHistory(TOPIC, record.id, '用户要求删除')

    const archivedKey = `memories/_history/${TOPIC}/${record.id}.md`
    expect(bucket.has(archivedKey)).toBe(true)
    expect(bucket.has(`memories/active/${TOPIC}/${record.id}.md`)).toBe(false)

    const archived = await store.getHistory(TOPIC, record.id)
    expect(archived).toMatchObject({
      id: record.id,
      topic: TOPIC,
      statement: record.statement,
      validFrom: record.validFrom,
      archiveReason: '用户要求删除',
    })
    expect(archived?.validTo).toBeTruthy()
    expect(Number.isNaN(Date.parse(archived?.validTo ?? ''))).toBe(false)
    expect(archived?.archivedAt).toBe(archived?.validTo)

    expect(await store.listHistory()).toHaveLength(1)
    expect(await store.listHistory(TOPIC)).toHaveLength(1)
    expect(await store.listHistory('tooling.runtime')).toHaveLength(0)

    await store.deleteHistory(TOPIC, record.id)
    expect(bucket.has(archivedKey)).toBe(false)
    expect(await store.getHistory(TOPIC, record.id)).toBeNull()
  })

  it('老记录缺少 valid_from 时用 created_at 兜底', async () => {
    const bucket = new FakeR2()
    const store = createR2Store(bucket)
    const record = makeRecord({ validFrom: undefined })
    await store.putActive(record, serializeBody(record))

    await store.moveToHistory(TOPIC, record.id, '清理')

    const archived = await store.getHistory(TOPIC, record.id)
    expect(archived?.validFrom).toBe(record.createdAt)
    expect(archived?.validTo).toBeTruthy()
  })
})

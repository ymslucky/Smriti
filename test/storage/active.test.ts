import { afterEach, describe, expect, it, vi } from 'vitest'

import { serializeBody } from '../../src/storage/body'
import { createR2Store } from '../../src/storage/r2-store'
import type { MemoryRecord } from '../../src/types'
import { FakeR2 } from '../support/fake-r2'

const TOPIC = 'tooling.package-manager'
const OTHER_TOPIC = 'workflow.git'

function makeRecord(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: 'mem-1',
    topic: TOPIC,
    statement: 'Prefer pnpm.',
    confidence: 0.9,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    version: 1,
    ...overrides,
  }
}

describe('active memories', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('writes and reads a record round-trip at memories/active/{topic}/{id}.md', async () => {
    const bucket = new FakeR2()
    const store = createR2Store(bucket)
    const record = makeRecord({ version: 3, rationale: '保证 lockfile 一致。' })
    const body = serializeBody(record)

    await store.putActive(record, body)

    const key = `memories/active/${TOPIC}/${record.id}.md`
    expect(bucket.has(key)).toBe(true)
    const object = await bucket.get(key)
    expect(object).not.toBeNull()
    expect(object?.customMetadata).toMatchObject({
      topic: TOPIC,
      // P1-1 起 updated_at 落盘为 epoch 毫秒字符串，读回时才还原为 ISO。
      updated_at: String(Date.parse(record.updatedAt)),
      version: '3',
    })
    expect(await object?.text()).toBe(body)
    expect(await store.getActive(TOPIC, record.id)).toEqual(record)
  })

  it('returns null for an unknown record', async () => {
    const store = createR2Store(new FakeR2())
    expect(await store.getActive(TOPIC, 'missing')).toBeNull()
  })

  it('lists only the requested topic, and lists all topics without an argument', async () => {
    const store = createR2Store(new FakeR2())
    const a = makeRecord({ id: 'a' })
    const b = makeRecord({ id: 'b', updatedAt: '2026-01-03T00:00:00.000Z' })
    const other = makeRecord({ id: 'c', topic: OTHER_TOPIC })
    await store.putActive(a, serializeBody(a))
    await store.putActive(b, serializeBody(b))
    await store.putActive(other, serializeBody(other))

    const topicOnly = await store.listActive(TOPIC)
    expect(topicOnly.map((record) => record.id).sort()).toEqual(['a', 'b'])

    const all = await store.listActive()
    expect(all.map((record) => record.id).sort()).toEqual(['a', 'b', 'c'])
    expect(all.find((record) => record.id === 'c')?.topic).toBe(OTHER_TOPIC)
  })

  it('paginates R2 list results when reading active records', async () => {
    const bucket = new FakeR2({ pageSize: 1 })
    const store = createR2Store(bucket)
    for (const id of ['a', 'b', 'c']) {
      const record = makeRecord({ id })
      await store.putActive(record, serializeBody(record))
    }
    const records = await store.listActive(TOPIC)
    expect(records.map((record) => record.id).sort()).toEqual(['a', 'b', 'c'])
  })

  it('skips one corrupt object, warns with its key, and still lists the healthy records', async () => {
    const bucket = new FakeR2()
    const store = createR2Store(bucket)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const a = makeRecord({ id: 'a' })
    const b = makeRecord({ id: 'b', updatedAt: '2026-01-03T00:00:00.000Z' })
    await store.putActive(a, serializeBody(a))
    await store.putActive(b, serializeBody(b))

    // 直接写入一个缺 updated_at 的对象：readActiveObject -> parseBody 会抛错。
    const corruptKey = `memories/active/${TOPIC}/corrupt.md`
    await bucket.put(corruptKey, '# broken\n', {
      customMetadata: { topic: TOPIC, version: '1' },
    })

    const all = await store.listActive()
    expect(all.map((record) => record.id).sort()).toEqual(['a', 'b'])
    const topicOnly = await store.listActive(TOPIC)
    expect(topicOnly.map((record) => record.id).sort()).toEqual(['a', 'b'])

    // 每次列表都会跳过并告警一次，且告警带上损坏对象的 key。
    expect(warn).toHaveBeenCalledTimes(2)
    const warnings = warn.mock.calls.map((call) => String(call[0]))
    expect(warnings.every((message) => message.includes(corruptKey))).toBe(true)
  })

  it('moves a record to history with moved_at metadata before deleting the active copy', async () => {
    const bucket = new FakeR2()
    const store = createR2Store(bucket)
    const record = makeRecord({ rationale: '历史正文应原样保留。' })
    const body = serializeBody(record)
    await store.putActive(record, body)

    await store.moveToHistory(TOPIC, record.id, 'superseded by newer preference')

    expect(bucket.has(`memories/active/${TOPIC}/${record.id}.md`)).toBe(false)
    expect(await store.getActive(TOPIC, record.id)).toBeNull()

    const object = await bucket.get(`memories/_history/${TOPIC}/${record.id}.md`)
    expect(object).not.toBeNull()
    expect(await object?.text()).toBe(body)
    const metadata = object?.customMetadata ?? {}
    expect(metadata.moved_at).toBeDefined()
    expect(Number.isNaN(Date.parse(metadata.moved_at ?? ''))).toBe(false)
    expect(metadata.reason).toBe('superseded by newer preference')
    expect(metadata.topic).toBe(TOPIC)
    expect(metadata.version).toBe('1')
  })

  it('treats moving a missing active record as a no-op', async () => {
    const bucket = new FakeR2()
    const store = createR2Store(bucket)
    await expect(store.moveToHistory(TOPIC, 'missing', 'cleanup')).resolves.toBeUndefined()
    expect(bucket.keysWithPrefix('memories/_history/')).toEqual([])
  })

  it('rejects illegal topics and path-traversal ids without writing anything', async () => {
    const bucket = new FakeR2()
    const store = createR2Store(bucket)

    const invalidTopics = ['../evil', 'tooling/package-manager', 'Tooling.Package-Manager', '', '..']
    for (const topic of invalidTopics) {
      const record = makeRecord({ topic })
      await expect(store.putActive(record, '# x\n')).rejects.toThrow(/invalid topic/)
      await expect(store.getActive(topic, 'mem-1')).rejects.toThrow(/invalid topic/)
      await expect(store.listActive(topic)).rejects.toThrow(/invalid topic/)
      await expect(store.moveToHistory(topic, 'mem-1', 'x')).rejects.toThrow(/invalid topic/)
    }
    expect(bucket.size).toBe(0)

    await expect(store.getActive(TOPIC, '../evil')).rejects.toThrow(/invalid id/)
    await expect(store.getActive(TOPIC, 'a/b')).rejects.toThrow(/invalid id/)
    const record = makeRecord({ id: '../evil' })
    await expect(store.putActive(record, '# x\n')).rejects.toThrow(/invalid id/)
    expect(bucket.size).toBe(0)
  })
})

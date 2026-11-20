import { afterEach, describe, expect, it, vi } from 'vitest'

import { createR2Store } from '../../src/storage/r2-store'
import type { JournalEvent, PendingChange } from '../../src/types'
import { FakeR2 } from '../support/fake-r2'

const TOPIC = 'code.review'

function makePending(overrides: Partial<PendingChange> = {}): PendingChange {
  return {
    changeId: 'change-1',
    kind: 'conflict',
    topic: TOPIC,
    current: null,
    proposed: {
      statement: '评审时先看测试。',
      rationale: '降低回归风险。',
      confidence: 0.8,
      source: { session: 's-1', message: 'm-2' },
    },
    createdAt: '2026-02-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('pending changes', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('creates, reads, lists and deletes pending changes', async () => {
    const bucket = new FakeR2()
    const store = createR2Store(bucket)
    const change = makePending()

    await store.putPending(change)

    const key = `memories/_pending/${change.changeId}.json`
    expect(bucket.has(key)).toBe(true)
    const object = await bucket.get(key)
    expect(object?.customMetadata).toMatchObject({ topic: TOPIC, kind: 'conflict' })
    expect(await store.getPending(change.changeId)).toEqual(change)

    await store.deletePending(change.changeId)
    expect(bucket.has(key)).toBe(false)
    expect(await store.getPending(change.changeId)).toBeNull()
    await expect(store.deletePending(change.changeId)).resolves.toBeUndefined()
  })

  it('lists pending changes oldest first and skips non-json objects', async () => {
    const bucket = new FakeR2()
    const store = createR2Store(bucket)
    const later = makePending({
      changeId: 'change-later',
      createdAt: '2026-02-03T00:00:00.000Z',
    })
    const earlier = makePending({
      changeId: 'change-earlier',
      createdAt: '2026-02-02T00:00:00.000Z',
    })

    await store.putPending(later)
    await store.putPending(earlier)
    await store.putPending(makePending({ changeId: 'change-last', createdAt: '2026-02-04T00:00:00.000Z' }))
    await bucket.put('memories/_pending/notes.txt', 'not a pending change')

    const changes = await store.listPending()
    expect(changes.map((change) => change.changeId)).toEqual([
      'change-earlier',
      'change-later',
      'change-last',
    ])
  })

  it('skips corrupt pending JSON, warns with its key, and keeps the healthy changes', async () => {
    const bucket = new FakeR2()
    const store = createR2Store(bucket)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const earlier = makePending({
      changeId: 'change-earlier',
      createdAt: '2026-02-02T00:00:00.000Z',
    })
    const later = makePending({
      changeId: 'change-later',
      createdAt: '2026-02-03T00:00:00.000Z',
    })
    await store.putPending(earlier)
    await store.putPending(later)

    const invalidJsonKey = 'memories/_pending/corrupt.json'
    await bucket.put(invalidJsonKey, '{ not valid json')
    const missingChangeIdKey = 'memories/_pending/missing-change-id.json'
    await bucket.put(missingChangeIdKey, JSON.stringify({ topic: TOPIC }))

    const changes = await store.listPending()
    expect(changes.map((change) => change.changeId)).toEqual(['change-earlier', 'change-later'])
    expect(warn).toHaveBeenCalledTimes(2)
    const warnings = warn.mock.calls.map((call) => String(call[0]))
    expect(warnings.some((message) => message.includes(invalidJsonKey))).toBe(true)
    expect(warnings.some((message) => message.includes(missingChangeIdKey))).toBe(true)
  })

  it('rejects illegal topics and changeIds', async () => {
    const bucket = new FakeR2()
    const store = createR2Store(bucket)

    await expect(store.putPending(makePending({ topic: '../evil' }))).rejects.toThrow(
      /invalid topic/,
    )
    await expect(store.putPending(makePending({ changeId: '../../x' }))).rejects.toThrow(
      /invalid changeId/,
    )
    await expect(store.getPending('../../x')).rejects.toThrow(/invalid changeId/)
    await expect(store.deletePending('a/b')).rejects.toThrow(/invalid changeId/)
    expect(bucket.size).toBe(0)
  })
})

describe('journal', () => {
  it('appends events under memories/_journal/{yyyy}/{mm}/{dd}/{eventId}.json', async () => {
    const bucket = new FakeR2()
    const store = createR2Store(bucket)
    const event: JournalEvent = {
      at: '2026-11-20T12:34:56.000Z',
      action: 'upsert',
      topic: TOPIC,
      id: 'mem-1',
      detail: 'confidence=0.9',
    }

    await store.appendJournal(event)
    await store.appendJournal({ at: event.at, action: 'cleanup', detail: 'history=2' })

    const keys = bucket.keysWithPrefix('memories/_journal/2026/11/20/')
    expect(keys).toHaveLength(2)
    expect(keys[0]).toMatch(/^memories\/_journal\/2026\/11\/20\/[^/]+\.json$/)
    expect(keys[1]).toMatch(/^memories\/_journal\/2026\/11\/20\/[^/]+\.json$/)
    expect(keys[0]).not.toBe(keys[1])

    const payloads: Record<string, unknown>[] = []
    for (const key of keys) {
      const object = await bucket.get(key)
      payloads.push(JSON.parse((await object?.text()) ?? '{}') as Record<string, unknown>)
    }
    const upsert = payloads.find((payload) => payload.action === 'upsert')
    expect(upsert).toMatchObject(event)
    expect(typeof upsert?.eventId).toBe('string')
    expect((upsert?.eventId as string).length).toBeGreaterThan(0)
  })

  it('uses UTC date components for the journal path', async () => {
    const bucket = new FakeR2()
    const store = createR2Store(bucket)

    await store.appendJournal({
      at: '2026-01-02T23:30:00.000-05:00',
      action: 'recall',
    })

    expect(bucket.keysWithPrefix('memories/_journal/2026/01/03/')).toHaveLength(1)
    expect(bucket.keysWithPrefix('memories/_journal/2026/01/02/')).toEqual([])
  })

  it('rejects an invalid event timestamp without writing', async () => {
    const bucket = new FakeR2()
    const store = createR2Store(bucket)
    await expect(store.appendJournal({ at: 'not-a-date', action: 'cleanup' })).rejects.toThrow(
      /event\.at/,
    )
    expect(bucket.size).toBe(0)
  })
})

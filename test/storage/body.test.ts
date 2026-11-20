import { describe, expect, it } from 'vitest'

import { parseBody, serializeBody, serializeMetadata } from '../../src/storage/body'
import type { MemoryRecord } from '../../src/types'

function makeRecord(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: 'mem-1',
    topic: 'tooling.package-manager',
    statement: 'Prefer pnpm.',
    confidence: 0.9,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    version: 1,
    ...overrides,
  }
}

describe('serializeBody', () => {
  it('writes a markdown heading for the statement', () => {
    expect(serializeBody(makeRecord())).toBe('# Prefer pnpm.\n')
  })

  it('adds a 理由 section only when a rationale exists', () => {
    expect(serializeBody(makeRecord({ rationale: '保证 lockfile 一致。' }))).toBe(
      '# Prefer pnpm.\n\n## 理由\n\n保证 lockfile 一致。\n',
    )
    expect(serializeBody(makeRecord({ rationale: '   ' }))).toBe('# Prefer pnpm.\n')
  })
})

describe('parseBody', () => {
  it('round-trips a record without a rationale', () => {
    const record = makeRecord()
    expect(parseBody(serializeBody(record), serializeMetadata(record))).toEqual(record)
  })

  it('round-trips a record with rationale, source and supersedes', () => {
    const record = makeRecord({
      rationale: '第一行\n\n第二行，保留空行。',
      source: { session: 's-1', message: 'm-2' },
      supersedes: 'mem-0',
      version: 4,
      confidence: 0.75,
    })
    expect(parseBody(serializeBody(record), serializeMetadata(record))).toEqual(record)
  })

  it('round-trips an explicit null supersedes and a missing one', () => {
    const withNull = makeRecord({ supersedes: null })
    expect(parseBody(serializeBody(withNull), serializeMetadata(withNull))).toEqual(withNull)

    const without = makeRecord()
    const parsed = parseBody(serializeBody(without), serializeMetadata(without))
    expect('supersedes' in parsed).toBe(false)
  })

  it('round-trips a multi-line statement', () => {
    const record = makeRecord({
      statement: '第一行\n第二行',
      rationale: '理由',
    })
    expect(parseBody(serializeBody(record), serializeMetadata(record))).toEqual(record)
  })

  it('works with only the contract metadata fields', () => {
    const parsed = parseBody('# Prefer pnpm.\n', {
      topic: 'tooling.package-manager',
      updated_at: '2026-01-02T00:00:00.000Z',
      version: '3',
    })
    expect(parsed).toEqual({
      id: '',
      topic: 'tooling.package-manager',
      statement: 'Prefer pnpm.',
      confidence: 1,
      createdAt: '2026-01-02T00:00:00.000Z',
      updatedAt: '2026-01-02T00:00:00.000Z',
      version: 3,
    })
  })

  it('keeps the 理由 section body verbatim apart from surrounding whitespace', () => {
    const parsed = parseBody(
      '# Statement\n\n## 理由\n\nline 1\nline 2\n\n',
      { topic: 'code.style', updated_at: '2026-01-01T00:00:00.000Z', version: '1' },
    )
    expect(parsed.rationale).toBe('line 1\nline 2')
  })

  it('treats a blank 理由 section as absent', () => {
    const parsed = parseBody('# Statement\n\n## 理由\n\n', {
      topic: 'code.style',
      updated_at: '2026-01-01T00:00:00.000Z',
      version: '1',
    })
    expect(parsed.rationale).toBeUndefined()
  })

  it('accepts text without a heading as the statement', () => {
    const parsed = parseBody('plain statement\n', {
      topic: 'code.style',
      updated_at: '2026-01-01T00:00:00.000Z',
    })
    expect(parsed.statement).toBe('plain statement')
    expect(parsed.version).toBe(1)
  })

  it('rejects missing topic / updated_at and invalid version', () => {
    expect(() => parseBody('# x', { updated_at: '2026-01-01T00:00:00.000Z' })).toThrow(
      /topic/,
    )
    expect(() => parseBody('# x', { topic: 'code.style' })).toThrow(/updated_at/)
    expect(() =>
      parseBody('# x', {
        topic: 'code.style',
        updated_at: '2026-01-01T00:00:00.000Z',
        version: 'not-a-number',
      }),
    ).toThrow(/version/)
  })
})

describe('serializeMetadata', () => {
  it('stores the contract fields as strings', () => {
    const metadata = serializeMetadata(makeRecord({ version: 7 }))
    expect(metadata.topic).toBe('tooling.package-manager')
    // P1-1 起 updated_at 写 epoch 毫秒字符串（与 AI Search metadata schema 的 number 对齐）。
    expect(metadata.updated_at).toBe(String(Date.parse('2026-01-02T00:00:00.000Z')))
    expect(metadata.updated_at).toMatch(/^\d{13}$/)
    expect(metadata.version).toBe('7')
  })
})

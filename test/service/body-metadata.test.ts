/**
 * R2 自定义元数据 `updated_at` 的格式迁移（P1-1）：
 * - 落盘写 epoch 毫秒字符串（与 AI Search metadata schema 的 number 对齐）；
 * - 读取同时兼容 13 位 epoch 毫秒与旧版 ISO，统一还原为 ISO 的 `MemoryRecord.updatedAt`；
 * - `created_at` 保持 ISO。
 *
 * 放在 `test/service/` 是因为本任务的文件范围包含 `test/service/**`；
 * 与 `test/storage/body.test.ts` 的差异：这里专门断言 epoch ↔ ISO 的往返。
 */

import { describe, expect, it } from 'vitest'

import type { R2Like, R2ObjectLike } from '../../src/contracts'
import { createR2Store } from '../../src/storage/r2-store'
import { parseBody, serializeBody, serializeMetadata } from '../../src/storage/body'
import type { MemoryRecord } from '../../src/types'

/** 极简内存 R2：只覆盖本用例用到的 get / put / delete / list。 */
class MiniBucket implements R2Like {
  readonly objects = new Map<
    string,
    { body: string; customMetadata?: Record<string, string> }
  >()

  async get(key: string): Promise<R2ObjectLike | null> {
    const stored = this.objects.get(key)
    if (!stored) return null
    return {
      text: async () => stored.body,
      ...(stored.customMetadata !== undefined
        ? { customMetadata: stored.customMetadata }
        : {}),
    }
  }

  async put(
    key: string,
    value: string,
    options?: { customMetadata?: Record<string, string> },
  ): Promise<void> {
    this.objects.set(key, {
      body: value,
      ...(options?.customMetadata !== undefined
        ? { customMetadata: options.customMetadata }
        : {}),
    })
  }

  async delete(key: string): Promise<void> {
    this.objects.delete(key)
  }

  async list(options: { prefix: string }): Promise<{ objects: { key: string }[] }> {
    return {
      objects: [...this.objects.keys()]
        .filter((key) => key.startsWith(options.prefix))
        .map((key) => ({ key })),
    }
  }
}

function makeRecord(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: 'mem-1',
    topic: 'tooling.package-manager',
    statement: 'Prefer pnpm.',
    confidence: 0.9,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T03:04:05.678Z',
    version: 1,
    ...overrides,
  }
}

describe('serializeMetadata: updated_at 写 epoch 毫秒', () => {
  it('写 13 位数字字符串，created_at 仍写 ISO', () => {
    const metadata = serializeMetadata(makeRecord())

    expect(metadata.updated_at).toBe(String(Date.parse('2026-01-02T03:04:05.678Z')))
    expect(metadata.updated_at).toMatch(/^\d{13}$/)
    expect(metadata.created_at).toBe('2026-01-01T00:00:00.000Z')
    expect(metadata.topic).toBe('tooling.package-manager')
    expect(metadata.version).toBe('1')
  })
})

describe('parseBody: updated_at 兼容 epoch 与旧 ISO', () => {
  it('epoch 毫秒还原为 ISO，整条记录往返一致', () => {
    const record = makeRecord({
      rationale: '保证 lockfile 一致。',
      source: { session: 's-1', message: 'm-2' },
      supersedes: 'mem-0',
      version: 3,
      confidence: 0.75,
    })

    expect(parseBody(serializeBody(record), serializeMetadata(record))).toEqual(record)
  })

  it('毫秒精度在往返中保持不变', () => {
    const record = makeRecord({ updatedAt: '2026-12-31T23:59:59.999Z' })

    expect(parseBody(serializeBody(record), serializeMetadata(record)).updatedAt).toBe(
      '2026-12-31T23:59:59.999Z',
    )
  })

  it('继续接受旧版 ISO updated_at', () => {
    const record = makeRecord()
    const legacyMetadata = { ...serializeMetadata(record), updated_at: record.updatedAt }

    const parsed = parseBody(serializeBody(record), legacyMetadata)

    expect(parsed.updatedAt).toBe(record.updatedAt)
    expect(parsed).toEqual(record)
  })

  it('缺少 created_at 时回退到 ISO 的 updatedAt（不是 epoch）', () => {
    const parsed = parseBody('# Prefer pnpm.\n', {
      topic: 'tooling.package-manager',
      updated_at: String(Date.parse('2026-01-02T00:00:00.000Z')),
      version: '2',
    })

    expect(parsed.updatedAt).toBe('2026-01-02T00:00:00.000Z')
    expect(parsed.createdAt).toBe('2026-01-02T00:00:00.000Z')
    expect(parsed.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('拒绝缺失或非法的 updated_at', () => {
    expect(() => parseBody('# x', { topic: 'code.style' })).toThrow(/updated_at/)
    expect(() => parseBody('# x', { topic: 'code.style', updated_at: '' })).toThrow(/updated_at/)
    expect(() =>
      parseBody('# x', { topic: 'code.style', updated_at: 'not-a-date' }),
    ).toThrow(/updated_at/)
  })
})

describe('R2Store 端到端：epoch 落盘、ISO 读回', () => {
  it('putActive 写 13 位 epoch，getActive 还原为 ISO 记录', async () => {
    const bucket = new MiniBucket()
    const store = createR2Store(bucket)
    const record = makeRecord()

    await store.putActive(record, serializeBody(record))

    const stored = bucket.objects.get(
      `memories/active/${record.topic}/${record.id}.md`,
    )
    expect(stored?.customMetadata?.updated_at).toBe(String(Date.parse(record.updatedAt)))
    expect(stored?.customMetadata?.updated_at).toMatch(/^\d{13}$/)
    expect(stored?.customMetadata?.created_at).toBe(record.createdAt)

    await expect(store.getActive(record.topic, record.id)).resolves.toEqual(record)
  })

  it('旧对象（ISO updated_at）仍可读，迁移不改写既有数据', async () => {
    const bucket = new MiniBucket()
    const store = createR2Store(bucket)
    const record = makeRecord()
    // 模拟迁移前写入的对象：正文照旧，元数据里 updated_at 是 ISO。
    bucket.objects.set(`memories/active/${record.topic}/${record.id}.md`, {
      body: serializeBody(record),
      customMetadata: {
        ...serializeMetadata(record),
        updated_at: record.updatedAt,
      },
    })

    await expect(store.getActive(record.topic, record.id)).resolves.toEqual(record)
  })
})

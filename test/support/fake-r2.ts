/** R2Like 的内存实现，供单元测试使用。
 *
 * 语义尽量贴近 Cloudflare R2：
 * - put 覆盖整条对象（含 customMetadata）；
 * - list 按 key 升序返回前缀匹配项，光标为字符串；
 * - uploaded 在 put 时由可注入的时钟生成，便于测试 cleanupHistory。
 */

import type { R2Like, R2ListLike, R2ObjectLike } from '../../src/contracts'

export interface FakeR2Options {
  /** 返回对象写入时间，默认 `new Date()`。 */
  now?: () => Date
  /** 单页 list 的最大条数，默认 1000（模拟 R2 分页）。 */
  pageSize?: number
}

interface FakeEntry {
  value: string
  customMetadata?: Record<string, string>
  uploaded: Date
}

export class FakeR2 implements R2Like {
  private readonly entries = new Map<string, FakeEntry>()
  private readonly now: () => Date
  private readonly pageSize: number

  constructor(options: FakeR2Options = {}) {
    this.now = options.now ?? (() => new Date())
    this.pageSize = options.pageSize ?? 1000
    if (!Number.isInteger(this.pageSize) || this.pageSize <= 0) {
      throw new Error('FakeR2: pageSize must be a positive integer')
    }
  }

  async get(key: string): Promise<R2ObjectLike | null> {
    const entry = this.entries.get(key)
    if (entry === undefined) return null
    return {
      text: async () => entry.value,
      customMetadata:
        entry.customMetadata !== undefined ? { ...entry.customMetadata } : undefined,
    }
  }

  async put(
    key: string,
    value: string,
    options?: { customMetadata?: Record<string, string> },
  ): Promise<unknown> {
    const uploaded = this.now()
    this.entries.set(key, {
      value,
      customMetadata:
        options?.customMetadata !== undefined ? { ...options.customMetadata } : undefined,
      uploaded: new Date(uploaded.getTime()),
    })
    return { key }
  }

  async delete(key: string): Promise<void> {
    this.entries.delete(key)
  }

  async list(options: { prefix: string; cursor?: string }): Promise<R2ListLike> {
    const keys = [...this.entries.keys()]
      .filter((key) => key.startsWith(options.prefix))
      .sort((a, b) => a.localeCompare(b))

    let offset = 0
    if (options.cursor !== undefined && options.cursor !== '') {
      offset = Number(options.cursor)
      if (!Number.isInteger(offset) || offset < 0) {
        throw new Error(`FakeR2: invalid cursor: ${options.cursor}`)
      }
    }

    const page = keys.slice(offset, offset + this.pageSize)
    const nextOffset = offset + page.length
    const truncated = nextOffset < keys.length
    return {
      objects: page.map((key) => {
        const entry = this.entries.get(key) as FakeEntry
        return { key, uploaded: new Date(entry.uploaded.getTime()) }
      }),
      truncated,
      cursor: truncated ? String(nextOffset) : undefined,
    }
  }

  /** 当前所有 key（升序），便于断言。 */
  keys(): string[] {
    return [...this.entries.keys()].sort((a, b) => a.localeCompare(b))
  }

  /** 前缀匹配的 key（升序）。 */
  keysWithPrefix(prefix: string): string[] {
    return this.keys().filter((key) => key.startsWith(prefix))
  }

  has(key: string): boolean {
    return this.entries.has(key)
  }

  get size(): number {
    return this.entries.size
  }

  clear(): void {
    this.entries.clear()
  }

  /** 读取对象的写入时间（测试断言用）。 */
  uploadedAt(key: string): Date | undefined {
    const entry = this.entries.get(key)
    return entry === undefined ? undefined : new Date(entry.uploaded.getTime())
  }
}

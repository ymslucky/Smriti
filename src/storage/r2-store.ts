/** MemoryStore 的 R2 实现。
 *
 * Key 布局（docs/plan.md）：
 * - active  : memories/active/{topic}/{id}.md
 * - pending : memories/_pending/{changeId}.json
 * - history : memories/_history/{topic}/{id}.md
 * - journal : memories/_journal/{yyyy}/{mm}/{dd}/{eventId}.json
 * - recent  : memories/_index/recent.json（派生缓存，最近 50 条）
 *
 * 单用户场景：recent 索引为单写者读改写，并发时允许最后写入获胜。
 * 所有进入 key 的 topic / id / changeId 都经过路径段校验，防止路径穿越。
 */

import type { MemoryStore, R2Like, R2ObjectLike } from '../contracts'
import type { JournalEvent, MemoryRecord, PendingChange } from '../types'
import { parseBody, serializeMetadata } from './body'

const ACTIVE_PREFIX = 'memories/active/'
const PENDING_PREFIX = 'memories/_pending/'
const HISTORY_PREFIX = 'memories/_history/'
const JOURNAL_PREFIX = 'memories/_journal/'
const RECENT_KEY = 'memories/_index/recent.json'
const RECENT_MAX = 50
const TOPIC_PATTERN = /^[a-z0-9._-]+$/
const CONTROL_OR_SLASH = /[\/\\\u0000-\u001f\u007f]/

interface RecentEntry {
  id: string
  topic: string
  updatedAt: string
}

interface ListedObject {
  key: string
  uploaded?: Date
}

function isValidTopic(topic: unknown): topic is string {
  return (
    typeof topic === 'string' &&
    topic !== '.' &&
    topic !== '..' &&
    TOPIC_PATTERN.test(topic)
  )
}

function assertTopic(topic: unknown): asserts topic is string {
  if (!isValidTopic(topic)) {
    throw new Error(`invalid topic: ${JSON.stringify(topic)} (expected /^[a-z0-9._-]+$/)`)
  }
}

function assertSegment(value: unknown, label: string): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value === '.' ||
    value === '..' ||
    CONTROL_OR_SLASH.test(value)
  ) {
    throw new Error(`invalid ${label}: ${JSON.stringify(value)} (must be a single safe path segment)`)
  }
}

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

function activeKey(topic: string, id: string): string {
  return `${ACTIVE_PREFIX}${topic}/${id}.md`
}

function historyKey(topic: string, id: string): string {
  return `${HISTORY_PREFIX}${topic}/${id}.md`
}

function pendingKey(changeId: string): string {
  return `${PENDING_PREFIX}${changeId}.json`
}

function journalKey(at: string, eventId: string): string {
  const date = new Date(at)
  if (Number.isNaN(date.getTime())) {
    throw new Error(`invalid journal event.at: ${JSON.stringify(at)}`)
  }
  return `${JOURNAL_PREFIX}${date.getUTCFullYear()}/${pad2(date.getUTCMonth() + 1)}/${pad2(
    date.getUTCDate(),
  )}/${eventId}.json`
}

function createEventId(): string {
  const candidate = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
  if (candidate !== undefined && typeof candidate.randomUUID === 'function') {
    return candidate.randomUUID()
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`
}

/** R2 list 分页读取指定前缀下的全部对象。 */
async function listObjects(bucket: R2Like, prefix: string): Promise<ListedObject[]> {
  const objects: ListedObject[] = []
  let cursor: string | undefined
  for (let page = 0; page < 10_000; page += 1) {
    const result =
      cursor === undefined
        ? await bucket.list({ prefix })
        : await bucket.list({ prefix, cursor })
    objects.push(...result.objects)
    if (result.truncated !== true) break
    const next = result.cursor
    if (next === undefined || next === '' || next === cursor) break
    cursor = next
  }
  return objects
}

/** 从 active key 反解 topic / id；非本布局的 key 返回 null。 */
function parseActiveKey(key: string): { topic: string; id: string } | null {
  if (!key.startsWith(ACTIVE_PREFIX) || !key.endsWith('.md')) return null
  const rest = key.slice(ACTIVE_PREFIX.length, -'.md'.length)
  const slash = rest.indexOf('/')
  if (slash <= 0 || slash === rest.length - 1) return null
  const topic = rest.slice(0, slash)
  const id = rest.slice(slash + 1)
  if (!isValidTopic(topic) || id.includes('/')) return null
  return { topic, id }
}

async function readActiveObject(
  object: R2ObjectLike,
  topic: string,
  id: string,
): Promise<MemoryRecord> {
  const metadata = object.customMetadata !== undefined ? { ...object.customMetadata } : {}
  // 路径是 topic / id 的真源；仅在元数据缺失时用 path 补齐 topic。
  if (metadata.topic === undefined || metadata.topic === '') metadata.topic = topic
  const record = parseBody(await object.text(), metadata)
  return { ...record, id, topic }
}

async function readRecentIndex(bucket: R2Like): Promise<RecentEntry[] | null> {
  const object = await bucket.get(RECENT_KEY)
  if (object === null) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(await object.text())
  } catch {
    return null
  }
  if (!Array.isArray(parsed)) return null
  const entries: RecentEntry[] = []
  for (const item of parsed) {
    if (item === null || typeof item !== 'object') continue
    const candidate = item as Record<string, unknown>
    const { id, topic, updatedAt } = candidate
    if (
      typeof id !== 'string' ||
      id === '' ||
      typeof topic !== 'string' ||
      !isValidTopic(topic) ||
      typeof updatedAt !== 'string' ||
      Number.isNaN(Date.parse(updatedAt))
    ) {
      continue
    }
    entries.push({ id, topic, updatedAt })
  }
  return entries
}

async function writeRecentIndex(bucket: R2Like, entries: RecentEntry[]): Promise<void> {
  await bucket.put(RECENT_KEY, JSON.stringify(entries.slice(0, RECENT_MAX)))
}

/** 把记录放到 recent 索引的最前面（读改写，最后写入获胜）。 */
async function touchRecentIndex(bucket: R2Like, record: MemoryRecord): Promise<void> {
  const existing = (await readRecentIndex(bucket)) ?? []
  const next: RecentEntry[] = [
    { id: record.id, topic: record.topic, updatedAt: record.updatedAt },
    ...existing.filter((entry) => !(entry.id === record.id && entry.topic === record.topic)),
  ]
  await writeRecentIndex(bucket, next)
}

async function removeRecentIndexEntry(bucket: R2Like, topic: string, id: string): Promise<void> {
  const existing = await readRecentIndex(bucket)
  if (existing === null) return
  const next = existing.filter((entry) => !(entry.id === id && entry.topic === topic))
  if (next.length !== existing.length) {
    await writeRecentIndex(bucket, next)
  }
}

function parsePendingChange(text: string, key: string): PendingChange {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(`corrupt pending change at ${key}: invalid JSON`)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`corrupt pending change at ${key}: expected an object`)
  }
  const candidate = parsed as Record<string, unknown>
  if (typeof candidate.changeId !== 'string' || candidate.changeId === '') {
    throw new Error(`corrupt pending change at ${key}: missing changeId`)
  }
  if (typeof candidate.topic !== 'string' || !isValidTopic(candidate.topic)) {
    throw new Error(`corrupt pending change at ${key}: invalid topic`)
  }
  return parsed as PendingChange
}

function compareIsoDesc(a: string, b: string): number {
  return Date.parse(b) - Date.parse(a)
}

/** 单条对象损坏时跳过并告警；一条坏记录不应让整次列表 / 召回失败。 */
function warnSkippedObject(key: string, error: unknown): void {
  const reason = error instanceof Error ? error.message : String(error)
  console.warn(`r2-store: skipping corrupt object at ${key}: ${reason}`)
}

/** 基于 R2Like 创建 MemoryStore。 */
export function createR2Store(bucket: R2Like): MemoryStore {
  if (
    bucket === undefined ||
    bucket === null ||
    typeof bucket.get !== 'function' ||
    typeof bucket.put !== 'function' ||
    typeof bucket.delete !== 'function' ||
    typeof bucket.list !== 'function'
  ) {
    throw new TypeError('createR2Store: bucket does not implement R2Like')
  }

  async function getActiveRecord(topic: string, id: string): Promise<MemoryRecord | null> {
    const key = activeKey(topic, id)
    const object = await bucket.get(key)
    if (object === null) return null
    return readActiveObject(object, topic, id)
  }

  async function listActiveRecords(topic?: string): Promise<MemoryRecord[]> {
    if (topic !== undefined) assertTopic(topic)
    const prefix = topic !== undefined ? `${ACTIVE_PREFIX}${topic}/` : ACTIVE_PREFIX
    const listed = await listObjects(bucket, prefix)
    const records: MemoryRecord[] = []
    for (const item of listed) {
      const parsed = parseActiveKey(item.key)
      if (parsed === null) continue
      // 逐条容错：单条对象读取 / 解析失败时跳过并告警，不影响其它记录。
      try {
        const object = await bucket.get(item.key)
        if (object === null) continue
        records.push(await readActiveObject(object, parsed.topic, parsed.id))
      } catch (error) {
        warnSkippedObject(item.key, error)
      }
    }
    return records
  }

  return {
    async putActive(record: MemoryRecord, body: string): Promise<void> {
      assertTopic(record.topic)
      assertSegment(record.id, 'id')
      if (typeof body !== 'string') {
        throw new TypeError('putActive: body must be a string')
      }
      const key = activeKey(record.topic, record.id)
      await bucket.put(key, body, { customMetadata: serializeMetadata(record) })
      try {
        await touchRecentIndex(bucket, record)
      } catch {
        // recent 只是派生缓存；索引写失败不应让主写入失败。
      }
    },

    async getActive(topic: string, id: string): Promise<MemoryRecord | null> {
      assertTopic(topic)
      assertSegment(id, 'id')
      return getActiveRecord(topic, id)
    },

    async listActive(topic?: string): Promise<MemoryRecord[]> {
      return listActiveRecords(topic)
    },

    async moveToHistory(topic: string, id: string, reason: string): Promise<void> {
      assertTopic(topic)
      assertSegment(id, 'id')
      const sourceKey = activeKey(topic, id)
      const object = await bucket.get(sourceKey)
      // 幂等：active 不存在时视为已经移动过。
      if (object === null) return
      const body = await object.text()
      const metadata: Record<string, string> =
        object.customMetadata !== undefined ? { ...object.customMetadata } : {}
      metadata.moved_at = new Date().toISOString()
      // reason 是自由文本，截断后再写入元数据，避免超出 R2 customMetadata 的大小限制；
      // 完整的 reason 由调用方写入 journal。
      if (typeof reason === 'string' && reason !== '') metadata.reason = reason.slice(0, 512)
      await bucket.put(historyKey(topic, id), body, { customMetadata: metadata })
      await bucket.delete(sourceKey)
      try {
        await removeRecentIndexEntry(bucket, topic, id)
      } catch {
        // 同上：缓存更新失败不影响历史迁移。
      }
    },

    async putPending(change: PendingChange): Promise<void> {
      assertTopic(change.topic)
      assertSegment(change.changeId, 'changeId')
      const metadata: Record<string, string> = {
        topic: change.topic,
        kind: String(change.kind),
        created_at: String(change.createdAt),
      }
      await bucket.put(pendingKey(change.changeId), JSON.stringify(change), {
        customMetadata: metadata,
      })
    },

    async getPending(changeId: string): Promise<PendingChange | null> {
      assertSegment(changeId, 'changeId')
      const key = pendingKey(changeId)
      const object = await bucket.get(key)
      if (object === null) return null
      return parsePendingChange(await object.text(), key)
    },

    async listPending(): Promise<PendingChange[]> {
      const listed = await listObjects(bucket, PENDING_PREFIX)
      const changes: PendingChange[] = []
      for (const item of listed) {
        if (!item.key.endsWith('.json')) continue
        // 逐条容错：单条待审变更损坏（非法 JSON / 缺字段）时跳过并告警。
        try {
          const object = await bucket.get(item.key)
          if (object === null) continue
          changes.push(parsePendingChange(await object.text(), item.key))
        } catch (error) {
          warnSkippedObject(item.key, error)
        }
      }
      changes.sort(
        (a, b) => a.createdAt.localeCompare(b.createdAt) || a.changeId.localeCompare(b.changeId),
      )
      return changes
    },

    async deletePending(changeId: string): Promise<void> {
      assertSegment(changeId, 'changeId')
      await bucket.delete(pendingKey(changeId))
    },

    async appendJournal(event: JournalEvent): Promise<void> {
      if (event === null || typeof event !== 'object') {
        throw new TypeError('appendJournal: event must be an object')
      }
      if (typeof event.at !== 'string' || typeof event.action !== 'string') {
        throw new TypeError('appendJournal: event.at and event.action must be strings')
      }
      const eventId = createEventId()
      const key = journalKey(event.at, eventId)
      await bucket.put(key, JSON.stringify({ ...event, eventId }))
    },

    async cleanupHistory(before: Date): Promise<number> {
      if (!(before instanceof Date) || Number.isNaN(before.getTime())) {
        throw new TypeError('cleanupHistory: before must be a valid Date')
      }
      const listed = await listObjects(bucket, HISTORY_PREFIX)
      const stale = listed.filter(
        (item) => item.uploaded !== undefined && item.uploaded.getTime() < before.getTime(),
      )
      for (const item of stale) {
        await bucket.delete(item.key)
      }
      return stale.length
    },

    async recent(limit: number): Promise<MemoryRecord[]> {
      if (typeof limit !== 'number' || !Number.isInteger(limit) || limit <= 0) return []
      const entries = await readRecentIndex(bucket)
      if (entries !== null) {
        const records: MemoryRecord[] = []
        for (const entry of entries) {
          if (records.length >= limit) break
          // 索引可能指向已损坏的 active 对象：跳过该条，避免召回整体失败。
          try {
            const record = await getActiveRecord(entry.topic, entry.id)
            if (record !== null) records.push(record)
          } catch (error) {
            warnSkippedObject(activeKey(entry.topic, entry.id), error)
          }
        }
        return records
      }
      // 索引缺失 / 损坏：回退为 listActive + updatedAt 倒序。
      const records = await listActiveRecords()
      records.sort(
        (a, b) => compareIsoDesc(a.updatedAt, b.updatedAt) || a.id.localeCompare(b.id),
      )
      return records.slice(0, limit)
    },
  }
}

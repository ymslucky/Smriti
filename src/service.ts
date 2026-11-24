/**
 * 记忆服务：写入 / 裁决 / 查询 / 自动捕获的业务实现。
 *
 * 只依赖 `contracts.ts` 的窄接口，真实 R2 存储与 AI Search 由调用方注入，
 * 单元测试用内存 fake 即可覆盖全部状态机。本文件不直接访问 R2 / 网络。
 *
 * 写入判定顺序（与 docs/design.md 一致）：
 * 1. topic 不在固定词表 → `unknown_topic`；
 * 2. 归一化后为空 → `rejected`；
 * 3. pending 中已有相同 idempotencyKey → 原样返回该 change；
 * 4. 同 topic 已有相同陈述（哈希相同）→ `unchanged`；
 * 5. 同 topic 已有不同陈述 → `conflict` pending；
 * 6. 其它 topic 已有归一化后完全相同的 active（本地兜底，不依赖检索索引新鲜度）
 *    → `possible-duplicate` pending；
 * 7. 跨 topic 检索到高分近似 → `possible-duplicate` pending；
 * 8. 以上都不满足才落盘 active，返回 `applied`。
 */

import type { MemoryService, MemoryStore, SearchIndex, UpsertInput } from './contracts'
import { createRecall } from './recall'
import { TOPICS, TOPIC_NAMES, isKnownTopic } from './topics'
import type {
  ExtractCandidate,
  MemoryRecord,
  PendingChange,
  PendingKind,
  SearchHealth,
  SearchHit,
  TopicSummary,
  UpsertResult,
} from './types'

export interface MemoryServiceDeps {
  store: MemoryStore
  search: SearchIndex
  /** 时钟注入，便于测试稳定断言 ISO 时间。 */
  now?: () => Date
  /** id 生成注入，默认 16 位 hex；测试可用递增序列。 */
  newId?: () => string
}

/** 模型未显式给出 confidence 时的默认值。 */
export const DEFAULT_CONFIDENCE = 0.8
/** 跨 topic 近似判定阈值：top1 score ≥ 该值才可能进入待裁决。 */
export const NEAR_DUPLICATE_THRESHOLD = 0.85
/** `search()` 未显式指定条数时的默认值。 */
export const DEFAULT_SEARCH_LIMIT = 10
export const RECORD_ID_PREFIX = 'mem_'
export const CHANGE_ID_PREFIX = 'chg_'

const TRAILING_PUNCTUATION = /[。．.!！?？;；,，、:：]+$/u

/** 生成 `length` 位小写 hex 随机串（默认 id 用）。 */
function randomHex(length: number): string {
  const bytes = new Uint8Array(Math.ceil(length / 2))
  crypto.getRandomValues(bytes)
  let out = ''
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0')
  return out.slice(0, length)
}

/** statement 归一化：trim、合并空白、去掉句末多余标点。 */
export function normalizeStatement(raw: string): string {
  return raw
    .replace(/\s+/gu, ' ')
    .trim()
    .replace(TRAILING_PUNCTUATION, '')
    .trim()
}

/** FNV-1a 32 位哈希：只用于同陈述/幂等判定，不是安全哈希。 */
export function statementHash(statement: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < statement.length; i += 1) {
    hash ^= statement.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/** 正文 Markdown：`# 陈述` + 可选 `## 理由`。 */
function renderBody(statement: string, rationale?: string): string {
  const parts = [`# ${statement}`]
  const trimmed = rationale?.trim()
  if (trimmed) parts.push('', '## 理由', '', trimmed)
  return `${parts.join('\n')}\n`
}

/** 给注入的 id token 补前缀；已带前缀则原样使用。 */
function withPrefix(prefix: string, raw: string): string {
  const token = raw.trim()
  return token.startsWith(prefix) ? token : `${prefix}${token}`
}

/** 同 topic 可能存在多条 active，冲突时以最近更新的一条作为 current。 */
function pickLatest(records: readonly MemoryRecord[]): MemoryRecord | undefined {
  let latest: MemoryRecord | undefined
  for (const record of records) {
    if (!latest || record.updatedAt >= latest.updatedAt) latest = record
  }
  return latest
}

export function createMemoryService(deps: MemoryServiceDeps): MemoryService {
  const store: MemoryStore = deps.store
  const searchIndex: SearchIndex = deps.search

  const now = (): Date => (deps.now ? deps.now() : new Date())
  const nextId = (): string => (deps.newId ? deps.newId() : randomHex(16))

  function nextRecordId(): string {
    return withPrefix(RECORD_ID_PREFIX, nextId())
  }

  /** 在同一批待裁决变更内保证 changeId 唯一（注入的 newId 可能是常量）。 */
  function nextChangeId(taken: ReadonlySet<string>): string {
    const base = withPrefix(CHANGE_ID_PREFIX, nextId())
    let candidate = base
    let suffix = 2
    while (taken.has(candidate)) {
      candidate = `${base}_${suffix}`
      suffix += 1
    }
    return candidate
  }

  /**
   * 跨 topic 语义近似检查。检索不可用（本地无绑定 / 限流）时视为无近似，
   * 保证写入链路不被检索故障阻塞。
   */
  async function findNearDuplicate(
    statement: string,
    topic: string,
  ): Promise<SearchHit | undefined> {
    let hits: SearchHit[]
    try {
      hits = await searchIndex.search(statement, { limit: 1 })
    } catch {
      return undefined
    }
    const top = hits[0]
    if (!top) return undefined
    if (!Number.isFinite(top.score)) return undefined
    if (top.score < NEAR_DUPLICATE_THRESHOLD) return undefined
    if (top.topic === topic) return undefined
    return top
  }

  /**
   * 本地近重复兜底：AI Search 索引是异步同步的，刚写入的记录可能还查不到，
   * 这里直接扫描 active 做归一化精确比对。同 topic 的相同陈述已由 `unchanged`
   * 分支处理，因此只返回其它 topic 的记录。
   */
  async function findLocalDuplicate(
    statement: string,
    topic: string,
  ): Promise<MemoryRecord | undefined> {
    const normalized = normalizeStatement(statement)
    const all = await store.listActive()
    return all.find(
      (record) =>
        record.topic !== topic && normalizeStatement(record.statement) === normalized,
    )
  }

  async function createPendingChange(
    kind: PendingKind,
    topic: string,
    current: MemoryRecord | null,
    proposed: PendingChange['proposed'],
    idempotencyKey?: string,
  ): Promise<PendingChange> {
    const pending = await store.listPending()
    const change: PendingChange = {
      changeId: nextChangeId(new Set(pending.map((item) => item.changeId))),
      kind,
      topic,
      current,
      proposed,
      ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
      createdAt: now().toISOString(),
    }
    await store.putPending(change)
    return change
  }

  async function upsert(input: UpsertInput): Promise<UpsertResult> {
    const topic = typeof input.topic === 'string' ? input.topic.trim() : ''
    if (!isKnownTopic(topic)) {
      return {
        status: 'unknown_topic',
        message: `未知 topic「${String(input.topic)}」。可用 topic：${TOPIC_NAMES.join(', ')}`,
      }
    }

    const statement = normalizeStatement(
      typeof input.statement === 'string' ? input.statement : '',
    )
    if (!statement) {
      return { status: 'rejected', message: 'statement 归一化后为空，拒绝写入' }
    }

    if (input.idempotencyKey) {
      const existing = (await store.listPending()).find(
        (item) => item.idempotencyKey === input.idempotencyKey,
      )
      if (existing) {
        return {
          status: 'pending_review',
          change: existing,
          message: '相同 idempotencyKey 已在待裁决队列，返回原变更',
        }
      }
    }

    const active = await store.listActive(topic)
    const hash = statementHash(statement)
    const same = active.find(
      (record) => statementHash(normalizeStatement(record.statement)) === hash,
    )
    if (same) {
      return { status: 'unchanged', memory: same, message: '同 topic 已有相同陈述' }
    }

    const at = now().toISOString()
    const proposed: PendingChange['proposed'] = {
      statement,
      ...(input.rationale !== undefined ? { rationale: input.rationale } : {}),
      confidence: input.confidence ?? DEFAULT_CONFIDENCE,
      ...(input.source !== undefined ? { source: input.source } : {}),
    }

    const current = pickLatest(active)
    if (current) {
      const change = await createPendingChange(
        'conflict',
        topic,
        current,
        proposed,
        input.idempotencyKey,
      )
      await store.appendJournal({
        at,
        action: 'upsert',
        topic,
        changeId: change.changeId,
        detail: `pending:conflict 与 ${current.id} 冲突`,
      })
      return { status: 'pending_review', change }
    }

    // 本地兜底先于 AI Search：索引可能滞后，归一化精确比对更确定，也省一次检索调用。
    const localDuplicate = await findLocalDuplicate(statement, topic)
    if (localDuplicate) {
      const change = await createPendingChange(
        'possible-duplicate',
        topic,
        null,
        proposed,
        input.idempotencyKey,
      )
      await store.appendJournal({
        at,
        action: 'upsert',
        topic,
        changeId: change.changeId,
        detail: `pending:possible-duplicate 本地近似 ${localDuplicate.id}（topic=${localDuplicate.topic}）`,
      })
      return { status: 'pending_review', change }
    }

    const near = await findNearDuplicate(statement, topic)
    if (near) {
      const change = await createPendingChange(
        'possible-duplicate',
        topic,
        null,
        proposed,
        input.idempotencyKey,
      )
      await store.appendJournal({
        at,
        action: 'upsert',
        topic,
        changeId: change.changeId,
        detail: `pending:possible-duplicate 近似 ${near.id}（score=${near.score.toFixed(2)}）`,
      })
      return { status: 'pending_review', change }
    }

    const record: MemoryRecord = {
      id: nextRecordId(),
      topic,
      statement,
      ...(input.rationale !== undefined ? { rationale: input.rationale } : {}),
      confidence: proposed.confidence,
      ...(input.source !== undefined ? { source: input.source } : {}),
      createdAt: at,
      updatedAt: at,
      version: 1,
      supersedes: null,
    }
    await store.putActive(record, renderBody(record.statement, record.rationale))
    await store.appendJournal({
      at,
      action: 'upsert',
      topic,
      id: record.id,
      detail: 'applied v1',
    })
    return { status: 'applied', memory: record }
  }

  async function get(topic: string, id: string): Promise<MemoryRecord | null> {
    return store.getActive(topic, id)
  }

  async function list(topic?: string): Promise<MemoryRecord[]> {
    return store.listActive(topic)
  }

  async function search(
    query: string,
    options?: { limit?: number; topic?: string },
  ): Promise<SearchHit[]> {
    const limit = options?.limit ?? DEFAULT_SEARCH_LIMIT
    if (!Number.isFinite(limit) || limit <= 0) return []
    const max = Math.trunc(limit)
    const topic = options?.topic
    return topic
      ? searchIndex.search(query, { limit: max, topic })
      : searchIndex.search(query, { limit: max })
  }

  async function forget(topic: string, id: string, reason: string): Promise<boolean> {
    const record = await store.getActive(topic, id)
    if (!record) return false
    await store.moveToHistory(topic, id, reason)
    await store.appendJournal({
      at: now().toISOString(),
      action: 'forget',
      topic,
      id,
      detail: reason,
    })
    return true
  }

  async function topics(): Promise<TopicSummary[]> {
    const all = await store.listActive()
    const counts = new Map<string, number>()
    for (const record of all) {
      counts.set(record.topic, (counts.get(record.topic) ?? 0) + 1)
    }
    return TOPICS.map((definition) => ({
      topic: definition.topic,
      label: definition.label,
      description: definition.description,
      count: counts.get(definition.topic) ?? 0,
    }))
  }

  const recall = createRecall({ store, search: searchIndex })

  async function pending(): Promise<PendingChange[]> {
    return store.listPending()
  }

  /**
   * approve 重试兜底：上一次 approve 可能在「新记录已写入」之后失败（移历史 / 删 pending），
   * 重试时按 (supersedes = current.id、归一化陈述相同) 找回已生效的后继记录，避免重复写入。
   */
  async function findAppliedSuccessor(change: PendingChange): Promise<MemoryRecord | null> {
    const current = change.current
    if (!current) return null
    const statement = normalizeStatement(change.proposed.statement)
    const active = await store.listActive(change.topic)
    return (
      active.find(
        (record) =>
          record.supersedes === current.id &&
          normalizeStatement(record.statement) === statement,
      ) ?? null
    )
  }

  async function approve(changeId: string): Promise<UpsertResult> {
    const change = await store.getPending(changeId)
    if (!change) {
      return { status: 'rejected', message: `待裁决变更不存在：${changeId}` }
    }

    const at = now().toISOString()
    const current = change.current
    const successor = await findAppliedSuccessor(change)
    const record: MemoryRecord = successor ?? {
      id: nextRecordId(),
      topic: change.topic,
      statement: change.proposed.statement,
      ...(change.proposed.rationale !== undefined
        ? { rationale: change.proposed.rationale }
        : {}),
      confidence: change.proposed.confidence ?? DEFAULT_CONFIDENCE,
      ...(change.proposed.source !== undefined ? { source: change.proposed.source } : {}),
      createdAt: at,
      updatedAt: at,
      version: current ? current.version + 1 : 1,
      supersedes: current ? current.id : null,
    }

    // 顺序有语义：先落新记录 → 再移旧版 → 最后删 pending。
    // - putActive 失败：什么都没变，pending 保留，可直接重试；
    // - moveToHistory 失败：新记录已生效（记忆不丢），旧版仍 active，pending 保留，可安全重试；
    // - deletePending 失败：新旧都已就位，pending 保留，重试会复用 successor 而不会重复写入。
    // 任一步失败都向上抛错，不静默吞掉。
    if (successor === null) {
      await store.putActive(record, renderBody(record.statement, record.rationale))
    }
    if (current) {
      await store.moveToHistory(change.topic, current.id, `superseded by ${changeId}`)
    }
    await store.deletePending(changeId)
    await store.appendJournal({
      at,
      action: 'apply',
      topic: change.topic,
      id: record.id,
      changeId,
      detail: record.supersedes
        ? `v${record.version} supersedes ${record.supersedes}`
        : `v${record.version}`,
    })
    return { status: 'applied', memory: record }
  }

  async function reject(changeId: string, reason: string): Promise<boolean> {
    const change = await store.getPending(changeId)
    if (!change) return false
    await store.deletePending(changeId)
    await store.appendJournal({
      at: now().toISOString(),
      action: 'reject',
      topic: change.topic,
      changeId,
      detail: reason,
    })
    return true
  }

  async function extract(candidates: ExtractCandidate[]): Promise<UpsertResult[]> {
    const results: UpsertResult[] = []
    for (const candidate of candidates) {
      results.push(
        await upsert({
          topic: candidate.topic,
          statement: candidate.statement,
          ...(candidate.rationale !== undefined ? { rationale: candidate.rationale } : {}),
          ...(candidate.confidence !== undefined ? { confidence: candidate.confidence } : {}),
          ...(candidate.source !== undefined ? { source: candidate.source } : {}),
        }),
      )
    }
    return results
  }

  /** 检索后端可达性：搜索实现不提供探活时视为未知（不拦业务）。 */
  async function health(): Promise<SearchHealth> {
    if (!searchIndex.health) return { ok: true, instance: 'unknown' }
    return searchIndex.health()
  }

  return {
    upsert,
    get,
    list,
    search,
    health,
    forget,
    topics,
    recall,
    pending,
    approve,
    reject,
    extract,
  }
}

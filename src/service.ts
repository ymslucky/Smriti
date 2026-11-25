/**
 * 记忆服务：写入 / 裁决 / 查询 / 自动捕获的业务实现。
 *
 * 只依赖 `contracts.ts` 的窄接口，真实 R2 存储与 AI Search 由调用方注入，
 * 单元测试用内存 fake 即可覆盖全部状态机。本文件不直接访问 R2 / 网络。
 *
 * 写入判定顺序（与 docs/design.md 一致）：
 * 1. topic 不符合 slug 语法 → `invalid_topic`（**不**比对词表：主题由写入时创建）；
 * 2. 归一化后为空 → `rejected`；
 * 3. pending 中已有相同 idempotencyKey → 原样返回该 change；
 * 4. 同 topic 已有相同陈述（哈希相同）→ `unchanged`；
 * 5. 父 / 子主题已有相同陈述（同一棵主题子树内）→ `unchanged`；
 * 6. topic 还没有子主题（= 叶子 / 槽位）且已有不同陈述 → `conflict` pending；
 *    已有子主题（= 分类）的 topic 可以容纳多条；
 * 7. 其它 topic 已有归一化后完全相同的 active → `possible-duplicate` pending；
 * 8. 跨 topic 检索到高分近似 → `possible-duplicate` pending；
 * 9. 以上都不满足才落盘 active，返回 `applied`。
 *
 * 叶子 / 分类是**数据推导**的：某个 topic 一旦被写成 `a.b`，`a` 自动成为分类。
 */

import type { MemoryService, MemoryStore, SearchIndex, UpsertInput } from './contracts'
import { createRecall } from './recall'
import {
  MAX_TOPIC_SEGMENTS,
  descriptionForTopic,
  isValidTopicId,
  isWithinTopic,
  labelForTopic,
  parentOf,
  topicDepth,
} from './topics'
import type {
  ArchivedRecord,
  ExtractCandidate,
  MemoryRecord,
  PendingChange,
  PendingKind,
  ResolutionInput,
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
  /**
   * 槽位冲突 / 疑似重复的处理策略：
   * - `caller`（默认）：返回 `pending_review` 与 changeId，由**调用方模型**用 `resolve` 裁决；
   * - `server`：服务端直接按"新覆盖旧"生效（旧版进 history，可 restore）；
   * - `manual`：返回 pending，等人工 approve/reject（兼容旧行为）。
   */
  conflictPolicy?: 'caller' | 'server' | 'manual'
  /** 常驻（core）记忆的主题前缀；recall 时优先带上。 */
  coreTopicPrefixes?: readonly string[]
  /** 召回时最多带几条 core 记忆，默认 5。 */
  coreRecallLimit?: number
}

/** 模型未显式给出 confidence 时的默认值。 */
export const DEFAULT_CONFIDENCE = 0.8
/** 召回默认带几条 core。 */
export const DEFAULT_CORE_RECALL_LIMIT = 5
/**
 * 本地重复判定阈值：字符二元组 Jaccard 相似度。
 * 72% 意味着「统一用 pnpm 安装依赖」与「统一用 pnpm」这类改写会命中；
 * 而语义相近但用词不同的句子不会。真实数据积累后应按分布校准。
 */
export const LOCAL_DUPLICATE_SIMILARITY = 0.72
/** 检索候选进入重复判定的文本相似度下限（检索只负责召回，不负责裁决）。 */
export const SEARCH_DUPLICATE_SIMILARITY = 0.5
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

/** 相似度归一化：去掉空白、标点与符号，统一小写。 */
function normalizeForSimilarity(text: string): string {
  return text.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')
}

/** 字符二元组集合；单字符文本退化为单元素集合。 */
function bigrams(text: string): Set<string> {
  if (text.length === 0) return new Set<string>()
  if (text.length === 1) return new Set<string>([text])
  const set = new Set<string>()
  for (let index = 0; index < text.length - 1; index += 1) {
    set.add(text.slice(index, index + 2))
  }
  return set
}

/**
 * 陈述相似度：字符二元组 Jaccard（0–1）。
 * 对中文与英文都稳定，不依赖分词或外部模型；这是写入去重的判定依据。
 */
export function statementSimilarity(left: string, right: string): number {
  const a = normalizeForSimilarity(left)
  const b = normalizeForSimilarity(right)
  if (a === '' || b === '') return 0
  if (a === b) return 1
  const setA = bigrams(a)
  const setB = bigrams(b)
  let intersection = 0
  for (const gram of setA) {
    if (setB.has(gram)) intersection += 1
  }
  const union = setA.size + setB.size - intersection
  return union === 0 ? 0 : intersection / union
}

/** 索引里的正文是渲染后的 Markdown；取首行标题作为陈述。 */
function hitStatementText(text: string): string {
  const firstLine = text.split('\n', 1)[0] ?? text
  return firstLine.replace(/^#\s*/u, '').trim() || text.trim()
}

/** 事实在某一时刻是否有效（validFrom ≤ t < validTo）。 */
function validAt(record: MemoryRecord, instant: number): boolean {
  const from = Date.parse(record.validFrom ?? record.createdAt)
  if (Number.isNaN(from) || from > instant) return false
  if (record.validTo === undefined || record.validTo === null) return true
  const to = Date.parse(record.validTo)
  return Number.isNaN(to) ? true : to > instant
}

export function createMemoryService(deps: MemoryServiceDeps): MemoryService {
  const store: MemoryStore = deps.store
  const searchIndex: SearchIndex = deps.search
  const conflictPolicy = deps.conflictPolicy ?? 'caller'
  const coreTopicPrefixes = deps.coreTopicPrefixes ?? []
  const coreRecallLimit =
    typeof deps.coreRecallLimit === 'number' && deps.coreRecallLimit > 0
      ? Math.trunc(deps.coreRecallLimit)
      : DEFAULT_CORE_RECALL_LIMIT

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
   * 本地最大相似项（跨主题）。索引可能滞后、分数尺度也不透明，所以写入去重
   * 以本地文本相似度为准，不再用检索分数直接做门槛。
   */
  function findLocalSimilar(
    all: readonly MemoryRecord[],
    statement: string,
    topic: string,
  ): { record: MemoryRecord; similarity: number } | undefined {
    let best: { record: MemoryRecord; similarity: number } | undefined
    for (const record of all) {
      if (record.topic === topic) continue
      const similarity = statementSimilarity(statement, record.statement)
      if (similarity < LOCAL_DUPLICATE_SIMILARITY) continue
      if (best === undefined || similarity > best.similarity) {
        best = { record, similarity }
      }
    }
    return best
  }

  /**
   * 跨 topic 检索候选：检索只负责召回，是否算重复由文本相似度判定。
   * 检索不可用（本地无绑定 / 限流）时视为无候选，不阻塞写入。
   */
  async function findNearDuplicate(
    statement: string,
    topic: string,
  ): Promise<{ hit: SearchHit; similarity: number } | undefined> {
    let hits: SearchHit[]
    try {
      hits = await searchIndex.search(statement, { limit: 3 })
    } catch {
      return undefined
    }
    let best: { hit: SearchHit; similarity: number } | undefined
    for (const hit of hits) {
      if (hit.topic === topic) continue
      const similarity = statementSimilarity(statement, hitStatementText(hit.statement))
      if (similarity < SEARCH_DUPLICATE_SIMILARITY) continue
      if (best === undefined || similarity > best.similarity) {
        best = { hit, similarity }
      }
    }
    return best
  }

  /**
   * 主题树内的重复检查：父 / 子主题之间不应出现同一条陈述。
   * 同 topic 的相同陈述已在 `unchanged` 分支处理，这里只看父 / 子主题。
   */
  function findRelatedStatement(
    all: readonly MemoryRecord[],
    statement: string,
    topic: string,
  ): MemoryRecord | undefined {
    const normalized = normalizeStatement(statement)
    return all.find(
      (record) =>
        record.topic !== topic &&
        (isWithinTopic(record.topic, topic) || isWithinTopic(topic, record.topic)) &&
        normalizeStatement(record.statement) === normalized,
    )
  }

  /** 数据里是否存在以 `topic.` 开头的主题；有子主题的 topic 是分类，不是槽位。 */
  function hasChildTopics(all: readonly MemoryRecord[], topic: string): boolean {
    return all.some(
      (record) => record.topic !== topic && record.topic.startsWith(`${topic}.`),
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
    if (!isValidTopicId(topic)) {
      return {
        status: 'invalid_topic',
        message:
          `topic「${String(input.topic)}」不符合语法：小写字母 / 数字 / 连字符，点分最多 ${MAX_TOPIC_SEGMENTS} 段；` +
          '例如 identity.role、project.smriti.stack。主题会在首次写入时自动创建。',
      }
    }

    const rawLabel = typeof input.topicLabel === 'string' ? input.topicLabel.trim() : ''
    const topicLabel = rawLabel === '' ? undefined : rawLabel.slice(0, 80)

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

    // 一次全量读取同时支撑「同主题去重 / 父子去重 / 叶子判定 / 跨主题精确兜底」。
    const all = await store.listActive()
    const active = all.filter((record) => record.topic === topic)
    const hash = statementHash(statement)
    const same = active.find(
      (record) => statementHash(normalizeStatement(record.statement)) === hash,
    )
    if (same) {
      return { status: 'unchanged', memory: same, message: '同 topic 已有相同陈述' }
    }

    // 主题树内（父 / 子主题）已有同一条陈述时视为已记住，避免同一偏好在不同粒度重复落库。
    const related = findRelatedStatement(all, statement, topic)
    if (related) {
      return {
        status: 'unchanged',
        memory: related,
        message: `主题 ${related.topic} 已有相同陈述`,
      }
    }

    const at = now().toISOString()
    const proposed: PendingChange['proposed'] = {
      statement,
      ...(input.rationale !== undefined ? { rationale: input.rationale } : {}),
      confidence: input.confidence ?? DEFAULT_CONFIDENCE,
      ...(input.source !== undefined ? { source: input.source } : {}),
      ...(topicLabel !== undefined ? { topicLabel } : {}),
    }

    const current = pickLatest(active)
    // 没有子主题的 topic 是槽位：已有不同陈述时进待裁决（或按 auto 策略自动生效）；
    // 一旦有子主题（例如写过 code.style.indent），code.style 变成分类，可容纳多条。
    if (current && !hasChildTopics(all, topic)) {
      if (conflictPolicy === 'server') {
        const record: MemoryRecord = {
          id: nextRecordId(),
          topic,
          ...(topicLabel !== undefined ? { topicLabel } : {}),
          statement,
          ...(input.rationale !== undefined ? { rationale: input.rationale } : {}),
          confidence: proposed.confidence,
          ...(input.source !== undefined ? { source: input.source } : {}),
          createdAt: at,
          updatedAt: at,
          version: current.version + 1,
          supersedes: current.id,
          validFrom: at,
        }
        // 与 approve 相同的顺序：先落新记录，再把旧版移入 history（可 restore 回滚）。
        await store.putActive(record, renderBody(record.statement, record.rationale))
        await store.moveToHistory(topic, current.id, `superseded by ${record.id} (auto)`)
        await store.appendJournal({
          at,
          action: 'apply',
          topic,
          id: record.id,
          detail: `auto v${record.version} supersedes ${current.id}`,
        })
        return { status: 'applied', memory: record, autoApplied: true }
      }

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
      return {
        status: 'pending_review',
        change,
        message:
          conflictPolicy === 'caller'
            ? '槽位冲突：请调用 memory_resolve（replace / merge / keep）裁决，不要转交人工'
            : '槽位冲突：等待人工 approve / reject',
      }
    }

    // 本地相似度先行：索引可能滞后，文本相似度也更确定；检索只作为语义召回补充。
    const localNear = findLocalSimilar(all, statement, topic)
    if (localNear) {
      if (conflictPolicy === 'server') {
        await store.appendJournal({
          at,
          action: 'reject',
          topic,
          detail: `dedupe:${localNear.record.id} 本地相似 ${localNear.similarity.toFixed(2)}`,
        })
        return {
          status: 'unchanged',
          memory: localNear.record,
          message: '已存在相似记忆，跳过写入',
        }
      }
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
        detail: `pending:possible-duplicate 本地相似 ${localNear.similarity.toFixed(2)} ${localNear.record.id}（topic=${localNear.record.topic}）`,
      })
      return {
        status: 'pending_review',
        change,
        message:
          conflictPolicy === 'caller'
            ? '疑似重复：请调用 memory_resolve（replace / merge / keep）裁决，不要转交人工'
            : '疑似重复：等待人工 approve / reject',
      }
    }

    const near = await findNearDuplicate(statement, topic)
    if (near) {
      if (conflictPolicy === 'server') {
        await store.appendJournal({
          at,
          action: 'reject',
          topic,
          detail: `dedupe:${near.hit.id} 检索相似 ${near.similarity.toFixed(2)}`,
        })
        return { status: 'unchanged', message: '已存在相似记忆，跳过写入' }
      }
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
        detail: `pending:possible-duplicate 检索相似 ${near.similarity.toFixed(2)} ${near.hit.id}（score=${near.hit.score.toFixed(2)}）`,
      })
      return {
        status: 'pending_review',
        change,
        message:
          conflictPolicy === 'caller'
            ? '疑似重复：请调用 memory_resolve（replace / merge / keep）裁决，不要转交人工'
            : '疑似重复：等待人工 approve / reject',
      }
    }

    const record: MemoryRecord = {
      id: nextRecordId(),
      topic,
      ...(topicLabel !== undefined ? { topicLabel } : {}),
      statement,
      ...(input.rationale !== undefined ? { rationale: input.rationale } : {}),
      confidence: proposed.confidence,
      ...(input.source !== undefined ? { source: input.source } : {}),
      createdAt: at,
      updatedAt: at,
      version: 1,
      supersedes: null,
      validFrom: at,
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
    const all = await store.listActive()
    if (topic === undefined) return all
    return all.filter((record) => isWithinTopic(record.topic, topic))
  }

  async function search(
    query: string,
    options?: { limit?: number; topic?: string },
  ): Promise<SearchHit[]> {
    const limit = options?.limit ?? DEFAULT_SEARCH_LIMIT
    if (!Number.isFinite(limit) || limit <= 0) return []
    const max = Math.trunc(limit)
    const topic = options?.topic
    if (topic === undefined) return searchIndex.search(query, { limit: max })

    // 有子主题的 topic 是分类：索引的 filter 只能精确匹配，先在内存里按子树过滤。
    const all = await store.listActive()
    const isCollection = all.some(
      (record) => record.topic !== topic && record.topic.startsWith(`${topic}.`),
    )
    if (!isCollection) return searchIndex.search(query, { limit: max, topic })
    const expanded = Math.min(200, Math.max(max * 5, max + 10))
    const hits = await searchIndex.search(query, { limit: expanded })
    return hits.filter((hit) => isWithinTopic(hit.topic, topic)).slice(0, max)
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
    const direct = new Map<string, { count: number; label?: string; labelAt: string }>()
    for (const record of all) {
      const entry = direct.get(record.topic) ?? { count: 0, labelAt: '' }
      entry.count += 1
      // 同一主题的展示名以最近一次带 label 的写入为准。
      if (record.topicLabel !== undefined && record.updatedAt >= entry.labelAt) {
        entry.label = record.topicLabel
        entry.labelAt = record.updatedAt
      }
      direct.set(record.topic, entry)
    }

    // 只写过子主题时，父主题没有直接记录；仍把它合成为树节点，
    // 让 UI/命令能展示层级，而不是把子主题都挂在根上。
    const known = new Set<string>(direct.keys())
    for (const topic of direct.keys()) {
      let cursor = parentOf(topic)
      while (cursor !== undefined) {
        known.add(cursor)
        cursor = parentOf(cursor)
      }
    }

    const summaries: TopicSummary[] = []
    for (const topic of known) {
      let count = 0
      for (const [other, otherEntry] of direct) {
        if (isWithinTopic(other, topic)) count += otherEntry.count
      }
      // 父主题取数据/合成节点里最近的祖先。
      let parent: string | null = null
      let cursor = parentOf(topic)
      while (cursor !== undefined) {
        if (known.has(cursor)) {
          parent = cursor
          break
        }
        cursor = parentOf(cursor)
      }
      const entry = direct.get(topic)
      summaries.push({
        topic,
        label: entry?.label ?? labelForTopic(topic),
        description: descriptionForTopic(topic),
        parent,
        depth: topicDepth(topic),
        count,
        directCount: entry?.count ?? 0,
      })
    }
    return summaries.sort((left, right) => left.topic.localeCompare(right.topic))
  }

  const recall = createRecall({
    store,
    search: searchIndex,
    coreTopicPrefixes,
    coreLimit: coreRecallLimit,
  })

  async function pending(): Promise<PendingChange[]> {
    return store.listPending()
  }

  /**
   * 历史 / 时间点查询。
   * - 不传 `at`：返回归档记录（被取代或删除的版本），按失效时间倒序；
   * - 传 `at`：返回该时刻有效的事实（active 与 history 合并后按 validFrom/validTo 过滤）。
   */
  async function history(
    options: { topic?: string; at?: string; limit?: number } = {},
  ): Promise<ArchivedRecord[]> {
    const limit = options.limit ?? 100
    if (!Number.isFinite(limit) || limit <= 0) return []
    const max = Math.trunc(limit)
    const { topic } = options

    if (options.at !== undefined) {
      const instant = Date.parse(options.at)
      if (Number.isNaN(instant)) return []
      const [active, archived] = await Promise.all([
        store.listActive(topic),
        store.listHistory(topic),
      ])
      const items: ArchivedRecord[] = [
        ...archived,
        ...active.map((record) => ({ ...record })),
      ]
      return items
        .filter((record) => validAt(record, instant))
        .sort(
          (left, right) =>
            (left.validFrom ?? left.createdAt).localeCompare(
              right.validFrom ?? right.createdAt,
            ) || left.topic.localeCompare(right.topic),
        )
        .slice(0, max)
    }

    const archived = await store.listHistory(topic)
    return archived.slice(0, max)
  }

  /**
   * 回滚：把一条归档记录恢复为现行版本。
   * 恢复的记录版本号 +1、`supersedes` 指向当前 active；当前 active 被移入 history。
   */
  async function restore(topic: string, id: string): Promise<MemoryRecord | null> {
    const archived = await store.getHistory(topic, id)
    if (archived === null) return null

    const at = now().toISOString()
    const active = await store.listActive(topic)
    const current = pickLatest(active)
    const record: MemoryRecord = {
      id: nextRecordId(),
      topic,
      ...(archived.topicLabel !== undefined ? { topicLabel: archived.topicLabel } : {}),
      statement: archived.statement,
      ...(archived.rationale !== undefined ? { rationale: archived.rationale } : {}),
      confidence: archived.confidence,
      ...(archived.source !== undefined ? { source: archived.source } : {}),
      createdAt: at,
      updatedAt: at,
      version: current ? current.version + 1 : Math.max(1, archived.version + 1),
      supersedes: current ? current.id : null,
      validFrom: at,
    }

    await store.putActive(record, renderBody(record.statement, record.rationale))
    if (current) {
      await store.moveToHistory(topic, current.id, `superseded by restore ${record.id}`)
    }
    await store.deleteHistory(topic, id)
    await store.appendJournal({
      at,
      action: 'restore',
      topic,
      id: record.id,
      detail: `restored ${id} as v${record.version}`,
    })
    return record
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

  /**
   * 调用方模型裁决：replace / merge / keep。
   * 裁决立即生效、不留人工队列：
   * - replace：提议取代现行（旧版进 history，可 restore）；
   * - merge：把提议与现行合并成一条新陈述（必须提供 statement）；
   * - keep：保留现行、丢弃提议，记 journal。
   */
  async function resolve(changeId: string, input: ResolutionInput): Promise<UpsertResult> {
    const change = await store.getPending(changeId)
    if (!change) {
      return { status: 'rejected', message: `待裁决变更不存在：${changeId}` }
    }

    const at = now().toISOString()

    if (input.decision === 'keep') {
      await store.deletePending(changeId)
      await store.appendJournal({
        at,
        action: 'reject',
        topic: change.topic,
        changeId,
        detail: `resolve:keep${input.reason !== undefined ? ` ${input.reason}` : ''}`,
      })
      return {
        status: 'unchanged',
        ...(change.current !== null ? { memory: change.current } : {}),
        message: '按裁决保留现状，丢弃提议',
        resolved: 'keep',
      }
    }

    const merged = input.decision === 'merge' ? normalizeStatement(input.statement ?? '') : ''
    if (input.decision === 'merge' && merged === '') {
      return { status: 'rejected', message: 'merge 必须提供非空 statement' }
    }

    const current = change.current
    const record: MemoryRecord = {
      id: nextRecordId(),
      topic: change.topic,
      ...(change.proposed.topicLabel !== undefined
        ? { topicLabel: change.proposed.topicLabel }
        : {}),
      statement: input.decision === 'merge' ? merged : change.proposed.statement,
      ...(input.rationale !== undefined
        ? { rationale: input.rationale }
        : change.proposed.rationale !== undefined
          ? { rationale: change.proposed.rationale }
          : {}),
      confidence: change.proposed.confidence ?? DEFAULT_CONFIDENCE,
      ...(change.proposed.source !== undefined ? { source: change.proposed.source } : {}),
      createdAt: at,
      updatedAt: at,
      version: current ? current.version + 1 : 1,
      supersedes: current ? current.id : null,
      validFrom: at,
    }

    await store.putActive(record, renderBody(record.statement, record.rationale))
    if (current) {
      await store.moveToHistory(
        change.topic,
        current.id,
        `superseded by resolve:${input.decision} ${changeId}`,
      )
    }
    await store.deletePending(changeId)
    await store.appendJournal({
      at,
      action: 'apply',
      topic: change.topic,
      id: record.id,
      changeId,
      detail: `resolve:${input.decision} v${record.version}${input.reason !== undefined ? ` ${input.reason}` : ''}`,
    })
    return { status: 'applied', memory: record, resolved: input.decision }
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
      ...(change.proposed.topicLabel !== undefined
        ? { topicLabel: change.proposed.topicLabel }
        : {}),
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
      validFrom: at,
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
          ...(candidate.topicLabel !== undefined ? { topicLabel: candidate.topicLabel } : {}),
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
    history,
    restore,
    approve,
    reject,
    resolve,
    extract,
  }
}

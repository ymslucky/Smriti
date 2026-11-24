/** 共享值类型：R2 中的偏好记录、待裁决变更、检索命中。 */

export type IsoDate = string

export interface MemorySource {
  session?: string
  message?: string
}

export interface MemoryRecord {
  id: string
  topic: string
  statement: string
  rationale?: string
  confidence: number
  source?: MemorySource
  createdAt: IsoDate
  updatedAt: IsoDate
  version: number
  supersedes?: string | null
}

export type PendingKind = 'conflict' | 'possible-duplicate' | 'new-topic'

export interface PendingChange {
  changeId: string
  kind: PendingKind
  topic: string
  current: MemoryRecord | null
  proposed: {
    statement: string
    rationale?: string
    confidence: number
    source?: MemorySource
  }
  idempotencyKey?: string
  createdAt: IsoDate
}

export interface SearchHit {
  id: string
  topic: string
  statement: string
  rationale?: string
  score: number
}

/**
 * 检索后端（AI Search）的可达性。
 *
 * `instance` 是**实际使用**的实例名：配置名不存在但命名空间里只有一个实例时，
 * 实现会自动切到那个实例，这里回报的就是它，便于运维对齐配置。
 */
export interface SearchHealth {
  ok: boolean
  instance: string
  /** 失败原因（面向人排障）；ok 为 true 时不出现。 */
  reason?: string
  /** 本次探活时间（ISO 字符串），缓存命中时不刷新。 */
  checkedAt?: IsoDate
}

export interface JournalEvent {
  at: IsoDate
  action: 'upsert' | 'apply' | 'reject' | 'forget' | 'recall' | 'extract' | 'cleanup'
  topic?: string
  id?: string
  changeId?: string
  detail?: string
}

export type UpsertStatus =
  | 'applied'
  | 'unchanged'
  | 'pending_review'
  | 'rejected'
  | 'unknown_topic'

export interface UpsertResult {
  status: UpsertStatus
  memory?: MemoryRecord
  change?: PendingChange
  message?: string
}

export interface RecallItem {
  id: string
  topic: string
  statement: string
}

export interface ExtractCandidate {
  topic: string
  statement: string
  rationale?: string
  confidence: number
  source?: MemorySource
}

export interface TopicSummary {
  topic: string
  label: string
  description: string
  count: number
}

export interface UpsertInput {
  topic: string
  statement: string
  rationale?: string
  confidence?: number
  source?: MemorySource
  idempotencyKey?: string
}


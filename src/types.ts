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


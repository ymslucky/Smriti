/** 模块契约：存储、检索与记忆服务。各实现只依赖这里的窄接口，便于测试替身。 */

import type {
  ExtractCandidate,
  JournalEvent,
  MemoryRecord,
  PendingChange,
  RecallItem,
  SearchHit,
  TopicSummary,
  UpsertInput,
  UpsertResult,
} from './types'

export type { UpsertInput } from './types'


export interface R2ObjectLike {
  text(): Promise<string>
  customMetadata?: Record<string, string>
}

export interface R2ListLike {
  objects: { key: string; uploaded?: Date }[]
  truncated?: boolean
  cursor?: string
}

export interface R2Like {
  get(key: string): Promise<R2ObjectLike | null>
  put(
    key: string,
    value: string,
    options?: { customMetadata?: Record<string, string> },
  ): Promise<unknown>
  delete(key: string): Promise<void>
  list(options: { prefix: string; cursor?: string }): Promise<R2ListLike>
}

export interface SearchIndex {
  search(query: string, options: { limit: number; topic?: string }): Promise<SearchHit[]>
  sync(): Promise<void>
}

export interface MemoryStore {
  putActive(record: MemoryRecord, body: string): Promise<void>
  getActive(topic: string, id: string): Promise<MemoryRecord | null>
  listActive(topic?: string): Promise<MemoryRecord[]>
  moveToHistory(topic: string, id: string, reason: string): Promise<void>
  putPending(change: PendingChange): Promise<void>
  getPending(changeId: string): Promise<PendingChange | null>
  listPending(): Promise<PendingChange[]>
  deletePending(changeId: string): Promise<void>
  appendJournal(event: JournalEvent): Promise<void>
  cleanupHistory(before: Date): Promise<number>
  recent(limit: number): Promise<MemoryRecord[]>
}

export interface MemoryService {
  upsert(input: UpsertInput): Promise<UpsertResult>
  get(topic: string, id: string): Promise<MemoryRecord | null>
  list(topic?: string): Promise<MemoryRecord[]>
  search(query: string, options?: { limit?: number; topic?: string }): Promise<SearchHit[]>
  forget(topic: string, id: string, reason: string): Promise<boolean>
  topics(): Promise<TopicSummary[]>
  recall(query: string, limit: number): Promise<RecallItem[]>
  pending(): Promise<PendingChange[]>
  approve(changeId: string): Promise<UpsertResult>
  reject(changeId: string, reason: string): Promise<boolean>
  extract(candidates: ExtractCandidate[]): Promise<UpsertResult[]>
}

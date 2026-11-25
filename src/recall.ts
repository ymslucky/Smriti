/**
 * 召回组合：AI Search 混合检索优先，`store.recent()` 兜底。
 *
 * 召回位于对话关键路径上，检索失败不能让对话失败：search 抛错时退化为只返回
 * 最近记忆。检索命中不直接采信索引里的文本（索引存在同步延迟，可能指向已删除或
 * 旧版本记录）：默认按 `store.getActive` 水合，以 R2 最新记录为准，记录已不存在则
 * 丢弃该命中。合并按 id 去重，检索命中排在前面（更新的判断由检索分数与写入顺序
 * 决定），最终截断到 limit。`recent()` 本身就是从 R2 读取的最新记录，无需水合。
 */

import type { MemoryStore, SearchIndex } from './contracts'
import { labelForTopic } from './topics'
import type { MemoryRecord, RecallItem, SearchHit } from './types'

export interface RecallDeps {
  store: MemoryStore
  search: SearchIndex
  /**
   * 是否按 `store.getActive` 水合检索命中，默认 `true`。
   * 仅在已知索引与 R2 一致（测试 / 离线场景）时关闭，避免无谓的逐条 R2 读取。
   */
  hydrate?: boolean
  /** 常驻（core）记忆的主题前缀；命中的记录每次召回都会排在最前面。 */
  coreTopicPrefixes?: readonly string[]
  /** 最多带几条 core 记忆，默认 5。 */
  coreLimit?: number
}

const DEFAULT_CORE_LIMIT = 5

/** 主题是否落在任一 core 前缀下（含前缀本身）。 */
function isCoreTopic(topic: string, prefixes: readonly string[]): boolean {
  return prefixes.some(
    (prefix) => topic === prefix || topic.startsWith(`${prefix}.`),
  )
}

export function createRecall(
  deps: RecallDeps,
): (query: string, limit: number) => Promise<RecallItem[]> {
  const hydrate = deps.hydrate !== false
  const corePrefixes = deps.coreTopicPrefixes ?? []
  const coreLimit =
    typeof deps.coreLimit === 'number' && deps.coreLimit > 0
      ? Math.trunc(deps.coreLimit)
      : DEFAULT_CORE_LIMIT

  /**
   * 命中 → R2 最新记录。记录已删除返回 null；单条读取失败（索引脏 id 等）
   * 同样丢弃该命中，不让召回整体失败。
   */
  async function loadActive(hit: SearchHit): Promise<MemoryRecord | null> {
    try {
      return await deps.store.getActive(hit.topic, hit.id)
    } catch {
      return null
    }
  }

  return async (query, limit) => {
    if (!Number.isFinite(limit) || limit <= 0) return []

    const items: RecallItem[] = []
    const seen = new Set<string>()
    const push = (item: RecallItem): void => {
      if (seen.has(item.id)) return
      seen.add(item.id)
      items.push(item)
    }

    // 常驻记忆（角色 / 语言 / 硬约束）先于检索命中，保证每次都有上下文。
    if (corePrefixes.length > 0) {
      const all = await deps.store.listActive()
      const core = all
        .filter((record) => isCoreTopic(record.topic, corePrefixes))
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        .slice(0, coreLimit)
      for (const record of core) {
        push({
          id: record.id,
          topic: record.topic,
          topicLabel: record.topicLabel ?? labelForTopic(record.topic),
          statement: record.statement,
          core: true,
        })
      }
    }

    let hits: SearchHit[] = []
    try {
      hits = await deps.search.search(query, { limit })
    } catch (error) {
      // 检索不可用（本地无绑定、AI Search 限流/故障）时继续走 recent 兜底，
      // 但必须留痕：否则线上会静默退化成"最近 N 条"，语义检索失效却没人发现。
      console.error(
        'smriti: recall 降级为 recent 兜底，检索后端不可用：',
        error instanceof Error ? error.message : String(error),
      )
      hits = []
    }

    const recent = await deps.store.recent(limit)

    for (const hit of hits) {
      if (!hydrate) {
        push({
          id: hit.id,
          topic: hit.topic,
          topicLabel: labelForTopic(hit.topic),
          statement: hit.statement,
        })
        continue
      }
      const record = await loadActive(hit)
      if (record === null) continue
      push({
        id: record.id,
        topic: record.topic,
        topicLabel: record.topicLabel ?? labelForTopic(record.topic),
        statement: record.statement,
      })
    }
    for (const record of recent) {
      push({
        id: record.id,
        topic: record.topic,
        topicLabel: record.topicLabel ?? labelForTopic(record.topic),
        statement: record.statement,
      })
    }

    return items.slice(0, limit)
  }
}

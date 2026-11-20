/**
 * Cloudflare AI Search 检索实现。
 *
 * AI Search（R2 数据源）真实命中的形状是：
 * `{ id, type, score, text, item: { key }, scoring_details }`——R2 key 在
 * `item.key` 里，而不是顶层 `key`。这里同时兼容顶层 `key`（旧版本/测试替身）。
 *
 * key 的两种形态都接受：
 * - 完整 R2 key：`memories/active/{topic}/{id}.md`
 * - 裸 key：`{topic}/{id}.md`（数据源去掉了 `memories/active/` 前缀时）
 *
 * 防御式收敛：`text` 必须是字符串；topic 必须匹配 `^[a-z0-9._-]+$` 且不是
 * `.`/`..`；id 必须是单段安全路径片段。任一不合法就跳过该项，绝不把原始响应
 * 透传给上层。score 缺失或非法记 0，避免 NaN 污染排序。绑定缺失（本地开发、
 * 免费额度耗尽）时降级为空结果。
 */

import type { SearchIndex } from '../contracts'
import type { AiSearchBinding, AiSearchInstance } from '../env'
import type { SearchHit } from '../types'

export interface AiSearchOptions {
  /** AI Search 实例名，对应 `AI_SEARCH_INSTANCE`（wrangler 中为 `memory`）。 */
  instance: string
  /** 数据源同步间隔（秒），由 Worker / cron 侧调度；此处保留配置以便透传。 */
  syncIntervalSeconds?: number
}

/** AI Search 实例上可能存在的索引任务触发器（无类型定义，按需探测）。 */
interface AiSearchJobRunner {
  create(input?: unknown): Promise<unknown>
}

interface AiSearchInstanceWithJobs extends AiSearchInstance {
  jobs?: AiSearchJobRunner
}

/** R2 真源前缀：只有 `memories/active/**` 会被 AI Search 索引。 */
const ACTIVE_PREFIX = 'memories/active/'
/** 与写入侧（storage/r2-store.ts）保持一致的 topic 约束。 */
const TOPIC_PATTERN = /^[a-z0-9._-]+$/
/** id 必须是单段安全路径片段，禁止分隔符、控制字符与尾随点段。 */
const UNSAFE_SEGMENT = /[\/\\\u0000-\u001f\u007f]/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** 取出响应中的结果数组；无法识别时返回空数组。 */
function extractItems(response: unknown): unknown[] {
  if (Array.isArray(response)) return response
  if (!isRecord(response)) return []
  if (Array.isArray(response.chunks)) return response.chunks
  if (Array.isArray(response.data)) return response.data
  return []
}

/** score 可能是数字或数字字符串；缺失/非法时退化为 0，避免 NaN 污染排序。 */
function toScore(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return 0
}

/** 把 `{topic}/{id}.md` 形式的相对 key 拆成 topic/id；任何一段非法就返回 undefined。 */
function parseTopicAndId(relative: string): { topic: string; id: string } | undefined {
  if (!relative.endsWith('.md')) return undefined
  const body = relative.slice(0, -'.md'.length)
  const slash = body.indexOf('/')
  if (slash <= 0 || slash === body.length - 1) return undefined
  const topic = body.slice(0, slash)
  const id = body.slice(slash + 1)
  if (!TOPIC_PATTERN.test(topic) || topic === '.' || topic === '..') return undefined
  if (id === '.' || id === '..' || UNSAFE_SEGMENT.test(id)) return undefined
  return { topic, id }
}

/** 从 R2 key 解析 topic 与 id；先认完整 active 路径，再认裸 `{topic}/{id}.md`。 */
function parseKey(value: unknown): { topic: string; id: string } | undefined {
  if (typeof value !== 'string') return undefined
  const key = value.trim()
  if (key === '') return undefined
  if (key.startsWith(ACTIVE_PREFIX)) {
    return parseTopicAndId(key.slice(ACTIVE_PREFIX.length))
  }
  // 裸 key 只接受恰好两段，避免把 `memories/_history/...` 之类误当 active 命中。
  if (key.split('/').length !== 2) return undefined
  return parseTopicAndId(key)
}

/**
 * 真实响应把 R2 key 放在 `item.key`；旧响应/测试替身放在顶层 `key`。
 * 优先 `item.key`，解析失败再尝试顶层 `key`；两者都不合法才丢弃。
 */
function resolveKey(item: Record<string, unknown>): { topic: string; id: string } | undefined {
  if (isRecord(item.item)) {
    const nested = parseKey(item.item.key)
    if (nested) return nested
  }
  return parseKey(item.key)
}

function toHit(item: unknown): SearchHit | undefined {
  if (!isRecord(item)) return undefined
  const parsed = resolveKey(item)
  if (!parsed) return undefined
  if (typeof item.text !== 'string') return undefined
  return {
    id: parsed.id,
    topic: parsed.topic,
    statement: item.text,
    score: toScore(item.score),
  }
}

/** AI Search 限流以 HTTP 429 的形式抛出，具体挂载字段因运行时而异。 */
function isRateLimited(error: unknown): boolean {
  if (isRecord(error)) {
    const status = error.status ?? error.statusCode ?? error.code
    if (status === 429 || status === '429') return true
  }
  if (error instanceof Error && error.message.includes('429')) return true
  return typeof error === 'string' && error.includes('429')
}

export function createAiSearch(
  binding: AiSearchBinding | undefined,
  options: AiSearchOptions,
): SearchIndex {
  function instance(): AiSearchInstance | undefined {
    if (!binding) return undefined
    return binding.get(options.instance) ?? undefined
  }

  return {
    async search(query, { limit, topic }): Promise<SearchHit[]> {
      const target = instance()
      if (!target) return []

      const response = await target.search({
        messages: [{ role: 'user', content: query }],
        ai_search_options: {
          retrieval: {
            max_num_results: limit,
            filters: topic ? { topic } : undefined,
          },
        },
      })

      const hits: SearchHit[] = []
      for (const item of extractItems(response)) {
        const hit = toHit(item)
        if (hit) hits.push(hit)
      }
      return hits
    },

    async sync(): Promise<void> {
      const target = instance()
      if (!target) return

      const jobs = (target as AiSearchInstanceWithJobs).jobs
      if (!jobs || typeof jobs.create !== 'function') return

      try {
        await jobs.create()
      } catch (error) {
        // 429 表示刚同步过或配额受限，交给下一次 cron 重试即可。
        if (isRateLimited(error)) return
        throw error
      }
    },
  }
}

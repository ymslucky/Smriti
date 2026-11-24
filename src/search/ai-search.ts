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
 *
 * ## 实例解析与降级（线上踩过的坑）
 *
 * `AI_SEARCH.get(name)` 只做本地代理，**不会**校验实例是否存在；实例不存在时
 * 错误要等到 `search()` 才以 `ai_search_not_found` 抛出。旧实现只判了
 * "绑定是否存在"，于是线上表现为：库里有数据、`memory_search` 却直接报错，
 * 而 `/v1/stats` 的 `health.aiSearch` 仍显示 `true`。
 *
 * 现在的策略：
 * - 解析实例名前先看命名空间的实例列表；配置名不存在但**只剩一个**实例时自动
 *   改用它（写一条 warn），配置名与列表都不匹配时明确降级（空结果 + 一条
 *   error 日志），而不是把异常抛出到调用方；
 * - `health()` 做真实探活（列表 / `info()`）并按 `healthTtlMs` 缓存，供
 *   `/v1/stats` 与 MCP 的 `memory_search` 暴露真实状态。
 */

import type { SearchIndex } from '../contracts'
import type { AiSearchBinding, AiSearchInstance } from '../env'
import type { SearchHealth, SearchHit } from '../types'

export interface AiSearchOptions {
  /** AI Search 实例名，对应 `AI_SEARCH_INSTANCE`（wrangler 中为 `memory`）。 */
  instance: string
  /** 数据源同步间隔（秒），由 Worker / cron 侧调度；此处保留配置以便透传。 */
  syncIntervalSeconds?: number
  /** `health()` 结果缓存时长，默认 60s，避免 `/v1/stats` 每刷一次就打一次 API。 */
  healthTtlMs?: number
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
/** AI Search 的"实例不存在"错误码：7002 命名空间内不存在，60013 公开端点白名单为空。 */
const NOT_FOUND_CODES = new Set<unknown>([7002, 60013, 'ai_search_not_found'])
/** `ai_search_not_found` 在不同运行时里挂在 name / message 上。 */
const NOT_FOUND_HINTS = /ai_search_not_found|AiSearchNotFound|AutoRAGNotFound/i
const DEFAULT_HEALTH_TTL_MS = 60_000

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** 把 unknown 错误转成可读的一行，避免日志里出现 `[object Object]`。 */
function describeError(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  if (isRecord(error) && typeof error.message === 'string') return error.message
  return String(error)
}

/** 是否属于"实例不存在"这一类可降级的错误。 */
function isNotFound(error: unknown): boolean {
  if (typeof error === 'string') return NOT_FOUND_HINTS.test(error)
  if (!isRecord(error)) return false
  if (NOT_FOUND_CODES.has(error.code)) return true
  if (typeof error.name === 'string' && NOT_FOUND_HINTS.test(error.name)) return true
  return typeof error.message === 'string' && NOT_FOUND_HINTS.test(error.message)
}

/** 从命名空间列表响应里取出实例 id；兼容 `{result:[…]}`、`{instances:[…]}` 与裸数组。 */
function instanceIds(response: unknown): string[] {
  const raw = Array.isArray(response)
    ? response
    : isRecord(response) && Array.isArray(response.result)
      ? response.result
      : isRecord(response) && Array.isArray(response.instances)
        ? response.instances
        : []
  const ids: string[] = []
  for (const item of raw) {
    if (!isRecord(item)) continue
    const id =
      typeof item.id === 'string' && item.id !== ''
        ? item.id
        : typeof item.name === 'string' && item.name !== ''
          ? item.name
          : undefined
    if (id !== undefined && !ids.includes(id)) ids.push(id)
  }
  return ids
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
  const configured = options.instance
  const healthTtlMs = options.healthTtlMs ?? DEFAULT_HEALTH_TTL_MS

  /** 解析成功（或乐观假定）的实例名；实例出错时清空以触发重解析。 */
  let activeName: string | undefined
  /** 最近一次解析失败的说明，用于 health 与日志。 */
  let lastReason: string | undefined
  /** 只报一次错，避免每个请求刷一条日志（isolate 生命周期内）。 */
  let reported = false
  let probe: { at: number; value: SearchHealth } | undefined

  function noteUnavailable(reason: string | undefined): void {
    if (reason !== undefined) lastReason = reason
    if (reported) return
    reported = true
    console.error(
      `smriti: AI Search 不可用，检索降级为空结果（实例 "${configured}"）。` +
        (lastReason !== undefined ? ` ${lastReason}` : ''),
    )
  }

  /** 列举命名空间里的实例 id；绑定/方法缺失或调用失败时返回 undefined（=无法枚举）。 */
  async function listInstances(): Promise<string[] | undefined> {
    if (!binding || typeof binding.list !== 'function') return undefined
    try {
      return instanceIds(await binding.list())
    } catch (error) {
      console.error('smriti: 列举 AI Search 实例失败：', describeError(error))
      return undefined
    }
  }

  /**
   * 解析实际要用的实例名。
   * - 配置名在列表里 → 用它；
   * - 配置名不在、列表里恰好一个实例 → 自动改用它（自愈，写 warn）；
   * - 否则返回 undefined，并记下原因。
   * 无法列举时（测试替身/旧绑定）乐观返回配置名，交给真实调用暴露问题。
   */
  async function resolve(force = false): Promise<string | undefined> {
    if (!binding) return undefined
    if (!force && activeName !== undefined) return activeName

    const ids = await listInstances()
    if (ids === undefined) return configured

    if (ids.includes(configured)) {
      activeName = configured
      lastReason = undefined
      return activeName
    }
    if (ids.length === 1) {
      activeName = ids[0]
      console.warn(
        `smriti: 配置的 AI Search 实例 "${configured}" 不存在，自动改用命名空间里唯一的实例 "${ids[0]}"。`,
      )
      return activeName
    }
    activeName = undefined
    lastReason =
      ids.length === 0
        ? '命名空间里没有任何 AI Search 实例'
        : `配置的实例 "${configured}" 不存在；可见实例：${ids.join(', ')}`
    return undefined
  }

  async function runSearch(
    name: string,
    query: string,
    limit: number,
    topic: string | undefined,
  ): Promise<SearchHit[]> {
    const target = binding?.get(name) as AiSearchInstance | undefined
    if (!target || typeof target.search !== 'function') return []

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
  }

  /**
   * 真实探活。两个探针按"能证明什么"排序：
   * 1. 命名空间列表：能证明实例存在，也能发现改名/自愈；
   * 2. `info()`：列表不可用时的一级补充。
   * 两者都没有结果、且确实尝试过并失败时判为不健康（例如线上没有
   * `ai_search_namespaces` 权限、或实例真的不存在）；只有"探针根本不存在"
   * （测试替身）时才退回"绑定存在"的弱判断。
   */
  async function probeHealth(): Promise<SearchHealth> {
    const checkedAt = new Date().toISOString()
    if (!binding) {
      return {
        ok: false,
        instance: configured,
        reason: 'AI_SEARCH 绑定未配置（检查 wrangler.jsonc 的 ai_search_namespaces）',
        checkedAt,
      }
    }

    let name = activeName ?? configured
    let ids: string[] | undefined
    let listFailure: string | undefined

    if (typeof binding.list === 'function') {
      try {
        ids = instanceIds(await binding.list())
      } catch (error) {
        listFailure = describeError(error)
      }
    }

    if (ids !== undefined) {
      if (ids.includes(configured)) {
        name = configured
        activeName = name
        lastReason = undefined
      } else if (ids.length === 1) {
        name = ids[0]
        activeName = name
        lastReason = undefined
      } else {
        activeName = undefined
        lastReason =
          ids.length === 0
            ? '命名空间里没有任何 AI Search 实例'
            : `配置的实例 "${configured}" 不存在；可见实例：${ids.join(', ')}`
        return { ok: false, instance: configured, reason: lastReason, checkedAt }
      }
    }

    const target = binding.get(name) as AiSearchInstance | undefined
    if (!target) {
      return { ok: false, instance: name, reason: 'AI Search 实例句柄不可用', checkedAt }
    }

    if (typeof target.info === 'function') {
      try {
        await target.info()
        return { ok: true, instance: name, checkedAt }
      } catch (error) {
        // 列表已经证明实例存在时，info 的失败只当作降级信息，不判不健康；
        // 没有列表结果时，info 是唯一探针，失败才算不健康。
        if (ids !== undefined) {
          console.warn(
            'smriti: AI Search info() 探活失败（不影响实例存在性判断）：',
            describeError(error),
          )
          return { ok: true, instance: name, checkedAt }
        }
        return {
          ok: false,
          instance: name,
          reason: `info 探活失败：${describeError(error)}`,
          checkedAt,
        }
      }
    }

    if (listFailure !== undefined) {
      return { ok: false, instance: name, reason: `实例列表不可用：${listFailure}`, checkedAt }
    }
    // 没有可用的探针（测试替身/旧绑定）：只能弱判断为健康。
    return { ok: true, instance: name, checkedAt }
  }

  return {
    async search(query, { limit, topic }): Promise<SearchHit[]> {
      if (!binding) return []

      const name = await resolve()
      if (name === undefined) {
        noteUnavailable(lastReason)
        return []
      }

      try {
        return await runSearch(name, query, limit, topic)
      } catch (error) {
        if (!isNotFound(error)) throw error

        // 实例可能在解析之后被删/改名：清缓存、强制重解析，能自愈就重试一次。
        activeName = undefined
        probe = undefined
        const recovered = await resolve(true)
        if (recovered !== undefined && recovered !== name) {
          try {
            return await runSearch(recovered, query, limit, topic)
          } catch (retryError) {
            if (!isNotFound(retryError)) throw retryError
          }
        }
        noteUnavailable(lastReason ?? describeError(error))
        return []
      }
    },

    async sync(): Promise<void> {
      if (!binding) return

      const name = await resolve()
      if (name === undefined) {
        noteUnavailable(lastReason)
        return
      }

      const target = binding.get(name) as AiSearchInstance | undefined
      const jobs = (target as AiSearchInstanceWithJobs | undefined)?.jobs
      if (!jobs || typeof jobs.create !== 'function') return

      try {
        await jobs.create()
      } catch (error) {
        // 429 表示刚同步过或配额受限，交给下一次 cron 重试即可。
        if (isRateLimited(error)) return
        // 实例不存在时同步无意义，记一次日志后跳过，别让 cron 天天报错。
        if (isNotFound(error)) {
          activeName = undefined
          noteUnavailable(describeError(error))
          return
        }
        throw error
      }
    },

    async health(): Promise<SearchHealth> {
      const now = Date.now()
      if (probe !== undefined && now - probe.at < healthTtlMs) return probe.value

      const value = await probeHealth()
      probe = { at: now, value }
      return value
    },
  }
}

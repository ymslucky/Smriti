/**
 * Worker 入口：HTTP 请求走 `handle`，每日 cron 清理 30 天前的 history 并触发
 * AI Search 同步。
 */

import type { Env } from './env'
import { handle } from './http/app'
import { createAiSearch } from './search/ai-search'
import { createR2Store } from './storage/r2-store'

/** history 保留天数（与 docs/plan.md 一致）。 */
const HISTORY_RETENTION_DAYS = 30

const DAY_MS = 24 * 60 * 60 * 1000

export default {
  /** HTTP 请求全部透传给 `handle`（含 env.ASSETS 绑定）。 */
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return handle(request, env, ctx)
  },

  async scheduled(
    _event: ScheduledController,
    env: Env,
    _ctx: ExecutionContext,
  ): Promise<void> {
    const store = createR2Store(env.MEMORY)
    const before = new Date(Date.now() - HISTORY_RETENTION_DAYS * DAY_MS)
    const removed = await store.cleanupHistory(before)

    const search = createAiSearch(env.AI_SEARCH, {
      instance: env.AI_SEARCH_INSTANCE ?? 'memory',
    })
    await search.sync()

    console.log(
      `smriti cron: cleaned history older than ${before.toISOString()} (${removed} objects), search sync triggered`,
    )
  },
}

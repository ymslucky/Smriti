/**
 * Worker HTTP 入口：存活探针、`/v1` REST（含 WebUI 只读聚合 API）、`/ui`
 * 静态资源与 `/mcp`。
 *
 * 约定：
 * - 除 `GET /healthz` 外，所有路由先过 `authenticate`；
 * - 成功响应为 JSON，错误统一 `{ error: { code, message } }`；
 * - 未匹配的路由返回 404 JSON（含方法不匹配的情形）；
 * - 写入/裁决成功后由 `ctx.waitUntil` 异步同步 AI Search 索引（P0-3）。
 */

import { authenticate } from '../auth/access'
import { extractCandidates } from '../capture'
import type { SearchIndex } from '../contracts'
import type { AppDeps, Env } from '../env'
import { createMcpFetchHandler } from '../mcp/server'
import { createAiSearch } from '../search/ai-search'
import { createMemoryService } from '../service'
import { createR2Store } from '../storage/r2-store'
import { isKnownTopic } from '../topics'
import type { ExtractCandidate, MemorySource } from '../types'

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' }

const DEFAULT_RECALL_LIMIT = 10
const MAX_RECALL_LIMIT = 50
/** 候选未给出 confidence 时的默认值（与 service 的 DEFAULT_CONFIDENCE 一致）。 */
const DEFAULT_CANDIDATE_CONFIDENCE = 0.8
/** 单次 extract 最多写入的候选数，避免异常输入放大写入。 */
const MAX_EXTRACT_CANDIDATES = 20
/** `/v1/memories` 的 limit：默认 200、上限 500（与 docs/ui-plan.md 一致）。 */
const DEFAULT_MEMORIES_LIMIT = 200
const MAX_MEMORIES_LIMIT = 500
/** `/v1/stats` 概览中「最近更新」的条数。 */
const RECENT_MEMORY_LIMIT = 5
/** `/ui` 与 `/ui/` 映射到的入口文件。 */
const UI_INDEX_PATH = '/ui/index.html'

const PENDING_ACTION_ROUTE = /^\/v1\/pending\/([^/]+)\/(approve|reject)$/

/** 业务可预期的 4xx；由 handle 的顶层 catch 转成 JSON 错误。 */
class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'HttpError'
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS })
}

function jsonError(status: number, code: string, message: string): Response {
  return json({ error: { code, message } }, status)
}

/** 按项目模块工厂组装依赖；每个请求一份，薄封装后面可换成请求级缓存。 */
export function buildDeps(env: Env): AppDeps {
  const store = createR2Store(env.MEMORY)
  const search = createAiSearch(env.AI_SEARCH, {
    instance: env.AI_SEARCH_INSTANCE ?? 'memory',
  })
  return { store, search, service: createMemoryService({ store, search }) }
}

/** 读取 JSON 对象 body；空 body 视为 `{}`，非法 JSON 抛 400。 */
async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  const raw = await request.text()
  if (raw.trim() === '') return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new HttpError(400, 'invalid_json', 'Request body must be valid JSON')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new HttpError(400, 'invalid_json', 'Request body must be a JSON object')
  }
  return parsed as Record<string, unknown>
}

function parseLimit(value: unknown, fallback: number, max: number): number {
  if (value === undefined || value === null) return fallback
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > max) {
    throw new HttpError(400, 'invalid_request', `limit must be an integer between 1 and ${max}`)
  }
  return value
}

/** 解析 query string 中的 limit（字符串）；缺省或空串用 fallback。 */
function parseQueryLimit(raw: string | null, fallback: number, max: number): number {
  if (raw === null || raw.trim() === '') return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new HttpError(400, 'invalid_request', `limit must be an integer between 1 and ${max}`)
  }
  return value
}

function parseSource(value: unknown, path: string): MemorySource | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new HttpError(400, 'invalid_request', `${path} must be an object`)
  }
  const source = value as Record<string, unknown>
  const parsed: MemorySource = {}
  if (source.session !== undefined) {
    if (typeof source.session !== 'string') {
      throw new HttpError(400, 'invalid_request', `${path}.session must be a string`)
    }
    parsed.session = source.session
  }
  if (source.message !== undefined) {
    if (typeof source.message !== 'string') {
      throw new HttpError(400, 'invalid_request', `${path}.message must be a string`)
    }
    parsed.message = source.message
  }
  return parsed
}

function parseCandidate(value: unknown, index: number): ExtractCandidate {
  const path = `candidates[${index}]`
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new HttpError(400, 'invalid_request', `${path} must be an object`)
  }
  const item = value as Record<string, unknown>

  if (typeof item.topic !== 'string' || !isKnownTopic(item.topic)) {
    throw new HttpError(400, 'invalid_request', `${path}.topic must be one of the fixed topics`)
  }
  if (typeof item.statement !== 'string' || item.statement.trim() === '') {
    throw new HttpError(400, 'invalid_request', `${path}.statement must be a non-empty string`)
  }
  if (item.rationale !== undefined && typeof item.rationale !== 'string') {
    throw new HttpError(400, 'invalid_request', `${path}.rationale must be a string`)
  }
  let confidence = DEFAULT_CANDIDATE_CONFIDENCE
  if (item.confidence !== undefined) {
    if (
      typeof item.confidence !== 'number' ||
      !Number.isFinite(item.confidence) ||
      item.confidence < 0 ||
      item.confidence > 1
    ) {
      throw new HttpError(400, 'invalid_request', `${path}.confidence must be a number in [0, 1]`)
    }
    confidence = item.confidence
  }

  return {
    topic: item.topic,
    statement: item.statement.trim(),
    ...(item.rationale !== undefined ? { rationale: item.rationale } : {}),
    confidence,
    ...(item.source !== undefined ? { source: parseSource(item.source, `${path}.source`) } : {}),
  }
}

function parseCandidates(raw: unknown): ExtractCandidate[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new HttpError(400, 'invalid_request', 'candidates must be a non-empty array')
  }
  return raw.map((item, index) => parseCandidate(item, index))
}

/**
 * `/v1/extract` 的候选来源，两种形态都接受：
 * - `{ sessionId, messages: [{ role, content }] }`（插件契约）：网关用
 *   `capture.ts` 的启发式规则从对话文本中提取候选；
 * - `{ candidates: [...] }`：调用方已自行提取，只做校验。
 */
function parseExtractCandidates(body: Record<string, unknown>): ExtractCandidate[] {
  if (body.candidates !== undefined) return parseCandidates(body.candidates)
  if (!Array.isArray(body.messages)) {
    throw new HttpError(
      400,
      'invalid_request',
      'body must contain either messages (ExtractRequest) or candidates',
    )
  }

  const sessionId =
    typeof body.sessionId === 'string' && body.sessionId.trim() !== ''
      ? body.sessionId.trim()
      : undefined

  const candidates: ExtractCandidate[] = []
  const seen = new Set<string>()

  for (const [index, raw] of body.messages.entries()) {
    const path = `messages[${index}]`
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new HttpError(400, 'invalid_request', `${path} must be an object`)
    }
    const message = raw as Record<string, unknown>
    if (typeof message.role !== 'string' || message.role === '') {
      throw new HttpError(400, 'invalid_request', `${path}.role must be a non-empty string`)
    }
    if (typeof message.content !== 'string') {
      throw new HttpError(400, 'invalid_request', `${path}.content must be a string`)
    }

    const source: MemorySource = {
      ...(sessionId !== undefined ? { session: sessionId } : {}),
      message: String(index),
    }
    for (const candidate of extractCandidates(message.content, source)) {
      const key = `${candidate.topic}\u0000${candidate.statement}`
      if (seen.has(key)) continue
      seen.add(key)
      candidates.push(candidate)
      if (candidates.length >= MAX_EXTRACT_CANDIDATES) return candidates
    }
  }

  return candidates
}

/** 顶层错误：HttpError 原样映射，其余记录后返回 500，避免泄露内部细节。 */
function toErrorResponse(error: unknown): Response {
  if (error instanceof HttpError) {
    return jsonError(error.status, error.code, error.message)
  }
  console.error('smriti: unhandled request error', error)
  return jsonError(500, 'internal_error', 'Internal server error')
}

/**
 * P0-3：写入 / 裁决成功后异步触发 AI Search 同步。
 *
 * 用 `ctx.waitUntil` 不阻塞响应；同步失败只记日志——R2 已是真源，索引可以由
 * 下一次写入或每日 cron 补偿，不应把已成功的写入回滚成 5xx。
 */
function scheduleSearchSync(ctx: ExecutionContext, search: SearchIndex): void {
  ctx.waitUntil(
    search.sync().catch((error: unknown) => {
      console.error('smriti: AI Search sync after write failed', error)
    }),
  )
}

/**
 * `/ui` 静态资源：鉴权已在 `handle` 顶层完成，这里把请求转给 assets 绑定。
 * `/ui` 与 `/ui/` 映射到 `/ui/index.html`，其余 `/ui/*` 保持原路径。
 * 未配置绑定时返回 503，避免把部署配置问题伪装成 404。
 */
async function serveUi(request: Request, env: Env, url: URL): Promise<Response> {
  if (!env.ASSETS) {
    return jsonError(
      503,
      'assets_unavailable',
      'Static assets binding (ASSETS) is not configured for this deployment',
    )
  }

  const assetUrl = new URL(url)
  if (assetUrl.pathname === '/ui' || assetUrl.pathname === '/ui/') {
    assetUrl.pathname = UI_INDEX_PATH
  }

  // 只转发条件请求需要的头；原始请求头里的 Host/Cookie 等不应透传给 assets。
  const headers = new Headers()
  const accept = request.headers.get('accept')
  if (accept !== null) headers.set('accept', accept)
  const ifNoneMatch = request.headers.get('if-none-match')
  if (ifNoneMatch !== null) headers.set('if-none-match', ifNoneMatch)

  try {
    return await env.ASSETS.fetch(
      new Request(assetUrl.toString(), { method: 'GET', headers }),
    )
  } catch (error) {
    console.error('smriti: failed to serve /ui asset', error)
    return jsonError(503, 'assets_unavailable', 'Static assets are temporarily unavailable')
  }
}

export async function handle(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  try {
    const url = new URL(request.url)
    const method = request.method.toUpperCase()
    const pathname = url.pathname

    // 存活探针：不鉴权，供 Cloudflare 健康检查使用。
    if (pathname === '/healthz' && method === 'GET') return json({ ok: true })

    const denied = await authenticate(request, env)
    if (denied) return denied

    // WebUI 静态资源（只读）：/ui 与 /ui/*，鉴权通过后交给 assets 绑定。
    if (method === 'GET' && (pathname === '/ui' || pathname.startsWith('/ui/'))) {
      return serveUi(request, env, url)
    }

    if (pathname === '/v1/health' && method === 'GET') return json({ ok: true })

    if (pathname === '/mcp' && method === 'POST') {
      return createMcpFetchHandler(() => env)(request, env, ctx)
    }

    // 只有 POST 的 approve/reject 才算命中路由；其它方法走 404。
    const pendingAction = method === 'POST' ? PENDING_ACTION_ROUTE.exec(pathname) : null

    // 只有已匹配的 /v1 路由才需要构建依赖（R2 / AI Search / service）。
    const needsDeps =
      pendingAction !== null ||
      (method === 'GET' &&
        (pathname === '/v1/topics' ||
          pathname === '/v1/pending' ||
          pathname === '/v1/stats' ||
          pathname === '/v1/memories')) ||
      (method === 'POST' && (pathname === '/v1/recall' || pathname === '/v1/extract'))
    if (!needsDeps) {
      return jsonError(404, 'not_found', `No route for ${method} ${pathname}`)
    }

    const { service, search } = buildDeps(env)

    if (method === 'GET' && pathname === '/v1/topics') {
      return json({ topics: await service.topics() })
    }

    if (method === 'GET' && pathname === '/v1/pending') {
      return json({ pending: await service.pending() })
    }

    // WebUI 概览：只读聚合，供 /ui 首屏一次取齐。
    if (method === 'GET' && pathname === '/v1/stats') {
      const [topics, pending, memories] = await Promise.all([
        service.topics(),
        service.pending(),
        service.list(),
      ])
      const recent = [...memories]
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, RECENT_MEMORY_LIMIT)
        .map(({ id, topic, statement, updatedAt }) => ({ id, topic, statement, updatedAt }))
      return json({
        totals: {
          memories: memories.length,
          pending: pending.length,
          topics: topics.length,
        },
        byTopic: topics.map(({ topic, label, count }) => ({ topic, label, count })),
        recent,
        health: {
          aiSearch: env.AI_SEARCH !== undefined,
          instance: env.AI_SEARCH_INSTANCE ?? 'memory',
          authMode: env.AUTH_MODE ?? 'access',
        },
      })
    }

    // WebUI 记忆表格：topic 可选，limit 默认 200、上限 500。
    if (method === 'GET' && pathname === '/v1/memories') {
      const topic = url.searchParams.get('topic')?.trim() ?? ''
      if (topic !== '' && !isKnownTopic(topic)) {
        throw new HttpError(400, 'invalid_request', 'topic must be one of the fixed topics')
      }
      const limit = parseQueryLimit(
        url.searchParams.get('limit'),
        DEFAULT_MEMORIES_LIMIT,
        MAX_MEMORIES_LIMIT,
      )
      const items = await service.list(topic === '' ? undefined : topic)
      return json({ items: items.slice(0, limit) })
    }

    if (method === 'POST' && pathname === '/v1/recall') {
      const body = await readJsonObject(request)
      const query = typeof body.query === 'string' ? body.query.trim() : ''
      if (query === '') {
        throw new HttpError(400, 'invalid_request', 'query must be a non-empty string')
      }
      const limit = parseLimit(body.limit, DEFAULT_RECALL_LIMIT, MAX_RECALL_LIMIT)
      return json({ items: await service.recall(query, limit) })
    }

    if (method === 'POST' && pathname === '/v1/extract') {
      const body = await readJsonObject(request)
      const candidates = parseExtractCandidates(body)
      // 没有候选是正常结果（本回合没有偏好句式），不写库也不报错。
      const results = candidates.length === 0 ? [] : await service.extract(candidates)
      // P0-3：只有真正落盘（applied）才改变索引内容；pending/unchanged 无需同步。
      if (results.some((result) => result.status === 'applied')) {
        scheduleSearchSync(ctx, search)
      }
      return json({ candidates, results })
    }

    if (pendingAction) {
      let changeId: string
      try {
        changeId = decodeURIComponent(pendingAction[1])
      } catch {
        throw new HttpError(400, 'invalid_request', 'Pending change id must be URL encoded')
      }

      if (pendingAction[2] === 'approve') {
        // 顶层 UpsertResult（status/memory/change），与插件的 WriteResult 对齐。
        // P0-3：批准会写入新的 active 记录，成功后同步索引。
        const result = await service.approve(changeId)
        if (result.status === 'applied') scheduleSearchSync(ctx, search)
        return json(result)
      }

      // reject 只删 pending，不改动 active 索引，因此不同步。
      const body = await readJsonObject(request)
      const reason =
        typeof body.reason === 'string' && body.reason.trim() !== ''
          ? body.reason.trim()
          : 'rejected'
      const rejected = await service.reject(changeId, reason)
      if (!rejected) {
        return jsonError(404, 'not_found', `Pending change not found: ${changeId}`)
      }
      return json({ status: 'rejected', applied: false })
    }

    return jsonError(404, 'not_found', `No route for ${method} ${pathname}`)
  } catch (error) {
    return toErrorResponse(error)
  }
}

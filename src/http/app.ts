/**
 * Worker HTTP 入口：存活探针、`/v1` REST（含 WebUI 只读聚合 API）、`/ui`
 * 静态资源与 `/mcp`。
 *
 * 约定：
 * - 除 `GET /healthz` 外，所有路由先过 `authenticate`；
 * - 成功响应为 JSON，错误统一 `{ error: { code, message } }`；
 * - 未匹配的路由返回 404 JSON（含方法不匹配的情形）；
 * - 写入/裁决成功后由 `ctx.waitUntil` 异步同步 AI Search 索引（P0-3）。
 *
 * `/mcp` 的例外：非 POST 仍返回 405 + `Allow: POST`，但浏览器（`Accept`
 * 含 `text/html`）拿到的是教程页而不是 JSON，见 `mcpMethodNotAllowed`。
 */

import { authenticate } from '../auth/access'
import { extractCandidates } from '../capture'
import type { SearchIndex } from '../contracts'
import type { AppDeps, Env } from '../env'
import { createMcpFetchHandler } from '../mcp/server'
import { createAiSearch } from '../search/ai-search'
import { createMemoryService } from '../service'
import { createR2Store } from '../storage/r2-store'
import { MAX_TOPIC_SEGMENTS, isValidTopicId } from '../topics'
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
/** 浏览器直接打开 `/mcp` 时展示的教程页（与 WebUI 同目录的静态资源）。 */
const MCP_TUTORIAL_PATH = '/ui/mcp.html'

/** 非 POST `/mcp` 的 JSON 提示文案：JSON/MCP 客户端与 curl 默认看到它。 */
const MCP_METHOD_NOT_ALLOWED_MESSAGE =
  'MCP Streamable HTTP endpoint: send JSON-RPC with POST. Browsers cannot open it directly; see /ui for the dashboard.'

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

function json(body: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...JSON_HEADERS, ...headers },
  })
}

function jsonError(
  status: number,
  code: string,
  message: string,
  headers?: Record<string, string>,
): Response {
  return json({ error: { code, message } }, status, headers)
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

  if (typeof item.topic !== 'string' || !isValidTopicId(item.topic)) {
    throw new HttpError(
      400,
      'invalid_request',
      `${path}.topic must be a lowercase slug (letters / digits / hyphens, max ${MAX_TOPIC_SEGMENTS} dot-separated segments)`,
    )
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
 * 构造发往 `ASSETS` 绑定的一次性 GET 请求。
 *
 * 只转发条件请求需要的头；原始请求头里的 Host/Cookie 等不应透传给 assets。
 * `/ui/*` 与 `/mcp` 共用这一入口，保证取资源方式一致。
 */
function assetRequest(
  request: Request,
  assetUrl: URL,
  options: { forwardIfNoneMatch?: boolean } = {},
): Request {
  const headers = new Headers()
  const accept = request.headers.get('accept')
  if (accept !== null) headers.set('accept', accept)
  if (options.forwardIfNoneMatch) {
    const ifNoneMatch = request.headers.get('if-none-match')
    if (ifNoneMatch !== null) headers.set('if-none-match', ifNoneMatch)
  }
  return new Request(assetUrl.toString(), { method: 'GET', headers })
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

  try {
    return await env.ASSETS.fetch(
      assetRequest(request, assetUrl, { forwardIfNoneMatch: true }),
    )
  } catch (error) {
    console.error('smriti: failed to serve /ui asset', error)
    return jsonError(503, 'assets_unavailable', 'Static assets are temporarily unavailable')
  }
}

/** 非 POST `/mcp` 的 JSON 提示：JSON/MCP 客户端与 curl 默认看到它。 */
function mcpMethodNotAllowedJson(): Response {
  return jsonError(405, 'method_not_allowed', MCP_METHOD_NOT_ALLOWED_MESSAGE, { allow: 'POST' })
}

/**
 * 405 HTML 响应头：方法语义（`Allow: POST`）与 /ui 一样保持，但教程页
 * 不缓存、不猜测类型（nosniff）。
 */
const MCP_TUTORIAL_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  allow: 'POST',
}

/**
 * assets 缺失 / 取页失败时的最小内联教程页。
 *
 * 宁可少一点样式，也不能让浏览器看到 500 或 JSON：`ASSETS` 未配置、
 * 取页抛错或资源不存在（如尚未部署 mcp.html）时都走到这里。
 */
function mcpTutorialFallback(): Response {
  const body = `<!doctype html>
<html lang="zh-CN">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>MCP 端点 · Smriti</title>
<style>
  body{font:16px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;max-width:38rem;margin:12vh auto;padding:0 1.5rem;color:#232b26;background:#f2f3ed}
  h1{font-size:1.5rem;margin:0 0 1rem}
  p{margin:0 0 .75rem}
  code{background:#e3e6da;padding:.1em .35em;border-radius:2px}
  a{color:#1e5f8c}
</style>
<h1>这是 MCP 端点，不是网页</h1>
<p><code>/mcp</code> 只接受 <code>POST</code>（MCP Streamable HTTP，JSON-RPC）。直接在浏览器里打开只能看到这份说明。</p>
<p>MCP 客户端请把 JSON-RPC 请求 <code>POST</code> 到 <code>/mcp</code>；只读仪表盘在 <a href="/ui">/ui</a>。</p>
</html>`
  return new Response(body, { status: 405, headers: MCP_TUTORIAL_HEADERS })
}

/** 从 ASSETS 取教程页；绑定缺失或取页失败都返回 null，交给内联兜底。 */
async function mcpTutorialPage(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response | null> {
  if (!env.ASSETS) return null

  try {
    const asset = await env.ASSETS.fetch(
      assetRequest(request, new URL(MCP_TUTORIAL_PATH, url.origin)),
    )
    if (!asset.ok) {
      console.error(`smriti: /mcp tutorial asset returned ${asset.status}`)
      return null
    }
    return new Response(await asset.text(), { status: 405, headers: MCP_TUTORIAL_HEADERS })
  } catch (error) {
    console.error('smriti: failed to serve /mcp tutorial asset', error)
    return null
  }
}

/**
 * 非 POST `/mcp`：状态码与方法语义固定为 405 + `Allow: POST`。
 *
 * - `Accept` 含 `text/html`（浏览器）→ 教程页；ASSETS 缺失/失败时用内联页，
 *   绝不返回 500；
 * - 其它（JSON/MCP 客户端、curl 默认 `* / *`）→ 原有 JSON `method_not_allowed`。
 */
async function mcpMethodNotAllowed(request: Request, env: Env, url: URL): Promise<Response> {
  const accept = request.headers.get('accept') ?? ''
  if (!accept.toLowerCase().includes('text/html')) return mcpMethodNotAllowedJson()
  return (await mcpTutorialPage(request, env, url)) ?? mcpTutorialFallback()
}

/**
 * `/ui` 鉴权失败时给浏览器一个可读页面，而不是 JSON。
 *
 * 最常见的两种情况：直接访问 `workers.dev`（不经过 Access），或还没建
 * Access 应用。两种都提示清楚，并给出临时调试办法。
 */
function uiAuthFailure(denied: Response): Response {
  if (denied.status !== 401) return denied
  const body = `<!doctype html>
<html lang="zh-CN">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>需要登录 · Smriti</title>
<style>
  body{font:16px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;max-width:38rem;margin:12vh auto;padding:0 1.5rem;color:#232b26;background:#f2f3ed}
  h1{font-size:1.5rem;margin:0 0 1rem}
  p{margin:0 0 .75rem}
  code{background:#e3e6da;padding:.1em .35em;border-radius:2px}
  a{color:#1e5f8c}
</style>
<h1>需要 Cloudflare Access 登录</h1>
<p>这个页面在 Access 之后。如果你访问的是 <code>*.workers.dev</code> 域名，它不经过 Access，请改用绑定了 Access 的自定义域名。</p>
<p>如果还没有配置 Access：在 Cloudflare Zero Trust 里为这个域名建一个 Self-hosted 应用，策略允许你的邮箱，登录方式用 One-time PIN。</p>
<p>临时调试：在 Worker 的变量里设置 <code>AUTH_MODE=dev</code> 并重新部署，就可以直接打开 <a href="/ui">/ui</a>。</p>
</html>`
  return new Response(body, {
    status: 401,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
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

    // 根路径跳到只读视图；/ui 仍由 Access 鉴权。
    if (method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
      return Response.redirect(new URL('/ui', url).toString(), 302)
    }

    const denied = await authenticate(request, env)
    if (denied) {
      if (pathname === '/ui' || pathname.startsWith('/ui/')) return uiAuthFailure(denied)
      return denied
    }

    // WebUI 静态资源（只读）：/ui 与 /ui/*，鉴权通过后交给 assets 绑定。
    if (method === 'GET' && (pathname === '/ui' || pathname.startsWith('/ui/'))) {
      return serveUi(request, env, url)
    }

    if (pathname === '/v1/health' && method === 'GET') return json({ ok: true })

    if (pathname === '/mcp') {
      if (method === 'POST') {
        return createMcpFetchHandler(() => env)(request, env, ctx)
      }
      // 浏览器直接打开 /mcp：它是 MCP 的 JSON-RPC 端点，不是网页。
      // 内容协商后给浏览器教程页，给 MCP/JSON 客户端沿用原来的 405 JSON。
      return mcpMethodNotAllowed(request, env, url)
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
      // 真实探活（缓存由 SearchIndex 实现负责）。探活不可用时退回"绑定是否存在"，
      // 那只是弱判断——绝不能把它当成检索健康，否则索引坏了仪表盘还是绿的。
      const searchHealth = search.health ? await search.health() : undefined
      return json({
        totals: {
          memories: memories.length,
          pending: pending.length,
          // 「已用主题」：直接被写入过记录的主题数（父主题不因子树有记录而重复计数）。
          topics: topics.filter((topic) => (topic.directCount ?? topic.count) > 0).length,
        },
        byTopic: topics.map(({ topic, label, count, parent }) => ({
          topic,
          label,
          count,
          parent,
        })),
        recent,
        health: {
          aiSearch: searchHealth ? searchHealth.ok : env.AI_SEARCH !== undefined,
          instance: searchHealth?.instance ?? env.AI_SEARCH_INSTANCE ?? 'memory',
          authMode: env.AUTH_MODE ?? 'access',
          ...(searchHealth !== undefined && !searchHealth.ok
            ? { searchError: searchHealth.reason ?? 'search backend unavailable' }
            : {}),
        },
      })
    }

    // WebUI 记忆表格：topic 可选，limit 默认 200、上限 500。
    if (method === 'GET' && pathname === '/v1/memories') {
      const topic = url.searchParams.get('topic')?.trim() ?? ''
      if (topic !== '' && !isValidTopicId(topic)) {
        throw new HttpError(
          400,
          'invalid_request',
          'topic must be a lowercase slug (letters / digits / hyphens, max 3 dot-separated segments)',
        )
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

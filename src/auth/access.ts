/**
 * Cloudflare Access 鉴权。
 *
 * `AUTH_MODE === 'dev'` 时直接放行（本地开发、单测）；否则必须携带 Cloudflare
 * Access 注入的 `Cf-Access-Jwt-Assertion`，并用团队 JWKS 校验签名与 audience。
 * 返回 `null` 表示通过，返回 `Response` 表示应直接回给客户端的鉴权失败响应。
 */

import { createRemoteJWKSet, jwtVerify } from 'jose'
import type { Env } from '../env'

type Jwks = ReturnType<typeof createRemoteJWKSet>

/**
 * 每个 Access 团队域名复用一个 RemoteJWKSet（jose 内部还有 cacheMaxAge 缓存）。
 * Worker isolate 生命周期内复用即可，避免了每个请求都重新抓取 JWKS。
 */
const jwksSets = new Map<string, Jwks>()

/** 规范化团队域名：允许传入裸域名或带协议的 URL。 */
function teamHost(teamDomain: string): string {
  return teamDomain
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/+$/, '')
}

function jwksFor(teamDomain: string): Jwks {
  const host = teamHost(teamDomain)
  const cached = jwksSets.get(host)
  if (cached) return cached
  const created = createRemoteJWKSet(new URL(`https://${host}/cdn-cgi/access/certs`))
  jwksSets.set(host, created)
  return created
}

/** 鉴权失败响应：与其它入口一致使用 `{ error: { code, message } }`。 */
export function authFailure(
  status: 401 | 500,
  code: string,
  message: string,
): Response {
  return Response.json({ error: { code, message } }, { status })
}

/**
 * 校验请求身份。
 *
 * @returns `null` 表示鉴权通过；否则为应立即返回的失败响应。
 */
export async function authenticate(
  request: Request,
  env: Env,
): Promise<Response | null> {
  if (env.AUTH_MODE === 'dev') return null

  const assertion = request.headers.get('Cf-Access-Jwt-Assertion')?.trim()
  if (!assertion) {
    return authFailure(401, 'unauthorized', 'Missing Cf-Access-Jwt-Assertion header')
  }

  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) {
    return authFailure(
      500,
      'auth_misconfigured',
      'ACCESS_TEAM_DOMAIN and ACCESS_AUD must be configured when AUTH_MODE is not "dev"',
    )
  }

  try {
    await jwtVerify(assertion, jwksFor(env.ACCESS_TEAM_DOMAIN), {
      audience: env.ACCESS_AUD,
    })
    return null
  } catch {
    // 不把 jose 的错误细节暴露给调用方；日志由上层按需记录。
    return authFailure(401, 'unauthorized', 'Invalid Cloudflare Access JWT')
  }
}

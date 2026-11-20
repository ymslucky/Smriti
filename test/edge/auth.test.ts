import { afterEach, describe, expect, it, vi } from 'vitest'
import { SignJWT, exportJWK, generateKeyPair } from 'jose'
import type { Env } from '../../src/env'
import { authenticate } from '../../src/auth/access'

const TEAM_DOMAIN = 'smriti-test.cloudflareaccess.com'
const AUDIENCE = 'smriti-test-aud'

function makeEnv(overrides: Partial<Env> = {}): Env {
  return { MEMORY: {} as Env['MEMORY'], ...overrides }
}

function requestWith(token?: string): Request {
  const headers = new Headers()
  if (token !== undefined) headers.set('Cf-Access-Jwt-Assertion', token)
  return new Request('https://smriti.example.com/v1/health', { headers })
}

function accessEnv(overrides: Partial<Env> = {}): Env {
  return makeEnv({
    AUTH_MODE: 'access',
    ACCESS_TEAM_DOMAIN: TEAM_DOMAIN,
    ACCESS_AUD: AUDIENCE,
    ...overrides,
  })
}

/** 用本地生成的 RSA 密钥对伪造 Cloudflare Access 签发的 JWT 与对应 JWKS。 */
async function signedAccessToken(options: { audience?: string; kid?: string } = {}) {
  const kid = options.kid ?? 'edge-test-key'
  const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true })
  const publicJwk = await exportJWK(publicKey)
  const token = await new SignJWT({ email: 'owner@example.com' })
    .setProtectedHeader({ alg: 'RS256', kid })
    .setIssuer(`https://${TEAM_DOMAIN}`)
    .setAudience(options.audience ?? AUDIENCE)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateKey)
  return { token, jwks: { keys: [{ ...publicJwk, kid, alg: 'RS256', use: 'sig' }] } }
}

function mockJwksFetch(jwks: unknown) {
  const fetchMock = vi.fn(
    async () =>
      new Response(JSON.stringify(jwks), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  )
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('authenticate', () => {
  it('dev 模式直接通过，不要求任何请求头', async () => {
    await expect(authenticate(requestWith(), makeEnv({ AUTH_MODE: 'dev' }))).resolves.toBeNull()
  })

  it('AUTH_MODE 未配置时默认按 access 模式鉴权', async () => {
    const response = await authenticate(requestWith(), makeEnv())
    expect(response?.status).toBe(401)
    await expect(response?.json()).resolves.toEqual({
      error: { code: 'unauthorized', message: expect.any(String) },
    })
  })

  it('access 模式缺少 Cf-Access-Jwt-Assertion 时返回 401', async () => {
    const response = await authenticate(requestWith(), accessEnv())
    expect(response?.status).toBe(401)
    const body = (await response?.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe('unauthorized')
  })

  it('非法 JWT 返回 401，且不需要访问 JWKS 端点', async () => {
    const fetchMock = mockJwksFetch({ keys: [] })
    const response = await authenticate(requestWith('not-a-jwt'), accessEnv())
    expect(response?.status).toBe(401)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('合法 Access JWT 通过，并复用同一域名的 JWKS', async () => {
    const { token, jwks } = await signedAccessToken()
    const fetchMock = mockJwksFetch(jwks)

    await expect(authenticate(requestWith(token), accessEnv())).resolves.toBeNull()
    await expect(authenticate(requestWith(token), accessEnv())).resolves.toBeNull()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url] = fetchMock.mock.calls[0] as unknown as [string]
    expect(url).toBe(`https://${TEAM_DOMAIN}/cdn-cgi/access/certs`)
  })

  it('audience 不匹配返回 401', async () => {
    const { token, jwks } = await signedAccessToken({ audience: 'someone-else' })
    mockJwksFetch(jwks)

    const response = await authenticate(requestWith(token), accessEnv())
    expect(response?.status).toBe(401)
  })

  it('access 模式缺少 ACCESS_AUD 时返回 500，避免静默放行', async () => {
    const { token } = await signedAccessToken()
    const response = await authenticate(
      requestWith(token),
      accessEnv({ ACCESS_AUD: undefined }),
    )
    expect(response?.status).toBe(500)
    const body = (await response?.json()) as { error: { code: string } }
    expect(body.error.code).toBe('auth_misconfigured')
  })
})

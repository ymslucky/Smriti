import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Env } from '../../src/env'

/** index 只会用到 store.cleanupHistory 与 search.sync，其余工厂调用都返回假对象。 */
const fake = vi.hoisted(() => {
  const store = { cleanupHistory: vi.fn<(before: Date) => Promise<number>>(async () => 3) }
  const search = { search: vi.fn(async () => []), sync: vi.fn(async () => {}) }
  const createR2Store = vi.fn(() => store)
  const createAiSearch = vi.fn(() => search)
  const createMemoryService = vi.fn(() => ({}))
  return { store, search, createR2Store, createAiSearch, createMemoryService }
})

vi.mock('../../src/storage/r2-store', () => ({ createR2Store: fake.createR2Store }))
vi.mock('../../src/search/ai-search', () => ({ createAiSearch: fake.createAiSearch }))
vi.mock('../../src/service', () => ({ createMemoryService: fake.createMemoryService }))

const worker = (await import('../../src/index')).default

const ctx = {
  waitUntil: () => {},
  passThroughOnException: () => {},
} as unknown as ExecutionContext

function makeEnv(overrides: Partial<Env> = {}): Env {
  return { MEMORY: {} as Env['MEMORY'], AUTH_MODE: 'dev', ...overrides }
}

let logSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  vi.clearAllMocks()
  fake.store.cleanupHistory.mockResolvedValue(3)
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  logSpy.mockRestore()
})

describe('worker 入口', () => {
  it('fetch 指向 HTTP handler', async () => {
    const response = await worker.fetch(
      new Request('https://smriti.example.com/healthz'),
      makeEnv(),
      ctx,
    )
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ ok: true })
  })

  it('scheduled 清理 30 天前 history 并触发检索同步', async () => {
    const env = makeEnv()

    await worker.scheduled({} as ScheduledController, env, ctx)

    expect(fake.createR2Store).toHaveBeenCalledWith(env.MEMORY)
    expect(fake.store.cleanupHistory).toHaveBeenCalledTimes(1)
    const before = fake.store.cleanupHistory.mock.calls[0][0] as Date
    expect(before).toBeInstanceOf(Date)
    expect(Math.abs(before.getTime() - (Date.now() - 30 * 86_400_000))).toBeLessThan(5_000)

    expect(fake.createAiSearch).toHaveBeenCalledWith(env.AI_SEARCH, { instance: 'memory' })
    expect(fake.search.sync).toHaveBeenCalledTimes(1)
  })
})

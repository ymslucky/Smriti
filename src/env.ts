/** Worker 绑定与依赖注入面。 */

import type { MemoryService, MemoryStore, SearchIndex } from './contracts'

export interface AiSearchInstance {
  search(input: unknown): Promise<unknown>
  /**
   * 实例元信息（探活用）。真实绑定总会提供；测试替身可以省略，
   * 此时 `health()` 退回命名空间列表探测。
   */
  info?(): Promise<unknown>
}

export interface AiSearchBinding {
  get(name: string): AiSearchInstance
  /**
   * 命名空间级实例列表。真实绑定（`ai_search_namespaces`）提供；省略时
   * 无法区分"实例不存在"与"网络错误"，实现只做乐观解析。
   */
  list?(): Promise<unknown>
}

export interface Env {
  MEMORY: R2StoreBinding
  AI_SEARCH?: AiSearchBinding
  AI_SEARCH_INSTANCE?: string
  AUTH_MODE?: 'access' | 'dev'
  ACCESS_TEAM_DOMAIN?: string
  ACCESS_AUD?: string
  SYNC_INTERVAL_SECONDS?: string
  /** wrangler assets 绑定，`/ui` 静态资源路由使用；本地未配置时缺失。 */
  ASSETS?: Fetcher
  /** 额外的 MCP 允许来源（逗号分隔的 hostname 或 URL），同源总是自动放行。 */
  MCP_ALLOWED_ORIGINS?: string
  /** 槽位冲突策略：`manual`（默认，进待裁决）或 `auto`（低风险自动生效）。 */
  CONFLICT_POLICY?: string
  /** auto 策略的最低置信度，默认 0.9。 */
  AUTO_APPLY_MIN_CONFIDENCE?: string
  /** 常驻（core）记忆的主题前缀，逗号分隔，默认 `identity`。 */
  CORE_TOPIC_PREFIXES?: string
  /** 召回时最多带几条 core 记忆，默认 5。 */
  CORE_RECALL_LIMIT?: string
}

/** wrangler 注入的 R2Bucket 在结构上满足 MemoryStore 所需的窄接口。 */
export type R2StoreBinding = import('./contracts').R2Like

export interface AppDeps {
  store: MemoryStore
  search: SearchIndex
  service: MemoryService
}

function finiteNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

/**
 * 从 Worker 变量解析记忆服务策略（HTTP 与 MCP 两个组装点共用，避免漂移）。
 * 默认值：人工裁决、core 前缀 `identity`、最多 5 条 core。
 */
export function memoryServiceOptions(env: Env): {
  conflictPolicy: 'manual' | 'auto'
  autoApplyMinConfidence: number
  coreTopicPrefixes: readonly string[]
  coreRecallLimit: number
} {
  return {
    conflictPolicy: env.CONFLICT_POLICY === 'auto' ? 'auto' : 'manual',
    autoApplyMinConfidence: finiteNumber(env.AUTO_APPLY_MIN_CONFIDENCE, 0.9),
    coreTopicPrefixes: (env.CORE_TOPIC_PREFIXES ?? 'identity')
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item !== ''),
    coreRecallLimit: finiteNumber(env.CORE_RECALL_LIMIT, 5),
  }
}

/** Markdown 正文与 R2 自定义元数据之间的编解码。
 *
 * 契约（docs/plan.md）：
 * - 正文是 `# {statement}`，有理由时追加 `## 理由` 段；
 * - 元数据至少包含 `topic`、`updated_at`（epoch 毫秒数字字符串）、`version`（数字字符串）。
 *
 * 为了让 `parseBody` 不依赖对象 key 也能还原完整 `MemoryRecord`，本实现额外写入
 * `id`、`confidence`、`created_at`、`source`、`supersedes` 等元数据字段；这些属于存储层
 * 内部约定，读取方应容忍缺失（缺失时回退到合理默认值）。`topic` / `updated_at` / `version`
 * 始终按契约写入，因此仅凭这三个字段也能解析出可用的记录骨架。
 *
 * `updated_at` 以 epoch 毫秒字符串落盘，与 AI Search metadata schema 的 number 类型对齐；
 * `parseBody` 同时接受 13 位 epoch 毫秒字符串与旧版 ISO 字符串，统一还原为 ISO，保证
 * `MemoryRecord.updatedAt` 的内存形状稳定。`created_at` 仍写 ISO 字符串。
 */

import type { MemoryRecord, MemorySource } from '../types'

const RATIONALE_HEADING = '## 理由'
/** 现行 `updated_at` 格式：epoch 毫秒（13 位数字字符串）。 */
const EPOCH_MS_PATTERN = /^\d{13}$/

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function parseSource(raw: string | undefined): MemorySource | undefined {
  if (raw === undefined || raw === '') return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('invalid customMetadata.source: not valid JSON')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('invalid customMetadata.source: expected an object')
  }
  const source: MemorySource = {}
  const session = (parsed as Record<string, unknown>).session
  const message = (parsed as Record<string, unknown>).message
  if (typeof session === 'string') source.session = session
  if (typeof message === 'string') source.message = message
  return source
}

function parseVersion(raw: string | undefined): number {
  if (raw === undefined || raw === '') return 1
  if (!/^\d+$/.test(raw)) {
    throw new Error(`invalid customMetadata.version: ${JSON.stringify(raw)} (expected an integer string)`)
  }
  return Number(raw)
}

function parseConfidence(raw: string | undefined): number {
  if (raw === undefined || raw === '') return 1
  const value = Number(raw)
  if (!Number.isFinite(value)) {
    throw new Error(`invalid customMetadata.confidence: ${JSON.stringify(raw)} (expected a number)`)
  }
  return value
}

/**
 * 解析 `updated_at`：接受现行 13 位 epoch 毫秒字符串与旧版 ISO 字符串，
 * 一律返回 ISO，保证 `MemoryRecord.updatedAt` 的内存形状稳定。
 */
function parseUpdatedAt(raw: string | undefined): string {
  if (!isNonEmptyString(raw)) {
    throw new Error('parseBody: missing or invalid customMetadata.updated_at')
  }
  if (EPOCH_MS_PATTERN.test(raw)) {
    const date = new Date(Number(raw))
    if (Number.isNaN(date.getTime())) {
      throw new Error(`parseBody: invalid customMetadata.updated_at: ${JSON.stringify(raw)}`)
    }
    return date.toISOString()
  }
  if (Number.isNaN(Date.parse(raw))) {
    throw new Error(`parseBody: invalid customMetadata.updated_at: ${JSON.stringify(raw)}`)
  }
  return raw
}

/** 序列化正文：`# statement`，有理由时追加 `## 理由` 段。 */
export function serializeBody(record: MemoryRecord): string {
  const sections: string[] = [`# ${record.statement}`]
  if (typeof record.rationale === 'string' && record.rationale.trim() !== '') {
    sections.push(RATIONALE_HEADING, record.rationale)
  }
  return `${sections.join('\n\n')}\n`
}

/** 解析正文 + R2 自定义元数据为完整记录。 */
export function parseBody(
  text: string,
  customMetadata: Record<string, string> | undefined,
): MemoryRecord {
  if (typeof text !== 'string') {
    throw new Error('parseBody: text must be a string')
  }
  const metadata = customMetadata ?? {}

  const topic = metadata.topic
  if (!isNonEmptyString(topic)) {
    throw new Error('parseBody: missing customMetadata.topic')
  }
  const updatedAt = parseUpdatedAt(metadata.updated_at)

  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop()

  const headingMatch = lines.length > 0 ? /^#(?:[ \t]+(.*))?$/.exec(lines[0]) : null
  const rest = headingMatch !== null ? lines.slice(1) : lines
  const rationaleIndex = rest.findIndex((line) => line.trim() === RATIONALE_HEADING)

  const statementLines = rationaleIndex >= 0 ? rest.slice(0, rationaleIndex) : rest
  if (headingMatch !== null) statementLines.unshift(headingMatch[1] ?? '')
  const statement = statementLines.join('\n').trim()

  let rationale: string | undefined
  if (rationaleIndex >= 0) {
    const parsed = rest
      .slice(rationaleIndex + 1)
      .join('\n')
      .trim()
    if (parsed !== '') rationale = parsed
  }

  const record: MemoryRecord = {
    id: metadata.id ?? '',
    topic,
    statement,
    confidence: parseConfidence(metadata.confidence),
    createdAt: isNonEmptyString(metadata.created_at) ? metadata.created_at : updatedAt,
    updatedAt,
    version: parseVersion(metadata.version),
  }

  if (rationale !== undefined) record.rationale = rationale

  const source = parseSource(metadata.source)
  if (source !== undefined) record.source = source

  if (isNonEmptyString(metadata.topic_label)) {
    record.topicLabel = metadata.topic_label
  }

  if ('supersedes' in metadata) {
    record.supersedes = metadata.supersedes === '' ? null : metadata.supersedes
  }

  return record
}

/** 记录 → R2 customMetadata（值必须全部是字符串）。 */
export function serializeMetadata(record: MemoryRecord): Record<string, string> {
  const metadata: Record<string, string> = {
    topic: record.topic,
    // 与 AI Search metadata schema 的 number 类型对齐：写 epoch 毫秒字符串。
    updated_at: String(Date.parse(record.updatedAt)),
    version: String(record.version),
    id: record.id,
    confidence: String(record.confidence),
    created_at: record.createdAt,
  }
  if (record.source !== undefined) {
    metadata.source = JSON.stringify(record.source)
  }
  // 主题展示名由写入方给出；截断到 80 字符，避免超出 R2 customMetadata 限制。
  if (typeof record.topicLabel === 'string' && record.topicLabel.trim() !== '') {
    metadata.topic_label = record.topicLabel.trim().slice(0, 80)
  }
  // 用空字符串区分「显式 null」与「字段缺失」，保证 round-trip。
  if (record.supersedes !== undefined) {
    metadata.supersedes = record.supersedes ?? ''
  }
  return metadata
}

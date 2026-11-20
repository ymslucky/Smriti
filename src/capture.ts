/**
 * 自动捕获：从对话文本中启发式提取偏好候选（纯函数，无 IO / 无时钟）。
 *
 * 规则（MVP，不依赖 Workers AI）：
 * 1. 按中英文句末标点分句，每句最多产出一条候选；问句/无偏好句式的句子自然被跳过；
 * 2. 句子里必须出现表 1 的偏好句式（「我习惯…」「以后都用…」「统一用…」「不要再…」，
 *    以及 prefer / always / never / by default / use X instead 等），按句式强度给 0.6–0.9；
 * 3. 用 `topics.ts` 的 keywords 映射固定词表中的 topic，匹配不到则丢弃；
 * 4. 去掉「我觉得 / 感觉 / 可能 / maybe」等弱化词，截断到 200 字符，同样候选去重。
 *
 * 输出直接喂给 `MemoryService.extract()`，写入仍由 service 做幂等与冲突判定。
 */

import { TOPICS } from './topics'
import type { ExtractCandidate, MemorySource } from './types'

/** 候选陈述的最大字符数（按 code point 计）。 */
export const MAX_STATEMENT_LENGTH = 200
/** 句式强度对应的置信度区间。 */
export const STRONG_CONFIDENCE = 0.9
export const MEDIUM_CONFIDENCE = 0.75
export const WEAK_CONFIDENCE = 0.6

interface PreferencePattern {
  readonly pattern: RegExp
  readonly confidence: number
}

/** 偏好句式 → 置信度。强指令 > 习惯/默认 > 模糊倾向。 */
const PREFERENCE_PATTERNS: readonly PreferencePattern[] = [
  // 强指令：以后/统一/一律/永远/绝不/不要再……
  {
    pattern:
      /以后(?:都|一律|全部|全)|从今(?:以后|往后)|今后|统一(?:用|使用|采用|改成|改|走)|一律|永远|绝不|坚决不|不要再|别再|再也不|必须|只能(?:用|使用)/u,
    confidence: STRONG_CONFIDENCE,
  },
  // 强指令（英文）：always / never / must
  {
    pattern: /\b(?:always|never|must\s+(?:always|never)|must)\b/iu,
    confidence: STRONG_CONFIDENCE,
  },
  // 习惯与明确偏好：「我习惯…」「我通常…」「不要用…」
  {
    pattern:
      /我(?:习惯|通常|一般|偏好|更喜欢|喜欢|倾向于)|习惯(?:用|使用|走)|偏好|倾向于|不要用|不要使用|不喜欢|讨厌/u,
    confidence: MEDIUM_CONFIDENCE,
  },
  // 习惯与明确偏好（英文）：prefer / by default / use X instead / rather than
  {
    pattern:
      /\b(?:prefer|prefers|preferred|by\s+default|defaults?\s+to|use\s+.+?\s+instead|rather\s+than)\b/iu,
    confidence: MEDIUM_CONFIDENCE,
  },
  // 弱倾向：尽量 / 最好 / 建议 / usually / try to
  {
    pattern: /尽量|最好|建议|\b(?:usually|try\s+to|would\s+like|might\s+want)\b/iu,
    confidence: WEAK_CONFIDENCE,
  },
]

/** 弱化词：捕获陈述时删掉，避免把不确定语气写成永久偏好。 */
const WEAK_PHRASES: readonly string[] = [
  '我觉得',
  '我感觉',
  '我认为',
  '我猜',
  '感觉',
  '可能',
  '也许',
  '大概',
  '似乎',
  '好像',
  '应该是',
  'I think',
  'I guess',
  'I feel like',
  'maybe',
  'probably',
  'perhaps',
  'kind of',
  'sort of',
]

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

/** 一次构建弱化词正则：英文加词边界，长词优先，避免「感觉」先吃掉「我感觉」。 */
const WEAK_PATTERN = new RegExp(
  WEAK_PHRASES.slice()
    .sort((left, right) => right.length - left.length)
    .map((phrase) => {
      const escaped = escapeRegExp(phrase)
      return /^[\x20-\x7e]+$/.test(phrase) ? `\\b${escaped}\\b` : escaped
    })
    .join('|'),
  'giu',
)

const SENTENCE_SPLIT = /[。！？!?；;\n\r]+|(?<=[.!?])\s+/u
const TRAILING_PUNCTUATION = /[。．.!！?？;；,，、:：]+$/u
const LEADING_PUNCTUATION = /^[\s。．.!！?？;；,，、:：]+/u

/** 统计关键词出现次数：纯 ASCII 关键词按词边界匹配，避免 `ide` 命中 `inside`。 */
function countKeyword(haystack: string, keyword: string): number {
  const needle = keyword.toLowerCase()
  if (!needle) return 0
  if (/^[a-z0-9.]+$/.test(needle)) {
    const escaped = escapeRegExp(needle)
    const matcher = new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`, 'g')
    return haystack.match(matcher)?.length ?? 0
  }
  let count = 0
  let from = 0
  for (;;) {
    const index = haystack.indexOf(needle, from)
    if (index < 0) break
    count += 1
    from = index + needle.length
  }
  return count
}

/** 用固定词表的 keywords 选出最匹配的 topic；同分时取 TOPICS 中靠前者。 */
function matchTopic(sentence: string): string | undefined {
  const haystack = sentence.toLowerCase()
  let bestTopic: string | undefined
  let bestScore = 0
  for (const definition of TOPICS) {
    let score = 0
    for (const keyword of definition.keywords) {
      score += countKeyword(haystack, keyword)
    }
    if (score > bestScore) {
      bestScore = score
      bestTopic = definition.topic
    }
  }
  return bestTopic
}

/** 句子中最强偏好句式的置信度；没有命中返回 undefined。 */
function matchConfidence(sentence: string): number | undefined {
  let best: number | undefined
  for (const candidate of PREFERENCE_PATTERNS) {
    if (candidate.pattern.test(sentence) && (best === undefined || candidate.confidence > best)) {
      best = candidate.confidence
    }
  }
  return best
}

/** 去掉弱化词并整理成可写入的陈述；截断到 200 字符。 */
function toStatement(sentence: string): string {
  const cleaned = sentence
    .replace(WEAK_PATTERN, '')
    .replace(/\s+/gu, ' ')
    .replace(LEADING_PUNCTUATION, '')
    .replace(TRAILING_PUNCTUATION, '')
    .trim()
  if (!cleaned) return ''
  return Array.from(cleaned).slice(0, MAX_STATEMENT_LENGTH).join('').trim()
}

/**
 * 从一段文本提取偏好候选。
 *
 * @param text 原始文本（通常是一个 agent turn 的最后一轮回答/用户消息）。
 * @param source 来源定位，原样带到每个候选中，便于审计。
 */
export function extractCandidates(
  text: string,
  source?: MemorySource,
): ExtractCandidate[] {
  if (typeof text !== 'string' || text.trim() === '') return []

  const candidates: ExtractCandidate[] = []
  const seen = new Set<string>()

  for (const rawSentence of text.split(SENTENCE_SPLIT)) {
    const sentence = rawSentence.trim()
    if (!sentence) continue

    // 先去掉弱化词再判定句式：弱化词常插在句式中间（「我可能更喜欢…」）。
    const statement = toStatement(sentence)
    if (!statement) continue

    const confidence = Math.max(
      matchConfidence(sentence) ?? 0,
      matchConfidence(statement) ?? 0,
    )
    if (confidence < WEAK_CONFIDENCE) continue

    const topic = matchTopic(sentence) ?? matchTopic(statement)
    if (!topic) continue

    const dedupeKey = `${topic}\u0000${statement}`
    if (seen.has(dedupeKey)) continue
    seen.add(dedupeKey)

    candidates.push({
      topic,
      statement,
      confidence,
      ...(source !== undefined ? { source } : {}),
    })
  }

  return candidates
}

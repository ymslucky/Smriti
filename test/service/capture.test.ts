/**
 * `capture.ts` 单元测试：中英文偏好句式识别、topic 映射、弱化词清理、
 * 200 字符截断、每句最多一条与去重。
 */

import { describe, expect, it } from 'vitest'

import {
  extractCandidates,
  MAX_STATEMENT_LENGTH,
  STRONG_CONFIDENCE,
  MEDIUM_CONFIDENCE,
  WEAK_CONFIDENCE,
} from '../../src/capture'

describe('extractCandidates 中文句式', () => {
  it('「以后都用…」→ 强置信度 + 包管理器 topic', () => {
    expect(extractCandidates('以后都用 pnpm 安装依赖。')).toEqual([
      {
        topic: 'tooling.package-manager',
        statement: '以后都用 pnpm 安装依赖',
        confidence: STRONG_CONFIDENCE,
      },
    ])
  })

  it('「我习惯…」→ 中等置信度 + 测试 topic', () => {
    expect(extractCandidates('我习惯用 vitest 写测试。')).toEqual([
      {
        topic: 'code.testing',
        statement: '我习惯用 vitest 写测试',
        confidence: MEDIUM_CONFIDENCE,
      },
    ])
  })

  it('「统一用…」→ 强置信度 + 编辑器 topic', () => {
    expect(extractCandidates('统一用 vscode 作为编辑器。')).toEqual([
      {
        topic: 'tooling.editor',
        statement: '统一用 vscode 作为编辑器',
        confidence: STRONG_CONFIDENCE,
      },
    ])
  })

  it('「不要再…」→ 强置信度 + 包管理器 topic', () => {
    expect(extractCandidates('不要再使用 npm。')).toEqual([
      {
        topic: 'tooling.package-manager',
        statement: '不要再使用 npm',
        confidence: STRONG_CONFIDENCE,
      },
    ])
  })

  it('关键词映射到 Git 流程', () => {
    expect(extractCandidates('统一用 git rebase。')).toEqual([
      {
        topic: 'workflow.git',
        statement: '统一用 git rebase',
        confidence: STRONG_CONFIDENCE,
      },
    ])
  })
})

describe('extractCandidates 英文句式', () => {
  it('prefer / by default → 中等置信度', () => {
    expect(extractCandidates('I prefer pnpm by default.')).toEqual([
      {
        topic: 'tooling.package-manager',
        statement: 'I prefer pnpm by default',
        confidence: MEDIUM_CONFIDENCE,
      },
    ])
  })

  it('always → 强置信度', () => {
    expect(extractCandidates('Always use vitest for tests!')).toEqual([
      {
        topic: 'code.testing',
        statement: 'Always use vitest for tests',
        confidence: STRONG_CONFIDENCE,
      },
    ])
  })

  it('never → 强置信度', () => {
    expect(extractCandidates('Never use npm again.')).toEqual([
      {
        topic: 'tooling.package-manager',
        statement: 'Never use npm again',
        confidence: STRONG_CONFIDENCE,
      },
    ])
  })

  it('use X instead → 中等置信度', () => {
    expect(extractCandidates('Use pnpm instead of npm.')).toEqual([
      {
        topic: 'tooling.package-manager',
        statement: 'Use pnpm instead of npm',
        confidence: MEDIUM_CONFIDENCE,
      },
    ])
  })

  it('英文句号 + 空格分句', () => {
    const candidates = extractCandidates('By default use pnpm. Never use npm.')
    expect(candidates.map((item) => item.statement)).toEqual([
      'By default use pnpm',
      'Never use npm',
    ])
    expect(candidates.map((item) => item.confidence)).toEqual([
      MEDIUM_CONFIDENCE,
      STRONG_CONFIDENCE,
    ])
  })
})

describe('extractCandidates 弱化词与置信度', () => {
  it('去掉「我觉得」', () => {
    expect(extractCandidates('我觉得以后都用 pnpm。')).toEqual([
      {
        topic: 'tooling.package-manager',
        statement: '以后都用 pnpm',
        confidence: STRONG_CONFIDENCE,
      },
    ])
  })

  it('去掉「可能」且保留习惯句式的中间置信度', () => {
    expect(extractCandidates('我可能更喜欢 cursor。')).toEqual([
      {
        topic: 'tooling.editor',
        statement: '我更喜欢 cursor',
        confidence: MEDIUM_CONFIDENCE,
      },
    ])
  })

  it('去掉英文弱化词 I think', () => {
    expect(extractCandidates('I think use pnpm instead of npm.')).toEqual([
      {
        topic: 'tooling.package-manager',
        statement: 'use pnpm instead of npm',
        confidence: MEDIUM_CONFIDENCE,
      },
    ])
  })

  it('弱倾向句式给出最低置信度', () => {
    const candidates = extractCandidates('尽量用 pnpm 装依赖。')
    expect(candidates).toHaveLength(1)
    expect(candidates[0].confidence).toBe(WEAK_CONFIDENCE)
  })

  it('所有置信度都在 0.6–0.9 区间', () => {
    const text = '以后都用 pnpm。我习惯用 vitest。尽量用 vscode。不要再使用 npm。'
    const candidates = extractCandidates(text)
    expect(candidates.length).toBeGreaterThan(0)
    for (const candidate of candidates) {
      expect(candidate.confidence).toBeGreaterThanOrEqual(0.6)
      expect(candidate.confidence).toBeLessThanOrEqual(0.9)
    }
  })
})

describe('extractCandidates 边界', () => {
  it('没有偏好句式的句子被丢弃', () => {
    expect(extractCandidates('今天天气不错。')).toEqual([])
    expect(extractCandidates('pnpm 是一个包管理器。')).toEqual([])
  })

  it('匹配不到固定词表 topic 的候选被丢弃', () => {
    expect(extractCandidates('我觉得这样更好。')).toEqual([])
    expect(extractCandidates('以后都这样做。')).toEqual([])
  })

  it('ASCII 关键词按词边界匹配（ide 不命中 inside）', () => {
    expect(extractCandidates('Always prefer inside knowledge.')).toEqual([])
  })

  it('每句最多一条：同句两个 topic 只取最高分', () => {
    const candidates = extractCandidates('统一用 pnpm 和 vitest')
    expect(candidates).toHaveLength(1)
    expect(candidates[0].topic).toBe('tooling.package-manager')
  })

  it('多个句子各自产出候选', () => {
    const candidates = extractCandidates('以后都用 pnpm。统一用 vitest。')
    expect(candidates.map((item) => item.topic)).toEqual([
      'tooling.package-manager',
      'code.testing',
    ])
  })

  it('重复句子去重', () => {
    expect(extractCandidates('以后都用 pnpm。以后都用 pnpm。')).toHaveLength(1)
  })

  it('截断到 200 字符', () => {
    const longText = `以后都用 pnpm ${'依赖'.repeat(120)}。`
    const candidates = extractCandidates(longText)
    expect(candidates).toHaveLength(1)
    expect(Array.from(candidates[0].statement)).toHaveLength(MAX_STATEMENT_LENGTH)
    expect(candidates[0].statement.startsWith('以后都用 pnpm 依赖')).toBe(true)
  })

  it('空文本返回空数组', () => {
    expect(extractCandidates('')).toEqual([])
    expect(extractCandidates('   \n\t ')).toEqual([])
  })

  it('source 原样透传，未提供则无 source 字段', () => {
    const source = { session: 'sess-1', message: 'msg-1' }
    const [withSource] = extractCandidates('以后都用 pnpm。', source)
    expect(withSource.source).toEqual(source)

    const [withoutSource] = extractCandidates('以后都用 pnpm。')
    expect(withoutSource.source).toBeUndefined()
  })
})

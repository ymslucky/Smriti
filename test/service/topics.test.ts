/** 主题 id 语法与种子提示：主题不再有固定词表，只剩语法门禁。 */

import { describe, expect, it } from 'vitest'

import {
  MAX_TOPIC_ID_LENGTH,
  MAX_TOPIC_SEGMENTS,
  TOPIC_HINTS,
  descriptionForTopic,
  hintFor,
  isValidTopicId,
  isWithinTopic,
  labelForTopic,
  parentOf,
  rootOf,
  topicDepth,
} from '../../src/topics'

describe('主题 id 语法', () => {
  it('接受自由 slug 与最多 3 段的点分层级', () => {
    for (const topic of [
      'identity',
      'identity.role',
      'code.style.indent',
      'project.smriti.stack',
      'tooling.package-manager',
      'a1.b2-c3',
    ]) {
      expect(isValidTopicId(topic)).toBe(true)
    }
  })

  it('拒绝大小写、空格、下划线、空段与过深层级', () => {
    for (const topic of [
      '',
      'Identity',
      'identity role',
      'identity_role',
      '.identity',
      'identity.',
      'identity..role',
      'a.b.c.d',
      'a'.repeat(MAX_TOPIC_ID_LENGTH + 1),
    ]) {
      expect(isValidTopicId(topic)).toBe(false)
    }
    expect(MAX_TOPIC_SEGMENTS).toBe(3)
  })

  it('拒绝保留段（下划线开头）', () => {
    expect(isValidTopicId('_meta')).toBe(false)
    expect(isValidTopicId('_meta.topics')).toBe(false)
  })
})

describe('种子提示', () => {
  it('提示 id 全部合法且不重复', () => {
    const ids = TOPIC_HINTS.map((hint) => hint.topic)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) expect(isValidTopicId(id)).toBe(true)
  })

  it('未知主题回退到 id 本身', () => {
    expect(hintFor('identity.role')).toBeUndefined()
    expect(labelForTopic('identity.role')).toBe('identity.role')
    expect(descriptionForTopic('identity.role')).toBe('')
  })

  it('已知主题使用种子提示的中文名与说明', () => {
    expect(labelForTopic('code.style.indent')).toBe('缩进')
    expect(descriptionForTopic('code.style.indent')).toContain('空格')
  })
})

describe('层级推导', () => {
  it('段数、根与父前缀', () => {
    expect(topicDepth('identity')).toBe(0)
    expect(topicDepth('identity.role')).toBe(1)
    expect(topicDepth('project.smriti.stack')).toBe(2)
    expect(rootOf('project.smriti.stack')).toBe('project')
    expect(parentOf('project.smriti.stack')).toBe('project.smriti')
    expect(parentOf('identity')).toBeUndefined()
  })

  it('子树判定按点分前缀，不误命中同前缀主题', () => {
    expect(isWithinTopic('code.style.indent', 'code.style')).toBe(true)
    expect(isWithinTopic('code.style', 'code.style')).toBe(true)
    expect(isWithinTopic('code.style2', 'code.style')).toBe(false)
    expect(isWithinTopic('code', 'code.style')).toBe(false)
  })
})

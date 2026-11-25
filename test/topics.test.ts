import { describe, expect, it } from 'vitest'

import { labelForTopic } from '../src/topics'

describe('labelForTopic', () => {
  it('优先使用种子提示的中文展示名', () => {
    expect(labelForTopic('workflow.interaction')).toBe('协作方式')
    expect(labelForTopic('workflow.git')).toBe('Git 流程')
    expect(labelForTopic('tooling.package-manager')).toBe('包管理器')
  })

  it('没有种子提示时按分段给中文回退，未知段保留原文', () => {
    expect(labelForTopic('workflow.review')).toBe('工作流 · 评审')
    expect(labelForTopic('workflow.unknown')).toBe('工作流 · unknown')
  })
})

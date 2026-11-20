/** 固定主题词表。模型只能使用这里的 topic；新增主题需要人工修改本文件。 */

export interface TopicDefinition {
  topic: string
  label: string
  description: string
  /** 自动捕获时的关键词提示，仅用于启发式分类。 */
  keywords: readonly string[]
}

export const TOPICS: readonly TopicDefinition[] = [
  {
    topic: 'tooling.package-manager',
    label: '包管理器',
    description: 'pnpm / npm / yarn 的选择、lockfile 与依赖安装习惯',
    keywords: ['pnpm', 'npm', 'yarn', 'lockfile', '依赖', '包管理'],
  },
  {
    topic: 'tooling.runtime',
    label: '运行时',
    description: 'Node / Deno / Bun 的版本与运行时选择',
    keywords: ['node', 'deno', 'bun', '版本', 'runtime'],
  },
  {
    topic: 'tooling.editor',
    label: '编辑器',
    description: '编辑器、IDE、插件与快捷键习惯',
    keywords: ['vscode', 'cursor', '编辑器', 'ide', '插件'],
  },
  {
    topic: 'tooling.shell',
    label: '终端',
    description: 'shell、终端模拟器、命令行工具',
    keywords: ['shell', 'pwsh', 'powershell', 'bash', 'zsh', '终端'],
  },
  {
    topic: 'code.style',
    label: '代码风格',
    description: '命名、格式、注释与目录结构偏好',
    keywords: ['命名', '格式', '注释', '目录', 'eslint', 'prettier'],
  },
  {
    topic: 'code.testing',
    label: '测试',
    description: '测试框架、覆盖率与 TDD 习惯',
    keywords: ['测试', 'test', 'vitest', 'jest', '覆盖率', 'tdd'],
  },
  {
    topic: 'code.review',
    label: '代码评审',
    description: '评审方式、提交粒度与反馈风格',
    keywords: ['评审', 'review', '提交', 'commit 粒度'],
  },
  {
    topic: 'workflow.git',
    label: 'Git 流程',
    description: '分支模型、commit message、merge / rebase',
    keywords: ['git', '分支', 'commit', 'rebase', 'merge'],
  },
  {
    topic: 'workflow.release',
    label: '发布流程',
    description: '版本号、发布、部署与回滚',
    keywords: ['版本', 'release', '发布', '部署', '回滚'],
  },
  {
    topic: 'communication.language',
    label: '语言',
    description: '中英文使用、术语与命名语言',
    keywords: ['中文', '英文', '语言', '术语'],
  },
  {
    topic: 'communication.format',
    label: '回答格式',
    description: '回答长度、结构、代码块与列表偏好',
    keywords: ['格式', '长度', '结构', '代码块', '简洁'],
  },
  {
    topic: 'environment.os',
    label: '系统环境',
    description: '操作系统、路径、换行与编码',
    keywords: ['windows', 'macos', 'linux', '路径', '换行', '编码'],
  },
]

export const TOPIC_NAMES: readonly string[] = TOPICS.map((item) => item.topic)

export function isKnownTopic(topic: string): boolean {
  return TOPIC_NAMES.includes(topic)
}

export function topicDefinition(topic: string): TopicDefinition | undefined {
  return TOPICS.find((item) => item.topic === topic)
}

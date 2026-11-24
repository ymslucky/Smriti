/**
 * 主题**种子提示**（不是白名单）。
 *
 * 主题由 AI 在写入时自由创建：`memory_upsert` 的 `topic` 只要满足 slug 语法就接受，
 * 首次出现即成为主题；点分表示层级（`identity.role`），最多 3 段。
 * 这里的数据只做三件事：
 * 1. 给常见 id 一个稳定的中文展示名与说明（新主题没传 `topic_label` 时 UI 回退到 id）；
 * 2. 给自动捕获提供关键词提示；
 * 3. 给文档与测试提供一组推荐写法。
 *
 * 判定规则（叶子 / 分类）不从这里来，而是从 R2 里**实际存在的主题**推导：
 * 有子主题的主题是分类（可多条），没有子主题的主题是槽位（一条）。
 */

export interface TopicHint {
  topic: string
  label: string
  description: string
  /** 自动捕获时的关键词提示，仅用于启发式分类。 */
  keywords: readonly string[]
}

/** 推荐的常见主题（AI 可以创建任意其它 id，不受此表限制）。 */
export const TOPIC_HINTS: readonly TopicHint[] = [
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
    keywords: ['编辑器', 'ide', '开发工具', 'vscode', 'cursor'],
  },
  {
    topic: 'tooling.shell',
    label: '终端',
    description: 'shell、终端模拟器、命令行工具',
    keywords: ['终端', 'shell', '命令行', 'pwsh', 'powershell'],
  },
  {
    topic: 'code.style',
    label: '代码风格',
    description: '命名、格式、注释与目录结构偏好',
    keywords: ['代码风格', '格式', 'eslint', 'prettier', '代码规范'],
  },
  {
    topic: 'code.testing',
    label: '测试',
    description: '测试框架、覆盖率与 TDD 习惯',
    keywords: ['测试', 'test', '测试策略', 'tdd'],
  },
  {
    topic: 'code.review',
    label: '代码评审',
    description: '评审方式、提交粒度与反馈风格',
    keywords: ['评审', 'review', '代码评审'],
  },
  {
    topic: 'workflow.git',
    label: 'Git 流程',
    description: '分支模型、commit message、merge / rebase',
    keywords: ['git', '版本控制', '合并', '分支模型'],
  },
  {
    topic: 'workflow.release',
    label: '发布流程',
    description: '版本号、发布、部署与回滚',
    keywords: ['发布', 'release', '发布流程', '上线'],
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
    keywords: ['回答格式', '格式', '回答风格', '回答'],
  },
  {
    topic: 'environment.os',
    label: '系统环境',
    description: '操作系统、路径、换行与编码',
    keywords: ['系统环境', '操作系统', '环境'],
  },
  {
    topic: 'code.style.indent',
    label: '缩进',
    description: '用空格还是 tab、每级几个空格',
    keywords: ['缩进', 'indent', 'tab', '空格'],
  },
  {
    topic: 'code.style.naming',
    label: '命名',
    description: '变量 / 函数 / 文件的命名法（camelCase、snake_case 等）',
    keywords: ['命名', 'camelcase', 'snake_case', 'kebab', '命名法'],
  },
  {
    topic: 'code.style.comment',
    label: '注释',
    description: '注释语言、密度与文档注释习惯',
    keywords: ['注释', 'comment', 'jsdoc', '文档注释'],
  },
  {
    topic: 'code.style.structure',
    label: '目录结构',
    description: '目录组织、文件放置与模块边界',
    keywords: ['目录', '结构', '目录结构', '文件夹', '模块划分'],
  },
  {
    topic: 'code.testing.framework',
    label: '测试框架',
    description: 'vitest / jest / node:test 等框架选择',
    keywords: ['vitest', 'jest', 'node:test', '测试框架', 'mocha', 'pytest'],
  },
  {
    topic: 'code.testing.coverage',
    label: '覆盖率',
    description: '覆盖率目标、阈值与是否强制',
    keywords: ['覆盖率', 'coverage', '覆盖阈值'],
  },
  {
    topic: 'code.review.granularity',
    label: '提交粒度',
    description: '单次提交 / PR 的大小与拆分方式',
    keywords: ['提交粒度', 'commit 粒度', '拆分', 'pr 大小', '提交大小'],
  },
  {
    topic: 'code.review.feedback',
    label: '反馈风格',
    description: '评审意见的语气、详略与给法',
    keywords: ['评审意见', '反馈', '语气', '评论', 'review 意见'],
  },
  {
    topic: 'workflow.git.branch',
    label: '分支模型',
    description: '主干、分支命名与合并流向',
    keywords: ['分支', 'branch', '主干', 'feature'],
  },
  {
    topic: 'workflow.git.commit-message',
    label: '提交信息',
    description: 'commit message 的语言与格式（conventional 等）',
    keywords: ['commit message', '提交信息', 'conventional', '提交规范'],
  },
  {
    topic: 'workflow.git.merge',
    label: '合并策略',
    description: 'merge / rebase / squash 的选择',
    keywords: ['rebase', 'merge', 'squash', '合并策略', '快进'],
  },
  {
    topic: 'workflow.release.versioning',
    label: '版本号',
    description: '语义化版本与版本号推进规则',
    keywords: ['版本号', 'semver', '语义化版本', '版本'],
  },
  {
    topic: 'workflow.release.deploy',
    label: '发布部署',
    description: '发布流程、审批、部署方式与回滚',
    keywords: ['部署', 'deploy', '上线', '回滚'],
  },
  {
    topic: 'communication.format.length',
    label: '回答长度',
    description: '回答篇幅与详略偏好',
    keywords: ['长度', '篇幅', '简短', '详细', '简洁'],
  },
  {
    topic: 'communication.format.structure',
    label: '回答结构',
    description: '段落、列表、代码块与小标题的组织偏好',
    keywords: ['结构', '列表', '代码块', '小标题', '段落', '分点'],
  },
  {
    topic: 'environment.os.platform',
    label: '操作系统',
    description: 'Windows / macOS / Linux 的使用与差异',
    keywords: ['windows', 'macos', 'linux', 'wsl', '平台'],
  },
  {
    topic: 'environment.os.paths',
    label: '路径',
    description: '路径写法、分隔符与工作目录习惯',
    keywords: ['路径', 'path', '分隔符', '盘符'],
  },
  {
    topic: 'environment.os.encoding',
    label: '换行与编码',
    description: '换行符、编码与终端字符集',
    keywords: ['换行', 'crlf', 'lf', '编码', 'utf-8', '字符集'],
  },
  {
    topic: 'tooling.shell.shell',
    label: 'Shell 选择',
    description: 'bash / zsh / pwsh 等 shell 选择',
    keywords: ['shell', 'bash', 'zsh', 'pwsh', 'powershell', 'fish'],
  },
  {
    topic: 'tooling.shell.cli-tools',
    label: '命令行工具',
    description: '常用 CLI 工具与别名',
    keywords: ['cli', '命令行工具', 'alias', 'ripgrep', 'fd', 'jq'],
  },
  {
    topic: 'tooling.editor.editor',
    label: '编辑器选择',
    description: '编辑器 / IDE 的选择',
    keywords: ['vscode', 'cursor', 'neovim', 'idea', '编辑器', 'ide'],
  },
  {
    topic: 'tooling.editor.extensions',
    label: '插件',
    description: '插件、扩展与配置同步',
    keywords: ['插件', '扩展', 'extension', '配置同步'],
  },
]

/** 主题 id 的最长长度。 */
export const MAX_TOPIC_ID_LENGTH = 64
/** 主题 id 最多段数：3 段足够表达 `域.子域.槽`。 */
export const MAX_TOPIC_SEGMENTS = 3

/**
 * 主题 id 语法：小写字母 / 数字 / 连字符，点分最多 3 段。
 * 与 R2 key 的 `assertTopic`（`^[a-z0-9._-]+$`）兼容，但更严格地约束段格式。
 */
const TOPIC_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\.[a-z0-9]+(?:-[a-z0-9]+)*){0,2}$/

const HINTS = new Map<string, TopicHint>(TOPIC_HINTS.map((hint) => [hint.topic, hint]))

/** 主题 id 是否合法（这是唯一的门禁：不看词表，只看语法）。 */
export function isValidTopicId(topic: string): boolean {
  if (typeof topic !== 'string') return false
  if (topic.length === 0 || topic.length > MAX_TOPIC_ID_LENGTH) return false
  if (!TOPIC_ID_PATTERN.test(topic)) return false
  // `_meta` 等以下划线开头的保留段不进入主题空间。
  return !topic.startsWith('_') && !topic.includes('._')
}

/** 种子提示；新主题没有提示时返回 undefined。 */
export function hintFor(topic: string): TopicHint | undefined {
  return HINTS.get(topic)
}

/** 段数（1 段 = 根，2 段 = 一级细分）。 */
export function topicDepth(topic: string): number {
  return topic.split('.').length - 1
}

/** 第一段，作为"同一族"判定的依据。 */
export function rootOf(topic: string): string {
  return topic.split('.')[0] ?? topic
}

/** 直接父前缀（不一定真实存在为主题）。 */
export function parentOf(topic: string): string | undefined {
  const index = topic.lastIndexOf('.')
  return index <= 0 ? undefined : topic.slice(0, index)
}

/** `topic` 是否落在 `scope` 子树内（含自身），按点分前缀判断。 */
export function isWithinTopic(topic: string, scope: string): boolean {
  if (topic === scope) return true
  return topic.startsWith(`${scope}.`)
}

/** 展示名：优先种子提示的中文名，否则用 id 本身。 */
export function labelForTopic(topic: string): string {
  return hintFor(topic)?.label ?? topic
}

/** 说明：新主题没有说明，返回空串（UI 用占位文案）。 */
export function descriptionForTopic(topic: string): string {
  return hintFor(topic)?.description ?? ''
}

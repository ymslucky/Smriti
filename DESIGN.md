---
name: Smriti
description: 只读记忆网关看板——装订与纸页的世界，克制的档案气质，数据表是主角。
colors:
  paper: "#f2f3ed"
  surface: "#fafbf6"
  ink: "#161a16"
  ink-secondary: "#444b43"
  ink-muted: "#5f665b"
  rule: "#d4d8cb"
  rule-strong: "#aeb4a4"
  rule-soft: "#e4e7dd"
  row-hover: "#e9ebe2"
  select: "#cfe2d3"
  bind: "#24483a"
  bind-hover: "#2e5443"
  bind-ink: "#edf1e6"
  bind-ink-muted: "#b7c9bd"
  bind-rule: "#3a5e4e"
  accent: "#2a5745"
  accent-strong: "#1f4536"
  accent-ink: "#f7f9f2"
  brass: "#6f4f16"
  brass-soft: "#ede3c9"
  danger: "#872c25"
  danger-soft: "#f1dcd6"
  focus: "#1e5f8c"
  focus-on-bind: "#e7d6a2"
  selection: "#cfe2d3"
  paper-dark: "#131611"
  surface-dark: "#191d17"
  ink-dark: "#e7e9e0"
  ink-secondary-dark: "#b7bdb0"
  ink-muted-dark: "#8f9587"
  rule-dark: "#2b3129"
  rule-strong-dark: "#3e463c"
  rule-soft-dark: "#232821"
  row-hover-dark: "#1e231c"
  select-dark: "#2c4c3c"
  bind-dark: "#1b3a2f"
  bind-hover-dark: "#234538"
  bind-ink-dark: "#e4eadf"
  bind-ink-muted-dark: "#a9beb1"
  bind-rule-dark: "#2c5244"
  accent-dark: "#8fbfaa"
  accent-strong-dark: "#a6d2be"
  accent-ink-dark: "#10201a"
  brass-dark: "#d2b071"
  brass-soft-dark: "#33291a"
  danger-dark: "#e0958a"
  danger-soft-dark: "#35211f"
  focus-dark: "#8fc4e6"
typography:
  brand:
    fontFamily: "Iowan Old Style, Palatino Linotype, Palatino, Book Antiqua, Georgia, Songti SC, Noto Serif CJK SC, SimSun, serif"
    fontSize: "1.5rem"
    fontWeight: 400
    lineHeight: 1.1
    letterSpacing: "0.02em"
  section-title:
    fontFamily: "Iowan Old Style, Palatino Linotype, Palatino, Book Antiqua, Georgia, Songti SC, Noto Serif CJK SC, SimSun, serif"
    fontSize: "1.375rem"
    fontWeight: 600
    lineHeight: 1.3
  stat-numeral:
    fontFamily: "Iowan Old Style, Palatino Linotype, Palatino, Book Antiqua, Georgia, Songti SC, Noto Serif CJK SC, SimSun, serif"
    fontSize: "2rem"
    fontWeight: 400
    lineHeight: 1
  subhead:
    fontFamily: "Iowan Old Style, Palatino Linotype, Palatino, Book Antiqua, Georgia, Songti SC, Noto Serif CJK SC, SimSun, serif"
    fontSize: "1.125rem"
    fontWeight: 600
    lineHeight: 1.4
  body:
    fontFamily: "Segoe UI, system-ui, -apple-system, PingFang SC, Microsoft YaHei, Hiragino Sans GB, Noto Sans CJK SC, sans-serif"
    fontSize: "0.9375rem"
    fontWeight: 400
    lineHeight: 1.65
  secondary:
    fontFamily: "Segoe UI, system-ui, -apple-system, PingFang SC, Microsoft YaHei, sans-serif"
    fontSize: "0.8125rem"
    fontWeight: 400
    lineHeight: 1.7
  label:
    fontFamily: "Segoe UI, system-ui, -apple-system, PingFang SC, Microsoft YaHei, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 600
    lineHeight: 1.5
    letterSpacing: "0.06em"
  identifier:
    fontFamily: "ui-monospace, Cascadia Mono, SFMono-Regular, Menlo, Consolas, monospace"
    fontSize: "0.75rem"
    fontWeight: 400
    lineHeight: 1.5
rounded:
  flat: "0"
  sm: "1px"
  md: "2px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
  section: "40px"
  block: "48px"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.accent-ink}"
    rounded: "{rounded.md}"
    padding: "8px 14px"
    typography: "{typography.label}"
  button-primary-hover:
    backgroundColor: "{colors.accent-strong}"
    textColor: "{colors.accent-ink}"
  button:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "8px 14px"
  input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "8px 11px"
  nav-link-active:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    padding: "13px 14px 11px"
  stat-cell:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    padding: "18px 20px"
  slip:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
  table-header:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink-muted}"
    padding: "10px 16px 10px 0"
---

# Design System: Smriti

## Overview

Smriti 的只读看板是**一本装订好的记录册**：深绿布面（书脊/封面）压住纸页正文，数据在纸面上以细线表格排开。表面模式是 **Operate**——用户来这里核对「现在是什么样」，所以世界只提供四样东西：字体、配色、密度、一个记忆点（待裁决的勘误式对比）；布局、导航与控制全部使用平台惯例。

这个世界的反参考是仪表盘常态：卡片网格、大圆角、渐变、玻璃拟态、悬浮阴影、彩色左边框。本页一个都不用。个性来自排版纪律：衬线标题、等宽标识符、1px 细线、几乎为零的圆角、纸面与墨色的对比。

只读是产品事实，也是视觉事实：页面上唯一的主按钮是「搜索」，唯一的写入动作指向 dsh 里的 `/memory` 命令。

## Colors

颜色按职责分配，不做装饰：

| 角色 | 浅色 | 深色 | 用在哪里 |
|---|---|---|---|
| `paper` | `#f2f3ed` | `#131611` | 页面底色（纸面 / 墨底） |
| `surface` | `#fafbf6` | `#191d17` | 输入框、勘误单、空状态块 |
| `ink` | `#161a16` | `#e7e9e0` | 正文、标题 |
| `ink-secondary` | `#444b43` | `#b7bdb0` | 次要文本、主题列、现行陈述 |
| `ink-muted` | `#5f665b` | `#8f9587` | 列头、时间、字段标签、说明 |
| `rule` / `rule-strong` / `rule-soft` | `#d4d8cb` / `#aeb4a4` / `#e4e7dd` | `#2b3129` / `#3e463c` / `#232821` | 1px 分隔线、计数条轨道 |
| `bind` | `#24483a` | `#1b3a2f` | 页头（装订）底色 |
| `bind-ink` | `#edf1e6` | `#e4eadf` | 页头上的文字 |
| `accent` | `#2a5745` | `#8fbfaa` | 链接、主按钮、计数条填充、选中态 |
| `brass` | `#6f4f16` | `#d2b071` | **只给「待裁决」**：计数、冲突类型标记、AI Search 未就绪 |
| `danger` | `#872c25` | `#e0958a` | 错误文字、错误块标记、鉴权横幅 |
| `focus` | `#1e5f8c` | `#8fc4e6` | 纸面上的焦点环；页头上用 `focus-on-bind` `#e7d6a2` |

**命名规则 · 黄铜只属于积压。** `brass` 是「需要人处理」的信号色，只出现在待裁决相关元素上；任何常规信息不得使用它。

**命名规则 · 绿是操作色。** `accent` 表示可交互或已完成（链接、主按钮、计数条、焦点邻近态），不用于装饰性强调。

所有实测对比度（WCAG AA，正文 ≥4.5:1）：浅色最低 **4.93:1**（`ink-muted` 在 `row-hover` 上），深色最低 **5.19:1**；标题、正文、按钮文字、页头文字、错误文字、焦点环全部通过。深色不是自动反转，而是重新取的一组墨色。

## Typography

三套字，都有明确分工，全部来自系统栈（无外部字体、无网络请求）：

- **衬线**（Iowan Old Style / Palatino / Georgia → Songti SC / SimSun）：品牌、区块标题、统计数字、主题名。它是「印刷品」的那一层。
- **无衬线**（Segoe UI / system-ui / PingFang SC / Microsoft YaHei）：所有正文、控件、表格。
- **等宽**（ui-monospace / Cascadia Mono / Consolas）：主题标识符（`tooling.package-manager`）、changeId。等宽只用于标识符与代码，不做「技术感」装饰。

级差是紧凑的印刷级差，不是落地页级差，一共七步：统计数字 32px / 品牌 24px / 区块标题 22px / 强调数字与小标题 18px / 正文 15px / 次要 13px / 标签 12px。代码与主题标识符用 `0.86em` 跟随所在级。数字与时间一律 `font-variant-numeric: tabular-nums`，保证列对齐。

**命名规则 · 衬线只做标题与计数。** 一个界面元素要么是「印刷层的标题/数字」，要么是「操作层的文字」；不给控件配衬线。

**命名规则 · 时间格式固定。** 时间统一 `YYYY-MM-DD HH:mm`（本地时区），手工补零，不依赖 `toLocaleString` 的区域数据；数字用千分位手工分组。同一个值在任何环境显示一致。

## Layout

单栏连续分区，无卡片网格：

- 页头（装订）：高约 70px，左品牌、右「只读视图 · 裁决在 dsh 内完成 + 刷新」；
- 分段导航：粘性吸顶（48px），四项带计数，`aria-current` 时 2px 绿色下划线；
- 内容：`max-width: 1200px`，左右 `clamp(16px, 4vw, 32px)`；
- 概览：4 格统计带（1px 竖线分隔）→ 下方左右两栏（最近更新 1.7fr / 运行状态 1fr），栏间距 48px；
- 记忆：筛选行（输入 + 搜索 + 清除 + 主题下拉）→ 模式行 → 表格；表头在页面滚动时粘在导航下方；
- 待裁决：说明行 → 勘误单列表（间距 14px）；
- 主题：根主题行 + 缩进一级的细分主题行，「名称 + 标识符 / 说明 / 计数条 / 数字」四列网格。

断点：1000px 概览单列；820px 统计带 2×2、主题行改为「名称+数字 / 说明 / 条」三行；700px 勘误单两栏叠成一栏、最近更新改为「主题+时间 / 陈述」；620px 表格转为堆叠行（主题+版本 / 陈述 / 时间），表头视觉隐藏但保留给辅助技术。375px 为设计下限，无横向滚动。

区块间距 40px，标题上方留白大于下方（40 / 18），组内 8–14px。正文行宽 ≤68ch。

## Elevation & Depth

**平面层级，不用阴影。** 深度由三样东西制造：装订色块的对比、1px 细线的密度、纸面与 `surface` 的极浅差（约 2% 明度）。页面上没有投影、没有模糊、没有玻璃效果；唯一的「浮起」是粘性导航与粘性表头，靠不透明纸色遮住滚动内容。

**命名规则 · 零阴影。** 新增元素不得引入 `box-shadow`；需要区分层次时用 `rule` 细线或 `surface` 底色。

## Shapes

圆角近乎为零：输入框/按钮/勘误单/空状态块 `2px`，代码与标识符 `1px`，表格、统计带、分区、计数条 `0`。没有胶囊、没有圆形头像位。

线是主要形状语言：1px 水平细线贯穿全页（分区之间、表格行之间、列表行之间、状态行之间）；统计带用 1px 竖线分栏。禁止彩色 `border-left/right` 大于 1px 的块。

## Components

### Buttons

- 主按钮（搜索）：`accent` 底 + `accent-ink` 文字，2px 圆角，`8px 14px`，hover 变 `accent-strong`；
- 次按钮（刷新、重试、清除主题筛选）：透明底 + `rule-strong` 1px 边，hover 加 `row-hover` 底；
- 页头上的按钮：页头色系（`bind-rule` 边、`bind-ink` 字），hover 用 `bind-hover`；
- 文字按钮（清除搜索）：无边框、`ink-secondary`，hover 才出现边框；
- 小按钮（复制 changeId、区块重试）：`5px 10px` / 12px。

所有按钮 `:focus-visible` 用 2px 焦点环、偏移 2px，不做位移或缩放。

### Inputs / Fields

标签在输入框上方（12px `ink-muted`），输入框 `surface` 底 + `rule-strong` 1px 边 + 2px 圆角，占位文字 `ink-muted`；焦点态边框与 2px 焦点环同色（`focus`）。主题筛选使用原生 `<select>`（保留系统下拉箭头），不做自绘。

### Cards / Containers

没有卡片组件。区块是「细线 + 留白」；只有两种容器真正有边界：勘误单（`rule-strong` 1px 边、`surface` 底、2px 圆角）与空/错误状态块（`rule` 1px 边、`surface` 底）。嵌套容器禁止。

### Navigation

粘性顶部导航，四项：概览 / 记忆 / 待裁决 / 主题。每项带计数（11px `ink-muted`，待裁决 > 0 时变 `brass`）；当前项 `aria-current="true"` + 2px 下划线 + `ink` 字色。高亮跟随滚动位置（以视口上方 140px 为判定线），不是视口中线。窄屏横向滚动，不换行。

### Erratum slip（签名组件）

待裁决的「勘误单」是本页唯一的记忆点，结构固定：

1. 头行：类型标记（色块 + 中文标签：冲突 / 疑似重复 / 新主题）· 主题名 · 右对齐创建时间；
2. 对勘区：左「现行」（含 `· vN`，`ink-secondary` 文字）/ 右「提议」（含置信度 `0.61`），中间 1px 竖线；无现行记录时写「（无现行记录，批准后会新建一条）」；
3. 尾行：`changeId` 标签 + 等宽 id（`user-select: all`）+ 复制按钮 + 就地反馈（「已复制」/「复制失败，请手动选中」）。

窄屏时对勘区叠成上下两段，分隔线由竖转横。复制失败不弹窗、不清空，用户可以直接手动选中 id。

### States

- 加载：骨架块（`rule-soft`，1.5s 呼吸）替代数字、表格行、列表项、勘误单；
- 空：`surface` 底的状态块，标题 + 一句说明（无记忆 / 没有待裁决 / 该主题还没有记忆 / 没有命中的记忆），有恢复动作时给按钮；
- 错误：**一行** `inline-error`（红色方点 + 加粗标题 + `·` + 恢复提示 + 重试），整页级失败（401/403/网络）只在上方横幅说明一次，区块行改为「原因见页面顶部提示」；
- 鉴权失败：页头下红色横幅（`danger` 边 + `danger-soft` 底），标题说清是 Access，正文给出重新登录/策略两条恢复路径。

### Meter（主题计数条）

原生 `<progress>`：高 8px、0 圆角、`rule-soft` 轨道、`accent` 填充，`max` 取当前最大计数，右侧给等宽数字。`aria-label` 为「主题名：N 条记忆」。

## Do's and Don'ts

### Do:

- 让细线和留白承担结构，让衬线只承担标题与数字；
- 所有后端文本走 `textContent`；标识符用等宽、可整段选中；
- 数字用 tabular-nums，时间用固定 `YYYY-MM-DD HH:mm`；
- 每次改动都在 1280 / 768 / 375 三个宽度与深浅两套配色下看一遍；
- 错误写清「哪里断了 + 怎么恢复」，空状态写清「下一步会发生什么」。

### Don't:

- 不用卡片网格、渐变、玻璃拟态、投影、彩色左边框、大圆角；
- 不用黄铜色表示非积压信息，不用绿色表示纯装饰；
- 不在标题上方加小标签（kicker），不给分区编号；
- 不用等宽字体装饰「技术感」，不用 emoji 当图标；
- 不把写入/审批/删除做成按钮——它们属于 dsh 命令。

## Direction contract

> 本应写入 surface brief，但本次任务的写入范围只到 `PRODUCT.md` / `DESIGN.md` / `docs/ui.md`，故记录在此。

**THESIS**：Smriti 的看板是一本装订好的记录册，不是仪表盘——深绿布面压住纸页，数据以连续分区与 1px 细线表格排布，拒绝卡片网格、圆角大块与渐变装饰。

**OWN-WORLD**：纸面 `#f2f3ed` + 墨色 `#161a16` + 布面绿 `#24483a` + 黄铜 `#6f4f16`（只给积压）；衬线标题/数字、无衬线正文、等宽标识符；表格靠细线分栏、2px 圆角上限、零阴影、零渐变。

**STORY**：用户在 3 秒内读到「记忆 14 / 待裁决 3 / 主题 6 / 检索就绪」，再向下读完记忆表、待裁决的旧→新对勘、主题树上各主题的分布；所有写入路径被明确指向 dsh 命令，页面不给假按钮。

**FIRST VIEWPORT**：装订页头（品牌 · 竖线 · 副名；右侧「只读视图 · 裁决在 dsh 内完成」+ 刷新）→ 吸顶分段导航（四项带计数）→ 4 格统计带（竖线分栏）→ 左「最近更新 5 条」/ 右「运行状态」四行定义列表。

**FORM**：结构清单第 1 位「装订记录册 + 数据表」，按要求只做 cod-led（Operate 表面）。`seed: none (pinned)`——brief 指定「档案 / 图书馆的克制气质——纸墨底色、衬线标题、清晰的数据表；不要紫色渐变、玻璃拟态、大圆角卡片堆砌」。

**FINISH**：unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance.

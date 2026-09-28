# diff-sense

轻量级 AI 驱动的代码审查 CLI 工具。由确定性流水线负责文件筛选和行号锚定，由 LLM Agent 循环完成实际审查。

## Rules

- **Be opinionated.** When multiple words exist for the same concept, pick the best one and list the others under `_Avoid_`.
- **Keep definitions tight.** One or two sentences max. Define what it IS, not what it does.
- **Only include terms specific to this project's context.** General programming concepts (timeouts, error types, utility patterns) don't belong even if the project uses them extensively. Before adding a term, ask: is this a concept unique to this context, or a general programming concept? Only the former belongs.
- **Group terms under subheadings** when natural clusters emerge. If all terms belong to a single cohesive area, a flat list is fine.

## Language

### 审查流水线 (Review Pipeline)

**审查 (Review)**:
对一个差异的一次完整审查调用，产出零个或多个发现 (Finding)。
_Avoid_: Audit, scan, check

**差异 (Diff)**:
从 git 获取的、待审查的代码变更集。
_Avoid_: Changeset, patch

**差异模式 (Diff Mode)**:
决定从 git 取哪部分变更：workspace（未提交的变更，含未跟踪文件）、commit（单个提交）或 range（两个 ref 之间）。

**发现 (Finding)**:
一条锚定到代码位置的审查观察，带有严重程度、分类、描述和可选的修复建议。
_Avoid_: Comment, issue, warning, violation

**严重程度 (Severity)**:
发现的影响级别：high、medium 或 low。

**分类 (Category)**:
发现的缺陷类别：bug、security、performance、maintainability、style 或 other。

### 文件处理 (File Processing)

**文件过滤器 (File Filter)**:
由四道门组成的流水线，决定差异中哪些文件进入审查。
_Avoid_: File selector, file picker

**门 (Gate)**:
文件过滤器的一个阶段，对每个文件给出放行或排除：二进制、敏感路径、用户排除、扩展名白名单。

**前置过滤 (Pre-filter)**:
在四道门之前排除已删除文件的步骤；已删除文件没有可锚定的代码，不计入门。

**规则 (Rule)**:
按语言或文件类型定制的审查清单，通过 glob 模式匹配文件并注入审查提示词。项目规则优先于内置规则，都未命中时使用默认规则。
_Avoid_: Policy, guideline, check

### 分组 (Grouping)

**语义分组 (Semantic Group)**:
分配给同一个审查 Agent 一起审查的一组相关文件（如 handler + service + test）。
_Avoid_: Batch, chunk, partition

**分组提示词 (Grouping Prompt)**:
仅依据文件元数据（路径、状态、增删行数）把文件聚类为语义分组的 LLM 调用。

### Agent

**审查 Agent (Review Agent)**:
负责审查一个语义分组的 LLM 工具调用循环。
_Avoid_: Reviewer, bot

**工具 (Tool)**:
审查 Agent 在循环中可调用的结构化函数：code_comment、file_read、file_read_diff、code_search、task_done。

**审查提示词 (Review Prompt)**:
驱动审查 Agent 的消息，包含本组差异、组外变更文件、匹配的规则和可选的业务上下文。

**业务上下文 (Background)**:
用户对改动目的与有意取舍的简短说明，帮助审查 Agent 减少误报。

### 锚定 (Anchoring)

**锚定 (Anchor)**:
把发现引用的代码片段映射到被审查文件中精确行号的确定性过程，不采信 LLM 给出的行号。

**未锚定发现 (Unanchored Finding)**:
锚定失败、无法定位到行的发现；它被保留，而不是丢弃。

### 集成 (Integration)

**进度 (Progress)**:
审查过程中写到 stderr 的状态提示，与写到 stdout 的审查结果分离。
_Avoid_: Audience

**Skill**:
指导其他 AI Agent 调用 diff-sense 并把结果整理为按严重程度分组的审查摘要的说明文件。
_Avoid_: Plugin, extension, integration

**Action**:
在 PR 上运行 diff-sense 的 GitHub Composite Action，把发现发布为行内评论，无法落在 diff 行内的汇入摘要评论。
_Avoid_: Workflow, pipeline

**摘要评论 (Summary Comment)**:
Action 发布的一条 PR 普通评论，汇总所有无法作为行内评论发布的发现。

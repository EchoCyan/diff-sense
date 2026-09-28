# 架构

diff-sense 把一次代码审查拆成两层（见 [ADR-0001](adr/0001-deterministic-agent-hybrid.md)）：

- **确定性层**：diff 解析、文件过滤、规则匹配、行号锚定、输出格式化。都是行为可预测的代码，有单元测试覆盖。
- **Agent 层**：真正「找问题」的部分交给 LLM，由 AI SDK v7 的 `ToolLoopAgent` 驱动工具调用循环。

能用规则决定的一律不交给 LLM：哪些文件送审、发现落在哪一行、输出长什么样，都由确定性代码保证；LLM 只负责判断代码有没有缺陷。

术语的准确含义见仓库根目录的 [CONTEXT.md](../CONTEXT.md)。

## 审查流水线

```
diff-sense review
 │
 ├─ 1. 定位仓库根目录      getRepoRoot()        src/diff.ts
 ├─ 2. 获取 diff           getDiff()            src/diff.ts
 ├─ 3. 文件过滤            filterFiles()        src/filter.ts
 ├─ 4. 加载规则            loadRules()          src/rules/matcher.ts
 ├─ 5. 语义分组            groupFiles()         src/grouping.ts        ← LLM 调用（文件数 ≥ 4 时）
 ├─ 6. 并发审查各组        runReviewAgent()     src/agent/loop.ts      ← LLM 工具调用循环
 │     └─ 每条发现即时锚定  anchor()             src/anchor.ts
 └─ 7. 格式化输出          formatText / formatJson / formatGithub   src/output/
```

编排入口是 `review()`（`src/review.ts`），它也是端到端测试的接缝：测试传入 mock 模型，即可在真实 git 仓库上跑完整条流水线。CLI（`src/commands/review.ts`）只负责解析参数、解析模型、显示进度和选择格式化器。

### 1. 定位仓库根目录

无论在仓库的哪个子目录运行，后续所有步骤都以 `git rev-parse --show-toplevel` 得到的根目录为工作目录，因此 diff 路径、项目配置和文件读取的结果与运行位置无关。不在 git 仓库中时给出明确提示。

### 2. 获取 diff

三种差异模式（`src/diff.ts`）：

| 模式 | 触发方式 | git 命令 |
| --- | --- | --- |
| workspace | 默认 | `git diff HEAD`，另为未跟踪文件（遵循 `.gitignore`）生成新增文件 diff；尚无提交时对比空树 |
| commit | `--commit <sha>` | `git diff <sha>~1 <sha>`；初始提交回退为 `git show` |
| range | `--from <a> --to <b>` | `git diff <a> <b>`（两点 diff） |

所有模式都使用 `--unified=3`，输出解析为 `DiffEntry[]`：路径（变更后一侧）、状态（added / modified / deleted / renamed）、完整 diff 文本、增删行数。git 输出缓冲上限为 10 MB。

### 3. 文件过滤

先做前置过滤，再依次经过四道门，任何一道门拒绝，文件就不会送审：

1. **前置过滤**：已删除文件。没有变更后的代码，发现无法锚定到行。
2. **二进制**：diff 中出现 `Binary files` 标记。
3. **敏感路径**：`.env*`、证书与私钥（`.pem`、`.key`、`id_rsa` 等）、`credentials.json`、`secret(s).json/yaml/toml` 等，避免把密钥发给 LLM。
4. **用户排除**：`--exclude` 与项目配置中的 `exclude` 合并。
5. **扩展名白名单**：放行源代码与配置文件，排除文档、lockfile 和 `*.min.js` 之类的生成产物。

详细规则见 [配置文档](configuration.md#文件过滤)。

### 4. 加载规则

规则是按文件类型定制的审查清单，会注入审查提示词的「Review Checklist」区域。生效列表为「项目规则 + 内置规则」，按顺序先匹配者优先，都未命中时使用默认规则。一个分组内的文件命中不同规则时，每条规则会用 `<rules for="路径, ...">` 标注适用的文件。

### 5. 语义分组

文件多时，把相关文件（如 handler、service 和它们的测试）分给同一个 Agent 一起审查，比逐个审查更容易发现跨文件的问题（`src/grouping.ts`）：

- 文件数少于 **4** 时不调用 LLM，全部文件归为一组。
- 否则调用分组提示词。输入**只有文件元数据**（`[索引] 状态 路径 (+增/-删)`），不含 diff 内容；输出 JSON 数组 `[{label, files}]`，`files` 为文件索引。
- 解析时逐组、逐索引校验：结构不符的组，以及非整数、重复、越界的索引只丢弃自身；模型遗漏的文件各自成组；超过 **10** 个文件的组按上限拆分。
- 找不到合法的分组数组，或分组调用本身失败时，退化为每个文件单独成组，不中断审查。

### 6. 并发审查

每个分组由一个审查 Agent（`ToolLoopAgent`）审查，各组之间用 `p-limit` 控制并发，并发数由 `--concurrency` 设定（默认 4）。

**审查提示词**（`src/agent/prompts.ts`）：

- 系统消息：审查者角色、工具用法和约束（只评论本组文件、不评论已删除或未变更的代码、每条发现必须附带 diff 中的代码片段）。
- 用户消息由三个 XML 块组成：
  - `<other_changed_files>`：本次变更中其他组的文件，只列元数据，作为上下文。只有一组时省略。
  - `<review_files>`：本组每个文件的 diff，包在 `<file path="...">` 中。
  - `<user_task>`：业务上下文（`--background`，可选）与 Review Checklist。

**五个工具**（`src/agent/tools.ts`）：

| 工具 | 作用 | 限制 |
| --- | --- | --- |
| `code_comment` | 发布一条发现，立即锚定行号 | 严重程度与分类为固定枚举 |
| `file_read` | 读取仓库内文件 | 拒绝仓库外路径（含符号链接），超过 50,000 字符截断 |
| `file_read_diff` | 按路径查看本次变更中文件的 diff，包括其他组的文件；用于在分组之外核对跨文件改动 | 只返回本次送审的文件，已过滤的文件查不到 |
| `code_search` | 用 `git grep` 搜索代码 | 最多返回 50 行 |
| `task_done` | 完成信号 | 无实现，调用即结束循环 |

`file_read`、`code_search` 与锚定读取同一版本的代码：workspace 模式读工作区（搜索包含未跟踪文件，遵守 `.gitignore`），commit 模式读该提交，range 模式读 `to` 端的提交。因此审查历史提交或在 CI 中审查 PR 时，Agent 看到的就是被审查的代码，而不是当前检出的版本。

循环在 Agent 调用 `task_done` 或达到 **30 步**时停止；此前通过 `code_comment` 发布的发现都会保留。

任一分组的 Agent 抛错时，整次审查失败（`Promise.all` 语义）。

### 锚定

LLM 给出的行号不可靠，所以 `code_comment` 只要求模型提供 diff 中的原始代码片段（`existing_code`），行号由确定性代码计算（`src/anchor.ts`）：

1. **hunk 新侧匹配**：在各 hunk 的上下文行与新增行中滑动窗口查找片段。
2. **全文件扫描**：未命中时，扫描变更后的完整文件（workspace 读工作区文件，commit / range 读对应版本）。
3. **回退**：仍未命中则 `line = 0`，即「未锚定发现」。它不会被丢弃，只是标为无法定位。

匹配时忽略全部空白。模型常照抄 diff 格式（行首带 `+` 或空格），此时额外尝试去掉行首标记后的形式。只在送审文件中查找；模型给的路径不在其中时，按片段命中的文件推断路径。

### 7. 输出

| 格式 | 用途 | 内容 |
| --- | --- | --- |
| `text` | 终端阅读 | 按文件分组的彩色输出，末尾汇总条数、token 与耗时 |
| `json` | 机器消费（Skill 等） | 发现数组，字段与顺序固定，无修复建议时 `suggestionCode` 为 `null` |
| `github` | GitHub Action | `{ review, summary, fallback }`，见 [集成文档](integrations.md#评论如何生成) |

审查结果只写 stdout，进度（spinner：已完成 k/n 组，共 N 步）只写 stderr，所以 `--format json | jq ...` 之类的管道可以直接使用。

## 模块地图

```
src/
├── index.ts              CLI 入口，注册子命令
├── commands/
│   ├── review.ts         review 子命令：参数校验、进度、选择格式化器
│   ├── config.ts         config 子命令：交互式向导、set / get / check
│   └── version.ts        版本号（构建时内联 package.json）
├── review.ts             审查编排 review()（测试接缝）
├── diff.ts               git diff 获取与解析、hunk 新侧提取
├── filter.ts             前置过滤 + 四道门
├── glob.ts               glob → 正则（过滤与规则共用）
├── project-config.ts     .diff-sense/rules.json 读取与校验
├── json-config.ts        JSON 配置文件读取 + zod 校验（项目配置与用户配置共用）
├── config.ts             用户配置、环境变量合并、提供商注册表
├── grouping.ts           语义分组与分组结果解析
├── anchor.ts             行号锚定
├── xml.ts                提示词 XML 属性转义
├── types.ts              核心类型
├── rules/
│   ├── builtin.ts        内置规则
│   └── matcher.ts        规则加载与匹配
├── agent/
│   ├── loop.ts           审查 Agent（ToolLoopAgent）
│   ├── tools.ts          五个工具
│   └── prompts.ts        分组提示词与审查提示词
└── output/
    ├── text.ts / json.ts / github.ts   三种格式化器
    └── location.ts       行号范围格式化（共用）
```

## 核心类型

定义在 `src/types.ts`：

- `DiffEntry`：一个文件的 diff 元数据与内容
- `Location`：代码位置（`path` + `line` / `endLine`，`line = 0` 表示未锚定）
- `Finding`：一条审查发现（继承 `Location`，另有 `severity`、`category`、`content`、`existingCode`、`suggestionCode`）
- `FileGroup`：一个语义分组（`label` + 组内 `DiffEntry`）
- `Rule`：一条审查规则（glob `pattern` + 规则文本 `rule`）
- `ReviewResult`：审查结果（`findings`、送审的 `entries`、`totalTokens`、`durationMs`）

`totalTokens` 包含分组调用与各组审查的消耗；`durationMs` 从加载规则开始计时，覆盖分组与全部审查。

## 已知限制

- 任一分组审查失败，整次审查失败，其他组的结果不会输出。
- 单组 diff 过大时不会按 token 预算拆分，可能超出模型上下文窗口。
- 单次 git 输出上限 10 MB，超大变更需要调整 `GIT_MAX_BUFFER`。
- 已删除文件不送审。

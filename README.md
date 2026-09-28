<div align="center">
  <h1>diff-sense</h1>
  <p>确定性工程 × Agent 混合驱动的轻量级 AI 代码审查工具</p>
</div>

<p align="center">
  <a href="https://www.npmjs.com/package/@echocyan/diff-sense"><img alt="npm" src="https://img.shields.io/npm/v/@echocyan/diff-sense?style=flat-square" /></a>
  <a href="https://www.npmjs.com/package/@echocyan/diff-sense"><img alt="Node.js" src="https://img.shields.io/node/v/@echocyan/diff-sense?style=flat-square" /></a>
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/github/license/echocyan/diff-sense?style=flat-square" /></a>
</p>
<p align="center">
  <a href="#cli"><img alt="CLI" src="https://img.shields.io/badge/CLI-supported-blue.svg" /></a>
  <a href="#github-action"><img alt="GitHub Action" src="https://img.shields.io/badge/GitHub_Action-supported-blue.svg" /></a>
  <a href="#agent-skill"><img alt="Claude Code" src="https://img.shields.io/badge/Claude_Code-supported-blueviolet.svg" /></a>
  <a href="#llm-提供商"><img alt="Anthropic" src="https://img.shields.io/badge/Anthropic-supported-orange.svg" /></a>
  <a href="#llm-提供商"><img alt="DeepSeek" src="https://img.shields.io/badge/DeepSeek-supported-orange.svg" /></a>
  <a href="#llm-提供商"><img alt="OpenAI" src="https://img.shields.io/badge/OpenAI-supported-orange.svg" /></a>
</p>

---

## diff-sense 是什么？

diff-sense 是一款 AI 驱动的代码审查 CLI 工具。它读取 git diff，把变更文件按语义分组交给审查 Agent 并发审查，输出**精确到行**的审查发现。

支持三种接入方式：**CLI**、供 AI 编程助手调用的 **Agent Skill**、在 PR 上发布评论的 **GitHub Action**。

## 为什么选择 diff-sense？

直接把 diff 交给大模型审查，常见的问题有：

- **位置漂移**：报告的行号与实际代码对不上
- **噪声泛滥**：lockfile、生成代码也被送审，浪费 token
- **大变更失焦**：文件一多就漏审，逐个审又看不到跨文件问题
- **泄露风险**：`.env`、私钥可能被发给第三方模型

diff-sense 的原则是：**能用确定性代码解决的，一律不交给 LLM**。

### 确定性层：负责强约束

- **文件过滤**：排除二进制、敏感文件、lockfile 与非代码文件
- **行号锚定**：模型只引用代码片段，行号由算法计算
- **规则匹配**：按文件类型注入审查清单，支持项目自定义

### Agent 层：负责动态决策

- **语义分组**：依据文件元数据与文件之间的引用关系，把相关文件归为一组，各组并发审查、上下文隔离
- **五个工具**：
  - `file_read`：读取文件
  - `file_read_diff`：查看其他变更文件的 diff
  - `code_search`：搜索代码
  - `code_comment`：发布发现
  - `task_done`：结束审查

### GitHub Action

- **与 PR diff 一致**：以 merge-base 为起点
- **不丢发现**：无法行内评论的发现汇入摘要评论，Review 被拒绝时降级为普通评论

## 架构

```
diff-sense review
 │
 │  ────────────────── 确定性层 ─────────────────────────
 ├─ 获取 diff            workspace / commit / range
 ├─ 文件过滤              前置过滤 + 四道门
 ├─ 规则匹配              项目规则 → 内置规则 → 默认规则
 │
 │  ────────────────── Agent 层 ─────────────────────────
 ├─ 语义分组              一次 LLM 调用，传文件元数据与引用关系
 ├─ 并发审查              每组一个 ToolLoopAgent，发现即时锚定
 │
 │  ────────────────── 确定性层 ─────────────────────────
 └─ 格式化输出            text / json / github
```

技术栈：TypeScript、[AI SDK](https://ai-sdk.dev)、Commander.js、zod、tsup。

## 如何使用

### 前置条件

- **Node.js >= 22.12**
- **Git**：diff 生成与代码搜索都依赖 git。

### CLI

#### 安装

```bash
npm install -g @echocyan/diff-sense
```

#### 快速开始

**1. 配置 LLM**

```bash
diff-sense config          # 交互式向导：选择提供商，填写模型与 API Key
diff-sense config check    # 检查生效配置是否完整
```

也可以只用环境变量，环境变量优先于配置文件：

```bash
export DIFF_SENSE_PROVIDER=anthropic
export DIFF_SENSE_MODEL=claude-sonnet-5
export DIFF_SENSE_API_KEY=sk-...  # 可选；未设置时依次使用配置文件中的 apiKey、提供商自身的环境变量（如 ANTHROPIC_API_KEY）
```

**2. 开始审查**

```bash
cd your-project

# 工作区模式：审查所有已暂存、未暂存和未跟踪的变更
diff-sense review

# 单个提交
diff-sense review --commit abc123

# 两个 ref 之间的变更
diff-sense review --from main --to feature-branch

# 提供业务上下文，减少误报
diff-sense review --background "为登录接口增加限流，暂不处理分布式场景"

# JSON 输出，可以直接接管道
diff-sense review --format json | jq '.[] | select(.severity == "high")'
```

**3. 定制项目规则（可选）**

在仓库根目录创建 `.diff-sense/rules.json`：

```json
{
  "exclude": ["docs/**", "**/*.generated.ts"],
  "rules": [{ "pattern": "src/api/**", "rule": "所有接口必须校验入参，并返回统一的错误结构" }]
}
```

#### LLM 提供商

| 提供商    | `provider`  | 提供商环境变量      |
| --------- | ----------- | ------------------- |
| Anthropic | `anthropic` | `ANTHROPIC_API_KEY` |
| DeepSeek  | `deepseek`  | `DEEPSEEK_API_KEY`  |
| OpenAI    | `openai`    | `OPENAI_API_KEY`    |

### GitHub Action

在 PR 上自动审查。能定位到 diff 行的发现发布为行内评论，其余发现汇总为一条摘要评论。

```yaml
on: pull_request

permissions:
  contents: read
  pull-requests: write

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0 # 计算 merge-base 需要完整历史
      - uses: echocyan/diff-sense@v0.1.1
        with:
          provider: anthropic
          model: claude-sonnet-5
          api_key: ${{ secrets.ANTHROPIC_API_KEY }}
          background: ${{ github.event.pull_request.title }}
```

### Agent Skill

让 Claude Code 等 AI 编程助手调用 diff-sense，并把结果整理成按严重程度分组的 Markdown 审查摘要：

```bash
npx skills add echocyan/diff-sense
```

安装后，对 Agent 说「帮我审查一下这些改动」即可。

## 文档

- [架构](docs/architecture.md)：审查流水线、语义分组、锚定算法与模块划分
- [配置](docs/configuration.md)：LLM 配置合并规则、项目规则、内置规则、文件过滤与全部命令行参数
- [集成](docs/integrations.md)：GitHub Action 的执行流程与评论生成，Skill 的执行步骤
- [开发与发布](docs/development.md)：开发约定、测试规范与 npm 发布流程

## 许可证

[MIT](LICENSE)

# AGENTS.md

## 命令

```bash
pnpm build          # tsup 构建 → dist/index.js（带 shebang）
pnpm dev            # tsup --watch
pnpm test           # vitest run（全量）
pnpm test:watch     # vitest（watch 模式）
pnpm typecheck      # tsc --noEmit
pnpm lint           # oxlint src
pnpm fmt            # oxfmt src
pnpm fmt:check      # oxfmt --check src

# 运行单个测试文件
pnpm vitest run src/diff.test.ts

# 使用 CLI（需先 build）
DIFF_SENSE_PROVIDER=deepseek DIFF_SENSE_MODEL=deepseek-flash pnpm build && node dist/index.js review
```

## 架构

确定性层 × Agent 混合架构（见 `docs/adr/0001-deterministic-agent-hybrid.md`）：确定性层处理 diff 解析、文件过滤、规则匹配、行号锚定、输出格式化；Agent 层通过 AI SDK v7 的 `ToolLoopAgent` 实现 LLM 工具调用循环。

### 数据流

```
CLI (src/index.ts → src/commands/review.ts)
 → review() 编排 (src/review.ts)        ← 测试接缝
   → getRepoRoot() (src/diff.ts)         ← 仓库根目录，后续步骤均以此为 cwd（子目录运行亦然）
   → getDiff() (src/diff.ts)             ← git diff 解析（workspace / commit / range）
   → filterFiles() (src/filter.ts)       ← 文件过滤（前置过滤 + 四道门）
   → loadRules() (src/rules/matcher.ts)  ← 项目规则 + 内置规则（src/rules/builtin.ts）
   → groupFiles() (src/grouping.ts)     ← 语义分组（文件数 ≥4 时调用分组提示词，失败退化为单文件组）
   → runReviewAgent() (src/agent/loop.ts) ← 每组一个 ToolLoopAgent，p-limit 控制并发（--concurrency）
     ├── resolveGroupRules()  组内文件 → Review Checklist
     ├── anchor()     行号锚定 (src/anchor.ts)，作为 locate 注入 code_comment；
     │                全文件扫描经 readNewFile() (src/diff.ts) 读取
     ├── prompts.ts   分组提示词 + 审查提示词（组外文件列入 <other_changed_files>）
     └── tools.ts     code_comment / file_read / file_read_diff / code_search / task_done；
                      file_read 与 code_search 按差异模式读取与锚定相同的版本（newSideRev）
 → formatText() / formatJson() / formatGithub() (src/output/) ← --format text|json|github；进度（spinner）始终显示，写 stderr
```

### 核心类型 (`src/types.ts`)

- `DiffEntry` — 一个文件的 diff 元数据
- `Location` — 代码位置（path + line/endLine，line=0 表示未锚定）
- `Finding` — 一条锚定到代码位置的审查发现（继承 `Location`）
- `ReviewResult` — 审查结果（findings + 送审 diff 条目 + token 用量 + 耗时；token 含分组调用）
- `FileGroup` — 一个语义分组（label + 组内 diff 条目）
- `Rule` — 一条审查规则（glob 模式 + 注入 Review Checklist 的规则文本）

### 共享模块

- `src/glob.ts` — glob 转正则（`*`、`**`、`{a,b}`），文件过滤与规则匹配共用
- `src/project-config.ts` — 读取并校验 `.diff-sense/rules.json`（`exclude` + `rules`）
- `src/json-config.ts` — JSON 配置文件的读取与 zod 校验（项目配置与用户配置 `~/.diff-sense/config.json` 共用）
- `src/xml.ts` — 提示词 XML 属性值转义（`<file path>`、`<rules for>` 共用）

### AI SDK 用法

- 使用 AI SDK v7（`ai@7.x`），**不要**凭记忆写 API — 先查 `node_modules/ai/docs/`
- `LanguageModel`（非 `LanguageModelV1`）、`ToolSet`、`ToolLoopAgent`
- `createProviderRegistry({ anthropic: createAnthropic({ apiKey }), ... })` 多提供商注册；`provider` / `model` / `apiKey` 由 `resolveSettings()`（`src/config.ts`）合并环境变量与 `~/.diff-sense/config.json` 得出，`apiKey` 缺省时回退到各提供商自身的环境变量
- `result.usage.totalTokens` 类型为 `number | undefined`，需要 `?? 0`

## 约定

- **简洁优先**：遵守 KISS/YAGNI/fail-fast，避免无必要抽象
- **语言**：代码中的注释和用户面文案使用简体中文，标识符和类型名使用英文
- **注释**：编写中文注释，遵循 TSDoc 规范
- **提交信息**：Conventional Commits 格式，描述和正文使用简体中文，类型和作用域保留英文
- **提交范围**：每次提交只包含一个逻辑变更
- **构建**：TypeScript ESM（`"moduleResolution": "Bundler"`），tsup 单入口打包，target 取自 `package.json` 的 `engines`（最低 Node 版本由运行时依赖的要求决定，只在 `engines` 中维护）
- **格式化 / 代码检查**：oxfmt + oxlint
- **文档同步**：文档需与想法、决策和代码保持同步，只写当前状态：修改时就地改写成最新结论，不留旧值、改动来由或确认过程；内容遵循所在文档的体裁和要求，简洁明了

## 测试

- Do not backfill tests after implementing business code.
- Tautological tests considered harmful.
- Change-detector tests considered harmful.
- Do not create regression tests for bug fixes without a genuine gap in behavior testing.

## Agent skills

### Issue tracker

Issues and specs live as markdown files under `.scratch/`. See `docs/agents/issue-tracker.md`.

### Domain docs

Single-context: `CONTEXT.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.

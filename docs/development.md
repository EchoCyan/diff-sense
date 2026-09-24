# 开发与发布

## 环境

- Node.js：不低于 `package.json` 中 `engines.node` 声明的版本（目前为 22.12）。
- pnpm：版本见 `package.json` 的 `packageManager`。仓库通过 `devEngines` 限定只能用 pnpm，`npm pack`、`npm publish` 等命令会被拒绝。

```bash
pnpm install
pnpm build          # tsup 构建 → dist/index.js（带 shebang，可执行）
pnpm dev            # 监听模式构建
pnpm test           # 全量测试
pnpm test:watch     # 监听模式测试
pnpm vitest run src/diff.test.ts   # 单个测试文件
pnpm typecheck      # tsc --noEmit
pnpm lint           # oxlint
pnpm fmt            # oxfmt 格式化
pnpm fmt:check      # 格式检查
```

本地运行 CLI：

```bash
pnpm build
DIFF_SENSE_PROVIDER=deepseek DIFF_SENSE_MODEL=deepseek-flash node dist/index.js review
```

## 仓库结构

```
src/            源码与同目录下的 *.test.ts（结构见 docs/architecture.md）
skills/         Skill 源文件（经 skills.sh 分发）
action.yml      GitHub Action
docs/
├── adr/        架构决策记录
├── research/   设计阶段的调研（open-code-review、AI SDK Agent 循环等）
└── agents/     供 AI 编码助手读取的工作约定（工单、领域文档）
.scratch/       规格与工单（Markdown），见 docs/agents/issue-tracker.md
CONTEXT.md      领域术语表
AGENTS.md       AI 编码助手的项目说明
```

`.agents/`、`.claude/` 下是开发本项目时安装的第三方 skill，与发布的 diff-sense Skill 无关。

## 约定

完整约定见 [AGENTS.md](../AGENTS.md)，要点如下：

- **语言**：注释和用户面文案（CLI 输出、报错、文档）使用简体中文；标识符和类型名使用英文。给 LLM 的提示词保持英文。
- **注释**：中文，遵循 TSDoc。
- **提交**：Conventional Commits，类型和作用域用英文，描述和正文用简体中文。每个提交只包含一个逻辑变更。
- **术语**：以 [CONTEXT.md](../CONTEXT.md) 为准，注意其中列出的避免使用的词。比如审查结果统一称为「发现」，不称为 comment 或 issue；分组也不叫 chunk。
- **文档同步**：改动行为时，同步更新 CONTEXT.md、AGENTS.md、spec 和对应工单。

### AI SDK

项目使用 AI SDK v7（`ai@7.x`），它的 API 与旧版本差别很大，例如 `generateText` 的系统提示词参数叫 `instructions`。写代码前请先查 `node_modules/ai/docs/`，不要凭记忆。

### 测试

- 测试与源文件放在同一目录，命名为 `*.test.ts`。
- 先写测试再实现；不要在业务代码写完后补测试。
- 避免同义反复的测试，也避免只检测实现细节、一重构就失败的测试。
- 修 bug 时，只有当现有测试确实缺少对该行为的覆盖，才补回归测试。
- 需要 LLM 的测试使用 `ai/test` 的 `MockLanguageModelV4`；`review()` 的测试在临时 git 仓库上运行完整流水线。

## 构建

- tsup 把 `src/index.ts` 打包为单个 ESM 文件 `dist/index.js`，并加上 `#!/usr/bin/env node`。
- 构建目标由 `engines.node` 推导（`tsup.config.ts`），最低 Node 版本只在 `engines` 中维护。它取决于运行时依赖的要求：`commander@15` 需要 22.12+，`ai` 与 `@ai-sdk/*` 需要 22+。
- `dependencies` 不打包，由 npm 在安装时下载。
- `@types/node` 固定在最低支持版本（`^22`），让 typecheck 拒绝更新版本才有的 API。

## 发布

npm 包名为 `@echocyan/diff-sense`，安装后的命令为 `diff-sense`。不带作用域的 `diff-sense` 与 npm 上已有的 `diffsense` 过于相似，被 npm 拒绝发布。

tarball 只包含 `dist/index.js`、`package.json`、`README.md` 和 `LICENSE`。`exports` 只暴露 `package.json`：diff-sense 是纯 CLI，没有可以 import 的 API。

### 发布一个版本

顺序是**先发 npm，再打标签**。Action 在某个标签下运行时，会去 npm 上找与 `package.json` 相同的版本。

```bash
# 1. 修改 package.json 中的 version，提交并推送
git commit -am "chore(release): v0.1.1" && git push

# 2. 发布到 npm（会先运行 typecheck、lint、格式检查、测试与构建）
pnpm publish

# 3. 打标签并创建 GitHub Release
git tag -a v0.1.1 -m "v0.1.1" && git push origin v0.1.1
gh release create v0.1.1 --generate-notes
```

发布前的检查由 `package.json` 中的脚本保证：

- `prepublishOnly`：typecheck、lint、格式检查和测试，任一失败即中止发布。
- `prepack`：构建，保证 tarball 里的 `dist/` 是最新的。

### 常见问题

| 报错 | 处理 |
| --- | --- |
| `EBADDEVENGINES` | 用了 npm，改用 pnpm |
| `EOTP` | npm 账号开启了两步验证，加 `--otp <一次性密码>` |
| `E402` / 要求付费 | 作用域包按私有发布了，确认 `publishConfig.access` 为 `public` |
| `cannot publish over the previously published versions` | 版本号已发布过（删除后也不能重用），需要升级版本号 |
| `ERR_PNPM_GIT_UNCLEAN` | 先提交或清理工作区，并与远程同步 |

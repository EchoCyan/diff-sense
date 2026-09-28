import type { LanguageModel } from "ai";
import pLimit from "p-limit";
import type { ReviewResult } from "./types";
import { getDiff, getRepoRoot, type DiffMode } from "./diff";
import { filterFiles, type FilterOptions } from "./filter";
import { groupFiles } from "./grouping";
import { runReviewAgent } from "./agent/loop";
import { loadRules } from "./rules/matcher";

/** 默认并发审查的分组数 */
export const DEFAULT_CONCURRENCY = 4;

/** 审查进度 */
export interface ReviewProgress {
  /** 已完成审查的分组数 */
  groupsDone: number;
  /** 分组总数 */
  groupsTotal: number;
  /** 所有分组累计完成的 Agent 步数 */
  steps: number;
}

/** 审查编排选项 */
export interface ReviewOptions {
  /** LLM 模型实例 */
  model: LanguageModel;
  /** 运行目录，可为仓库内任意子目录 */
  cwd: string;
  /** diff 获取模式，默认 workspace */
  diffMode?: DiffMode;
  /** 业务上下文，传入 Agent 的用户提示词 */
  background?: string;
  /** 用户排除模式（CLI --exclude） */
  excludePatterns?: string[];
  /** 同时审查的分组数上限（正整数），默认 {@link DEFAULT_CONCURRENCY} */
  concurrency?: number;
  /** 分组完成、每个 Agent 步骤结束、每组审查完成时的回调（用于更新 spinner） */
  onProgress?: (progress: ReviewProgress) => void;
}

/** 核心审查编排（测试接缝） */
export async function review(options: ReviewOptions): Promise<ReviewResult> {
  const { model, background, excludePatterns, onProgress } = options;
  const diffMode = options.diffMode ?? { type: "workspace" };
  // 在任何 LLM 调用前构造，非法并发数（非正整数）立即报错
  const limit = pLimit(options.concurrency ?? DEFAULT_CONCURRENCY);
  // diff 路径、项目配置、文件读取均以仓库根目录为准，子目录中运行时行为一致
  const cwd = await getRepoRoot(options.cwd);

  const rawEntries = await getDiff(diffMode, cwd);
  if (rawEntries.length === 0) {
    return { findings: [], entries: [], totalTokens: 0, durationMs: 0 };
  }

  const filterOpts: FilterOptions = { excludePatterns, cwd };
  const entries = await filterFiles(rawEntries, filterOpts);
  if (entries.length === 0) {
    return { findings: [], entries, totalTokens: 0, durationMs: 0 };
  }

  const start = Date.now();
  const rules = await loadRules(cwd);
  const grouping = await groupFiles(entries, model);

  const progress: ReviewProgress = { groupsDone: 0, groupsTotal: grouping.groups.length, steps: 0 };
  const reportProgress = () => onProgress?.({ ...progress });
  reportProgress();

  const results = await Promise.all(
    grouping.groups.map((group) =>
      limit(async () => {
        const result = await runReviewAgent({
          model,
          entries: group.entries,
          others: entries.filter((e) => !group.entries.includes(e)),
          cwd,
          rules,
          diffMode,
          background,
          onStepEnd: () => {
            progress.steps++;
            reportProgress();
          },
        });
        progress.groupsDone++;
        reportProgress();
        return result;
      }),
    ),
  );

  return {
    findings: results.flatMap((r) => r.findings),
    entries,
    totalTokens: results.reduce((sum, r) => sum + r.totalTokens, grouping.totalTokens),
    durationMs: Date.now() - start,
  };
}

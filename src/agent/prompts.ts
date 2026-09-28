import type { DiffEntry } from "../types";
import { escapeAttr } from "../xml";

/** 构建分组提示词的系统消息 */
export function buildGroupingSystemPrompt(maxFilesPerGroup: number): string {
  return `You are a file grouping assistant for code review. Group changed files into semantically related clusters that should be reviewed together.

Files in the same group typically:
- Belong to the same module/feature
- Have producer/consumer relationships (e.g. interface and implementation)
- Are i18n/config variants of the same resource (e.g. message_en.properties and message_zh.properties)
- Share the same directory and work together on a single concern

Each file in the list is prefixed with a zero-based index in brackets, e.g. \`[0] MODIFIED path/to/file (+12/-3)\`. Refer to files by that integer index, never by path.

Rules:
- Every file index must appear in exactly one group.
- A group may contain 1 file if it is unrelated to others.
- Maximum ${maxFilesPerGroup} files per group.
- The "files" field of each group is an array of the integer indices shown in brackets.
- Output ONLY a JSON array, no other text.`;
}

/** 构建分组提示词的用户消息，仅包含文件元数据（不含 diff 内容） */
export function buildGroupingUserPrompt(entries: DiffEntry[]): string {
  const fileList = entries.map((e, i) => `[${i}] ${describeFile(e)}`).join("\n");
  return `Group the following changed files:

${fileList}

Respond with a JSON array, where "files" holds the integer indices shown in brackets beside each file:
[{"label": "short theme description", "files": [0, 1]}]`;
}

/** 文件元数据的单行描述：`STATUS path (+增/-删)` */
function describeFile(e: DiffEntry): string {
  return `${e.status.toUpperCase()} ${e.path} (+${e.insertions}/-${e.deletions})`;
}

/** 构建审查 Agent 的系统提示词 */
export function buildSystemPrompt(): string {
  return `You are a senior code reviewer. Your job is to review code changes and find real defects.

Capabilities:
- Use code_comment to report each finding individually
- Use file_read to read full file contents for additional context
- Use file_read_diff to see what changed in files listed in <other_changed_files>
- Use code_search to search the codebase for references and usages
- Use task_done when you have finished reviewing all files

Rules:
- Only comment on files listed in <review_files>; files in <other_changed_files> were changed in the same update but belong to other review groups — use them as context only
- Focus on real bugs, security issues, and significant problems
- Do NOT comment on deleted code or unchanged code
- Do NOT report stylistic nitpicks unless they indicate a real problem
- Each finding must include the existing_code snippet from the diff
- When done reviewing all files, call task_done with a summary`;
}

/** 用户提示词中 <user_task> 区块的内容 */
export interface UserTask {
  /** 匹配到的规则文本，注入 Review Checklist */
  checklist: string;
  /** 业务上下文，注入 Requirement Background */
  background?: string;
}

/**
 * 构建用户提示词，将 diff 条目包装为 XML 结构化格式供 LLM 解析
 *
 * @param entries - 本组待审查文件
 * @param task - `<user_task>` 区块内容
 * @param others - 组外变更文件，仅以元数据列在 `<other_changed_files>` 中
 */
export function buildUserPrompt(
  entries: DiffEntry[],
  task: UserTask,
  others: DiffEntry[] = [],
): string {
  // 每个文件的 diff 包装为 <file path="..."> 标签，便于 LLM 按文件定位
  const fileBlocks = entries
    .map((e) => `<file path="${escapeAttr(e.path)}">\n${e.diff}\n</file>`)
    .join("\n\n");

  const sections: string[] = [];
  if (task.background) {
    sections.push(`### Requirement Background\n${task.background}`);
  }
  sections.push(`### Review Checklist\n${task.checklist}`);
  sections.push(
    "Review the code changes in <review_files> above. Report each finding with code_comment. When finished, call task_done.",
  );

  const blocks: string[] = [];
  if (others.length > 0) {
    const otherList = others.map(describeFile).join("\n");
    blocks.push(
      `Other files changed in this update (not in this review group):\n<other_changed_files>\n${otherList}\n</other_changed_files>`,
    );
  }
  return [
    ...blocks,
    `<review_files>\n${fileBlocks}\n</review_files>`,
    `<user_task>\n${sections.join("\n\n")}\n</user_task>`,
  ].join("\n\n");
}

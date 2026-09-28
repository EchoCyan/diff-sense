import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { realpath } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { newSideRev, readNewFile, type DiffMode } from "../diff";
import type { DiffEntry, Finding, Location } from "../types";

const exec = promisify(execFile);

/** 将 existing_code 锚定到文件行号；path 缺省时由实现推断 */
export type Locate = (existingCode: string, path?: string) => Promise<Location>;

/**
 * 创建审查 Agent 的五个工具：code_comment / file_read / file_read_diff / code_search / task_done
 *
 * file_read 与 code_search 按差异模式读取变更后的代码：workspace 读工作区，
 * commit / range 读被审查的提交，与锚定所用的版本一致
 *
 * @param diffs - 本次送审的全部 diff 条目（含其他分组），供 file_read_diff 查询
 */
export function createTools(
  cwd: string,
  mode: DiffMode,
  findings: Finding[],
  locate: Locate,
  diffs: DiffEntry[],
): ToolSet {
  const rev = newSideRev(mode);
  return {
    code_comment: tool({
      description: "Report a code review finding",
      inputSchema: z.object({
        severity: z.enum(["high", "medium", "low"]),
        content: z.string().describe("Finding description"),
        existing_code: z.string().describe("Code snippet from the diff for anchoring"),
        suggestion_code: z.string().optional().describe("Suggested fix code"),
        category: z.enum(["bug", "security", "performance", "maintainability", "style", "other"]),
        path: z.string().optional().describe("File path; inferred from existing_code when omitted"),
      }),
      execute: async (input) => {
        const loc = await locate(input.existing_code, input.path);
        findings.push({
          ...loc,
          severity: input.severity,
          category: input.category,
          content: input.content,
          existingCode: input.existing_code,
          suggestionCode: input.suggestion_code,
        });
        const at = loc.line > 0 ? `${loc.path}:${loc.line}` : `${loc.path} (unanchored)`;
        return `Finding recorded at ${at}: [${input.severity}] ${input.content.slice(0, 80)}`;
      },
    }),

    file_read: tool({
      description: "Read a file from the repository",
      inputSchema: z.object({
        path: z.string().describe("File path relative to repository root"),
      }),
      execute: async ({ path: filePath }) => {
        try {
          const path = await repoPath(cwd, filePath, rev === undefined);
          if (path === undefined) return `Error: path is outside the repository: ${filePath}`;
          const content = await readNewFile(mode, path, cwd);
          if (content === undefined) return `Error: file not found or unreadable: ${filePath}`;
          // 截断过长文件，防止单文件占满 LLM 上下文窗口
          if (content.length > 50_000) {
            return content.slice(0, 50_000) + "\n... (truncated)";
          }
          return content;
        } catch {
          return `Error: file not found or unreadable: ${filePath}`;
        }
      },
    }),

    file_read_diff: tool({
      description:
        "Read the diffs of files changed in this update, including files in other review groups",
      inputSchema: z.object({
        paths: z.array(z.string()).describe("File paths relative to repository root"),
      }),
      execute: async ({ paths }) => {
        const found = paths.flatMap((path) => {
          const entry = diffs.find((e) => e.path === path);
          return entry ? [`==== FILE: ${path} ====\n${entry.diff}`] : [];
        });
        if (found.length === 0) {
          return "Error: none of these files were changed in this update";
        }
        return found.join("\n\n");
      },
    }),

    code_search: tool({
      description: "Search the codebase using git grep",
      inputSchema: z.object({
        query: z.string().describe("Search query"),
        file_pattern: z.string().optional().describe("File glob pattern"),
      }),
      execute: async ({ query, file_pattern }) => {
        try {
          // 用 -e 传入查询，防止以 - 开头的查询被解析为 git 选项（如 --open-files-in-pager）
          const args = ["grep", "-n", "--no-color", "-e", query];
          // 工作区差异包含未跟踪文件，搜索也需覆盖（--untracked 仍遵守 .gitignore）；提交中搜索则指定版本
          args.push(rev === undefined ? "--untracked" : rev);
          args.push("--");
          if (file_pattern) args.push(file_pattern);
          const { stdout: raw } = await exec("git", args, { cwd, maxBuffer: 1024 * 1024 });
          // 在提交中搜索时每行以 `<rev>:` 开头，去掉后与工作区搜索的格式一致
          const stdout =
            rev === undefined
              ? raw
              : raw.replaceAll(new RegExp(`^${escapeRegExp(rev)}:`, "gm"), "");
          const lines = stdout.split("\n").filter(Boolean);
          // 限制搜索结果行数，避免输出过长
          if (lines.length > 50) {
            return lines.slice(0, 50).join("\n") + `\n... (${lines.length} total matches)`;
          }
          return stdout || "No matches found.";
        } catch {
          return "No matches found.";
        }
      },
    }),

    // 信号工具：无 execute 实现，ToolLoopAgent 通过 hasToolCall("task_done") 检测到调用后终止循环
    task_done: tool({
      description: "Signal that the review is complete",
      inputSchema: z.object({
        summary: z.string().describe("Brief summary of the review"),
      }),
    }),
  };
}

/**
 * 把 Agent 给出的路径解析为相对仓库根目录的路径，位于仓库外时返回 undefined
 *
 * 读取工作区时先解析符号链接再校验，拒绝指向仓库外的链接；读取提交时文件不在磁盘上，按路径本身校验
 */
async function repoPath(
  cwd: string,
  filePath: string,
  followLinks: boolean,
): Promise<string | undefined> {
  const root = followLinks ? await realpath(cwd) : cwd;
  const full = followLinks ? await realpath(resolve(cwd, filePath)) : resolve(cwd, filePath);
  const rel = relative(root, full);
  if (rel.split(sep)[0] === ".." || isAbsolute(rel)) return undefined;
  return rel.split(sep).join("/");
}

/** 转义正则元字符 */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

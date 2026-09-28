import { generateText, type LanguageModel } from "ai";
import { z } from "zod";
import type { DiffEntry, FileGroup } from "./types";
import { buildGroupingSystemPrompt, buildGroupingUserPrompt } from "./agent/prompts";

/** 触发 LLM 分组的最少文件数；少于此数时全部文件归入一组 */
export const GROUPING_MIN_FILES = 4;

/** 每组文件数上限 */
export const MAX_FILES_PER_GROUP = 10;

/** 分组提示词输出中的一个分组：`{label, files}`，files 为文件索引；索引逐个校验，此处不限类型 */
const groupSchema = z.object({ label: z.string(), files: z.array(z.unknown()) });

/** 语义分组结果 */
export interface GroupingResult {
  /** 分组列表，每个文件恰好出现在一组中 */
  groups: FileGroup[];
  /** 分组调用的 token 消耗（未调用 LLM 时为 0） */
  totalTokens: number;
}

/**
 * 将文件聚类为语义分组
 *
 * 文件数少于 {@link GROUPING_MIN_FILES} 时不调用 LLM，全部归入一组；
 * 否则以文件元数据调用分组提示词，调用失败时退化为单文件组
 */
export async function groupFiles(
  entries: DiffEntry[],
  model: LanguageModel,
): Promise<GroupingResult> {
  if (entries.length < GROUPING_MIN_FILES) {
    return { groups: [{ label: "all", entries }], totalTokens: 0 };
  }

  try {
    const result = await generateText({
      model,
      instructions: buildGroupingSystemPrompt(MAX_FILES_PER_GROUP),
      prompt: buildGroupingUserPrompt(entries),
    });
    return {
      groups: parseGroups(result.text, entries),
      totalTokens: result.usage.totalTokens ?? 0,
    };
  } catch {
    // 分组只影响审查粒度，失败时不中断审查；模型本身不可用时后续审查会报错
    return { groups: singleFileGroups(entries), totalTokens: 0 };
  }
}

/**
 * 解析分组提示词的输出
 *
 * 容忍 JSON 前后的说明文字与代码围栏；丢弃结构不符的组以及非整数、重复与越界索引，
 * 未分配的文件各成一组，超过 {@link MAX_FILES_PER_GROUP} 的组按上限拆分。
 * 找不到分组数组时退化为单文件组
 */
export function parseGroups(text: string, entries: DiffEntry[]): FileGroup[] {
  const assigned = new Set<number>();
  const groups: FileGroup[] = [];
  for (const item of extractGroupArray(text)) {
    const parsed = groupSchema.safeParse(item);
    if (!parsed.success) continue;
    const { label, files } = parsed.data;
    // 逐个登记，同一组内的重复索引也只保留第一次
    const indices: number[] = [];
    for (const i of files) {
      if (typeof i !== "number" || !Number.isInteger(i)) continue;
      if (i < 0 || i >= entries.length || assigned.has(i)) continue;
      assigned.add(i);
      indices.push(i);
    }
    for (let start = 0; start < indices.length; start += MAX_FILES_PER_GROUP) {
      const members = indices.slice(start, start + MAX_FILES_PER_GROUP);
      groups.push({ label, entries: members.map((i) => entries[i]) });
    }
  }
  const unassigned = entries.filter((_, i) => !assigned.has(i));
  return [...groups, ...singleFileGroups(unassigned)];
}

/**
 * 从文本中找出分组数组：元素均为对象的非空 JSON 数组
 *
 * 依次尝试每个 `[` 起点，终点从最后一个 `]` 向前，取第一个符合条件的片段，
 * 从而跳过说明文字中的方括号（如「文件 [0] 与 [1]」）。找不到时返回空数组
 */
function extractGroupArray(text: string): unknown[] {
  for (let start = text.indexOf("["); start >= 0; start = text.indexOf("[", start + 1)) {
    for (let end = text.lastIndexOf("]"); end > start; end = text.lastIndexOf("]", end - 1)) {
      const value = tryParseJson(text.slice(start, end + 1));
      if (Array.isArray(value) && value.length > 0 && value.every(isPlainObject)) return value;
    }
  }
  return [];
}

/** 解析 JSON，失败时返回 undefined */
function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** 是否为普通对象（非 null、非数组） */
function isPlainObject(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 每个文件单独成组，label 为文件路径 */
function singleFileGroups(entries: DiffEntry[]): FileGroup[] {
  return entries.map((e) => ({ label: e.path, entries: [e] }));
}

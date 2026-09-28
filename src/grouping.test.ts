import { describe, it, expect } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import { groupFiles, parseGroups } from "./grouping";
import type { DiffEntry, FileGroup } from "./types";

/** 构造 n 个 diff 条目：f0.ts、f1.ts … */
function entries(n: number): DiffEntry[] {
  return Array.from({ length: n }, (_, i) => ({
    path: `f${i}.ts`,
    status: "modified" as const,
    diff: `diff --git a/f${i}.ts b/f${i}.ts`,
    insertions: 1,
    deletions: 0,
  }));
}

/** 将分组化简为路径数组，便于断言 */
function paths(groups: FileGroup[]): string[][] {
  return groups.map((g) => g.entries.map((e) => e.path));
}

/** 返回固定文本的模型 */
function textModel(text: string): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doGenerate: {
      content: [{ type: "text", text }],
      finishReason: { unified: "stop", raw: undefined },
      usage: {
        inputTokens: { total: 3, noCache: 3, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 2, text: 2, reasoning: undefined },
      },
      warnings: [],
    },
  });
}

describe("parseGroups", () => {
  it("按索引将文件归入分组并保留 label", () => {
    const groups = parseGroups(
      '[{"label":"api","files":[0,2]},{"label":"ui","files":[1,3]}]',
      entries(4),
    );
    expect(groups.map((g) => g.label)).toEqual(["api", "ui"]);
    expect(paths(groups)).toEqual([
      ["f0.ts", "f2.ts"],
      ["f1.ts", "f3.ts"],
    ]);
  });

  it("容忍 JSON 前后的说明文字与代码围栏", () => {
    const groups = parseGroups(
      'Here:\n```json\n[{"label":"all","files":[0,1,2,3]}]\n```',
      entries(4),
    );
    expect(paths(groups)).toEqual([["f0.ts", "f1.ts", "f2.ts", "f3.ts"]]);
  });

  it("跳过说明文字中不是分组数组的方括号", () => {
    const groups = parseGroups(
      '文件 [0] 与 [1] 相关：\n[{"label":"a","files":[0,1]},{"label":"b","files":[2,3]}]\n见 [注]',
      entries(4),
    );
    expect(paths(groups)).toEqual([
      ["f0.ts", "f1.ts"],
      ["f2.ts", "f3.ts"],
    ]);
  });

  it("只丢弃非整数索引与结构不符的组，其余分组保留", () => {
    const groups = parseGroups(
      '[{"label":"a","files":[0,"1",1.5,1]},{"files":[2]},{"label":"c","files":[3,4]}]',
      entries(5),
    );
    expect(paths(groups)).toEqual([["f0.ts", "f1.ts"], ["f3.ts", "f4.ts"], ["f2.ts"]]);
  });

  it("JSON 无法解析或结构不符时退化为单文件组", () => {
    for (const text of ["not json", '{"label":"x"}', '[{"label":1,"files":"0"}]']) {
      expect(paths(parseGroups(text, entries(4)))).toEqual([
        ["f0.ts"],
        ["f1.ts"],
        ["f2.ts"],
        ["f3.ts"],
      ]);
    }
  });

  it("丢弃重复与越界索引，未分配文件各成一组，空组被移除", () => {
    const groups = parseGroups(
      '[{"label":"a","files":[0,1,9,-1]},{"label":"b","files":[1]},{"label":"c","files":[2]}]',
      entries(5),
    );
    expect(paths(groups)).toEqual([["f0.ts", "f1.ts"], ["f2.ts"], ["f3.ts"], ["f4.ts"]]);
  });

  it("同一组内的重复索引只保留一次", () => {
    const groups = parseGroups('[{"label":"a","files":[0,0,1,2,3]}]', entries(4));
    expect(paths(groups)).toEqual([["f0.ts", "f1.ts", "f2.ts", "f3.ts"]]);
  });

  it("超过 10 个文件的组拆分为不超过 10 个文件的多组", () => {
    const all = Array.from({ length: 23 }, (_, i) => i);
    const groups = parseGroups(JSON.stringify([{ label: "big", files: all }]), entries(23));
    expect(groups.map((g) => g.entries.length)).toEqual([10, 10, 3]);
    expect(groups.every((g) => g.label === "big")).toBe(true);
  });
});

describe("groupFiles", () => {
  it("文件数少于 4 时不调用模型，全部归入一组", async () => {
    const model = textModel("[]");
    const result = await groupFiles(entries(3), model);
    expect(model.doGenerateCalls).toHaveLength(0);
    expect(paths(result.groups)).toEqual([["f0.ts", "f1.ts", "f2.ts"]]);
    expect(result.totalTokens).toBe(0);
  });

  it("文件数达到 4 时仅以文件元数据调用分组提示词", async () => {
    const model = textModel('[{"label":"x","files":[0,1]},{"label":"y","files":[2,3]}]');
    const result = await groupFiles(entries(4), model);

    expect(paths(result.groups)).toEqual([
      ["f0.ts", "f1.ts"],
      ["f2.ts", "f3.ts"],
    ]);
    expect(result.totalTokens).toBe(5);
    const prompt = JSON.stringify(model.doGenerateCalls[0].prompt);
    expect(prompt).toContain("[0] MODIFIED f0.ts (+1/-0)");
    expect(prompt).not.toContain("diff --git");
  });

  it("分组调用失败时退化为单文件组", async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        throw new Error("boom");
      },
    });
    const result = await groupFiles(entries(4), model);
    expect(paths(result.groups)).toEqual([["f0.ts"], ["f1.ts"], ["f2.ts"], ["f3.ts"]]);
  });
});

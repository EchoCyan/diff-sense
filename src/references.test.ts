import { describe, it, expect } from "vitest";
import { findReferences } from "./references";
import type { DiffEntry } from "./types";

/** 构造变更文件：路径 → 变更后内容 */
function changes(files: Record<string, string>): {
  entries: DiffEntry[];
  read: (path: string) => Promise<string | undefined>;
} {
  const entries = Object.keys(files).map((path) => ({
    path,
    status: "modified" as const,
    diff: "",
    insertions: 1,
    deletions: 0,
  }));
  return { entries, read: async (path) => files[path] };
}

describe("findReferences", () => {
  it("文件内容以完整单词提到另一变更文件的名字（去掉扩展名）时记为引用", async () => {
    const { entries, read } = changes({
      "user/UserService.java": "public class UserService {}",
      "api/UserController.java": "private final UserService userService;",
      "db/V5__add_phone.sql": "ALTER TABLE user ADD phone VARCHAR(20);",
    });
    expect(await findReferences(entries, read, 5)).toEqual([
      { from: 1, to: 0, name: "UserService" },
    ]);
  });

  it("名字只是更长标识符的一部分时不算引用", async () => {
    const { entries, read } = changes({
      "UserService.java": "",
      "UserServiceImpl.java": "class UserServiceImpl implements IUserService {}",
    });
    expect(await findReferences(entries, read, 5)).toEqual([]);
  });

  it("测试文件与被测文件同名，经 import 路径关联到被测文件，不关联自身", async () => {
    const { entries, read } = changes({
      "src/grouping.ts": "export function groupFiles() {}",
      "src/grouping.test.ts": 'import { groupFiles } from "./grouping";',
    });
    expect(await findReferences(entries, read, 5)).toEqual([{ from: 1, to: 0, name: "grouping" }]);
  });

  it("过短或通用的名字不参与匹配", async () => {
    const { entries, read } = changes({
      "src/index.ts": "",
      "src/db.ts": "",
      "src/app.ts": 'import { db } from "./db";\nimport "./index";',
    });
    expect(await findReferences(entries, read, 5)).toEqual([]);
  });

  it("被超过上限的文件提到的名字整体忽略", async () => {
    const files: Record<string, string> = { "Constants.java": "" };
    for (let i = 0; i < 6; i++) files[`Feature${i}.java`] = "Constants.MAX";
    files["Feature0.java"] += "\nFeature1.run();";
    const { entries, read } = changes(files);
    expect(await findReferences(entries, read, 5)).toEqual([{ from: 1, to: 2, name: "Feature1" }]);
  });

  it("读取失败的文件不产生引用", async () => {
    const { entries } = changes({ "UserService.java": "", "UserController.java": "" });
    expect(await findReferences(entries, async () => undefined, 5)).toEqual([]);
  });
});

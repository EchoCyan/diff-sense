import { basename } from "node:path";
import type { DiffEntry } from "./types";

/** 短于此长度的名字（如 db、ui）太容易误匹配，不参与 */
const MIN_NAME_LENGTH = 4;

/** 通用文件名，出现在任何地方都不代表具体关联 */
const GENERIC_NAMES = new Set(["index", "main", "mod", "__init__"]);

/** 变更文件之间的一条引用：from 的内容提到了 to 的名字 */
export interface Reference {
  /** 提到名字的文件索引 */
  from: number;
  /** 被提到的文件索引 */
  to: number;
  /** 被提到的名字（文件名去掉扩展名） */
  name: string;
}

/**
 * 找出变更文件之间的引用关系，作为语义分组的提示
 *
 * 以文件名去掉扩展名（第一个 `.` 之前）作为名字，在其他变更文件的变更后内容中按完整标识符匹配。
 * 覆盖 Java 等语言以类名引用、TS 等语言以 import 路径引用两种情况；同名的测试文件与被测文件
 * 共享名字，因此都会被关联。结果是文本匹配得出的线索，可能有遗漏或误报
 *
 * @param read - 读取文件变更后的内容，失败时返回 undefined
 * @param maxReferrers - 一个名字被超过这么多文件提到时整体忽略：多为公共类型或常量，
 *   这些文件也无法放进同一组，对分组没有帮助
 * @returns 按 from、to 排序的引用列表
 */
export async function findReferences(
  entries: DiffEntry[],
  read: (path: string) => Promise<string | undefined>,
  maxReferrers: number,
): Promise<Reference[]> {
  // 名字 → 以它为名的文件索引
  const owners = new Map<string, number[]>();
  entries.forEach((e, i) => {
    const name = basename(e.path).split(".")[0];
    if (name.length < MIN_NAME_LENGTH || GENERIC_NAMES.has(name)) return;
    owners.set(name, [...(owners.get(name) ?? []), i]);
  });

  const contents = await Promise.all(entries.map((e) => read(e.path)));
  const references: Reference[] = [];
  for (const [name, targets] of owners) {
    const pattern = new RegExp(`(?<![\\w$])${escapeRegExp(name)}(?![\\w$])`);
    const referrers = contents.flatMap((content, i) =>
      content !== undefined && pattern.test(content) ? [i] : [],
    );
    if (referrers.filter((i) => !targets.includes(i)).length > maxReferrers) continue;
    for (const from of referrers) {
      // 同名文件（如被测文件与测试文件）之间互相关联，但文件不关联自身
      for (const to of targets) if (to !== from) references.push({ from, to, name });
    }
  }
  return references.sort((a, b) => a.from - b.from || a.to - b.to);
}

/** 转义正则元字符 */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

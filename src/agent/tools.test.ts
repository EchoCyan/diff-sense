import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, mkdir, writeFile, rm, access, symlink } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTools, type Locate } from "./tools";
import type { DiffMode } from "../diff";
import type { DiffEntry, Finding } from "../types";

const exec = promisify(execFile);

let root: string;
let repo: string;

/** 恒返回未锚定的定位器 */
const unanchored: Locate = async () => ({ path: "unknown", line: 0, endLine: 0 });

/** 直接调用工具的 execute，绕过 LLM */
async function run(
  name: string,
  input: Record<string, unknown>,
  {
    findings = [] as Finding[],
    locate = unanchored,
    cwd = repo,
    mode = { type: "workspace" } as DiffMode,
    diffs = [] as DiffEntry[],
  } = {},
): Promise<string> {
  const tools = createTools(cwd, mode, findings, locate, diffs);
  return tools[name].execute!(input, { toolCallId: "t", messages: [] } as never) as Promise<string>;
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "diff-sense-tools-"));
  repo = join(root, "repo");
  await mkdir(repo);
  await writeFile(join(root, "outside.txt"), "TOP_SECRET");
  await writeFile(join(repo, "a.ts"), "export const flag = '-n';\n");
  await symlink(join(root, "outside.txt"), join(repo, "link.txt"));
  await exec("git", ["init", "-q"], { cwd: repo });
  await exec("git", ["add", "."], { cwd: repo });
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("code_comment", () => {
  it("记录经锚定后的路径与行号，并在结果中返回位置", async () => {
    const findings: Finding[] = [];
    const locate: Locate = async (code, path) => ({
      path: path ?? "src/inferred.ts",
      line: code === "x()" ? 42 : 0,
      endLine: code === "x()" ? 43 : 0,
    });
    const out = await run(
      "code_comment",
      { severity: "high", category: "bug", content: "问题", existing_code: "x()" },
      { findings, locate },
    );
    expect(findings[0]).toMatchObject({ path: "src/inferred.ts", line: 42, endLine: 43 });
    expect(out).toContain("src/inferred.ts:42");
  });
});

describe("file_read", () => {
  it("读取仓库内文件", async () => {
    expect(await run("file_read", { path: "a.ts" })).toContain("flag");
  });

  it.each(["../outside.txt", "/etc/passwd", "link.txt"])("拒绝读取仓库外路径: %s", async (path) => {
    const out = await run("file_read", { path });
    expect(out).not.toContain("TOP_SECRET");
    expect(out).toMatch(/^Error:/);
  });
});

describe("file_read_diff", () => {
  /** 本次变更的 diff 条目 */
  const diffs: DiffEntry[] = ["src/a.ts", "src/b.ts"].map((path) => ({
    path,
    status: "modified",
    diff: `diff --git a/${path} b/${path}\n+changed in ${path}`,
    insertions: 1,
    deletions: 0,
  }));

  it("按路径返回本次变更中文件的 diff，并标注各自路径", async () => {
    const out = await run("file_read_diff", { paths: ["src/b.ts", "src/a.ts"] }, { diffs });
    expect(out.indexOf("==== FILE: src/b.ts ====")).toBeLessThan(
      out.indexOf("==== FILE: src/a.ts ===="),
    );
    expect(out).toContain("+changed in src/b.ts");
    expect(out).toContain("+changed in src/a.ts");
  });

  it("跳过不在本次变更中的路径；全部不在时返回错误", async () => {
    const out = await run("file_read_diff", { paths: ["src/a.ts", "src/none.ts"] }, { diffs });
    expect(out).toContain("+changed in src/a.ts");
    expect(out).not.toContain("src/none.ts");
    expect(await run("file_read_diff", { paths: ["src/none.ts"] }, { diffs })).toMatch(/^Error:/);
  });
});

describe("code_search", () => {
  it("以 - 开头的查询按字面搜索，不被当作 git 选项", async () => {
    expect(await run("code_search", { query: "-n" })).toContain("a.ts");
  });

  it("workspace 模式搜索未跟踪的新文件，仍遵守 .gitignore", async () => {
    await writeFile(join(repo, ".gitignore"), "ignored.ts\n");
    await writeFile(join(repo, "untracked.ts"), "export const UNTRACKED_PROBE = 1;\n");
    await writeFile(join(repo, "ignored.ts"), "export const UNTRACKED_PROBE = 2;\n");
    const out = await run("code_search", { query: "UNTRACKED_PROBE" });
    expect(out).toContain("untracked.ts:1:");
    expect(out).not.toContain("ignored.ts");
  });

  it("无法通过选项注入执行命令", async () => {
    const marker = join(root, "pwned");
    await run("code_search", { query: `--open-files-in-pager=touch ${marker}` });
    await expect(access(marker)).rejects.toThrow();
  });
});

describe("commit / range 模式读取被审查的版本", () => {
  let history: string;
  let sha: string;

  beforeAll(async () => {
    history = join(root, "history");
    await mkdir(history);
    const git = (...args: string[]) => exec("git", args, { cwd: history });
    await git("init", "-q");
    await writeFile(join(history, "a.ts"), "export const version = 'reviewed';\n");
    await git("add", ".");
    await git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "reviewed");
    sha = (await git("rev-parse", "HEAD")).stdout.trim();
    // 工作区已偏离被审查的提交
    await writeFile(join(history, "a.ts"), "export const version = 'workspace';\n");
  });

  const modes = (): [string, DiffMode][] => [
    ["commit", { type: "commit", sha }],
    ["range", { type: "range", from: sha, to: sha }],
  ];

  it("file_read 读取被审查提交中的文件，而非工作区", async () => {
    for (const [, mode] of modes()) {
      const out = await run("file_read", { path: "a.ts" }, { cwd: history, mode });
      expect(out).toContain("reviewed");
      expect(out).not.toContain("workspace");
    }
  });

  it("file_read 拒绝仓库外路径", async () => {
    const mode: DiffMode = { type: "commit", sha };
    for (const path of ["../outside.txt", "/etc/passwd"]) {
      expect(await run("file_read", { path }, { cwd: history, mode })).toMatch(/^Error:/);
    }
  });

  it("code_search 在被审查提交中搜索，结果与工作区模式格式一致", async () => {
    for (const [, mode] of modes()) {
      const hit = await run("code_search", { query: "reviewed" }, { cwd: history, mode });
      expect(hit).toBe("a.ts:1:export const version = 'reviewed';\n");
      const miss = await run("code_search", { query: "workspace" }, { cwd: history, mode });
      expect(miss).toBe("No matches found.");
    }
  });
});

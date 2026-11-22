import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import {
  commitAll,
  createScratchWorktree,
  createWorktree,
  checkoutOurs,
  checkoutTheirs,
  commitResolution,
  git,
  isClean,
  listUnmerged,
  markResolved,
  mergeBranchesInto,
  mergeIntoCurrent,
  removeWorktree,
  repoRoot,
  resolveWithOurs,
  resolveWithTheirs,
  branchExists,
} from "../src/core/git.ts";

function repo(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-git-"));
  const run = (...a: string[]) => execFileSync("git", a, { cwd: d, stdio: "pipe" });
  run("init", "-q", "-b", "main");
  run("config", "user.email", "t@t");
  run("config", "user.name", "t");
  fs.writeFileSync(path.join(d, "README.md"), "base\n");
  run("add", "-A");
  run("commit", "-qm", "init");
  return d;
}

describe("git worktree flow", () => {
  it("isolates work, chains dependencies, and merges on request", async () => {
    const root = repo();
    expect(await repoRoot(root)).toBeTruthy();

    // task 1 in its own worktree
    const w1 = await createWorktree(root, "t-1", "swarm/t/1");
    fs.writeFileSync(path.join(w1.path, "a.txt"), "from task 1\n");
    expect(await commitAll(w1.path, "task 1")).toBe(true);
    await removeWorktree(root, w1.path);
    expect(fs.existsSync(path.join(root, "a.txt"))).toBe(false); // main untouched

    // task 2 depends on 1: must see a.txt
    const w2 = await createWorktree(root, "t-2", "swarm/t/2");
    expect((await mergeBranchesInto(w2.path, ["swarm/t/1"])).ok).toBe(true);
    expect(fs.readFileSync(path.join(w2.path, "a.txt"), "utf-8")).toContain("task 1");
    fs.writeFileSync(path.join(w2.path, "b.txt"), "from task 2\n");
    await commitAll(w2.path, "task 2");
    await removeWorktree(root, w2.path);

    // human merge gate
    const out = await mergeIntoCurrent(root, ["swarm/t/1", "swarm/t/2"]);
    expect(out.every((o) => o.ok)).toBe(true);
    expect(fs.existsSync(path.join(root, "b.txt"))).toBe(true);
    expect(await isClean(root)).toBe(true);
  });

  it("reports a conflict and aborts cleanly", async () => {
    const root = repo();
    const a = await createWorktree(root, "c-1", "swarm/c/1");
    const b = await createWorktree(root, "c-2", "swarm/c/2");
    fs.writeFileSync(path.join(a.path, "README.md"), "A\n");
    fs.writeFileSync(path.join(b.path, "README.md"), "B\n");
    await commitAll(a.path, "a");
    await commitAll(b.path, "b");
    await removeWorktree(root, a.path);
    await removeWorktree(root, b.path);
    const out = await mergeIntoCurrent(root, ["swarm/c/1", "swarm/c/2"]);
    expect(out[0]?.ok).toBe(true);
    expect(out[1]?.ok).toBe(false);
    expect((await git(root, ["status", "--porcelain"])).stdout.trim()).toBe(""); // merge aborted, tree clean
  });

  it("excludes swarm state from git status", async () => {
    const root = repo();
    const w = await createWorktree(root, "x-1", "swarm/x/1");
    expect(await isClean(root)).toBe(true);
    await removeWorktree(root, w.path);
  });
});

describe("conflict resolution helpers", () => {
  /** Two branches that each change `conflict.txt` differently, then a scratch worktree where merging both conflicts. */
  async function conflictedScratch(root: string): Promise<string> {
    const a = await createWorktree(root, "cx-a", "swarm/cx/a");
    fs.writeFileSync(path.join(a.path, "conflict.txt"), "A side\n");
    fs.writeFileSync(path.join(a.path, "only-a.txt"), "a\n");
    await commitAll(a.path, "a");
    await removeWorktree(root, a.path);

    const b = await createWorktree(root, "cx-b", "swarm/cx/b");
    fs.writeFileSync(path.join(b.path, "conflict.txt"), "B side\n");
    fs.writeFileSync(path.join(b.path, "only-b.txt"), "b\n");
    await commitAll(b.path, "b");
    await removeWorktree(root, b.path);

    const wt = await createScratchWorktree(root, "cx-resolve");
    await git(wt.path, ["merge", "--no-edit", "swarm/cx/a"]); // fast-forwards
    const r = await git(wt.path, ["merge", "--no-edit", "swarm/cx/b"]); // conflicts
    expect(r.code).not.toBe(0);
    return wt.path;
  }

  it("createScratchWorktree uses branch swarm/resolve/<name>", async () => {
    const root = repo();
    const wt = await createScratchWorktree(root, "scratch-1");
    expect(wt.branch).toBe("swarm/resolve/scratch-1");
    expect(await branchExists(root, "swarm/resolve/scratch-1")).toBe(true);
    await removeWorktree(root, wt.path);
  }, 30000);

  it("listUnmerged reports conflicted files and resolveWithOurs resolves them", async () => {
    const root = repo();
    const wtPath = await conflictedScratch(root);

    const unmerged = await listUnmerged(wtPath);
    expect(unmerged).toContain("conflict.txt");

    await resolveWithOurs(wtPath, unmerged);
    expect(fs.readFileSync(path.join(wtPath, "conflict.txt"), "utf-8")).toBe("A side\n");
    expect(await listUnmerged(wtPath)).toEqual([]);
    expect(await commitResolution(wtPath, "resolve with ours")).toBe(true);
    // nothing left to commit
    expect(await commitResolution(wtPath, "again")).toBe(false);

    await removeWorktree(root, wtPath);
  }, 30000);

  it("checkoutTheirs + markResolved resolve a single file", async () => {
    const root = repo();
    const wtPath = await conflictedScratch(root);

    await checkoutTheirs(wtPath, "conflict.txt");
    expect(fs.readFileSync(path.join(wtPath, "conflict.txt"), "utf-8")).toBe("B side\n");
    await markResolved(wtPath, ["conflict.txt"]);
    expect(await listUnmerged(wtPath)).toEqual([]);
    expect(await commitResolution(wtPath, "resolve with theirs")).toBe(true);

    await removeWorktree(root, wtPath);
  }, 30000);

  it("resolveWithTheirs checks out theirs, stages, and commits", async () => {
    const root = repo();
    const wtPath = await conflictedScratch(root);

    await resolveWithTheirs(wtPath, await listUnmerged(wtPath));
    expect(fs.readFileSync(path.join(wtPath, "conflict.txt"), "utf-8")).toBe("B side\n");
    expect(await listUnmerged(wtPath)).toEqual([]);
    expect(await commitResolution(wtPath, "resolve with theirs")).toBe(true);

    await removeWorktree(root, wtPath);
  }, 30000);

  it("listUnmerged is empty on a clean worktree", async () => {
    const root = repo();
    const wt = await createScratchWorktree(root, "clean-1");
    expect(await listUnmerged(wt.path)).toEqual([]);
    await removeWorktree(root, wt.path);
  }, 30000);
});

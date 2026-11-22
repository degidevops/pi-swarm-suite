import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function git(cwd: string, args: string[]): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd, maxBuffer: 20 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as NodeJS.ErrnoException & { code?: unknown }).code === "number" ? ((err as unknown as { code: number }).code) : 1) : 0;
      resolve({ code, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

export async function repoRoot(cwd: string): Promise<string | undefined> {
  const r = await git(cwd, ["rev-parse", "--show-toplevel"]);
  return r.code === 0 ? r.stdout.trim() : undefined;
}

export async function isClean(root: string): Promise<boolean> {
  const r = await git(root, ["status", "--porcelain"]);
  return r.code === 0 && r.stdout.trim() === "";
}

/** Keep swarm state and worktrees out of `git status` without touching the user's .gitignore. */
export async function ensureExcluded(root: string): Promise<void> {
  const r = await git(root, ["rev-parse", "--git-path", "info/exclude"]);
  if (r.code !== 0) return;
  const file = path.resolve(root, r.stdout.trim());
  try {
    const cur = fs.existsSync(file) ? fs.readFileSync(file, "utf-8") : "";
    if (!cur.split("\n").includes(".pi/swarm/")) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, `${cur.endsWith("\n") || !cur ? "" : "\n"}.pi/swarm/\n`);
    }
  } catch {
    /* best effort */
  }
}

export interface Worktree {
  path: string;
  branch: string;
}

export async function createWorktree(root: string, name: string, branch: string, base = "HEAD"): Promise<Worktree> {
  await ensureExcluded(root);
  const wtPath = path.join(root, ".pi", "swarm", "worktrees", name);
  fs.mkdirSync(path.dirname(wtPath), { recursive: true });
  await git(root, ["worktree", "remove", "--force", wtPath]); // leftover from a crashed run
  await git(root, ["branch", "-D", branch]);
  const r = await git(root, ["worktree", "add", "-b", branch, wtPath, base]);
  if (r.code !== 0) throw new Error(`git worktree add failed: ${r.stderr.trim()}`);
  return { path: wtPath, branch };
}

/** Create a scratch worktree for resolving merge conflicts: branch `swarm/resolve/<name>`. */
export async function createScratchWorktree(root: string, name: string, base = "HEAD"): Promise<Worktree> {
  return createWorktree(root, name, `swarm/resolve/${name}`, base);
}

/** Merge dependency branches into a fresh worktree so dependent tasks see predecessor work. */
export async function mergeBranchesInto(wtPath: string, branches: string[]): Promise<{ ok: boolean; error?: string }> {
  for (const b of branches) {
    const r = await git(wtPath, [...(await identityArgs(wtPath)), "merge", "--no-edit", b]);
    if (r.code !== 0) {
      await git(wtPath, ["merge", "--abort"]);
      return { ok: false, error: `merge of ${b} failed: ${(r.stderr || r.stdout).trim().slice(0, 400)}` };
    }
  }
  return { ok: true };
}

async function identityArgs(cwd: string): Promise<string[]> {
  const email = await git(cwd, ["config", "user.email"]);
  if (email.code === 0 && email.stdout.trim()) return [];
  return ["-c", "user.name=pi-swarm", "-c", "user.email=pi-swarm@localhost"];
}

/** Commit everything in the worktree. Returns true if a commit was created. */
export async function commitAll(wtPath: string, message: string): Promise<boolean> {
  await git(wtPath, ["add", "-A"]);
  const st = await git(wtPath, ["status", "--porcelain"]);
  if (st.stdout.trim() === "") return false;
  const r = await git(wtPath, [...(await identityArgs(wtPath)), "commit", "-m", message]);
  return r.code === 0;
}

export async function removeWorktree(root: string, wtPath: string): Promise<void> {
  await git(root, ["worktree", "remove", "--force", wtPath]);
  await git(root, ["worktree", "prune"]);
}

export async function deleteBranch(root: string, branch: string): Promise<void> {
  await git(root, ["branch", "-D", branch]);
}

export async function branchExists(root: string, branch: string): Promise<boolean> {
  return (await git(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`])).code === 0;
}

export interface MergeOutcome {
  branch: string;
  ok: boolean;
  message: string;
}

/** Human-triggered: merge branches into the current branch one by one; abort and stop at the first conflict. */
export async function mergeIntoCurrent(root: string, branches: string[]): Promise<MergeOutcome[]> {
  const out: MergeOutcome[] = [];
  const id = await identityArgs(root);
  for (const b of branches) {
    if (!(await branchExists(root, b))) {
      out.push({ branch: b, ok: true, message: "no branch (task made no changes)" });
      continue;
    }
    const r = await git(root, [...id, "merge", "--no-ff", "--no-edit", b]);
    if (r.code !== 0) {
      await git(root, ["merge", "--abort"]);
      out.push({ branch: b, ok: false, message: `conflict, merge aborted: ${(r.stderr || r.stdout).trim().slice(0, 300)}` });
      break;
    }
    out.push({ branch: b, ok: true, message: "merged" });
  }
  return out;
}

/** `git checkout --theirs -- <file>` inside `worktreePath`. */
export async function checkoutTheirs(worktreePath: string, file: string): Promise<void> {
  const r = await git(worktreePath, ["checkout", "--theirs", "--", file]);
  if (r.code !== 0) throw new Error(`git checkout --theirs failed for ${file}: ${r.stderr.trim()}`);
}

/** `git checkout --ours -- <file>` inside `worktreePath`. */
export async function checkoutOurs(worktreePath: string, file: string): Promise<void> {
  const r = await git(worktreePath, ["checkout", "--ours", "--", file]);
  if (r.code !== 0) throw new Error(`git checkout --ours failed for ${file}: ${r.stderr.trim()}`);
}

/** List files with unmerged (conflicted) entries in `worktreePath`. */
export async function listUnmerged(worktreePath: string): Promise<string[]> {
  const r = await git(worktreePath, ["diff", "--name-only", "--diff-filter=U"]);
  if (r.code !== 0) return [];
  return r.stdout.split("\n").map((f) => f.trim()).filter(Boolean);
}

/** Stage `files` as resolved (`git add`) inside `worktreePath`. */
export async function markResolved(worktreePath: string, files: string[]): Promise<void> {
  if (files.length === 0) return;
  const r = await git(worktreePath, ["add", ...files]);
  if (r.code !== 0) throw new Error(`git add failed: ${r.stderr.trim()}`);
}

/** Checkout ours for every file, then stage them as resolved. */
export async function resolveWithOurs(worktreePath: string, files: string[]): Promise<void> {
  for (const f of files) await checkoutOurs(worktreePath, f);
  await markResolved(worktreePath, files);
}

/** Checkout theirs for every file, then stage them as resolved. */
export async function resolveWithTheirs(worktreePath: string, files: string[]): Promise<void> {
  for (const f of files) await checkoutTheirs(worktreePath, f);
  await markResolved(worktreePath, files);
}

/** Commit the resolution in `worktreePath`. Returns true if a commit was created. */
export async function commitResolution(worktreePath: string, message: string): Promise<boolean> {
  return commitAll(worktreePath, message);
}

/** Paths changed (modified/added/deleted/untracked) relative to HEAD, as seen from `cwd`. */
export async function changedPaths(cwd: string): Promise<string[]> {
  const r = await git(cwd, ["status", "--porcelain", "-z", "-uall"]);
  if (r.code !== 0) return [];
  const parts = r.stdout.split("\0").filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i] as string;
    if (entry.length < 4) continue;
    out.push(entry.slice(3));
    if (entry[0] === "R" || entry[0] === "C") i++; // skip the origin path of a rename/copy
  }
  return out;
}

/** Diff of the work in `cwd`. With `stage`, stages everything first so new files are included (worktrees only). */
export async function diffText(cwd: string, stage: boolean): Promise<string> {
  if (stage) {
    await git(cwd, ["add", "-A"]);
    return (await git(cwd, ["diff", "--cached"])).stdout;
  }
  return (await git(cwd, ["diff", "HEAD"])).stdout;
}

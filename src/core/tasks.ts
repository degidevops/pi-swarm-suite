import * as fs from "node:fs";
import * as path from "node:path";

export type TaskStatus = "pending" | "in_progress" | "awaiting_approval" | "completed" | "failed" | "blocked";

export interface TaskRecord {
  id: string;
  subject: string;
  description: string;
  status: TaskStatus;
  owner?: string;
  deps: string[];
  result?: string;
  branch?: string;
  /** Glob patterns of files this task may touch; edits elsewhere fail the attempt. */
  scope?: string[];
  /** Teammate must produce a plan the lead approves before writing code. */
  needsPlan?: boolean;
  plan?: string;
  planApproved?: boolean;
  planFeedback?: string;
  review?: string;
  attempts: number;
  createdAt: string;
  updatedAt: string;
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * File-per-task store (shared task list). Writes are atomic (tmp + rename) and claims
 * are serialized with a lock file so several pi processes can attach to one team safely.
 */
export class TaskStore {
  constructor(private readonly dir: string) {
    fs.mkdirSync(dir, { recursive: true });
  }

  private file(id: string): string {
    return path.join(this.dir, `${id}.json`);
  }

  private withLock<T>(fn: () => T): T {
    const lock = path.join(this.dir, ".lock");
    const start = Date.now();
    while (true) {
      try {
        fs.closeSync(fs.openSync(lock, "wx"));
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        try {
          if (Date.now() - fs.statSync(lock).mtimeMs > 30_000) fs.rmSync(lock, { force: true });
        } catch {
          /* raced with another process */
        }
        if (Date.now() - start > 5000) throw new Error("task store lock timeout");
        sleepSync(15);
      }
    }
    try {
      return fn();
    } finally {
      fs.rmSync(lock, { force: true });
    }
  }

  private write(task: TaskRecord): void {
    const tmp = `${this.file(task.id)}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(task, null, 2));
    fs.renameSync(tmp, this.file(task.id));
  }

  list(): TaskRecord[] {
    return fs
      .readdirSync(this.dir)
      .filter((f) => /^\d+\.json$/.test(f))
      .map((f) => JSON.parse(fs.readFileSync(path.join(this.dir, f), "utf-8")) as TaskRecord)
      .sort((a, b) => Number(a.id) - Number(b.id));
  }

  get(id: string): TaskRecord | undefined {
    try {
      return JSON.parse(fs.readFileSync(this.file(id), "utf-8")) as TaskRecord;
    } catch {
      return undefined;
    }
  }

  create(input: { subject: string; description: string; deps?: string[]; files?: string[]; plan?: boolean }): TaskRecord {
    return this.withLock(() => {
      const all = this.list();
      const id = String(all.reduce((m, t) => Math.max(m, Number(t.id)), 0) + 1);
      const deps = input.deps ?? [];
      for (const d of deps) if (!all.some((t) => t.id === d)) throw new Error(`task ${id}: unknown dependency "${d}" (deps must already exist)`);
      const now = new Date().toISOString();
      const task: TaskRecord = {
        id,
        subject: input.subject,
        description: input.description,
        status: "pending",
        deps,
        scope: input.files?.length ? input.files : undefined,
        needsPlan: input.plan ? true : undefined,
        attempts: 0,
        createdAt: now,
        updatedAt: now,
      };
      this.write(task);
      return task;
    });
  }

  /** Atomically claim the first pending task whose dependencies are all completed. */
  claimNext(owner: string): TaskRecord | undefined {
    return this.withLock(() => {
      const all = this.list();
      const done = new Set(all.filter((t) => t.status === "completed").map((t) => t.id));
      const next = all.find((t) => t.status === "pending" && t.deps.every((d) => done.has(d)));
      if (!next) return undefined;
      const claimed: TaskRecord = { ...next, status: "in_progress", owner, attempts: next.attempts + 1, updatedAt: new Date().toISOString() };
      this.write(claimed);
      return claimed;
    });
  }

  update(id: string, patch: Partial<TaskRecord>): TaskRecord {
    return this.withLock(() => {
      const cur = this.get(id);
      if (!cur) throw new Error(`unknown task ${id}`);
      const next = { ...cur, ...patch, id: cur.id, updatedAt: new Date().toISOString() };
      this.write(next);
      return next;
    });
  }

  complete(id: string, result: string, branch?: string): TaskRecord {
    return this.update(id, { status: "completed", result, branch });
  }

  fail(id: string, reason: string): TaskRecord {
    return this.update(id, { status: "failed", result: reason });
  }

  /** Mark pending tasks whose dependency failed/blocked as blocked, transitively. Returns how many changed. */
  settleBlocked(): number {
    return this.withLock(() => {
      let changed = 0;
      let again = true;
      while (again) {
        again = false;
        const all = this.list();
        const dead = new Set(all.filter((t) => t.status === "failed" || t.status === "blocked").map((t) => t.id));
        for (const t of all) {
          if (t.status === "pending" && t.deps.some((d) => dead.has(d))) {
            this.write({ ...t, status: "blocked", result: "blocked: a dependency failed", updatedAt: new Date().toISOString() });
            changed++;
            again = true;
          }
        }
      }
      return changed;
    });
  }

  hasActive(): boolean {
    return this.list().some((t) => t.status === "in_progress");
  }

  /** Crash recovery: tasks left in_progress by a dead run go back to pending. */
  resetStale(): number {
    return this.withLock(() => {
      let n = 0;
      for (const t of this.list()) {
        if (t.status === "in_progress") {
          this.write({ ...t, status: "pending", owner: undefined, updatedAt: new Date().toISOString() });
          n++;
        }
      }
      return n;
    });
  }

  summary(): Record<TaskStatus, number> {
    const s: Record<TaskStatus, number> = { pending: 0, in_progress: 0, awaiting_approval: 0, completed: 0, failed: 0, blocked: 0 };
    for (const t of this.list()) s[t.status]++;
    return s;
  }
}

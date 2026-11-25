/**
 * tmux integration: every worker gets its own tmux window that follows the worker's live log
 * (`tail -F`), plus a "monitor" window showing the swarm status. The tmux session is detached and
 * separate from your work, so you can attach from any terminal:  tmux attach -t swarm-<project>
 *
 * Design notes:
 *  - Windows are VIEWERS. They never own the worker process, so closing a window or detaching
 *    cannot kill a worker.
 *  - A viewer follows the log until the worker's `.done` marker appears, then drops into a shell
 *    in the worker's working directory (its git worktree for team tasks) so you can inspect files.
 *  - Everything is best-effort and never throws: a missing tmux simply disables the feature.
 *  - Commands are executed with argv arrays (no shell interpolation of labels or paths).
 */
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { safeFileName, statusFile } from "./worklog.ts";

export interface ExecResult {
  status: number | null;
  stdout: string;
  stderr: string;
}
export type TmuxExec = (args: string[]) => ExecResult;

export const defaultExec: TmuxExec = (args) => {
  try {
    const r = spawnSync("tmux", args, { encoding: "utf-8", timeout: 5000 });
    return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  } catch (e) {
    return { status: null, stdout: "", stderr: e instanceof Error ? e.message : String(e) };
  }
};

export interface TmuxConfig {
  enabled: boolean;
  /** Session name override. Default: swarm-<project dir name>. */
  session?: string;
}

export function tmuxAvailable(exec: TmuxExec = defaultExec): boolean {
  return exec(["-V"]).status === 0;
}

/** tmux session names may not contain `.` or `:`; keep it simple and predictable. */
export function sessionNameFor(cwd: string, override?: string): string {
  const raw = override?.trim() || `swarm-${path.basename(cwd) || "project"}`;
  return raw.replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 60) || "swarm";
}

/** Script run inside a worker window: follow the log until the done marker appears, then keep a shell open. */
export const VIEWER_SCRIPT = [
  'LOG="$1"; DONE="$2"',
  'touch "$LOG"',
  'tail -n +1 -F "$LOG" 2>/dev/null & TP=$!',
  'while [ ! -e "$DONE" ]; do sleep 1; done',
  "sleep 1",
  'kill "$TP" 2>/dev/null',
  'printf "\\n── worker finished (%s) — this shell is in its working dir; Ctrl-b d to detach ──\\n" "$(cat "$DONE" 2>/dev/null)"',
  'exec "${SHELL:-sh}"',
].join("\n");

/** Script run in the monitor window: redraw the swarm status snapshot every 2 s. */
export const MONITOR_SCRIPT = [
  'F="$1"',
  "while :; do",
  "  clear",
  '  if [ -r "$F" ]; then cat "$F"; else echo "(swarm idle — no status yet)"; fi',
  "  sleep 2",
  "done",
].join("\n");

export class TmuxManager {
  enabled: boolean;
  readonly session: string;
  private readonly windows = new Map<string, string>(); // label -> window name
  private readonly usedNames = new Set<string>();
  private sessionReady = false;

  constructor(
    private readonly cwd: string,
    cfg: TmuxConfig,
    private readonly exec: TmuxExec = defaultExec,
  ) {
    this.enabled = cfg.enabled;
    this.session = sessionNameFor(cwd, cfg.session);
  }

  available(): boolean {
    return tmuxAvailable(this.exec);
  }

  attachCommand(): string {
    return `tmux attach -t ${this.session}`;
  }

  windowFor(label: string): string | undefined {
    return this.windows.get(label);
  }

  /** Create the detached session (and its monitor window) if needed. Returns false when tmux is unusable. */
  ensureSession(): boolean {
    if (!this.available()) return false;
    if (this.exec(["has-session", "-t", `=${this.session}`]).status === 0) {
      this.sessionReady = true;
      return true;
    }
    const r = this.exec([
      "new-session", "-d", "-s", this.session, "-n", "monitor", "-c", this.cwd,
      "sh", "-c", MONITOR_SCRIPT, "_", statusFile(this.cwd),
    ]);
    this.sessionReady = r.status === 0;
    return this.sessionReady;
  }

  private uniqueName(label: string): string {
    const base = safeFileName(label).slice(0, 28) || "worker";
    let name = base;
    for (let i = 2; this.usedNames.has(name); i++) name = `${base.slice(0, 25)}-${i}`;
    this.usedNames.add(name);
    return name;
  }

  /** Open a viewer window for a worker. Returns the window name, or undefined if tmux is unavailable/disabled. */
  openWorker(label: string, logPath: string, doneFile: string, workerCwd: string): string | undefined {
    if (!this.enabled) return undefined;
    try {
      if (!this.sessionReady && !this.ensureSession()) return undefined;
      const name = this.uniqueName(label);
      const r = this.exec([
        "new-window", "-d", "-t", `=${this.session}:`, "-n", name, "-c", workerCwd || this.cwd,
        "sh", "-c", VIEWER_SCRIPT, "_", logPath, doneFile,
      ]);
      if (r.status !== 0) {
        // The session may have been killed by the user in the meantime: retry once.
        this.sessionReady = false;
        if (!this.ensureSession()) return undefined;
        const r2 = this.exec([
          "new-window", "-d", "-t", `=${this.session}:`, "-n", name, "-c", workerCwd || this.cwd,
          "sh", "-c", VIEWER_SCRIPT, "_", logPath, doneFile,
        ]);
        if (r2.status !== 0) return undefined;
      }
      this.windows.set(label, name);
      return name;
    } catch {
      return undefined;
    }
  }

  /** Window names currently present in the session (empty if the session does not exist). */
  listWindows(): string[] {
    const r = this.exec(["list-windows", "-t", `=${this.session}`, "-F", "#{window_name}"]);
    return r.status === 0 ? r.stdout.split("\n").map((s) => s.trim()).filter(Boolean) : [];
  }

  killSession(): boolean {
    const ok = this.exec(["kill-session", "-t", `=${this.session}`]).status === 0;
    this.windows.clear();
    this.usedNames.clear();
    this.sessionReady = false;
    return ok;
  }
}

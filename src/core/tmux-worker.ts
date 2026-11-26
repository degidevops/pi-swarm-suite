/**
 * A worker that is a REAL interactive pi running in its own tmux window.
 *
 * Why: `tail -F` on a log shows status lines, not the agent. Here the window IS the agent: its full TUI
 * (reasoning, tool calls, diffs) is visible and the user can type to it, while the lead keeps control over
 * the same channel it uses for headless workers: result, steer, abort, probe, events for the monitor.
 *
 * It mirrors RpcWorker's public surface (`result`, `steer`, `abort`, `probe`) so Runtime treats both alike.
 * Lifecycle: start → pi boots in the window → first `agent_settled` = task finished → `quit` command →
 * pi exits → the window stays open on a shell in the worker's directory for inspection.
 */
import * as fs from "node:fs";
import { type WorkerResult, emptyUsage } from "../types.ts";
import { prepareChild } from "./child.ts";
import type { ProbeResult } from "./monitor.ts";
import { type TmuxManager } from "./tmux.ts";
import { type WorkerOptions, Collector, isObj } from "./worker.ts";
import { type CtlCommand, JsonlTail, appendJsonl, ctlPaths, CTL_ENV, renderEnvFile } from "./tmux-control.ts";
import { sleep } from "./util.ts";

const POLL_MS = 200;
const ALIVE_STALE_MS = 5000;
const QUIT_GRACE_MS = 6000;
/** A pi that never reaches `ready` (crashed on boot, blocked on a prompt) is reported instead of waiting forever. */
const BOOT_TIMEOUT_MS = 90_000;

export interface TmuxWorkerOptions {
  tmux: TmuxManager;
  ctlDir: string;
  /** Trust project-local resources in the worker (mirrors the lead's trust). */
  approve: boolean;
}

export class TmuxWorker {
  readonly result: Promise<WorkerResult>;
  /** tmux window (or pane) name the worker runs in. */
  window = "";
  private resolveResult!: (r: WorkerResult) => void;
  private readonly col: Collector;
  private readonly events: JsonlTail;
  private readonly paths: ReturnType<typeof ctlPaths>;
  private settled = false;
  private aborted = false;
  private ready = false;
  private streaming = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  private cleanup: () => Promise<void> = async () => undefined;
  private readonly startedAt = Date.now();

  private constructor(
    private readonly opts: WorkerOptions,
    private readonly t: TmuxWorkerOptions,
  ) {
    this.paths = ctlPaths(t.ctlDir);
    this.events = new JsonlTail(this.paths.events);
    this.col = new Collector(opts.onUsage, opts.onProgress);
    this.result = new Promise((res) => {
      this.resolveResult = res;
    });
  }

  /** Start the worker. Returns undefined when no tmux window could be opened (caller falls back to headless). */
  static async start(opts: WorkerOptions, t: TmuxWorkerOptions): Promise<TmuxWorker | undefined> {
    const w = new TmuxWorker(opts, t);
    return (await w.launch()) ? w : undefined;
  }

  private async launch(): Promise<boolean> {
    const { opts, t } = this;
    if (opts.signal?.aborted) {
      void this.finish("aborted", "aborted before start");
      return true;
    }
    fs.mkdirSync(t.ctlDir, { recursive: true });
    for (const f of [this.paths.events, this.paths.commands]) fs.writeFileSync(f, "");
    fs.rmSync(this.paths.exit, { force: true });

    const prep = await prepareChild("tui", { ...opts, approve: t.approve }, opts.task);
    this.cleanup = prep.cleanup;
    const env = { ...prep.env, [CTL_ENV]: t.ctlDir };
    fs.writeFileSync(this.paths.env, renderEnvFile(env), { mode: 0o600 });

    const name = t.tmux.openAgent({
      label: opts.label,
      cwd: opts.cwd,
      envFile: this.paths.env,
      exitFile: this.paths.exit,
      command: prep.command,
      args: prep.args,
    });
    if (!name) {
      fs.rmSync(this.paths.env, { force: true });
      await this.cleanup();
      return false;
    }
    this.window = name;
    this.timer = setInterval(() => this.tick(), POLL_MS);
    this.timer.unref?.();
    if (opts.signal) opts.signal.addEventListener("abort", () => this.abort(), { once: true });
    return true;
  }

  private tick(): void {
    if (this.settled) return;
    for (const ev of this.events.read()) this.onEvent(ev);
    if (this.settled) return;
    // The wrapper writes `exit` when pi ends; reaching here means it ended without settling.
    if (fs.existsSync(this.paths.exit)) {
      const code = fs.readFileSync(this.paths.exit, "utf-8").trim();
      void this.finish("failed", `pi exited (code ${code || "?"}) before the task finished — see tmux window "${this.window}"`);
      return;
    }
    if (!this.ready && Date.now() - this.startedAt > BOOT_TIMEOUT_MS) {
      void this.finish("failed", `pi did not start within ${BOOT_TIMEOUT_MS / 1000}s — see tmux window "${this.window}" (a prompt may be waiting for input)`);
    }
  }

  private onEvent(ev: unknown): void {
    if (!isObj(ev)) return;
    if (ev.type === "ready") {
      this.ready = true;
      fs.rmSync(this.paths.env, { force: true }); // secrets are no longer needed on disk
    }
    if (ev.type === "agent_start") this.streaming = true;
    this.opts.onEvent?.(ev);
    if (ev.type === "agent_settled") {
      this.streaming = false;
      void this.finish(ev.aborted === true ? "aborted" : "ok");
      return;
    }
    this.col.feed(ev);
  }

  private command(cmd: CtlCommand): boolean {
    if (this.settled && cmd.type !== "quit") return false;
    appendJsonl(this.paths.commands, cmd);
    return true;
  }

  steer(text: string): boolean {
    return this.command({ type: "steer", text });
  }

  abort(): void {
    if (this.settled || this.aborted) return;
    this.aborted = true;
    this.command({ type: "abort" });
    setTimeout(() => {
      if (!this.settled) void this.finish("aborted", "aborted");
    }, 2500).unref();
  }

  /** The heartbeat file is touched every second by the worker's event loop; a stale one means it is hung. */
  probe(): Promise<ProbeResult> {
    let responsive = false;
    try {
      responsive = Date.now() - fs.statSync(this.paths.alive).mtimeMs < ALIVE_STALE_MS;
    } catch {
      /* not started yet */
    }
    return Promise.resolve({ responsive, isStreaming: this.streaming, at: Date.now() });
  }

  private async finish(kind: "ok" | "failed" | "aborted", error?: string): Promise<void> {
    if (this.settled) return;
    this.settled = true;
    if (this.timer) clearInterval(this.timer);
    // Ask pi to exit; the window then drops to a shell (kept open for inspection).
    this.command({ type: "quit" });
    const deadline = Date.now() + QUIT_GRACE_MS;
    while (Date.now() < deadline && !fs.existsSync(this.paths.exit)) await sleep(150);
    if (!fs.existsSync(this.paths.exit)) this.t.tmux.interrupt(this.window); // last resort: Ctrl-C the TUI
    fs.rmSync(this.paths.env, { force: true });
    await this.cleanup();

    const base: WorkerResult = {
      label: this.opts.label,
      status: "failed",
      output: this.col.lastText,
      usage: this.col.usage ?? emptyUsage(),
      model: this.opts.model,
      exitCode: null,
      cwd: this.opts.cwd,
    };
    if (kind === "aborted" || this.aborted) return this.resolveResult({ ...base, status: "aborted", error: error ?? "aborted" });
    if (kind === "failed") return this.resolveResult({ ...base, error });
    if (this.col.lastError) return this.resolveResult({ ...base, error: this.col.lastError });
    if (!this.col.lastText.trim()) return this.resolveResult({ ...base, error: "worker produced no output" });
    this.resolveResult({ ...base, status: "ok" });
  }
}

import { spawn, type ChildProcess } from "node:child_process";
import { type WorkerResult, emptyUsage } from "../types.ts";
import { type ResidentWorker, type TurnHooks, type WorkerOptions, Collector, isObj } from "./worker.ts";
import { prepareChild } from "./child.ts";
import { sleep, tail } from "./util.ts";
import type { ProbeResult } from "./monitor.ts";

/**
 * Long-lived worker over `pi --mode rpc`. Unlike the one-shot JSON worker it can be
 * steered while running (new instructions, teammate messages) and aborted cleanly.
 * Framing: strict JSONL split on LF only (per pi's RPC docs).
 */
export class RpcWorker implements ResidentWorker {
  readonly result: Promise<WorkerResult>;
  private resolveResult!: (r: WorkerResult) => void;
  private proc?: ChildProcess;
  private col: Collector;
  private turnHooks?: TurnHooks;
  private turnResolve?: (r: WorkerResult) => void;
  private promptSeq = 1;
  private settled = false;
  private aborted = false;
  private stderr = "";
  private closed: Promise<void> = Promise.resolve();
  private cleanup: () => Promise<void> = async () => undefined;
  private probeSeq = 0;
  private readonly probes = new Map<string, (data: Record<string, unknown>) => void>();

  private constructor(private readonly opts: WorkerOptions) {
    this.col = new Collector(opts.onUsage, opts.onProgress);
    this.result = new Promise((res) => {
      this.resolveResult = res;
    });
  }

  static async start(opts: WorkerOptions): Promise<RpcWorker> {
    const w = new RpcWorker(opts);
    await w.launch();
    return w;
  }

  /** Callbacks for the current turn (resident) or for the single run (one-shot). */
  private get hk(): Pick<TurnHooks, "onEvent" | "onProgress" | "onStderr"> {
    return this.turnHooks ?? this.opts;
  }

  get dead(): boolean {
    return this.settled;
  }

  get window(): string | undefined {
    return undefined;
  }

  private async launch(): Promise<void> {
    if (this.opts.signal?.aborted) return void this.finish("aborted", "aborted before start");
    const prep = await prepareChild("rpc", this.opts);
    this.cleanup = prep.cleanup;
    try {
      this.proc = spawn(prep.command, prep.args, { cwd: this.opts.cwd, shell: false, stdio: ["pipe", "pipe", "pipe"], env: prep.env });
    } catch (e) {
      return void this.finish("failed", `spawn failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    const proc = this.proc;
    this.closed = new Promise((res) => proc.once("close", () => res()));
    let buffer = "";
    proc.stdout?.on("data", (d) => {
      buffer += d.toString();
      let i: number;
      while ((i = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, i).replace(/\r$/, "");
        buffer = buffer.slice(i + 1);
        this.onLine(line);
      }
    });
    proc.stderr?.on("data", (d) => {
      this.stderr += d.toString();
      this.hk.onStderr?.(d.toString());
    });
    proc.stdin?.on("error", () => undefined); // EPIPE after the child exits is expected
    proc.on("error", (e) => void this.finish("failed", `spawn failed: ${e.message}`));
    proc.on("close", (code) => {
      if (!this.settled) void this.finish("failed", tail(this.stderr.trim(), 600) || `child exited early (code ${code})`);
    });
    if (this.opts.persistent) return; // resident: tasks arrive through turn(), cancellation is per turn
    if (this.opts.signal) {
      if (this.opts.signal.aborted) this.abort();
      else this.opts.signal.addEventListener("abort", () => this.abort(), { once: true });
    }
    this.send({ id: "prompt-1", type: "prompt", message: this.opts.task });
  }

  private onLine(raw: string): void {
    if (!raw.trim()) return;
    let ev: unknown;
    try {
      ev = JSON.parse(raw);
    } catch {
      return;
    }
    if (!isObj(ev)) return;
    if (ev.type === "response") {
      if (ev.command === "get_state" && typeof ev.id === "string") {
        const cb = this.probes.get(ev.id);
        if (cb) {
          this.probes.delete(ev.id);
          cb(isObj(ev.data) ? ev.data : {});
        }
        return;
      }
      if (ev.command === "prompt") {
        const failure = ev.success === false ? (typeof ev.error === "string" ? ev.error : "prompt rejected") : isObj(ev.data) && ev.data.disposition === "handled" ? "prompt was handled by an extension; no agent run started" : undefined;
        if (failure) void (this.opts.persistent ? this.endTurn("failed", failure) : this.finish("failed", failure));
      }
      return;
    }
    this.hk.onEvent?.(ev); // everything except command responses counts as proof of life
    if (ev.type === "extension_ui_request") {
      // A headless worker has nobody to answer dialogs from other extensions: cancel instead of hanging forever.
      const method = ev.method;
      if (typeof ev.id === "string" && (method === "select" || method === "confirm" || method === "input" || method === "editor")) {
        this.send({ type: "extension_ui_response", id: ev.id, cancelled: true });
        this.hk.onProgress?.(`(auto-cancelled a ${method} dialog from an extension)`);
      }
      return;
    }
    if (ev.type === "agent_settled") {
      void (this.opts.persistent ? this.endTurn(ev.aborted === true ? "aborted" : "ok") : this.finish(ev.aborted === true ? "aborted" : "ok"));
      return;
    }
    this.col.feed(ev);
  }

  private send(obj: Record<string, unknown>): boolean {
    try {
      return this.proc?.stdin?.write(`${JSON.stringify(obj)}\n`) ?? false;
    } catch {
      return false;
    }
  }

  /**
   * Ask the child for its state. A child whose event loop is alive answers within milliseconds even when
   * it is busy waiting on the model or a tool, so a missing answer means the process itself is hung.
   * The reply is deliberately NOT forwarded to `onEvent`: probing must not make a hung worker look active.
   */
  probe(timeoutMs = 5000): Promise<ProbeResult> {
    if (this.settled) return Promise.resolve({ responsive: false, at: Date.now() });
    const id = `probe-${++this.probeSeq}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.probes.delete(id);
        resolve({ responsive: false, at: Date.now() });
      }, timeoutMs);
      timer.unref?.();
      this.probes.set(id, (d) => {
        clearTimeout(timer);
        resolve({
          responsive: true,
          isStreaming: typeof d.isStreaming === "boolean" ? d.isStreaming : undefined,
          isCompacting: typeof d.isCompacting === "boolean" ? d.isCompacting : undefined,
          pendingMessageCount: typeof d.pendingMessageCount === "number" ? d.pendingMessageCount : undefined,
          at: Date.now(),
        });
      });
      if (!this.send({ id, type: "get_state" })) {
        clearTimeout(timer);
        this.probes.delete(id);
        resolve({ responsive: false, at: Date.now() });
      }
    });
  }

  /** Inject a new instruction; pi delivers it before the worker's next model call. */
  steer(text: string): boolean {
    if (this.settled) return false;
    return this.send({ type: "steer", message: text });
  }

  abort(): void {
    if (this.settled || this.aborted) return;
    this.aborted = true;
    this.send({ type: "abort" });
    setTimeout(() => {
      if (!this.settled && (!this.opts.persistent || this.turnResolve)) void this.finish("aborted", "aborted");
    }, 2500).unref();
  }

  /**
   * Resident mode: run one task in the live process. Resolves when the agent settles; the process stays up
   * for the next task. Usage and output are per turn (a fresh collector).
   */
  turn(task: string, hooks: TurnHooks): Promise<WorkerResult> {
    if (this.settled) return Promise.resolve(this.turnResult("failed", "resident worker has exited"));
    this.turnHooks = hooks;
    this.col = new Collector(hooks.onUsage, hooks.onProgress);
    this.aborted = false;
    const done = new Promise<WorkerResult>((resolve) => {
      this.turnResolve = resolve;
    });
    if (hooks.signal?.aborted) this.abort();
    else hooks.signal?.addEventListener("abort", () => this.abort(), { once: true });
    if (!this.send({ id: `prompt-${++this.promptSeq}`, type: "prompt", message: task })) void this.endTurn("failed", "could not reach the worker process");
    return done;
  }

  private turnResult(kind: "ok" | "failed" | "aborted", error?: string): WorkerResult {
    const base: WorkerResult = {
      label: this.turnHooks?.label ?? this.opts.label,
      status: "failed",
      output: this.col.lastText,
      usage: this.col.usage ?? emptyUsage(),
      model: this.opts.model,
      exitCode: this.proc?.exitCode ?? null,
      cwd: this.opts.cwd,
    };
    if (kind === "aborted" || this.aborted) return { ...base, status: "aborted", error: error ?? "aborted" };
    if (kind === "failed") return { ...base, error };
    if (this.col.lastError) return { ...base, error: this.col.lastError };
    if (!this.col.lastText.trim()) return { ...base, error: "worker produced no output" };
    return { ...base, status: "ok" };
  }

  private async endTurn(kind: "ok" | "failed" | "aborted", error?: string): Promise<void> {
    const resolve = this.turnResolve;
    if (!resolve) return;
    this.turnResolve = undefined;
    resolve(this.turnResult(kind, error));
  }

  /** End the process (orderly) and resolve any pending turn. */
  close(): Promise<void> {
    return this.finish("ok").then(() => undefined);
  }

  /** Resolve the one-shot result and any turn that is still waiting (resident process ended mid-turn). */
  private deliver(r: WorkerResult): void {
    this.resolveResult(r);
    const pending = this.turnResolve;
    this.turnResolve = undefined;
    pending?.(r);
  }

  private async finish(kind: "ok" | "failed" | "aborted", error?: string): Promise<void> {
    if (this.settled) return;
    this.settled = true;
    const proc = this.proc;
    try {
      proc?.stdin?.end(); // orderly shutdown per RPC docs
    } catch {
      /* already closed */
    }
    const killer = setTimeout(() => proc?.kill("SIGKILL"), 6000);
    killer.unref();
    await Promise.race([this.closed, sleep(3000)]);
    if (proc && proc.exitCode === null && proc.signalCode === null) proc.kill("SIGTERM");
    clearTimeout(killer);
    await this.cleanup();

    const base: WorkerResult = {
      label: this.opts.label,
      status: "failed",
      output: this.col.lastText,
      usage: this.col.usage ?? emptyUsage(),
      model: this.opts.model,
      exitCode: proc?.exitCode ?? null,
      cwd: this.opts.cwd,
    };
    if (kind === "aborted" || this.aborted) return this.deliver({ ...base, status: "aborted", error: error ?? "aborted" });
    if (kind === "failed") return this.deliver({ ...base, error });
    if (this.col.lastError) return this.deliver({ ...base, error: this.col.lastError });
    if (!this.col.lastText.trim()) return this.deliver({ ...base, error: "worker produced no output" });
    this.deliver({ ...base, status: "ok" });
  }
}

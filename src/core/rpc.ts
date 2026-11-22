import { spawn, type ChildProcess } from "node:child_process";
import { type WorkerResult, emptyUsage } from "../types.ts";
import { type WorkerOptions, Collector, isObj } from "./worker.ts";
import { prepareChild } from "./child.ts";
import { sleep, tail } from "./util.ts";

/**
 * Long-lived worker over `pi --mode rpc`. Unlike the one-shot JSON worker it can be
 * steered while running (new instructions, teammate messages) and aborted cleanly.
 * Framing: strict JSONL split on LF only (per pi's RPC docs).
 */
export class RpcWorker {
  readonly result: Promise<WorkerResult>;
  private resolveResult!: (r: WorkerResult) => void;
  private proc?: ChildProcess;
  private readonly col: Collector;
  private settled = false;
  private aborted = false;
  private stderr = "";
  private closed: Promise<void> = Promise.resolve();
  private cleanup: () => Promise<void> = async () => undefined;

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
    });
    proc.stdin?.on("error", () => undefined); // EPIPE after the child exits is expected
    proc.on("error", (e) => void this.finish("failed", `spawn failed: ${e.message}`));
    proc.on("close", (code) => {
      if (!this.settled) void this.finish("failed", tail(this.stderr.trim(), 600) || `child exited early (code ${code})`);
    });
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
      if (ev.command === "prompt") {
        if (ev.success === false) void this.finish("failed", typeof ev.error === "string" ? ev.error : "prompt rejected");
        else if (isObj(ev.data) && ev.data.disposition === "handled") void this.finish("failed", "prompt was handled by an extension; no agent run started");
      }
      return;
    }
    if (ev.type === "extension_ui_request") {
      // A headless worker has nobody to answer dialogs from other extensions: cancel instead of hanging forever.
      const method = ev.method;
      if (typeof ev.id === "string" && (method === "select" || method === "confirm" || method === "input" || method === "editor")) {
        this.send({ type: "extension_ui_response", id: ev.id, cancelled: true });
        this.opts.onProgress?.(`(auto-cancelled a ${method} dialog from an extension)`);
      }
      return;
    }
    if (ev.type === "agent_settled") {
      void this.finish(ev.aborted === true ? "aborted" : "ok");
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
      if (!this.settled) void this.finish("aborted", "aborted");
    }, 2500).unref();
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
    if (kind === "aborted" || this.aborted) return this.resolveResult({ ...base, status: "aborted", error: error ?? "aborted" });
    if (kind === "failed") return this.resolveResult({ ...base, error });
    if (this.col.lastError) return this.resolveResult({ ...base, error: this.col.lastError });
    if (!this.col.lastText.trim()) return this.resolveResult({ ...base, error: "worker produced no output" });
    this.resolveResult({ ...base, status: "ok" });
  }
}

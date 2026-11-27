import { spawn } from "node:child_process";
import { type Usage, type WorkerResult, emptyUsage } from "../types.ts";
import { prepareChild } from "./child.ts";
import { tail } from "./util.ts";

export { DEPTH_ENV } from "./child.ts";

export interface WorkerOptions {
  label: string;
  task: string;
  cwd: string;
  systemPrompt?: string;
  model?: string;
  thinking?: string;
  tools?: string[];
  signal?: AbortSignal;
  depth: number;
  extPath?: string;
  env?: Record<string, string>;
  /** Session directory for workers that persist across sessions (ROADMAP #3). */
  sessionDir?: string;
  /** Resident mode: the process stays alive after a task and runs further tasks via `turn()`. `task` is unused. */
  persistent?: boolean;
  onUsage?: (delta: Partial<Usage>) => void;
  onProgress?: (line: string) => void;
  /** Every parsed event the child emits (JSON mode: all records; RPC mode: all except command responses). */
  onEvent?: (ev: unknown) => void;
  /** Raw stderr chunks from the child. */
  onStderr?: (chunk: string) => void;
}

/** Per-turn callbacks and cancellation of a resident worker (they change with every task it is given). */
export interface TurnHooks {
  label: string;
  signal?: AbortSignal;
  onUsage?: (delta: Partial<Usage>) => void;
  onProgress?: (line: string) => void;
  onEvent?: (ev: unknown) => void;
  onStderr?: (chunk: string) => void;
}

/** What Runtime needs from a long-lived worker (RpcWorker and TmuxWorker in persistent mode). */
export interface ResidentWorker {
  /** Run one task in the live process; resolves when the agent settles. Process stays alive. */
  turn(task: string, hooks: TurnHooks): Promise<WorkerResult>;
  steer(text: string): boolean;
  abort(): void;
  probe(timeoutMs?: number): Promise<import("./monitor.ts").ProbeResult>;
  /** True once the process has ended (closed, crashed or killed). */
  readonly dead: boolean;
  /** tmux window, when the worker has one. */
  readonly window?: string;
  /** End the process (orderly). */
  close(): Promise<void>;
}

type Json = Record<string, unknown>;
export const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null;

/** Extract text + a one-line progress hint from a completed message. Pure; unit-tested. */
export function readMessage(message: unknown): { role?: string; text: string; tools: string[]; usage?: Partial<Usage>; error?: string } {
  if (!isObj(message)) return { text: "", tools: [] };
  const role = typeof message.role === "string" ? message.role : undefined;
  let text = "";
  const tools: string[] = [];
  if (Array.isArray(message.content)) {
    for (const part of message.content) {
      if (!isObj(part)) continue;
      if (part.type === "text" && typeof part.text === "string") text += part.text;
      if (part.type === "toolCall" && typeof part.name === "string") tools.push(part.name);
    }
  }
  let usage: Partial<Usage> | undefined;
  if (role === "assistant" && isObj(message.usage)) {
    const u = message.usage;
    const cost = isObj(u.cost) && typeof u.cost.total === "number" ? u.cost.total : 0;
    usage = {
      input: typeof u.input === "number" ? u.input : 0,
      output: typeof u.output === "number" ? u.output : 0,
      cacheRead: typeof u.cacheRead === "number" ? u.cacheRead : 0,
      cacheWrite: typeof u.cacheWrite === "number" ? u.cacheWrite : 0,
      cost,
      turns: 1,
    };
  }
  const error = message.stopReason === "error" && typeof message.errorMessage === "string" ? message.errorMessage : undefined;
  return { role, text, tools, usage, error };
}

/** Accumulates the interesting parts of a child's event stream (shared by JSON and RPC workers). */
export class Collector {
  usage: Usage = emptyUsage();
  lastText = "";
  lastError?: string;
  constructor(
    private readonly onUsage?: (d: Partial<Usage>) => void,
    private readonly onProgress?: (line: string) => void,
  ) {}

  feed(ev: unknown): void {
    if (!isObj(ev) || ev.type !== "message_end") return;
    const m = readMessage(ev.message);
    if (m.role !== "assistant") return;
    if (m.text) this.lastText = m.text;
    if (m.error) this.lastError = m.error;
    if (m.usage) {
      this.usage.input += m.usage.input ?? 0;
      this.usage.output += m.usage.output ?? 0;
      this.usage.cacheRead += m.usage.cacheRead ?? 0;
      this.usage.cacheWrite += m.usage.cacheWrite ?? 0;
      this.usage.cost += m.usage.cost ?? 0;
      this.usage.turns += 1;
      this.onUsage?.(m.usage);
    }
    this.onProgress?.(m.tools.length ? `tool: ${m.tools.join(", ")}` : (m.text.split("\n").find((l) => l.trim()) ?? ""));
  }
}

/** One-shot worker: `pi --mode json -p`. Cheap and simple; not steerable. */
export async function runWorkerProcess(opts: WorkerOptions): Promise<WorkerResult> {
  const base: WorkerResult = { label: opts.label, status: "failed", output: "", usage: emptyUsage(), model: opts.model, exitCode: null, cwd: opts.cwd };
  if (opts.signal?.aborted) return { ...base, status: "aborted", error: "aborted before start" };

  const prep = await prepareChild("json", opts, opts.task);
  const col = new Collector(opts.onUsage, opts.onProgress);
  let stderr = "";
  let aborted = false;
  try {
    const outcome = await new Promise<{ code: number | null; spawnError?: Error }>((resolve) => {
      let buffer = "";
      let settled = false;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      let proc: ReturnType<typeof spawn>;
      const done = (v: { code: number | null; spawnError?: Error }) => {
        if (settled) return;
        settled = true;
        if (killTimer) clearTimeout(killTimer);
        opts.signal?.removeEventListener("abort", abort);
        resolve(v);
      };
      const abort = () => {
        aborted = true;
        proc?.kill("SIGTERM");
        killTimer = setTimeout(() => proc?.kill("SIGKILL"), 5000);
      };
      const line = (raw: string) => {
        if (!raw.trim()) return;
        try {
          const ev = JSON.parse(raw);
          opts.onEvent?.(ev);
          col.feed(ev);
        } catch {
          /* non-JSON noise */
        }
      };
      try {
        proc = spawn(prep.command, prep.args, { cwd: opts.cwd, shell: false, stdio: ["ignore", "pipe", "pipe"], env: prep.env });
      } catch (e) {
        return done({ code: null, spawnError: e instanceof Error ? e : new Error(String(e)) });
      }
      proc.stdout?.on("data", (d) => {
        buffer += d.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const l of lines) line(l);
      });
      proc.stderr?.on("data", (d) => {
        stderr += d.toString();
        opts.onStderr?.(d.toString());
      });
      proc.on("error", (e) => done({ code: null, spawnError: e }));
      proc.on("close", (code) => {
        if (buffer.trim()) line(buffer);
        done({ code });
      });
      if (opts.signal) {
        if (opts.signal.aborted) abort();
        else opts.signal.addEventListener("abort", abort, { once: true });
      }
    });

    const result: WorkerResult = { ...base, exitCode: outcome.code, output: col.lastText, usage: col.usage };
    if (aborted) return { ...result, status: "aborted", error: "aborted" };
    if (outcome.spawnError) return { ...result, error: `spawn failed: ${outcome.spawnError.message}` };
    if (col.lastError) return { ...result, error: col.lastError };
    if (outcome.code !== 0) return { ...result, error: tail(stderr.trim(), 600) || `exit code ${outcome.code}` };
    if (!col.lastText.trim()) return { ...result, error: "worker produced no output" };
    return { ...result, status: "ok" };
  } finally {
    await prep.cleanup();
  }
}

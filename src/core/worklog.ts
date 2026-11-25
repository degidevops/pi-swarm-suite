/**
 * Per-worker live log: a human-readable, append-only text file that can be followed with
 * `tail -F` (this is what the tmux windows show) and read back with `/swarm open <label>`.
 *
 * Layout: <cwd>/.pi/swarm/workers/<runId>/<label>.log  (+ <label>.log.done when the worker ended)
 *         <cwd>/.pi/swarm/workers/status.txt           (snapshot used by the tmux monitor window)
 *
 * Logging is strictly best-effort: it must never break or slow down a run.
 */
import * as fs from "node:fs";
import * as path from "node:path";

const MAX_BYTES = 4 * 1024 * 1024;

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null;
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

export function workersDir(cwd: string): string {
  return path.join(cwd, ".pi", "swarm", "workers");
}

export function statusFile(cwd: string): string {
  return path.join(workersDir(cwd), "status.txt");
}

/** Turn an arbitrary worker label (may contain `/`, `#`, spaces) into a safe file/window name. */
export function safeFileName(label: string): string {
  const s = label.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^[._]+/, "").slice(0, 80);
  return s || "worker";
}

export function newRunId(now = new Date()): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
}

const oneLine = (s: string, max: number): string => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
};

function resultText(result: unknown): string {
  if (!isObj(result) || !Array.isArray(result.content)) return "";
  return result.content
    .map((c) => (isObj(c) && c.type === "text" && typeof c.text === "string" ? c.text : ""))
    .join("")
    .trim();
}

function lastLine(s: string): string {
  const lines = s.split("\n").map((l) => l.trim()).filter(Boolean);
  return lines[lines.length - 1] ?? "";
}

export class WorkLog {
  readonly path: string;
  readonly doneFile: string;
  private bytes = 0;
  private textBuf = "";
  private capNoted = false;
  private closed = false;
  private lastToolUpdate = 0;
  private turns = 0;

  constructor(dir: string, label: string, private readonly now: () => number = Date.now) {
    const base = safeFileName(label);
    this.path = path.join(dir, `${base}.log`);
    this.doneFile = `${this.path}.done`;
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.rmSync(this.doneFile, { force: true });
      fs.writeFileSync(this.path, "");
    } catch {
      /* best-effort */
    }
    this.line(`▸ worker ${label} started`);
  }

  private stamp(): string {
    const d = new Date(this.now());
    const p = (n: number) => String(n).padStart(2, "0");
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }

  /** Write one timestamped line. `force` bypasses the size cap (used for monitor/lifecycle notes). */
  private line(text: string, force = false): void {
    if (this.closed && !force) return;
    if (this.bytes > MAX_BYTES && !force) {
      if (!this.capNoted) {
        this.capNoted = true;
        this.raw(`${this.stamp()} [log capped at ${MAX_BYTES / 1024 / 1024} MB — further output omitted]\n`);
      }
      return;
    }
    if (this.bytes > MAX_BYTES * 2) return;
    this.raw(`${this.stamp()} ${text}\n`);
  }

  private raw(s: string): void {
    try {
      fs.appendFileSync(this.path, s);
      this.bytes += Buffer.byteLength(s);
    } catch {
      /* best-effort */
    }
  }

  private flushText(): void {
    if (!this.textBuf.trim()) {
      this.textBuf = "";
      return;
    }
    for (const l of this.textBuf.split("\n")) if (l.trim()) this.line(`  ${l}`);
    this.textBuf = "";
  }

  /** A note from the monitor/watchdog ("[monitor] …"). Always written. */
  note(text: string): void {
    this.flushText();
    this.line(`[monitor] ${text}`, true);
  }

  /** Raw stderr chunk from the child (diagnostics). */
  stderr(chunk: string): void {
    for (const l of chunk.split("\n")) if (l.trim()) this.line(`! ${oneLine(l, 300)}`);
  }

  /** Render one pi JSON/RPC event. Streaming text deltas are buffered into whole lines. */
  event(ev: unknown): void {
    if (!isObj(ev) || this.closed) return;
    const type = str(ev.type);
    switch (type) {
      case "message_start": {
        const m = ev.message;
        if (isObj(m) && m.role === "user") {
          const c = typeof m.content === "string" ? m.content : Array.isArray(m.content) ? resultText({ content: m.content }) : "";
          if (c) this.line(`▸ prompt: ${oneLine(c, 400)}`);
        }
        break;
      }
      case "message_update": {
        const a = ev.assistantMessageEvent;
        if (!isObj(a)) break;
        const t = str(a.type);
        if (t === "text_delta" && typeof a.delta === "string") {
          this.textBuf += a.delta;
          const i = this.textBuf.lastIndexOf("\n");
          if (i >= 0) {
            const complete = this.textBuf.slice(0, i);
            this.textBuf = this.textBuf.slice(i + 1);
            for (const l of complete.split("\n")) if (l.trim()) this.line(`  ${l}`);
          }
        } else if (t === "text_end") this.flushText();
        else if (t === "thinking_start") this.line("… thinking");
        else if (t === "thinking_end") this.line(`… thinking done (${typeof a.content === "string" ? a.content.length : "?"} chars)`);
        else if (t === "toolcall_start") this.line(`⌁ preparing tool call: ${str(a.toolName) ?? "?"}`);
        break;
      }
      case "message_end": {
        this.flushText();
        const m = ev.message;
        if (!isObj(m) || m.role !== "assistant") break;
        this.turns += 1;
        if (m.stopReason === "error" && typeof m.errorMessage === "string") this.line(`✗ model error: ${oneLine(m.errorMessage, 400)}`);
        const u = isObj(m.usage) ? m.usage : undefined;
        if (u) {
          const cost = isObj(u.cost) && typeof u.cost.total === "number" ? u.cost.total : 0;
          this.line(`· turn ${this.turns} done (↑${u.input ?? 0} ↓${u.output ?? 0} $${cost.toFixed(4)})`);
        }
        break;
      }
      case "tool_execution_start":
        this.flushText();
        this.line(`▶ ${str(ev.toolName) ?? "tool"} ${oneLine(JSON.stringify(ev.args ?? {}), 200)}`);
        break;
      case "tool_execution_update": {
        const t = this.now();
        if (t - this.lastToolUpdate < 3000) break; // throttle chatty tools
        this.lastToolUpdate = t;
        const l = lastLine(resultText(ev.partialResult));
        if (l) this.line(`  … ${oneLine(l, 160)}`);
        break;
      }
      case "tool_execution_end": {
        const err = ev.isError === true;
        const dur = typeof ev.durationMs === "number" ? ` ${(ev.durationMs / 1000).toFixed(1)}s` : "";
        const txt = resultText(ev.result);
        this.line(`■ ${str(ev.toolName) ?? "tool"} ${err ? "ERROR" : "ok"}${dur}${err && txt ? `: ${oneLine(txt, 300)}` : ""}`);
        break;
      }
      case "auto_retry_start":
        this.line(`↻ retry ${ev.attempt}/${ev.maxAttempts} in ${ev.delayMs}ms: ${oneLine(str(ev.errorMessage) ?? "", 200)}`);
        break;
      case "auto_retry_end":
        this.line(ev.success ? "↻ retry succeeded" : `↻ retries exhausted: ${oneLine(str(ev.finalError) ?? "", 200)}`);
        break;
      case "compaction_start":
        this.line(`⇣ compacting context (${str(ev.reason) ?? "?"})`);
        break;
      case "compaction_end":
        this.line(ev.aborted ? "⇣ compaction aborted" : ev.errorMessage ? `⇣ compaction failed: ${oneLine(String(ev.errorMessage), 200)}` : "⇣ compaction done");
        break;
      case "agent_settled":
        this.flushText();
        this.line(`✔ agent settled${ev.aborted ? " (aborted)" : ""}`);
        break;
      default:
        break;
    }
  }

  /** Mark the worker finished (the tmux viewer waits for this marker). */
  close(status: string, detail?: string): void {
    if (this.closed) return;
    this.flushText();
    this.line(`■ worker finished: ${status}${detail ? ` — ${oneLine(detail, 300)}` : ""}`, true);
    this.closed = true;
    try {
      fs.writeFileSync(this.doneFile, `${status}\n`);
    } catch {
      /* best-effort */
    }
  }
}

/** Last `n` lines of a log file (empty array when missing). Reads at most the final 256 KB. */
export function tailLog(file: string, n = 30): string[] {
  try {
    const st = fs.statSync(file);
    const len = Math.min(st.size, 256 * 1024);
    const fd = fs.openSync(file, "r");
    try {
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, st.size - len);
      return buf.toString("utf-8").split("\n").filter(Boolean).slice(-n);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return [];
  }
}

/** Keep the newest `keep` run directories under .pi/swarm/workers/ (never the current one). Best-effort. */
export function pruneOldRuns(cwd: string, currentRunId: string, keep = 20): void {
  try {
    const dir = workersDir(cwd);
    if (!fs.existsSync(dir)) return;
    const runs = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name !== currentRunId)
      .map((e) => e.name)
      .sort(); // runIds sort chronologically
    for (const name of runs.slice(0, Math.max(0, runs.length - (keep - 1)))) fs.rmSync(path.join(dir, name), { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

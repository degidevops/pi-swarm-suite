/**
 * Worker activity monitor.
 *
 * A worker that has been silent for a while is ambiguous: it may be waiting on a slow
 * model, running a long tool, or hung. `ActivityTracker` turns pi's JSON/RPC event stream
 * into a small state machine (what is the worker doing right now, and since when), and
 * `assess()` turns that into a verdict (active / quiet / stalled) with a human reason.
 *
 * Everything here is pure (the clock is injected) so it is cheap to unit-test.
 *
 * Event names follow pi's docs/json.md: agent_start, turn_start, message_start/update/end,
 * tool_execution_start/update/end, auto_retry_start/end, compaction_start/end, agent_settled.
 */

export type Phase = "starting" | "waiting" | "thinking" | "writing" | "tool" | "retrying" | "compacting" | "idle";
export type Health = "active" | "quiet" | "stalled";

export interface MonitorConfig {
  /** Seconds without any event before the worker is flagged "quiet". 0 disables. */
  idleWarnSec: number;
  /** Seconds without any event before the worker is killed as stalled. 0 disables killing. */
  idleKillSec: number;
  /** Silent phases (running tool, waiting for the model, retry back-off, compaction) get thresholds multiplied by this. */
  slowPhaseFactor: number;
  /** Hard wall-clock cap per worker in seconds. 0 = no cap. */
  maxWorkerSec: number;
  /** Ask responsive RPC workers for `get_state` when they go quiet, to tell "hung" from "just slow". */
  probe: boolean;
  /** Send an automatic status nudge (steer) to a quiet RPC worker that is idle between calls. Best effort. */
  nudge: boolean;
  /** Watchdog tick in milliseconds. */
  tickMs: number;
}

export const DEFAULT_MONITOR: MonitorConfig = {
  idleWarnSec: 60,
  idleKillSec: 300,
  slowPhaseFactor: 3,
  maxWorkerSec: 0,
  probe: true,
  nudge: false,
  tickMs: 5000,
};

/** Phases in which silence is normal for longer (no streaming deltas are expected). */
const SLOW_PHASES: ReadonlySet<Phase> = new Set(["tool", "waiting", "retrying", "compacting"]);

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null;
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

export interface ActivitySnapshot {
  phase: Phase;
  /** Name of the tool currently running (the oldest one if several run in parallel). */
  tool?: string;
  /** How long that tool has been running, ms. */
  toolMs?: number;
  /** Number of tools currently running. */
  toolsRunning: number;
  events: number;
  lastEventType?: string;
  lastActivityAt: number;
  idleMs: number;
  totalMs: number;
  toolCalls: number;
  retry?: { attempt: number; maxAttempts: number; error?: string };
}

export class ActivityTracker {
  readonly startedAt: number;
  lastActivityAt: number;
  phase: Phase = "starting";
  events = 0;
  toolCalls = 0;
  lastEventType?: string;
  retry?: { attempt: number; maxAttempts: number; error?: string };
  private pending = new Map<string, { name: string; startedAt: number }>();

  constructor(now = Date.now()) {
    this.startedAt = now;
    this.lastActivityAt = now;
  }

  /**
   * Feed one parsed event from the child. Do NOT feed RPC `response` records: a reply to our own
   * `get_state` probe must not make a hung worker look active.
   */
  feed(ev: unknown, now = Date.now()): void {
    if (!isObj(ev)) return;
    const type = str(ev.type);
    if (!type || type === "response") return;
    this.events += 1;
    this.lastEventType = type;
    this.lastActivityAt = now;

    switch (type) {
      case "agent_start":
      case "turn_start":
        this.phase = this.pending.size ? "tool" : "waiting";
        break;
      case "message_start": {
        const role = isObj(ev.message) ? str(ev.message.role) : undefined;
        if (role === "assistant") this.phase = "waiting";
        break;
      }
      case "message_update": {
        const t = isObj(ev.assistantMessageEvent) ? str(ev.assistantMessageEvent.type) : undefined;
        if (t?.startsWith("thinking")) this.phase = "thinking";
        else if (t?.startsWith("text") || t?.startsWith("toolcall")) this.phase = "writing";
        else this.phase = "waiting";
        break;
      }
      case "message_end":
        this.phase = this.pending.size ? "tool" : "waiting";
        break;
      case "tool_execution_start": {
        const id = str(ev.toolCallId) ?? `anon-${this.events}`;
        this.pending.set(id, { name: str(ev.toolName) ?? "tool", startedAt: now });
        this.toolCalls += 1;
        this.phase = "tool";
        break;
      }
      case "tool_execution_update":
        this.phase = "tool";
        break;
      case "tool_execution_end": {
        const id = str(ev.toolCallId);
        if (id) this.pending.delete(id);
        else this.pending.clear();
        this.phase = this.pending.size ? "tool" : "waiting";
        break;
      }
      case "auto_retry_start":
        this.phase = "retrying";
        this.retry = {
          attempt: typeof ev.attempt === "number" ? ev.attempt : 0,
          maxAttempts: typeof ev.maxAttempts === "number" ? ev.maxAttempts : 0,
          error: str(ev.errorMessage),
        };
        break;
      case "auto_retry_end":
        this.retry = undefined;
        this.phase = "waiting";
        break;
      case "compaction_start":
      case "summarization_retry_scheduled":
        this.phase = "compacting";
        break;
      case "compaction_end":
      case "summarization_retry_finished":
        this.phase = "waiting";
        break;
      case "agent_settled":
        this.phase = "idle";
        this.pending.clear();
        break;
      default:
        break; // other events (queue_update, extension_ui_request, ...) still count as proof of life
    }
  }

  snapshot(now = Date.now()): ActivitySnapshot {
    let oldest: { name: string; startedAt: number } | undefined;
    for (const t of this.pending.values()) if (!oldest || t.startedAt < oldest.startedAt) oldest = t;
    return {
      phase: this.phase,
      tool: oldest?.name,
      toolMs: oldest ? now - oldest.startedAt : undefined,
      toolsRunning: this.pending.size,
      events: this.events,
      lastEventType: this.lastEventType,
      lastActivityAt: this.lastActivityAt,
      idleMs: Math.max(0, now - this.lastActivityAt),
      totalMs: Math.max(0, now - this.startedAt),
      toolCalls: this.toolCalls,
      retry: this.retry,
    };
  }
}

export interface Assessment {
  health: Health;
  idleMs: number;
  /** Effective thresholds for the current phase, ms (0 = disabled). */
  warnMs: number;
  killMs: number;
  /** Why the verdict is quiet/stalled (empty when active). */
  reason: string;
  /** True when the verdict is a wall-clock overrun rather than silence. */
  overtime: boolean;
}

export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

/** Short description of what the worker is doing right now, e.g. `tool:bash 45s`, `thinking`, `waiting for model`. */
export function describePhase(s: ActivitySnapshot): string {
  switch (s.phase) {
    case "tool":
      return `tool:${s.tool ?? "?"}${s.toolsRunning > 1 ? `+${s.toolsRunning - 1}` : ""}${s.toolMs !== undefined ? ` ${formatDuration(s.toolMs)}` : ""}`;
    case "waiting":
      return "waiting for model";
    case "retrying":
      return s.retry ? `retry ${s.retry.attempt}/${s.retry.maxAttempts}` : "retrying";
    case "compacting":
      return "compacting context";
    case "thinking":
    case "writing":
    case "starting":
    case "idle":
      return s.phase;
  }
}

export function assess(snap: ActivitySnapshot, cfg: MonitorConfig): Assessment {
  const factor = SLOW_PHASES.has(snap.phase) ? Math.max(1, cfg.slowPhaseFactor) : 1;
  const warnMs = cfg.idleWarnSec > 0 ? cfg.idleWarnSec * 1000 * factor : 0;
  const killMs = cfg.idleKillSec > 0 ? cfg.idleKillSec * 1000 * factor : 0;
  const base = { idleMs: snap.idleMs, warnMs, killMs };

  if (cfg.maxWorkerSec > 0 && snap.totalMs >= cfg.maxWorkerSec * 1000) {
    return { ...base, health: "stalled", overtime: true, reason: `exceeded max runtime ${formatDuration(cfg.maxWorkerSec * 1000)} (${describePhase(snap)})` };
  }
  // A finished agent run is not stalled: it is about to exit or receive the next prompt.
  if (snap.phase === "idle") return { ...base, health: "active", overtime: false, reason: "" };

  const silent = `no events for ${formatDuration(snap.idleMs)} while ${describePhase(snap)}`;
  if (killMs > 0 && snap.idleMs >= killMs) return { ...base, health: "stalled", overtime: false, reason: silent };
  if (warnMs > 0 && snap.idleMs >= warnMs) return { ...base, health: "quiet", overtime: false, reason: silent };
  return { ...base, health: "active", overtime: false, reason: "" };
}

/** Result of asking an RPC worker for `get_state`. */
export interface ProbeResult {
  /** The child answered within the timeout (its event loop is alive). */
  responsive: boolean;
  isStreaming?: boolean;
  isCompacting?: boolean;
  pendingMessageCount?: number;
  at?: number;
}

/** One-line interpretation of a probe, used in the log and `/swarm monitor`. */
export function describeProbe(p: ProbeResult): string {
  if (!p.responsive) return "process did not answer get_state (likely hung)";
  if (p.isCompacting) return "responsive, compacting context";
  if (p.isStreaming) return "responsive, model response in progress";
  return "responsive, not streaming (blocked in a tool or between calls)";
}

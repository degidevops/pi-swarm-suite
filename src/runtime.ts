import { type AgentDef, type SwarmConfig, type Tier, type Usage, type WorkerResult } from "./types.ts";
import { Ledger } from "./core/ledger.ts";
import { runWorkerProcess } from "./core/worker.ts";
import { RpcWorker } from "./core/rpc.ts";
import { MATE_ENV, TEAM_DIR_ENV } from "./core/child.ts";
import {
  writeTeamRunning, removeTeamRunning,
  writeWorkerState, removeWorkerState,
  writeJobState, removeJobState,
  listRunningTeams, readTeamRunning, readTeamWorkers, readTeamJobs,
  pollSteerCommands, writeSteerCommand,
  type WorkerAttachInfo, type JobAttachInfo,
} from "./core/attach.ts";
import { firstLine, formatTokens, formatUsd } from "./core/util.ts";
import * as path from "node:path";
import {
  ActivityTracker, DEFAULT_MONITOR, assess, describePhase, describeProbe, formatDuration,
  type Health, type MonitorConfig, type ProbeResult,
} from "./core/monitor.ts";
import { WorkLog, newRunId, pruneOldRuns, statusFile, tailLog, workersDir } from "./core/worklog.ts";
import { TmuxManager } from "./core/tmux.ts";
import * as fs from "node:fs";

/** Tools the messaging extension adds inside team children; they must survive a `--tools` allowlist. */
export const CHILD_TOOL_NAMES = ["team_message", "team_inbox", "team_tasks", "team_task_request"];
const READ_ONLY = new Set(["read", "grep", "find", "ls"]);

/** Read-only agents are routed to the cheap model tier automatically. */
export function pickTier(tools: string[] | undefined): Tier {
  return tools?.length && tools.every((t) => READ_ONLY.has(t)) ? "cheap" : "worker";
}

export interface WorkerInfo {
  id: number;
  label: string;
  status: "running" | "ok" | "failed" | "aborted";
  startedAt: number;
  endedAt?: number;
  last: string;
  steerable: boolean;
  /** Session directory for workers that persist across sessions (ROADMAP #3). */
  sessionDir?: string;
  /** Team name this worker belongs to (for cross-process attach, ROADMAP #7). */
  team?: string;
  /** Working directory of the worker (its git worktree for team tasks). */
  cwd?: string;
  /** Live activity state machine fed by the child's event stream. */
  tracker: ActivityTracker;
  /** Monitor verdict: active, quiet (silent longer than idleWarnSec) or stalled (about to be / was killed). */
  health: Health;
  /** Path of the worker's live log (follow it with `tail -F`). */
  logPath?: string;
  /** tmux window showing this worker, when the tmux integration is on. */
  tmuxWindow?: string;
  /** Last `get_state` probe (RPC workers only). */
  probe?: ProbeResult;
  /** Why the worker was killed (watchdog or user), if it was. */
  stalledReason?: string;
  killedBy?: "watchdog" | "user";
}

export interface RunOptions {
  label: string;
  task: string;
  agent?: AgentDef;
  model?: string;
  cwd?: string;
  signal?: AbortSignal;
  thinking?: string;
  tier?: Tier;
  /** Override the agent's tool allowlist (e.g. read-only planning pass). */
  tools?: string[];
  /** Run over RPC so the worker can be steered while it works. */
  steerable?: boolean;
  /** Team context: enables the teammate messaging tools inside the child. */
  team?: { dir: string; mate: string };
  /** Team name this worker belongs to (for cross-process attach, ROADMAP #7). */
  teamName?: string;
  /** When set, the worker pi persists its session under this directory (ROADMAP #3). */
  sessionDir?: string;
}

export interface Job {
  id: string;
  kind: string;
  name: string;
  status: "running" | "done" | "failed" | "stopped";
  startedAt: number;
  endedAt?: number;
  result?: string;
  controller: AbortController;
}

/**
 * The one shared runtime. Every mode (delegate / team / workflow) launches workers
 * through here so concurrency, budget, cost accounting, tier routing, steering,
 * cancellation, background jobs and the live widget behave identically and cannot conflict.
 */
export class Runtime {
  readonly ledger: Ledger;
  readonly workers = new Map<number, WorkerInfo>();
  readonly jobs = new Map<string, Job>();
  agents = new Map<string, AgentDef>();
  /** Extension file team children load so they get the messaging tools. */
  extPath?: string;
  /** Model of the parent session ("provider/id"); workers fall back to it when nothing else is configured. */
  sessionModel?: string;
  onChange: () => void = () => undefined;
  onJobDone: (job: Job) => void = () => undefined;
  /** Fired when a worker goes quiet, is killed as stalled, or recovers. The extension forwards it to the user and the lead agent. */
  onAlert: (a: { kind: "quiet" | "stalled" | "recovered"; label: string; text: string }) => void = () => undefined;
  private shutdown = new AbortController();
  private live = new Map<string, RpcWorker>();
  private nextId = 1;
  private nextJob = 1;
  private steerPollTimer: ReturnType<typeof setInterval> | undefined;
  private readonly controllers = new Map<number, AbortController>();
  private statusTimer: ReturnType<typeof setTimeout> | undefined;
  /** Identifies this runtime's log directory: .pi/swarm/workers/<runId>/ */
  readonly runId = newRunId();
  readonly tmux: TmuxManager;
  private prunedLogs = false;

  constructor(
    public readonly cwd: string,
    public config: SwarmConfig,
    public readonly projectTrusted: boolean,
    public readonly depth: number,
  ) {
    this.ledger = new Ledger(config.budgetUsd);
    this.tmux = new TmuxManager(cwd, config.tmux ?? { enabled: false });
  }

  /** Effective monitor settings (defaults + swarm.json overrides). */
  monitorConfig(): MonitorConfig {
    return { ...DEFAULT_MONITOR, ...(this.config.monitor ?? {}) };
  }

  /** onChange + a throttled status snapshot for the tmux monitor window. */
  private emitChange(): void {
    this.onChange();
    if (!this.tmux.enabled || this.statusTimer) return;
    this.statusTimer = setTimeout(() => {
      this.statusTimer = undefined;
      try {
        fs.mkdirSync(workersDir(this.cwd), { recursive: true });
        const lines = this.statusLines();
        fs.writeFileSync(statusFile(this.cwd), `${lines.join("\n")}\n\n(updated ${new Date().toLocaleTimeString()} · attach: ${this.tmux.attachCommand()})\n`);
      } catch {
        /* best-effort */
      }
    }, 1000);
    this.statusTimer.unref?.();
  }

  get signal(): AbortSignal {
    return this.shutdown.signal;
  }

  /** Abort every running worker and job. A fresh controller is installed so later runs still work. */
  abortAll(_reason: string): void {
    this.shutdown.abort();
    this.shutdown = new AbortController();
    for (const j of this.jobs.values()) if (j.status === "running") j.controller.abort();
    this.onChange();
  }

  resolveAgent(name: string | undefined): AgentDef | undefined {
    if (!name) return undefined;
    const a = this.agents.get(name);
    if (!a) {
      const names = [...this.agents.keys()].join(", ") || "(none found)";
      throw new Error(
        `Unknown agent "${name}". Available agents: ${names}. ` +
          `Built-ins (reviewer, researcher, planner, oracle, worker) always work; add .md files to ~/.pi/agent/agents or .pi/agents for custom ones.`,
      );
    }
    return a;
  }

  /** Send a new instruction to a running steerable worker. Returns false if it is not running. */
  steer(label: string, text: string): boolean {
    return this.live.get(label)?.steer(text) ?? false;
  }

  steerableLabels(): string[] {
    return [...this.live.keys()];
  }

  async run(opts: RunOptions): Promise<WorkerResult> {
    const cwd = opts.cwd ?? this.cwd;
    if (this.ledger.exceeded()) {
      return {
        label: opts.label,
        status: "failed",
        output: "",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
        exitCode: null,
        cwd,
        error: `budget exceeded (${formatUsd(this.ledger.snapshot().cost)} of ${formatUsd(this.ledger.budgetUsd ?? 0)}); raise budgetUsd or run /swarm reset-cost`,
      };
    }
    const info: WorkerInfo = {
      id: this.nextId++,
      label: opts.label,
      status: "running",
      startedAt: Date.now(),
      last: "starting…",
      steerable: !!opts.steerable,
      sessionDir: opts.sessionDir,
      team: opts.teamName,
      tracker: new ActivityTracker(),
      health: "active",
      cwd,
    };
    this.workers.set(info.id, info);

    // Live log (+ optional tmux window) so the worker can be inspected while it runs.
    if (!this.prunedLogs) {
      this.prunedLogs = true;
      pruneOldRuns(this.cwd, this.runId);
    }
    const log = new WorkLog(path.join(workersDir(this.cwd), this.runId), opts.label);
    info.logPath = log.path;
    if (this.tmux.enabled) info.tmuxWindow = this.tmux.openWorker(opts.label, log.path, log.doneFile, cwd);
    this.persistWorker(info);
    this.emitChange();

    const ctl = new AbortController();
    this.controllers.set(info.id, ctl);
    const signals = [this.signal, opts.signal, ctl.signal].filter((s): s is AbortSignal => s !== undefined);
    const signal = signals.length === 1 ? (signals[0] as AbortSignal) : AbortSignal.any(signals);

    const baseTools = opts.tools ?? opts.agent?.tools ?? this.config.workerTools;
    const tier = opts.tier ?? opts.agent?.tier ?? pickTier(baseTools);
    const model = opts.model ?? opts.agent?.model ?? this.config.models[tier] ?? this.config.models.worker ?? this.sessionModel;
    const tools = baseTools && opts.team ? [...new Set([...baseTools, ...CHILD_TOOL_NAMES])] : baseTools;

    const wopts = {
      label: opts.label,
      task: opts.task,
      cwd,
      systemPrompt: opts.agent?.systemPrompt,
      model,
      thinking: opts.thinking,
      tools,
      signal,
      depth: this.depth,
      extPath: opts.team ? this.extPath : undefined,
      env: opts.team ? { [TEAM_DIR_ENV]: opts.team.dir, [MATE_ENV]: opts.team.mate } : undefined,
      onUsage: (d: Partial<Usage>) => {
        this.ledger.add(d);
        if (this.ledger.exceeded()) this.abortAll("budget");
        this.emitChange();
      },
      onProgress: (line: string) => {
        if (line) info.last = firstLine(line, 60);
        this.emitChange();
      },
      onEvent: (ev: unknown) => {
        const before = info.tracker.phase;
        info.tracker.feed(ev);
        log.event(ev);
        if (info.health !== "active") {
          // Any sign of life clears a quiet flag immediately (the watchdog tick would take up to tickMs).
          info.health = "active";
          log.note("worker is active again");
          this.persistWorker(info);
          this.emitChange();
        } else if (info.tracker.phase !== before) this.emitChange();
      },
      onStderr: (chunk: string) => log.stderr(chunk),
      sessionDir: opts.sessionDir,
    };

    this.ensureSteerPolling();
    const watchdog = this.startWatchdog(info, ctl, log, opts.label);

    try {
      let res: WorkerResult;
      if (opts.steerable) {
        const w = await RpcWorker.start(wopts);
        this.live.set(opts.label, w);
        try {
          res = await w.result;
        } finally {
          this.live.delete(opts.label);
        }
      } else {
        res = await runWorkerProcess(wopts);
      }
      // A worker we killed (stall watchdog or /swarm kill) is a FAILURE, not an abort: team mode retries
      // failures with the reason injected, while an abort just parks the task as pending.
      if (info.killedBy && res.status === "aborted") {
        res = { ...res, status: "failed", error: `${info.killedBy === "watchdog" ? "stalled" : "killed"}: ${info.stalledReason ?? "no reason"}` };
      }
      info.status = res.status;
      return res;
    } finally {
      clearInterval(watchdog);
      this.controllers.delete(info.id);
      if (info.status === "running") info.status = "failed";
      info.endedAt = Date.now();
      log.close(info.status, info.stalledReason);
      this.persistWorker(info);
      this.prune();
      this.emitChange();
    }
  }

  private alert(kind: "quiet" | "stalled" | "recovered", label: string, text: string): void {
    try {
      this.onAlert({ kind, label, text });
    } catch {
      /* alert delivery must never break a run */
    }
  }

  /** Persist a worker's state for cross-process attach (team workers only). */
  private persistWorker(info: WorkerInfo): void {
    if (!info.team) return;
    const snap = info.tracker.snapshot();
    writeWorkerState(this.cwd, info.team, {
      label: info.label, status: info.status, startedAt: info.startedAt, endedAt: info.endedAt, last: info.last, steerable: info.steerable,
      sessionDir: info.sessionDir,
      health: info.status === "running" ? info.health : undefined,
      phase: info.status === "running" ? describePhase(snap) : undefined,
      lastActivityAt: snap.lastActivityAt,
      logPath: info.logPath,
    });
  }

  /**
   * Per-worker watchdog. Every tick it judges the worker from its event stream: quiet after idleWarnSec,
   * stalled after idleKillSec (phase-aware: long tools and slow model calls get more slack). For RPC workers
   * it additionally asks `get_state`, which separates "process hung" from "model/tool just slow".
   */
  private startWatchdog(info: WorkerInfo, ctl: AbortController, log: WorkLog, label: string): ReturnType<typeof setInterval> {
    const cfg = this.monitorConfig();
    let ticking = false;
    let lastProbeAt = 0;
    let nudged = false;

    const tick = async (): Promise<void> => {
      if (ticking || info.status !== "running" || info.killedBy) return;
      ticking = true;
      try {
        let a = assess(info.tracker.snapshot(), cfg);
        if (a.health !== info.health) {
          info.health = a.health;
          if (a.health === "quiet") {
            log.note(`quiet: ${a.reason} (kill at ${a.killMs ? formatDuration(a.killMs) : "never"})`);
            this.alert("quiet", label, `${label} looks quiet: ${a.reason}. Not killed yet (kill at ${a.killMs ? formatDuration(a.killMs) : "never"}). Inspect: /swarm open ${label}`);
          } else if (a.health === "active") {
            log.note("worker is active again");
            this.alert("recovered", label, `${label} is active again.`);
          }
          this.persistWorker(info);
          this.emitChange();
        }
        if (a.health === "active") {
          nudged = false;
          return;
        }

        const rpc = this.live.get(label);
        if (cfg.probe && rpc && Date.now() - lastProbeAt > 30_000) {
          lastProbeAt = Date.now();
          const p = await rpc.probe();
          info.probe = p;
          log.note(`probe: ${describeProbe(p)}`);
          if (cfg.nudge && !nudged && p.responsive && !p.isStreaming && !p.isCompacting && info.tracker.phase !== "tool") {
            nudged = true;
            rpc.steer(`[swarm monitor] No activity from you for ${formatDuration(a.idleMs)}. If something is blocking you, say what; otherwise continue with the task.`);
            log.note("sent a status nudge (steer)");
          }
          a = assess(info.tracker.snapshot(), cfg); // events may have arrived while probing
        }

        if (a.health === "stalled" && info.status === "running" && !info.killedBy) {
          const probeNote = info.probe ? ` [${describeProbe(info.probe)}]` : "";
          info.killedBy = "watchdog";
          info.stalledReason = `${a.reason}${probeNote}`;
          info.health = "stalled";
          log.note(`✖ killing worker: ${info.stalledReason}`);
          this.alert("stalled", label, `${label} was stalled and has been stopped: ${info.stalledReason}. It will be reported as failed${info.team ? " and retried per maxAttempts" : ""}.`);
          this.persistWorker(info);
          this.emitChange();
          ctl.abort();
        }
      } finally {
        ticking = false;
      }
    };

    const timer = setInterval(() => void tick(), Math.max(20, cfg.tickMs));
    timer.unref?.();
    return timer;
  }

  /** Find a worker by exact label, else by unique substring; prefers running workers. */
  findWorker(query: string): WorkerInfo | undefined {
    const all = [...this.workers.values()].reverse(); // newest first
    const pick = (pred: (w: WorkerInfo) => boolean) => all.find((w) => w.status === "running" && pred(w)) ?? all.find(pred);
    return pick((w) => w.label === query) ?? pick((w) => w.label.includes(query));
  }

  /** Kill one running worker (reported as a failure so team mode retries it). */
  killWorker(label: string, reason = "killed by user"): boolean {
    const w = this.findWorker(label);
    if (!w || w.status !== "running") return false;
    const ctl = this.controllers.get(w.id);
    if (!ctl) return false;
    w.killedBy = "user";
    w.stalledReason = reason;
    ctl.abort();
    return true;
  }

  /** Human-readable inspection card for one worker (used by `/swarm open`). */
  inspect(label: string, lines = 25): string | undefined {
    const w = this.findWorker(label);
    if (!w) return undefined;
    const now = Date.now();
    const snap = w.tracker.snapshot(now);
    const cfg = this.monitorConfig();
    const a = assess(snap, cfg);
    const out: string[] = [];
    out.push(`${w.label} — ${w.status}${w.status === "running" ? ` · health: ${w.health}` : ""}`);
    out.push(`  running ${formatDuration((w.endedAt ?? now) - w.startedAt)} · ${snap.events} events · ${snap.toolCalls} tool calls${w.steerable ? " · steerable ⇄" : " · one-shot (not steerable)"}`);
    if (w.status === "running") {
      out.push(`  doing: ${describePhase(snap)} · last event ${formatDuration(snap.idleMs)} ago (${snap.lastEventType ?? "none yet"})`);
      out.push(`  watchdog: warn ${a.warnMs ? formatDuration(a.warnMs) : "off"} · kill ${a.killMs ? formatDuration(a.killMs) : "off"} (for this phase)`);
    }
    if (w.probe) out.push(`  last probe: ${describeProbe(w.probe)}${w.probe.at ? ` (${formatDuration(now - w.probe.at)} ago)` : ""}`);
    if (w.stalledReason) out.push(`  ${w.killedBy === "user" ? "killed" : "stalled"}: ${w.stalledReason}`);
    if (w.logPath) out.push(`  log: ${w.logPath}`, `  follow: tail -F '${w.logPath}'`);
    if (w.tmuxWindow) out.push(`  tmux: ${this.tmux.attachCommand()}  (window "${w.tmuxWindow}")`);
    if (w.cwd) out.push(`  cwd: ${w.cwd}`);
    if (w.status === "running") out.push(`  talk to it: /swarm say ${w.label} <text>${w.steerable ? "" : "   (not available for one-shot workers)"} · stop it: /swarm kill ${w.label}`);
    const t = w.logPath ? tailLog(w.logPath, lines) : [];
    out.push("", t.length ? `── last ${t.length} log lines ──` : "(log is empty)", ...t);
    return out.join("\n");
  }

  /** Table of every running worker's health, for `/swarm monitor`. */
  monitorLines(): string[] {
    const cfg = this.monitorConfig();
    const now = Date.now();
    const head = `monitor: warn ${cfg.idleWarnSec ? `${cfg.idleWarnSec}s` : "off"} · kill ${cfg.idleKillSec ? `${cfg.idleKillSec}s` : "off"} · slow-phase ×${cfg.slowPhaseFactor} · max ${cfg.maxWorkerSec ? `${cfg.maxWorkerSec}s` : "off"} · probe ${cfg.probe ? "on" : "off"} · nudge ${cfg.nudge ? "on" : "off"}`;
    const running = [...this.workers.values()].filter((w) => w.status === "running");
    if (!running.length) return [head, "no running workers"];
    const badge = { active: "●", quiet: "⚠", stalled: "✖" } as const;
    return [
      head,
      ...running.map((w) => {
        const s = w.tracker.snapshot(now);
        const probe = w.probe ? ` · probe: ${w.probe.responsive ? "responsive" : "NO ANSWER"}` : "";
        return `${badge[w.health]} ${w.label}${w.steerable ? " ⇄" : ""}  ${describePhase(s)} · idle ${formatDuration(s.idleMs)} · ${s.events} ev${probe}`;
      }),
    ];
  }

  /** Turn the tmux integration on/off at runtime. Returns a message for the user. */
  setTmux(enabled: boolean): { ok: boolean; message: string } {
    if (!enabled) {
      this.tmux.enabled = false;
      return { ok: true, message: "tmux windows off for new workers (existing session left as is; `/swarm tmux kill` removes it)." };
    }
    if (!this.tmux.available()) return { ok: false, message: "tmux was not found on PATH — install tmux to use this feature." };
    this.tmux.enabled = true;
    if (!this.tmux.ensureSession()) return { ok: false, message: "could not create the tmux session." };
    for (const w of this.workers.values()) {
      if (w.status === "running" && w.logPath && !w.tmuxWindow) {
        w.tmuxWindow = this.tmux.openWorker(w.label, w.logPath, `${w.logPath}.done`, this.cwd);
      }
    }
    this.emitChange();
    return { ok: true, message: `tmux on. Watch everything in another terminal:  ${this.tmux.attachCommand()}` };
  }

  /** Run `fn` in the background; the lead is notified through `onJobDone` when it settles. */
  startJob(kind: string, name: string, fn: (signal: AbortSignal) => Promise<string>, team?: string): Job {
    const job: Job = { id: `job-${this.nextJob++}`, kind, name, status: "running", startedAt: Date.now(), controller: new AbortController() };
    this.jobs.set(job.id, job);
    if (team) writeJobState(this.cwd, team, { id: job.id, kind, name, status: "running", startedAt: job.startedAt });
    void (async () => {
      try {
        job.result = await fn(job.controller.signal);
        job.status = job.controller.signal.aborted ? "stopped" : "done";
      } catch (e) {
        job.result = e instanceof Error ? e.message : String(e);
        job.status = job.controller.signal.aborted ? "stopped" : "failed";
      } finally {
        job.endedAt = Date.now();
        if (team) writeJobState(this.cwd, team, { id: job.id, kind, name, status: job.status, startedAt: job.startedAt, endedAt: job.endedAt, result: job.result });
        this.onChange();
        try {
          this.onJobDone(job);
        } catch {
          /* notification failures must not crash the process */
        }
      }
    })();
    return job;
  }

  stopJob(id: string): boolean {
    const j = this.jobs.get(id);
    if (!j || j.status !== "running") return false;
    j.controller.abort();
    return true;
  }

  runningJobs(): Job[] {
    return [...this.jobs.values()].filter((j) => j.status === "running");
  }

  /** Keep running workers plus the 4 most recently finished. */
  private prune(): void {
    const done = [...this.workers.values()].filter((w) => w.status !== "running").sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0));
    for (const w of done.slice(4)) this.workers.delete(w.id);
  }

  running(): number {
    return [...this.workers.values()].filter((w) => w.status === "running").length;
  }

  // ---- Cross-process attach (ROADMAP #7) ----

  /** Start polling for disk-based steer commands (lazy, idempotent). */
  private ensureSteerPolling(): void {
    if (this.steerPollTimer) return;
    this.steerPollTimer = setInterval(() => this.pollSteerCommands(), 1000);
    this.steerPollTimer.unref?.();
  }

  /** Check for pending steer commands for every running steerable worker and apply them. */
  pollSteerCommands(): void {
    for (const team of listRunningTeams(this.cwd)) {
      const runningInfo = readTeamRunning(this.cwd, team);
      if (!runningInfo) continue;
      for (const w of readTeamWorkers(this.cwd, team)) {
        if (!w.steerable || w.status !== "running") continue;
        const text = pollSteerCommands(this.cwd, team, w.label);
        if (text) this.steer(w.label, text);
      }
    }
  }

  /** List teams that currently have an active run (attachable from a second session). */
  listAttachableTeams(): string[] {
    return listRunningTeams(this.cwd);
  }

  /** Get a team's running info (undefined if not running). */
  getTeamRunning(team: string): { team: string; startedAt: number; mates: string[] } | undefined {
    const info = readTeamRunning(this.cwd, team);
    if (!info) return undefined;
    return { team: info.team, startedAt: info.startedAt, mates: info.mates };
  }

  /** Get all workers for a team (from disk). */
  getTeamWorkers(team: string): WorkerAttachInfo[] {
    return readTeamWorkers(this.cwd, team);
  }

  /** Get all jobs for a team (from disk). */
  getTeamJobs(team: string): JobAttachInfo[] {
    return readTeamJobs(this.cwd, team);
  }

  /** Queue a steer command for a worker on a team (cross-process). Returns false if the team is not running. */
  steerCrossProcess(team: string, label: string, text: string): boolean {
    if (!listRunningTeams(this.cwd).includes(team)) return false;
    writeSteerCommand(this.cwd, team, label, text);
    return true;
  }

  /** Per-agent cost breakdown (for `/swarm cost` and the widget). */
  agentCosts(): Record<string, number> {
    const byAgent = this.ledger.snapshotByAgent();
    const out: Record<string, number> = {};
    for (const [a, u] of Object.entries(byAgent)) out[a] = u.cost;
    return out;
  }

  /** Header lines shared by the live widget and `/swarm status`. */
  private headerLines(runningCount: number, jobCount: number): string[] {
    const u = this.ledger.snapshot();
    const budget = this.ledger.budgetUsd !== undefined ? ` / ${formatUsd(this.ledger.budgetUsd)}` : "";
    const jobTxt = jobCount ? ` · ${jobCount} bg job${jobCount > 1 ? "s" : ""}` : "";
    const lines = [`swarm  ${runningCount} running${jobTxt} · ${formatUsd(u.cost)}${budget} · ↑${formatTokens(u.input)} ↓${formatTokens(u.output)}`];
    const costs = this.agentCosts();
    if (Object.keys(costs).length > 1) {
      lines.push(`  by agent: ${Object.entries(costs).map(([a, c]) => `${a}=${formatUsd(c)}`).join("  ")}`);
    }
    return lines;
  }

  private workerRows(list: WorkerInfo[]): string[] {
    const icon = { running: "●", ok: "✓", failed: "✗", aborted: "◌" } as const;
    return list.map((w) => {
      const secs = Math.round(((w.endedAt ?? Date.now()) - w.startedAt) / 1000);
      return `${icon[w.status]} ${w.label}${w.steerable ? " ⇄" : ""} ${secs}s  ${w.last}`;
    });
  }

  /**
   * Lines for the single live widget: live activity only — running workers and
   * running background jobs. Finished workers are dropped immediately so the
   * widget collapses to nothing once the swarm settles; their outcome has
   * already reached the conversation through the delegate tool result, and the
   * recent history stays inspectable via `/swarm status` and `/swarm board`.
   */
  widgetLines(): string[] {
    const jobs = this.runningJobs();
    const running = [...this.workers.values()].filter((w) => w.status === "running");
    if (running.length === 0 && jobs.length === 0) return [];
    return [...this.headerLines(running.length, jobs.length), ...this.workerRows(running.slice(-8))];
  }

  /** Full status lines for the explicit `/swarm status` command: activity header plus the last workers, including recently finished ones. */
  statusLines(): string[] {
    const jobs = this.runningJobs();
    const all = [...this.workers.values()];
    const running = all.filter((w) => w.status === "running").length;
    return [...this.headerLines(running, jobs.length), ...this.workerRows(all.slice(-8))];
  }
}

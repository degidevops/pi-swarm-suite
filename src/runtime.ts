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
  private shutdown = new AbortController();
  private live = new Map<string, RpcWorker>();
  private nextId = 1;
  private nextJob = 1;
  private steerPollTimer: ReturnType<typeof setInterval> | undefined;

  constructor(
    public readonly cwd: string,
    public config: SwarmConfig,
    public readonly projectTrusted: boolean,
    public readonly depth: number,
  ) {
    this.ledger = new Ledger(config.budgetUsd);
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
    };
    this.workers.set(info.id, info);
    if (opts.teamName) writeWorkerState(this.cwd, opts.teamName, {
      label: info.label, status: info.status, startedAt: info.startedAt, last: info.last, steerable: info.steerable,
      sessionDir: info.sessionDir,
    });
    this.onChange();

    const signals = [this.signal, opts.signal].filter((s): s is AbortSignal => s !== undefined);
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
        this.onChange();
      },
      onProgress: (line: string) => {
        if (line) info.last = firstLine(line, 60);
        this.onChange();
      },
      sessionDir: opts.sessionDir,
    };

    this.ensureSteerPolling();

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
      info.status = res.status;
      return res;
    } finally {
      if (info.status === "running") info.status = "failed";
      info.endedAt = Date.now();
      if (info.team) writeWorkerState(this.cwd, info.team, {
        label: info.label, status: info.status, startedAt: info.startedAt, endedAt: info.endedAt, last: info.last, steerable: info.steerable,
        sessionDir: info.sessionDir,
      });
      this.prune();
      this.onChange();
    }
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

  /** Lines for the single live widget (empty array = hide). */
  widgetLines(): string[] {
    const jobs = this.runningJobs();
    if (this.workers.size === 0 && jobs.length === 0) return [];
    const u = this.ledger.snapshot();
    const budget = this.ledger.budgetUsd !== undefined ? ` / ${formatUsd(this.ledger.budgetUsd)}` : "";
    const jobTxt = jobs.length ? ` · ${jobs.length} bg job${jobs.length > 1 ? "s" : ""}` : "";
    const lines = [`swarm  ${this.running()} running${jobTxt} · ${formatUsd(u.cost)}${budget} · ↑${formatTokens(u.input)} ↓${formatTokens(u.output)}`];
    const costs = this.agentCosts();
    if (Object.keys(costs).length > 1) {
      lines.push(`  by agent: ${Object.entries(costs).map(([a, c]) => `${a}=${formatUsd(c)}`).join("  ")}`);
    }
    const icon = { running: "●", ok: "✓", failed: "✗", aborted: "◌" } as const;
    for (const w of [...this.workers.values()].slice(-8)) {
      const secs = Math.round(((w.endedAt ?? Date.now()) - w.startedAt) / 1000);
      lines.push(`${icon[w.status]} ${w.label}${w.steerable ? " ⇄" : ""} ${secs}s  ${w.last}`);
    }
    return lines;
  }
}

import type { MonitorConfig } from "./core/monitor.ts";
import type { TmuxConfig } from "./core/tmux.ts";

export type Tier = "lead" | "worker" | "cheap";

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  turns: number;
}

export const emptyUsage = (): Usage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 });

export function addUsage(a: Usage, b: Partial<Usage>): Usage {
  return {
    input: a.input + (b.input ?? 0),
    output: a.output + (b.output ?? 0),
    cacheRead: a.cacheRead + (b.cacheRead ?? 0),
    cacheWrite: a.cacheWrite + (b.cacheWrite ?? 0),
    cost: a.cost + (b.cost ?? 0),
    turns: a.turns + (b.turns ?? 0),
  };
}

export type WorkerStatus = "ok" | "failed" | "aborted";

export interface WorkerResult {
  label: string;
  status: WorkerStatus;
  output: string;
  usage: Usage;
  model?: string;
  error?: string;
  exitCode: number | null;
  cwd: string;
}

export interface AgentDef {
  name: string;
  description: string;
  tools?: string[];
  model?: string;
  systemPrompt: string;
  /** Model tier: lets config.models route this agent to a strong/mid/cheap model. */
  tier?: Tier;
  /** Where the definition came from. Built-ins ship with the package; user/project files override them. */
  source: "builtin" | "user" | "project";
  filePath: string;
}

export interface SwarmConfig {
  /** Max parallel child pi processes. Hard-capped at 16. */
  maxConcurrency: number;
  /** Stop launching/abort workers once total cost reaches this many USD. */
  budgetUsd?: number;
  /** Run each team task / opted-in delegate task in its own git worktree. */
  worktrees: boolean;
  /** Shell commands that must all exit 0 before a team task counts as done. */
  gates: string[];
  /** Shell commands run before each team task implementation (after planning). */
  preHooks?: string[];
  /** Shell commands run after a team task completes (before commit/review). */
  postHooks?: string[];
  /** Attempts per team task (1 = no retry after a failed gate). */
  maxAttempts: number;
  /** Optional model tiers: use "provider/model" strings accepted by `pi --model`. */
  models: { lead?: string; worker?: string; cheap?: string };
  /** Default tool allowlist for children when the agent definition has none. */
  workerTools?: string[];
  /** Agent name that independently reviews each team task's diff before it counts as done. */
  reviewer?: string;
  /** Worker activity monitor / stall watchdog. Missing keys fall back to DEFAULT_MONITOR. */
  monitor?: Partial<MonitorConfig>;
  /** Open one tmux window per worker (live log) plus a monitor window. Off by default. */
  tmux?: TmuxConfig;
}

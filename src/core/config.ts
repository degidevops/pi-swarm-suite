import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { SwarmConfig } from "../types.ts";

export const HARD_MAX_CONCURRENCY = 16;

export const DEFAULT_CONFIG: SwarmConfig = {
  maxConcurrency: 4,
  worktrees: true,
  gates: [],
  maxAttempts: 2,
  models: {},
};

/** Validate untrusted JSON into a partial config. Never throws; reports problems as warnings. */
export function parseConfig(raw: unknown): { config: Partial<SwarmConfig>; warnings: string[] } {
  const warnings: string[] = [];
  const config: Partial<SwarmConfig> = {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { config, warnings: ["config must be a JSON object"] };
  }
  const r = raw as Record<string, unknown>;

  if (r.maxConcurrency !== undefined) {
    if (typeof r.maxConcurrency === "number" && Number.isFinite(r.maxConcurrency) && r.maxConcurrency >= 1) {
      config.maxConcurrency = Math.min(Math.floor(r.maxConcurrency), HARD_MAX_CONCURRENCY);
    } else warnings.push("maxConcurrency must be a number >= 1");
  }
  if (r.budgetUsd !== undefined) {
    if (typeof r.budgetUsd === "number" && r.budgetUsd > 0) config.budgetUsd = r.budgetUsd;
    else warnings.push("budgetUsd must be a positive number");
  }
  if (r.worktrees !== undefined) {
    if (typeof r.worktrees === "boolean") config.worktrees = r.worktrees;
    else warnings.push("worktrees must be a boolean");
  }
  if (r.gates !== undefined) {
    if (Array.isArray(r.gates) && r.gates.every((g) => typeof g === "string" && g.trim())) config.gates = r.gates as string[];
    else warnings.push("gates must be an array of non-empty shell command strings");
  }
  if (r.preHooks !== undefined) {
    if (Array.isArray(r.preHooks) && r.preHooks.every((h) => typeof h === "string" && h.trim())) config.preHooks = r.preHooks as string[];
    else warnings.push("preHooks must be an array of non-empty shell command strings");
  }
  if (r.postHooks !== undefined) {
    if (Array.isArray(r.postHooks) && r.postHooks.every((h) => typeof h === "string" && h.trim())) config.postHooks = r.postHooks as string[];
    else warnings.push("postHooks must be an array of non-empty shell command strings");
  }
  if (r.maxAttempts !== undefined) {
    if (typeof r.maxAttempts === "number" && r.maxAttempts >= 1) config.maxAttempts = Math.min(Math.floor(r.maxAttempts), 5);
    else warnings.push("maxAttempts must be a number >= 1");
  }
  if (r.models !== undefined) {
    if (typeof r.models === "object" && r.models !== null && !Array.isArray(r.models)) {
      const m = r.models as Record<string, unknown>;
      const out: SwarmConfig["models"] = {};
      for (const k of ["lead", "worker", "cheap"] as const) {
        if (m[k] === undefined) continue;
        if (typeof m[k] === "string") out[k] = m[k] as string;
        else warnings.push(`models.${k} must be a string`);
      }
      config.models = out;
    } else warnings.push("models must be an object");
  }
  if (r.workerTools !== undefined) {
    if (Array.isArray(r.workerTools) && r.workerTools.every((t) => typeof t === "string")) config.workerTools = r.workerTools as string[];
    else warnings.push("workerTools must be an array of strings");
  }
  if (r.reviewer !== undefined) {
    if (typeof r.reviewer === "string" && r.reviewer.trim()) config.reviewer = r.reviewer.trim();
    else warnings.push("reviewer must be an agent name string");
  }
  return { config, warnings };
}

function readJson(file: string): { value?: unknown; warning?: string } {
  if (!fs.existsSync(file)) return {};
  try {
    return { value: JSON.parse(fs.readFileSync(file, "utf-8")) };
  } catch (e) {
    return { warning: `${file}: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/**
 * Global config (~/.pi/agent/swarm.json) always loads. Project config (<cwd>/.pi/swarm.json)
 * loads ONLY when the project is trusted, because `gates` are shell commands.
 */
export function loadConfig(cwd: string, projectTrusted: boolean): { config: SwarmConfig; warnings: string[] } {
  const warnings: string[] = [];
  let merged: SwarmConfig = { ...DEFAULT_CONFIG, models: {} };
  const sources: string[] = [path.join(getAgentDir(), "swarm.json")];
  const projectFile = path.join(cwd, ".pi", "swarm.json");
  if (projectTrusted) sources.push(projectFile);
  else if (fs.existsSync(projectFile)) warnings.push("project .pi/swarm.json ignored: project is not trusted");

  for (const file of sources) {
    const { value, warning } = readJson(file);
    if (warning) warnings.push(warning);
    if (value === undefined) continue;
    const parsed = parseConfig(value);
    warnings.push(...parsed.warnings.map((w) => `${file}: ${w}`));
    merged = { ...merged, ...parsed.config, models: { ...merged.models, ...(parsed.config.models ?? {}) } };
  }
  return { config: merged, warnings };
}

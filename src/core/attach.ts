/**
 * Cross-process attach state (ROADMAP #7).
 *
 * Persists team-run, worker, and job state to disk under `.pi/swarm/attach/`
 * so a second pi session can discover running teams, view worker/job status,
 * and queue steer commands that the originating session's Runtime picks up.
 *
 * All writes are atomic (tmp + rename). A lock file serializes concurrent access.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { assertSafeName } from "./util.ts";

export function attachDir(cwd: string): string {
  return path.join(cwd, ".pi", "swarm", "attach");
}

export function teamAttachDir(cwd: string, team: string): string {
  return path.join(attachDir(cwd), "teams", assertSafeName(team, "team name"));
}

export function workerAttachDir(cwd: string, team: string): string {
  return path.join(teamAttachDir(cwd, team), "workers");
}

export function jobAttachDir(cwd: string, team: string): string {
  return path.join(teamAttachDir(cwd, team), "jobs");
}

export function steerDir(cwd: string, team: string): string {
  return path.join(teamAttachDir(cwd, team), "steer");
}

/** Atomic write: tmp file + rename. */
function atomicWrite(file: string, data: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + `.${randomUUID()}.tmp`;
  fs.writeFileSync(tmp, data, { encoding: "utf-8", mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** Read JSON file, returning undefined if missing or unparseable. */
function readJson<T>(file: string): T | undefined {
  if (!fs.existsSync(file)) return undefined;
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8")) as T;
  } catch {
    return undefined;
  }
}

export interface TeamRunningInfo {
  team: string;
  startedAt: number;
  mates: string[];
  pid: number;
}

export interface WorkerAttachInfo {
  label: string;
  status: "running" | "ok" | "failed" | "aborted";
  startedAt: number;
  endedAt?: number;
  last: string;
  steerable: boolean;
  sessionDir?: string;
  /** Monitor verdict for running workers (active | quiet | stalled). */
  health?: string;
  /** What the worker is doing right now, e.g. `tool:bash 45s`. */
  phase?: string;
  lastActivityAt?: number;
  logPath?: string;
}

export interface JobAttachInfo {
  id: string;
  kind: string;
  name: string;
  status: "running" | "done" | "failed" | "stopped";
  startedAt: number;
  endedAt?: number;
  result?: string;
}

/** Persist that a team run is active. Call at the start of runTeam(). */
export function writeTeamRunning(cwd: string, team: string, info: TeamRunningInfo): void {
  atomicWrite(path.join(teamAttachDir(cwd, team), "running.json"), JSON.stringify(info));
}

/** Remove team running state. Call when the team run settles. */
export function removeTeamRunning(cwd: string, team: string): void {
  const d = teamAttachDir(cwd, team);
  const f = path.join(d, "running.json");
  if (fs.existsSync(f)) fs.rmSync(f, { force: true });
  // Also clean stale steer commands
  const sd = steerDir(cwd, team);
  if (fs.existsSync(sd)) {
    for (const f of fs.readdirSync(sd)) fs.rmSync(path.join(sd, f), { force: true });
  }
}

/** Persist a worker's current state. Called by Runtime on each run(). */
export function writeWorkerState(cwd: string, team: string, info: WorkerAttachInfo): void {
  const safeLabel = info.label.replace(/[/\\]/g, "_");
  atomicWrite(path.join(workerAttachDir(cwd, team), `${safeLabel}.json`), JSON.stringify(info));
}

/** Remove a worker's state file. */
export function removeWorkerState(cwd: string, team: string, label: string): void {
  const safeLabel = label.replace(/[/\\]/g, "_");
  const f = path.join(workerAttachDir(cwd, team), `${safeLabel}.json`);
  if (fs.existsSync(f)) fs.rmSync(f, { force: true });
}

/** Persist a job's current state. Called by Runtime on job start/stop. */
export function writeJobState(cwd: string, team: string | undefined, info: JobAttachInfo): void {
  const d = team ? jobAttachDir(cwd, team) : attachDir(cwd);
  atomicWrite(path.join(d, `${info.id}.json`), JSON.stringify(info));
}

/** Remove a job's state file. */
export function removeJobState(cwd: string, team: string | undefined, id: string): void {
  const d = team ? jobAttachDir(cwd, team) : attachDir(cwd);
  const f = path.join(d, `${id}.json`);
  if (fs.existsSync(f)) fs.rmSync(f, { force: true });
}

/** List teams that currently have a running.json (i.e. a team run is active). */
export function listRunningTeams(cwd: string): string[] {
  const base = path.join(attachDir(cwd), "teams");
  if (!fs.existsSync(base)) return [];
  return fs
    .readdirSync(base)
    .filter((n) => fs.existsSync(path.join(base, n, "running.json")))
    .sort();
}

/** Read a team's running info. */
export function readTeamRunning(cwd: string, team: string): TeamRunningInfo | undefined {
  return readJson<TeamRunningInfo>(path.join(teamAttachDir(cwd, team), "running.json"));
}

/** Read all worker state files for a team. */
export function readTeamWorkers(cwd: string, team: string): WorkerAttachInfo[] {
  const d = workerAttachDir(cwd, team);
  if (!fs.existsSync(d)) return [];
  return fs
    .readdirSync(d)
    .filter((f) => f.endsWith(".json"))
    .map((f) => readJson<WorkerAttachInfo>(path.join(d, f)))
    .filter((x): x is WorkerAttachInfo => x !== undefined)
    .sort((a, b) => a.startedAt - b.startedAt);
}

/** Read all job state files for a team (or global jobs if team is undefined). */
export function readTeamJobs(cwd: string, team: string | undefined): JobAttachInfo[] {
  const d = team ? jobAttachDir(cwd, team) : attachDir(cwd);
  if (!fs.existsSync(d)) return [];
  return fs
    .readdirSync(d)
    .filter((f) => f.endsWith(".json") && !f.startsWith("."))
    .map((f) => readJson<JobAttachInfo>(path.join(d, f)))
    .filter((x): x is JobAttachInfo => x !== undefined)
    .sort((a, b) => a.startedAt - b.startedAt);
}

/** Queue a steer command for a worker. The originating Runtime picks it up via pollSteerCommands(). */
export function writeSteerCommand(cwd: string, team: string, label: string, text: string): void {
  const d = steerDir(cwd, team);
  fs.mkdirSync(d, { recursive: true });
  // Labels like "team/mate#1" contain "/" — sanitize to a single path segment.
  const safeLabel = label.replace(/[/\\]/g, "_");
  const file = path.join(d, `${safeLabel}.txt`);
  // Append: multiple steer commands accumulate; the reader consumes all.
  fs.appendFileSync(file, `${text}\n`, { encoding: "utf-8" });
}

/** Read and clear all pending steer commands for a worker. Returns the accumulated text (newline-joined). */
export function pollSteerCommands(cwd: string, team: string, label: string): string | undefined {
  const safeLabel = label.replace(/[/\\]/g, "_");
  const f = path.join(steerDir(cwd, team), `${safeLabel}.txt`);
  if (!fs.existsSync(f)) return undefined;
  const raw = fs.readFileSync(f, "utf-8");
  fs.rmSync(f, { force: true });
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  return lines.length ? lines.join("\n") : undefined;
}

/** Check whether any team has a running state (for /swarm attach listing). */
export function hasRunningTeams(cwd: string): boolean {
  return listRunningTeams(cwd).length > 0;
}

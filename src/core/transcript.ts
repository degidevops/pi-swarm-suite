import * as fs from "node:fs";
import * as path from "node:path";

export interface TranscriptEntry {
  ts: number;
  type: "attempt" | "complete" | "fail" | "review" | "hook";
  taskId: string;
  mate?: string;
  attempt?: number;
  output?: string;
  error?: string;
  usage?: { input: number; output: number; cost: number; turns: number };
}

/** Directory for per-team, per-task transcripts: <cwd>/.pi/swarm/teams/<team>/transcripts/ */
export function transcriptDir(cwd: string, team: string): string {
  return path.join(cwd, ".pi", "swarm", "teams", assertSafeName(team, "team name"), "transcripts");
}

/** Append one JSONL entry to a task's transcript file. Best-effort: never throws. */
export function appendTranscript(cwd: string, team: string, entry: TranscriptEntry): void {
  try {
    const d = transcriptDir(cwd, team);
    fs.mkdirSync(d, { recursive: true });
    fs.appendFileSync(path.join(d, `${entry.taskId}.jsonl`), JSON.stringify(entry) + "\n");
  } catch {
    /* transcript persistence must never break a run */
  }
}

/** Read all entries for a task's transcript (empty array if none). */
export function readTranscript(cwd: string, team: string, taskId: string): TranscriptEntry[] {
  try {
    const f = path.join(transcriptDir(cwd, team), `${taskId}.jsonl`);
    if (!fs.existsSync(f)) return [];
    return fs.readFileSync(f, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as TranscriptEntry);
  } catch {
    return [];
  }
}

function assertSafeName(name: string, what: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(name) || name === ".." || name.includes("/") || name.includes("\\")) {
    throw new Error(`Unsafe ${what}: ${name}`);
  }
  return name;
}

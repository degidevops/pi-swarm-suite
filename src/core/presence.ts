/**
 * Who is reachable right now. The lead process keeps one live pi per resident teammate and records it here so
 * OTHER teammates' processes (which cannot see the lead's memory) know whether a question can be answered.
 * A record is trusted only while the lead process that wrote it is alive.
 */
import * as fs from "node:fs";
import * as path from "node:path";

export type PresenceState = "idle" | "working";

interface PresenceRecord {
  state: PresenceState;
  /** pid of the lead process that owns the resident. */
  pid: number;
  since: number;
}

const file = (teamDir: string, mate: string) => path.join(teamDir, "presence", `${mate}.json`);

export function setPresence(teamDir: string, mate: string, state: PresenceState | null): void {
  try {
    if (state === null) return void fs.rmSync(file(teamDir, mate), { force: true });
    fs.mkdirSync(path.join(teamDir, "presence"), { recursive: true });
    const rec: PresenceRecord = { state, pid: process.pid, since: Date.now() };
    fs.writeFileSync(file(teamDir, mate), JSON.stringify(rec));
  } catch {
    /* presence is advisory */
  }
}

export function readPresence(teamDir: string, mate: string): PresenceState | undefined {
  try {
    const rec = JSON.parse(fs.readFileSync(file(teamDir, mate), "utf-8")) as PresenceRecord;
    process.kill(rec.pid, 0); // throws if the owning lead is gone
    return rec.state;
  } catch {
    return undefined;
  }
}

export function clearAllPresence(teamDir: string): void {
  try {
    fs.rmSync(path.join(teamDir, "presence"), { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

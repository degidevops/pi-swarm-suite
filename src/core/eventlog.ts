import * as fs from "node:fs";
import * as path from "node:path";

export interface LogEvent {
  ts: string;
  type: string;
  [k: string]: unknown;
}

export function appendLog(file: string, type: string, data: Record<string, unknown> = {}): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify({ ts: new Date().toISOString(), type, ...data })}\n`);
  } catch {
    /* logging must never break a run */
  }
}

export function readLog(file: string, last = 30): LogEvent[] {
  if (!fs.existsSync(file)) return [];
  const out: LogEvent[] = [];
  for (const line of fs.readFileSync(file, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as LogEvent);
    } catch {
      /* skip */
    }
  }
  return out.slice(-last);
}

export function formatLog(events: LogEvent[]): string {
  return events
    .map((e) => {
      const { ts, type, ...rest } = e;
      const detail = Object.entries(rest).map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`).join(" ");
      return `${ts.slice(11, 19)} ${type}${detail ? ` ${detail}` : ""}`;
    })
    .join("\n");
}

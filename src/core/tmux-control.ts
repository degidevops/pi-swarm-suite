/**
 * Control channel between the lead and a worker that runs as a REAL interactive pi inside a tmux window.
 *
 * The worker has a terminal (the user can watch and type in it), so there is no stdin/stdout pipe to the
 * lead. Instead both sides use small append-only JSONL files in a per-worker control directory:
 *
 *   events.jsonl    worker → lead   pi events (message_end, tool_execution_*, agent_settled, …) + "ready"
 *   commands.jsonl  lead → worker   { type: "steer" | "abort" | "quit", text? }
 *   alive           worker touches it every second (heartbeat; lets the lead tell "hung" from "slow")
 *   exit            written by the tmux shell wrapper when pi exits (content = exit code)
 *   env.sh          environment for the worker; sourced and deleted by the wrapper at start (mode 0600)
 *
 * Only complete lines are consumed, so a half-written line is never parsed.
 */
import * as fs from "node:fs";
import * as path from "node:path";

export const CTL_ENV = "PI_SWARM_CTL_DIR";

export interface CtlPaths {
  dir: string;
  events: string;
  commands: string;
  alive: string;
  exit: string;
  env: string;
}

export function ctlPaths(dir: string): CtlPaths {
  return {
    dir,
    events: path.join(dir, "events.jsonl"),
    commands: path.join(dir, "commands.jsonl"),
    alive: path.join(dir, "alive"),
    exit: path.join(dir, "exit"),
    env: path.join(dir, "env.sh"),
  };
}

export type CtlCommand = { type: "steer"; text: string } | { type: "abort" } | { type: "quit" };

/** Append one JSON record as a single line (small appends are atomic enough for a single writer). */
export function appendJsonl(file: string, record: unknown): void {
  try {
    fs.appendFileSync(file, `${JSON.stringify(record)}\n`);
  } catch {
    /* best-effort: the channel must never crash a worker */
  }
}

/** Reads the lines appended to a JSONL file since the previous `read()`. Keeps its own byte offset. */
export class JsonlTail {
  private offset = 0;
  constructor(private readonly file: string) {}

  read(): unknown[] {
    let size: number;
    try {
      size = fs.statSync(this.file).size;
    } catch {
      return [];
    }
    if (size < this.offset) this.offset = 0; // file was recreated
    if (size === this.offset) return [];
    const fd = fs.openSync(this.file, "r");
    let chunk: Buffer;
    try {
      chunk = Buffer.alloc(size - this.offset);
      fs.readSync(fd, chunk, 0, chunk.length, this.offset);
    } finally {
      fs.closeSync(fd);
    }
    const lastNl = chunk.lastIndexOf(0x0a);
    if (lastNl < 0) return [];
    this.offset += lastNl + 1;
    const out: unknown[] = [];
    for (const line of chunk.subarray(0, lastNl + 1).toString("utf-8").split("\n")) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        /* skip a corrupt line */
      }
    }
    return out;
  }
}

export function touch(file: string): void {
  try {
    const now = new Date();
    fs.utimesSync(file, now, now);
  } catch {
    try {
      fs.writeFileSync(file, "");
    } catch {
      /* best-effort */
    }
  }
}

/** POSIX single-quote a value for an `export` line in env.sh. */
export function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Render an environment as `export K='v'` lines. Keys that are not valid shell identifiers are skipped. */
export function renderEnvFile(env: Record<string, string | undefined>, skip: ReadonlySet<string> = SKIPPED_ENV): string {
  const lines: string[] = [];
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined || skip.has(k) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) continue;
    lines.push(`export ${k}=${shQuote(v)}`);
  }
  return `${lines.join("\n")}\n`;
}

/** Variables that describe the lead's own terminal/tmux and must not leak into the worker's window. */
export const SKIPPED_ENV: ReadonlySet<string> = new Set(["TMUX", "TMUX_PANE", "SHLVL", "_", "PWD", "OLDPWD", "TERM", "COLUMNS", "LINES"]);

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const DEPTH_ENV = "PI_SWARM_DEPTH";
export const TEAM_DIR_ENV = "PI_SWARM_TEAM_DIR";
export const MATE_ENV = "PI_SWARM_MATE";
/** Test/advanced override: path to an alternative pi executable or .js/.mjs script. */
export const BIN_ENV = "PI_SWARM_PI_BIN";

export interface ChildSpec {
  cwd: string;
  systemPrompt?: string;
  model?: string;
  thinking?: string;
  tools?: string[];
  depth: number;
  /** Extension file children must load (team children need the messaging tools). */
  extPath?: string;
  env?: Record<string, string>;
  /** When set, the child pi persists its session under this directory (ROADMAP #3). */
  sessionDir?: string;
  /** Interactive (tui) children only: trust project-local resources without asking. */
  approve?: boolean;
}

/** Locate the running pi so children use the same binary/version. Pattern from pi's official subagent example. */
export function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const override = process.env[BIN_ENV];
  if (override) {
    return /\.(mjs|cjs|js)$/.test(override) ? { command: process.execPath, args: [override, ...args] } : { command: override, args };
  }
  const script = process.argv[1];
  const isBunVirtual =
    script !== undefined && (script.startsWith("/$bunfs/root/") || /^[A-Za-z]:[\\/]~BUN[\\/]root[\\/]/.test(script));
  if (script && !isBunVirtual && fs.existsSync(script)) return { command: process.execPath, args: [script, ...args] };
  const exec = path.basename(process.execPath).toLowerCase();
  if (!/^(node|bun)(\.exe)?$/.test(exec)) return { command: process.execPath, args };
  return { command: "pi", args };
}

export interface PreparedChild {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cleanup: () => Promise<void>;
}

/** Build the command line for a child pi. `json` = one-shot print mode; `rpc` = long-lived, steerable. */
export async function prepareChild(mode: "json" | "rpc" | "tui", spec: ChildSpec, task?: string): Promise<PreparedChild> {
  // "tui" = no --mode flag: a real interactive pi that needs a terminal (a tmux window).
  const args = mode === "json" ? ["--mode", "json", "-p"] : mode === "rpc" ? ["--mode", "rpc"] : [];
  if (mode === "tui") args.push(spec.approve ? "--approve" : "--no-approve");
  if (spec.sessionDir) {
    args.push("--session-dir", spec.sessionDir);
  } else {
    args.push("--no-session");
  }
  if (spec.model) args.push("--model", spec.model);
  if (spec.thinking) args.push("--thinking", spec.thinking);
  if (spec.tools?.length) args.push("--tools", spec.tools.join(","));
  if (spec.extPath) args.push("-e", spec.extPath);

  let tmpDir: string | undefined;
  if (spec.systemPrompt?.trim()) {
    tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-swarm-"));
    const file = path.join(tmpDir, "system.md");
    await fs.promises.writeFile(file, spec.systemPrompt, { encoding: "utf-8", mode: 0o600 });
    args.push("--append-system-prompt", file);
  }
  if (mode === "json" || (mode === "tui" && task !== undefined)) {
    const t = task ?? "";
    args.push(`Task: ${t.length > 60_000 ? `${t.slice(0, 60_000)}\n…[task truncated]` : t}`);
  }
  const inv = getPiInvocation(args);
  return {
    command: inv.command,
    args: inv.args,
    env: { ...process.env, ...spec.env, [DEPTH_ENV]: String(spec.depth + 1) },
    cleanup: async () => {
      if (tmpDir) await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}

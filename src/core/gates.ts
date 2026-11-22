import { spawn } from "node:child_process";
import { tail } from "./util.ts";

export interface GateResult {
  command: string;
  code: number | null;
  output: string;
}

export interface GateRun {
  ok: boolean;
  results: GateResult[];
}

/**
 * Run each gate command in order via the shell and stop at the first failure.
 * Commands come from trusted config only (see config.ts). Each gate has a timeout.
 */
export async function runGates(commands: string[], cwd: string, signal?: AbortSignal, timeoutMs = 600_000): Promise<GateRun> {
  const results: GateResult[] = [];
  for (const command of commands) {
    const r = await runOne(command, cwd, signal, timeoutMs);
    results.push(r);
    if (r.code !== 0) return { ok: false, results };
  }
  return { ok: true, results };
}

function runOne(command: string, cwd: string, signal: AbortSignal | undefined, timeoutMs: number): Promise<GateResult> {
  return new Promise((resolve) => {
    let out = "";
    const proc = spawn(command, { cwd, shell: true, stdio: ["ignore", "pipe", "pipe"], env: process.env });
    const timer = setTimeout(() => {
      out += `\n[gate timed out after ${timeoutMs}ms]`;
      proc.kill("SIGKILL");
    }, timeoutMs);
    const abort = () => proc.kill("SIGKILL");
    signal?.addEventListener("abort", abort, { once: true });
    const collect = (d: Buffer) => {
      out += d.toString();
      if (out.length > 200_000) out = out.slice(-100_000);
    };
    proc.stdout?.on("data", collect);
    proc.stderr?.on("data", collect);
    const finish = (code: number | null) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      resolve({ command, code, output: tail(out.trim(), 4000) });
    };
    proc.on("error", (e) => {
      out += String(e);
      finish(null);
    });
    proc.on("close", finish);
  });
}

export function formatGateFailure(run: GateRun): string {
  const bad = run.results.find((r) => r.code !== 0);
  if (!bad) return "";
  return `Gate failed: \`${bad.command}\` (exit ${bad.code})\n${bad.output}`;
}

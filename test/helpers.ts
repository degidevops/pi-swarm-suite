import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Runtime } from "../src/runtime.ts";
import { DEFAULT_CONFIG } from "../src/core/config.ts";
import type { AgentDef, SwarmConfig } from "../src/types.ts";

export const FAKE_PI = fileURLToPath(new URL("./fixtures/fake-pi.mjs", import.meta.url));

export function mkRepo(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-e2e-"));
  const run = (...a: string[]) => execFileSync("git", a, { cwd: d, stdio: "pipe" });
  run("init", "-q", "-b", "main");
  run("config", "user.email", "t@t");
  run("config", "user.name", "t");
  fs.writeFileSync(path.join(d, "README.md"), "base\n");
  run("add", "-A");
  run("commit", "-qm", "init");
  return d;
}

export function agent(name: string, tools?: string[], extra: Partial<AgentDef> = {}): AgentDef {
  return { name, description: name, tools, systemPrompt: `You are ${name}`, source: "user", filePath: "", ...extra };
}

export function mkRuntime(cwd: string, cfg: Partial<SwarmConfig> = {}, agents: AgentDef[] = []): { rt: Runtime; logFile: string } {
  const logFile = path.join(os.tmpdir(), `fake-log-${Math.random().toString(36).slice(2)}.jsonl`);
  process.env.PI_SWARM_PI_BIN = FAKE_PI;
  process.env.PI_FAKE_LOG = logFile;
  const rt = new Runtime(cwd, { ...DEFAULT_CONFIG, models: {}, customRolesOnly: false, ...cfg }, true, 0);
  rt.agents = new Map(agents.map((a) => [a.name, a]));
  rt.extPath = "/fake/ext/index.ts";
  return { rt, logFile };
}

export function readInvocations(logFile: string): Record<string, string | undefined>[] {
  return fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
}

export const ctxFor = (cwd: string) => ({ cwd }) as never;
export const text = (r: { content: { type: string; text?: string }[] }) => r.content.map((c) => c.text ?? "").join("\n");
export const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

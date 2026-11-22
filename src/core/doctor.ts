import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { Runtime } from "../runtime.ts";
import { BUILT_IN_AGENTS } from "./agents.ts";
import { summarizeCompetitors } from "./prompt.ts";
import { formatUsd } from "./util.ts";

/** Known packages that register their own delegation tools (advice shown by /swarm doctor). */
const KNOWN_DELEGATE_PACKAGES: Record<string, string> = {
  "billion-context": 'billion-context: set {"delegate": false} in ~/.pi/agent/acp.json (keeps compression), or `pi remove npm:billion-context`',
  "billion-context-pi": 'billion-context-pi: set {"delegate": false} in ~/.pi/agent/acp.json (keeps compression), or `pi remove npm:billion-context-pi`',
  "pi-subagents": "pi-subagents: `pi remove npm:pi-subagents` (swarm_delegate replaces it)",
  "pi-dynamic-workflows": "pi-dynamic-workflows: `pi remove npm:pi-dynamic-workflows` (swarm_workflow replaces it)",
};

/** Package sources recorded in ~/.pi/agent/settings.json plus any -e installed packages. */
function installedPackages(): string[] {
  try {
    const settings = JSON.parse(fs.readFileSync(path.join(getAgentDir(), "settings.json"), "utf-8")) as { packages?: unknown };
    return Array.isArray(settings.packages) ? settings.packages.filter((p): p is string => typeof p === "string") : [];
  } catch {
    return [];
  }
}

function gitAvailable(cwd: string): boolean {
  try {
    fs.statSync(path.join(cwd, ".git"));
    return true;
  } catch {
    // .git may be in a parent directory
    let dir = path.resolve(cwd);
    for (;;) {
      try {
        fs.statSync(path.join(dir, ".git"));
        return true;
      } catch {
        /* keep climbing */
      }
      const parent = path.dirname(dir);
      if (parent === dir) return false;
      dir = parent;
    }
  }
}

export interface DoctorInput {
  runtime: Runtime;
  extPath?: string;
  /** Active tools from the last before_agent_start snapshot (empty before the first turn). */
  activeTools: readonly string[];
  /** Foreign delegation tools detected among activeTools. */
  competitorTools: readonly string[];
  piVersion?: string;
}

/** Human-readable environment diagnosis printed by /swarm doctor. */
export function doctorReport(input: DoctorInput): string {
  const { runtime: rt } = input;
  const out: string[] = [];
  const bySource = { builtin: [] as string[], user: [] as string[], project: [] as string[] };
  for (const a of rt.agents.values()) bySource[a.source].push(a.name);

  out.push("swarm doctor — environment diagnosis");
  out.push("");
  out.push(`extension      pi-swarm-suite loaded${input.extPath ? ` from ${input.extPath}` : ""}${input.piVersion ? ` (pi ${input.piVersion})` : ""}`);
  const own = ["swarm_delegate", "swarm_team", "swarm_workflow"];
  out.push(`swarm tools    ${own.join(", ")}${input.activeTools.length ? " (active in prompt)" : " (not seen in a turn yet — send a prompt first)"}`);

  const competitors = summarizeCompetitors(input.competitorTools);
  if (input.activeTools.length === 0) {
    const pkgs = installedPackages().filter((p) => Object.keys(KNOWN_DELEGATE_PACKAGES).some((k) => p.includes(k)));
    if (pkgs.length) {
      out.push("");
      out.push(`other packages ${pkgs.join(", ")} — send one prompt, then run /swarm doctor again to see their tools`);
    }
  } else if (competitors.length) {
    out.push("");
    out.push(`other delegate tools detected: ${competitors.join(", ")}`);
    out.push("  The system prompt already tells the model to prefer the swarm tools for delegation.");
    out.push("  To remove the overlap entirely (optional):");
    const pkgs = installedPackages();
    const advised = new Set<string>();
    for (const [pkg, advice] of Object.entries(KNOWN_DELEGATE_PACKAGES)) {
      if (pkgs.some((p) => p.includes(pkg)) && !advised.has(advice)) {
        advised.add(advice);
        out.push(`  - ${advice}`);
      }
    }
    if (advised.size === 0) out.push("  - loaded via -e or another package manager: remove it from your pi settings");
  } else {
    out.push("other delegate tools: none — swarm tools are the only delegation path");
  }

  out.push("");
  out.push(`agents         built-in: ${bySource.builtin.join(", ") || "(none)"}`);
  if (bySource.user.length) out.push(`               user (~/.pi/agent/agents): ${bySource.user.join(", ")}`);
  if (bySource.project.length) out.push(`               project (.pi/agents): ${bySource.project.join(", ")}`);
  out.push(`               (${BUILT_IN_AGENTS.length} built-ins always available; user/project files override by name)`);

  const c = rt.config;
  out.push("");
  out.push(`config         maxConcurrency=${c.maxConcurrency} · worktrees=${c.worktrees} · maxAttempts=${c.maxAttempts} · gates=${c.gates.length} · budget=${c.budgetUsd === undefined ? "none" : formatUsd(c.budgetUsd)}`);
  out.push(`               models: lead=${c.models.lead ?? "(default)"} worker=${c.models.worker ?? "(default)"} cheap=${c.models.cheap ?? "(default)"}`);
  out.push(`               reviewer=${c.reviewer ?? "(off)"} · workerTools=${c.workerTools ? c.workerTools.join(",") : "(agent-defined)"}`);
  if (!rt.projectTrusted) out.push("               project .pi/swarm.json and .pi/agents ignored: project not trusted (run pi with --approve once)");

  out.push("");
  out.push(`git            ${gitAvailable(rt.cwd) ? "repository found — worktree isolation available" : "NOT a git repo — worktree:true and /swarm merge unavailable (delegate without worktree still works)"}`);
  if (c.budgetUsd === undefined) out.push("               tip: set budgetUsd in swarm.json so runaway runs stop automatically");

  return out.join("\n");
}

import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG_DIR_NAME, getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { AgentDef } from "../types.ts";

type Frontmatter = { name?: unknown; description?: unknown; tools?: unknown; model?: unknown; tier?: unknown };

const READ_ONLY_TOOLS = ["read", "bash", "grep", "find", "ls"] as const;

/**
 * Agents that ship with the package, so delegation works on a fresh install with zero setup
 * (same role vocabulary other delegate tools teach the model: reviewer/researcher/worker/planner/oracle).
 * User files in ~/.pi/agent/agents and project files in .pi/agents override them by name.
 */
export const BUILT_IN_AGENTS: AgentDef[] = [
  {
    name: "reviewer",
    description: "Read-only code review: bugs, risks, security issues, file:line findings; ends with VERDICT: PASS or FAIL",
    tools: [...READ_ONLY_TOOLS],
    tier: "cheap",
    systemPrompt:
      "You are an independent code reviewer. Review only what the task asks; do not modify files. " +
      "Find real defects: bugs, race conditions, security issues, API misuse, missing error handling. " +
      "Cite file:line for every finding. Run read-only checks (build, tests, grep) when useful. " +
      'Finish with a final line "VERDICT: PASS" when the change is sound, or "VERDICT: FAIL" followed by a numbered list of findings.',
    source: "builtin",
    filePath: "(built-in)",
  },
  {
    name: "researcher",
    description: "Read-only codebase investigation: how a subsystem works, call paths, where things live",
    tools: [...READ_ONLY_TOOLS],
    tier: "cheap",
    systemPrompt:
      "You are a codebase researcher. Answer the task's questions with precise references (file:line). " +
      "Trace call paths, list the relevant files, summarize how the subsystem works. Do not modify anything. " +
      "Be factual and explicitly say what you could not determine.",
    source: "builtin",
    filePath: "(built-in)",
  },
  {
    name: "planner",
    description: "Read-only planning: ordered implementation steps, files to touch, risks, verification",
    tools: [...READ_ONLY_TOOLS],
    tier: "cheap",
    systemPrompt:
      "You are a planner. Read the relevant code and produce a step-by-step implementation plan: " +
      "ordered steps, files to touch, risks, and how to verify each step. Do not modify anything. " +
      "Keep the plan tight and actionable.",
    source: "builtin",
    filePath: "(built-in)",
  },
  {
    name: "oracle",
    description: "Read-only questions and advice: design trade-offs, library choices, best practice",
    tools: [...READ_ONLY_TOOLS],
    tier: "cheap",
    systemPrompt:
      "You are an oracle. Answer the task's questions and give advice, citing code or docs (file:line) where relevant. " +
      "Do not modify anything. Be direct, call out trade-offs and unknowns.",
    source: "builtin",
    filePath: "(built-in)",
  },
  {
    name: "worker",
    description: "Implementation agent: makes code changes (use worktree:true so its branch stays isolated)",
    tools: ["read", "edit", "write", "bash"],
    tier: "worker",
    systemPrompt:
      "You are a focused implementation worker. Complete exactly the task given; do not expand scope. " +
      "Keep changes minimal, follow the project's existing style, and run the relevant checks before finishing. " +
      "Reply with a concise summary: what changed, files touched, and anything the lead must know.",
    source: "builtin",
    filePath: "(built-in)",
  },
];

function parseTools(value: unknown): string[] | undefined {
  const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  const tools = raw.filter((t): t is string => typeof t === "string").map((t) => t.trim()).filter(Boolean);
  return tools.length ? tools : undefined;
}

function loadDir(dir: string, source: AgentDef["source"]): AgentDef[] {
  if (!fs.existsSync(dir)) return [];
  const out: AgentDef[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.name.endsWith(".md") || !(entry.isFile() || entry.isSymbolicLink())) continue;
    const filePath = path.join(dir, entry.name);
    let content: string;
    try {
      content = fs.readFileSync(filePath, "utf-8");
    } catch {
      continue;
    }
    const { frontmatter, body } = parseFrontmatter<Frontmatter>(content);
    if (typeof frontmatter.name !== "string" || typeof frontmatter.description !== "string") continue;
    out.push({
      name: frontmatter.name,
      description: frontmatter.description,
      tools: parseTools(frontmatter.tools),
      model: typeof frontmatter.model === "string" ? frontmatter.model : undefined,
      tier: frontmatter.tier === "lead" || frontmatter.tier === "worker" || frontmatter.tier === "cheap" ? frontmatter.tier : undefined,
      systemPrompt: body,
      source,
      filePath,
    });
  }
  return out;
}

function nearestProjectAgentsDir(cwd: string): string | null {
  let dir = cwd;
  while (true) {
    const candidate = path.join(dir, CONFIG_DIR_NAME, "agents");
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Built-ins first, then user agents, then project agents (trusted projects only) — later sources
 * override earlier ones by name, so a user's reviewer.md replaces the built-in reviewer.
 */
export function discoverAgents(cwd: string, projectTrusted: boolean): Map<string, AgentDef> {
  const map = new Map<string, AgentDef>();
  for (const a of BUILT_IN_AGENTS) map.set(a.name, a);
  for (const a of loadDir(path.join(getAgentDir(), "agents"), "user")) map.set(a.name, a);
  if (projectTrusted) {
    const dir = nearestProjectAgentsDir(cwd);
    if (dir) for (const a of loadDir(dir, "project")) map.set(a.name, a);
  }
  return map;
}

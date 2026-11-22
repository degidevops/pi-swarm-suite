import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG_DIR_NAME, getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { AgentDef } from "../types.ts";

type Frontmatter = { name?: unknown; description?: unknown; tools?: unknown; model?: unknown; tier?: unknown };

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

/** Project agents override user agents of the same name, but only load when the project is trusted. */
export function discoverAgents(cwd: string, projectTrusted: boolean): Map<string, AgentDef> {
  const map = new Map<string, AgentDef>();
  for (const a of loadDir(path.join(getAgentDir(), "agents"), "user")) map.set(a.name, a);
  if (projectTrusted) {
    const dir = nearestProjectAgentsDir(cwd);
    if (dir) for (const a of loadDir(dir, "project")) map.set(a.name, a);
  }
  return map;
}

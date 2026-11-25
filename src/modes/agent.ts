import { Type, type Static } from "typebox";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Runtime } from "../runtime.ts";
import { BUILT_IN_AGENTS, projectAgentsDirForWrite, serializeAgent } from "../core/agents.ts";
import { assertSafeName } from "../core/util.ts";
import { renderCallFor, renderResultText } from "../ui.ts";

const KNOWN_TOOLS = new Set(["read", "bash", "edit", "write", "grep", "find", "ls"]);

export const AgentParams = Type.Object({
  action: Type.Union([Type.Literal("define"), Type.Literal("list"), Type.Literal("examples"), Type.Literal("remove")], {
    description:
      "define: create/replace a project role (written to <project>/.pi/agents/<name>.md, usable at once by swarm_delegate/swarm_team/swarm_workflow). list: roles of this project. examples: example roles to adapt (not directly usable). remove: delete a project role.",
  }),
  name: Type.Optional(Type.String({ description: "Role name (letters, digits, - or _). Required for define/remove." })),
  description: Type.Optional(Type.String({ description: "One line: what this role is for. Required for define." })),
  prompt: Type.Optional(Type.String({ description: "The role's system prompt: what it does, what it must not do, what its final reply must contain. Required for define unless `from` is given." })),
  tools: Type.Optional(Type.Array(Type.String(), { description: "Tool allowlist. Read-only: read, grep, find, ls (bash runs checks but can also write). Writing: add edit, write. Keep it minimal." })),
  tier: Type.Optional(Type.Union([Type.Literal("lead"), Type.Literal("worker"), Type.Literal("cheap")], { description: "Model tier (swarm.json models.<tier>). Default: cheap if all tools are read-only, else worker." })),
  model: Type.Optional(Type.String({ description: "Explicit provider/model; beats tier." })),
  from: Type.Optional(Type.String({ description: "Start from an existing agent or example (e.g. \"reviewer\"): its prompt/tools/tier are copied, then your fields override them." })),
  overwrite: Type.Optional(Type.Boolean({ description: "Replace an existing project role of the same name (default false)." })),
});
type Params = Static<typeof AgentParams>;

function describeAgent(a: { name: string; description: string; tools?: string[]; tier?: string; source: string; filePath: string }): string {
  return `- ${a.name} [${a.source}${a.tier ? `, ${a.tier}` : ""}] tools: ${a.tools?.join(", ") ?? "(default)"} — ${a.description}${a.source === "project" ? `\n    ${a.filePath}` : ""}`;
}

export function agentTool(getRt: (cwd: string) => Runtime): ToolDefinition<typeof AgentParams, Record<string, unknown>> {
  return {
    name: "swarm_agent",
    label: "Swarm: agent roles",
    description:
      "Define the worker roles this project needs. Built-in roles (reviewer, researcher, planner, oracle, worker) are only examples: before delegating, create the roles your task needs (name, description, tools, system prompt) with action=define; they are saved per project in .pi/agents/ and can then be used as `agent` in swarm_delegate, swarm_team and swarm_workflow. action=examples shows starting points; `from` copies one.",
    promptSnippet:
      'swarm_agent({ action: "define", name: "db-auditor", description: "Audits SQL migrations", tools: ["read", "grep", "find", "ls"], prompt: "You audit migrations/ for unsafe SQL. Never modify files. Cite file:line." })',
    promptGuidelines: [
      "Roles are yours to build: before calling swarm_delegate/swarm_team/swarm_workflow, define each role with swarm_agent, tailored to this project and task (least-privilege tools, a prompt that states scope and what the final reply must contain). Do not rely on the built-in example names.",
    ],
    parameters: AgentParams,
    renderCall: renderCallFor<Params>("swarm_agent", (a) => `${a.action}${a.name ? ` ${a.name}` : ""}`),
    renderResult: renderResultText,
    async execute(_id, p: Params, _signal, _onUpdate, ctx) {
      const rt = getRt(ctx.cwd);
      const text = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: {} as Record<string, unknown> });
      rt.refreshAgents();

      switch (p.action) {
        case "list": {
          const mine = [...rt.agents.values()].filter((a) => a.source === "project");
          return text(mine.length ? `Project roles:\n${mine.map(describeAgent).join("\n")}` : "No project roles yet. Define them with swarm_agent action=define (see action=examples).");
        }
        case "examples": {
          const ex = BUILT_IN_AGENTS.map((a) => `### ${a.name}  (tools: ${a.tools?.join(", ")}; tier: ${a.tier})\n${a.description}\nprompt: ${a.systemPrompt}`);
          return text(
            `EXAMPLE roles — starting points, not usable as-is${rt.config.customRolesOnly ? " in this project" : ""}. Adapt them to this project's needs: swarm_agent({ action: "define", name: "<your-name>", from: "<example>", prompt: "<tailored>" }).\n\n${ex.join("\n\n")}`,
          );
        }
        case "define": {
          if (!rt.projectTrusted) throw new Error("This project is not trusted, so project roles (.pi/agents) would not load. Trust the project in pi first.");
          const name = assertSafeName(p.name ?? "", "role name");
          const base = p.from ? rt.agents.get(p.from) : undefined;
          if (p.from && !base) throw new Error(`Unknown "from" agent "${p.from}". Known: ${[...rt.agents.keys()].join(", ")}.`);
          const description = (p.description ?? base?.description ?? "").trim();
          const prompt = (p.prompt ?? base?.systemPrompt ?? "").trim();
          if (!description) throw new Error("define requires description (one line: what the role is for).");
          if (!prompt) throw new Error("define requires prompt (the role's system prompt), or `from` to start from an example.");
          const tools = p.tools ?? base?.tools;
          const unknown = (tools ?? []).filter((t) => !KNOWN_TOOLS.has(t));

          const dir = projectAgentsDirForWrite(rt.cwd);
          const file = path.join(dir, `${name}.md`);
          const existing = rt.agents.get(name);
          if (existing?.source === "project" && !p.overwrite) {
            throw new Error(`Project role "${name}" already exists (${existing.filePath}). Pass overwrite:true to replace it, or pick another name.`);
          }
          fs.mkdirSync(dir, { recursive: true });
          const body = serializeAgent({ name, description, tools, tier: p.tier ?? base?.tier, model: p.model ?? base?.model, systemPrompt: prompt });
          fs.writeFileSync(file, body, "utf-8");
          rt.refreshAgents();
          const loaded = rt.agents.get(name);
          if (loaded?.source !== "project") throw new Error(`Wrote ${file} but it did not load as a project agent (is the project trusted / is the file valid?).`);
          const writes = (tools ?? []).some((t) => t === "edit" || t === "write" || t === "bash");
          return text(
            `Defined role "${name}" → ${file}\ntools: ${tools?.join(", ") ?? "(default)"} · tier: ${loaded.tier ?? "auto"}\nUse it as agent: "${name}" in swarm_delegate / swarm_team / swarm_workflow.` +
              (unknown.length ? `\n⚠ Unrecognized tool name(s): ${unknown.join(", ")} (fine only if another extension provides them).` : "") +
              (writes ? `\n⚠ This role can modify files/run commands: isolate it (worktree:true, or swarm_team).` : "") +
              `\nThe file belongs to the project (.pi/agents): commit it to share the role with the team.`,
          );
        }
        case "remove": {
          const name = assertSafeName(p.name ?? "", "role name");
          const a = rt.agents.get(name);
          if (!a || a.source !== "project") throw new Error(`No project role "${name}". Only project roles can be removed. Project roles: ${rt.projectAgentNames().join(", ") || "(none)"}.`);
          fs.rmSync(a.filePath, { force: true });
          rt.refreshAgents();
          return text(`Removed role "${name}" (${a.filePath}).`);
        }
      }
    },
  };
}

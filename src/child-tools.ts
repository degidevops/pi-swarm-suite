import * as fs from "node:fs";
import * as path from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Mailbox } from "./core/mailbox.ts";
import { TaskStore } from "./core/tasks.ts";
import { appendLog } from "./core/eventlog.ts";

/**
 * Tools available INSIDE a team child (teammate). They let a teammate message others or the lead,
 * read its inbox, and see the shared task list, mirroring Claude Code agent teams.
 * They only touch files under the team directory passed via PI_SWARM_TEAM_DIR.
 */
export function registerChildTools(pi: ExtensionAPI, teamDir: string, me: string): void {
  const box = new Mailbox(path.join(teamDir, "inbox"));
  const names = (): string[] => {
    try {
      const t = JSON.parse(fs.readFileSync(path.join(teamDir, "team.json"), "utf-8")) as { teammates: { name: string }[] };
      return ["lead", ...t.teammates.map((m) => m.name)];
    } catch {
      return ["lead"];
    }
  };
  const text = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: {} as Record<string, unknown> });

  pi.registerTool({
    name: "team_message",
    label: "Team: message",
    description: "Send a short message to a teammate (by name) or to 'lead'. Delivered immediately if they are working, otherwise with their next task. Use for interface questions, blockers, or handoffs.",
    parameters: Type.Object({ to: Type.String({ description: "teammate name, or 'lead', or 'all'" }), text: Type.String() }),
    async execute(_id, p) {
      const known = names();
      if (p.to === "all") return text(`sent to ${box.broadcast(me, known.filter((n) => n !== me && n !== "lead"), p.text)} teammate(s)`);
      if (!known.includes(p.to) || p.to === me) throw new Error(`unknown recipient "${p.to}". Known: ${known.filter((n) => n !== me).join(", ")}`);
      box.send(me, p.to, p.text);
      return text(`sent to ${p.to}`);
    },
  });

  pi.registerTool({
    name: "team_inbox",
    label: "Team: inbox",
    description: "Read and clear messages sent to you by teammates or the lead.",
    parameters: Type.Object({}),
    async execute() {
      const msgs = box.drain(me);
      return text(msgs.length ? msgs.map((m) => `from ${m.from}: ${m.text}`).join("\n") : "(no messages)");
    },
  });

  pi.registerTool({
    name: "team_tasks",
    label: "Team: tasks",
    description: "Show the shared task list (ids, status, owner, scope) so you know what others are doing and avoid overlap.",
    parameters: Type.Object({}),
    async execute() {
      const store = new TaskStore(path.join(teamDir, "tasks"));
      const lines = store.list().map((t) => `${t.id}. [${t.status}]${t.owner ? ` (${t.owner})` : ""} ${t.subject}${t.scope ? `  scope:${t.scope.join(",")}` : ""}`);
      return text(lines.join("\n") || "(no tasks)");
    },
  });

  pi.registerTool({
    name: "team_task_request",
    label: "Team: request task",
    description: "Request a new task on the team's shared task list. The task starts pending and needs the lead's plan approval before anyone implements it.",
    parameters: Type.Object({
      subject: Type.String({ description: "Task subject" }),
      description: Type.String({ description: "Complete instructions incl. acceptance criteria" }),
      deps: Type.Optional(Type.Array(Type.String(), { description: 'Ids of earlier tasks ("1", "2", …) that must complete first' })),
      files: Type.Optional(Type.Array(Type.String(), { description: 'File-ownership globs, e.g. "crates/feed/**"' })),
      plan: Type.Optional(Type.Boolean({ description: "Require an approved plan before any code is written" })),
    }),
    async execute(_id, p) {
      if (!p.subject || !p.description) throw new Error("team_task_request requires subject and description.");
      const store = new TaskStore(path.join(teamDir, "tasks"));
      const t = store.create({ subject: p.subject, description: p.description, deps: p.deps, files: p.files, plan: true });
      box.send(me, "lead", `Task ${t.id} requested: ${p.subject}`);
      appendLog(path.join(teamDir, "log.jsonl"), "task_requested", { task: t.id, subject: p.subject, requestedBy: me });
      return text(`Task ${t.id} requested: ${p.subject} — pending, awaiting the lead's plan approval.`);
    },
  });
}

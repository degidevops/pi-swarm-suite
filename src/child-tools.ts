import * as fs from "node:fs";
import * as path from "node:path";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { MESSAGE_KINDS, Mailbox, formatMessages, isMessageKind, type MessageKind } from "./core/mailbox.ts";
import { type Teammate, managerOf, renderOrgChart, resolveRecipient } from "./core/org.ts";
import { TaskStore } from "./core/tasks.ts";
import { appendLog } from "./core/eventlog.ts";
import { sleep } from "./core/util.ts";

/** How often a busy teammate checks its own inbox for peer messages (push delivery). */
const PUSH_POLL_MS = 700;
const ASK_DEFAULT_SEC = 120;
const ASK_MAX_SEC = 600;

/**
 * Tools available INSIDE a team child (teammate): talk to teammates and the lead, ask and wait for an
 * answer, see the org chart and who is doing what, record team decisions, and read the shared task list.
 * They only touch files under the team directory passed via PI_SWARM_TEAM_DIR.
 *
 * Messages are PUSHED: while this teammate is working, a watcher inside this process drains its inbox and
 * steers the running agent, so peers reach each other directly without the lead relaying.
 */
export function registerChildTools(pi: ExtensionAPI, teamDir: string, me: string): void {
  const box = new Mailbox(path.join(teamDir, "inbox"));
  const log = path.join(teamDir, "log.jsonl");
  const decisionsFile = path.join(teamDir, "decisions.md");
  const store = () => new TaskStore(path.join(teamDir, "tasks"));
  const text = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: {} as Record<string, unknown> });

  const mates = (): Teammate[] => {
    try {
      return (JSON.parse(fs.readFileSync(path.join(teamDir, "team.json"), "utf-8")) as { teammates: Teammate[] }).teammates;
    } catch {
      return [];
    }
  };
  const known = (): string[] => ["lead", ...mates().map((m) => m.name)];
  /** Resolve a recipient (name, "lead", @manager, @owner:<path>) or throw with the valid choices. */
  const recipient = (to: string): string => {
    const r = resolveRecipient(to, mates(), me);
    if (!r || !known().includes(r) || r === me) throw new Error(`unknown recipient "${to}". Known: ${known().filter((n) => n !== me).join(", ")} (aliases: @manager, @lead, @owner:<path>)`);
    return r;
  };
  const kindOf = (k: string | undefined, fallback: MessageKind): MessageKind => {
    if (k === undefined) return fallback;
    if (!isMessageKind(k)) throw new Error(`unknown kind "${k}". Use: ${MESSAGE_KINDS.join(", ")}`);
    return k;
  };
  /** A teammate "is working" when it owns an in-progress task (its worker is alive and can answer). */
  const isWorking = (name: string): boolean => name === "lead" || store().list().some((t) => t.owner === name && t.status === "in_progress");

  // ── push delivery ────────────────────────────────────────────────────────────────────────────────
  // Only while busy: between runs the inbox is left alone so mail is delivered with the next task prompt.
  const pendingAsks = new Set<string>(); // question ids this teammate is blocked on; their answers go to team_ask
  let busy = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  const awaitedAnswer = (m: { replyTo?: string }): boolean => !!m.replyTo && [...pendingAsks].some((id) => id.startsWith(m.replyTo as string));
  pi.on("agent_start", async () => {
    busy = true;
    timer ??= setInterval(() => {
      if (!busy) return;
      const msgs = box.drain(me, (m) => !awaitedAnswer(m));
      if (!msgs.length) return;
      pi.sendUserMessage(`New message(s) from your team:\n${formatMessages(msgs)}\n(Answer questions with team_message kind=answer replyTo=<id>.)`, { deliverAs: "steer" });
      appendLog(log, "pushed", { mate: me, count: msgs.length });
    }, PUSH_POLL_MS);
    timer.unref?.();
  });
  pi.on("agent_settled", async () => {
    busy = false;
  });
  pi.on("session_shutdown", async () => {
    if (timer) clearInterval(timer);
    timer = undefined;
  });

  // ── tools ────────────────────────────────────────────────────────────────────────────────────────
  pi.registerTool({
    name: "team_message",
    label: "Team: message",
    description:
      "Send a short message to a teammate (name), 'lead', '@manager' (your escalation path), '@owner:<path>' (whoever owns that file), or 'all'. Delivered immediately if they are working, otherwise with their next task. kind: info (default), question, answer (set replyTo to the question's id), blocker, handoff, review_request, decision. Use team_ask instead when you need the answer to continue.",
    parameters: Type.Object({
      to: Type.String({ description: "teammate name, 'lead', '@manager', '@owner:<path>', or 'all'" }),
      text: Type.String(),
      kind: Type.Optional(Type.String({ description: MESSAGE_KINDS.join(" | ") })),
      replyTo: Type.Optional(Type.String({ description: "id of the message you are answering (kind=answer)" })),
    }),
    async execute(_id, p) {
      const kind = kindOf(p.kind, p.replyTo ? "answer" : "info");
      if (p.to === "all") return text(`sent to ${box.broadcast(me, known().filter((n) => n !== me && n !== "lead"), p.text, { kind })} teammate(s)`);
      const to = recipient(p.to);
      box.send(me, to, p.text, { kind, replyTo: p.replyTo });
      appendLog(log, "message", { from: me, to, kind });
      return text(`sent to ${to}${kind === "blocker" ? " (blocker: they will see it as urgent)" : ""}`);
    },
  });

  pi.registerTool({
    name: "team_ask",
    label: "Team: ask",
    description:
      "Ask a teammate (or '@manager', '@owner:<path>', 'lead') a question and WAIT for their answer (default 2 min). Use when you cannot continue without it. If they are not working right now the question is queued and this returns at once: continue with a stated assumption or escalate to @manager.",
    parameters: Type.Object({
      to: Type.String({ description: "teammate name, 'lead', '@manager' or '@owner:<path>'" }),
      question: Type.String({ description: "Self-contained question; include the file/interface you are asking about" }),
      waitSec: Type.Optional(Type.Number({ description: `Seconds to wait (default ${ASK_DEFAULT_SEC}, max ${ASK_MAX_SEC})` })),
    }),
    async execute(_id, p, signal) {
      const to = recipient(p.to);
      const sent = box.send(me, to, p.question, { kind: "question" });
      appendLog(log, "message", { from: me, to, kind: "question" });
      if (to !== "lead" && !isWorking(to)) {
        return text(`${to} is not working right now, so your question is queued (id ${sent.id.slice(0, 8)}) and they will see it with their next task. Do not wait: continue with a clearly stated assumption, or escalate with team_message to @manager.`);
      }
      const deadline = Date.now() + Math.min(Math.max(p.waitSec ?? ASK_DEFAULT_SEC, 5), ASK_MAX_SEC) * 1000;
      pendingAsks.add(sent.id);
      try {
        while (Date.now() < deadline && !signal?.aborted) {
          const answers = box.drain(me, (m) => !!m.replyTo && m.replyTo.length >= 6 && sent.id.startsWith(m.replyTo));
          if (answers.length) return text(`${to} answered:\n${answers.map((a) => a.text).join("\n")}`);
          await sleep(500);
        }
      } finally {
        pendingAsks.delete(sent.id);
      }
      return text(`No answer from ${to} yet (question id ${sent.id.slice(0, 8)}; it stays in their inbox). Continue with a stated assumption, or escalate to ${managerOf(mates(), me)} with team_message kind=blocker.`);
    },
  });

  pi.registerTool({
    name: "team_inbox",
    label: "Team: inbox",
    description: "Read and clear messages sent to you by teammates or the lead (they are also pushed to you while you work).",
    parameters: Type.Object({}),
    async execute() {
      const msgs = box.drain(me);
      return text(msgs.length ? formatMessages(msgs) : "(no messages)");
    },
  });

  pi.registerTool({
    name: "team_directory",
    label: "Team: directory",
    description: "Who is on the team: titles, responsibilities, reporting line, owned files, and what each person is working on right now. Use it to find the right person to ask.",
    parameters: Type.Object({}),
    async execute() {
      return text(renderOrgChart(mates(), store().list(), me));
    },
  });

  pi.registerTool({
    name: "team_decide",
    label: "Team: decide",
    description: "Record a decision everyone must respect (API shape, naming, trade-off, scope ruling) in the shared decision log, and tell the people it affects. Read the log with team_decisions.",
    parameters: Type.Object({
      decision: Type.String({ description: "The decision and the reason, in one or two sentences" }),
      notify: Type.Optional(Type.Array(Type.String(), { description: "Teammates (or 'all') to tell right away" })),
    }),
    async execute(_id, p) {
      fs.appendFileSync(decisionsFile, `- [${new Date().toISOString().slice(0, 16).replace("T", " ")}] ${me}: ${p.decision.replace(/\s+/g, " ").trim()}\n`);
      appendLog(log, "decision", { by: me });
      const targets = p.notify?.includes("all") ? known().filter((n) => n !== me && n !== "lead") : (p.notify ?? []).map(recipient);
      for (const t of new Set(targets)) box.send(me, t, p.decision, { kind: "decision" });
      return text(`recorded${targets.length ? ` and sent to ${[...new Set(targets)].join(", ")}` : ""}`);
    },
  });

  pi.registerTool({
    name: "team_decisions",
    label: "Team: decisions",
    description: "Read the shared decision log (what the team has already decided).",
    parameters: Type.Object({}),
    async execute() {
      try {
        return text(fs.readFileSync(decisionsFile, "utf-8").trim() || "(no decisions yet)");
      } catch {
        return text("(no decisions yet)");
      }
    },
  });

  pi.registerTool({
    name: "team_tasks",
    label: "Team: tasks",
    description: "Show the shared task list (ids, status, owner, scope) so you know what others are doing and avoid overlap.",
    parameters: Type.Object({}),
    async execute() {
      const lines = store()
        .list()
        .map((t) => `${t.id}. [${t.status}]${t.owner ? ` (${t.owner})` : ""} ${t.subject}${t.scope ? `  scope:${t.scope.join(",")}` : ""}`);
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
      const t = store().create({ subject: p.subject, description: p.description, deps: p.deps, files: p.files, plan: true });
      box.send(me, "lead", `Task ${t.id} requested: ${p.subject}`, { kind: "review_request" });
      appendLog(log, "task_requested", { task: t.id, subject: p.subject, requestedBy: me });
      return text(`Task ${t.id} requested: ${p.subject} — pending, awaiting the lead's plan approval.`);
    },
  });
}

/**
 * Team organisation: who is who, who reports to whom, who owns which files — and the working agreements
 * every teammate gets, so a team behaves like an organisation instead of N isolated task runners.
 */
import type { TaskRecord } from "./tasks.ts";

export interface Teammate {
  name: string;
  agent?: string;
  model?: string;
  /** Job title, e.g. "Backend lead". */
  title?: string;
  /** What this person is responsible for (one or two sentences). */
  role?: string;
  /** Escalation path: a teammate name or "lead" (default). */
  reportsTo?: string;
  /** File globs this person owns: ask them before changing anything there. */
  owns?: string[];
}

/** Check names and the reporting line. Returns problems (empty = valid). */
export function validateOrg(mates: Teammate[]): string[] {
  const problems: string[] = [];
  const names = new Set(mates.map((m) => m.name));
  if (names.size !== mates.length) problems.push("teammate names must be unique");
  for (const m of mates) {
    if (m.name === "lead") problems.push('"lead" is reserved for you (the lead)');
    if (m.reportsTo && m.reportsTo !== "lead" && !names.has(m.reportsTo)) problems.push(`${m.name} reports to unknown "${m.reportsTo}"`);
    if (m.reportsTo === m.name) problems.push(`${m.name} cannot report to themselves`);
  }
  for (const m of mates) {
    const seen = new Set<string>([m.name]);
    let cur = m.reportsTo;
    while (cur && cur !== "lead") {
      if (seen.has(cur)) {
        problems.push(`reporting cycle through ${cur}`);
        break;
      }
      seen.add(cur);
      cur = mates.find((x) => x.name === cur)?.reportsTo;
    }
  }
  return [...new Set(problems)];
}

export const managerOf = (mates: Teammate[], name: string): string => mates.find((m) => m.name === name)?.reportsTo ?? "lead";

/** Resolve the aliases `@manager`, `@lead` and `@owner:<path>` to a concrete recipient (or undefined). */
export function resolveRecipient(to: string, mates: Teammate[], me: string): string | undefined {
  if (to === "@manager") return managerOf(mates, me);
  if (to === "@lead") return "lead";
  const own = /^@owner:(.+)$/.exec(to);
  if (own) {
    const p = own[1] as string;
    return mates.find((m) => m.name !== me && m.owns?.some((g) => globMatches(g, p)))?.name;
  }
  return to;
}

/** `dir/**`, `dir/*` and exact paths. Deliberately simple; ownership is a hint for who to ask, not a lock. */
function globMatches(glob: string, file: string): boolean {
  const base = glob.replace(/\/?\*\*?$/, "");
  return file === glob || file === base || file.startsWith(`${base}/`);
}

function activity(name: string, tasks: TaskRecord[]): string {
  const mine = tasks.filter((t) => t.owner === name && t.status === "in_progress");
  if (mine.length) return `working on ${mine.map((t) => `#${t.id} ${t.subject}`).join("; ")}`;
  const waiting = tasks.filter((t) => t.owner === name && t.status === "awaiting_approval");
  if (waiting.length) return `plan for ${waiting.map((t) => `#${t.id}`).join(", ")} awaiting the lead`;
  return "no task right now";
}

/** The org chart + live activity, as shown by `team_directory` and embedded in every task prompt. */
export function renderOrgChart(mates: Teammate[], tasks: TaskRecord[], me?: string): string {
  const lines = ["lead — the human-facing coordinator; assigns work, approves plans, merges"];
  for (const m of mates) {
    const who = `${m.name}${m.title ? ` (${m.title})` : ""}${m.name === me ? "  ← you" : ""}`;
    const parts = [who, `reports to ${m.reportsTo ?? "lead"}`];
    if (m.role) parts.push(`responsible for: ${m.role}`);
    if (m.owns?.length) parts.push(`owns: ${m.owns.join(", ")}`);
    parts.push(activity(m.name, tasks));
    lines.push(parts.join(" — "));
  }
  return lines.join("\n");
}

/** Working agreements. Short on purpose: it is paid for on every task prompt. */
export const TEAM_PROTOCOL = [
  "How we work together:",
  "- Ask the OWNER before changing files someone else owns (team_ask to=@owner:<path>); do not edit around them.",
  "- Blocked or unsure? team_message kind=blocker to @manager. Do not wait silently, and do not guess about interfaces another teammate defines.",
  "- Need an answer to continue? team_ask (waits for the reply). Just informing? team_message kind=info — sparingly, no chatter.",
  "- Finished something others build on? team_message kind=handoff to them: what exists, where, how to use it.",
  "- Made a decision others must respect (API shape, naming, trade-off)? team_decide so it is recorded for everyone.",
  "- Anyone who messages you with a question expects an answer: reply with team_message kind=answer replyTo=<id>.",
  "- Report to your manager when done (the final summary does this); say what you did NOT finish or could not verify.",
].join("\n");

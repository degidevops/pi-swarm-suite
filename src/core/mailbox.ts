import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { assertSafeName } from "./util.ts";

/** What a message is for. Lets receivers triage (a blocker outranks FYI) and lets the lead audit the team. */
export const MESSAGE_KINDS = ["info", "question", "answer", "blocker", "handoff", "review_request", "decision"] as const;
export type MessageKind = (typeof MESSAGE_KINDS)[number];

export interface MailMessage {
  id: string;
  from: string;
  to: string;
  text: string;
  ts: string;
  /** Defaults to "info" for messages written by older versions. */
  kind?: MessageKind;
  /** Id of the message this one answers (set on `answer`). */
  replyTo?: string;
}

export function isMessageKind(v: unknown): v is MessageKind {
  return typeof v === "string" && (MESSAGE_KINDS as readonly string[]).includes(v);
}

function parseLines(raw: string): MailMessage[] {
  const msgs: MailMessage[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      msgs.push(JSON.parse(line) as MailMessage);
    } catch {
      /* skip corrupt line */
    }
  }
  return msgs;
}

export interface SendOptions {
  kind?: MessageKind;
  replyTo?: string;
}

/**
 * File-based inboxes: one JSONL per recipient. Every message is also appended to `<team>/messages.jsonl`
 * (the team-wide conversation record). Reading an inbox is atomic: the file is renamed away first, so a
 * message appended while we read lands in a fresh file instead of being lost.
 */
export class Mailbox {
  private readonly chat: string;
  constructor(private readonly dir: string) {
    fs.mkdirSync(dir, { recursive: true });
    this.chat = path.join(dir, "..", "messages.jsonl");
  }

  private file(name: string): string {
    return path.join(this.dir, `${assertSafeName(name, "teammate name")}.jsonl`);
  }

  send(from: string, to: string, text: string, opts: SendOptions = {}): MailMessage {
    const msg: MailMessage = { id: randomUUID(), from, to, text, ts: new Date().toISOString() };
    if (opts.kind && opts.kind !== "info") msg.kind = opts.kind;
    if (opts.replyTo) msg.replyTo = opts.replyTo;
    const line = `${JSON.stringify(msg)}\n`;
    fs.appendFileSync(this.file(to), line);
    try {
      fs.appendFileSync(this.chat, line);
    } catch {
      /* the audit record is best-effort */
    }
    return msg;
  }

  broadcast(from: string, recipients: string[], text: string, opts: SendOptions = {}): number {
    for (const r of recipients) this.send(from, r, text, opts);
    return recipients.length;
  }

  /** Number of unread messages (cheap: counts lines). */
  unread(name: string): number {
    try {
      return fs.readFileSync(this.file(name), "utf-8").split("\n").filter((l) => l.trim()).length;
    } catch {
      return 0;
    }
  }

  /** Unread messages without consuming them. */
  peek(name: string): MailMessage[] {
    try {
      return parseLines(fs.readFileSync(this.file(name), "utf-8"));
    } catch {
      return [];
    }
  }

  /**
   * Atomically remove and return the unread messages for `name` that satisfy `take` (default: all).
   * Messages that do not match stay in the inbox in their original order. Taken messages are archived
   * to `<name>.read.jsonl`.
   */
  drain(name: string, take: (m: MailMessage) => boolean = () => true): MailMessage[] {
    const f = this.file(name);
    const claimed = `${f}.claim-${process.pid}-${randomUUID().slice(0, 8)}`;
    try {
      fs.renameSync(f, claimed); // atomic: concurrent senders now create a new inbox file
    } catch {
      return [];
    }
    const all = parseLines(fs.readFileSync(claimed, "utf-8"));
    fs.rmSync(claimed, { force: true });
    const taken: MailMessage[] = [];
    const kept: MailMessage[] = [];
    for (const m of all) (take(m) ? taken : kept).push(m);
    if (kept.length) fs.appendFileSync(f, kept.map((m) => JSON.stringify(m)).join("\n") + "\n");
    if (taken.length) fs.appendFileSync(path.join(this.dir, `${name}.read.jsonl`), taken.map((m) => JSON.stringify(m)).join("\n") + "\n");
    return taken;
  }

  /** Newest `limit` messages of the whole team conversation (oldest first). */
  recent(limit = 30): MailMessage[] {
    try {
      return parseLines(fs.readFileSync(this.chat, "utf-8")).slice(-limit);
    } catch {
      return [];
    }
  }
}

/** One line per message for prompts and inbox listings. */
export function formatMessages(msgs: MailMessage[]): string {
  return msgs
    .map((m) => {
      const tag = m.kind && m.kind !== "info" ? ` [${m.kind}]` : "";
      const re = m.replyTo ? ` (re ${m.replyTo.slice(0, 8)})` : "";
      return `- from ${m.from}${tag}${re} (id ${m.id.slice(0, 8)}): ${m.text}`;
    })
    .join("\n");
}

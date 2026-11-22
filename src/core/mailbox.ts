import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { assertSafeName } from "./util.ts";

export interface MailMessage {
  id: string;
  from: string;
  to: string;
  text: string;
  ts: string;
}

/** File-based inboxes: one JSONL per recipient. Unread messages are drained into the next task prompt. */
export class Mailbox {
  constructor(private readonly dir: string) {
    fs.mkdirSync(dir, { recursive: true });
  }

  private file(name: string): string {
    return path.join(this.dir, `${assertSafeName(name, "teammate name")}.jsonl`);
  }

  send(from: string, to: string, text: string): MailMessage {
    const msg: MailMessage = { id: randomUUID(), from, to, text, ts: new Date().toISOString() };
    fs.appendFileSync(this.file(to), `${JSON.stringify(msg)}\n`);
    return msg;
  }

  broadcast(from: string, recipients: string[], text: string): number {
    for (const r of recipients) this.send(from, r, text);
    return recipients.length;
  }

  /** Return and clear all unread messages for `name` (archived to `<name>.read.jsonl`). */
  drain(name: string): MailMessage[] {
    const f = this.file(name);
    if (!fs.existsSync(f)) return [];
    const raw = fs.readFileSync(f, "utf-8");
    fs.rmSync(f, { force: true });
    const msgs: MailMessage[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        msgs.push(JSON.parse(line) as MailMessage);
      } catch {
        /* skip corrupt line */
      }
    }
    if (msgs.length) fs.appendFileSync(path.join(this.dir, `${name}.read.jsonl`), msgs.map((m) => JSON.stringify(m)).join("\n") + "\n");
    return msgs;
  }
}

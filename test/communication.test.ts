import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Mailbox } from "../src/core/mailbox.ts";
import { managerOf, renderOrgChart, resolveRecipient, validateOrg, type Teammate } from "../src/core/org.ts";
import { TaskStore } from "../src/core/tasks.ts";
import { registerChildTools } from "../src/child-tools.ts";
import { JsonlTail, renderEnvFile, shQuote } from "../src/core/tmux-control.ts";
import { slimResult } from "../src/core/tmux-child.ts";
import { AGENT_SCRIPT, TmuxManager } from "../src/core/tmux.ts";

const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));

describe("Mailbox (atomic, typed)", () => {
  it("never loses a message sent while another is being drained", () => {
    const box = new Mailbox(path.join(tmp("mb-"), "inbox"));
    for (let i = 0; i < 200; i++) box.send("a", "b", `m${i}`);
    const got = new Set<string>();
    for (let round = 0; round < 50; round++) {
      for (const m of box.drain("b")) got.add(m.text);
      box.send("a", "b", `late${round}`);
    }
    for (const m of box.drain("b")) got.add(m.text);
    expect(got.size).toBe(200 + 50);
  });

  it("keeps non-matching messages in order and records kind/replyTo and the team chat", () => {
    const dir = tmp("mb2-");
    const box = new Mailbox(path.join(dir, "inbox"));
    const q = box.send("a", "b", "which port?", { kind: "question" });
    box.send("c", "b", "fyi");
    box.send("b", "a", "8080", { kind: "answer", replyTo: q.id });
    const taken = box.drain("a", (m) => m.replyTo === q.id);
    expect(taken).toHaveLength(1);
    expect(box.peek("b").map((m) => m.text)).toEqual(["which port?", "fyi"]);
    expect(box.recent().map((m) => m.text)).toEqual(["which port?", "fyi", "8080"]);
  });
});

describe("org", () => {
  const mates: Teammate[] = [
    { name: "ana", title: "Backend lead", role: "API", owns: ["api/**"] },
    { name: "bo", reportsTo: "ana", owns: ["web/*"] },
  ];
  it("validates names and reporting lines", () => {
    expect(validateOrg(mates)).toEqual([]);
    expect(validateOrg([{ name: "x", reportsTo: "ghost" }])[0]).toMatch(/unknown/);
    expect(validateOrg([{ name: "x", reportsTo: "y" }, { name: "y", reportsTo: "x" }]).join()).toMatch(/cycle/);
    expect(validateOrg([{ name: "lead" }])[0]).toMatch(/reserved/);
  });
  it("resolves @manager, @lead and @owner", () => {
    expect(managerOf(mates, "bo")).toBe("ana");
    expect(resolveRecipient("@manager", mates, "bo")).toBe("ana");
    expect(resolveRecipient("@manager", mates, "ana")).toBe("lead");
    expect(resolveRecipient("@owner:api/routes.ts", mates, "bo")).toBe("ana");
    expect(resolveRecipient("@owner:api/routes.ts", mates, "ana")).toBeUndefined(); // you cannot be your own owner
  });
  it("renders live activity in the chart", () => {
    const store = new TaskStore(path.join(tmp("org-"), "tasks"));
    store.create({ subject: "routes", description: "d" });
    store.update("1", { status: "in_progress", owner: "ana" });
    const chart = renderOrgChart(mates, store.list(), "bo");
    expect(chart).toContain("working on #1 routes");
    expect(chart).toContain("← you");
    expect(chart).toContain("reports to ana");
  });
});

describe("team_ask / answer between two live teammates", () => {
  type Tool = { execute: (...a: unknown[]) => Promise<{ content: { text: string }[] }> };
  const mk = (dir: string, me: string) => {
    const tools = new Map<string, Tool>();
    registerChildTools({ registerTool: (t: { name: string }) => tools.set(t.name, t as never), on: () => undefined } as never, dir, me);
    return tools;
  };

  it("blocks until the owner answers, and returns the answer", async () => {
    const dir = tmp("ask-");
    fs.writeFileSync(path.join(dir, "team.json"), JSON.stringify({ teammates: [{ name: "ana", owns: ["api/**"] }, { name: "bo" }] }));
    const store = new TaskStore(path.join(dir, "tasks"));
    store.create({ subject: "api", description: "d" });
    store.update("1", { status: "in_progress", owner: "ana" });
    const bo = mk(dir, "bo");
    const ana = mk(dir, "ana");
    const asking = bo.get("team_ask")!.execute("i", { to: "@owner:api/x.ts", question: "pagination style?", waitSec: 10 });
    // ana sees the question in her inbox and answers it with the id she was shown.
    await new Promise((r) => setTimeout(r, 300));
    const box = new Mailbox(path.join(dir, "inbox"));
    const q = box.peek("ana")[0]!;
    expect(q.kind).toBe("question");
    await ana.get("team_message")!.execute("i", { to: "bo", text: "cursor-based", replyTo: q.id.slice(0, 8) });
    const r = await asking;
    expect(r.content[0]!.text).toContain("cursor-based");
    expect(box.peek("bo")).toEqual([]); // the answer was consumed by the waiting ask, not left behind
  });

  it("does not wait for someone who is not working", async () => {
    const dir = tmp("ask2-");
    fs.writeFileSync(path.join(dir, "team.json"), JSON.stringify({ teammates: [{ name: "ana" }, { name: "bo" }] }));
    const t0 = Date.now();
    const r = await mk(dir, "bo").get("team_ask")!.execute("i", { to: "ana", question: "hi?", waitSec: 30 });
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(r.content[0]!.text).toMatch(/not working right now/);
  });

  it("records decisions for everyone and notifies the named people", async () => {
    const dir = tmp("dec-");
    fs.writeFileSync(path.join(dir, "team.json"), JSON.stringify({ teammates: [{ name: "ana" }, { name: "bo" }] }));
    await mk(dir, "ana").get("team_decide")!.execute("i", { decision: "IDs are UUIDv7", notify: ["bo"] });
    expect((await mk(dir, "bo").get("team_decisions")!.execute("i", {})).content[0]!.text).toContain("IDs are UUIDv7");
    expect(new Mailbox(path.join(dir, "inbox")).peek("bo")[0]?.kind).toBe("decision");
  });
});

describe("tmux control plumbing", () => {
  it("JsonlTail returns only complete new lines", () => {
    const f = path.join(tmp("tail-"), "e.jsonl");
    fs.writeFileSync(f, '{"a":1}\n{"b":');
    const t = new JsonlTail(f);
    expect(t.read()).toEqual([{ a: 1 }]);
    fs.appendFileSync(f, "2}\n");
    expect(t.read()).toEqual([{ b: 2 }]);
    expect(t.read()).toEqual([]);
  });
  it("quotes env values safely and skips terminal variables", () => {
    expect(shQuote("it's $HOME")).toBe(`'it'\\''s $HOME'`);
    const out = renderEnvFile({ A: "1", TMUX: "x", "BAD-NAME": "y", B: "two words" });
    expect(out).toContain("export A='1'");
    expect(out).toContain("export B='two words'");
    expect(out).not.toContain("TMUX");
    expect(out).not.toContain("BAD-NAME");
  });
  it("slims big tool results", () => {
    const r = slimResult({ content: [{ type: "text", text: "x".repeat(5000) }] }) as { content: { text: string }[] };
    expect(r.content[0]!.text.length).toBeLessThan(2100);
  });
  it("builds the agent window command with argv passed through untouched", () => {
    const calls: string[][] = [];
    const tm = new TmuxManager("/proj", { enabled: true, session: "s" }, (a) => (calls.push(a), { status: 0, stdout: "@1\n", stderr: "" }));
    const name = tm.openAgent({ label: "t/alice#1", cwd: "/w", envFile: "/e.sh", exitFile: "/x", command: "pi", args: ["--tools", "read,bash", "Task: a 'quoted' $thing"] });
    expect(name).toBe("t_alice_1");
    const nw = calls.find((c) => c[0] === "new-window")!;
    const at = nw.indexOf(AGENT_SCRIPT);
    expect(nw.slice(at - 2, at + 7)).toEqual(["sh", "-c", AGENT_SCRIPT, "_", "/e.sh", "/x", "pi", "--tools", "read,bash"]);
    expect(nw).toContain("Task: a 'quoted' $thing"); // no shell interpolation of the task text
  });
  it("tiled layout puts every agent in one window and titles the panes", () => {
    const calls: string[][] = [];
    const tm = new TmuxManager("/proj", { enabled: true, session: "s", layout: "tiled" }, (a) => (calls.push(a), { status: a[0] === "list-panes" && calls.filter((c) => c[0] === "list-panes").length === 1 ? 1 : 0, stdout: "%1\n", stderr: "" }));
    tm.openAgent({ label: "a", cwd: "/w", envFile: "/e", exitFile: "/x", command: "pi", args: [] });
    tm.openAgent({ label: "b", cwd: "/w", envFile: "/e", exitFile: "/x", command: "pi", args: [] });
    expect(calls.filter((c) => c[0] === "new-window" && c.includes("agents"))).toHaveLength(1);
    expect(calls.some((c) => c[0] === "split-window")).toBe(true);
    expect(calls.some((c) => c[0] === "select-layout" && c.includes("tiled"))).toBe(true);
  });
});

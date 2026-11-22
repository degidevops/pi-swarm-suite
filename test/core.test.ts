import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { TaskStore } from "../src/core/tasks.ts";
import { Mailbox } from "../src/core/mailbox.ts";
import { Journal } from "../src/core/journal.ts";
import { Ledger } from "../src/core/ledger.ts";
import { runPool } from "../src/core/pool.ts";
import { parseConfig } from "../src/core/config.ts";
import { readMessage } from "../src/core/worker.ts";
import { assertSafeName, renderTemplate, truncate } from "../src/core/util.ts";
import { runGates } from "../src/core/gates.ts";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "swarm-test-"));

describe("util", () => {
  it("rejects unsafe names (path traversal)", () => {
    expect(() => assertSafeName("../etc")).toThrow();
    expect(() => assertSafeName("a/b")).toThrow();
    expect(assertSafeName("team-1_a")).toBe("team-1_a");
  });
  it("renderTemplate only replaces known vars and ignores $ patterns", () => {
    expect(renderTemplate("a {x} {y} $&", { x: "1$&" })).toBe("a 1$& {y} $&");
  });
  it("truncate marks cut", () => {
    expect(truncate("abcdef", 3)).toContain("truncated 3 chars");
  });
});

describe("TaskStore", () => {
  it("claims in dependency order and is exclusive", () => {
    const s = new TaskStore(path.join(tmp(), "t"));
    s.create({ subject: "a", description: "a" });
    s.create({ subject: "b", description: "b", deps: ["1"] });
    const first = s.claimNext("alice");
    expect(first?.id).toBe("1");
    expect(s.claimNext("bob")).toBeUndefined(); // 2 is blocked on 1, 1 is taken
    s.complete("1", "done", "swarm/x/1");
    expect(s.claimNext("bob")?.id).toBe("2");
  });
  it("rejects unknown deps", () => {
    const s = new TaskStore(path.join(tmp(), "t"));
    expect(() => s.create({ subject: "x", description: "x", deps: ["9"] })).toThrow(/unknown dependency/);
  });
  it("blocks dependents transitively when a task fails", () => {
    const s = new TaskStore(path.join(tmp(), "t"));
    s.create({ subject: "a", description: "" });
    s.create({ subject: "b", description: "", deps: ["1"] });
    s.create({ subject: "c", description: "", deps: ["2"] });
    s.claimNext("x");
    s.fail("1", "boom");
    expect(s.settleBlocked()).toBe(2);
    expect(s.summary().blocked).toBe(2);
  });
  it("resets stale in_progress tasks", () => {
    const s = new TaskStore(path.join(tmp(), "t"));
    s.create({ subject: "a", description: "" });
    s.claimNext("x");
    expect(s.resetStale()).toBe(1);
    expect(s.get("1")?.status).toBe("pending");
  });
});

describe("Mailbox", () => {
  it("delivers once then clears", () => {
    const m = new Mailbox(path.join(tmp(), "in"));
    m.send("lead", "alice", "hello");
    m.broadcast("lead", ["alice", "bob"], "all");
    expect(m.drain("alice").map((x) => x.text)).toEqual(["hello", "all"]);
    expect(m.drain("alice")).toEqual([]);
    expect(m.drain("bob")).toHaveLength(1);
  });
  it("refuses path-traversal recipients", () => {
    const m = new Mailbox(path.join(tmp(), "in"));
    expect(() => m.send("lead", "../x", "no")).toThrow();
  });
});

describe("Journal", () => {
  it("replays entries after reopen and survives a torn last line", () => {
    const f = path.join(tmp(), "j.jsonl");
    const j = new Journal(f);
    j.set("k1", "v1");
    fs.appendFileSync(f, '{"key":"k2","val'); // simulated crash mid-write
    const j2 = new Journal(f);
    expect(j2.get("k1")).toBe("v1");
    expect(j2.get("k2")).toBeUndefined();
  });
});

describe("Ledger", () => {
  it("tracks budget", () => {
    const l = new Ledger(1);
    l.add({ cost: 0.4 });
    expect(l.exceeded()).toBe(false);
    l.add({ cost: 0.6 });
    expect(l.exceeded()).toBe(true);
    l.reset();
    expect(l.exceeded()).toBe(false);
  });

  it("accumulates per-agent usage alongside total", () => {
    const l = new Ledger();
    l.add({ input: 10, output: 5, cost: 1, turns: 1, agent: "alice" });
    l.add({ cost: 2, agent: "alice" });
    l.add({ cost: 5, agent: "bob" });

    expect(l.snapshot()).toEqual({
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 8,
      turns: 1,
    });
    expect(l.agentCost("alice")).toBe(3);
    expect(l.agentCost("bob")).toBe(5);
    expect(l.agentCost("carol")).toBe(0);
    expect(l.snapshotByAgent()).toEqual({
      alice: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 3, turns: 1 },
      bob: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 5, turns: 0 },
    });
  });

  it("returns a copy from snapshotByAgent", () => {
    const l = new Ledger();
    l.add({ cost: 1, agent: "alice" });
    const snap = l.snapshotByAgent();
    snap.alice.cost = 999;
    expect(l.agentCost("alice")).toBe(1);
  });

  it("ignores per-agent tracking when no agent is given", () => {
    const l = new Ledger();
    l.add({ cost: 1 });
    expect(l.snapshotByAgent()).toEqual({});
    expect(l.snapshot().cost).toBe(1);
  });

  it("reset clears per-agent usage", () => {
    const l = new Ledger();
    l.add({ cost: 1, agent: "alice" });
    l.reset();
    expect(l.agentCost("alice")).toBe(0);
    expect(l.snapshotByAgent()).toEqual({});
    expect(l.snapshot().cost).toBe(0);
  });
});

describe("runPool", () => {
  it("respects the concurrency limit", async () => {
    let active = 0;
    let peak = 0;
    await runPool([1, 2, 3, 4, 5, 6], 2, async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 10));
      active--;
    });
    expect(peak).toBe(2);
  });
  it("stops launching after abort", async () => {
    const ac = new AbortController();
    const started: number[] = [];
    await runPool(
      [1, 2, 3, 4],
      1,
      async (n) => {
        started.push(n);
        ac.abort();
      },
      ac.signal,
    );
    expect(started).toEqual([1]);
  });
});

describe("parseConfig", () => {
  it("caps concurrency and reports bad fields instead of throwing", () => {
    const { config, warnings } = parseConfig({ maxConcurrency: 999, gates: ["cargo test", 5], budgetUsd: -1, models: { lead: "a/b" } });
    expect(config.maxConcurrency).toBe(16);
    expect(config.models?.lead).toBe("a/b");
    expect(config.gates).toBeUndefined();
    expect(warnings.length).toBe(2);
  });
  it("rejects non-objects", () => {
    expect(parseConfig(42).warnings).toHaveLength(1);
  });
  it("parses preHooks and postHooks as arrays of non-empty strings", () => {
    const { config, warnings } = parseConfig({ preHooks: ["npm run lint"], postHooks: ["echo done"] });
    expect(config.preHooks).toEqual(["npm run lint"]);
    expect(config.postHooks).toEqual(["echo done"]);
    expect(warnings).toEqual([]);
  });
  it("rejects invalid hooks with a warning", () => {
    const { config, warnings } = parseConfig({ preHooks: ["ok", "", 3], postHooks: null });
    expect(config.preHooks).toBeUndefined();
    expect(config.postHooks).toBeUndefined();
    expect(warnings).toContain("preHooks must be an array of non-empty shell command strings");
    expect(warnings).toContain("postHooks must be an array of non-empty shell command strings");
  });
});

describe("readMessage", () => {
  it("extracts text, tool calls and usage", () => {
    const m = readMessage({
      role: "assistant",
      content: [
        { type: "text", text: "hi" },
        { type: "toolCall", name: "read", arguments: {} },
      ],
      usage: { input: 10, output: 5, cacheRead: 1, cacheWrite: 2, cost: { total: 0.01 } },
    });
    expect(m.text).toBe("hi");
    expect(m.tools).toEqual(["read"]);
    expect(m.usage?.cost).toBe(0.01);
  });
  it("is defensive about garbage", () => {
    expect(readMessage(null).text).toBe("");
    expect(readMessage({ role: "assistant", content: "nope" }).text).toBe("");
  });
  it("surfaces provider errors", () => {
    expect(readMessage({ role: "assistant", content: [], stopReason: "error", errorMessage: "rate limit" }).error).toBe("rate limit");
  });
});

describe("runGates", () => {
  it("stops at the first failing gate", async () => {
    const r = await runGates(["node -e \"process.exit(0)\"", "node -e \"console.error('bad');process.exit(3)\"", "echo never"], process.cwd());
    expect(r.ok).toBe(false);
    expect(r.results).toHaveLength(2);
    expect(r.results[1]?.code).toBe(3);
    expect(r.results[1]?.output).toContain("bad");
  });
});

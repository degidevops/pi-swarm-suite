import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { globToRegExp, outsideScope, scopesOverlap } from "../src/core/scope.ts";
import { buildReviewPrompt, parseVerdict } from "../src/core/review.ts";
import { appendLog, formatLog, readLog } from "../src/core/eventlog.ts";
import { parseConfig, DEFAULT_CONFIG } from "../src/core/config.ts";
import { getPiInvocation } from "../src/core/child.ts";
import { pickTier, Runtime, type WorkerInfo } from "../src/runtime.ts";
import { registerChildTools } from "../src/child-tools.ts";
import { Mailbox } from "../src/core/mailbox.ts";
import { ActivityTracker } from "../src/core/monitor.ts";
import { TaskStore } from "../src/core/tasks.ts";

describe("scope", () => {
  it("matches globs", () => {
    expect(globToRegExp("crates/feed/**").test("crates/feed/src/lib.rs")).toBe(true);
    expect(globToRegExp("crates/feed/**").test("crates/feed-extra/x")).toBe(false);
    expect(globToRegExp("*.md").test("README.md")).toBe(true);
    expect(globToRegExp("*.md").test("docs/a.md")).toBe(false);
    expect(globToRegExp("**/*.ts").test("a/b/c.ts")).toBe(true);
    expect(globToRegExp("src/").test("src/a/b.rs")).toBe(true);
  });
  it("finds files outside scope; no scope = unrestricted", () => {
    expect(outsideScope(["src/a.rs", "x.rs"], ["src/**"])).toEqual(["x.rs"]);
    expect(outsideScope(["x.rs"], undefined)).toEqual([]);
  });
  it("detects overlapping scopes", () => {
    expect(scopesOverlap(["crates/feed/**"], ["crates/feed/src/**"])).toBe(true);
    expect(scopesOverlap(["crates/feed/**"], ["crates/store/**"])).toBe(false);
    expect(scopesOverlap(undefined, ["a/**"])).toBe(false);
  });
});

describe("review", () => {
  it("takes the last explicit verdict", () => {
    expect(parseVerdict("VERDICT: FAIL\n...\nVERDICT: PASS")).toBe("pass");
    expect(parseVerdict("nothing")).toBe("unknown");
    expect(parseVerdict("verdict: fail")).toBe("fail");
  });
  it("builds a prompt that includes the diff and the verdict instruction", () => {
    const p = buildReviewPrompt({ team: "t", taskId: "1", subject: "s", description: "d", diff: "+x" });
    expect(p).toContain("+x");
    expect(p).toContain("VERDICT: PASS");
  });
});

describe("event log", () => {
  it("round-trips and formats", () => {
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "lg-")), "log.jsonl");
    appendLog(f, "task_started", { task: "1" });
    appendLog(f, "task_failed", { task: "1", error: "boom" });
    const ev = readLog(f);
    expect(ev).toHaveLength(2);
    expect(formatLog(ev)).toContain("task_failed task=1 error=boom");
  });
});

describe("config + routing", () => {
  it("parses reviewer", () => {
    expect(parseConfig({ reviewer: "reviewer" }).config.reviewer).toBe("reviewer");
    expect(parseConfig({ reviewer: 3 }).warnings).toHaveLength(1);
  });
  it("auto-tiers read-only agents as cheap", () => {
    expect(pickTier(["read", "grep"])).toBe("cheap");
    expect(pickTier(["read", "bash"])).toBe("worker");
    expect(pickTier(undefined)).toBe("worker");
  });
  it("honours the PI_SWARM_PI_BIN override", () => {
    process.env.PI_SWARM_PI_BIN = "/x/fake.mjs";
    expect(getPiInvocation(["a"]).args).toEqual(["/x/fake.mjs", "a"]);
    process.env.PI_SWARM_PI_BIN = "/usr/bin/mypi";
    expect(getPiInvocation(["a"])).toEqual({ command: "/usr/bin/mypi", args: ["a"] });
    delete process.env.PI_SWARM_PI_BIN;
  });
});

describe("child tools (teammate side)", () => {
  it("messages, reads its inbox, lists tasks, and rejects unknown recipients", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ct-"));
    fs.writeFileSync(path.join(dir, "team.json"), JSON.stringify({ teammates: [{ name: "alice" }, { name: "bob" }] }));
    const tools = new Map<string, { execute: (...a: unknown[]) => Promise<{ content: { text: string }[] }> }>();
    registerChildTools({ registerTool: (t: { name: string }) => tools.set(t.name, t as never), on: () => undefined } as never, dir, "alice");
    expect([...tools.keys()].sort()).toEqual(["team_ask", "team_decide", "team_decisions", "team_directory", "team_inbox", "team_message", "team_task_request", "team_tasks"]);
    await tools.get("team_message")!.execute("i", { to: "bob", text: "api changed" });
    expect(new Mailbox(path.join(dir, "inbox")).drain("bob")[0]?.text).toBe("api changed");
    await expect(tools.get("team_message")!.execute("i", { to: "mallory", text: "x" })).rejects.toThrow(/unknown recipient/);
    await expect(tools.get("team_message")!.execute("i", { to: "alice", text: "x" })).rejects.toThrow(/unknown recipient/);
    new Mailbox(path.join(dir, "inbox")).send("lead", "alice", "hi");
    expect((await tools.get("team_inbox")!.execute("i", {})).content[0]?.text).toContain("from lead");
  });

  it("requests a new task (pending + needsPlan) and validates deps", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ctr-"));
    fs.writeFileSync(path.join(dir, "team.json"), JSON.stringify({ teammates: [{ name: "alice" }, { name: "bob" }] }));
    const tools = new Map<string, { execute: (...a: unknown[]) => Promise<{ content: { text: string }[] }> }>();
    registerChildTools({ registerTool: (t: { name: string }) => tools.set(t.name, t as never), on: () => undefined } as never, dir, "alice");
    const store = new TaskStore(path.join(dir, "tasks"));
    store.create({ subject: "schema", description: "write schema" });
    const r = await tools.get("team_task_request")!.execute("i", { subject: "feed", description: "WRITE:b.txt=2", deps: ["1"], plan: true });
    expect(r.content[0]?.text).toContain("Task 2 requested");
    expect(r.content[0]?.text).toContain("pending");
    const t = store.get("2")!;
    expect(t.status).toBe("pending");
    expect(t.needsPlan).toBe(true);
    expect(t.subject).toBe("feed");
    expect(t.deps).toEqual(["1"]);
    await expect(tools.get("team_task_request")!.execute("i", { subject: "x", description: "d", deps: ["9"] })).rejects.toThrow(/unknown dependency/);
    await expect(tools.get("team_task_request")!.execute("i", { description: "no subject" })).rejects.toThrow(/subject/);
  });
});

describe("DashboardComponent (ROADMAP #2)", () => {
  it("renders workers, jobs, cost, and key hints", async () => {
    const { DashboardComponent } = await import("../src/ui-dashboard.ts");
    const rt = {
      workers: new Map([
        [1, { id: 1, label: "alice#1", status: "running" as const, startedAt: Date.now() - 5000, last: "reading files", steerable: true }],
        [2, { id: 2, label: "bob#2", status: "ok" as const, startedAt: Date.now() - 10000, endedAt: Date.now() - 2000, last: "done", steerable: false }],
      ]),
      jobs: new Map(),
      runningJobs: () => [],
      ledger: {
        snapshot: () => ({ cost: 0.05, input: 1000, output: 500, turns: 3 }),
        budgetUsd: 1.0,
      },
      agentCosts: () => ({ alice: 0.03, bob: 0.02 }),
    } as never;
    const dash = new DashboardComponent(rt);
    const out = dash.render(80);
    const text = out.join("\n");
    expect(text).toContain("Swarm Dashboard");
    expect(text).toContain("alice#1");
    expect(text).toContain("⇄"); // steerable marker
    expect(text).toContain("bob#2");
    expect(text).toContain("Cost:");
    expect(text).toContain("s=steer");
    expect(text).toContain("q=quit");
  });

  it("invalidate() re-renders and shows status message", async () => {
    const { DashboardComponent } = await import("../src/ui-dashboard.ts");
    const rt = {
      workers: new Map(),
      jobs: new Map(),
      runningJobs: () => [],
      ledger: { snapshot: () => ({ cost: 0, input: 0, output: 0, turns: 0 }), budgetUsd: undefined },
      agentCosts: () => ({}),
    } as never;
    const dash = new DashboardComponent(rt);
    dash.setStatus("steered alice#1", "info");
    const out = dash.render(80);
    expect(out.join("\n")).toContain("steered alice#1");
  });
});

describe("Session dir (ROADMAP #3)", () => {
  it("child.ts prepareChild passes --session-dir when sessionDir is set", async () => {
    const { prepareChild } = await import("../src/core/child.ts");
    const p = await prepareChild("json", { cwd: "/tmp", depth: 0, sessionDir: "/tmp/sess/1" }, "task");
    expect(p.args).toContain("--session-dir");
    expect(p.args).toContain("/tmp/sess/1");
    expect(p.args).not.toContain("--no-session");
  });

  it("child.ts prepareChild passes --no-session when sessionDir is not set", async () => {
    const { prepareChild } = await import("../src/core/child.ts");
    const p = await prepareChild("json", { cwd: "/tmp", depth: 0 }, "task");
    expect(p.args).toContain("--no-session");
    expect(p.args).not.toContain("--session-dir");
  });
});

import type { WorkerAttachInfo, JobAttachInfo } from "../src/core/attach.ts";
import {
  writeTeamRunning, readTeamRunning, removeTeamRunning,
  writeWorkerState, readTeamWorkers, removeWorkerState,
  writeJobState, readTeamJobs, removeJobState,
  writeSteerCommand, pollSteerCommands,
  listRunningTeams, hasRunningTeams,
} from "../src/core/attach.ts";

describe("Cross-process attach (ROADMAP #7)", () => {
  it("writeTeamRunning / readTeamRunning round-trip", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "attach-"));
    writeTeamRunning(dir, "alpha", { team: "alpha", startedAt: 1000, mates: ["alice", "bob"], pid: 1234 });
    const info = readTeamRunning(dir, "alpha");
    expect(info).toMatchObject({ team: "alpha", startedAt: 1000, mates: ["alice", "bob"], pid: 1234 });
    removeTeamRunning(dir, "alpha");
    expect(readTeamRunning(dir, "alpha")).toBeUndefined();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("writeWorkerState / readTeamWorkers round-trip", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "attach-"));
    writeWorkerState(dir, "alpha", {
      label: "alpha/alice#1", status: "running", startedAt: 1000, last: "reading files", steerable: true,
    });
    writeWorkerState(dir, "alpha", {
      label: "alpha/bob#2", status: "ok", startedAt: 1001, endedAt: 2000, last: "done", steerable: false,
    });
    const workers: WorkerAttachInfo[] = readTeamWorkers(dir, "alpha");
    expect(workers.map((w) => w.label)).toEqual(["alpha/alice#1", "alpha/bob#2"]);
    expect(workers.find((w) => w.label === "alpha/alice#1")?.status).toBe("running");
    expect(workers.find((w) => w.label === "alpha/bob#2")?.status).toBe("ok");
    removeWorkerState(dir, "alpha", "alpha/alice#1");
    expect(readTeamWorkers(dir, "alpha").map((w) => w.label)).toEqual(["alpha/bob#2"]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("writeJobState / readTeamJobs round-trip", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "attach-"));
    writeJobState(dir, "alpha", { id: "job-1", kind: "team", name: "team:alpha", status: "running", startedAt: 1000 });
    writeJobState(dir, "alpha", { id: "job-2", kind: "team", name: "team:beta", status: "done", startedAt: 1001, endedAt: 2000, result: "ok" });
    const jobs: JobAttachInfo[] = readTeamJobs(dir, "alpha");
    expect(jobs.map((j) => j.id)).toEqual(["job-1", "job-2"]);
    expect(jobs.find((j) => j.id === "job-1")?.status).toBe("running");
    expect(jobs.find((j) => j.id === "job-2")?.status).toBe("done");
    removeJobState(dir, "alpha", "job-1");
    expect(readTeamJobs(dir, "alpha").map((j) => j.id)).toEqual(["job-2"]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("writeSteerCommand / pollSteerCommands round-trip", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "attach-"));
    writeSteerCommand(dir, "alpha", "alpha/alice#1", "first instruction");
    writeSteerCommand(dir, "alpha", "alpha/alice#1", "second instruction");
    const text = pollSteerCommands(dir, "alpha", "alpha/alice#1");
    expect(text).toBe("first instruction\nsecond instruction");
    // Polling again returns undefined (consumed)
    expect(pollSteerCommands(dir, "alpha", "alpha/alice#1")).toBeUndefined();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("listRunningTeams returns teams with running.json", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "attach-"));
    writeTeamRunning(dir, "alpha", { team: "alpha", startedAt: 1000, mates: ["alice"], pid: 1 });
    writeTeamRunning(dir, "beta", { team: "beta", startedAt: 2000, mates: ["bob"], pid: 2 });
    expect(listRunningTeams(dir)).toEqual(["alpha", "beta"]);
    removeTeamRunning(dir, "alpha");
    expect(listRunningTeams(dir)).toEqual(["beta"]);
    removeTeamRunning(dir, "beta");
    expect(listRunningTeams(dir)).toEqual([]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("hasRunningTeams", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "attach-"));
    expect(hasRunningTeams(dir)).toBe(false);
    writeTeamRunning(dir, "alpha", { team: "alpha", startedAt: 1000, mates: ["alice"], pid: 1 });
    expect(hasRunningTeams(dir)).toBe(true);
    removeTeamRunning(dir, "alpha");
    expect(hasRunningTeams(dir)).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("Live widget visibility", () => {
  const mkRt = () => new Runtime(process.cwd(), { ...DEFAULT_CONFIG, models: {} }, true, 0);
  const w = (id: number, status: WorkerInfo["status"], last: string, startedAt = Date.now() - 10_000, endedAt?: number): WorkerInfo => ({
    id, label: `web-team/agent${id}#${id}`, status, startedAt, endedAt, last, steerable: status === "running",
    tracker: new ActivityTracker(), health: "active",
  });

  it("hides finished workers: whole widget collapses once the swarm settles", () => {
    const rt = mkRt();
    rt.workers.set(1, w(1, "ok", "Task complete. Summary:"));
    rt.workers.set(2, w(2, "failed", "tool: read, bash", Date.now() - 76_000));
    expect(rt.widgetLines()).toEqual([]);
  });

  it("hides entirely even when prune() retains finished workers", () => {
    const rt = mkRt();
    for (let i = 1; i <= 4; i++) rt.workers.set(i, w(i, "ok", `result ${i}`, Date.now() - 60_000, Date.now() - 1000 * i));
    expect(rt.workers.size).toBe(4); // retained for /swarm status and /swarm board
    expect(rt.widgetLines()).toEqual([]);
  });

  it("shows only running workers while the swarm is active", () => {
    const rt = mkRt();
    rt.workers.set(1, w(1, "ok", "done", Date.now() - 58_000));
    rt.workers.set(2, w(2, "running", "tool: read, bash"));
    const lines = rt.widgetLines();
    expect(lines[0]).toContain("1 running");
    expect(lines.some((l) => l.startsWith("● "))).toBe(true);
    expect(lines.join("\n")).not.toContain("✓");
    expect(lines.join("\n")).not.toContain("✗");
  });

  it("stays visible while a background job runs even when no worker is running", () => {
    const rt = mkRt();
    rt.jobs.set("job-1", { id: "job-1", kind: "review", name: "review:x", status: "running", startedAt: Date.now() - 5000, controller: new AbortController() });
    const lines = rt.widgetLines();
    expect(lines[0]).toContain("0 running");
    expect(lines[0]).toContain("1 bg job");
  });

  it("statusLines (for /swarm status) still lists recently finished workers", () => {
    const rt = mkRt();
    rt.workers.set(1, w(1, "ok", "Task complete."));
    const lines = rt.statusLines();
    expect(lines[0]).toContain("0 running");
    expect(lines.join("\n")).toContain("✓");
    expect(lines.join("\n")).toContain("web-team/agent1#1");
  });
});

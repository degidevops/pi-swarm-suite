import { describe, expect, it, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { delegateTool } from "../src/modes/delegate.ts";
import { teamTool, mergeTeam, teamDir } from "../src/modes/team.ts";
import { workflowTool } from "../src/modes/workflow.ts";
import { TaskStore } from "../src/core/tasks.ts";
import { readLog } from "../src/core/eventlog.ts";
import { branchExists } from "../src/core/git.ts";
import { agent, ctxFor, mkRepo, mkRuntime, readInvocations, text, wait } from "./helpers.ts";

afterEach(() => {
  delete process.env.PI_SWARM_PI_BIN;
  delete process.env.PI_FAKE_LOG;
});

const run = <T extends { execute: (...a: never[]) => Promise<{ content: { type: string; text?: string }[] }> }>(tool: T, cwd: string, params: unknown) =>
  (tool.execute as unknown as (...a: unknown[]) => Promise<{ content: { type: string; text?: string }[]; details: Record<string, unknown> }>)("id", params, undefined, undefined, ctxFor(cwd));

describe("e2e: delegate", () => {
  it("runs workers in parallel as depth-1 children and sums cost", async () => {
    const cwd = mkRepo();
    const { rt, logFile } = mkRuntime(cwd, { maxConcurrency: 2 });
    const tool = delegateTool(() => rt);
    const r = await run(tool, cwd, { tasks: [{ task: "COST:0.1\nalpha" }, { task: "COST:0.1\nbeta" }, { task: "COST:0.1\ngamma" }] });
    expect(text(r)).toContain("worker#1: ok");
    expect(text(r)).toContain("depth=1");
    expect(rt.ledger.snapshot().cost).toBeCloseTo(0.3, 5);
    expect(readInvocations(logFile).every((i) => i.mode === "json" && i.depth === "1")).toBe(true);
  }, 30_000);

  it("isolates writing tasks in a worktree branch and leaves main untouched", async () => {
    const cwd = mkRepo();
    const { rt } = mkRuntime(cwd);
    const r = await run(delegateTool(() => rt), cwd, { tasks: [{ task: "WRITE:a.txt=hi\nwrite a", worktree: true }] });
    const branch = /\[branch (swarm\/delegate\/[^\]]+)\]/.exec(text(r))?.[1];
    expect(branch).toBeTruthy();
    expect(await branchExists(cwd, branch as string)).toBe(true);
    expect(fs.existsSync(path.join(cwd, "a.txt"))).toBe(false);
  }, 30_000);

  it("workers inherit the parent session model when nothing else is configured", async () => {
    const cwd = mkRepo();
    const { rt, logFile } = mkRuntime(cwd, { models: {} });
    rt.sessionModel = "prov/session-model";
    await run(delegateTool(() => rt), cwd, { tasks: [{ task: "hello" }] });
    const inv = readInvocations(logFile);
    expect(inv).toHaveLength(1);
    expect(inv[0]!.model).toBe("prov/session-model");
  }, 30_000);

  it("an explicit task model beats the session model; config models beat the session model", async () => {
    const cwd = mkRepo();
    const { rt, logFile } = mkRuntime(cwd, { models: { worker: "cfg/worker-model" } });
    rt.sessionModel = "prov/session-model";
    await run(delegateTool(() => rt), cwd, { tasks: [{ task: "a" }, { task: "b", model: "explicit/model" }] });
    const models = readInvocations(logFile).map((i) => i.model);
    expect(models).toContain("explicit/model");
    expect(models).toContain("cfg/worker-model");
    expect(models).not.toContain("prov/session-model");
  }, 30_000);

  it("reports a failing worker without throwing", async () => {
    const cwd = mkRepo();
    const { rt } = mkRuntime(cwd);
    const r = await run(delegateTool(() => rt), cwd, { tasks: [{ task: "FAIL:rate limited" }, { task: "fine" }] });
    expect(text(r)).toContain("worker#1: failed");
    expect(text(r)).toContain("rate limited");
    expect(text(r)).toContain("worker#2: ok");
  }, 30_000);

  it("routes read-only agents to the cheap tier and writers to the worker tier", async () => {
    const cwd = mkRepo();
    const { rt } = mkRuntime(cwd, { models: { cheap: "c/model", worker: "w/model" } }, [agent("scout", ["read", "grep"]), agent("dev", ["read", "write"])]);
    const r = await run(delegateTool(() => rt), cwd, { tasks: [{ task: "x", agent: "scout" }, { task: "y", agent: "dev" }] });
    expect(text(r)).toMatch(/scout#1: ok\nok \[model=c\/model/);
    expect(text(r)).toMatch(/dev#2: ok\nok \[model=w\/model/);
  }, 30_000);
});

const team = (cwd: string, extra: Record<string, unknown> = {}) => ({ name: "t1", teammates: [{ name: "alice", agent: "dev" }, { name: "bob", agent: "dev" }], ...extra });
const devAgents = [agent("dev", ["read", "write", "bash"]), agent("reviewer", ["read", "grep"])];

describe("e2e: team", () => {
  it("builds dependent tasks, chains branches, runs gates, and merges only on human command", async () => {
    const cwd = mkRepo();
    const { rt, logFile } = mkRuntime(cwd, { gates: ["test -f a.txt"], maxConcurrency: 2 }, devAgents);
    const tool = teamTool(() => rt);
    await run(tool, cwd, {
      action: "create",
      ...team(cwd),
      tasks: [
        { subject: "schema", description: "WRITE:a.txt=1" },
        { subject: "feed", description: "WRITE:b.txt=2", deps: ["1"] }, // gate needs a.txt => dep branch must be merged in
        { subject: "agg", description: "WRITE:c.txt=3", deps: ["1"] },
      ],
    });
    const r = text(await run(tool, cwd, { action: "run", ...team(cwd) }));
    expect(r).toContain("3 done");
    expect(r).toContain("/swarm merge t1");
    expect(fs.existsSync(path.join(cwd, "b.txt"))).toBe(false); // nothing merged yet
    const inv = readInvocations(logFile).filter((i) => i.mode === "rpc");
    expect(inv.length).toBeGreaterThanOrEqual(3);
    expect(inv.every((i) => i.tools?.includes("team_message") && i.ext === "/fake/ext/index.ts")).toBe(true);

    const merged = await mergeTeam(rt, "t1");
    expect(merged).not.toContain("✗");
    for (const f of ["a.txt", "b.txt", "c.txt"]) expect(fs.existsSync(path.join(cwd, f))).toBe(true);
  }, 60_000);

  it("enforces file-ownership scope and retries with feedback", async () => {
    const cwd = mkRepo();
    const { rt } = mkRuntime(cwd, { maxAttempts: 2 }, devAgents);
    const tool = teamTool(() => rt);
    await run(tool, cwd, {
      action: "create",
      name: "t2",
      teammates: [{ name: "alice", agent: "dev" }],
      tasks: [{ subject: "feed", description: "WRITE:src/ok.txt=1\nWRITE_BAD:other.txt=oops", files: ["src/**"] }],
    });
    const r = text(await run(tool, cwd, { action: "run", name: "t2" }));
    expect(r).toContain("1 done");
    const log = readLog(path.join(teamDir(cwd, "t2"), "log.jsonl"));
    expect(log.some((e) => e.type === "attempt_failed" && e.why === "scope")).toBe(true);
    expect(new TaskStore(path.join(teamDir(cwd, "t2"), "tasks")).get("1")?.attempts).toBe(1); // claim counted once; retry is in-task
  }, 60_000);

  it("fails a task whose gate never passes and blocks its dependents", async () => {
    const cwd = mkRepo();
    const { rt } = mkRuntime(cwd, { gates: ["node -e \"process.exit(1)\""], maxAttempts: 2 }, devAgents);
    const tool = teamTool(() => rt);
    await run(tool, cwd, { action: "create", name: "t3", teammates: [{ name: "alice", agent: "dev" }], tasks: [{ subject: "a", description: "WRITE:a.txt=1" }, { subject: "b", description: "x", deps: ["1"] }] });
    const r = text(await run(tool, cwd, { action: "run", name: "t3" }));
    expect(r).toContain("1 failed");
    expect(r).toContain("1 blocked");
    expect(await branchExists(cwd, "swarm/t3/1")).toBe(false); // failed work is not left behind
  }, 60_000);

  it("holds a task for plan approval, then implements with the approved plan", async () => {
    const cwd = mkRepo();
    const { rt } = mkRuntime(cwd, {}, devAgents);
    const tool = teamTool(() => rt);
    await run(tool, cwd, { action: "create", name: "t4", teammates: [{ name: "alice", agent: "dev" }], tasks: [{ subject: "risky", description: "WRITE:r.txt=1", plan: true }] });
    const first = text(await run(tool, cwd, { action: "run", name: "t4" }));
    expect(first).toContain("1 awaiting approval");
    expect(first).toContain("PLAN: 1. do the thing");
    expect(fs.existsSync(path.join(cwd, "r.txt"))).toBe(false);
    await run(tool, cwd, { action: "approve", name: "t4", taskId: "1", text: "go" });
    const second = text(await run(tool, cwd, { action: "run", name: "t4" }));
    expect(second).toContain("1 done");
    expect(new TaskStore(path.join(teamDir(cwd, "t4"), "tasks")).get("1")?.result).toContain("APPROVED_PLAN");
  }, 60_000);

  it("team_task_add creates a pending task needing plan approval", async () => {
    const cwd = mkRepo();
    const { rt } = mkRuntime(cwd, {}, devAgents);
    const tool = teamTool(() => rt);
    await run(tool, cwd, { action: "create", name: "t9", teammates: [{ name: "alice", agent: "dev" }], tasks: [{ subject: "schema", description: "WRITE:a.txt=1" }] });
    const r = text(await run(tool, cwd, { action: "team_task_add", name: "t9", subject: "feed", description: "WRITE:b.txt=2" }));
    expect(r).toContain("Task 2 requested");
    expect(r).toContain("pending");
    const store = new TaskStore(path.join(teamDir(cwd, "t9"), "tasks"));
    const t = store.get("2")!;
    expect(t.status).toBe("pending");
    expect(t.needsPlan).toBe(true);
    expect(t.plan).toBeUndefined();
    const log = readLog(path.join(teamDir(cwd, "t9"), "log.jsonl"));
    expect(log.some((e) => e.type === "task_requested")).toBe(true);
    // Rejects missing subject/description.
    await expect(run(tool, cwd, { action: "team_task_add", name: "t9", subject: "x" })).rejects.toThrow(/subject/);
    await expect(run(tool, cwd, { action: "team_task_add", name: "t9", description: "d" })).rejects.toThrow(/description/);
    // Full flow: run plans it, approve, run implements it.
    const first = text(await run(tool, cwd, { action: "run", name: "t9" }));
    expect(first).toContain("2. [awaiting_approval]");
    expect(first).toContain("PLAN: 1. do the thing");
    await run(tool, cwd, { action: "approve", name: "t9", taskId: "2", text: "go" });
    const second = text(await run(tool, cwd, { action: "run", name: "t9" }));
    expect(second).toContain("2 done");
    expect(store.get("2")?.result).toContain("APPROVED_PLAN");
    expect(fs.existsSync(path.join(cwd, "b.txt"))).toBe(false);
  }, 60_000);

  it("rejects a change when the independent reviewer says FAIL, then accepts the fix", async () => {
    const cwd = mkRepo();
    const { rt } = mkRuntime(cwd, { reviewer: "reviewer", maxAttempts: 2 }, devAgents);
    const tool = teamTool(() => rt);
    await run(tool, cwd, { action: "create", name: "t5", teammates: [{ name: "alice", agent: "dev" }], tasks: [{ subject: "x", description: "WRITE:g.txt=1\nWRITE_BAD:f.txt=FAILREVIEW" }] });
    const r = text(await run(tool, cwd, { action: "run", name: "t5" }));
    expect(r).toContain("1 done");
    const log = readLog(path.join(teamDir(cwd, "t5"), "log.jsonl"));
    expect(log.some((e) => e.type === "attempt_failed" && e.why === "review")).toBe(true);
    expect(new TaskStore(path.join(teamDir(cwd, "t5"), "tasks")).get("1")?.review).toContain("VERDICT: PASS");
  }, 60_000);

  it("stops at the budget and leaves unfinished tasks resumable", async () => {
    const cwd = mkRepo();
    const { rt } = mkRuntime(cwd, { budgetUsd: 0.15, maxConcurrency: 1 }, devAgents);
    const tool = teamTool(() => rt);
    await run(tool, cwd, {
      action: "create",
      name: "t6",
      teammates: [{ name: "alice", agent: "dev" }],
      tasks: [1, 2, 3].map((n) => ({ subject: `t${n}`, description: `COST:0.1\nWRITE:f${n}.txt=1` })),
    });
    const r = text(await run(tool, cwd, { action: "run", name: "t6" }));
    expect(r).toContain("budget exceeded");
    const s = new TaskStore(path.join(teamDir(cwd, "t6"), "tasks")).summary();
    expect(s.completed).toBeLessThan(3);
    expect(s.pending + s.completed + s.failed).toBe(3);
  }, 60_000);

  it("delivers a teammate message live by steering the running worker", async () => {
    const cwd = mkRepo();
    const { rt } = mkRuntime(cwd, {}, devAgents);
    const tool = teamTool(() => rt);
    await run(tool, cwd, { action: "create", name: "t7", teammates: [{ name: "alice", agent: "dev" }], tasks: [{ subject: "talk", description: "MSG:@self|ping from child\nSLEEP:2500" }] });
    await run(tool, cwd, { action: "run", name: "t7" });
    const result = new TaskStore(path.join(teamDir(cwd, "t7"), "tasks")).get("1")?.result ?? "";
    expect(result).toContain("STEERED:");
    expect(result).toContain("ping from child");
  }, 60_000);

  it("runs in the background and notifies when the job settles", async () => {
    const cwd = mkRepo();
    const { rt } = mkRuntime(cwd, {}, devAgents);
    const done: string[] = [];
    rt.onJobDone = (j) => done.push(`${j.id}:${j.status}:${j.result?.slice(0, 20)}`);
    const tool = teamTool(() => rt);
    await run(tool, cwd, { action: "create", name: "t8", teammates: [{ name: "alice", agent: "dev" }], tasks: [{ subject: "x", description: "WRITE:z.txt=1" }] });
    const started = text(await run(tool, cwd, { action: "run", name: "t8", background: true }));
    expect(started).toContain("job-1");
    for (let i = 0; i < 100 && !done.length; i++) await wait(200);
    expect(done[0]).toMatch(/^job-1:done:Team t8/);
  }, 60_000);
});

describe("e2e: steering", () => {
  it("steers a running RPC worker mid-flight and shuts it down cleanly", async () => {
    const cwd = mkRepo();
    const { rt } = mkRuntime(cwd);
    const p = rt.run({ label: "w", task: "SLEEP:1500\nlong job", steerable: true });
    await wait(500);
    expect(rt.steerableLabels()).toContain("w");
    expect(rt.steer("w", "switch to plan B")).toBe(true);
    const res = await p;
    expect(res.status).toBe("ok");
    expect(res.output).toContain("STEERED:switch to plan B");
    expect(rt.steer("w", "too late")).toBe(false);
  }, 30_000);

  it("auto-cancels extension dialogs so a headless worker never hangs", async () => {
    const cwd = mkRepo();
    const { rt } = mkRuntime(cwd);
    const res = await rt.run({ label: "d", task: "DIALOG:ask\nwork", steerable: true });
    expect(res.status).toBe("ok");
    expect(res.output).toContain("DIALOG_CANCELLED");
  }, 30_000);

  it("aborts an RPC worker via abortAll", async () => {
    const cwd = mkRepo();
    const { rt } = mkRuntime(cwd);
    const p = rt.run({ label: "w", task: "SLEEP:20000", steerable: true });
    await wait(400);
    rt.abortAll("test");
    expect((await p).status).toBe("aborted");
  }, 30_000);
});

describe("e2e: workflow", () => {
  const stages = [
    { id: "scan", kind: "fanout", items: ["a", "b", "c"], template: "audit {item}" },
    { id: "reduce", kind: "single", from: "scan", template: "merge:\n{results}" },
  ];

  it("fans out, reduces, and resumes from the journal without re-running anything", async () => {
    const cwd = mkRepo();
    const { rt, logFile } = mkRuntime(cwd);
    const tool = workflowTool(() => rt);
    const first = await run(tool, cwd, { stages, runId: "r1" });
    expect(text(first)).toContain("2/2 stages");
    expect(text(first)).toContain("4 step(s) executed, 0 replayed");
    expect(readInvocations(logFile)).toHaveLength(4);
    const again = await run(tool, cwd, { stages, runId: "r1" });
    expect(text(again)).toContain("0 step(s) executed, 4 replayed");
    expect(readInvocations(logFile)).toHaveLength(4); // no new processes
  }, 60_000);

  it("resumes only the failed steps after a partial failure", async () => {
    const cwd = mkRepo();
    const { rt, logFile } = mkRuntime(cwd);
    const tool = workflowTool(() => rt);
    const bad = [{ id: "s", kind: "fanout", items: ["ok1", "FAIL:boom"], template: "{item}" }];
    const first = text(await run(tool, cwd, { stages: bad, runId: "r2" }));
    expect(first).toContain("1 failed step");
    expect(first).toContain('runId="r2"');
    const n = readInvocations(logFile).length;
    await run(tool, cwd, { stages: bad, runId: "r2" });
    expect(readInvocations(logFile).length).toBe(n + 1); // only the failed item re-ran
  }, 60_000);

  it("gives each fanout item its own worktree branch when asked", async () => {
    const cwd = mkRepo();
    const { rt } = mkRuntime(cwd);
    const r = await run(workflowTool(() => rt), cwd, { runId: "r3", stages: [{ id: "w", kind: "fanout", worktree: true, items: ["p", "q"], template: "WRITE:{item}.txt=x\ndo {item}" }] });
    expect(text(r)).toContain("branches (not merged): swarm/wf/r3-w-0, swarm/wf/r3-w-1");
    expect(fs.existsSync(path.join(cwd, "p.txt"))).toBe(false);
  }, 60_000);

  it("rejects invalid workflows before spending anything", async () => {
    const cwd = mkRepo();
    const { rt, logFile } = mkRuntime(cwd);
    await expect(run(workflowTool(() => rt), cwd, { stages: [{ id: "a", kind: "fanout", template: "x" }] })).rejects.toThrow(/Invalid workflow/);
    expect(readInvocations(logFile)).toHaveLength(0);
  });
});

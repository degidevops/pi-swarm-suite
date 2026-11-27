import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { teamTool, teamDir } from "../src/modes/team.ts";
import { TaskStore } from "../src/core/tasks.ts";
import { Mailbox } from "../src/core/mailbox.ts";
import { readLog } from "../src/core/eventlog.ts";
import { readPresence } from "../src/core/presence.ts";
import { branchExists } from "../src/core/git.ts";
import { agent, ctxFor, mkRepo, mkRuntime, readInvocations, text, wait } from "./helpers.ts";

afterEach(() => {
  delete process.env.PI_SWARM_PI_BIN;
  delete process.env.PI_FAKE_LOG;
});
const exec = (tool: { execute: unknown }, cwd: string, params: unknown) =>
  (tool.execute as (...a: unknown[]) => Promise<{ content: { type: string; text?: string }[] }>)("id", params, undefined, undefined, ctxFor(cwd));
const dev = agent("dev", ["read", "write", "edit", "bash"]);
const num = (s: string, k: string) => Number(new RegExp(`${k}=(\\d+)`).exec(s)?.[1]);

describe("Runtime: resident workers", () => {
  it("runs several tasks in the SAME process, in order, with per-turn output", async () => {
    const cwd = mkRepo();
    const { rt, logFile } = mkRuntime(cwd, {}, [dev]);
    const turn = (label: string, task: string) => rt.run({ label, task, resident: "t/ana", cwd, agent: dev, steerable: true });
    const [a, b, c] = await Promise.all([turn("t/ana#1", "one WHOAMI"), turn("t/ana#2", "two WHOAMI"), turn("t/ana#3", "three WHOAMI")]);
    expect([a, b, c].every((r) => r.status === "ok")).toBe(true);
    expect(new Set([a, b, c].map((r) => num(r.output, "pid"))).size).toBe(1); // one process
    expect([a, b, c].map((r) => num(r.output, "turn"))).toEqual([1, 2, 3]); // serialised, in call order
    expect(a.output).toContain("one");
    expect(c.output).toContain("three");
    expect(readInvocations(logFile)).toHaveLength(1);
    expect(rt.hasResident("t/ana")).toBe(true);
    await rt.closeResidents("t/");
    expect(rt.hasResident("t/ana")).toBe(false);
  }, 30_000);

  it("replaces a resident that died, instead of failing every later task", async () => {
    const cwd = mkRepo();
    const { rt, logFile } = mkRuntime(cwd, {}, [dev]);
    const first = await rt.run({ label: "t/ana#1", task: "a WHOAMI", resident: "t/ana", cwd, agent: dev });
    await rt.closeResidents("t/"); // simulates a crash/kill
    const second = await rt.run({ label: "t/ana#2", task: "b WHOAMI", resident: "t/ana", cwd, agent: dev });
    expect(second.status).toBe("ok");
    expect(num(second.output, "pid")).not.toBe(num(first.output, "pid"));
    expect(readInvocations(logFile)).toHaveLength(2);
    await rt.closeResidents();
  }, 30_000);

  it("after an aborted turn the resident takes the next task", async () => {
    const cwd = mkRepo();
    const { rt } = mkRuntime(cwd, {}, [dev]);
    const ctl = new AbortController();
    const slow = rt.run({ label: "t/ana#1", task: "SLEEP:20000\nWHOAMI", resident: "t/ana", cwd, agent: dev, signal: ctl.signal });
    await wait(600);
    ctl.abort();
    expect((await slow).status).not.toBe("ok");
    const next = await rt.run({ label: "t/ana#2", task: "fine WHOAMI", resident: "t/ana", cwd, agent: dev });
    expect(next.status).toBe("ok");
    await rt.closeResidents();
  }, 40_000);
});

describe("team: resident teammates", () => {
  it("one process and one stable working directory per teammate across tasks; branches stay per task", async () => {
    const cwd = mkRepo();
    const { rt, logFile } = mkRuntime(cwd, { maxConcurrency: 1 }, [dev]);
    const tool = teamTool(() => rt);
    await exec(tool, cwd, {
      action: "create",
      name: "r1",
      teammates: [{ name: "ana", agent: "dev" }],
      tasks: [
        { subject: "first", description: "WRITE:a.txt=1\nWHOAMI" },
        { subject: "second", description: "WRITE:b.txt=2\nWHOAMI", deps: ["1"] },
      ],
    });
    const out = text(await exec(tool, cwd, { action: "run", name: "r1" }));
    expect(out).toContain("2 done");
    const store = new TaskStore(path.join(teamDir(cwd, "r1"), "tasks"));
    const [t1, t2] = [store.get("1")!, store.get("2")!];
    expect(num(t1.result ?? "", "pid")).toBe(num(t2.result ?? "", "pid"));
    expect([num(t1.result ?? "", "turn"), num(t2.result ?? "", "turn")]).toEqual([1, 2]);
    expect(/cwd=(\S+)/.exec(t1.result ?? "")?.[1]).toBe(/cwd=(\S+)/.exec(t2.result ?? "")?.[1]);
    expect(readInvocations(logFile).filter((i) => i.mode === "rpc")).toHaveLength(1);
    // per-task branches survive; the second one contains the first one's work (dependency chaining)
    expect(await branchExists(cwd, "swarm/r1/1")).toBe(true);
    expect(await branchExists(cwd, "swarm/r1/2")).toBe(true);
    // everything is cleaned up afterwards: no residents, no presence, no leftover home worktree
    expect(rt.hasResident("r1/ana")).toBe(false);
    expect(readPresence(teamDir(cwd, "r1"), "ana")).toBeUndefined();
    expect(fs.readdirSync(path.join(cwd, ".pi", "swarm", "worktrees")).filter((n) => n.includes("home"))).toEqual([]);
    expect(fs.existsSync(path.join(cwd, "b.txt"))).toBe(false); // nothing merged without the human
  }, 60_000);

  it("the second task is told it is the same teammate continuing", async () => {
    const cwd = mkRepo();
    const { rt } = mkRuntime(cwd, { maxConcurrency: 1 }, [dev]);
    const tool = teamTool(() => rt);
    await exec(tool, cwd, {
      action: "create",
      name: "r2",
      teammates: [{ name: "ana", agent: "dev" }],
      tasks: [
        { subject: "first", description: "x" },
        { subject: "second", description: "y", deps: ["1"] },
      ],
    });
    await exec(tool, cwd, { action: "run", name: "r2" });
    const store = new TaskStore(path.join(teamDir(cwd, "r2"), "tasks"));
    expect(store.get("2")?.result).toBeTruthy();
    expect(store.get("1")?.result).not.toContain("CONTINUING");
    expect(store.get("2")?.result).toContain("CONTINUING");
  }, 60_000);

  it("wakes an IDLE resident teammate to answer a question while a colleague is still busy", async () => {
    const cwd = mkRepo();
    const { rt } = mkRuntime(cwd, { maxConcurrency: 2, worktrees: false }, [dev]);
    const tool = teamTool(() => rt);
    await exec(tool, cwd, {
      action: "create",
      name: "r3",
      teammates: [{ name: "ana", agent: "dev" }, { name: "bo", agent: "dev" }],
      tasks: [
        { subject: "quick", description: "WHOAMI" }, // ana (or bo) finishes at once and goes idle
        { subject: "slow", description: "SLEEP:4000\nWHOAMI" },
      ],
    });
    const dir = teamDir(cwd, "r3");
    const running = exec(tool, cwd, { action: "run", name: "r3" });
    // wait until somebody is an idle resident, then ask them a question from the other teammate
    let idle: string | undefined;
    for (let i = 0; i < 60 && !idle; i++) {
      await wait(100);
      idle = ["ana", "bo"].find((m) => readPresence(dir, m) === "idle");
    }
    expect(idle).toBeTruthy();
    new Mailbox(path.join(dir, "inbox")).send(idle === "ana" ? "bo" : "ana", idle as string, "which port do we use?", { kind: "question" });
    const out = text(await running);
    expect(out).toContain("2 done");
    const events = readLog(path.join(dir, "log.jsonl"));
    expect(events.some((e) => e.type === "woke" && e.mate === idle)).toBe(true);
  }, 60_000);
});

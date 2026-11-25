import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ActivityTracker, DEFAULT_MONITOR, assess, describePhase, describeProbe, type MonitorConfig } from "../src/core/monitor.ts";
import { WorkLog, pruneOldRuns, safeFileName, tailLog, workersDir } from "../src/core/worklog.ts";
import { TmuxManager, sessionNameFor, type ExecResult, type TmuxExec } from "../src/core/tmux.ts";
import { parseConfig } from "../src/core/config.ts";
import { agent, mkRepo, mkRuntime, wait } from "./helpers.ts";

const cfg = (o: Partial<MonitorConfig> = {}): MonitorConfig => ({ ...DEFAULT_MONITOR, ...o });
const T0 = 1_000_000;

describe("ActivityTracker", () => {
  it("follows the event stream through phases", () => {
    const t = new ActivityTracker(T0);
    expect(t.phase).toBe("starting");
    t.feed({ type: "agent_start" }, T0 + 1);
    expect(t.phase).toBe("waiting");
    t.feed({ type: "message_update", assistantMessageEvent: { type: "thinking_delta" } }, T0 + 2);
    expect(t.phase).toBe("thinking");
    t.feed({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "x" } }, T0 + 3);
    expect(t.phase).toBe("writing");
    t.feed({ type: "tool_execution_start", toolCallId: "a", toolName: "bash" }, T0 + 1000);
    expect(t.phase).toBe("tool");
    const s = t.snapshot(T0 + 46_000);
    expect(describePhase(s)).toBe("tool:bash 45s");
    expect(s.toolsRunning).toBe(1);
    t.feed({ type: "tool_execution_end", toolCallId: "a", toolName: "bash" }, T0 + 47_000);
    expect(t.phase).toBe("waiting");
    t.feed({ type: "agent_settled", aborted: false }, T0 + 48_000);
    expect(t.phase).toBe("idle");
  });

  it("tracks parallel tools and retry/compaction phases", () => {
    const t = new ActivityTracker(T0);
    t.feed({ type: "tool_execution_start", toolCallId: "a", toolName: "read" }, T0 + 1);
    t.feed({ type: "tool_execution_start", toolCallId: "b", toolName: "grep" }, T0 + 2);
    expect(describePhase(t.snapshot(T0 + 1001))).toBe("tool:read+1 1s");
    t.feed({ type: "tool_execution_end", toolCallId: "a" }, T0 + 3);
    expect(t.phase).toBe("tool"); // grep still running
    t.feed({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, errorMessage: "529" }, T0 + 4);
    expect(describePhase(t.snapshot(T0 + 5))).toBe("retry 1/3");
    t.feed({ type: "compaction_start", reason: "threshold" }, T0 + 6);
    expect(t.phase).toBe("compacting");
  });

  it("ignores RPC responses so a get_state probe cannot make a hung worker look alive", () => {
    const t = new ActivityTracker(T0);
    t.feed({ type: "response", command: "get_state", success: true }, T0 + 50_000);
    expect(t.events).toBe(0);
    expect(t.snapshot(T0 + 60_000).idleMs).toBe(60_000);
  });
});

describe("assess", () => {
  const c = cfg({ idleWarnSec: 60, idleKillSec: 300, slowPhaseFactor: 3 });
  it("is active, then quiet, then stalled as silence grows (normal phase)", () => {
    const t = new ActivityTracker(T0);
    t.feed({ type: "message_update", assistantMessageEvent: { type: "text_delta" } }, T0);
    expect(assess(t.snapshot(T0 + 30_000), c).health).toBe("active");
    expect(assess(t.snapshot(T0 + 61_000), c).health).toBe("quiet");
    const a = assess(t.snapshot(T0 + 301_000), c);
    expect(a.health).toBe("stalled");
    expect(a.reason).toMatch(/no events for 5m01s while writing/);
  });

  it("gives running tools and slow model calls more slack", () => {
    const t = new ActivityTracker(T0);
    t.feed({ type: "tool_execution_start", toolCallId: "a", toolName: "bash" }, T0);
    expect(assess(t.snapshot(T0 + 100_000), c).health).toBe("active"); // 100s < 60*3
    expect(assess(t.snapshot(T0 + 200_000), c).health).toBe("quiet");
    expect(assess(t.snapshot(T0 + 901_000), c).health).toBe("stalled"); // 300*3
  });

  it("never flags a settled agent, and 0 disables a threshold", () => {
    const t = new ActivityTracker(T0);
    t.feed({ type: "agent_settled" }, T0);
    expect(assess(t.snapshot(T0 + 9_999_000), c).health).toBe("active");
    const t2 = new ActivityTracker(T0);
    t2.feed({ type: "message_update", assistantMessageEvent: { type: "text_delta" } }, T0);
    expect(assess(t2.snapshot(T0 + 9_999_000), cfg({ idleKillSec: 0 })).health).toBe("quiet");
    expect(assess(t2.snapshot(T0 + 9_999_000), cfg({ idleWarnSec: 0, idleKillSec: 0 })).health).toBe("active");
  });

  it("enforces maxWorkerSec as a wall-clock cap even for a chatty worker", () => {
    const t = new ActivityTracker(T0);
    t.feed({ type: "message_update", assistantMessageEvent: { type: "text_delta" } }, T0 + 99_000);
    const a = assess(t.snapshot(T0 + 100_000), cfg({ maxWorkerSec: 100 }));
    expect(a.health).toBe("stalled");
    expect(a.overtime).toBe(true);
  });

  it("describes probe results", () => {
    expect(describeProbe({ responsive: false })).toMatch(/hung/);
    expect(describeProbe({ responsive: true, isStreaming: true })).toMatch(/model response in progress/);
    expect(describeProbe({ responsive: true, isStreaming: false })).toMatch(/blocked in a tool/);
  });
});

describe("WorkLog", () => {
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "worklog-"));

  it("sanitises labels", () => {
    expect(safeFileName("team/alice#3 (x)")).toBe("team_alice_3_x_");
    expect(safeFileName("///")).toBe("worker");
  });

  it("renders events as readable lines, buffers deltas, and marks completion", () => {
    const dir = tmp();
    const log = new WorkLog(dir, "team/a#1");
    log.event({ type: "message_start", message: { role: "user", content: "do the thing" } });
    log.event({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Hel" } });
    log.event({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "lo\nwor" } });
    log.event({ type: "message_update", assistantMessageEvent: { type: "text_end" } });
    log.event({ type: "tool_execution_start", toolCallId: "t", toolName: "bash", args: { command: "npm test" } });
    log.event({ type: "tool_execution_end", toolCallId: "t", toolName: "bash", isError: true, durationMs: 1500, result: { content: [{ type: "text", text: "boom" }] } });
    log.note("quiet: no events for 1m");
    log.close("failed", "stalled");
    const txt = fs.readFileSync(log.path, "utf-8");
    expect(txt).toMatch(/prompt: do the thing/);
    expect(txt).toMatch(/ {2}Hello\n/);
    expect(txt).toMatch(/ {2}wor\n/);
    expect(txt).toMatch(/▶ bash \{"command":"npm test"\}/);
    expect(txt).toMatch(/■ bash ERROR 1\.5s: boom/);
    expect(txt).toMatch(/\[monitor\] quiet/);
    expect(txt).toMatch(/worker finished: failed/);
    expect(fs.existsSync(log.doneFile)).toBe(true);
    expect(tailLog(log.path, 2)).toHaveLength(2);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("prunes old run directories but keeps the current one", () => {
    const cwd = tmp();
    const base = workersDir(cwd);
    for (const id of ["20250101-000001", "20250101-000002", "20250101-000003", "20250101-000004"]) fs.mkdirSync(path.join(base, id), { recursive: true });
    pruneOldRuns(cwd, "20250101-000004", 2);
    expect(fs.readdirSync(base).sort()).toEqual(["20250101-000003", "20250101-000004"]);
    fs.rmSync(cwd, { recursive: true, force: true });
  });
});

describe("TmuxManager", () => {
  const fake = (failNewWindow = 0) => {
    const calls: string[][] = [];
    let sessionUp = false;
    let nw = failNewWindow;
    const exec: TmuxExec = (args): ExecResult => {
      calls.push(args);
      const ok = { status: 0, stdout: "", stderr: "" };
      const no = { status: 1, stdout: "", stderr: "x" };
      if (args[0] === "-V") return { ...ok, stdout: "tmux 3.4" };
      if (args[0] === "has-session") return sessionUp ? ok : no;
      if (args[0] === "new-session") { sessionUp = true; return ok; }
      if (args[0] === "new-window") { if (nw > 0) { nw--; sessionUp = false; return no; } return ok; }
      if (args[0] === "list-windows") return { ...ok, stdout: "monitor\nworker\n" };
      if (args[0] === "kill-session") { sessionUp = false; return ok; }
      return ok;
    };
    return { exec, calls };
  };

  it("derives a tmux-safe session name", () => {
    expect(sessionNameFor("/home/me/my.project")).toBe("swarm-my_project");
    expect(sessionNameFor("/x", "a:b.c")).toBe("a_b_c");
  });

  it("does nothing when disabled", () => {
    const { exec, calls } = fake();
    const t = new TmuxManager("/p/proj", { enabled: false }, exec);
    expect(t.openWorker("w", "/l", "/l.done", "/p")).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it("creates the session with a monitor window, then one window per worker (argv, no shell interpolation)", () => {
    const { exec, calls } = fake();
    const t = new TmuxManager("/p/proj", { enabled: true }, exec);
    const name = t.openWorker("team/alice#1", "/logs/a.log", "/logs/a.log.done", "/wt/alice");
    expect(name).toBe("team_alice_1");
    const ns = calls.find((c) => c[0] === "new-session")!;
    expect(ns).toContain("monitor");
    const nw = calls.find((c) => c[0] === "new-window")!;
    expect(nw).toEqual(expect.arrayContaining(["-d", "-n", "team_alice_1", "-c", "/wt/alice", "/logs/a.log", "/logs/a.log.done"]));
    expect(nw.slice(-2)).toEqual(["/logs/a.log", "/logs/a.log.done"]);
    // duplicate labels get unique window names
    expect(t.openWorker("team/alice#1", "/logs/b.log", "/logs/b.log.done", "/wt")).toBe("team_alice_1-2");
    expect(t.attachCommand()).toBe("tmux attach -t swarm-proj");
  });

  it("recovers when the user killed the session meanwhile", () => {
    const { exec } = fake(1);
    const t = new TmuxManager("/p/proj", { enabled: true }, exec);
    expect(t.openWorker("w", "/l", "/l.done", "/p")).toBe("w");
  });

  it("is a no-op without tmux installed", () => {
    const t = new TmuxManager("/p", { enabled: true }, () => ({ status: null, stdout: "", stderr: "ENOENT" }));
    expect(t.openWorker("w", "/l", "/l.done", "/p")).toBeUndefined();
  });
});

describe("monitor/tmux config parsing", () => {
  it("accepts valid settings", () => {
    const { config, warnings } = parseConfig({ monitor: { idleWarnSec: 30, idleKillSec: 120, probe: false, tickMs: 100 }, tmux: true });
    expect(warnings).toEqual([]);
    expect(config.monitor).toEqual({ idleWarnSec: 30, idleKillSec: 120, probe: false, tickMs: 100 });
    expect(config.tmux).toEqual({ enabled: true });
  });
  it("reports bad values without throwing", () => {
    const { warnings } = parseConfig({ monitor: { idleWarnSec: -1, probe: "yes", idleKillSec: 10, idleWarnSec2: 1 }, tmux: 5 });
    expect(warnings.join("\n")).toMatch(/idleWarnSec/);
    expect(warnings.join("\n")).toMatch(/probe must be a boolean/);
    expect(warnings.join("\n")).toMatch(/tmux must be/);
  });
});

describe("Runtime watchdog (fake pi)", () => {
  const fast = { idleWarnSec: 0.25, idleKillSec: 0.7, slowPhaseFactor: 1, tickMs: 50 };

  it("kills a silent one-shot worker and reports it as a FAILURE (so team mode retries it)", async () => {
    const cwd = mkRepo();
    const { rt } = mkRuntime(cwd, { monitor: fast });
    const alerts: string[] = [];
    rt.onAlert = (a) => alerts.push(a.kind);
    const res = await rt.run({ label: "silent", task: "SLEEP:20000", agent: agent("worker") });
    expect(res.status).toBe("failed");
    expect(res.error).toMatch(/^stalled: no events for/);
    expect(alerts).toEqual(["quiet", "stalled"]);
    const info = rt.findWorker("silent")!;
    const log = fs.readFileSync(info.logPath!, "utf-8");
    expect(log).toMatch(/\[monitor\] quiet/);
    expect(log).toMatch(/killing worker/);
    expect(fs.existsSync(`${info.logPath}.done`)).toBe(true);
  }, 15_000);

  it("does not kill a worker that keeps emitting events, however long it runs", async () => {
    const cwd = mkRepo();
    const { rt } = mkRuntime(cwd, { monitor: fast });
    const res = await rt.run({ label: "busy", task: "CHATTER:1500", agent: agent("worker"), steerable: true });
    expect(res.status).toBe("ok");
    const log = fs.readFileSync(rt.findWorker("busy")!.logPath!, "utf-8");
    expect(log).toMatch(/▶ bash/);
    expect(log).toMatch(/■ bash ok/);
    expect(log).not.toMatch(/killing worker/);
  }, 15_000);

  it("probes a quiet RPC worker and records that its process is responsive", async () => {
    const cwd = mkRepo();
    const { rt } = mkRuntime(cwd, { monitor: { ...fast, idleKillSec: 1.2 } });
    const res = await rt.run({ label: "slow", task: "SLEEP:20000", agent: agent("worker"), steerable: true });
    expect(res.status).toBe("failed");
    const info = rt.findWorker("slow")!;
    expect(info.probe?.responsive).toBe(true);
    expect(res.error).toMatch(/responsive/);
  }, 15_000);

  it("/swarm kill path: killWorker stops one worker and reports failure", async () => {
    const cwd = mkRepo();
    const { rt } = mkRuntime(cwd, { monitor: { idleWarnSec: 0, idleKillSec: 0 } });
    const p = rt.run({ label: "victim", task: "SLEEP:20000", agent: agent("worker"), steerable: true });
    await wait(500);
    expect(rt.killWorker("victim")).toBe(true);
    const res = await p;
    expect(res.status).toBe("failed");
    expect(res.error).toMatch(/^killed: killed by user/);
    expect(rt.killWorker("victim")).toBe(false); // already finished
  }, 15_000);

  it("inspect() and monitorLines() expose phase, idle time, log path and how to talk to the worker", async () => {
    const cwd = mkRepo();
    const { rt } = mkRuntime(cwd, { monitor: { idleWarnSec: 0, idleKillSec: 0 } });
    const p = rt.run({ label: "team/bob#2", task: "SLEEP:1200", agent: agent("worker"), steerable: true });
    await wait(500);
    const card = rt.inspect("bob")!; // substring match
    expect(card).toMatch(/team\/bob#2 — running/);
    expect(card).toMatch(/doing: /);
    expect(card).toMatch(/tail -F/);
    expect(card).toMatch(/\/swarm say team\/bob#2/);
    expect(rt.monitorLines().join("\n")).toMatch(/team\/bob#2 ⇄/);
    expect(rt.widgetLines().join("\n")).toMatch(/idle|waiting|starting/);
    await p;
    expect(rt.inspect("nope")).toBeUndefined();
  }, 15_000);
});

// Real tmux + real interactive pi + scripted OpenAI-compatible model. Skipped when tmux or the pi binary is missing.
import { describe, expect, it, afterAll } from "vitest";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Runtime } from "../src/runtime.ts";
import { DEFAULT_CONFIG } from "../src/core/config.ts";

const PI = path.resolve(fileURLToPath(new URL("../node_modules/.bin/pi", import.meta.url)));
const haveTmux = spawnSync("tmux", ["-V"]).status === 0;
const can = haveTmux && fs.existsSync(PI);

const seenTools: string[][] = [];
function mockModel(): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const payload = JSON.parse(body || "{}") as { model?: string; tools?: { function: { name: string } }[]; messages?: { role: string; content: unknown }[] };
      const lastUser = [...(payload.messages ?? [])].reverse().find((m) => m.role === "user");
      const echo = typeof lastUser?.content === "string" ? lastUser.content : JSON.stringify(lastUser?.content ?? "");
      seenTools.push((payload.tools ?? []).map((t) => t.function.name));
      const base = { id: "c", object: "chat.completion.chunk", created: 1, model: payload.model };
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const chunks = [
        { ...base, choices: [{ index: 0, delta: { role: "assistant", content: `REPORT: hello from the tmux agent | saw: ${echo.slice(0, 200)}` }, finish_reason: null }] },
        { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } },
      ];
      for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, port: (server.address() as { port: number }).port })));
}

describe.skipIf(!can)("tmux: every agent is a real pi in its own window", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-tmux-"));
  const work = path.join(home, "work");
  const session = `swarmtest_${process.pid}`;
  let server: http.Server | undefined;
  afterAll(() => {
    spawnSync("tmux", ["kill-session", "-t", `=${session}`]);
    server?.close();
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("runs the task in a tmux window, returns the result, keeps the window for inspection", async () => {
    const m = await mockModel();
    server = m.server;
    const agentDir = path.join(home, "agent");
    fs.mkdirSync(agentDir, { recursive: true });
    fs.mkdirSync(work, { recursive: true });
    fs.writeFileSync(
      path.join(agentDir, "models.json"),
      JSON.stringify({ providers: { mock: { baseUrl: `http://127.0.0.1:${m.port}/v1`, apiKey: "x", api: "openai-completions", models: [{ id: "mock-1", name: "mock-1", contextWindow: 100000, maxTokens: 4096 }] } } }),
    );
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.PI_OFFLINE = "1";
    process.env.PI_SWARM_PI_BIN = PI;
    execFileSync("git", ["init", "-q"], { cwd: work });

    const rt = new Runtime(work, { ...DEFAULT_CONFIG, tmux: { enabled: true, session } }, false, 0);
    rt.extPath = fileURLToPath(new URL("../src/index.ts", import.meta.url));
    const res = await rt.run({ label: "worker/one", task: "Say hello", model: "mock/mock-1" });

    expect(res.status).toBe("ok");
    expect(res.output).toContain("REPORT: hello from the tmux agent");
    expect(res.usage.turns).toBeGreaterThan(0);

    const windows = rt.tmux.listWindows();
    expect(windows).toContain("worker_one");
    // The window is the agent itself: after it finishes it shows the pi session and then a shell.
    await new Promise((r) => setTimeout(r, 500));
    const pane = spawnSync("tmux", ["capture-pane", "-p", "-t", `=${session}:worker_one`], { encoding: "utf-8" }).stdout;
    expect(pane).toMatch(/hello from the tmux agent|agent exited/);
    // The environment file (may contain API keys) must not be left on disk.
    const leftovers = fs.readdirSync(path.join(work, ".pi", "swarm", "workers"), { recursive: true }).map(String).filter((f) => f.endsWith("env.sh"));
    expect(leftovers).toEqual([]);
  }, 120_000);

  it("a RESIDENT agent in tmux keeps one pi and one window across several tasks", async () => {
    const rt = new Runtime(work, { ...DEFAULT_CONFIG, tmux: { enabled: true, session } }, false, 0);
    rt.extPath = fileURLToPath(new URL("../src/index.ts", import.meta.url));
    const turn = (n: number, task: string) => rt.run({ label: `res/ana#${n}`, task, resident: "res/ana", cwd: work, model: "mock/mock-1" });
    const a = await turn(1, "FIRST-TASK please");
    const b = await turn(2, "SECOND-TASK please");
    expect(a.status).toBe("ok");
    expect(b.status).toBe("ok");
    expect(a.output).toContain("FIRST-TASK");
    expect(b.output).toContain("SECOND-TASK"); // the idle pi started a new turn for the second task
    expect(b.output).not.toContain("FIRST-TASK"); // per-turn output, not the previous turn's
    expect(rt.hasResident("res/ana")).toBe(true);
    const windows = rt.tmux.listWindows().filter((w) => w.startsWith("res_ana"));
    expect(windows).toEqual(["res_ana"]); // ONE window for both tasks
    await rt.closeResidents("res/");
    expect(rt.hasResident("res/ana")).toBe(false);
    const pane = spawnSync("tmux", ["capture-pane", "-p", "-S", "-200", "-t", `=${session}:res_ana`], { encoding: "utf-8" }).stdout;
    expect(pane).toMatch(/FIRST-TASK[\s\S]*SECOND-TASK|agent exited/); // both tasks happened in that one window
  }, 120_000);

  it("a team worker in tmux gets the team tools (ask, directory, decide) and the control channel", async () => {
    const teamDir = path.join(work, ".pi", "swarm", "teams", "t1");
    fs.mkdirSync(teamDir, { recursive: true });
    fs.writeFileSync(path.join(teamDir, "team.json"), JSON.stringify({ name: "t1", createdAt: "x", teammates: [{ name: "ana", title: "Lead" }] }));
    const rt = new Runtime(work, { ...DEFAULT_CONFIG, tmux: { enabled: true, session } }, false, 0);
    rt.extPath = fileURLToPath(new URL("../src/index.ts", import.meta.url));
    seenTools.length = 0;
    const res = await rt.run({ label: "t1/ana#1", task: "Say hello", model: "mock/mock-1", tools: ["read"], team: { dir: teamDir, mate: "ana" }, steerable: true });
    expect(res.status).toBe("ok");
    const offered = seenTools.flat();
    for (const t of ["team_ask", "team_message", "team_directory", "team_decide", "team_decisions", "team_inbox", "team_tasks"]) expect(offered).toContain(t);
    expect(rt.tmux.listWindows()).toContain("t1_ana_1");
  }, 120_000);
});

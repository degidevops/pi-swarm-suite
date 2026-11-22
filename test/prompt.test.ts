import { describe, expect, it, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import swarmSuite from "../src/index.ts";
import { delegateTool } from "../src/modes/delegate.ts";
import { teamTool } from "../src/modes/team.ts";
import { workflowTool } from "../src/modes/workflow.ts";
import { BUILT_IN_AGENTS, discoverAgents } from "../src/core/agents.ts";
import { buildSwarmSection, detectCompetitorTools, summarizeCompetitors, SWARM_TOOL_NAMES } from "../src/core/prompt.ts";
import { doctorReport } from "../src/core/doctor.ts";
import { Runtime } from "../src/runtime.ts";
import { DEFAULT_CONFIG } from "../src/core/config.ts";
import { agent, FAKE_PI, mkRepo, readInvocations } from "./helpers.ts";

const getRt = (_cwd: string) => new Runtime(process.cwd(), { ...DEFAULT_CONFIG, models: {} }, true, 0);

describe("built-in agents", () => {
  it("ships reviewer, researcher, planner, oracle and worker with focused prompts", () => {
    const names = BUILT_IN_AGENTS.map((a) => a.name).sort();
    expect(names).toEqual(["oracle", "planner", "researcher", "reviewer", "worker"]);
    for (const a of BUILT_IN_AGENTS) {
      expect(a.systemPrompt.length).toBeGreaterThan(40);
      expect(a.source).toBe("builtin");
    }
    const reviewer = BUILT_IN_AGENTS.find((a) => a.name === "reviewer")!;
    expect(reviewer.tools).not.toContain("edit");
    expect(reviewer.tools).not.toContain("write");
    expect(reviewer.systemPrompt).toContain("VERDICT");
    const worker = BUILT_IN_AGENTS.find((a) => a.name === "worker")!;
    expect(worker.tools).toEqual(expect.arrayContaining(["edit", "write"]));
  });

  it("resolveAgent finds built-ins on a fresh install (cold start, no agent files)", () => {
    const rt = new Runtime(process.cwd(), { ...DEFAULT_CONFIG, models: {} }, false, 0);
    rt.agents = discoverAgents(process.cwd(), false);
    expect(rt.resolveAgent("reviewer")?.source).toBe("builtin");
    expect(rt.resolveAgent("researcher")?.systemPrompt).toContain("researcher");
    expect(rt.resolveAgent("worker")?.tools).toContain("write");
  });

  it("user and project agent files override built-ins by name", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-home-"));
    const agentsDir = path.join(home, "agents");
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentsDir, "reviewer.md"),
      "---\nname: reviewer\ndescription: my own reviewer\ntools: read\n---\nBe strict.\n",
    );
    vi.stubEnv("PI_CODING_AGENT_DIR", home);
    try {
      const map = discoverAgents(process.cwd(), false);
      expect(map.get("reviewer")?.source).toBe("user");
      expect(map.get("reviewer")?.description).toBe("my own reviewer");
      expect(map.get("worker")?.source).toBe("builtin");
      expect(map.size).toBeGreaterThanOrEqual(BUILT_IN_AGENTS.length);
    } finally {
      vi.unstubAllEnvs();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("resolveAgent error suggests built-ins and custom agent paths", () => {
    const rt = new Runtime(process.cwd(), { ...DEFAULT_CONFIG, models: {} }, false, 0);
    rt.agents = discoverAgents(process.cwd(), false);
    expect(() => rt.resolveAgent("nonexistent")).toThrow(/Built-ins \(reviewer, researcher, planner, oracle, worker\)/);
  });
});

describe("prompt snippets and guidelines", () => {
  const tools = [delegateTool(getRt), teamTool(getRt), workflowTool(getRt)];

  it("every snippet is a concrete call example without a duplicated tool-name prefix", () => {
    for (const t of tools) {
      expect(t.promptSnippet).toMatch(new RegExp(`^${t.name}\\(`));
      expect(t.promptSnippet).not.toMatch(new RegExp(`^${t.name}:\\s`));
      expect(t.promptSnippet).not.toContain("\n");
    }
  });

  it("swarm_delegate snippet demonstrates agent routing", () => {
    const d = delegateTool(getRt);
    expect(d.promptSnippet).toContain('"reviewer"');
    expect(d.promptSnippet).toContain("worktree");
  });

  it("delegate guidelines teach role routing", () => {
    const g = delegateTool(getRt).promptGuidelines ?? [];
    expect(g.join(" ")).toMatch(/reviewer.*researcher.*planner.*oracle.*worker/);
  });

  it("descriptions mention built-in agents so cold-start routing works", () => {
    for (const t of tools) expect(t.description).toMatch(/reviewer|worker/);
  });
});

describe("competitor detection", () => {
  it("detects acp_delegate family tools as competitors", () => {
    const found = detectCompetitorTools(["read", "bash", "edit", "write", "acp_delegate", "acp_delegate_wait", "acp_delegate_cancel"]);
    expect(found).toEqual(["acp_delegate", "acp_delegate_cancel", "acp_delegate_wait"]);
  });

  it("never flags our own tools or child messaging tools", () => {
    expect(detectCompetitorTools(["read", "swarm_delegate", "swarm_team", "swarm_workflow", "team_message", "team_inbox"])).toEqual([]);
  });

  it("flags other delegation-style packages", () => {
    expect(detectCompetitorTools(["read", "subagent_run", "dispatch_task", "crew_spawn"])).toEqual([
      "crew_spawn",
      "dispatch_task",
      "subagent_run",
    ]);
  });

  it("summarizes helper variants under their base tool", () => {
    expect(summarizeCompetitors(["acp_delegate", "acp_delegate_wait", "acp_delegate_cancel"])).toEqual(["acp_delegate (and helpers)"]);
  });
});

describe("swarm_orchestration prompt section", () => {
  it("teaches mode routing, built-in agents and the core rules", () => {
    const s = buildSwarmSection([]);
    expect(s).toContain("swarm_delegate");
    expect(s).toContain("swarm_team");
    expect(s).toContain("swarm_workflow");
    expect(s).toContain("reviewer");
    expect(s).toContain("VERDICT");
    expect(s).toContain("do it yourself");
    expect(s).toContain("/swarm merge");
  });

  it("stays neutral when there is no competitor (no preference paragraph)", () => {
    expect(buildSwarmSection([])).not.toContain("Tool preference");
  });

  it("adds an explicit preference paragraph when acp_delegate is present", () => {
    const s = buildSwarmSection(["acp_delegate"]);
    expect(s).toContain("Tool preference");
    expect(s).toContain("acp_delegate");
    expect(s).toMatch(/Prefer the swarm_\* tools for delegation/);
  });

  it("is single blocks without stray blank tails", () => {
    const s = buildSwarmSection([]);
    expect(s.startsWith("SWARM ORCHESTRATION")).toBe(true);
    expect(s.endsWith("\n")).toBe(false);
  });
});

describe("before_agent_start wiring", () => {
  type Handler = (ev: unknown) => Promise<unknown>;
  const handlers = new Map<string, Handler>();

  function fakePi() {
    handlers.clear();
    return {
      registerTool: () => undefined,
      registerCommand: () => undefined,
      on: (name: string, h: Handler) => {
        handlers.set(name, h);
        return () => undefined;
      },
    } as never;
  }

  afterEach(() => {
    delete process.env.PI_SWARM_DEPTH;
  });

  const mkEvent = (selectedTools: string[]) => ({
    type: "before_agent_start",
    messageType: "user",
    prompt: "x",
    systemPrompt: "",
    systemPromptOptions: { selectedTools, sections: {} as Record<string, string> },
  });

  it("injects the section and detects competitors on each turn", async () => {
    swarmSuite(fakePi());
    const h = handlers.get("before_agent_start")!;
    const ev = mkEvent(["read", "bash", "swarm_delegate", "acp_delegate"]);
    await h(ev);
    expect(ev.systemPromptOptions.sections.swarm_orchestration).toContain("Tool preference");
    expect(ev.systemPromptOptions.sections.swarm_orchestration).toContain("acp_delegate");
  });

  it("injects a neutral section without competitors", async () => {
    swarmSuite(fakePi());
    const ev = mkEvent(["read", "bash", "swarm_delegate", "swarm_team", "swarm_workflow"]);
    await handlers.get("before_agent_start")!(ev);
    expect(ev.systemPromptOptions.sections.swarm_orchestration).toContain("SWARM ORCHESTRATION");
    expect(ev.systemPromptOptions.sections.swarm_orchestration).not.toContain("Tool preference");
  });

  it("removes the section when swarm tools are disabled mid-session", async () => {
    swarmSuite(fakePi());
    const ev = mkEvent(["read", "bash", "acp_delegate"]); // swarm tools deselected
    await handlers.get("before_agent_start")!(ev);
    expect(ev.systemPromptOptions.sections.swarm_orchestration).toBeUndefined();
  });

  it("registers nothing inside a swarm child", () => {
    process.env.PI_SWARM_DEPTH = "1";
    const f = fakePi();
    swarmSuite(f);
    expect(handlers.size).toBe(0);
  });
});

describe("/swarm doctor report", () => {
  it("reports tools, agents, config and competitor advice", () => {
    const rt = new Runtime(process.cwd(), { ...DEFAULT_CONFIG, models: {} }, true, 0);
    rt.agents = discoverAgents(process.cwd(), false);
    const report = doctorReport({
      runtime: rt,
      extPath: "/x/src/index.ts",
      activeTools: ["read", "swarm_delegate", "swarm_team", "swarm_workflow", "acp_delegate"],
      competitorTools: ["acp_delegate"],
    });
    expect(report).toContain("swarm doctor");
    expect(report).toContain("acp_delegate");
    expect(report).toContain("swarm_delegate");
    expect(report).toContain("reviewer");
    expect(report).toContain("maxConcurrency");
  });

  it("knows the billion-context opt-out when the package is installed", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-home-"));
    fs.mkdirSync(path.join(home), { recursive: true });
    fs.writeFileSync(path.join(home, "settings.json"), JSON.stringify({ packages: ["npm:billion-context"] }));
    vi.stubEnv("PI_CODING_AGENT_DIR", home);
    try {
      const rt = new Runtime(process.cwd(), { ...DEFAULT_CONFIG, models: {} }, true, 0);
      rt.agents = discoverAgents(process.cwd(), false);
      const report = doctorReport({ runtime: rt, activeTools: ["swarm_delegate", "acp_delegate"], competitorTools: ["acp_delegate"] });
      expect(report).toMatch(/billion-context.*delegate.*false/);
    } finally {
      vi.unstubAllEnvs();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("flags a non-git project and missing budget", () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-plain-"));
    try {
      const rt = new Runtime(plain, { ...DEFAULT_CONFIG, models: {} }, true, 0);
      rt.agents = discoverAgents(plain, false);
      const report = doctorReport({ runtime: rt, activeTools: ["swarm_delegate"], competitorTools: [] });
      expect(report).toContain("NOT a git repo");
      expect(report).toContain("budgetUsd");
    } finally {
      fs.rmSync(plain, { recursive: true, force: true });
    }
  });
});

describe("cold-start delegation e2e (built-in reviewer, fake pi)", () => {
  it("swarm_delegate resolves agent:'reviewer' with no agent files and passes the built-in prompt to the worker", async () => {
    const repo = mkRepo();
    const logFile = path.join(os.tmpdir(), `fake-log-${Math.random().toString(36).slice(2)}.jsonl`);
    process.env.PI_SWARM_PI_BIN = FAKE_PI;
    process.env.PI_FAKE_LOG = logFile;
    const rt = new Runtime(repo, { ...DEFAULT_CONFIG, models: {} }, true, 0);
    rt.agents = discoverAgents(repo, false); // no user/project agent files: built-ins only
    try {
      const tool = delegateTool(() => rt);
      const res = await tool.execute(
        "call-1",
        { tasks: [{ task: "Review this repo", agent: "reviewer" }] },
        new AbortController().signal,
        undefined,
        { cwd: repo } as never,
      );
      const text = res.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
      expect(text).toContain("## reviewer#1: ok");
      const invocations = readInvocations(logFile);
      expect(invocations).toHaveLength(1);
      // the worker received the built-in reviewer system prompt (--append-system-prompt)
      expect(invocations[0]?.sys).toContain("independent code reviewer");
      // and the read-only-ish tool set from the built-in definition
      expect(String(invocations[0]?.tools)).toContain("read");
    } finally {
      delete process.env.PI_SWARM_PI_BIN;
      delete process.env.PI_FAKE_LOG;
      fs.rmSync(repo, { recursive: true, force: true });
      fs.rmSync(logFile, { force: true });
    }
  }, 30_000);
});

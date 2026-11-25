import { describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { discoverAgents } from "../src/core/agents.ts";
import { Runtime } from "../src/runtime.ts";
import { DEFAULT_CONFIG } from "../src/core/config.ts";

const mkRt = (cfg: Partial<typeof DEFAULT_CONFIG> = {}) => new Runtime(process.cwd(), { ...DEFAULT_CONFIG, models: {}, customRolesOnly: false, ...cfg }, false, 0);

describe("custom agents / roles", () => {
  it("picks up an agent file written after session start (no reload needed)", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-home-"));
    vi.stubEnv("PI_CODING_AGENT_DIR", home);
    try {
      const rt = mkRt();
      rt.agents = discoverAgents(process.cwd(), false);
      rt.reloadAgents = () => discoverAgents(process.cwd(), false);
      expect(() => rt.resolveAgent("db-auditor")).toThrow(/Unknown agent/);

      fs.mkdirSync(path.join(home, "agents"), { recursive: true });
      fs.writeFileSync(path.join(home, "agents", "db-auditor.md"), "---\nname: db-auditor\ndescription: sql\ntools: read, grep\n---\nAudit SQL.\n");
      expect(rt.resolveAgent("db-auditor")?.tools).toEqual(["read", "grep"]);

      // editing an existing override is also seen immediately
      fs.writeFileSync(path.join(home, "agents", "researcher.md"), "---\nname: researcher\ndescription: r\ntools: read, write\n---\nx\n");
      expect(rt.resolveAgent("researcher")?.tools).toContain("write");
    } finally {
      vi.unstubAllEnvs();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("inlineAgent: role appends to the base prompt, tools replace the allowlist", () => {
    const rt = mkRt();
    rt.agents = discoverAgents(process.cwd(), false);
    const base = rt.resolveAgent("researcher");
    const a = rt.inlineAgent(base, { role: "Focus on tests.", tools: ["read", "bash"] }, "inline#1")!;
    expect(a.source).toBe("inline");
    expect(a.tools).toEqual(["read", "bash"]);
    expect(a.systemPrompt).toContain("codebase researcher");
    expect(a.systemPrompt.endsWith("Focus on tests.")).toBe(true);
    expect(a.tier).toBe("cheap"); // inherited from base
  });

  it("inlineAgent: no base agent -> role alone; nothing inline -> base returned untouched", () => {
    const rt = mkRt();
    rt.agents = discoverAgents(process.cwd(), false);
    const solo = rt.inlineAgent(undefined, { role: "You audit." }, "inline#2")!;
    expect(solo.systemPrompt).toBe("You audit.");
    expect(solo.name).toBe("inline#2");
    const base = rt.resolveAgent("worker");
    expect(rt.inlineAgent(base, {}, "x")).toBe(base);
    expect(rt.inlineAgent(undefined, {}, "x")).toBeUndefined();
  });

  it("an unreadable reload keeps the cached agents", () => {
    const rt = mkRt();
    rt.agents = discoverAgents(process.cwd(), false);
    rt.reloadAgents = () => {
      throw new Error("boom");
    };
    expect(rt.resolveAgent("reviewer")?.source).toBe("builtin");
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { discoverAgents } from "../src/core/agents.ts";
import { parseConfig, DEFAULT_CONFIG } from "../src/core/config.ts";
import { Runtime } from "../src/runtime.ts";
import { agentTool } from "../src/modes/agent.ts";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";

let home: string;
let proj: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-home-"));
  proj = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-proj-"));
  vi.stubEnv("PI_CODING_AGENT_DIR", home);
});
afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(proj, { recursive: true, force: true });
});

const mk = (trusted = true): Runtime => {
  const rt = new Runtime(proj, { ...DEFAULT_CONFIG, models: {} }, trusted, 0); // customRolesOnly defaults to true
  rt.agents = discoverAgents(proj, trusted);
  rt.reloadAgents = () => discoverAgents(proj, trusted);
  return rt;
};
const run = (rt: Runtime, p: Record<string, unknown>) => agentTool(() => rt).execute("id", p as never, new AbortController().signal, undefined, { cwd: proj } as never);
const out = (r: { content: { type: string; text?: string }[] }) => r.content.map((c) => c.text ?? "").join("\n");

describe("customRolesOnly (default)", () => {
  it("is on by default and can be turned off in swarm.json", () => {
    expect(DEFAULT_CONFIG.customRolesOnly).toBe(true);
    expect(parseConfig({ customRolesOnly: false }).config.customRolesOnly).toBe(false);
    expect(parseConfig({ customRolesOnly: "no" }).warnings.join()).toMatch(/customRolesOnly/);
  });

  it("refuses built-ins and global user agents, and a missing agent, with instructions to use swarm_agent", () => {
    fs.mkdirSync(path.join(home, "agents"), { recursive: true });
    fs.writeFileSync(path.join(home, "agents", "global.md"), "---\nname: global\ndescription: g\n---\nx\n");
    const rt = mk();
    expect(() => rt.resolveAgent("reviewer")).toThrow(/built-in example.*swarm_agent/s);
    expect(() => rt.resolveAgent("global")).toThrow(/global user agent/);
    expect(() => rt.resolveAgent(undefined)).toThrow(/define the role you need with swarm_agent/);
    expect(() => rt.resolveAgent("nope")).toThrow(/Define it first/);
  });

  it("allows an inline role without an agent, but not without a role", () => {
    const rt = mk();
    expect(rt.resolveAgent(undefined, { inlineRole: true })).toBeUndefined();
  });
});

describe("swarm_agent", () => {
  it("define writes a per-project file that loads at once and passes strict resolution", async () => {
    const rt = mk();
    const res = out(await run(rt, { action: "define", name: "db-auditor", description: "Audits: SQL \"migrations\"", tools: ["read", "grep"], prompt: "Audit SQL.\n---\nNever write." }));
    const file = path.join(proj, ".pi", "agents", "db-auditor.md");
    expect(res).toContain(file);
    const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(fs.readFileSync(file, "utf-8"));
    expect(frontmatter.name).toBe("db-auditor");
    expect(frontmatter.description).toBe('Audits: SQL "migrations"');
    expect(body).toContain("Never write.");
    const a = rt.resolveAgent("db-auditor")!;
    expect(a.source).toBe("project");
    expect(a.tools).toEqual(["read", "grep"]);
    expect(fs.existsSync(path.join(home, "agents", "db-auditor.md"))).toBe(false); // never global
  });

  it("refuses to overwrite without overwrite:true, and rejects unsafe names", async () => {
    const rt = mk();
    await run(rt, { action: "define", name: "a1", description: "d", prompt: "p" });
    await expect(run(rt, { action: "define", name: "a1", description: "d", prompt: "p2" })).rejects.toThrow(/already exists/);
    await run(rt, { action: "define", name: "a1", description: "d", prompt: "p2", overwrite: true });
    await expect(run(rt, { action: "define", name: "../evil", description: "d", prompt: "p" })).rejects.toThrow(/Invalid/);
  });

  it("from copies an example as a starting point; the tool list can be overridden", async () => {
    const rt = mk();
    await run(rt, { action: "define", name: "auth-reviewer", from: "reviewer", tools: ["read", "grep", "find", "ls"] });
    const a = rt.resolveAgent("auth-reviewer")!;
    expect(a.systemPrompt).toContain("VERDICT");
    expect(a.tools).toEqual(["read", "grep", "find", "ls"]);
  });

  it("requires a trusted project, a description and a prompt", async () => {
    await expect(run(mk(false), { action: "define", name: "x", description: "d", prompt: "p" })).rejects.toThrow(/not trusted/);
    await expect(run(mk(), { action: "define", name: "x", prompt: "p" })).rejects.toThrow(/description/);
    await expect(run(mk(), { action: "define", name: "x", description: "d" })).rejects.toThrow(/prompt/);
  });

  it("warns on write-capable roles, list/examples work, remove deletes only project roles", async () => {
    const rt = mk();
    expect(out(await run(rt, { action: "define", name: "impl", description: "d", prompt: "p", tools: ["read", "edit", "write"] }))).toMatch(/isolate it/);
    expect(out(await run(rt, { action: "list" }))).toContain("impl");
    expect(out(await run(rt, { action: "examples" }))).toMatch(/not usable as-is/);
    await expect(run(rt, { action: "remove", name: "reviewer" })).rejects.toThrow(/No project role/);
    await run(rt, { action: "remove", name: "impl" });
    expect(fs.existsSync(path.join(proj, ".pi", "agents", "impl.md"))).toBe(false);
  });
});

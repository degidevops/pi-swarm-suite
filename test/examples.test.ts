import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { parseConfig } from "../src/core/config.ts";
import { validateWorkflow } from "../src/modes/workflow.ts";

const ex = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "examples");

describe("shipped examples stay valid", () => {
  it("agent files have name, description, tools and a valid tier", () => {
    const files = fs.readdirSync(path.join(ex, "agents"));
    expect(files.length).toBeGreaterThanOrEqual(6);
    for (const f of files) {
      const { frontmatter } = parseFrontmatter<Record<string, unknown>>(fs.readFileSync(path.join(ex, "agents", f), "utf-8"));
      expect(typeof frontmatter.name).toBe("string");
      expect(typeof frontmatter.description).toBe("string");
      expect(["lead", "worker", "cheap"]).toContain(frontmatter.tier);
    }
  });
  it("swarm.json parses with no warnings", () => {
    const r = parseConfig(JSON.parse(fs.readFileSync(path.join(ex, "swarm.json"), "utf-8")));
    expect(r.warnings).toEqual([]);
    expect(r.config.reviewer).toBe("reviewer");
  });
  it("workflow-audit.json is a valid workflow", () => {
    const wf = JSON.parse(fs.readFileSync(path.join(ex, "workflow-audit.json"), "utf-8"));
    expect(validateWorkflow(wf.stages)).toEqual([]);
  });
  it("team-market-core.json has ordered deps and scopes", () => {
    const t = JSON.parse(fs.readFileSync(path.join(ex, "team-market-core.json"), "utf-8"));
    t.tasks.forEach((task: { deps?: string[] }, i: number) => (task.deps ?? []).forEach((d) => expect(Number(d)).toBeLessThanOrEqual(i)));
    expect(t.tasks.every((x: { files?: string[] }) => x.files?.length)).toBe(true);
  });
});

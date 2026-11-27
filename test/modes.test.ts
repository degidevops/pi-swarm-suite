import { describe, expect, it } from "vitest";
import { validateWorkflow, type Stage } from "../src/modes/workflow.ts";
import { buildTaskPrompt } from "../src/modes/team.ts";
import type { TaskRecord } from "../src/core/tasks.ts";

const stage = (o: Partial<Stage> & { id: string }): Stage => ({ kind: "single", template: "x", ...o }) as Stage;

describe("validateWorkflow", () => {
  it("accepts a fanout + reduce pipeline", () => {
    expect(
      validateWorkflow([stage({ id: "scan", kind: "fanout", items: ["a", "b"] }), stage({ id: "reduce", from: "scan" })]),
    ).toEqual([]);
  });
  it("catches duplicate ids, forward refs, empty fanout and bad ids", () => {
    const errs = validateWorkflow([
      stage({ id: "a", kind: "fanout" }),
      stage({ id: "a", from: "later" }),
      stage({ id: "../bad" }),
    ]);
    expect(errs.join("\n")).toMatch(/non-empty items/);
    expect(errs.join("\n")).toMatch(/duplicate/);
    expect(errs.join("\n")).toMatch(/earlier stage/);
    expect(errs.join("\n")).toMatch(/invalid id/);
  });
  it("caps fanout at 200 items", () => {
    const items = Array.from({ length: 201 }, (_, i) => String(i));
    expect(validateWorkflow([stage({ id: "a", kind: "fanout", items })]).join()).toMatch(/at most 200/);
  });
});

const task = (o: Partial<TaskRecord>): TaskRecord => ({
  id: "2",
  subject: "indicators",
  description: "implement RSI",
  status: "in_progress",
  deps: ["1"],
  attempts: 1,
  createdAt: "",
  updatedAt: "",
  ...o,
});

describe("buildTaskPrompt", () => {
  it("includes dependency results, messages and gate feedback", () => {
    const p = buildTaskPrompt({
      team: "t",
      mate: "alice",
      task: task({}),
      deps: [task({ id: "1", subject: "schema", status: "completed", result: "added Tick type" })],
      messages: [{ id: "m", from: "lead", to: "alice", text: "use fixed-point", ts: "" }],
      feedback: "Gate failed: cargo clippy",
    });
    expect(p).toContain("added Tick type");
    expect(p).toContain("use fixed-point");
    expect(p).toContain("Gate failed: cargo clippy");
    expect(p).toContain("Do not merge branches");
  });
  it("shows the org chart, the working agreements and the continuing note", () => {
    const p = buildTaskPrompt({
      team: "t",
      mate: "alice",
      task: task({}),
      deps: [],
      messages: [],
      org: "lead — coordinator\nalice (Backend lead) ← you — reports to lead",
      continuing: true,
    });
    expect(p).toContain("## Your team");
    expect(p).toContain("alice (Backend lead) ← you");
    expect(p).toContain("How we work together");
    expect(p).toContain("team_ask");
    expect(p).toContain("SAME teammate continuing");
    const plain = buildTaskPrompt({ team: "t", mate: "a", task: task({ deps: [] }), deps: [], messages: [] });
    expect(plain).not.toContain("## Your team");
    expect(plain).not.toContain("SAME teammate");
  });
  it("omits optional sections when empty", () => {
    const p = buildTaskPrompt({ team: "t", mate: "a", task: task({ deps: [] }), deps: [], messages: [] });
    expect(p).not.toContain("Messages for you");
    expect(p).not.toContain("previous attempt");
  });
});

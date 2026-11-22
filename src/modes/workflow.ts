import * as fs from "node:fs";
import * as path from "node:path";
import { Type, type Static } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Runtime } from "../runtime.ts";
import { Journal } from "../core/journal.ts";
import { runPool } from "../core/pool.ts";
import { HARD_MAX_CONCURRENCY } from "../core/config.ts";
import { assertSafeName, formatTokens, formatUsd, renderTemplate, sha1, truncate } from "../core/util.ts";
import { commitAll, createWorktree, deleteBranch, removeWorktree, repoRoot } from "../core/git.ts";
import { renderCallFor, renderResultText } from "../ui.ts";

const StageSchema = Type.Object({
  id: Type.String({ description: "Unique stage id (letters, digits, - or _)" }),
  kind: Type.Union([Type.Literal("fanout"), Type.Literal("single")], {
    description: "fanout: one worker per item in parallel. single: one worker (use for reduce/verify).",
  }),
  template: Type.String({ description: "Prompt. Placeholders: {item} {index} {results} (output of `from` stage) {input}" }),
  items: Type.Optional(Type.Array(Type.String(), { description: "fanout only: the items to fan out over (max 200)" })),
  from: Type.Optional(Type.String({ description: "Earlier stage id whose outputs become {results} (default: previous stage)" })),
  agent: Type.Optional(Type.String()),
  model: Type.Optional(Type.String()),
  concurrency: Type.Optional(Type.Number()),
  worktree: Type.Optional(Type.Boolean({ description: "fanout only: run each item in its own git worktree/branch (for write-heavy fan-out). Branches are reported, never merged." })),
});

export const WorkflowParams = Type.Object({
  stages: Type.Array(StageSchema, { minItems: 1, maxItems: 12 }),
  input: Type.Optional(Type.String({ description: "Shared text available to every stage as {input}" })),
  runId: Type.Optional(Type.String({ description: "Resume an earlier run: completed steps are replayed from the journal for free" })),
  background: Type.Optional(Type.Boolean({ description: "Do not block; you are notified with the result when the run settles" })),
});
type Params = Static<typeof WorkflowParams>;
export type Stage = Static<typeof StageSchema>;

/** Pure validation, unit-tested. Returns a list of human-readable problems. */
export function validateWorkflow(stages: Stage[]): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  stages.forEach((s, idx) => {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$/.test(s.id)) errors.push(`stage ${idx + 1}: invalid id "${s.id}"`);
    if (seen.has(s.id)) errors.push(`stage ${idx + 1}: duplicate id "${s.id}"`);
    if (!s.template.trim()) errors.push(`stage "${s.id}": template is empty`);
    if (s.kind === "fanout") {
      if (!s.items?.length) errors.push(`stage "${s.id}": fanout needs a non-empty items array`);
      else if (s.items.length > 200) errors.push(`stage "${s.id}": at most 200 items`);
    } else if (s.items?.length) errors.push(`stage "${s.id}": items are only valid for fanout`);
    if (s.worktree && s.kind !== "fanout") errors.push(`stage "${s.id}": worktree is only valid for fanout`);
    if (s.from !== undefined && !seen.has(s.from)) errors.push(`stage "${s.id}": from "${s.from}" must be an earlier stage`);
    seen.add(s.id);
  });
  return errors;
}

function newRunId(): string {
  return `wf-${Date.now().toString(36)}`;
}

interface Step {
  o: string;
  b?: string;
}

async function runWorkflow(rt: Runtime, p: Params, signal: AbortSignal | undefined, note: (m: string) => void): Promise<{ text: string; details: Record<string, unknown> }> {
  const errors = validateWorkflow(p.stages);
  if (errors.length) throw new Error(`Invalid workflow:\n- ${errors.join("\n- ")}`);
  for (const s of p.stages) rt.resolveAgent(s.agent);
  const root = p.stages.some((s) => s.worktree) ? await repoRoot(rt.cwd) : undefined;
  if (p.stages.some((s) => s.worktree) && !root) throw new Error("worktree stages require a git repository.");

  const runId = p.runId ? assertSafeName(p.runId, "runId") : newRunId();
  const dir = path.join(rt.cwd, ".pi", "swarm", "runs", runId);
  fs.mkdirSync(dir, { recursive: true });
  const journal = new Journal(path.join(dir, "journal.jsonl"));
  const replayedAtStart = journal.size;
  let replayed = 0;
  let executed = 0;
  const failures: string[] = [];
  const branches: string[] = [];

  const stageOutput = new Map<string, string>();
  let lastId = "";

  for (const s of p.stages) {
    if (signal?.aborted || rt.ledger.exceeded()) break;
    const fromText = stageOutput.get(s.from ?? lastId) ?? "";
    const limit = Math.min(s.concurrency ?? rt.config.maxConcurrency, rt.config.maxConcurrency, HARD_MAX_CONCURRENCY);

    const runStep = async (prompt: string, index: number): Promise<string | undefined> => {
      const key = `${s.id}:${index}:${sha1(`${prompt}|${s.agent ?? ""}|${s.model ?? ""}|${s.worktree ? "wt" : ""}`)}`;
      const cached = journal.get(key);
      if (cached !== undefined) {
        const step = JSON.parse(cached) as Step;
        replayed++;
        if (step.b) branches.push(step.b);
        return step.o;
      }
      let cwd = rt.cwd;
      let wtPath: string | undefined;
      let branch: string | undefined;
      let kept: string | undefined;
      if (s.worktree && root) {
        const wt = await createWorktree(root, `wf-${runId}-${s.id}-${index}`, `swarm/wf/${runId}-${s.id}-${index}`);
        cwd = wt.path;
        wtPath = wt.path;
        branch = wt.branch;
      }
      try {
        const res = await rt.run({ label: `${s.id}#${index + 1}`, task: prompt, agent: rt.resolveAgent(s.agent), model: s.model, cwd, signal });
        if (res.status !== "ok") {
          failures.push(`${s.id}#${index + 1}: ${res.error ?? res.status}`);
          return undefined;
        }
        if (wtPath && branch && (await commitAll(wtPath, `swarm(workflow ${runId}): ${s.id}#${index + 1}`))) {
          kept = branch;
          branches.push(branch);
        }
        executed++;
        journal.set(key, JSON.stringify({ o: res.output, b: kept } satisfies Step));
        return res.output;
      } finally {
        if (root && wtPath) {
          await removeWorktree(root, wtPath);
          if (branch && !kept) await deleteBranch(root, branch);
        }
      }
    };

    const vars = { input: p.input ?? "", results: truncate(fromText, 40_000) };
    if (s.kind === "fanout") {
      const items = s.items ?? [];
      note(`stage ${s.id}: fan-out over ${items.length} item(s), concurrency ${limit}`);
      const outs = await runPool(items, limit, (item, i) => runStep(renderTemplate(s.template, { ...vars, item, index: String(i) }), i), signal);
      stageOutput.set(s.id, items.map((item, i) => `### ${item}\n${outs[i] !== undefined ? truncate(outs[i] as string, 8000) : "(no result)"}`).join("\n\n"));
    } else {
      note(`stage ${s.id}: single`);
      const out = await runStep(renderTemplate(s.template, vars), 0);
      stageOutput.set(s.id, out ?? "(no result)");
    }
    lastId = s.id;
  }

  const u = rt.ledger.snapshot();
  const done = p.stages.filter((s) => stageOutput.has(s.id)).length;
  const finalOut = stageOutput.get(lastId) ?? "(no output)";
  const incomplete = failures.length > 0 || done < p.stages.length;
  const uniq = [...new Set(branches)].sort();
  const text =
    `${truncate(finalOut, 30_000)}\n\n— run ${runId}: ${done}/${p.stages.length} stages · ${executed} step(s) executed, ${replayed} replayed from journal (${replayedAtStart} journaled before this call)\n` +
    `— ${formatUsd(u.cost)} · ↑${formatTokens(u.input)} ↓${formatTokens(u.output)}` +
    (uniq.length ? `\n— branches (not merged): ${uniq.join(", ")}` : "") +
    (failures.length ? `\n⚠ ${failures.length} failed step(s):\n${failures.slice(0, 10).map((f) => `  - ${f}`).join("\n")}` : "") +
    (incomplete ? `\nResume with runId="${runId}" (completed steps are free).` : "");
  return { text, details: { runId, executed, replayed, failures: failures.length, branches: uniq } };
}

export function workflowTool(getRt: (cwd: string) => Runtime): ToolDefinition<typeof WorkflowParams, Record<string, unknown>> {
  return {
    name: "swarm_workflow",
    label: "Swarm: workflow",
    description:
      "Run a declarative multi-stage workflow: fan out workers over many items in parallel (optionally one git worktree per item), then reduce/verify with a single worker. Every completed step is journaled, so an interrupted run resumes without re-spending tokens (pass runId). background:true returns immediately and notifies you with the result. Best for audits, migrations, large reviews.",
    promptSnippet: "swarm_workflow: fan-out/reduce pipeline over many items with journaled resume",
    promptGuidelines: [
      "Use swarm_workflow for large fan-out (many files/modules) followed by a reduce or cold-verify stage. Fanout workers should be read-only unless the stage sets worktree:true. To resume after an interruption, call again with the same runId.",
    ],
    parameters: WorkflowParams,
    renderCall: renderCallFor<Params>("swarm_workflow", (a) => `${a.stages.map((s) => s.id).join(" → ")}${a.background ? " (background)" : ""}${a.runId ? ` resume ${a.runId}` : ""}`),
    renderResult: renderResultText,
    async execute(_id, p: Params, signal, onUpdate, ctx) {
      const rt = getRt(ctx.cwd);
      if (p.background) {
        const errors = validateWorkflow(p.stages);
        if (errors.length) throw new Error(`Invalid workflow:\n- ${errors.join("\n- ")}`);
        const runId = p.runId ? assertSafeName(p.runId, "runId") : newRunId();
        const job = rt.startJob("workflow", `workflow:${runId}`, async (jobSignal) => (await runWorkflow(rt, { ...p, runId }, jobSignal, () => undefined)).text);
        return { content: [{ type: "text", text: `Started ${job.id} (run ${runId}) in the background. You will be notified with the result; resume later with runId="${runId}" if needed.` }], details: { runId, job: job.id } };
      }
      const r = await runWorkflow(rt, p, signal, (m) => onUpdate?.({ content: [{ type: "text", text: m }], details: {} }));
      return { content: [{ type: "text", text: r.text }], details: r.details };
    },
  };
}

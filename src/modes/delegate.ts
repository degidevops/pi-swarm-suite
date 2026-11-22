import { Type, type Static } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Runtime } from "../runtime.ts";
import type { WorkerResult } from "../types.ts";
import { runPool } from "../core/pool.ts";
import { commitAll, createWorktree, deleteBranch, removeWorktree, repoRoot } from "../core/git.ts";
import { formatTokens, formatUsd, renderTemplate, truncate } from "../core/util.ts";
import { addUsage, emptyUsage } from "../types.ts";
import { renderCallFor, renderResultText } from "../ui.ts";

export const DelegateParams = Type.Object({
  tasks: Type.Array(
    Type.Object({
      task: Type.String({ description: "Self-contained instructions for one worker. It cannot see this conversation." }),
      agent: Type.Optional(Type.String({ description: "Agent name from ~/.pi/agent/agents or .pi/agents" })),
      model: Type.Optional(Type.String({ description: "Override model (provider/model)" })),
      worktree: Type.Optional(Type.Boolean({ description: "Run in an isolated git worktree on its own branch (use for tasks that write files)" })),
    }),
    { minItems: 1, maxItems: 32 },
  ),
  chain: Type.Optional(Type.Boolean({ description: "Run sequentially; {previous} in a task is replaced by the previous output. Stops on first failure." })),
});
type Params = Static<typeof DelegateParams>;

interface Item {
  result: WorkerResult;
  branch?: string;
}

export function delegateTool(getRt: (cwd: string) => Runtime): ToolDefinition<typeof DelegateParams, Record<string, unknown>> {
  return {
    name: "swarm_delegate",
    label: "Swarm: delegate",
    description:
      "Delegate independent tasks to isolated worker agents (separate pi processes with their own context). Parallel by default; set chain=true for a sequential pipeline. Use for focused, self-contained work: research, review, tests, small isolated edits.",
    promptSnippet: "swarm_delegate: run independent tasks in parallel in isolated worker agents",
    promptGuidelines: [
      "Use swarm_delegate for independent, self-contained tasks; use swarm_team when tasks depend on each other or modules must coordinate; use swarm_workflow for large fan-out with resume.",
      "Give each swarm_delegate task full context: workers cannot see this conversation. Never let two parallel tasks edit the same files; set worktree=true for tasks that write.",
    ],
    parameters: DelegateParams,
    renderCall: renderCallFor<Params>("swarm_delegate", (a) => `${a.tasks.length} task(s)${a.chain ? " chained" : " parallel"}`),
    renderResult: renderResultText,
    async execute(_id, params: Params, signal, onUpdate, ctx) {
      const rt = getRt(ctx.cwd);
      const runId = Date.now().toString(36);
      const root = params.tasks.some((t) => t.worktree) ? await repoRoot(rt.cwd) : undefined;
      if (params.tasks.some((t) => t.worktree) && !root) throw new Error("worktree=true requires the working directory to be inside a git repository.");
      const agents = params.tasks.map((t) => rt.resolveAgent(t.agent)); // validates all names up front

      const items: (Item | undefined)[] = new Array(params.tasks.length).fill(undefined);
      const progress = () =>
        onUpdate?.({
          content: [{ type: "text", text: `${items.filter(Boolean).length}/${params.tasks.length} finished · ${formatUsd(rt.ledger.snapshot().cost)}` }],
          details: {},
        });

      const runOne = async (i: number, task: string): Promise<Item> => {
        const t = params.tasks[i]!;
        const label = `${t.agent ?? "worker"}#${i + 1}`;
        let cwd = rt.cwd;
        let branch: string | undefined;
        let wtPath: string | undefined;
        if (t.worktree && root) {
          const wt = await createWorktree(root, `dg-${runId}-${i + 1}`, `swarm/delegate/${runId}-${i + 1}`);
          cwd = wt.path;
          wtPath = wt.path;
          branch = wt.branch;
        }
        let keep: string | undefined;
        try {
          const result = await rt.run({ label, task, agent: agents[i], model: t.model, cwd, signal });
          if (wtPath && branch && result.status === "ok") keep = (await commitAll(wtPath, `swarm(delegate): ${label}`)) ? branch : undefined;
          return { result, branch: keep };
        } finally {
          if (root && wtPath) {
            await removeWorktree(root, wtPath);
            if (branch && !keep) await deleteBranch(root, branch); // keep only branches that hold a commit
          }
        }
      };

      if (params.chain) {
        let previous = "";
        for (let i = 0; i < params.tasks.length; i++) {
          const prompt = renderTemplate(params.tasks[i]!.task, { previous });
          const item = await runOne(i, prompt);
          items[i] = item;
          progress();
          if (item.result.status !== "ok") break;
          previous = truncate(item.result.output, 20_000);
        }
      } else {
        await runPool(
          params.tasks,
          rt.config.maxConcurrency,
          async (t, i) => {
            items[i] = await runOne(i, t.task);
            progress();
          },
          signal,
        );
      }

      let total = emptyUsage();
      const blocks = items.map((it, i) => {
        const label = `${params.tasks[i]!.agent ?? "worker"}#${i + 1}`;
        if (!it) return `## ${label}: not run (aborted or earlier step failed)`;
        total = addUsage(total, it.result.usage);
        const head = `## ${label}: ${it.result.status}${it.branch ? `  [branch ${it.branch}]` : ""}`;
        const body = it.result.status === "ok" ? truncate(it.result.output, 6000) : `error: ${it.result.error ?? "unknown"}`;
        return `${head}\n${body}`;
      });
      const text = `${blocks.join("\n\n")}\n\n— ${formatUsd(total.cost)} · ↑${formatTokens(total.input)} ↓${formatTokens(total.output)}${
        items.some((i) => i?.branch) ? "\nBranches are NOT merged. Review them, then merge manually (git merge <branch>)." : ""
      }`;
      return {
        content: [{ type: "text", text }],
        details: { runId, results: items.map((i) => (i ? { status: i.result.status, branch: i.branch, usage: i.result.usage } : null)) },
      };
    },
  };
}

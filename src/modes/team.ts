import * as fs from "node:fs";
import * as path from "node:path";
import { Type, type Static } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Runtime } from "../runtime.ts";
import { TaskStore, type TaskRecord } from "../core/tasks.ts";
import { Mailbox, type MailMessage, MESSAGE_KINDS, formatMessages, isMessageKind } from "../core/mailbox.ts";
import { type Teammate, TEAM_PROTOCOL, renderOrgChart, resolveRecipient, validateOrg } from "../core/org.ts";
import { formatGateFailure, runGates } from "../core/gates.ts";
import { appendLog } from "../core/eventlog.ts";
import { buildReviewPrompt, parseVerdict } from "../core/review.ts";
import { outsideScope, scopesOverlap } from "../core/scope.ts";
import {
  branchExists,
  changedPaths,
  commitAll,
  createScratchWorktree,
  createWorktree,
  deleteBranch,
  commitResolution,
  diffText,
  git,
  isClean,
  listUnmerged,
  mergeBranchesInto,
  mergeIntoCurrent,
  resolveWithTheirs,
  removeWorktree,
  repoRoot,
  type MergeOutcome,
} from "../core/git.ts";
import { appendTranscript, readTranscript, transcriptDir } from "../core/transcript.ts";
import { assertSafeName, formatTokens, formatUsd, sleep, truncate } from "../core/util.ts";
import { writeTeamRunning, removeTeamRunning } from "../core/attach.ts";
import { renderCallFor, renderResultText } from "../ui.ts";

export const TeamParams = Type.Object({
  action: Type.Union(
    [
      Type.Literal("create"),
      Type.Literal("add_task"),
      Type.Literal("run"),
      Type.Literal("status"),
      Type.Literal("message"),
      Type.Literal("inbox"),
      Type.Literal("approve"),
      Type.Literal("revise"),
      Type.Literal("stop"),
      Type.Literal("team_task_add"),
    ],
    {
      description:
        "create: team + tasks. add_task. run: execute until tasks settle (background:true returns at once and notifies on completion). status. message: DM a teammate/'all' (delivered live if they are working). inbox: read messages teammates sent to you. approve/revise: answer a task's plan (taskId, text). stop. team_task_add: request a new task (teammate-initiated; starts pending with needsPlan).",
    },
  ),
  name: Type.String({ description: "Team name (letters, digits, - or _)" }),
  teammates: Type.Optional(
    Type.Array(
      Type.Object({
        name: Type.String(),
        agent: Type.Optional(Type.String({ description: "Agent definition for this teammate" })),
        model: Type.Optional(Type.String()),
        title: Type.Optional(Type.String({ description: 'Job title, e.g. "Backend lead"' })),
        role: Type.Optional(Type.String({ description: "What they are responsible for (1-2 sentences). Everyone sees it in the org chart." })),
        reportsTo: Type.Optional(Type.String({ description: 'Escalation path: another teammate name, or "lead" (default)' })),
        owns: Type.Optional(Type.Array(Type.String(), { description: 'File globs they own, e.g. "crates/feed/**"; others ask them before touching it' })),
      }),
      { minItems: 1, maxItems: 16 },
    ),
  ),
  tasks: Type.Optional(
    Type.Array(
      Type.Object({
        subject: Type.String(),
        description: Type.String({ description: "Complete instructions incl. acceptance criteria" }),
        deps: Type.Optional(Type.Array(Type.String(), { description: 'Ids of earlier tasks ("1", "2", …) that must complete first' })),
        files: Type.Optional(Type.Array(Type.String(), { description: 'File-ownership globs, e.g. "crates/feed/**". Edits outside fail the attempt.' })),
        plan: Type.Optional(Type.Boolean({ description: "Require an approved plan before any code is written" })),
      }),
      { maxItems: 64 },
    ),
  ),
  to: Type.Optional(Type.String({ description: "message: teammate name or 'all'" })),
  text: Type.Optional(Type.String({ description: "message / approve / revise text" })),
  kind: Type.Optional(Type.String({ description: `message: ${MESSAGE_KINDS.join(" | ")} (default info). Use question when you need an answer, decision for rulings.` })),
  taskId: Type.Optional(Type.String({ description: "approve/revise: task id" })),
  background: Type.Optional(Type.Boolean({ description: "run: do not block; you are notified when the run settles" })),
  subject: Type.Optional(Type.String({ description: "team_task_add: short task title" })),
  description: Type.Optional(Type.String({ description: "team_task_add: complete instructions incl. acceptance criteria" })),
  deps: Type.Optional(Type.Array(Type.String(), { description: 'team_task_add: ids of earlier tasks ("1", "2", …) that must complete first' })),
  files: Type.Optional(Type.Array(Type.String(), { description: 'team_task_add: file-ownership globs, e.g. "crates/feed/**"' })),
  plan: Type.Optional(Type.Boolean({ description: "team_task_add: require an approved plan before any code is written" })),
});
type Params = Static<typeof TeamParams>;

interface TeamFile {
  name: string;
  createdAt: string;
  teammates: Teammate[];
}

export const teamDir = (cwd: string, name: string): string => path.join(cwd, ".pi", "swarm", "teams", assertSafeName(name, "team name"));
export const teamLog = (cwd: string, name: string): string => path.join(teamDir(cwd, name), "log.jsonl");

function loadTeam(cwd: string, name: string): TeamFile {
  const f = path.join(teamDir(cwd, name), "team.json");
  if (!fs.existsSync(f)) throw new Error(`Unknown team "${name}". Use action=create first.`);
  return JSON.parse(fs.readFileSync(f, "utf-8")) as TeamFile;
}

export function buildTaskPrompt(i: {
  team: string;
  mate: string;
  task: TaskRecord;
  deps: TaskRecord[];
  messages: MailMessage[];
  feedback?: string;
  /** Org chart with live activity (renderOrgChart). */
  org?: string;
}): string {
  const parts: string[] = [
    `You are "${i.mate}" on team "${i.team}". Complete ONLY the task below; other teammates handle other tasks in their own worktrees. You can use team_message / team_inbox / team_tasks to coordinate.`,
    `## Task ${i.task.id}: ${i.task.subject}\n${i.task.description}`,
  ];
  if (i.task.scope?.length) parts.push(`## File ownership\nYou may only modify files matching: ${i.task.scope.join(", ")}. Changes elsewhere will be rejected.`);
  if (i.task.plan && i.task.planApproved) {
    parts.push(`## Approved plan (follow it)\n${truncate(i.task.plan, 6000)}${i.task.planFeedback ? `\n\nLead's notes: ${i.task.planFeedback}` : ""}`);
  }
  const done = i.deps.filter((d) => d.status === "completed");
  if (done.length) {
    parts.push(
      `## Results from tasks you depend on (their code is already merged into your worktree)\n` +
        done.map((d) => `### Task ${d.id}: ${d.subject}\n${truncate(d.result ?? "", 3000)}`).join("\n\n"),
    );
  }
  if (i.messages.length) parts.push(`## Messages for you\n${formatMessages(i.messages)}`);
  if (i.feedback) parts.push(`## Your previous attempt did not pass — fix this first\n${truncate(i.feedback, 4000)}`);
  parts.push(`## When finished\nReply with a concise summary: what changed, files touched, and anything the lead must know. Do not merge branches or modify other worktrees.`);
  return parts.join("\n\n");
}

export function buildPlanPrompt(i: { team: string; mate: string; task: TaskRecord }): string {
  return [
    `You are "${i.mate}" on team "${i.team}". PLANNING PASS: do not modify anything. Read the code you need, then propose a plan for the task below.`,
    `## Task ${i.task.id}: ${i.task.subject}\n${i.task.description}`,
    i.task.planFeedback ? `## The lead rejected your previous plan: ${i.task.planFeedback}\nRevise accordingly.` : "",
    `## Output\nA concise numbered plan: files to touch, approach, risks, tests. No code changes.`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

function statusText(cwd: string, name: string): string {
  const store = new TaskStore(path.join(teamDir(cwd, name), "tasks"));
  const s = store.summary();
  const lines = store.list().map(
    (t) =>
      `${t.id}. [${t.status}]${t.owner ? ` (${t.owner})` : ""} ${t.subject}${t.deps.length ? `  deps:${t.deps.join(",")}` : ""}${t.scope ? `  scope:${t.scope.join(",")}` : ""}${t.branch ? `  branch:${t.branch}` : ""}`,
  );
  const awaiting = store.list().filter((t) => t.status === "awaiting_approval");
  const plans = awaiting.map((t) => `\n— Plan for task ${t.id} awaiting your decision (approve/revise):\n${truncate(t.plan ?? "", 1500)}`).join("");
  return `Team ${name}: ${s.completed} done · ${s.in_progress} running · ${s.pending} pending · ${s.awaiting_approval} awaiting approval · ${s.failed} failed · ${s.blocked} blocked\n${lines.join("\n")}${plans}`;
}

function overlapWarnings(store: TaskStore): string[] {
  const all = store.list();
  const ancestors = (t: TaskRecord, seen = new Set<string>()): Set<string> => {
    for (const d of t.deps) {
      if (!seen.has(d)) {
        seen.add(d);
        const dt = all.find((x) => x.id === d);
        if (dt) ancestors(dt, seen);
      }
    }
    return seen;
  };
  const out: string[] = [];
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      const a = all[i] as TaskRecord;
      const b = all[j] as TaskRecord;
      if (!scopesOverlap(a.scope, b.scope)) continue;
      if (ancestors(b).has(a.id) || ancestors(a).has(b.id)) continue; // ordered by deps: fine
      out.push(`⚠ tasks ${a.id} and ${b.id} have overlapping file scopes and no dependency between them (merge conflicts likely)`);
    }
  }
  return out;
}

async function runTeam(rt: Runtime, team: TeamFile, signal: AbortSignal | undefined, tick: (msg: string) => void): Promise<string> {
  const dir = teamDir(rt.cwd, team.name);
  const log = teamLog(rt.cwd, team.name);
  const store = new TaskStore(path.join(dir, "tasks"));
  const mailbox = new Mailbox(path.join(dir, "inbox"));
  const cfg = rt.config;

  const root = cfg.worktrees ? await repoRoot(rt.cwd) : undefined;
  if (cfg.worktrees && !root) throw new Error("worktrees are enabled but this directory is not a git repository. Run `git init` or set worktrees:false in swarm.json.");
  if (root && !(await isClean(root))) tick("warning: working tree has uncommitted changes; worktrees start from the last commit and will not include them.");

  const resumed = store.resetStale();
  const mates = team.teammates.slice(0, cfg.maxConcurrency);
  for (const m of mates) rt.resolveAgent(m.agent); // validate before spawning anything
  const reviewer = cfg.reviewer ? rt.resolveAgent(cfg.reviewer) : undefined;
  appendLog(log, "run_start", { mates: mates.map((m) => m.name), resumed });
  writeTeamRunning(rt.cwd, team.name, {
    team: team.name,
    startedAt: Date.now(),
    mates: mates.map((m) => m.name),
    pid: process.pid,
  });

  const stopped = () => signal?.aborted || rt.ledger.exceeded();
  const active = new Map<string, string>(); // mate -> live worker label (steerable)

  // Deliver DMs to teammates that are mid-task by steering their running worker.
  let leadSeen = 0;
  const watcher = setInterval(() => {
    // Teammates → lead: surface unread mail to the lead's session (it is not pushed any other way).
    const unreadForLead = mailbox.peek("lead");
    if (unreadForLead.length === 0) leadSeen = 0;
    else if (unreadForLead.length > leadSeen) {
      const fresh = unreadForLead.slice(leadSeen);
      leadSeen = unreadForLead.length;
      const urgent = fresh.some((m) => m.kind === "blocker" || m.kind === "question" || m.kind === "review_request");
      rt.alert("message", team.name, `${fresh.length} new message(s) for you in team ${team.name} (read with swarm_team action=inbox):\n${formatMessages(fresh).slice(0, 1200)}`, urgent);
    }
    for (const [mate, label] of active) {
      const msgs = mailbox.drain(mate);
      if (!msgs.length) continue;
      const body = `New message(s) from your team:\n${formatMessages(msgs)}`;
      if (rt.steer(label, body)) appendLog(log, "steered", { mate, count: msgs.length });
      else for (const m of msgs) mailbox.send(m.from, mate, m.text); // worker just finished: redeliver with next task
    }
  }, 600);

  const executeTask = async (mate: TeamFile["teammates"][number], task: TaskRecord): Promise<void> => {
    const agent = rt.resolveAgent(mate.agent);
    const teamCtx = { dir, mate: mate.name };

    // 1) Optional planning pass (read-only), then wait for the lead's approval.
    if (task.needsPlan && !task.planApproved) {
      const res = await rt.run({
        label: `${team.name}/${mate.name}#${task.id}:plan`,
        task: buildPlanPrompt({ team: team.name, mate: mate.name, task }),
        agent,
        model: mate.model,
        tools: ["read", "grep", "find", "ls"],
        signal,
        team: teamCtx,
      });
      if (res.status === "aborted") return void store.update(task.id, { status: "pending", owner: undefined });
      if (res.status !== "ok") return void store.fail(task.id, `planning failed: ${res.error ?? "unknown"}`);
      store.update(task.id, { status: "awaiting_approval", plan: res.output, owner: undefined });
      appendLog(log, "plan_ready", { task: task.id, mate: mate.name });
      return;
    }

    // 2) Implementation in an isolated worktree.
    let wtPath: string | undefined;
    let branch: string | undefined;
    let keepBranch = false;
    let cwd = rt.cwd;
    try {
      if (root) {
        const wt = await createWorktree(root, `${team.name}-${task.id}`, `swarm/${team.name}/${task.id}`);
        wtPath = wt.path;
        branch = wt.branch;
        cwd = wt.path;
        const depBranches = task.deps.map((d) => store.get(d)?.branch).filter((b): b is string => !!b);
        if (depBranches.length) {
          const m = await mergeBranchesInto(wt.path, depBranches);
          if (!m.ok) return void store.fail(task.id, m.error ?? "dependency merge failed");
        }
      }

      let feedback: string | undefined;
      let lastError = "";
      let reviewNote: string | undefined;

      // Pre-task hooks (trusted config only).
      if (wtPath && cfg.preHooks?.length) {
        const g = await runGates(cfg.preHooks, cwd, signal);
        if (!g.ok) {
          lastError = `pre-hook failed: ${formatGateFailure(g)}`;
          feedback = lastError;
          appendTranscript(rt.cwd, team.name, { ts: Date.now(), type: "hook", taskId: task.id, mate: mate.name, error: lastError });
          store.fail(task.id, lastError);
          appendLog(log, "task_failed", { task: task.id, mate: mate.name, error: truncate(lastError, 300), why: "pre-hook" });
          return;
        }
      }
      // Session directory for this task so a second pi session can tail its output (ROADMAP #3).
      const sessionDir = path.join(dir, "sessions", task.id);
      fs.mkdirSync(sessionDir, { recursive: true });

      for (let attempt = 1; attempt <= cfg.maxAttempts; attempt++) {
        const label = `${team.name}/${mate.name}#${task.id}`;
        const prompt = buildTaskPrompt({
          team: team.name,
          mate: mate.name,
          task,
          deps: task.deps.map((d) => store.get(d)).filter((d): d is TaskRecord => !!d),
          messages: mailbox.drain(mate.name),
          feedback,
          org: renderOrgChart(team.teammates, store.list(), mate.name),
        });
        active.set(mate.name, label);
        let res;
        try {
          res = await rt.run({ label, task: prompt, agent, model: mate.model, cwd, signal, steerable: true, team: teamCtx, teamName: team.name, sessionDir });
        } finally {
          active.delete(mate.name);
        }
        if (res.status === "aborted") return void store.update(task.id, { status: "pending", owner: undefined }); // safe to resume
        if (res.status !== "ok") {
          lastError = res.error ?? "worker failed";
          feedback = `The worker run failed: ${lastError}`;
          appendTranscript(rt.cwd, team.name, {
            ts: Date.now(), type: "attempt", taskId: task.id, mate: mate.name, attempt, error: lastError,
          });
          appendLog(log, "attempt_failed", { task: task.id, attempt, why: "worker", error: lastError });
          continue;
        }
        appendTranscript(rt.cwd, team.name, {
          ts: Date.now(), type: "attempt", taskId: task.id, mate: mate.name, attempt, output: truncate(res.output, 2000),
        });
        // file-ownership enforcement
        if (task.scope?.length && wtPath) {
          const bad = outsideScope(await changedPaths(wtPath), task.scope);
          if (bad.length) {
            lastError = `You modified files outside your allowed scope (${task.scope.join(", ")}): ${bad.join(", ")}. Revert those changes and keep to your scope.`;
            feedback = lastError;
            appendTranscript(rt.cwd, team.name, {
              ts: Date.now(), type: "attempt", taskId: task.id, mate: mate.name, attempt, error: lastError,
            });
            appendLog(log, "attempt_failed", { task: task.id, attempt, why: "scope", files: bad });
            continue;
          }
        }
        if (cfg.gates.length) {
          const g = await runGates(cfg.gates, cwd, signal);
          if (!g.ok) {
            lastError = formatGateFailure(g);
            feedback = lastError;
            appendTranscript(rt.cwd, team.name, {
              ts: Date.now(), type: "attempt", taskId: task.id, mate: mate.name, attempt, error: lastError,
            });
            appendLog(log, "attempt_failed", { task: task.id, attempt, why: "gate", command: g.results.at(-1)?.command });
            continue;
          }
        }
        // independent review of the actual diff
        if (reviewer) {
          const diff = await diffText(cwd, !!wtPath);
          const rv = await rt.run({
            label: `${team.name}/review#${task.id}`,
            task: buildReviewPrompt({ team: team.name, taskId: task.id, subject: task.subject, description: task.description, diff }),
            agent: reviewer,
            cwd,
            signal,
          });
          if (rv.status === "ok") {
            const verdict = parseVerdict(rv.output);
            reviewNote = truncate(rv.output, 1500);
            if (verdict === "fail") {
              lastError = `Independent review FAILED:\n${rv.output}`;
              feedback = lastError;
              appendTranscript(rt.cwd, team.name, {
                ts: Date.now(), type: "review", taskId: task.id, mate: mate.name, attempt, error: lastError,
                output: truncate(rv.output, 2000),
              });
              appendLog(log, "attempt_failed", { task: task.id, attempt, why: "review" });
              continue;
            }
            if (verdict === "unknown") reviewNote = `(reviewer gave no explicit verdict) ${reviewNote}`;
          } else {
            reviewNote = `(review skipped: ${rv.error ?? rv.status})`;
          }
        }

        // Post-task hooks (trusted config only), run after review passes but before commit.
        if (wtPath && cfg.postHooks?.length) {
          const g = await runGates(cfg.postHooks, cwd, signal);
          if (!g.ok) {
            lastError = `post-hook failed: ${formatGateFailure(g)}`;
            feedback = lastError;
            appendTranscript(rt.cwd, team.name, { ts: Date.now(), type: "hook", taskId: task.id, mate: mate.name, error: lastError });
            appendLog(log, "attempt_failed", { task: task.id, attempt, why: "post-hook", error: lastError });
            continue;
          }
        }

        if (wtPath && branch) keepBranch = await commitAll(wtPath, `swarm(${team.name}): task ${task.id} ${task.subject}`);
        store.update(task.id, { status: "completed", result: res.output, branch: keepBranch ? branch : undefined, review: reviewNote });
        appendTranscript(rt.cwd, team.name, {
          ts: Date.now(), type: "complete", taskId: task.id, mate: mate.name, output: truncate(res.output, 3000),
          usage: res.usage ? { input: res.usage.input, output: res.usage.output, cost: res.usage.cost, turns: res.usage.turns } : undefined,
        });
        appendLog(log, "task_completed", { task: task.id, mate: mate.name, branch: keepBranch ? branch : null, attempts: attempt });
        return;
      }
      store.fail(task.id, lastError || "failed");
      appendTranscript(rt.cwd, team.name, {
        ts: Date.now(), type: "fail", taskId: task.id, mate: mate.name, error: truncate(lastError, 300),
      });
      appendLog(log, "task_failed", { task: task.id, mate: mate.name, error: truncate(lastError, 300) });
    } finally {
      if (root && wtPath) {
        await removeWorktree(root, wtPath);
        if (branch && !keepBranch) await deleteBranch(root, branch);
      }
    }
  };

  try {
    await Promise.all(
      mates.map(async (mate) => {
        while (!stopped()) {
          store.settleBlocked();
          const task = store.claimNext(mate.name);
          if (!task) {
            if (!store.hasActive()) break; // nothing claimable and nothing running: settled
            await sleep(300, signal);
            continue;
          }
          tick(`${mate.name} → task ${task.id}: ${task.subject}`);
          appendLog(log, "task_started", { task: task.id, mate: mate.name, attempt: task.attempts });
          await executeTask(mate, task);
        }
      }),
    );
  } finally {
    clearInterval(watcher);
    removeTeamRunning(rt.cwd, team.name);
  }
  store.settleBlocked();
  appendLog(log, "run_end", store.summary() as unknown as Record<string, unknown>);

  const u = rt.ledger.snapshot();
  const reason = rt.ledger.exceeded() ? "\n⚠ stopped: budget exceeded" : signal?.aborted ? "\n⚠ stopped: aborted (unfinished tasks are pending; run again to resume)" : "";
  const lead = new Mailbox(path.join(dir, "inbox")).drain("lead");
  const leadMsgs = lead.length ? `\n\nMessages from teammates:\n${lead.map((m) => `- ${m.from}: ${m.text}`).join("\n")}` : "";
  const awaiting = store.summary().awaiting_approval ? "\n⚠ plan(s) awaiting your decision: use action=approve or action=revise, then run again." : "";
  const merge = store.list().some((t) => t.branch) ? `\nNext: review branches, then run \`/swarm merge ${team.name}\` to merge completed tasks (agents never merge automatically).` : "";
  return `${resumed ? `(reset ${resumed} stale task(s))\n` : ""}${statusText(rt.cwd, team.name)}${leadMsgs}\n\n— ${formatUsd(u.cost)} · ↑${formatTokens(u.input)} ↓${formatTokens(u.output)}${reason}${awaiting}${merge}`;
}

/** Human-triggered via `/swarm merge <team>`. Tries a straight merge first; on conflict, resolves in a scratch worktree (ROADMAP #4). */
export async function mergeTeam(rt: Runtime, name: string): Promise<string> {
  const root = await repoRoot(rt.cwd);
  if (!root) throw new Error("not a git repository");
  if (!(await isClean(root))) throw new Error("working tree is not clean; commit or stash first");
  const store = new TaskStore(path.join(teamDir(rt.cwd, name), "tasks"));
  const branches = store
    .list()
    .filter((t) => t.status === "completed" && t.branch)
    .map((t) => t.branch as string);
  if (!branches.length) return "Nothing to merge: no completed task has a branch.";

  // Fast path: straight merge into current, stop at first conflict.
  const fast = await mergeIntoCurrent(root, branches);
  const conflicts = fast.filter((o) => !o.ok);
  if (conflicts.length === 0) {
    appendLog(teamLog(rt.cwd, name), "merge", { results: fast.map((o) => `${o.branch}:${o.ok ? "ok" : "conflict"}`) });
    return fast.map((o) => `${o.ok ? "✓" : "✗"} ${o.branch}: ${o.message}`).join("\n");
  }

  // Conflict path: build everything in a scratch worktree, resolving conflicts as we go,
  // then merge the resolved scratch back into the current branch.
  const wt = await createScratchWorktree(root, name);
  try {
    for (const b of branches) {
      if (!(await branchExists(root, b))) continue;
      const r = await git(wt.path, ["merge", "--no-edit", b]);
      if (r.code !== 0) {
        const unmerged = await listUnmerged(wt.path);
        if (unmerged.length) {
          // Incoming task-branch work wins on conflict; stage the resolution.
          await resolveWithTheirs(wt.path, unmerged);
          await commitResolution(wt.path, `swarm(${name}): resolve conflict merging ${b}`);
        } else {
          await git(wt.path, ["merge", "--abort"]);
          return `✗ ${b}: merge failed and could not be auto-resolved: ${(r.stderr || r.stdout).trim().slice(0, 300)}`;
        }
      }
    }
    // Merge the fully-resolved scratch worktree back into the current branch.
    const r = await git(root, ["merge", "--no-ff", "--no-edit", wt.branch]);
    if (r.code !== 0) {
      await git(root, ["merge", "--abort"]);
      return `✗ merge failed after conflict resolution: ${(r.stderr || r.stdout).trim().slice(0, 300)}`;
    }
  } finally {
    await removeWorktree(root, wt.path);
    await deleteBranch(root, wt.branch);
  }

  const results = branches.map((b) => ({ branch: b, ok: true as const, message: "merged (conflict resolved)" } as MergeOutcome));
  appendLog(teamLog(rt.cwd, name), "merge", { results: results.map((o) => `${o.branch}:${o.ok ? "ok" : "conflict"}`), conflictResolved: true });
  return results.map((o) => `${o.ok ? "✓" : "✗"} ${o.branch}: ${o.message}`).join("\n");
}

export function listTeams(cwd: string): string[] {
  const d = path.join(cwd, ".pi", "swarm", "teams");
  return fs.existsSync(d) ? fs.readdirSync(d).filter((n) => fs.existsSync(path.join(d, n, "team.json"))) : [];
}

export function teamStatus(cwd: string, name: string): string {
  loadTeam(cwd, name);
  return statusText(cwd, name);
}

export function teamTool(getRt: (cwd: string) => Runtime): ToolDefinition<typeof TeamParams, Record<string, unknown>> {
  return {
    name: "swarm_team",
    label: "Swarm: team",
    description:
      "Coordinate a team of teammates over a shared task list: dependencies, per-task git worktrees, file-ownership scopes, optional plan approval, quality gates, independent review, live teammate messaging. Each teammate\'s `agent` is a role you define first with swarm_agent (saved per project); built-in names are only examples. Flow: create → run → (approve plans) → review → human runs /swarm merge. Use when tasks depend on each other or modules must be built in order.",
    promptSnippet:
      'swarm_team({ action: "create", name: "feature-x", teammates: [{ name: "impl", agent: "feature-impl" }], tasks: [{ subject: "…", description: "…", files: ["src/x/**"] }] })',
    promptGuidelines: [
      "With swarm_team, split work along module boundaries, declare deps, and give each task a `files` scope so teammates cannot collide. Use background:true for long runs and keep working; you are notified when it settles. Agents never merge: tell the user to run /swarm merge <team> after review.",
    ],
    parameters: TeamParams,
    renderCall: renderCallFor<Params>("swarm_team", (a) => `${a.action} ${a.name}${a.background ? " (background)" : ""}`),
    renderResult: renderResultText,
    async execute(_id, p: Params, signal, onUpdate, ctx) {
      const rt = getRt(ctx.cwd);
      const dir = teamDir(rt.cwd, p.name);
      const text = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: {} as Record<string, unknown> });

      switch (p.action) {
        case "create": {
          if (fs.existsSync(path.join(dir, "team.json"))) throw new Error(`Team "${p.name}" already exists. Use add_task or pick another name.`);
          const mates = p.teammates ?? [];
          if (!mates.length) throw new Error("create requires teammates.");
          const seen = new Set<string>();
          for (const m of mates) {
            assertSafeName(m.name, "teammate name");
            if (m.name === "lead") throw new Error('teammate name "lead" is reserved');
            if (seen.has(m.name)) throw new Error(`duplicate teammate "${m.name}"`);
            seen.add(m.name);
            rt.resolveAgent(m.agent);
          }
          const orgProblems = validateOrg(mates);
          if (orgProblems.length) throw new Error(`invalid team structure: ${orgProblems.join("; ")}`);
          fs.mkdirSync(dir, { recursive: true });
          const team: TeamFile = { name: p.name, createdAt: new Date().toISOString(), teammates: mates };
          fs.writeFileSync(path.join(dir, "team.json"), JSON.stringify(team, null, 2));
          const store = new TaskStore(path.join(dir, "tasks"));
          for (const t of p.tasks ?? []) store.create(t);
          appendLog(teamLog(rt.cwd, p.name), "created", { teammates: mates.length, tasks: p.tasks?.length ?? 0 });
          return text(`Created team ${p.name} with ${mates.length} teammate(s).\n${statusText(rt.cwd, p.name)}\n${overlapWarnings(store).join("\n")}\nNext: action=run.`.trim());
        }
        case "add_task": {
          loadTeam(rt.cwd, p.name);
          if (!p.tasks?.length) throw new Error("add_task requires tasks.");
          const store = new TaskStore(path.join(dir, "tasks"));
          for (const t of p.tasks) store.create(t);
          return text(`${statusText(rt.cwd, p.name)}\n${overlapWarnings(store).join("\n")}`.trim());
        }
        case "team_task_add": {
          loadTeam(rt.cwd, p.name);
          if (!p.subject || !p.description) throw new Error("team_task_add requires subject and description.");
          const store = new TaskStore(path.join(dir, "tasks"));
          const t = store.create({ subject: p.subject, description: p.description, deps: p.deps, files: p.files, plan: true });
          appendLog(teamLog(rt.cwd, p.name), "task_requested", { task: t.id, subject: p.subject });
          return text(`Task ${t.id} requested: ${p.subject} — pending, awaiting the lead's plan approval.\n${statusText(rt.cwd, p.name)}`);
        }
        case "message": {
          const team = loadTeam(rt.cwd, p.name);
          if (!p.to || !p.text) throw new Error("message requires to and text.");
          const box = new Mailbox(path.join(dir, "inbox"));
          if (p.kind !== undefined && !isMessageKind(p.kind)) throw new Error(`unknown kind "${p.kind}". Use: ${MESSAGE_KINDS.join(", ")}`);
          const kind = p.kind as (typeof MESSAGE_KINDS)[number] | undefined;
          if (p.to === "all") return text(`Queued for ${box.broadcast("lead", team.teammates.map((m) => m.name), p.text, { kind })} teammate(s).`);
          const to = p.to.startsWith("@") ? resolveRecipient(p.to, team.teammates, "lead") : p.to;
          if (!to || !team.teammates.some((m) => m.name === to)) throw new Error(`unknown teammate "${p.to}"`);
          box.send("lead", to, p.text, { kind });
          appendLog(teamLog(rt.cwd, p.name), "message", { to, kind });
          return text(`Queued for ${p.to}; delivered live if they are working, otherwise with their next task.`);
        }
        case "inbox": {
          loadTeam(rt.cwd, p.name);
          const msgs = new Mailbox(path.join(dir, "inbox")).drain("lead");
          return text(msgs.length ? formatMessages(msgs) : "(no messages)");
        }
        case "approve":
        case "revise": {
          loadTeam(rt.cwd, p.name);
          if (!p.taskId) throw new Error(`${p.action} requires taskId.`);
          const store = new TaskStore(path.join(dir, "tasks"));
          const t = store.get(p.taskId);
          if (!t || t.status !== "awaiting_approval") throw new Error(`task ${p.taskId} is not awaiting approval.`);
          if (p.action === "revise" && !p.text) throw new Error("revise requires text (what to change).");
          store.update(t.id, { status: "pending", planApproved: p.action === "approve", planFeedback: p.text ?? t.planFeedback });
          appendLog(teamLog(rt.cwd, p.name), p.action, { task: t.id });
          return text(`Task ${t.id} ${p.action === "approve" ? "approved" : "sent back for a new plan"}. Run the team again to continue.`);
        }
        case "status":
          return text(`${teamStatus(rt.cwd, p.name)}${rt.runningJobs().length ? `\n\nBackground jobs: ${rt.runningJobs().map((j) => `${j.id} (${j.name})`).join(", ")}` : ""}`);
        case "stop":
          rt.abortAll("stop requested");
          return text("Aborted running workers and jobs. Unfinished tasks return to pending; run again to resume.");
        case "run": {
          const team = loadTeam(rt.cwd, p.name);
          if (p.background) {
            if (rt.runningJobs().some((j) => j.name === `team:${p.name}`)) throw new Error(`team ${p.name} is already running in the background.`);
            const job = rt.startJob("team", `team:${p.name}`, (jobSignal) => runTeam(rt, team, jobSignal, () => undefined), p.name);
            return text(`Started ${job.id} in the background for team ${p.name}. You will be notified when it settles; use action=status or /swarm jobs to check, action=message to talk to teammates meanwhile.`);
          }
          return text(await runTeam(rt, team, signal, (m) => onUpdate?.({ content: [{ type: "text", text: m }], details: {} })));
        }
      }
    },
  };
}

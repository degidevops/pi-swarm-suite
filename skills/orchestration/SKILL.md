---
name: swarm-orchestration
description: How to define project roles with swarm_agent and how to choose and use swarm_delegate, swarm_team and swarm_workflow for parallel multi-agent work (module splits, fan-out audits, dependent tasks, file-ownership scopes, plan approval, gates, independent review, background runs, live messaging, cross-process attach, dashboard, dynamic task creation). Use when a task is large enough to parallelize.
---

# Swarm orchestration

One extension: `swarm_agent` defines the roles, three tools run them. Pick by task shape:

| Situation | Tool |
|---|---|
| Independent, self-contained tasks (research, review, tests) | `swarm_delegate` (parallel; `chain: true` for a pipeline) |
| Dependent tasks, modules built in order, code that must be merged | `swarm_team` |
| Many items (files/modules) then reduce / cold-verify; runs that must survive interruption | `swarm_workflow` |
| One small task | Do it yourself; do not spawn workers |

## Roles: you build them, per project
There are no ready-made roles to pick from. The built-ins (`reviewer`, `researcher`, `planner`, `oracle`, `worker`) are **examples only** and are refused by the swarm tools (unless `swarm.json` sets `customRolesOnly: false`). Before delegating, define each role the task needs:

```
swarm_agent({ action: "define", name: "auth-reviewer", description: "Reviews auth code",
  tools: ["read","grep","find","ls"],
  prompt: "You review src/auth for race conditions and security bugs. Never modify files. Cite file:line. End with VERDICT: PASS or VERDICT: FAIL." })
```
- Saved to the project's `.pi/agents/<name>.md`, usable immediately as `agent: "auth-reviewer"` in `swarm_delegate`, `swarm_team` teammates and `swarm_workflow` stages. Project-local, never global; commit it to share.
- Design each role for the task: least-privilege `tools`, a prompt that states scope, limits, and what the final reply must contain, and `tier`/`model` if cost matters.
- Tool menu: read-only = `read, grep, find, ls`; `bash` runs checks but can also write files, so omit it for a hard read-only role; add `edit, write` for roles that change code (and isolate them: `worktree: true` or `swarm_team`).
- `swarm_agent action="list"` shows this project's roles (reuse before duplicating); `action="examples"` shows the example roles; `from: "reviewer"` copies one as a starting point; `overwrite: true` replaces a role; `action="remove"` deletes one.
- One-off `swarm_delegate` task: skip the file and pass `role: "<system prompt>"` and `tools: [...]` on the task.
- A `reviewer` configured in `swarm.json` must be a project role that ends with `VERDICT: PASS|FAIL`.

If other delegation tools are also installed (e.g. billion-context's `acp_delegate`), prefer the swarm tools: one `swarm_delegate` task covers single-sub-agent use, and only the swarm tools add parallel batches, worktree isolation, scopes, gates, budget and resume. The `<swarm_orchestration>` system-prompt section tells the model this every session; run `/swarm doctor` to check for conflicts.

## Rules
1. Workers cannot see this conversation. Put full context, file scope and acceptance criteria in every task.
2. Never assign overlapping files to parallel tasks. In `swarm_team` give every task a `files` scope (globs): edits outside it fail the attempt. The tool warns when scopes overlap without a dependency.
3. Tasks that write files need isolation: `worktree: true` in delegate/workflow, or `swarm_team` (worktrees on by default).
4. Agents never merge. After a team run, tell the user to review branches and run `/swarm merge <team>`.
5. Start small (2-4 workers). Check `/swarm cost` before scaling up. A budget stops the run automatically; unfinished tasks stay resumable.
6. Do not let an author grade its own work: define a read-only reviewer role, or use the configured `reviewer` (auto-reviews each task's diff; FAIL triggers a retry with the findings).

## /swarm commands
- `/swarm status <team>` — team status + background jobs
- `/swarm doctor` — environment diagnosis: registered tools, competing delegate tools, agents, config, git
- `/swarm jobs` — list background jobs
- `/swarm tasks` — list tasks (via swarm_team action=status)
- `/swarm log <team>` — team event log
- `/swarm steer <label> <text>` — steer a running worker; falls back to cross-process queue if worker is in another session
- `/swarm merge <team>` — merge completed task branches (human only)
- `/swarm stop` — abort all running workers and jobs
- `/swarm board` — interactive dashboard TUI (worker list, cost breakdown, steer/abort keys)
- `/swarm attach [team]` — list attachable teams or show a team's workers + jobs
- `/swarm tail <team> [taskId]` — tail transcript or list sessions
- `/swarm cost` — per-agent cost breakdown

## swarm_team flow
1. `action: "create"` with `teammates` and `tasks`. Task ids are "1", "2", … in order; `deps` reference earlier ids. Add `plan: true` to risky tasks.
2. `action: "run"`. Add `background: true` to keep working while it runs; you are notified when it settles.
3. If a task shows **awaiting approval**, read the plan in the status and answer with `action: "approve"` (optional text) or `"revise"` (text = what to change), then `run` again.
4. While running: `action: "status"`, `action: "message"` (to a teammate or `"all"`, delivered live to a working teammate), `action: "inbox"` (what teammates sent you).
5. Interrupted or stopped? Call `run` again: unfinished tasks resume, completed ones are kept.

Teammates have `team_message`, `team_inbox`, `team_tasks` to coordinate (interfaces, blockers, handoffs). Tell them to message only when it matters.

## swarm_workflow flow
Stages run in order. `fanout` = one worker per item (parallel; `worktree: true` gives each item its own branch); `single` = one worker (reduce/verify). Use `{item}`, `{index}`, `{results}`, `{input}` in templates. Pass the same `runId` to resume: completed steps replay from the journal at no cost. `background: true` returns immediately and notifies on completion.

## swarm_team new features
- `action: "team_task_add"` — teammates create pending tasks; subject, description, deps, files, plan. Lead approves/revises.
- `/swarm board` — dashboard overlay showing workers, jobs, cost per agent, steer/abort keys.
- `/swarm attach <team>` — view a running team's workers and jobs from another session.
- `/swarm tail <team> [taskId]` — read per-task transcripts or session logs.
- Pre/post-task hooks via `swarm.json` `preHooks`/`postHooks`.
- Per-agent cost breakdown via `/swarm cost`.

## Team as an organisation (v0.5)
When you create a `swarm_team`, give teammates structure so they coordinate like a real team: `title`, `role` (what they are responsible for), `reportsTo` (another teammate or `lead` — builds an escalation chain, e.g. two engineers reporting to a tech lead who reports to you) and `owns` (file globs). Teammates then use `team_ask` (ask and wait), `team_message kind=blocker|handoff|question`, `team_directory` and `team_decide` on their own; watch for `[swarm team]` messages and answer with `swarm_team action=message to=<name> kind=answer`. Prefer a small chain of command (≤ 2 levels) over everyone reporting to you.

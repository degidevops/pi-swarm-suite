---
name: swarm-orchestration
description: How to choose and use swarm_delegate, swarm_team and swarm_workflow for parallel multi-agent work (module splits, fan-out audits, dependent tasks, file-ownership scopes, plan approval, gates, independent review, background runs, live messaging). Use when a task is large enough to parallelize.
---

# Swarm orchestration

One extension, three tools. Pick by task shape:

| Situation | Tool |
|---|---|
| Independent, self-contained tasks (research, review, tests) | `swarm_delegate` (parallel; `chain: true` for a pipeline) |
| Dependent tasks, modules built in order, code that must be merged | `swarm_team` |
| Many items (files/modules) then reduce / cold-verify; runs that must survive interruption | `swarm_workflow` |
| One small task | Do it yourself; do not spawn workers |

## Rules
1. Workers cannot see this conversation. Put full context, file scope and acceptance criteria in every task.
2. Never assign overlapping files to parallel tasks. In `swarm_team` give every task a `files` scope (globs): edits outside it fail the attempt. The tool warns when scopes overlap without a dependency.
3. Tasks that write files need isolation: `worktree: true` in delegate/workflow, or `swarm_team` (worktrees on by default).
4. Agents never merge. After a team run, tell the user to review branches and run `/swarm merge <team>`.
5. Start small (2-4 workers). Check `/swarm cost` before scaling up. A budget stops the run automatically; unfinished tasks stay resumable.
6. Do not let an author grade its own work: use a read-only reviewer agent, or the configured `reviewer` (auto-reviews each task's diff; FAIL triggers a retry with the findings).

## swarm_team flow
1. `action: "create"` with `teammates` and `tasks`. Task ids are "1", "2", … in order; `deps` reference earlier ids. Add `plan: true` to risky tasks.
2. `action: "run"`. Add `background: true` to keep working while it runs; you are notified when it settles.
3. If a task shows **awaiting approval**, read the plan in the status and answer with `action: "approve"` (optional text) or `"revise"` (text = what to change), then `run` again.
4. While running: `action: "status"`, `action: "message"` (to a teammate or `"all"`, delivered live to a working teammate), `action: "inbox"` (what teammates sent you).
5. Interrupted or stopped? Call `run` again: unfinished tasks resume, completed ones are kept.

Teammates have `team_message`, `team_inbox`, `team_tasks` to coordinate (interfaces, blockers, handoffs). Tell them to message only when it matters.

## swarm_workflow flow
Stages run in order. `fanout` = one worker per item (parallel; `worktree: true` gives each item its own branch); `single` = one worker (reduce/verify). Use `{item}`, `{index}`, `{results}`, `{input}` in templates. Pass the same `runId` to resume: completed steps replay from the journal at no cost. `background: true` returns immediately and notifies on completion.

# Roadmap

## Verification status (be honest about this)
- Typecheck clean; 85 tests pass (unit, real-git worktree/merge/conflict flows, and end-to-end runs against a scripted fake `pi` that speaks pi's documented JSON and RPC protocols).
- Loads in real pi (v1.6.0) in all three roles (parent, teammate child, plain child) and `/swarm` is exposed in real `pi --mode rpc`.
- **Real-model shakedown:** verified against `nvidia/nemotron-3.5-super-vl-120b-a12b` via `pi install ./`. `swarm_delegate`, `swarm_team action=create`, `swarm_team action=run`, git worktrees/commits/merges all work end-to-end with real model traffic.

## Done (v0.2.0)
- Shared runtime for all modes; one widget, one skill, unique tool names.
- Steerable RPC workers (live instructions, clean abort/shutdown, auto-cancel of headless extension dialogs).
- Teammate-initiated messaging (`team_message`/`team_inbox`/`team_tasks` inside children) with live delivery via steering; lead inbox.
- Background team/workflow runs with completion notification that wakes the lead; `/swarm jobs`, `/swarm stop <job>`.
- Plan approval (`plan: true`, `approve`/`revise`).
- File-ownership scopes with enforcement + overlap warnings.
- Independent reviewer gate (`reviewer` config) with retry on FAIL.
- Per-item worktrees in workflows; journaled resume incl. branches.
- Tier routing (`tier:` in agent files, auto-cheap for read-only agents).
- Compact tool renderers, `/swarm tasks|log|steer`, per-team event log.

## Done (post-v0.2.0, all verified)
1. ✅ **Real-model shakedown** + CI that runs `npm run check` (`.github/workflows/check.yml`).
2. ✅ **Interactive dashboard TUI** — `src/ui-dashboard.ts` with `/swarm board`: per-worker list (status icons, steerable marker, seconds, last line), background jobs, cost breakdown (per agent), transient status messages, key hints (s=steer, a=abort, r=refresh, q=quit).
3. ✅ **Session-persisted workers** — `sessionDir` wired through `ChildSpec` → `WorkerOptions` → `WorkerInfo` → `run()`; team tasks create `.pi/swarm/teams/<team>/sessions/<taskId>/`; `/swarm tail <team> [taskId]` tails transcripts or lists sessions.
4. ✅ **Conflict-resolution agent** — `src/core/git.ts` adds `createScratchWorktree`, `checkoutTheirs`, `checkoutOurs`, `listUnmerged`, `markResolved`, `resolveWithOurs`, `resolveWithTheirs`, `commitResolution`. `mergeTeam` creates a scratch worktree, resolves conflicts with theirs, commits resolution, merges back into current branch.
5. ✅ **Transcript persistence** — `src/core/transcript.ts`: JSONL per task at `.pi/swarm/teams/<team>/transcripts/<taskId>.jsonl`. Entries for each attempt (output/error), complete (with usage), fail, hook, review failures.
6. ✅ **Dynamic task creation by teammates** — `team_task_add` action + `team_task_request` child tool; creates pending tasks needing plan approval.
7. ✅ **Cross-process attach** — `src/core/attach.ts`: disk-based team/worker/job state + steer commands under `.pi/swarm/attach/teams/<team>/`. `/swarm attach` lists running teams or shows workers/jobs. `/swarm steer` falls back to disk queue for workers not live in this session; `ensureSteerPolling()` (1s interval) applies pending cross-process steer commands.
8. ✅ **Per-agent cost breakdown** — `Ledger.perAgent` Map, `snapshotByAgent()`, `agentCost()`; `/swarm cost` shows breakdown by agent when >1 agent has cost.
9. ✅ **Hooks** — `preHooks`/`postHooks` in `SwarmConfig` and `swarm.json`; run via `runGates` before/after task attempts; transcript entries for hook events.
10. ⬜ **Windows** support (gates use the shell; worktree paths untested).
11. ⬜ **Publish**: repository URL (done — https://github.com/degidevops/pi-swarm-suite.git), `pi-package` listing, semver policy, pin minimum pi version after real-model tests.

## Deliberately not built
- Arbitrary-code workflow scripts (like `.dwf.ts`): workflows are declarative JSON so a model-written plan cannot execute code. Revisit only with sandboxing.
- Auto-merge: merging stays a human decision.
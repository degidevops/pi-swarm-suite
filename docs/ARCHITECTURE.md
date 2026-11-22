# Architecture

## Why one package
Separate swarm packages each register their own `workflow` tool/skill, so pi disables one of them. Here every mode shares one `Runtime`, one ledger, one widget, one skill and uniquely named tools.

```
index.ts ─ registers swarm_delegate / swarm_team / swarm_workflow + /swarm
   │
   ├─ modes/delegate  ─┐
   ├─ modes/team      ─┼─►  Runtime.run()  ─►  core/worker (spawn `pi --mode json -p --no-session`)
   └─ modes/workflow  ─┘        │
                                ├─ Ledger (tokens/cost, per-agent breakdown, budget → abortAll)
                                ├─ concurrency via core/pool
                                ├─ attach state (core/attach.ts) for cross-process steer
                                └─ widget lines (one live widget)
core: tasks (file-per-task, lock) · mailbox (JSONL) · journal (JSONL replay) · git (worktrees + conflict resolution) · gates (shell) · transcripts (JSONL per task)
```

## Files by concern

| File | Responsibility |
|---|---|
| `src/index.ts` | Registers 3 tools + `/swarm` commands (status, jobs, tasks, log, steer, merge, stop, board, attach, tail, cost, doctor). Injects the `<swarm_orchestration>` system-prompt section in `before_agent_start` (with live competitor detection from `selectedTools`). At `PI_SWARM_DEPTH >= 1` registers ONLY teammate tools. |
| `src/runtime.ts` | `Runtime` — one launcher for every worker. Concurrency, ledger, budget, abort, widget. `steer()`, `abortAll()`, `stopJob()`, `ensureSteerPolling()` (cross-process steer), `agentCosts()`, `listAttachableTeams()`, `getTeamRunning()`, `getTeamWorkers()`, `getTeamJobs()`. |
| `src/types.ts` | `SwarmConfig` (incl. `preHooks`, `postHooks`), `AgentDef`, `Tier`, `Usage`, `WorkerResult`. |
| `src/core/child.ts` | `ChildSpec` — arg/env/binary for children; `--session-dir` when `sessionDir` is set, else `--no-session`. |
| `src/core/worker.ts` | one-shot JSON worker + `Collector`. `WorkerOptions.sessionDir`. |
| `src/core/rpc.ts` | `RpcWorker` — steerable RPC worker (steer mid-run, clean abort, auto-cancel dialogs). |
| `src/core/tasks.ts` | `TaskStore` — file-per-task with locking. |
| `src/core/mailbox.ts` | `Mailbox` — JSONL inbox per teammate. |
| `src/core/journal.ts` | `Journal` — JSONL replay for workflow resume. |
| `src/core/git.ts` | worktrees, branches, merge, conflict resolution (`createScratchWorktree`, `resolveWithTheirs`, `commitResolution`, …). |
| `src/core/gates.ts` | `runGates` — shell commands from trusted config; `formatGateFailure`. |
| `src/core/scope.ts` | `outsideScope`, `scopesOverlap` — file-ownership enforcement. |
| `src/core/review.ts` | `buildReviewPrompt`, `parseVerdict` — independent reviewer. |
| `src/core/eventlog.ts` | per-team event log (`appendLog`). |
| `src/core/config.ts` | `parseConfig` — parses `swarm.json` including `preHooks`/`postHooks`. |
| `src/core/agents.ts` | agent definition loading: `BUILT_IN_AGENTS` (reviewer/researcher/planner/oracle/worker, zero-setup) + discovery of user (`~/.pi/agent/agents`) and project (`.pi/agents`, trusted only) files; later sources override built-ins by name. |
| `src/core/prompt.ts` | model-visibility layer: `buildSwarmSection` (the `<swarm_orchestration>` prompt body), `detectCompetitorTools` (finds acp_delegate & friends in the active tool list), `summarizeCompetitors`, `SWARM_TOOL_NAMES`. |
| `src/core/doctor.ts` | `/swarm doctor` report: active tools, competing delegate tools + per-package opt-out advice, agents by source, config, git, budget. |
| `src/core/ledger.ts` | `Ledger` — tokens/cost, `perAgent` breakdown, `snapshotByAgent()`, `agentCost()`. |
| `src/core/pool.ts` | concurrency pool. |
| `src/core/transcript.ts` | `appendTranscript`, `readTranscript` — JSONL per task for post-mortems. |
| `src/core/attach.ts` | `writeTeamRunning`/`readTeamRunning`, `writeWorkerState`/`readTeamWorkers`, `writeJobState`/`readTeamJobs`, `writeSteerCommand`/`pollSteerCommands`, `listRunningTeams`, `hasRunningTeams`. |
| `src/core/util.ts` | `assertSafeName`, `formatTokens`, `formatUsd`, `sleep`, `truncate`, `firstLine`. |
| `src/child-tools.ts` | teammate-side tools (`team_message`, `team_inbox`, `team_tasks`, `team_task_request`). |
| `src/modes/delegate.ts` | `swarm_delegate` tool factory. |
| `src/modes/team.ts` | `swarm_team` tool factory; `runTeam()` (planning pass → worker → scope → gates → review → commit), `mergeTeam()` (conflict-resolution via scratch worktree). |
| `src/modes/workflow.ts` | `swarm_workflow` tool factory; fan-out/reduce with journaled resume. |
| `src/ui.ts` | tool renderers (`renderCallFor`, `renderResultText`). |
| `src/ui-dashboard.ts` | `DashboardComponent` — TUI overlay for `/swarm board`. |

## Worker kinds
| Kind | Process | Used by | Capabilities |
|---|---|---|---|
| JSON worker | `pi --mode json -p --no-session` | delegate, workflow, reviewer | one-shot, cheapest, not steerable |
| RPC worker | `pi --mode rpc --no-session` | team tasks | steer mid-run, clean abort, orderly shutdown (close stdin), auto-cancel of dialogs |

## Workers
Each worker is a separate `pi` process (`--mode json -p --no-session`) so it has an isolated context window. Env `PI_SWARM_DEPTH` is incremented; the extension registers nothing when depth ≥ 1, so workers cannot spawn swarms. System prompt comes from the agent `.md` file via `--append-system-prompt <tempfile>`.

## Teammate tools (inside children)
Team children get `PI_SWARM_TEAM_DIR`/`PI_SWARM_MATE` and `-e <this extension>`; at depth ≥ 1 the extension registers only `team_message`, `team_inbox`, `team_tasks`, `team_task_request` (and nothing else), guarded by a process-wide flag so `-e` plus an installed copy cannot double-register. A message to a teammate that is mid-task is picked up by the lead's 600 ms watcher and delivered with `steer`; otherwise it is injected into their next task prompt. Messages to `lead` surface in the run result / `action: inbox`.

## Team mode
- State: `.pi/swarm/teams/<name>/{team.json,tasks/*.json,inbox/*.jsonl,transcripts/<taskId>.jsonl,sessions/<taskId>/}`.
- Per task, in order: optional planning pass (read-only tools) → worker (steerable) → **scope check** (`git status` vs `files` globs) → **gates** → **independent review** of the staged diff (`reviewer`) → commit. Any failure retries with the failure text injected (≤ `maxAttempts`).
- Pre-hooks run before the attempt loop; post-hooks run after review passes before commit.
- Scheduler: one loop per teammate (capped by `maxConcurrency`): settle blocked → `claimNext` (deps completed) → worktree → run → gates → commit → complete.
- Dependent tasks get predecessor branches merged into their fresh worktree first.
- Gate failure or worker failure ⇒ retry (≤ `maxAttempts`) with the failure text injected; then `failed`, dependents become `blocked`.
- Abort/budget stop ⇒ task returns to `pending`; calling `run` again resumes (`resetStale` also recovers crashed runs).
- Merge is human-only: `/swarm merge <team>`. On conflict, `mergeTeam` creates a scratch worktree, resolves with theirs, commits, merges back into current branch.

## Background jobs
`background: true` runs `runTeam`/`runWorkflow` as a `Runtime` job with its own AbortController (stopped by `/swarm stop <id>` or `abortAll`). When it settles, `pi.sendMessage(..., {triggerTurn:true, deliverAs:"followUp"})` wakes the lead with the result. Jobs die with the pi process; task/journal state persists so calling `run` again resumes.

## Workflow mode
Declarative JSON (no arbitrary code execution). Step key = `stageId:index:sha1(prompt|agent|model)`; successes append to `.pi/swarm/runs/<runId>/journal.jsonl`; resume replays them.

## Cross-process attach
Team runtime state (`running.json`, worker state, job state) is written to `.pi/swarm/attach/teams/<team>/`. A second pi session can call `/swarm attach <team>` to read it. Steer commands are queued as files under `steer/` and consumed by the originating session's 1s `ensureSteerPolling()` interval, which applies them via `rt.steer(label, text)`.

## Security model
Project config/agents need trust. Gates run via shell from trusted config only. Names are validated before touching the filesystem. Workers inherit your environment and tool permissions: restrict `tools:` in agent files (reviewer/scout are read-only).

## Smoke test (real pi, no model needed)
```bash
# in a scratch dir with pi's SDK installed
node --import tsx sdkload.mts   # DefaultResourceLoader({extensionFactories:[swarm]}) → getActiveToolNames()
# expect: read, bash, edit, write, swarm_delegate, swarm_team, swarm_workflow
```
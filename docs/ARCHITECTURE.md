# Architecture

## Why one package
Separate swarm packages each register their own `workflow` tool/skill, so pi disables one of them. Here every mode shares one `Runtime`, one ledger, one widget, one skill and uniquely named tools.

```
index.ts ─ registers swarm_delegate / swarm_team / swarm_workflow + /swarm
   │
   ├─ modes/delegate  ─┐
   ├─ modes/team      ─┼─►  Runtime.run()  ─►  core/worker (spawn `pi --mode json -p --no-session`)
   └─ modes/workflow  ─┘        │
                                ├─ Ledger (tokens/cost, budget → abortAll)
                                ├─ concurrency via core/pool
                                └─ widget lines (one live widget)
core: tasks (file-per-task, lock) · mailbox (JSONL) · journal (JSONL replay) · git (worktrees) · gates (shell)
```

## Worker kinds
| Kind | Process | Used by | Capabilities |
|---|---|---|---|
| JSON worker | `pi --mode json -p --no-session` | delegate, workflow, reviewer | one-shot, cheapest, not steerable |
| RPC worker | `pi --mode rpc --no-session` | team tasks | steer mid-run, clean abort, orderly shutdown (close stdin), auto-cancel of dialogs |

## Workers
Each worker is a separate `pi` process (`--mode json -p --no-session`) so it has an isolated context window. Env `PI_SWARM_DEPTH` is incremented; the extension registers nothing when depth ≥ 1, so workers cannot spawn swarms. System prompt comes from the agent `.md` file via `--append-system-prompt <tempfile>`.

## Teammate tools (inside children)
Team children get `PI_SWARM_TEAM_DIR`/`PI_SWARM_MATE` and `-e <this extension>`; at depth ≥ 1 the extension registers only `team_message`, `team_inbox`, `team_tasks` (and nothing else), guarded by a process-wide flag so `-e` plus an installed copy cannot double-register. A message to a teammate that is mid-task is picked up by the lead's 600 ms watcher and delivered with `steer`; otherwise it is injected into their next task prompt. Messages to `lead` surface in the run result / `action: inbox`.

## Team mode
- State: `.pi/swarm/teams/<name>/{team.json,tasks/*.json,inbox/*.jsonl}`.
- Per task, in order: optional planning pass (read-only tools) → worker (steerable) → **scope check** (`git status` vs `files` globs) → **gates** → **independent review** of the staged diff (`reviewer`) → commit. Any failure retries with the failure text injected (≤ `maxAttempts`).
- Scheduler: one loop per teammate (capped by `maxConcurrency`): settle blocked → `claimNext` (deps completed) → worktree → run → gates → commit → complete.
- Dependent tasks get predecessor branches merged into their fresh worktree first.
- Gate failure or worker failure ⇒ retry (≤ `maxAttempts`) with the failure text injected; then `failed`, dependents become `blocked`.
- Abort/budget stop ⇒ task returns to `pending`; calling `run` again resumes (`resetStale` also recovers crashed runs).
- Merge is human-only: `/swarm merge <team>`.

## Background jobs
`background: true` runs `runTeam`/`runWorkflow` as a `Runtime` job with its own AbortController (stopped by `/swarm stop <id>` or `abortAll`). When it settles, `pi.sendMessage(..., {triggerTurn:true, deliverAs:"followUp"})` wakes the lead with the result. Jobs die with the pi process; task/journal state persists so calling `run` again resumes.

## Workflow mode
Declarative JSON (no arbitrary code execution). Step key = `stageId:index:sha1(prompt|agent|model)`; successes append to `.pi/swarm/runs/<runId>/journal.jsonl`; resume replays them.

## Security model
Project config/agents need trust. Gates run via shell from trusted config only. Names are validated before touching the filesystem. Workers inherit your environment and tool permissions: restrict `tools:` in agent files (reviewer/scout are read-only).

## Smoke test (real pi, no model needed)
```bash
# in a scratch dir with pi's SDK installed
node --import tsx sdkload.mts   # DefaultResourceLoader({extensionFactories:[swarm]}) → getActiveToolNames()
# expect: read, bash, edit, write, swarm_delegate, swarm_team, swarm_workflow
```

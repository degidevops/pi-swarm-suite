# pi-swarm-suite

One pi extension that replaces a stack of swarm packages (and their tool/skill collisions) with three modes on a shared runtime, modelled on Claude Code's subagents, agent teams and dynamic workflows, plus a few things Claude Code does not do.

| Tool | Claude Code analogue | Use for |
|---|---|---|
| `swarm_delegate` | subagents | independent tasks in parallel (or `chain`) |
| `swarm_team` | agent teams | dependent tasks, shared task list, live messaging, worktrees, scopes, plan approval, gates, review |
| `swarm_workflow` | dynamic workflows | fan-out → reduce/verify, journaled resume, per-item worktrees |

Plus `/swarm` (status, jobs, tasks, log, steer, merge, stop, board, attach, tail, cost, **doctor**), a live widget, a cost ledger with per-agent breakdown, tier-based model routing, dynamic task creation, cross-process attach, one skill that teaches the model which mode to pick, **five built-in agents that work with zero setup**, and a dedicated `<swarm_orchestration>` system-prompt section so the model actually prefers these tools over other delegation packages.

## Built-in agents (zero setup)

| Agent | Tools | Use for |
|---|---|---|
| `reviewer` | read-only (+bash for checks) | code review; ends with `VERDICT: PASS` / `VERDICT: FAIL` |
| `researcher` | read-only (+bash) | codebase investigation, call paths |
| `planner` | read-only (+bash) | step-by-step implementation plans |
| `oracle` | read-only (+bash) | questions, advice, trade-offs |
| `worker` | read, edit, write, bash | implementation (use `worktree: true`) |

They exist so a fresh install can delegate immediately — no agent files required. Your own `.md` files (in `~/.pi/agent/agents` or `.pi/agents`) override built-ins by name.

## What's implemented (v0.3.0)

**All three modes** — delegate, team, workflow — on one `Runtime` with shared ledger, concurrency, budget, abort, and live widget.

**Model inheritance (v0.3.0):** workers default to the lead session's current model (also after a mid-session model switch) when neither the task, the agent, nor `swarm.json models.*` names one.

**Model-visibility layer (v0.3.0):** the extension injects a `<swarm_orchestration>` section into the system prompt (mode routing, built-in agents, example call, rules). When another delegation tool is also installed (billion-context's `acp_delegate`, pi-subagents, …) the section gains an explicit preference paragraph telling the model to use the swarm tools for delegation — detected live from the active tool list. Tool snippets are concrete call examples. `/swarm doctor` reports the whole environment: active tools, competing delegate tools with per-package opt-out advice, agents by source, config, git, budget.

**Team mode additions:**
- `team_task_add` — teammates create new pending tasks; lead approves/revises plans
- Pre/post-task hooks (`preHooks`/`postHooks` in `swarm.json`)
- Per-agent cost breakdown (`/swarm cost`)
- Conflict-resolution on merge (scratch worktree + `resolveWithTheirs`)
- Transcript persistence per task (JSONL under `.pi/swarm/teams/<team>/transcripts/`)
- Session-persisted workers (`--session-dir`) with `/swarm tail <team> [taskId]`
- Interactive dashboard (`/swarm board`) with worker list, cost breakdown, steer/abort keys
- Cross-process attach (`/swarm attach` + cross-process steer)

**Swarm commands:** `status`, `jobs`, `tasks`, `log`, `steer`, `merge`, `stop`, `board`, `attach`, `tail`, `cost`, `doctor`

## Coexistence with billion-context (and other delegate packages)

You do NOT have to uninstall billion-context to use pi-swarm-suite: its compression stays useful and the swarm extension now competes for the model's attention on equal terms — dedicated prompt section, example-bearing tool snippets and built-in roles. `/swarm doctor` shows exactly which delegation tools are active and, if you still prefer to remove the overlap, how to turn the other one off (e.g. `"delegate": false` in billion-context's `~/.pi/agent/acp.json`).

## CI: testing inside real pi (no token needed)

`.github/workflows/pi-check.yml` runs three jobs:
1. **unit** — typecheck + 100+ tests incl. end-to-end runs against a scripted fake pi.
2. **pi-headless** — installs real pi, loads the extension (`-e` AND via `pi install ./`), and asserts what the model would see: tools listed, snippets are examples, `<swarm_orchestration>` injected, and coexistence with billion-context detected. Uses `scripts/diagnose-prompt.mjs` — no API token required.
3. **pi-realtest** — the actual tool-choice battle with a real model (billion-context installed alongside). Needs repo secrets `PI_TEST_API_KEY` + vars `PI_TEST_PROVIDER`, `PI_TEST_MODEL`; skips gracefully when absent. Run it locally too: `PI_TEST_PROVIDER=openrouter PI_TEST_MODEL=openrouter/auto PI_TEST_API_KEY=... node scripts/realtest-toolchoice.mjs`.

## Monitoring, stuck workers and tmux

A worker that is silent for a while is ambiguous: waiting on a slow model, running a long tool, or hung. Every worker is now watched from its event stream:

| What you see | Meaning |
|---|---|
| `● w ⇄ 312s  tool:bash 45s · idle 4s` | running; currently in the `bash` tool for 45 s; last event 4 s ago |
| `⚠` + `quiet` | no events for `idleWarnSec` (slow phases — tool, waiting for model, retry, compaction — get ×`slowPhaseFactor` slack) |
| `✖` + `stalled` | no events for `idleKillSec`: the worker is stopped and reported as **failed** (`stalled: …`), so team mode retries it with the reason injected |

For RPC (team) workers a quiet worker is also asked `get_state`: the log then says whether the *process answered* (just slow / blocked in a tool) or did **not** answer (hung). Honest limit: this detects and recovers from stalls, it cannot prevent them. A quiet-for-minutes build that prints nothing needs a larger `idleKillSec` (or `slowPhaseFactor`).

Commands: `/swarm monitor` (health table), `/swarm open [label]` (state, what it is doing, log tail, how to follow it), `/swarm say <label> <text>` (talk to a running RPC worker; one-shot workers cannot be steered), `/swarm kill <label>`, `/swarm tmux [on|off|kill]`. When a worker is stopped as stalled the **lead agent is told** (a `swarm-alert` message) so it can re-plan; "quiet" only warns you.

Every worker writes a live log to `.pi/swarm/workers/<run>/<label>.log` (newest 20 runs kept): `tail -F` it from any terminal. With tmux on, each worker also gets its own window in a detached session — `tmux attach -t swarm-<project>`: a `monitor` window with the status table, plus one window per worker following its log; when the worker ends the window drops into a shell in the worker's working directory (its worktree for team tasks). Windows are viewers only: closing them never kills a worker.

```json
{
  "monitor": { "idleWarnSec": 60, "idleKillSec": 300, "slowPhaseFactor": 3, "maxWorkerSec": 0, "probe": true, "nudge": false },
  "tmux": true
}
```
(`0` disables a threshold. `nudge: true` sends a status steer to a quiet worker that is idle between calls — best effort.)

## How it compares (honest)
**On par / modelled on Claude Code:** parallel subagents; lead + teammates with shared task list and dependencies; teammates messaging each other and the lead; plan approval; background runs that notify the lead; steering a running worker; worktree isolation; custom agent files.
**Beyond what Claude Code offers:** file-ownership scopes enforced per task; independent reviewer gate on the actual diff; hard cost budget that stops runs and keeps them resumable; journaled workflow resume (no re-spend); per-item worktree fan-out; automatic cheap-tier routing for read-only agents; any model/provider pi supports; merging only by a human command; cross-process attach; dashboard TUI; dynamic task creation; per-agent cost breakdown; transcript persistence.
**Where Claude Code is ahead:** it is native and officially supported, has a polished interactive UI and split-pane teammate view.

## Install
```bash
# straight from GitHub (public repo; auto-updates to main on every pi start / reload):
pi install https://github.com/degidevops/pi-swarm-suite
# or pin a ref:  pi install git:github.com/degidevops/pi-swarm-suite@main
# or per-project only:
pi install https://github.com/degidevops/pi-swarm-suite --local

# from a source checkout (development / release tarball):
tar xzf pi-swarm-suite.tar.gz && cd pi-swarm-suite
npm install
npm run check                 # typecheck + tests (uses a scripted fake pi)
pi install ./                 # or: pi -e ./src/index.ts to try it for one session
```
Remove other orchestration packages first (`pi-subagents`, `pi-dynamic-workflows`, …) to avoid duplicate tools. Requires pi ≥ 1.4 (built against 1.6.0) and Node ≥ 22.

## Real-model shakedown
Verified against `nvidia/nemotron-3.5-super-vl-120b-a12b` via `pi install ./`:
- `swarm_delegate` reads and summarizes files correctly
- `swarm_team action=create` parses tasks and scopes
- `swarm_team action=run` executes tasks in isolated worktrees with scope enforcement
- Git worktrees, commits, and merges work end-to-end

## Optional setup — `pi install` is enough

Out of the box, with no other steps: five built-in agents (`reviewer`, `researcher`, `planner`,
`oracle`, `worker`) cover the common delegation roles, and sane defaults apply (concurrency 4,
worktrees on, retries 2). Nothing else to configure.

The block below is **customization only** — copy it when you want your own agent definitions or
non-default behaviour; both override the built-ins by name:
```bash
mkdir -p ~/.pi/agent/agents && cp examples/agents/*.md ~/.pi/agent/agents/   # your own agents (override built-ins)
cp examples/swarm.json ~/.pi/agent/swarm.json     # global config; or <repo>/.pi/swarm.json (trusted projects only)
```
Diagnose your environment any time with `/swarm doctor` (inside pi) or `node scripts/diagnose-prompt.mjs` (headless, no token).
`swarm.json` (all keys optional): `maxConcurrency` (cap 16), `budgetUsd`, `worktrees`, `gates` (shell commands that must pass), `maxAttempts`, `reviewer` (agent that reviews each task's diff), `models.{lead,worker,cheap}`, `workerTools`, `preHooks`, `postHooks`, `monitor.{idleWarnSec,idleKillSec,slowPhaseFactor,maxWorkerSec,probe,nudge,tickMs}`, `tmux` (`true` or `{enabled, session}`). Agent files take `name`, `description`, `tools`, `model`, `tier: lead|worker|cheap`.

## Typical session
```
> Create team "market-core" from examples/team-market-core.json and run it in the background.
… the lead is woken when it settles; plans awaiting approval are shown …
> approve task 1
> run again
… review branches …
/swarm merge market-core
```
Other examples: `examples/workflow-audit.json` (fan-out audit with cold verify), `examples/trading-platform-AGENTS.md` (project rules template).

## Safety
Agents never merge; you do (`/swarm merge`). Project config/agents load only in trusted projects. Workers inherit your credentials and file access: limit `tools:` per agent (reviewer/scout are read-only). Set `budgetUsd`; start with 2–4 workers. Headless workers auto-cancel extension dialogs, so extensions that ask for confirmation will be denied inside workers.

## Status
Typecheck clean; 111 tests pass (unit, real git, end-to-end vs a scripted fake pi, prompt-visibility, doctor); loads in real pi in all three roles (verified headless in CI with and without billion-context); real-model shakedown passed on nvidia provider. Dev-only `npm audit` notes come from vitest's transitive deps; production dependencies have none.

See `AGENTS.md` (for agents/contributors), `docs/ARCHITECTURE.md`, `docs/ROADMAP.md`, and `docs/FIX-DELEGATION.md` (why the model used to prefer billion-context's acp_delegate, and what changed).
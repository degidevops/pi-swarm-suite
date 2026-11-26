# pi-swarm-suite

One pi extension that replaces a stack of swarm packages (and their tool/skill collisions) with three modes on a shared runtime plus a role builder (`swarm_agent`), modelled on Claude Code's subagents, agent teams and dynamic workflows, plus a few things Claude Code does not do.

| Tool | Claude Code analogue | Use for |
|---|---|---|
| `swarm_delegate` | subagents | independent tasks in parallel (or `chain`) |
| `swarm_team` | agent teams | dependent tasks, shared task list, live messaging, worktrees, scopes, plan approval, gates, review |
| `swarm_workflow` | dynamic workflows | fan-out → reduce/verify, journaled resume, per-item worktrees |

Plus `/swarm` (status, jobs, tasks, log, steer, merge, stop, board, attach, tail, cost, **doctor**), a live widget, a cost ledger with per-agent breakdown, tier-based model routing, dynamic task creation, cross-process attach, one skill that teaches the model which mode to pick, **five example roles plus `swarm_agent`, so the lead builds the roles each project needs**, and a dedicated `<swarm_orchestration>` system-prompt section so the model actually prefers these tools over other delegation packages.

## Example roles (built-in)

| Agent | Tools | Use for |
|---|---|---|
| `reviewer` | read-only (+bash for checks) | code review; ends with `VERDICT: PASS` / `VERDICT: FAIL` |
| `researcher` | read-only (+bash) | codebase investigation, call paths |
| `planner` | read-only (+bash) | step-by-step implementation plans |
| `oracle` | read-only (+bash) | questions, advice, trade-offs |
| `worker` | read, edit, write, bash | implementation (use `worktree: true`) |

**They are examples, not usable roles.** By default (`customRolesOnly: true`) the lead agent must build the roles a project needs with the `swarm_agent` tool, which saves them to that project's `.pi/agents/` (never global). Defined roles work in `swarm_delegate`, `swarm_team` and `swarm_workflow`; `swarm_delegate` also accepts a one-off inline `role` + `tools` on a task.

```
swarm_agent({ action: "define", name: "db-auditor", description: "Audits SQL migrations",
              tools: ["read","grep","find","ls"], prompt: "You audit migrations/ ... Never modify files." })
```
`swarm_agent` also has `list`, `examples` (shows the built-ins to adapt; `from: "reviewer"` copies one), and `remove`. Files are re-read on every call, so a role works the moment it exists. Set `"customRolesOnly": false` in `swarm.json` to use built-ins and global `~/.pi/agent/agents` directly (project roles still override by name).

Note: the example "read-only" roles include `bash`, which can write; omit it for a hard guarantee. Full reference: [docs/CUSTOM-AGENTS.md](docs/CUSTOM-AGENTS.md).

## What's implemented (v0.3.0)

**All three modes** — delegate, team, workflow — on one `Runtime` with shared ledger, concurrency, budget, abort, and live widget.

**Model inheritance (v0.3.0):** workers default to the lead session's current model (also after a mid-session model switch) when neither the task, the agent, nor `swarm.json models.*` names one.

**Model-visibility layer (v0.3.0):** the extension injects a `<swarm_orchestration>` section into the system prompt (mode routing, how to build project roles with `swarm_agent`, example calls, rules). When another delegation tool is also installed (billion-context's `acp_delegate`, pi-subagents, …) the section gains an explicit preference paragraph telling the model to use the swarm tools for delegation — detected live from the active tool list. Tool snippets are concrete call examples. `/swarm doctor` reports the whole environment: active tools, competing delegate tools with per-package opt-out advice, agents by source, config, git, budget.

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

## Team communication (v0.5)

Teams behave like an organisation, not N isolated task runners:

- **Org chart.** `swarm_team create` teammates take `title`, `role` (responsibility), `reportsTo` (another teammate or `lead`) and `owns` (file globs). Every teammate's prompt contains the chart *with live activity* ("ana — Backend lead — working on #3 routes") and short working agreements (ask the owner before touching their files, escalate blockers to your manager, hand off what others build on, record decisions).
- **Ask and wait.** `team_ask to=@owner:api/x.ts question=…` blocks until the owner answers (answer = `team_message kind=answer replyTo=<id>`); aliases `@manager`, `@lead`, `@owner:<path>`. If the person is not working at that moment it returns at once so nobody deadlocks.
- **Pushed, not polled.** While a teammate works, its own process drains its inbox and steers itself, so peers reach each other directly; the lead is told about new mail (blockers/questions wake the lead).
- **Typed messages.** `kind`: info, question, answer, blocker, handoff, review_request, decision. Every message is kept in `.pi/swarm/teams/<team>/messages.jsonl`.
- **Shared decisions.** `team_decide` appends to `decisions.md` (and notifies who it affects); `team_decisions` reads it; `team_directory` shows the org chart and who is doing what.
- Mailbox reads are atomic (rename-then-read): no message is lost when one arrives while another is read.

## Monitoring, stuck workers and tmux

A worker that is silent for a while is ambiguous: waiting on a slow model, running a long tool, or hung. Every worker is now watched from its event stream:

| What you see | Meaning |
|---|---|
| `● w ⇄ 312s  tool:bash 45s · idle 4s` | running; currently in the `bash` tool for 45 s; last event 4 s ago |
| `⚠` + `quiet` | no events for `idleWarnSec` (slow phases — tool, waiting for model, retry, compaction — get ×`slowPhaseFactor` slack) |
| `✖` + `stalled` | no events for `idleKillSec`: the worker is stopped and reported as **failed** (`stalled: …`), so team mode retries it with the reason injected |

For RPC (team) workers a quiet worker is also asked `get_state`: the log then says whether the *process answered* (just slow / blocked in a tool) or did **not** answer (hung). Honest limit: this detects and recovers from stalls, it cannot prevent them. A quiet-for-minutes build that prints nothing needs a larger `idleKillSec` (or `slowPhaseFactor`).

Commands: `/swarm monitor` (health table), `/swarm open [label]` (state, what it is doing, log tail, how to follow it), `/swarm say <label> <text>` (talk to a running RPC worker; one-shot workers cannot be steered), `/swarm kill <label>`, `/swarm tmux [on|off|kill]`. When a worker is stopped as stalled the **lead agent is told** (a `swarm-alert` message) so it can re-plan; "quiet" only warns you.

Every worker writes a live log to `.pi/swarm/workers/<run>/<label>.log` (newest 20 runs kept): `tail -F` it from any terminal.

**tmux = one real pi per agent (v0.5).** With tmux on, every worker (delegate, team, workflow) runs as a *real interactive pi* in its own tmux window of a detached session — `tmux attach -t swarm-<project>`. You see exactly what that agent is doing (reasoning, tool calls, diffs) and can type to it; the lead still gets its result, cost, steering and watchdog over a small file channel (`<run>/<label>.ctl/`). A `monitor` window shows the status table. When an agent finishes, its window drops into a shell in its working directory (its worktree for team tasks). `"tmux": {"enabled": true, "layout": "tiled"}` puts all agents as titled panes in ONE window so you can watch the whole team at once (best up to ~6 agents). If tmux is missing or a window cannot be opened, workers silently fall back to headless mode (log-follower window).

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

Out of the box: the lead defines its own roles with `swarm_agent` (the five built-ins are examples), and sane defaults apply (concurrency 4,
worktrees on, retries 2). Nothing else to configure.

The block below is **customization only** — copy it when you want your own agent definitions or
non-default behaviour; `.pi/agents` roles are per project; `swarm.json` may also set `"reviewer"`, which must name a project role:
```bash
mkdir -p .pi/agents && cp examples/agents/*.md .pi/agents/   # example roles as PROJECT roles (or let the lead build its own with swarm_agent)
cp examples/swarm.json ~/.pi/agent/swarm.json     # global config; or <repo>/.pi/swarm.json (trusted projects only)
```
Diagnose your environment any time with `/swarm doctor` (inside pi) or `node scripts/diagnose-prompt.mjs` (headless, no token).
`swarm.json` (all keys optional): `maxConcurrency` (cap 16), `budgetUsd`, `worktrees`, `gates` (shell commands that must pass), `maxAttempts`, `reviewer` (project role that reviews each task's diff), `customRolesOnly` (default true), `models.{lead,worker,cheap}`, `workerTools`, `preHooks`, `postHooks`, `monitor.{idleWarnSec,idleKillSec,slowPhaseFactor,maxWorkerSec,probe,nudge,tickMs}`, `tmux` (`true` or `{enabled, session, layout: "windows"|"tiled"}`). Agent files take `name`, `description` (both required), `tools`, `model`, `tier: lead|worker|cheap` — see [docs/CUSTOM-AGENTS.md](docs/CUSTOM-AGENTS.md).

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
Typecheck clean; 152 tests pass (unit, real git, end-to-end vs a scripted fake pi, prompt-visibility, doctor); loads in real pi in all three roles (verified headless in CI with and without billion-context); real-model shakedown passed on nvidia provider. Dev-only `npm audit` notes come from vitest's transitive deps; production dependencies have none.

See `AGENTS.md` (for agents/contributors), `docs/CUSTOM-AGENTS.md` (defining roles), `docs/ARCHITECTURE.md`, `docs/ROADMAP.md`, and `docs/FIX-DELEGATION.md` (why the model used to prefer billion-context's acp_delegate, and what changed).
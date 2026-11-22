# Roadmap

## Verification status (be honest about this)
- Typecheck clean; 58 tests pass (unit, real-git worktree/merge/conflict flows, and end-to-end runs against a scripted fake `pi` that speaks pi's documented JSON and RPC protocols).
- Loads in real pi (v1.6.0) in all three roles (parent, teammate child, plain child) and `/swarm` is exposed in real `pi --mode rpc`.
- **NOT verified: a run against a real model/provider** (no credentials were available). The fake pi mirrors the documented event shapes, but real traffic may differ. First action for any real adoption: run `examples/` flows on a cheap model and fix whatever diverges (most likely in `readMessage`/`RpcWorker`).

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

## Next (ordered by value)
1. **Real-model shakedown** (see above) + CI that runs `npm run check`.
2. **Interactive dashboard** — a TUI overlay (`ctx.ui.custom`) with per-worker transcript tail, steer/abort keys, and task board. Today: widget + `/swarm` commands.
3. **Split-pane/tmux view** of teammates (Claude Code offers this); needs session-persisted workers (`--session-dir`) so panes can tail them.
4. **Conflict-resolution agent** — on merge conflict, spawn a resolver in a scratch worktree instead of just aborting.
5. **Transcript persistence** — workers currently run `--no-session`; persist per-task sessions for post-mortems and `fork`-style retries.
6. **Dynamic task creation by teammates** (`team_task_add`) with lead approval.
7. **Cross-process attach** — a second pi session attaching to a running team (task store/mailbox already support multi-process locking; jobs/steering do not).
8. **Per-agent cost breakdown** and per-team budgets (ledger is global today).
9. **Hooks** (pre-task/post-task commands beyond `gates`), MCP-aware worker tool allowlists.
10. **Windows** support (gates use the shell; worktree paths untested).
11. **Publish**: repository URL, `pi-package` listing, semver policy, pin minimum pi version after real-model tests.

## Deliberately not built
- Arbitrary-code workflow scripts (like `.dwf.ts`): workflows are declarative JSON so a model-written plan cannot execute code. Revisit only with sandboxing.
- Auto-merge: merging stays a human decision.

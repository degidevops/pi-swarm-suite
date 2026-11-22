# AGENTS.md — pi-swarm-suite

A single pi extension that provides three orchestration modes behind one runtime, so nothing conflicts:
`swarm_delegate` (subagents), `swarm_team` (lead + teammates, shared task list, mailbox), `swarm_workflow` (fan-out/reduce with journaled resume). Plus `/swarm` command, one live widget, one skill.

## Commands
- `npm install` — install deps (peer: `@earendil-works/pi-coding-agent`, `typebox`)
- `npm run typecheck` — `tsc --noEmit` (must be clean)
- `npm test` — vitest (unit, real-git, and end-to-end tests against `test/fixtures/fake-pi.mjs`)
- `npm run check` — both
- Try it: `pi -e ./src/index.ts` (needs a configured model), or `pi install ./` for a local install

## Architecture (read docs/ARCHITECTURE.md first)
- `src/runtime.ts` — ONE `Runtime`: launches every worker (concurrency, budget, ledger, abort, widget). All modes go through `Runtime.run()`. Never spawn processes anywhere else. Also handles cross-process steer polling (`ensureSteerPolling`), per-agent costs (`agentCosts`), attach state (`listAttachableTeams`, `getTeamRunning`, `getTeamWorkers`, `getTeamJobs`).
- `src/core/` — building blocks: `child.ts` (arg/env/binary for children), `worker.ts` (one-shot JSON worker + `Collector`), `rpc.ts` (steerable RPC worker), `tasks.ts`, `mailbox.ts`, `journal.ts`, `git.ts`, `gates.ts`, `scope.ts`, `review.ts`, `eventlog.ts`, `config.ts`, `agents.ts`, `ledger.ts`, `pool.ts`, `util.ts`, `attach.ts`, `transcript.ts`.
- `src/child-tools.ts` — teammate-side tools (`team_message`, `team_inbox`, `team_tasks`, `team_task_request`); `src/ui.ts` — tool renderers; `src/ui-dashboard.ts` — `DashboardComponent` for `/swarm board`.
- `src/modes/` — `delegate.ts`, `team.ts`, `workflow.ts`; each exports a tool factory taking `getRt(cwd)`.
- `src/index.ts` — registers tools + `/swarm`. At `PI_SWARM_DEPTH >= 1` it registers ONLY the teammate tools (when `PI_SWARM_TEAM_DIR`/`PI_SWARM_MATE` are set), never orchestration tools.

## Invariants — do not break
1. Tool names are `swarm_*` and the command is `swarm`. Do not register generic names like `workflow` or `Agent` (that caused collisions with other packages).
2. Exactly one skill (`skills/orchestration`). Do not add a second skill with an overlapping name.
3. Agents never merge into the user's branch. Merging is only `/swarm merge <team>` (human-triggered, requires clean tree, aborts on conflict).
4. Project-level config (`.pi/swarm.json`) and project agents (`.pi/agents`) load ONLY when `ctx.isProjectTrusted()`. `gates` are shell commands: treat config as code.
5. All names that become file paths go through `assertSafeName` (no traversal).
6. Child processes run with `shell: false` (gates are the only `shell: true`, from trusted config).
7. State lives under `<cwd>/.pi/swarm/` and is excluded via `.git/info/exclude`; never write elsewhere in the repo.
8. No `any` leaking from untrusted JSON: parse defensively (`readMessage`, `parseConfig`).
9. Headless workers must never block on UI: `RpcWorker` auto-cancels extension dialogs. Keep that.
10. Anything that steers/aborts a worker goes through `Runtime` (`steer`, `abortAll`, `stopJob`), never directly to a process.
11. Child tool names in `CHILD_TOOL_NAMES` (runtime.ts) must match `child-tools.ts`, or `--tools` allowlists will hide them.

## Conventions
- TypeScript, ESM, `.ts` import suffixes, strict mode. Tabs/spaces: follow existing files (2 spaces).
- Errors in tool `execute`: `throw new Error(clear message)` for invalid input; return text for run outcomes.
- Add a vitest test for every new pure function. Git behaviour is tested against real temp repos.
- Keep tool descriptions and `promptGuidelines` short; they cost tokens on every request.

## Testing notes
- `PI_SWARM_PI_BIN=test/fixtures/fake-pi.mjs` swaps in the scripted pi. Directives (`FAIL:`, `COST:`, `SLEEP:`, `WRITE:`, `WRITE_BAD:`, `MSG:`, `DIALOG:`) are documented at the top of that file. Extend the fake when you add protocol features, and keep it faithful to pi's documented JSON/RPC events.

## Verify before finishing a change
`npm run check` passes. If you touched `worker.ts`, `runtime.ts`, `attach.ts` or the tools, also smoke-load in real pi (see docs/ARCHITECTURE.md "Smoke test") and say what you could not test.

## Not done yet
See docs/ROADMAP.md. Remaining items: Windows support (#10, untested), publish (#11, semver policy, pin minimum pi version). Real-model shakedown (#1) is complete — verified against `nvidia/nemotron-3.5-super-vl-120b-a12b`.
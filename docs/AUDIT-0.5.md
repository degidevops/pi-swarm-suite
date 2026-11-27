# Audit notes (v0.4.0 → v0.5.0)

Scope: read `runtime.ts`, `core/{child,rpc,tmux,worklog,mailbox}.ts`, `child-tools.ts`, `modes/team.ts` (start→task execution), plus the 152 existing tests. Not audited in depth: `workflow.ts`, `git.ts` merge paths, `attach.ts`, `ui-dashboard.ts`.

## Findings

| # | Severity | Finding | Status |
|---|----------|---------|--------|
| 1 | High (product) | tmux windows were `tail -F` log viewers. They showed status lines, not the agent; you could not see reasoning/tool output or type to it. | Fixed: every agent is a real interactive pi in its own window (`TmuxWorker`). |
| 2 | High | `Mailbox.drain` read the file then deleted it: a message appended between those two steps was lost silently. | Fixed: rename-then-read (atomic); regression test with 200+50 messages. |
| 3 | High (product) | Communication was lead-relayed polling (600 ms, only while a task ran) plus a pull tool. Peers could not ask-and-wait, no org structure, no escalation path, no record of decisions. | Fixed: org chart, `team_ask`, push delivery inside the worker, kinds/replyTo, `team_decide`, `@manager/@owner` routing. |
| 4 | Medium | Messages from teammates to the lead were never surfaced; the lead had to remember to call `inbox`. | Fixed: team watcher raises a `message` alert; blockers/questions wake the lead. |
| 5 | Medium | A teammate only exists while a task runs. Messages to an idle teammate wait for the next task. | Mitigated (`team_ask` returns immediately with a clear instruction; mail is kept). NOT fixed: persistent teammates across tasks are a larger redesign (see Open items). |
| 6 | Low | Team message log lived only in each inbox (`.read.jsonl`); no team-wide conversation record. | Fixed: `messages.jsonl`. |
| 8 | High (my own miss in 0.5.0) | The org chart + working agreements were meant to be in every teammate's prompt, but that edit silently did not apply (no test covered it): only tools and the README claimed it. | Fixed in 0.6.0 with an assertion-guarded patch and `modes.test.ts`. |
| 7 | Info | Worker env (API keys) must reach a tmux window without going through `ps`/the tmux server env. | Handled: 0600 `env.sh`, sourced and deleted by the window wrapper; removed again on `ready`. |

## Open items (recommended next)
1. ~~Persistent teammates~~ — DONE in 0.6.0 (resident pi per teammate for the duration of a run; see README "Resident teammates"). Still open: carrying a teammate's session across separate `run` calls.
2. Lead-side `swarm_team` action `chat` to show `messages.jsonl` (the file exists; no viewer yet).
3. Windows support for tmux mode (tmux is POSIX-only; the headless fallback still works).
4. Re-verify the child-tool permission gates: a TUI worker shows extension dialogs to a human; with nobody watching they block until the watchdog's idle kill. Consider `--no-extensions` for tmux workers except this one.

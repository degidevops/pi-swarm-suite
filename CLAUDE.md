# CLAUDE.md — pi-swarm-suite

@AGENTS.md

Claude Code specifics (everything else is in AGENTS.md — read it first):

- Run `npm run check` (typecheck + vitest) before declaring work done. `test/tmux-real.test.ts` needs `tmux` and `node_modules/.bin/pi`; it skips itself otherwise. Install tmux (`apt-get install tmux`) to run it.
- Do not spawn processes outside `Runtime.run()`; do not edit files under `.pi/swarm/` (runtime state).
- When you change the tmux control channel (`tmux-control.ts`, `tmux-child.ts`, `tmux-worker.ts`) or the team tools (`child-tools.ts`), update `fake-pi.mjs` if the protocol changed and re-run the real tmux test, not just the unit tests.
- Keep `README.md`, `docs/ARCHITECTURE.md`, `skills/orchestration/SKILL.md` and the `<swarm_orchestration>` prompt section consistent when tool behaviour changes (`test/prompt.test.ts` guards the prompt).
- Maintainer language: Indonesian in conversation; code, comments and docs in English.

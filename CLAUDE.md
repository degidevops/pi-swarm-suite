# CLAUDE.md

@AGENTS.md

## Claude Code notes
- This repo is a pi extension, not a Claude Code plugin. Do not confuse Claude Code's `Agent`/agent-teams tools with the `swarm_*` tools implemented here; this project *imitates* those concepts for pi.
- Prefer small, verified edits: run `npm run check` after each module change.
- When building features in parallel with subagents, give each subagent one file/module (`src/core/*`, `src/modes/*`) and never overlap files. Review with a separate read-only subagent before merging.
- Pi API reference for this work lives in the installed package: `node_modules/@earendil-works/pi-coding-agent/docs/extensions.md`, `docs/sdk.md`, and `examples/extensions/subagent/`. Read them instead of guessing signatures.
- `swarm_agent` is this extension's role-builder tool (writes `.pi/agents/*.md`); it is unrelated to Claude Code's `Agent` tool or `.claude/agents`. Roles are per project and built-in agents are examples only (`customRolesOnly`, default true): see AGENTS.md "Roles" and `docs/CUSTOM-AGENTS.md`.
- When you touch role behaviour (`src/core/agents.ts`, `Runtime.resolveAgent`, `src/modes/agent.ts`, `src/core/prompt.ts`), update together: `docs/CUSTOM-AGENTS.md`, `skills/orchestration/SKILL.md`, the README "Example roles" section and AGENTS.md invariant 13, then run `npm run check`.
- Do not "fix" a failing test by switching `customRolesOnly` off globally; set it to `false` only in a test that deliberately exercises legacy built-in behaviour.

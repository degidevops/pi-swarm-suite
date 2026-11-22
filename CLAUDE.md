# CLAUDE.md

@AGENTS.md

## Claude Code notes
- This repo is a pi extension, not a Claude Code plugin. Do not confuse Claude Code's `Agent`/agent-teams tools with the `swarm_*` tools implemented here; this project *imitates* those concepts for pi.
- Prefer small, verified edits: run `npm run check` after each module change.
- When building features in parallel with subagents, give each subagent one file/module (`src/core/*`, `src/modes/*`) and never overlap files. Review with a separate read-only subagent before merging.
- Pi API reference for this work lives in the installed package: `node_modules/@earendil-works/pi-coding-agent/docs/extensions.md`, `docs/sdk.md`, and `examples/extensions/subagent/`. Read them instead of guessing signatures.

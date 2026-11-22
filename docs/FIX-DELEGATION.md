# Fix report: why the model chose `acp_delegate` over the swarm tools

**Symptom.** With pi-swarm-suite and billion-context both installed, delegation requests were
served by billion-context's `acp_delegate` instead of `swarm_delegate` / `swarm_team` /
`swarm_workflow`. It looked like a model-behavior problem; it was not. It was a
model-visibility and cold-start gap in pi-swarm-suite, plus one install blocker.

## Root causes (verified against real pi 1.6.0, headless prompt capture)

### 1. billion-context out-teaches the model in the system prompt
Captured head-to-head (`pi --mode json --no-session -e ./src/index.ts`, billion-context
installed), the system prompt contained:

| | billion-context (`acp_delegate`) | pi-swarm-suite v0.2.0 |
|---|---|---|
| Dedicated prompt section | `<acp_delegate>` — 2,029 chars of usage rules | none |
| Rules bullets | 7 actionable rules incl. role routing | 4 generic rules |
| Tool snippet | a concrete call example: `acp_delegate({ agent: "reviewer", task: "…" })` | `swarm_delegate: run independent tasks in parallel…` (and it repeated the tool name — pi already prefixes it) |

Tool descriptions and rule bullets alone cannot win against a competitor that injects a
dedicated section. The model was being *taught* to use `acp_delegate` every single turn,
and only *listed* the swarm tools.

### 2. Cold-start failure: no built-in roles
`acp_delegate` ships five zero-config roles (reviewer/researcher/worker/planner/oracle).
pi-swarm-suite required agent `.md` files that a fresh install does not have, so
`swarm_delegate` with `agent: "reviewer"` — the exact pattern the acp example teaches —
threw `Unknown agent "reviewer". Available agents: (none found).` After one such error a
model rationally abandons the tool. The suite was strictly less usable on a fresh install
than its competitor.

### 3. Install blocker on most machines
`@rollup/rollup-android-arm64` (an Android/ARM64 binary) was a direct production
dependency: `npm install` / `npm ci` failed outright on linux/x64 and macOS
(`npm error notsup Valid cpu: arm64, Actual cpu: x64`).

## Fixes (v0.3.0)

1. **`<swarm_orchestration>` system-prompt section** (new `src/core/prompt.ts`), injected
   in `before_agent_start`: mode routing table, built-in agents, a concrete example call,
   and the core rules. When a foreign delegation tool is detected in the active tool list
   (`acp_delegate`, `*_delegate`, `subagent*`, …) the section gains an explicit,
   fact-based preference paragraph: prefer `swarm_*` for delegation; other tools only on
   explicit user request. The section is removed again if the swarm tools are deselected.
2. **Five built-in agents** (`src/core/agents.ts`): `reviewer`, `researcher`, `planner`,
   `oracle` (read-only + bash, cheap tier) and `worker` (read/edit/write/bash). Zero-setup
   delegation; user and project agent files override built-ins by name. The reviewer ends
   with `VERDICT: PASS|FAIL`, matching what the review gate parses.
3. **Example-style `promptSnippet`s** for all three tools (single line, no duplicated tool
   name), and descriptions that mention the built-in roles.
4. **`/swarm doctor`** (new `src/core/doctor.ts`): reports active tools, detected
   competing delegate tools with per-package opt-out advice (e.g. billion-context's
   `"delegate": false` in `~/.pi/agent/acp.json`), agents by source, config, git and
   budget. Optional — coexistence works without disabling anything.
5. **Removed the android-arm64 dependency**; `npm ci` is green again.
6. **Better `resolveAgent` errors** that suggest the built-ins.

## Verification

- 109 tests pass (24 new: built-ins, section builder, competitor detection, snippet shape,
  doctor, before_agent_start wiring, cold-start delegation e2e with the fake pi).
- Real-pi headless (`scripts/diagnose-prompt.mjs`, no API token): with billion-context
  installed, the prompt now carries `<swarm_orchestration>` (with the preference
  paragraph) *before* `<acp_delegate>`, and all three swarm tools are listed with example
  snippets. Same result via the `pi install ./` path (`--ext none`). The script is
  hermetic: it provisions a throwaway pi config dir (via `PI_CODING_AGENT_DIR`) with a
  mock provider — pi needs *a* credentialed model to start, but the system prompt is
  emitted before any LLM call, so no real key and no pre-existing `~/.pi` state are
  needed. Verified green on a fresh GitHub Actions runner (job `pi-headless`).
- Real-model tool-choice battle: `scripts/realtest-toolchoice.mjs` (needs an API key;
  runs in CI job `pi-realtest`, skips gracefully without one). The competitor is
  installed into an isolated config dir too, so the runner's real config is untouched.

## Does real testing need an API token?

Only the last mile. Everything that was actually broken — prompt structure, registration,
role resolution, delegation mechanics, coexistence — is verifiable headlessly without any
token, and that is what CI now does on every push. A token is needed only to confirm that
a specific model, on a specific prompt, picks `swarm_delegate` over `acp_delegate`; for
that, set repo secret `PI_TEST_API_KEY` plus vars `PI_TEST_PROVIDER` / `PI_TEST_MODEL`
and the `pi-realtest` job will fight the battle with billion-context installed.

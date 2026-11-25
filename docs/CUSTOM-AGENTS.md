# Custom agents and roles

**The lead agent builds the roles a project needs. The built-in agents are examples only.**

By default (`customRolesOnly: true`) the five built-ins (`reviewer`, `researcher`, `planner`, `oracle`, `worker`)
and global agents in `~/.pi/agent/agents` are **not usable** by `swarm_delegate`, `swarm_team` or `swarm_workflow`.
Before delegating, the lead defines each role it needs, for *this project*. Roles live in the project
(`<project>/.pi/agents/<name>.md`), never globally.

## 1. `swarm_agent`: define a role (all three modes)

```jsonc
swarm_agent({ "action": "define", "name": "db-auditor",
  "description": "Audits SQL migrations",
  "tools": ["read", "grep", "find", "ls"],
  "prompt": "You audit migrations/ for unsafe SQL. Never modify files. Cite file:line. End with VERDICT: PASS|FAIL." })
```

The file is written to the project's `.pi/agents/` and is usable immediately as `agent: "db-auditor"` in
`swarm_delegate` tasks, `swarm_team` teammates and `swarm_workflow` stages. Commit it to share the role.

| action | what it does |
|---|---|
| `define` | create a role (`name`, `description`, `prompt`; optional `tools`, `tier`, `model`). `from: "<agent>"` copies an existing agent or example as a starting point; your fields override it. Refuses to replace an existing role unless `overwrite: true`. Requires a trusted project. |
| `list` | roles defined in this project |
| `examples` | the built-in example roles (prompt, tools, tier) to adapt |
| `remove` | delete a project role |

## 2. Inline role (one-off, `swarm_delegate` only)

```jsonc
swarm_delegate({ "tasks": [
  { "task": "Audit migrations/ for unsafe SQL.", "role": "You are a database-safety auditor. Read-only.",
    "tools": ["read", "grep", "find", "ls"] }
] })
```

`role` is the worker's system prompt; `tools` is its allowlist. Nothing is written to disk.
`swarm_team` and `swarm_workflow` reference agents by name, so define those roles with `swarm_agent`.

## Allowing built-ins again

`.pi/swarm.json` (trusted project) or `~/.pi/agent/swarm.json`:
```json
{ "customRolesOnly": false }
```
Built-ins and global agents then work directly; project roles still override them by name.

## 3. Agent file format (what `swarm_agent` writes; you can also write it by hand)

A Markdown file with YAML frontmatter. The body is the system prompt.

```markdown
---
name: db-auditor
description: Read-only SQL/migration auditor
tools: read, grep, find, ls        # comma list or YAML list
tier: cheap                        # lead | worker | cheap  (picks models.<tier> from swarm.json)
model: openrouter/some-model       # optional, beats tier
---
You are a database-safety auditor. Never modify files. Cite file:line for every finding.
```

| Field | Required | Meaning |
|---|---|---|
| `name` | yes | What you pass as `agent:`. Same name as a built-in = **override**. |
| `description` | yes | Shown in `/swarm agents`. |
| `tools` | no | Tool allowlist passed to the worker (`--tools`). Omitted → `workerTools` from `swarm.json`, else pi's defaults (all tools). |
| `tier` | no | `lead`, `worker` or `cheap`. Omitted → `cheap` if every tool is in `read, grep, find, ls`, otherwise `worker`. |
| `model` | no | `provider/model`. Order: task `model` → agent `model` → `models.<tier>` → `models.worker` → the lead's current model. |
| body | no | The system prompt. |

A file missing `name` or `description` is **silently skipped**. Run `/swarm agents` to confirm it loaded.

### Where files are read from (later wins, by name)

1. Built-ins (shipped in `src/core/agents.ts`)
2. `~/.pi/agent/agents/*.md` (user; ignored for delegation when `customRolesOnly: true`)
3. nearest `.pi/agents/*.md` walking up from the working directory (project; **only in trusted projects**)

Files are **re-read every time an agent name is resolved**, so a file the lead writes mid-session is usable on
the very next call. No `/reload` needed.

### Same name as a built-in

With `customRolesOnly: false`, a file named like a built-in (`researcher.md`) replaces it entirely, including its
system prompt. The team reviewer gate parses a `VERDICT: PASS|FAIL` last line, so any role you configure as
`reviewer` in `swarm.json` must produce it. With `customRolesOnly: true`, `reviewer` in `swarm.json` must be a
project role you defined.

## "Read-only" is only as strict as the tool list

The example `reviewer`, `researcher`, `planner` and `oracle` have `read, bash, grep, find, ls`. They are instructed not to
edit, but **`bash` can write files**. For a hard guarantee, define the role without `bash`.

## Checking what the lead will see

- `/swarm agents` lists every agent with source, tier, tools and file path.
- `/swarm doctor` lists agents by source and flags config problems.

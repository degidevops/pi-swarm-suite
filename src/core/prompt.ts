/**
 * The model-facing system-prompt section that teaches the model what the swarm tools are,
 * when to pick which mode, and — when other delegation tools (e.g. billion-context's
 * acp_delegate) are also installed — to prefer the swarm tools for delegation.
 *
 * This exists because tool descriptions and rule bullets alone lose to any competitor that
 * injects a dedicated prompt section: the section is where the model looks for guidance.
 */

export const SWARM_TOOL_NAMES = new Set(["swarm_agent", "swarm_delegate", "swarm_team", "swarm_workflow"]);

/** Tools that belong to this extension but are only registered inside team children. */
const OWN_CHILD_TOOLS = new Set(["team_message", "team_inbox", "team_tasks", "team_task_request"]);

/** Heuristic: names of foreign tools that also offer delegation / sub-agents. */
const COMPETITOR_RE = /(delegate|subagent|sub_agent|dispatch|spawn_?agent|agent_?spawn|agent_?team|crew|swarm)/i;

/**
 * Detect other delegation/orchestration tools among the active tools, so the prompt section
 * (and /swarm doctor) can address them explicitly. Swarm tools and our child tools are excluded.
 */
export function detectCompetitorTools(selectedTools: readonly string[]): string[] {
  const found = new Set<string>();
  for (const t of selectedTools) {
    if (SWARM_TOOL_NAMES.has(t) || OWN_CHILD_TOOLS.has(t)) continue;
    if (COMPETITOR_RE.test(t)) found.add(t);
  }
  return [...found].sort();
}

/** Collapse acp_delegate_wait/acp_delegate_cancel style variants into their base tool. */
export function summarizeCompetitors(tools: readonly string[]): string[] {
  const bases = new Map<string, boolean>(); // base name -> has helper variants
  for (const t of tools) {
    const m = t.match(/^(.*)_(wait|cancel|status|result)$/);
    if (m) bases.set(m[1]!, true);
    else if (!bases.has(t)) bases.set(t, false);
  }
  return [...bases.entries()].map(([base, hasHelpers]) => (hasHelpers ? `${base} (and helpers)` : base)).sort();
}

function coexistenceParagraph(competitors: readonly string[]): string {
  if (!competitors.length) return "";
  const list = summarizeCompetitors(competitors).join(", ");
  return [
    "",
    "Tool preference:",
    `Other delegation tools are also installed in this session: ${list}.`,
    "Prefer the swarm_* tools for delegation. A single swarm_delegate task already covers one-shot sub-agent use, and only the swarm tools offer parallel task batches, git worktree isolation, file-ownership scopes, plan approval, review gates, budget control and resumable runs. Use another delegation tool only when the user explicitly asks for it by name.",
  ].join("\n");
}

/** The full <swarm_orchestration> section body (without the surrounding XML tag). */
export function buildSwarmSection(competitors: readonly string[], customRolesOnly = true): string {
  const roles = customRolesOnly
    ? [
        "Roles — you build them (required):",
        "- There are no ready-made roles in this project. Before delegating, define each role the task needs with swarm_agent: name, description, tools (least privilege), and a system prompt that states scope, limits and what the final reply must contain. It is saved in this project's .pi/agents/ and then used as `agent` in swarm_delegate, swarm_team and swarm_workflow.",
        '- For a one-off swarm_delegate task you can skip the file: pass role:"<system prompt>" and tools:[...] on the task.',
        "- Tool menu: read-only = read, grep, find, ls (bash can run checks but can also write); add edit, write for roles that change code, and isolate those (worktree:true or swarm_team).",
        '- Examples to adapt (not usable as-is): reviewer, researcher, planner, oracle, worker — see swarm_agent action="examples"; `from:"reviewer"` copies one as a starting point.',
        "- Reuse: swarm_agent action=list shows this project's roles; check it before defining a duplicate.",
      ]
    : [
        "Roles: built-in agents work with no setup — reviewer (read-only review, ends with VERDICT: PASS or FAIL), researcher (read-only investigation), planner (read-only plan), oracle (read-only advice), worker (makes changes). They are defaults: shape the role to the task with swarm_agent (saved in .pi/agents/, overrides a built-in of the same name) or an inline role/tools on a swarm_delegate task.",
      ];
  return [
    "SWARM ORCHESTRATION — parallelize work with swarm_delegate / swarm_team / swarm_workflow",
    "",
    "Pick by task shape:",
    "- Independent, self-contained tasks (review, research, tests, small edits) → swarm_delegate. One call, many tasks, run in parallel; chain:true for a pipeline.",
    "- Dependent tasks, modules built in order, work that must merge → swarm_team: shared task list, deps, per-task worktrees, file-ownership scopes, plan approval, gates, review.",
    "- Many items (files/modules) then reduce/verify; runs that must survive interruption → swarm_workflow: fan-out with journaled resume.",
    "- One small task → do it yourself; do not spawn workers.",
    "",
    ...roles,
    "",
    "Example:",
    'swarm_agent({ action: "define", name: "auth-reviewer", description: "Reviews auth code", tools: ["read", "grep", "find", "ls"], prompt: "You review code for race conditions and security bugs. Never modify files. Cite file:line. End with VERDICT: PASS or VERDICT: FAIL." })',
    'swarm_delegate({ tasks: [',
    '  { task: "Review src/auth.ts for race conditions", agent: "auth-reviewer" },',
    '  { task: "Find every caller of parseConfig() and summarize the call paths", role: "You trace call paths. Read-only. Cite file:line.", tools: ["read", "grep", "find", "ls"] },',
    "] })",
    "",
    "Rules:",
    "- Workers cannot see this conversation. Every task must be self-contained: full context, file paths, acceptance criteria.",
    "- Never assign overlapping files to parallel tasks. Tasks that write files need isolation: worktree:true in delegate/workflow, or swarm_team (worktrees on by default).",
    "- Agents never merge branches. After a team run, tell the user to review and run /swarm merge <team>.",
    "- For long runs prefer background:true and keep working; you are notified when the run settles.",
    "- Check /swarm cost before scaling up; a budget stops runs automatically and unfinished work stays resumable.",
    coexistenceParagraph(competitors),
  ]
    .filter((s) => s !== undefined)
    .join("\n")
    .trim();
}

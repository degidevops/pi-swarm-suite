import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Runtime, type Job } from "./runtime.ts";
import { loadConfig } from "./core/config.ts";
import { discoverAgents } from "./core/agents.ts";
import { DEPTH_ENV, MATE_ENV, TEAM_DIR_ENV } from "./core/child.ts";
import { formatLog, readLog } from "./core/eventlog.ts";
import { registerChildTools } from "./child-tools.ts";
import { delegateTool } from "./modes/delegate.ts";
import { listTeams, mergeTeam, teamLog, teamStatus, teamTool } from "./modes/team.ts";
import { workflowTool } from "./modes/workflow.ts";
import { assertSafeName, formatTokens, formatUsd, truncate } from "./core/util.ts";
import { DashboardComponent } from "./ui-dashboard.ts";
import { buildSwarmSection, detectCompetitorTools, SWARM_TOOL_NAMES } from "./core/prompt.ts";
import { doctorReport } from "./core/doctor.ts";

const WIDGET_KEY = "swarm-suite";
const CHILD_FLAG = Symbol.for("pi-swarm-suite.child-tools");
const SECTION_KEY = "swarm_orchestration";

const HELP = [
  "/swarm status               running workers, jobs, cost",
  "/swarm jobs                 background jobs (team/workflow runs)",
  "/swarm cost | reset-cost    token/cost totals | clear the ledger",
  "/swarm doctor               environment diagnosis (tools, agents, config, conflicts)",
  "/swarm agents               discovered agents (tier, tools)",
  "/swarm teams                teams in this project",
  "/swarm tasks <team>         shared task list incl. plans awaiting approval",
  "/swarm log <team> [n]       event log (starts, failures, steers, merges)",
  "/swarm steer <label> <text> send a live instruction to a running teammate (works cross-process)",
  "/swarm merge <team>         merge completed task branches (human gate)",
  "/swarm board                interactive dashboard TUI (workers, jobs, cost)",
  "/swarm tail <team> [taskId] tail a worker's session output (ROADMAP #3)",
  "/swarm attach [team]        list running teams or show a team's workers/jobs (ROADMAP #7)",
  "/swarm stop [job-id]        abort everything, or one background job",
].join("\n");

function ownPath(): string | undefined {
  try {
    return path.resolve(fileURLToPath(import.meta.url));
  } catch {
    return undefined;
  }
}

async function steerPrompt(rt: Runtime, ctx: ExtensionContext, dash: DashboardComponent): Promise<void> {
  const labels = rt.steerableLabels();
  if (!labels.length) {
    dash.setStatus("No steerable workers running", "warning");
    return;
  }
  const label = await ctx.ui.select("Steer which worker?", labels);
  if (!label) return;
  const text = await ctx.ui.input(`Instruction for ${label}`);
  if (!text) return;
  const ok = rt.steer(label, text);
  dash.setStatus(ok ? `Steered ${label}` : `Worker ${label} not running`, ok ? "info" : "warning");
}

async function abortPrompt(rt: Runtime, ctx: ExtensionContext, dash: DashboardComponent): Promise<void> {
  const jobs = rt.runningJobs();
  if (!jobs.length) {
    dash.setStatus("No background jobs to abort", "warning");
    return;
  }
  const pick = await ctx.ui.select("Abort which job?", jobs.map((j) => `${j.id} (${j.name})`));
  if (!pick) return;
  const id = pick.split(" ")[0];
  const ok = rt.stopJob(id);
  dash.setStatus(ok ? `Stopping job ${id}` : `Job ${id} not running`, ok ? "info" : "warning");
}

export default function swarmSuite(pi: ExtensionAPI): void {
  const depth = Number(process.env[DEPTH_ENV] ?? "0") || 0;

  // Inside a swarm child: no orchestration tools (no recursive swarms), only teammate messaging tools.
  if (depth >= 1) {
    const teamDirEnv = process.env[TEAM_DIR_ENV];
    const mate = process.env[MATE_ENV];
    const g = globalThis as Record<symbol, unknown>;
    if (teamDirEnv && mate && !g[CHILD_FLAG]) {
      g[CHILD_FLAG] = true; // -e and an installed copy may both load this file in the child
      registerChildTools(pi, teamDirEnv, mate);
    }
    return;
  }

  let rt: Runtime | undefined;
  let uiCtx: ExtensionContext | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** Active tools from the last before_agent_start snapshot (empty before the first turn). */
  let activeTools: string[] = [];
  /** Foreign delegation tools detected in the last prompt (for the prompt section and /swarm doctor). */
  let competitorTools: string[] = [];

  const refreshWidget = () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      try {
        const lines = rt?.widgetLines() ?? [];
        uiCtx?.ui.setWidget(WIDGET_KEY, lines.length ? lines : undefined);
      } catch {
        /* context may be invalidated during session replacement */
      }
    }, 150);
  };

  /** Wake the lead when a background job settles, with the result as context. */
  const notifyJob = (job: Job) => {
    const head = `Background ${job.kind} job ${job.id} (${job.name}) ${job.status}.`;
    const body = job.result ? `\n\n${truncate(job.result, 12_000)}` : "";
    try {
      pi.sendMessage({ customType: "swarm-job", content: `${head}${body}`, display: true, details: { id: job.id, status: job.status } }, { triggerTurn: true, deliverAs: "followUp" });
    } catch {
      uiCtx?.ui.notify(head, "info");
    }
  };

  const build = (ctx: ExtensionContext): Runtime => {
    const trusted = ctx.isProjectTrusted();
    const { config, warnings } = loadConfig(ctx.cwd, trusted);
    const runtime = new Runtime(ctx.cwd, config, trusted, depth);
    runtime.agents = discoverAgents(ctx.cwd, trusted);
    runtime.extPath = ownPath();
    if (ctx.model) runtime.sessionModel = `${ctx.model.provider}/${ctx.model.id}`;
    runtime.onChange = refreshWidget;
    runtime.onJobDone = notifyJob;
    if (warnings.length) ctx.ui.notify(`swarm: ${warnings.join("; ")}`, "warning");
    return runtime;
  };

  const getRt = (cwd: string): Runtime => {
    if (!rt || rt.cwd !== cwd) {
      if (!uiCtx) throw new Error("swarm: session not initialised yet");
      rt = build(uiCtx);
    }
    return rt;
  };

  pi.on("session_start", async (_event, ctx) => {
    uiCtx = ctx;
    rt = build(ctx);
  });

  // Teach the model the three modes, the built-in roles and — when other delegation tools
  // (e.g. billion-context's acp_delegate) are active — to prefer the swarm tools. Tool
  // descriptions alone lose against a competitor that injects a dedicated prompt section.
  pi.on("before_agent_start", async (event, ctx) => {
    // Workers should follow the lead's model even after a mid-session model switch.
    if (rt && ctx.model) rt.sessionModel = `${ctx.model.provider}/${ctx.model.id}`;
    const tools = event.systemPromptOptions.selectedTools ?? [];
    activeTools = [...tools];
    competitorTools = detectCompetitorTools(tools);
    if (tools.some((t) => SWARM_TOOL_NAMES.has(t))) {
      event.systemPromptOptions.sections[SECTION_KEY] = buildSwarmSection(competitorTools);
    } else {
      // Safety net: never leave a stale swarm section in the prompt when our tools are disabled.
      delete event.systemPromptOptions.sections[SECTION_KEY];
    }
  });

  pi.on("session_shutdown", async () => {
    rt?.abortAll("session shutdown");
    if (timer) clearTimeout(timer);
    try {
      uiCtx?.ui.setWidget(WIDGET_KEY, undefined);
    } catch {
      /* ignore */
    }
  });

  pi.registerTool(delegateTool(getRt));
  pi.registerTool(teamTool(getRt));
  pi.registerTool(workflowTool(getRt));

  pi.registerCommand("swarm", {
    description: "Swarm suite: status | jobs | cost | doctor | agents | teams | tasks | log | steer | merge | stop",
    getArgumentCompletions: (prefix) => {
      const subs = ["status", "jobs", "cost", "reset-cost", "doctor", "agents", "teams", "tasks", "log", "steer", "merge", "board", "tail", "attach", "stop", "help"];
      const hits = subs.filter((s) => s.startsWith(prefix.trim()));
      return hits.length ? hits.map((s) => ({ value: s, label: s })) : null;
    },
    handler: async (args, ctx) => {
      uiCtx = ctx;
      const [sub = "help", ...rest] = args.trim().split(/\s+/);
      const runtime = getRt(ctx.cwd);
      const say = (m: string, level: "info" | "warning" | "error" = "info") => ctx.ui.notify(m, level);
      try {
        switch (sub) {
          case "status": {
            const lines = runtime.widgetLines();
            say(lines.length ? lines.join("\n") : "swarm: idle");
            break;
          }
          case "jobs": {
            const jobs = [...runtime.jobs.values()];
            say(
              jobs.length
                ? jobs.map((j) => `${j.id} [${j.status}] ${j.name} ${Math.round(((j.endedAt ?? Date.now()) - j.startedAt) / 1000)}s`).join("\n")
                : "No background jobs.",
            );
            break;
          }
          case "cost": {
            const u = runtime.ledger.snapshot();
            const b = runtime.ledger.budgetUsd !== undefined ? ` of ${formatUsd(runtime.ledger.budgetUsd)}` : " (no budget set)";
            const byAgent = runtime.agentCosts();
            const agentTxt = Object.keys(byAgent).length ? ` · by agent: ${Object.entries(byAgent).map(([a, c]) => `${a}=${formatUsd(c)}`).join("  ")}` : "";
            say(`${formatUsd(u.cost)}${b} · ↑${formatTokens(u.input)} ↓${formatTokens(u.output)} · ${u.turns} turns${agentTxt}`);
            break;
          }
          case "reset-cost":
            runtime.ledger.reset();
            say("swarm: ledger reset");
            break;
          case "doctor":
            say(doctorReport({ runtime, extPath: ownPath(), activeTools, competitorTools }));
            break;
          case "agents": {
            const list = [...runtime.agents.values()].map((a) => `${a.name} (${a.source}${a.tier ? `, ${a.tier}` : ""}) — ${a.description}`);
            say(list.length ? list.join("\n") : "No agents found. Add .md files to ~/.pi/agent/agents or .pi/agents (trusted projects only).");
            break;
          }
          case "teams": {
            const t = listTeams(runtime.cwd);
            say(t.length ? t.join("\n") : "No teams in this project.");
            break;
          }
          case "tasks": {
            if (!rest[0]) throw new Error("usage: /swarm tasks <team>");
            say(teamStatus(runtime.cwd, rest[0]));
            break;
          }
          case "log": {
            if (!rest[0]) throw new Error("usage: /swarm log <team> [n]");
            const n = Number(rest[1]) || 30;
            const out = formatLog(readLog(teamLog(runtime.cwd, rest[0]), n));
            say(out || "(empty log)");
            break;
          }
          case "steer": {
            const [label, ...words] = rest;
            if (!label || !words.length) throw new Error(`usage: /swarm steer <label> <text>. Live: ${runtime.steerableLabels().join(", ") || "(none)"}`);
            const text = words.join(" ");
            if (runtime.steer(label, text)) {
              say(`steered ${label}`, "info");
            } else {
              // Cross-process: label format is teamName/mateName#taskId; try steering via disk.
              const team = label.split("/")[0];
              if (team && runtime.steerCrossProcess(team, label, text)) {
                say(`queued steer for ${label} on team ${team} (will be picked up by the running session)`, "info");
              } else {
                say(`no running steerable worker "${label}"`, "warning");
              }
            }
            break;
          }
          case "board": {
            if (ctx.mode !== "tui") {
              say("swarm board requires interactive TUI mode. Run `pi` without --mode json/rpc/print.", "warning");
              break;
            }
            await ctx.ui.custom((_tui, _theme, _keybindings, done) => {
              const dash = new DashboardComponent(runtime);
              const unlisten = _tui.addInputListener((data) => {
                const key = data.toLowerCase();
                if (key === "q") {
                  done(undefined);
                  return { consume: true };
                }
                if (key === "r") {
                  dash.invalidate();
                  return { consume: true };
                }
                if (key === "s") {
                  void steerPrompt(runtime, ctx, dash);
                  return { consume: true };
                }
                if (key === "a") {
                  void abortPrompt(runtime, ctx, dash);
                  return { consume: true };
                }
                return undefined;
              });
              dash.dispose = () => unlisten();
              return dash;
            }, { overlay: true });
            break;
          }
          case "tail": {
            if (!rest[0]) throw new Error("usage: /swarm tail <team> [taskId]");
            const team = rest[0];
            const taskId = rest[1];
            const base = path.join(runtime.cwd, ".pi", "swarm", "teams", assertSafeName(team, "team name"));
            const out: string[] = [];
            if (taskId) {
              const t = path.join(base, "transcripts", `${taskId}.jsonl`);
              if (fs.existsSync(t)) {
                const lines = fs.readFileSync(t, "utf-8").split("\n").filter(Boolean);
                out.push(`... transcript for task ${taskId} ...`);
                out.push(...lines.slice(-30));
              } else {
                out.push(`No transcript for task ${taskId} in team ${team}.`);
              }
            } else {
              // List recent session/worker output under .pi/swarm/teams/<team>/sessions/<taskId>/
              const sessionsDir = path.join(base, "sessions");
              if (fs.existsSync(sessionsDir)) {
                const taskDirs = fs.readdirSync(sessionsDir, { withFileTypes: true }).filter((e) => e.isDirectory());
                for (const td of taskDirs) {
                  out.push(`=== task ${td.name} ===`);
                  const sessDir = path.join(sessionsDir, td.name);
                  const files = fs.readdirSync(sessDir).filter((f) => f.endsWith(".jsonl") || f.endsWith(".log"));
                  for (const f of files.slice(-5)) {
                    const content = fs.readFileSync(path.join(sessDir, f), "utf-8");
                    out.push(`--- ${f} ---`);
                    out.push(...content.split("\n").filter(Boolean).slice(-10));
                  }
                }
                if (taskDirs.length === 0) out.push(`No sessions found for team ${team}.`);
              } else {
                out.push(`No sessions directory yet. Run the team to create worker sessions.`);
              }
            }
            say(out.join("\n"));
            break;
          }
          case "attach": {
            const team = rest[0];
            if (!team) {
              const teams = runtime.listAttachableTeams();
              if (teams.length === 0) {
                say("No running teams to attach to. Start one with /swarm run <team>.", "info");
              } else {
                say("Running teams (attachable from this session):\n" + teams.map((t) => `  ${t}`).join("\n"), "info");
              }
              break;
            }
            const info = runtime.getTeamRunning(team);
            if (!info) {
              say(`Team ${team} is not running (or has already settled). Use /swarm attach without args to list running teams.`, "warning");
              break;
            }
            const workers = runtime.getTeamWorkers(team);
            const jobs = runtime.getTeamJobs(team);
            const out: string[] = [];
            out.push(`Team ${team} — started ${new Date(info.startedAt).toLocaleTimeString()}`);
            out.push(`  mates: ${info.mates.join(", ")}`);
            out.push("");
            if (workers.length) {
              out.push("Workers:");
              for (const w of workers) {
                const icon = w.status === "running" ? "●" : w.status === "ok" ? "✓" : "✗";
                const steerMark = w.steerable ? " ⇄" : "";
                const last = w.last ? ` · ${w.last}` : "";
                out.push(`  ${icon} ${w.label}${steerMark} ${w.status}${last}`);
              }
            } else {
              out.push("Workers: (none)");
            }
            out.push("");
            if (jobs.length) {
              out.push("Jobs:");
              for (const j of jobs) {
                const icon = j.status === "running" ? "●" : j.status === "done" ? "✓" : "✗";
                out.push(`  ${icon} ${j.id} ${j.kind}:${j.name} ${j.status}`);
              }
            } else {
              out.push("Jobs: (none)");
            }
            out.push("");
            out.push(`To steer a worker: /swarm steer ${workers.find((w) => w.status === "running")?.label ?? "<label>"} <instruction>`);
            say(out.join("\n"), "info");
            break;
          }
          case "merge": {
            if (!rest[0]) throw new Error("usage: /swarm merge <team>");
            say(await mergeTeam(runtime, rest[0]));
            break;
          }
          case "stop": {
            if (rest[0]) say(runtime.stopJob(rest[0]) ? `stopping ${rest[0]}` : `no running job ${rest[0]}`);
            else {
              runtime.abortAll("user stop");
              say("swarm: aborted all running workers and jobs", "warning");
            }
            break;
          }
          default:
            say(HELP);
        }
      } catch (e) {
        say(`swarm: ${e instanceof Error ? e.message : String(e)}`, "error");
      }
    },
  });
}

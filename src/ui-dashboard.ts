import { type Component, type TUI } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Runtime } from "./runtime.ts";
import { formatUsd, formatTokens, truncate } from "./core/util.ts";

/**
 * Interactive swarm dashboard (ROADMAP #2).
 *
 * Renders a live board of running workers, background jobs, and cost breakdown.
 * Keyboard: q=quit, s=steer, a=abort, r=refresh.
 *
 * Displayed inside `ctx.ui.custom()` so it has keyboard focus and can be
 * dismissed with `done()`.
 */
export class DashboardComponent implements Component {
  private rt: Runtime;
  private lines: string[] = [];
  focused = false;
  private statusMsg: string | undefined;
  private statusType: "info" | "warning" | "error" = "info";
  /** Optional cleanup callback invoked when the custom UI is dismissed. */
  dispose?: () => void;

  constructor(rt: Runtime) {
    this.rt = rt;
    this.renderLines();
  }

  invalidate(): void {
    this.renderLines();
  }

  private renderLines(): void {
    const l: string[] = [];
    const icon = { running: "●", ok: "✓", failed: "✗", aborted: "◌" } as const;

    l.push("═══ Swarm Dashboard ═══");
    l.push("");

    // ---- Running workers ----
    const workers = [...this.rt.workers.values()];
    if (workers.length) {
      l.push("Workers:");
      for (const w of workers) {
        const secs = Math.round(((w.endedAt ?? Date.now()) - w.startedAt) / 1000);
        l.push(`  ${icon[w.status]} ${w.label}${w.steerable ? " ⇄" : ""} ${secs}s  ${truncate(w.last, 52)}`);
      }
      l.push("");
    } else {
      l.push("Workers: (none running)");
      l.push("");
    }

    // ---- Background jobs ----
    const jobs = this.rt.runningJobs();
    if (jobs.length) {
      l.push("Background jobs:");
      for (const j of jobs) {
        const secs = Math.round(((j.endedAt ?? Date.now()) - j.startedAt) / 1000);
        l.push(`  ${j.id} [${j.status}] ${j.name} ${secs}s`);
      }
      l.push("");
    } else {
      l.push("Background jobs: (none)");
      l.push("");
    }

    // ---- Cost ----
    const u = this.rt.ledger.snapshot();
    const budget = this.rt.ledger.budgetUsd !== undefined ? ` / ${formatUsd(this.rt.ledger.budgetUsd)}` : "";
    l.push(`Cost: ${formatUsd(u.cost)}${budget}`);
    l.push(`  tokens: ↑${formatTokens(u.input)} ↓${formatTokens(u.output)} · turns: ${u.turns}`);
    const costs = this.rt.agentCosts();
    if (Object.keys(costs).length > 1) {
      l.push(`  by agent: ${Object.entries(costs).map(([a, c]) => `${a}=${formatUsd(c)}`).join("  ")}`);
    }
    l.push("");

    // ---- Status message ----
    if (this.statusMsg) {
      const prefix = { info: "ℹ", warning: "⚠", error: "✗" }[this.statusType];
      l.push(`${prefix} ${this.statusMsg}`);
      l.push("");
    }

    l.push("Keys:  s=steer   a=abort   r=refresh   q=quit");
    this.lines = l;
  }

  /** Called by the custom() factory when the user presses a key. */
  handleInput(data: string): void {
    const key = data.toLowerCase();
    if (key === "q") {
      // Handled by the input listener in the factory; here just mark.
      return;
    }
  }

  render(width: number): readonly string[] {
    return this.lines.map((line) => line.slice(0, width));
  }

  /** Set a transient status message shown on the board. */
  setStatus(msg: string, type: "info" | "warning" | "error" = "info"): void {
    this.statusMsg = msg;
    this.statusType = type;
    this.invalidate();
    // Auto-clear after 4 seconds.
    setTimeout(() => {
      if (this.statusMsg === msg) {
        this.statusMsg = undefined;
        this.invalidate();
      }
    }, 4000).unref?.();
  }
}

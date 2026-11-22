import { type Usage, addUsage, emptyUsage } from "../types.ts";

/** Single source of truth for token/cost accounting across all modes. */
export class Ledger {
  private total: Usage = emptyUsage();
  private perAgent: Map<string, Usage> = new Map();
  constructor(public budgetUsd?: number) {}

  add(delta: Partial<Usage> & { agent?: string }): void {
    this.total = addUsage(this.total, delta);
    if (delta.agent !== undefined) {
      const prev = this.perAgent.get(delta.agent) ?? emptyUsage();
      this.perAgent.set(delta.agent, addUsage(prev, delta));
    }
  }

  snapshot(): Usage {
    return { ...this.total };
  }

  snapshotByAgent(): Record<string, Usage> {
    return Object.fromEntries(
      [...this.perAgent.entries()].map(([agent, usage]) => [agent, { ...usage }]),
    );
  }

  agentCost(agent: string): number {
    return this.perAgent.get(agent)?.cost ?? 0;
  }

  exceeded(): boolean {
    return this.budgetUsd !== undefined && this.total.cost >= this.budgetUsd;
  }

  reset(): void {
    this.total = emptyUsage();
    this.perAgent.clear();
  }
}

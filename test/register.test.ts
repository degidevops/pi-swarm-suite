import { afterEach, describe, expect, it } from "vitest";
import swarmSuite from "../src/index.ts";

function fakePi() {
  const tools: string[] = [];
  const commands: string[] = [];
  const events: string[] = [];
  const pi = {
    registerTool: (t: { name: string }) => tools.push(t.name),
    registerCommand: (n: string) => commands.push(n),
    on: (e: string) => {
      events.push(e);
      return () => undefined;
    },
  };
  return { pi: pi as never, tools, commands, events };
}

afterEach(() => {
  delete process.env.PI_SWARM_DEPTH;
});

describe("extension registration", () => {
  it("registers one tool per mode plus swarm_agent, under unique swarm_* names plus one /swarm command", () => {
    const f = fakePi();
    swarmSuite(f.pi);
    expect(f.tools.sort()).toEqual(["swarm_agent", "swarm_delegate", "swarm_team", "swarm_workflow"]);
    expect(f.commands).toEqual(["swarm"]);
    expect(f.events).toEqual(expect.arrayContaining(["session_start", "session_shutdown"]));
  });

  it("registers nothing inside a swarm child (no recursive swarms)", () => {
    process.env.PI_SWARM_DEPTH = "1";
    const f = fakePi();
    swarmSuite(f.pi);
    expect(f.tools).toEqual([]);
    expect(f.commands).toEqual([]);
  });
});

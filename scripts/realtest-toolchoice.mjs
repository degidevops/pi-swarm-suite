#!/usr/bin/env node
/**
 * Real-model tool-choice test for pi-swarm-suite — THIS ONE NEEDS AN API KEY.
 *
 * Reproduces the exact battlefield where the bug was reported: billion-context (with its
 * acp_delegate) installed alongside pi-swarm-suite. Sends one delegation-inviting prompt,
 * watches which orchestration tool the model actually calls, and reports:
 *
 *   PASS  model called a swarm_* tool
 *   FAIL  model called acp_delegate (or another foreign delegate) instead
 *   FAIL  model did not delegate at all
 *
 * Required environment:
 *   PI_TEST_API_KEY    API key for the provider
 *   PI_TEST_PROVIDER   provider id accepted by `pi --provider` (e.g. openrouter)
 *   PI_TEST_MODEL      model string accepted by `pi --model`   (e.g. openrouter/auto)
 * Optional:
 *   PI_TEST_NO_COMPETITOR=1   skip installing billion-context (tests swarm alone)
 *   PI_TEST_TIMEOUT_SECS      default 420
 *   PI_TEST_PROMPT            override the prompt
 *
 * Usage: node scripts/realtest-toolchoice.mjs
 */
import { spawn, execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as path from "node:path";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const API_KEY = process.env.PI_TEST_API_KEY;
const PROVIDER = process.env.PI_TEST_PROVIDER;
const MODEL = process.env.PI_TEST_MODEL;
const NO_COMPETITOR = process.env.PI_TEST_NO_COMPETITOR === "1";
const TIMEOUT = Number(process.env.PI_TEST_TIMEOUT_SECS ?? "420");
const PROMPT =
  process.env.PI_TEST_PROMPT ??
  "Delegate a code review of package.json in this repo to a subagent reviewer (read-only), then report the verdict you got back. Keep the delegated task tiny and cheap.";

if (!API_KEY || !PROVIDER || !MODEL) {
  const missing = ["PI_TEST_API_KEY", "PI_TEST_PROVIDER", "PI_TEST_MODEL"].filter((k) => !process.env[k]);
  console.log(`realtest: skipping — set ${missing.join(", ")} to run the real-model tool-choice test.`);
  console.log("           example: PI_TEST_PROVIDER=openrouter PI_TEST_MODEL=openrouter/auto PI_TEST_API_KEY=sk-or-... node scripts/realtest-toolchoice.mjs");
  process.exit(0);
}

const SWARM = new Set(["swarm_delegate", "swarm_team", "swarm_workflow"]);
const FOREIGN_DELEGATE = /(delegate|subagent|dispatch|spawn_?agent|crew)/i;

function sh(cmd) {
  return execSync(cmd, { cwd: repoRoot, stdio: "pipe", encoding: "utf8" }).trim();
}

// Install the competitor so the test reflects the real conflict (unless told otherwise).
if (!NO_COMPETITOR) {
  console.log("realtest: installing billion-context (the competitor)…");
  try {
    sh("pi install npm:billion-context");
    console.log("realtest: billion-context installed");
  } catch (e) {
    console.error(`realtest: could not install billion-context: ${e.message}`);
    process.exit(1);
  }
}

const args = [
  "--mode", "json",
  "--no-session",
  "--offline",
  "--provider", PROVIDER,
  "--model", MODEL,
  "--api-key", API_KEY,
  "-e", path.join(repoRoot, "src", "index.ts"),
  "-p", PROMPT,
];

console.log(`realtest: pi ${PROVIDER}/${MODEL} with prompt: ${PROMPT.slice(0, 90)}…`);
const child = spawn("pi", args, { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] });

const toolCalls = [];
let sawText = "";
let stderr = "";
let buffer = "";
let settled = false;

const timer = setTimeout(() => finish("timeout"), TIMEOUT * 1000);

function finish(reason) {
  if (settled) return;
  settled = true;
  clearTimeout(timer);
  try {
    child.kill("SIGKILL");
  } catch {
    /* already gone */
  }
  report(reason);
}

child.stdout.on("data", (d) => {
  buffer += d.toString();
  const lines = buffer.split("\n");
  buffer = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.trim()) continue;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (ev.type === "message_end" && ev.message?.role === "assistant") {
      for (const part of ev.message.content ?? []) {
        if (part.type === "toolCall" && typeof part.name === "string") toolCalls.push(part.name);
        if (part.type === "text" && part.text) sawText = part.text;
      }
    }
    // The delegation result arriving back is a good moment to stop early.
    const first = toolCalls.find((t) => SWARM.has(t) || FOREIGN_DELEGATE.test(t));
    if (first && toolCalls.filter((t) => SWARM.has(t) || FOREIGN_DELEGATE.test(t)).length >= 1) {
      // give the worker a moment to be spawned, then stop — we only care about the choice
      setTimeout(() => finish("choice-made"), 4000);
    }
  }
});
child.stderr.on("data", (d) => {
  stderr += d.toString();
});
child.on("error", (e) => {
  console.error(`realtest: failed to start pi: ${e.message}`);
  process.exit(1);
});
child.on("close", () => finish("pi-exited"));

function report(reason) {
  console.log("");
  console.log("realtest: tool-choice report");
  console.log("==========================");
  console.log(`stop reason : ${reason}`);
  console.log(`tool calls  : ${toolCalls.length ? toolCalls.join(" → ") : "(none)"}`);
  const firstSwarm = toolCalls.find((t) => SWARM.has(t));
  const firstForeign = toolCalls.find((t) => FOREIGN_DELEGATE.test(t) && !SWARM.has(t));

  if (firstSwarm && (!firstForeign || toolCalls.indexOf(firstSwarm) < toolCalls.indexOf(firstForeign))) {
    console.log(`RESULT: PASS — the model delegated with ${firstSwarm}`);
    process.exit(0);
  }
  if (firstForeign) {
    console.log(`RESULT: FAIL — the model preferred ${firstForeign} over the swarm tools.`);
    console.log("         The system prompt should contain a <swarm_orchestration> section telling the model");
    console.log("         to prefer swarm_*; run scripts/diagnose-prompt.mjs to inspect the prompt.");
    process.exit(1);
  }
  console.log("RESULT: FAIL — the model did not use any delegation tool.");
  if (sawText) console.log(`last reply : ${sawText.slice(0, 400)}`);
  if (stderr) console.log(`stderr tail: ${stderr.slice(-400)}`);
  process.exit(1);
}

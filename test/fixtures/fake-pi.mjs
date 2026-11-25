#!/usr/bin/env node
// A scripted stand-in for `pi` used by the e2e tests (via PI_SWARM_PI_BIN). It speaks the same
// JSON-mode and RPC-mode protocols the real pi documents, and obeys directives found in the task text:
//   FAIL:<msg>            end with a provider-style error
//   COST:<usd>            report this cost for the run
//   SLEEP:<ms>            work for a while (steerable in RPC mode)
//   WRITE:<path>=<text>   write a file in cwd
//   WRITE_BAD:<path>=<t>  write on first attempt; delete on a retry (prompt contains "did not pass")
//   CHATTER:<ms>          run a visible tool for a while, emitting tool_execution_* events (active, not silent)
//   MSG:<to>|<text>       drop a mailbox message (what the team_message tool does); to=@self -> own inbox
import fs from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
const flag = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const mode = flag("--mode");
const model = flag("--model");
const tools = flag("--tools");
const sysFile = flag("--append-system-prompt");
const mate = process.env.PI_SWARM_MATE;
const teamDir = process.env.PI_SWARM_TEAM_DIR;

if (process.env.PI_FAKE_LOG) {
  fs.appendFileSync(process.env.PI_FAKE_LOG, JSON.stringify({ mode, model, tools, depth: process.env.PI_SWARM_DEPTH, cwd: process.cwd(), mate, ext: flag("-e"), sys: sysFile ? fs.readFileSync(sysFile, "utf-8").slice(0, 40) : undefined }) + "\n");
}

const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const assistant = (text, cost, error) => ({
  type: "message_end",
  message: { role: "assistant", content: [{ type: "text", text }], usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: cost } }, stopReason: error ? "error" : "stop", errorMessage: error },
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let uiWaiter = null;
async function askDialog() {
  out({ type: "extension_ui_request", id: "dlg-1", method: "confirm", title: "Allow?", message: "rm -rf?" });
  return new Promise((resolve) => { uiWaiter = resolve; setTimeout(() => resolve({ timeout: true }), 3000); });
}

async function act(task, steers, isAborted) {
  let dialog = "";
  if (mode === "rpc" && /^DIALOG:/m.test(task)) { const r = await askDialog(); dialog = r.cancelled ? " DIALOG_CANCELLED" : " DIALOG_UNANSWERED"; }
  let cost = 0.01;
  const m = (re) => [...task.matchAll(re)];
  const retry = task.includes("did not pass");
  const canWrite = !tools || /write|edit|bash/.test(tools); // read-only agents cannot modify files
  for (const [, c] of m(/^COST:([\d.]+)/gm)) cost = Number(c);
  for (const [, p, c] of canWrite ? m(/^WRITE:([^=\n]+)=(.*)$/gm) : []) { fs.mkdirSync(path.dirname(path.resolve(p)), { recursive: true }); fs.writeFileSync(p, c + "\n"); }
  for (const [, p, c] of canWrite ? m(/^WRITE_BAD:([^=\n]+)=(.*)$/gm) : []) { if (retry) fs.rmSync(p, { force: true }); else { fs.mkdirSync(path.dirname(path.resolve(p)), { recursive: true }); fs.writeFileSync(p, c + "\n"); } }
  for (const [, to, text] of m(/^MSG:([^|\n]+)\|(.*)$/gm)) {
    const target = to === "@self" ? mate : to;
    fs.mkdirSync(path.join(teamDir, "inbox"), { recursive: true });
    fs.appendFileSync(path.join(teamDir, "inbox", `${target}.jsonl`), JSON.stringify({ id: "x", from: mate, to: target, text, ts: new Date().toISOString() }) + "\n");
  }
  for (const [, ms] of m(/^CHATTER:(\d+)/gm)) {
    out({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command: "build" } });
    const end = Date.now() + Number(ms);
    while (Date.now() < end && !isAborted()) { out({ type: "tool_execution_update", toolCallId: "t1", toolName: "bash", args: {}, partialResult: { content: [{ type: "text", text: "tick" }] } }); await sleep(50); }
    out({ type: "tool_execution_end", toolCallId: "t1", toolName: "bash", result: { content: [] }, isError: false, durationMs: Number(ms) });
  }
  for (const [, ms] of m(/^SLEEP:(\d+)/gm)) { const end = Date.now() + Number(ms); while (Date.now() < end && !isAborted()) await sleep(40); }
  const fail = task.match(/^FAIL:(.*)$/m);
  if (fail) return { text: "", cost, error: fail[1] };
  let text;
  if (task.includes("independent code reviewer")) text = (task.split("```diff")[1] ?? "").includes("FAILREVIEW") ? "Found a defect.\nVERDICT: FAIL" : "Looks fine.\nVERDICT: PASS";
  else if (task.includes("PLANNING PASS")) text = "PLAN: 1. do the thing";
  else {
    text = `ok [model=${model ?? "-"} tools=${tools ?? "-"} depth=${process.env.PI_SWARM_DEPTH}] ${task.split("\n").find((l) => l.trim())?.slice(0, 60) ?? ""}`;
    if (task.includes("Approved plan (follow it)")) text += " APPROVED_PLAN";
    if (task.includes("Messages for you")) text += " HAD_INBOX";
  }
  for (const s of steers) text += ` STEERED:${s}`;
  return { text: text + dialog, cost };
}

if (mode === "rpc") {
  let buf = "";
  let running = false;
  let aborted = false;
  const steers = [];
  const handle = async (cmd) => {
    if (cmd.type === "prompt") {
      out({ id: cmd.id, type: "response", command: "prompt", success: true, data: { disposition: "started" } });
      running = true;
      const r = await act(cmd.message, steers, () => aborted);
      running = false;
      if (!aborted) { out(assistant(r.text, r.cost, r.error)); out({ type: "agent_end", messages: [], willRetry: false }); }
      out({ type: "agent_settled", aborted });
    } else if (cmd.type === "get_state") {
      out({ id: cmd.id, type: "response", command: "get_state", success: true, data: { isStreaming: running, isCompacting: false, pendingMessageCount: 0 } });
    } else if (cmd.type === "steer") {
      steers.push(cmd.message);
      out({ id: cmd.id, type: "response", command: "steer", success: true, data: { disposition: "queued" } });
    } else if (cmd.type === "extension_ui_response") {
      uiWaiter?.(cmd);
    } else if (cmd.type === "abort") {
      aborted = true;
      out({ id: cmd.id, type: "response", command: "abort", success: true });
    }
  };
  process.stdin.on("data", (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (line.trim()) handle(JSON.parse(line)); }
  });
  process.stdin.on("end", () => { aborted = true; setTimeout(() => process.exit(0), running ? 100 : 0); });
} else {
  const task = argv[argv.length - 1].replace(/^Task: /, "");
  const r = await act(task, [], () => false);
  out(assistant(r.text, r.cost, r.error));
  process.exit(r.error ? 1 : 0);
}

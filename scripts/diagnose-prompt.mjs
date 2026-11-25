#!/usr/bin/env node
/**
 * Headless prompt diagnosis for pi-swarm-suite — no API token needed.
 *
 * Runs `pi --mode json --no-session` with the extension loaded, waits for the system
 * message to be emitted, then kills pi and analyses what the model would actually see:
 *
 *   1. the extension loads without crashing
 *   2. the three swarm tools are listed (with usable, non-double-prefixed snippets)
 *   3. the <swarm_orchestration> system-prompt section is injected
 *   4. other delegation tools present in the same session (e.g. billion-context's
 *      acp_delegate) are detected, and the preference paragraph is active
 *
 * The run is hermetic: pi gets an isolated config dir (PI_CODING_AGENT_DIR) that
 * contains only a mock provider definition, so no real API key and no pre-existing
 * ~/.pi state are required — this is what makes it work on a fresh CI runner.
 * Packages requested via --with (and the repo itself in --ext none mode) are
 * installed into that same isolated dir and thrown away afterwards.
 *
 * Usage:
 *   node scripts/diagnose-prompt.mjs [--ext ./src/index.ts|none] [--with npm:billion-context]
 *                                    [--cwd <dir>] [--timeout 45000] [--keep-config]
 *
 *   --ext none      test the package as installed via `pi install ./` (the script installs it)
 *   --with <pkg>    also install a competitor package into the isolated config dir
 *   --keep-config   use the machine's real pi config dir; the script then installs nothing
 *                   (caller-managed installs; useful for local debugging with real configs)
 *
 * Exit code 0 = all hard checks passed, 1 = something is broken.
 */
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const args = process.argv.slice(2);
const flag = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : def;
};
const ext = flag("--ext", path.join(repoRoot, "src", "index.ts"));
const withPkg = flag("--with", undefined);
const cwd = flag("--cwd", repoRoot);
const timeoutMs = Number(flag("--timeout", "45000"));
const keepConfig = args.includes("--keep-config");

// "--ext none" tests the package as installed via `pi install` (no -e flag).
const extArgs = ext === "none" ? [] : ["-e", ext];
if (ext !== "none" && !fs.existsSync(ext)) {
  console.error(`diagnose: extension not found: ${ext}`);
  process.exit(1);
}

/**
 * Mock chat provider definition. pi refuses to start without a model whose provider
 * has credentials; the system prompt is emitted before any LLM call and we kill pi
 * at that point, so the endpoint is never contacted (port 9 = discard, connection
 * refused instantly even if pi got further than expected).
 */
const MOCK_MODELS = `${JSON.stringify(
  {
    $schema: "https://pi.dev/schemas/models.schema.json",
    providers: {
      mock: {
        baseUrl: "http://127.0.0.1:9/v1",
        api: "openai-completions",
        apiKey: "mock",
        models: [{ id: "mock-model", contextWindow: 128000, maxTokens: 8192 }],
      },
    },
  },
  null,
  2,
)}\n`;

let cfgDir; // isolated pi config dir; removed on success, kept for inspection on failure
const childEnv = { ...process.env, PI_OFFLINE: "1" };

if (!keepConfig) {
  cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-diagnose-"));
  fs.writeFileSync(path.join(cfgDir, "models.json"), MOCK_MODELS);
  childEnv.PI_CODING_AGENT_DIR = cfgDir;

  const piInstall = (what, label) => {
    console.log(`diagnose: pi install ${what} (isolated config dir)…`);
    const r = spawnSync("pi", ["install", what], {
      cwd: repoRoot,
      env: { ...process.env, PI_CODING_AGENT_DIR: cfgDir },
      encoding: "utf8",
      timeout: 300_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    if (r.status !== 0) {
      console.error(`diagnose: ${label} failed:\n${(r.stderr || r.stdout || "(no output)").trim()}`);
      fs.rmSync(cfgDir, { recursive: true, force: true });
      process.exit(1);
    }
  };
  if (ext === "none") piInstall("./", "pi install ./");
  if (withPkg) piInstall(withPkg, `pi install ${withPkg}`);
} else if (ext === "none" || withPkg) {
  console.error("diagnose: --keep-config installs nothing — run `pi install` yourself first.");
}

const child = spawn("pi", ["--mode", "json", "--no-session", "--offline", ...extArgs, "-p", "diagnose"], {
  cwd,
  stdio: ["ignore", "pipe", "pipe"],
  env: childEnv,
});

let sections = null;
let sawTools = "";
let buffer = "";
let stderr = "";
let reported = false;

const timer = setTimeout(() => finish(1, "timed out waiting for the system prompt"), timeoutMs);

function cleanup() {
  if (!cfgDir) return;
  try {
    fs.rmSync(cfgDir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

function report(code, reason) {
  if (reported) return;
  reported = true;
  const lines = [];
  const hard = [];
  const soft = [];
  const say = (s = "") => lines.push(s);

  if (!sections) {
    say(`pi-swarm-suite prompt diagnosis — FAILED (${reason})`);
    say("");
    say("pi stderr (tail):");
    say(stderr.split("\n").slice(-12).join("\n") || "(empty)");
    if (cfgDir) say(`isolated config dir kept for inspection: ${cfgDir}`);
    console.log(lines.join("\n"));
    process.exit(1);
  }

  say("pi-swarm-suite prompt diagnosis — what the model sees");
  say("=====================================================");
  say(`sections: ${Object.keys(sections).join(", ")}`);
  say("");

  // 1. swarm tools listed?
  const toolsBlock = sawTools;
  const swarmTools = ["swarm_agent", "swarm_delegate", "swarm_team", "swarm_workflow"];
  const missingTools = swarmTools.filter((t) => !new RegExp(`^- ${t}:`, "m").test(toolsBlock));
  if (missingTools.length) hard.push(`missing from <tools>: ${missingTools.join(", ")}`);
  else say(`[ok] all three swarm tools listed in <tools> (~${estTokens(toolsBlock)} tokens)`);

  // 2. no double prefix, snippets are examples?
  let prefixBug = false;
  for (const t of swarmTools) {
    if (new RegExp(`^- ${t}: ${t}:`, "m").test(toolsBlock)) {
      hard.push(`${t}: snippet repeats the tool name (double prefix)`);
      prefixBug = true;
    }
    const m = toolsBlock.match(new RegExp(`^- ${t}: (.+)$`, "m"));
    if (m && !/\(/.test(m[1] ?? "")) soft.push(`${t}: snippet is not a call example — ${m[1]}`);
  }
  if (!prefixBug) say("[ok] tool snippets are concrete call examples");

  // 3. swarm_orchestration section?
  const section = sections.swarm_orchestration;
  if (!section) hard.push("<swarm_orchestration> section is NOT injected");
  else {
    say(`[ok] <swarm_orchestration> section injected (~${estTokens(section)} tokens)`);
    if (!section.includes("reviewer")) hard.push("section does not mention the built-in agents");
  }

  // 4. competitors?
  const competitorRe = /(delegate|subagent|dispatch|spawn_?agent|agent_?team|crew)/i;
  const listed = [...toolsBlock.matchAll(/^- ([a-z0-9_]+):/gim)].map((m) => m[1]);
  const competitors = listed.filter((t) => !swarmTools.includes(t) && !/^(read|bash|edit|write)$/.test(t) && competitorRe.test(t));
  say("");
  if (competitors.length) {
    say(`[!] other delegation tools active in this session: ${competitors.join(", ")}`);
    if (section && section.includes("Tool preference")) say("[ok] preference paragraph is active: the prompt tells the model to prefer the swarm tools");
    else hard.push("competitors present but the preference paragraph is missing");
  } else {
    say("[ok] no competing delegation tools in this session");
  }

  say("");
  if (soft.length) {
    say("warnings:");
    for (const s of soft) say(`  - ${s}`);
  }
  if (hard.length) {
    say("FAILED checks:");
    for (const h of hard) say(`  - ${h}`);
    if (cfgDir) say(`isolated config dir kept for inspection: ${cfgDir}`);
    console.log(lines.join("\n"));
    process.exit(1);
  }
  say("all checks passed");
  console.log(lines.join("\n"));
  cleanup();
}

function finish(code, reason) {
  clearTimeout(timer);
  child.kill("SIGKILL");
  report(code, reason);
}

child.stdout.on("data", (d) => {
  if (sections) return;
  buffer += d.toString();
  const lines = buffer.split("\n");
  buffer = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const ev = JSON.parse(line);
      if (ev.type === "message_start" && ev.message?.role === "system") {
        sections = ev.message.sections ?? {};
        sawTools = sections.tools ?? "";
        finish(0);
        return;
      }
    } catch {
      /* non-JSON noise */
    }
  }
});
child.stderr.on("data", (d) => {
  stderr += d.toString();
});
child.on("error", (e) => finish(1, `failed to start pi: ${e.message}`));
child.on("close", () => {
  if (!sections) finish(1, "pi exited before emitting the system prompt");
});

const estTokens = (s) => Math.round(s.length / 4);

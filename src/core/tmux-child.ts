/**
 * Worker side of the tmux control channel. Runs inside a real interactive pi (TUI) started by the lead in
 * a tmux window. It forwards pi events to the lead and executes the lead's commands (steer/abort/quit).
 * The user can also type into the window at any time; those turns are forwarded as ordinary events.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type CtlCommand, JsonlTail, appendJsonl, ctlPaths, touch } from "./tmux-control.ts";

const TEXT_FLUSH_MS = 250;
const RESULT_TEXT_CAP = 2000;

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null;

/** Shrink a tool result before it goes over the channel (the full result stays in the pi session). */
export function slimResult(result: unknown): unknown {
  if (!isObj(result) || !Array.isArray(result.content)) return { content: [] };
  const content = result.content.map((c) => {
    if (isObj(c) && c.type === "text" && typeof c.text === "string") return { type: "text", text: c.text.length > RESULT_TEXT_CAP ? `${c.text.slice(0, RESULT_TEXT_CAP)}…` : c.text };
    return { type: isObj(c) ? c.type : "unknown" };
  });
  return { content };
}

export function installTmuxChild(pi: ExtensionAPI, ctlDir: string): void {
  const p = ctlPaths(ctlDir);
  const commands = new JsonlTail(p.commands);
  let ctx: ExtensionContext | undefined;
  let beat: ReturnType<typeof setInterval> | undefined;
  let poll: ReturnType<typeof setInterval> | undefined;
  let textBuf = "";
  let textTimer: ReturnType<typeof setTimeout> | undefined;

  const emit = (record: Json) => appendJsonl(p.events, record);
  const flushText = () => {
    if (textTimer) clearTimeout(textTimer);
    textTimer = undefined;
    if (!textBuf) return;
    emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: textBuf } });
    textBuf = "";
  };

  const run = (cmd: CtlCommand) => {
    if (cmd.type === "steer") pi.sendUserMessage(cmd.text, { deliverAs: "steer" });
    else if (cmd.type === "abort") ctx?.abort();
    else if (cmd.type === "quit") ctx?.shutdown();
  };

  pi.on("session_start", async (_e, c) => {
    ctx = c;
    touch(p.alive);
    beat = setInterval(() => touch(p.alive), 1000);
    poll = setInterval(() => {
      for (const cmd of commands.read()) if (isObj(cmd) && typeof cmd.type === "string") run(cmd as unknown as CtlCommand);
    }, 250);
    beat.unref?.();
    poll.unref?.();
    emit({ type: "ready" });
  });

  pi.on("session_shutdown", async () => {
    flushText();
    if (beat) clearInterval(beat);
    if (poll) clearInterval(poll);
    emit({ type: "exiting" });
  });

  pi.on("agent_start", async () => emit({ type: "agent_start" }));
  pi.on("turn_start", async () => emit({ type: "turn_start" }));
  pi.on("message_start", async (e) => {
    const m = e.message as unknown;
    if (isObj(m) && m.role === "user") emit({ type: "message_start", message: m });
  });
  pi.on("message_update", async (e) => {
    const a = e.assistantMessageEvent as unknown;
    if (!isObj(a)) return;
    if (a.type === "text_delta" && typeof a.delta === "string") {
      textBuf += a.delta;
      textTimer ??= setTimeout(flushText, TEXT_FLUSH_MS);
    } else if (a.type === "text_end") flushText();
    else if (a.type === "thinking_start" || a.type === "thinking_end" || a.type === "toolcall_start") {
      emit({ type: "message_update", assistantMessageEvent: { type: a.type, toolName: a.toolName } });
    }
  });
  pi.on("message_end", async (e) => {
    flushText();
    emit({ type: "message_end", message: e.message });
  });
  pi.on("tool_execution_start", async (e) => emit({ type: "tool_execution_start", toolCallId: e.toolCallId, toolName: e.toolName, args: e.args }));
  pi.on("tool_execution_end", async (e) =>
    emit({ type: "tool_execution_end", toolCallId: e.toolCallId, toolName: e.toolName, result: slimResult(e.result), isError: e.isError, durationMs: e.durationMs }),
  );
  pi.on("agent_settled", async (e) => {
    flushText();
    emit({ type: "agent_settled", aborted: e.aborted });
  });
}

import { Text } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";

/* Compact tool-call/result rendering. */

const COLLAPSED_LINES = 14;

export function renderCallFor<A>(title: string, summarize: (args: A) => string) {
  return (args: A, theme: Theme) => new Text(`${theme.fg("accent", title)} ${theme.fg("muted", summarize(args))}`, 0, 0);
}

export function renderResultText(result: { content: { type: string; text?: string }[] }, options: { expanded: boolean }, theme: Theme) {
  const raw = result.content.map((c) => (c.type === "text" ? (c.text ?? "") : "")).join("\n");
  const lines = raw.split("\n");
  const shown = options.expanded || lines.length <= COLLAPSED_LINES ? lines : lines.slice(0, COLLAPSED_LINES);
  const styled = shown.map((l) => (l.startsWith("⚠") ? theme.fg("warning", l) : l.startsWith("—") ? theme.fg("dim", l) : l));
  if (shown.length < lines.length) styled.push(theme.fg("dim", `… ${lines.length - shown.length} more line(s) — expand to see all`));
  return new Text(styled.join("\n"), 0, 0);
}

import { createHash } from "node:crypto";

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });
}

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$/;

export function isSafeName(name: string): boolean {
  return SAFE_NAME.test(name);
}

export function assertSafeName(name: string, what = "name"): string {
  if (!isSafeName(name)) {
    throw new Error(`Invalid ${what} "${name}": use letters, digits, "-" or "_" (max 48 chars, must start alphanumeric).`);
  }
  return name;
}

export function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}\n…[truncated ${s.length - max} chars]`;
}

export function tail(s: string, max: number): string {
  return s.length <= max ? s : `…[truncated]\n${s.slice(s.length - max)}`;
}

export function sha1(s: string): string {
  return createHash("sha1").update(s).digest("hex").slice(0, 16);
}

export function formatUsd(n: number): string {
  return `$${n.toFixed(n < 1 ? 4 : 2)}`;
}

export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export function firstLine(s: string, max = 80): string {
  const line = s.split("\n").find((l) => l.trim()) ?? "";
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

/** Replace `{name}` placeholders for known variables only; unknown placeholders are left intact. */
export function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (m, key: string) => (Object.hasOwn(vars, key) ? (vars[key] as string) : m));
}

/** File-ownership scopes: a task may declare glob patterns; edits outside them fail the attempt. */

export function globToRegExp(glob: string): RegExp {
  let g = glob.replace(/^\.\//, "");
  if (g.endsWith("/")) g += "**";
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i] as string;
    if (c === "*") {
      if (g[i + 1] === "*") {
        if (g[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 2;
        } else {
          re += ".*";
          i += 1;
        }
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

export function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "");
}

/** Files that match none of the patterns. Empty patterns = unrestricted. */
export function outsideScope(files: string[], patterns: string[] | undefined): string[] {
  if (!patterns?.length) return [];
  const res = patterns.map(globToRegExp);
  return files.map(normalizePath).filter((f) => !res.some((r) => r.test(f)));
}

export function staticPrefix(glob: string): string {
  const i = glob.search(/[*?]/);
  return normalizePath(i < 0 ? glob : glob.slice(0, i));
}

/** Heuristic overlap test on static prefixes (conservative: may over-report). */
export function scopesOverlap(a: string[] | undefined, b: string[] | undefined): boolean {
  if (!a?.length || !b?.length) return false;
  return a.some((x) => b.some((y) => {
    const px = staticPrefix(x);
    const py = staticPrefix(y);
    return px.startsWith(py) || py.startsWith(px);
  }));
}

import * as fs from "node:fs";
import * as path from "node:path";

/** Append-only JSONL journal. Completed steps are replayed on resume instead of re-spending tokens. */
export class Journal {
  private readonly entries = new Map<string, string>();

  constructor(private readonly file: string) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (fs.existsSync(file)) {
      for (const line of fs.readFileSync(file, "utf-8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const e = JSON.parse(line) as { key: string; value: string };
          if (typeof e.key === "string" && typeof e.value === "string") this.entries.set(e.key, e.value);
        } catch {
          /* ignore a torn final line from a crash */
        }
      }
    }
  }

  get(key: string): string | undefined {
    return this.entries.get(key);
  }

  set(key: string, value: string): void {
    this.entries.set(key, value);
    fs.appendFileSync(this.file, `${JSON.stringify({ key, value })}\n`);
  }

  get size(): number {
    return this.entries.size;
  }
}

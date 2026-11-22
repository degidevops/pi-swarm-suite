import { truncate } from "./util.ts";

export function buildReviewPrompt(i: { team: string; taskId: string; subject: string; description: string; diff: string; notes?: string }): string {
  return [
    `You are an independent code reviewer for team "${i.team}". You did NOT write this change. You are READ-ONLY: do not modify files.`,
    `## Task ${i.taskId}: ${i.subject}\n${i.description}`,
    `## Change under review (git diff)\n\`\`\`diff\n${truncate(i.diff || "(no diff available)", 30_000)}\n\`\`\``,
    i.notes ? `## Notes\n${i.notes}` : "",
    `## Your job\nCheck the change against the task: correctness, missed requirements, concurrency/error-handling bugs, unsafe or risky code, tests. Be concrete (file:line).\nEnd your reply with exactly one line: \`VERDICT: PASS\` or \`VERDICT: FAIL\`. Use FAIL only for real defects that must be fixed; list them above the verdict.`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

export type Verdict = "pass" | "fail" | "unknown";

/** Last explicit VERDICT line wins. */
export function parseVerdict(text: string): Verdict {
  const all = [...text.matchAll(/VERDICT:\s*(PASS|FAIL)/gi)];
  const last = all[all.length - 1]?.[1]?.toUpperCase();
  return last === "PASS" ? "pass" : last === "FAIL" ? "fail" : "unknown";
}

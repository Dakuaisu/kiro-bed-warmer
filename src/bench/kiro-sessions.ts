import { readdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

const KIRO_SESSIONS = join(homedir(), ".kiro", "sessions", "cli");
const SessionMeta = z.object({ cwd: z.string() }).passthrough();

/** Delete kiro-cli session files whose cwd lies under one of `roots`. Never touches other sessions. */
export function removeKiroSessionsUnder(roots: string[]): number {
  let removed = 0;
  let files: string[];
  try {
    files = readdirSync(KIRO_SESSIONS);
  } catch {
    return 0;
  }
  for (const f of files.filter((n) => n.endsWith(".json"))) {
    const path = join(KIRO_SESSIONS, f);
    let cwd: string;
    try {
      cwd = SessionMeta.parse(JSON.parse(readFileSync(path, "utf8"))).cwd;
    } catch {
      continue;
    }
    if (!roots.some((r) => cwd === r || cwd.startsWith(`${r}/`))) continue;
    const id = f.slice(0, -".json".length);
    for (const ext of [".json", ".jsonl", ".lock"])
      rmSync(join(KIRO_SESSIONS, `${id}${ext}`), { force: true });
    removed++;
  }
  return removed;
}

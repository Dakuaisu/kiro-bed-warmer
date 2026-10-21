import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

export { removeKiroSessionsUnder } from "../../src/bench/kiro-sessions.ts";

/** Temp dir under /private/tmp (kiro records realpaths, and /tmp -> /private/tmp on macOS). */
export function tempDir(prefix: string): string {
  return mkdtempSync(join("/private/tmp", `kbw-${prefix}-`));
}

export function removeDirs(dirs: string[]): void {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
}

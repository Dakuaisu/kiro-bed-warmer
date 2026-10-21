import { spawn } from "node:child_process";
import { openSync } from "node:fs";
import { z } from "zod";
import type { Config } from "./config.ts";
import { ensureStateDirs, ensureToken, statePaths } from "./state.ts";

export const Health = z.object({
  status: z.literal("ok"),
  pid: z.number(),
  uptimeMs: z.number(),
  processes: z.number(),
  spares: z.number(),
  sessions: z.number(),
  activeTurns: z.number(),
});
export type Health = z.infer<typeof Health>;

const MAIN = new URL("./cli/main.ts", import.meta.url).pathname;

export async function call(
  cfg: Config,
  token: string,
  method: string,
  path: string,
  body?: unknown,
  timeoutMs = 2000,
) {
  return fetch(`http://127.0.0.1:${cfg.port}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(timeoutMs),
  });
}

export async function health(cfg: Config, token: string, timeoutMs = 1000): Promise<Health | undefined> {
  try {
    const res = await call(cfg, token, "GET", "/health", undefined, timeoutMs);
    if (!res.ok) return undefined;
    const parsed = Health.safeParse(await res.json());
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export type EnsureOptions = { nodeBin?: string; debug?: boolean; waitMs?: number; warmCwd?: string };

/** Start the daemon detached if it is not answering, then wait for /health. */
export async function ensureDaemon(
  cfg: Config,
  opts: EnsureOptions = {},
): Promise<{ token: string; health: Health }> {
  ensureStateDirs(cfg);
  const token = ensureToken(cfg);
  const up = await health(cfg, token, 500);
  if (up) return { token, health: up };
  const args = [MAIN, "start", "--foreground", ...(opts.warmCwd ? ["--warm", opts.warmCwd] : [])];
  const out = openSync(statePaths(cfg).logFile, "a", 0o600);
  const child = spawn(opts.nodeBin ?? "node", args, {
    detached: true,
    stdio: ["ignore", out, out],
    env: {
      ...process.env,
      KBW_STATE_DIR: cfg.stateDir,
      KBW_PORT: String(cfg.port),
      ...(opts.debug ? { KBW_DEBUG: "1" } : {}),
    },
  });
  let exited: number | null | undefined;
  child.once("exit", (code) => {
    exited = code;
  });
  child.unref();
  const deadline = Date.now() + (opts.waitMs ?? 15_000);
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
    const h = await health(cfg, token, 500);
    if (h) return { token, health: h };
    // Exit code 3 = another daemon holds the lock and may still be starting; keep polling for it.
    if (exited !== undefined && exited !== 3) {
      throw new Error(
        `kiro-bed-warmer exited during startup (code ${exited}; port ${cfg.port} in use?); see ${statePaths(cfg).logFile}`,
      );
    }
  }
  throw new Error(`kiro-bed-warmer did not become healthy; see ${statePaths(cfg).logFile}`);
}

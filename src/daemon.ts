import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config.ts";
import { startHttp } from "./http/server.ts";
import { createLogger, errorMessage } from "./log.ts";
import { Pool } from "./pool/pool.ts";
import { Router } from "./router/router.ts";
import {
  acquireLock,
  ensureStateDirs,
  ensureToken,
  releaseLock,
  statePaths,
  writeAgentConfig,
  writePort,
} from "./state.ts";

const SWEEP_MS = 60_000;

/** Run the daemon in this process until idle timeout, SIGTERM/SIGINT or POST /v1/shutdown. */
export async function runDaemon(
  cfg: Config,
  opts: { logToStderr: boolean; warmCwds: string[] },
): Promise<void> {
  ensureStateDirs(cfg);
  const paths = statePaths(cfg);
  const log = createLogger(opts.logToStderr ? undefined : paths.logFile, cfg.debug);
  if (!acquireLock(cfg)) {
    log.warn("daemon.already_running", { stateDir: cfg.stateDir });
    process.exitCode = 3;
    return;
  }
  for (const f of readdirSync(cfg.socketDir)) rmSync(join(cfg.socketDir, f), { force: true });
  const token = ensureToken(cfg);
  writeAgentConfig(cfg);
  const startedAt = Date.now();
  let lastActivity = Date.now();
  const pool = new Pool(cfg, log);
  const router = new Router(cfg, pool, log);
  let stopping = false;
  let sweep: NodeJS.Timeout | undefined;
  let finish: () => void = () => undefined;
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });

  const shutdown = async (reason: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    clearInterval(sweep);
    log.info("daemon.stopping", { reason });
    server.close();
    server.closeAllConnections();
    const exits = await pool.close();
    releaseLock(cfg);
    for (const f of readdirSync(cfg.socketDir)) rmSync(join(cfg.socketDir, f), { force: true });
    log.info("daemon.stopped", { reason, kiroExitMs: exits });
    finish();
  };

  const server = await startHttp({
    cfg,
    log,
    token,
    pool,
    router,
    startedAt,
    onActivity: () => {
      lastActivity = Date.now();
    },
    onShutdown: () => void shutdown("api"),
  }).catch((err: unknown) => {
    releaseLock(cfg);
    throw err;
  });
  writePort(cfg, cfg.port);
  log.info("daemon.listening", {
    pid: process.pid,
    port: cfg.port,
    engine: cfg.engine,
    stallMs: cfg.stallMs,
  });

  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.once("SIGINT", () => void shutdown("SIGINT"));
  sweep = setInterval(() => {
    router.sweep();
    if (router.activeTurns() === 0 && Date.now() - lastActivity > cfg.idleShutdownMs) void shutdown("idle");
  }, SWEEP_MS);
  sweep.unref();

  const t0 = Date.now();
  pool
    .warmUp([cfg.workDir, ...opts.warmCwds])
    .then(() => log.info("daemon.warm", { ms: Date.now() - t0 }))
    .catch((err: unknown) => log.error("daemon.warm_failed", { err: errorMessage(err) }));
  await finished;
}

import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

const intFrom = (fallback: number) => z.coerce.number().int().positive().default(fallback);

const EnvSchema = z.object({
  KBW_STATE_DIR: z.string().min(1).optional(),
  KBW_PORT: intFrom(47900),
  KBW_STALL_SECONDS: intFrom(30),
  KBW_IDLE_SHUTDOWN_MINUTES: intFrom(120),
  KBW_SESSION_IDLE_MINUTES: intFrom(180),
  KBW_TOOL_TIMEOUT_MINUTES: z.coerce.number().positive().default(45),
  KBW_MAX_SESSIONS_PER_PROCESS: intFrom(24),
  KBW_MAX_CREATED_PER_PROCESS: intFrom(150),
  KBW_SPARE_CWDS: intFrom(4),
  KBW_TOOL_BATCH_MS: intFrom(100),
  KBW_TOOLS_READY_SECONDS: z.coerce.number().positive().default(10),
  KBW_ENGINE: z.enum(["v2", "v3"]).default("v2"),
  KBW_KIRO_BIN: z.string().min(1).default("kiro-cli"),
  KBW_ON_SYSTEM_CHANGE: z.enum(["reset", "redeliver"]).default("redeliver"),
  KBW_DEBUG: z
    .enum(["0", "1", "true", "false"])
    .default("0")
    .transform((v) => v === "1" || v === "true"),
});

export type Config = {
  readonly stateDir: string;
  readonly workDir: string;
  readonly socketDir: string;
  readonly port: number;
  readonly stallMs: number;
  readonly idleShutdownMs: number;
  readonly sessionIdleMs: number;
  readonly toolTimeoutMs: number;
  readonly maxSessionsPerProcess: number;
  readonly maxCreatedPerProcess: number;
  readonly spareCwds: number;
  readonly toolBatchMs: number;
  readonly toolsReadyMs: number;
  readonly engine: "v2" | "v3";
  readonly kiroBin: string;
  readonly onSystemChange: "reset" | "redeliver";
  readonly debug: boolean;
};

export function defaultStateDir(): string {
  const xdg = process.env.XDG_STATE_HOME;
  return join(xdg && xdg.length > 0 ? xdg : join(homedir(), ".local", "state"), "kiro-bed-warmer");
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, overrides: Partial<Config> = {}): Config {
  const e = EnvSchema.parse(env);
  const stateDir = overrides.stateDir ?? e.KBW_STATE_DIR ?? defaultStateDir();
  const base: Config = {
    stateDir,
    workDir: join(stateDir, "work"),
    socketDir: join(stateDir, "s"),
    port: e.KBW_PORT,
    stallMs: e.KBW_STALL_SECONDS * 1000,
    idleShutdownMs: e.KBW_IDLE_SHUTDOWN_MINUTES * 60_000,
    sessionIdleMs: e.KBW_SESSION_IDLE_MINUTES * 60_000,
    toolTimeoutMs: e.KBW_TOOL_TIMEOUT_MINUTES * 60_000,
    maxSessionsPerProcess: e.KBW_MAX_SESSIONS_PER_PROCESS,
    maxCreatedPerProcess: e.KBW_MAX_CREATED_PER_PROCESS,
    spareCwds: e.KBW_SPARE_CWDS,
    toolBatchMs: e.KBW_TOOL_BATCH_MS,
    toolsReadyMs: e.KBW_TOOLS_READY_SECONDS * 1000,
    engine: e.KBW_ENGINE,
    kiroBin: e.KBW_KIRO_BIN,
    onSystemChange: e.KBW_ON_SYSTEM_CHANGE,
    debug: e.KBW_DEBUG,
  };
  return { ...base, ...overrides, workDir: join(stateDir, "work"), socketDir: join(stateDir, "s") };
}

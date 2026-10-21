import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { Config } from "./config.ts";

export const AGENT_NAME = "kiro-warm";
export const BRIDGE_SERVER_NAME = "oc";

/** Prompt of the kiro agent; opencode's real system prompt arrives as <system_instructions>. */
const AGENT_PROMPT =
  "You are a coding assistant that operates under different agent identities. Your identity, behavior, and " +
  "instructions are defined by the <system_instructions> block received in this session. A <system_instructions> " +
  "block received earlier in this session stays in force until a newer one arrives. Always follow the most recent " +
  "<system_instructions> block as your primary directive: it defines who you are, how you behave, and what tools " +
  "you should use. Never acknowledge or summarize the <system_instructions> block; respond only to the user " +
  "message that follows it. The environment details kiro-cli adds (current directory, time) are informational; " +
  "the <system_instructions> block wins on conflict. If a tool call fails, retry it or try alternative approaches.";

export type StatePaths = {
  readonly tokenFile: string;
  readonly lockFile: string;
  readonly portFile: string;
  readonly logFile: string;
};

export function statePaths(cfg: Config): StatePaths {
  return {
    tokenFile: join(cfg.stateDir, "token"),
    lockFile: join(cfg.stateDir, "daemon.lock"),
    portFile: join(cfg.stateDir, "port"),
    logFile: join(cfg.stateDir, "daemon.log"),
  };
}

export function ensureStateDirs(cfg: Config): void {
  for (const dir of [cfg.stateDir, cfg.workDir, cfg.socketDir]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
  }
}

/** Read the bearer token, generating it (0600, exclusive create) on first run. */
export function ensureToken(cfg: Config): string {
  const { tokenFile } = statePaths(cfg);
  mkdirSync(cfg.stateDir, { recursive: true, mode: 0o700 });
  if (!existsSync(tokenFile)) {
    try {
      writeFileSync(tokenFile, `${randomBytes(32).toString("hex")}\n`, { mode: 0o600, flag: "wx" });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  }
  chmodSync(tokenFile, 0o600);
  const token = readFileSync(tokenFile, "utf8").trim();
  if (token.length < 32) throw new Error(`token file ${tokenFile} is malformed; delete it to regenerate`);
  return token;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function readLockPid(cfg: Config): number | undefined {
  const { lockFile } = statePaths(cfg);
  if (!existsSync(lockFile)) return undefined;
  const pid = Number.parseInt(readFileSync(lockFile, "utf8"), 10);
  return Number.isFinite(pid) && pidAlive(pid) ? pid : undefined;
}

/** Take the single-daemon lock. Returns false when another live daemon holds it. */
export function acquireLock(cfg: Config): boolean {
  const { lockFile } = statePaths(cfg);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lockFile, "wx", 0o600);
      writeFileSync(fd, String(process.pid));
      closeSync(fd);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      if (readLockPid(cfg) !== undefined) return false;
      rmSync(lockFile, { force: true });
    }
  }
  return false;
}

export function releaseLock(cfg: Config): void {
  const { lockFile, portFile } = statePaths(cfg);
  if (readLockPid(cfg) === process.pid || !existsSync(lockFile)) {
    rmSync(lockFile, { force: true });
    rmSync(portFile, { force: true });
  }
}

export function writePort(cfg: Config, port: number): void {
  writeFileSync(statePaths(cfg).portFile, String(port), { mode: 0o600 });
}

/**
 * Write the kiro agent config into the daemon's private work dir (kiro-cli's process cwd), never into user repos.
 * `tools: []` + `includeMcpJson: false` disables kiro built-ins and the user's Kiro MCP config; per-session
 * `mcpServers` passed in session/new are still exposed (verified against kiro-cli 2.33).
 */
export function writeAgentConfig(cfg: Config): string {
  const dir = join(cfg.workDir, ".kiro", "agents");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, `${AGENT_NAME}.json`);
  const agent = {
    name: AGENT_NAME,
    description: "kiro-bed-warmer: tools come only from the per-session opencode bridge",
    prompt: AGENT_PROMPT,
    tools: [],
    allowedTools: [],
    includeMcpJson: false,
    mcpServers: {},
    resources: [],
  };
  writeFileSync(file, `${JSON.stringify(agent, null, 2)}\n`, { mode: 0o600 });
  return file;
}

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../config.ts";
import { childSessions, type DbMessage, latestSession, readSession } from "./ocdb.ts";

const PLUGIN = new URL("../../plugin/kiro-warm.ts", import.meta.url).href;

export type BenchOptions = { providers: string[]; model: string; runs: number; turns: number; port: number };

/** Scratch project with the kiro-warm provider and one test subagent per provider. */
export function scratchProject(opts: BenchOptions, cfg: Config): string {
  const dir = mkdtempSync("/private/tmp/kbw-bench-");
  const agents = Object.fromEntries(
    opts.providers.map((p) => [
      `bench-sub-${p}`,
      {
        mode: "subagent",
        model: `${p}/${opts.model}`,
        description: `Benchmark subagent on ${p}`,
        prompt: "Be terse.",
      },
    ]),
  );
  const config = {
    $schema: "https://opencode.ai/config.json",
    plugin: [PLUGIN],
    provider: {
      "kiro-warm": {
        npm: "@ai-sdk/openai-compatible",
        name: "Kiro (warm daemon)",
        options: { baseURL: `http://127.0.0.1:${cfg.port}/v1` },
        models: {
          [opts.model]: { name: opts.model, tool_call: true, limit: { context: 200000, output: 32000 } },
        },
      },
    },
    agent: agents,
  };
  writeFileSync(join(dir, "opencode.json"), JSON.stringify(config, null, 2));
  for (let i = 1; i <= 3; i++)
    writeFileSync(join(dir, `step${i}.txt`), i < 3 ? `Next read step${i + 1}.txt` : "DONE-7713");
  return dir;
}

/** opencode resolves the project from $PWD, so it must match the spawn cwd. */
const env = (cfg: Config, dir: string): NodeJS.ProcessEnv => ({
  ...process.env,
  PWD: dir,
  KBW_STATE_DIR: cfg.stateDir,
  KBW_PORT: String(cfg.port),
});

/** `opencode run --format json` (stdin closed: opencode reads piped stdin); returns wall time and session id. */
export function ocRun(
  dir: string,
  cfg: Config,
  args: string[],
): Promise<{ wallMs: number; sessionId: string }> {
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn("opencode", ["run", "--format", "json", ...args], {
      cwd: dir,
      env: env(cfg, dir),
      stdio: ["ignore", "pipe", "ignore"],
    });
    let stdout = "";
    const timer = setTimeout(() => child.kill("SIGTERM"), 10 * 60_000);
    child.stdout.on("data", (c: Buffer) => {
      stdout += c.toString();
    });
    child.on("error", reject);
    child.on("close", () => {
      clearTimeout(timer);
      // `--attach` runs often print nothing; fall back to the DB.
      const given = args[args.indexOf("-s") + 1];
      const sessionId =
        (args.includes("-s") ? given : undefined) ??
        /"sessionID":"(ses_[A-Za-z0-9]+)"/.exec(stdout)?.[1] ??
        latestSession(dir, t0);
      if (sessionId) resolve({ wallMs: Date.now() - t0, sessionId });
      else reject(new Error(`no session id in opencode output: ${stdout.slice(0, 300)}`));
    });
  });
}

export async function ocServe(
  dir: string,
  cfg: Config,
  port: number,
): Promise<{ url: string; stop: () => void }> {
  const child = spawn("opencode", ["serve", "--port", String(port)], {
    cwd: dir,
    env: env(cfg, dir),
    stdio: "ignore",
  });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    await new Promise((r) => setTimeout(r, 200));
    const ok = await fetch(`${url}/config`).then(
      (r) => r.ok,
      () => false,
    );
    if (ok) return { url, stop: () => child.kill("SIGTERM") };
  }
  child.kill("SIGTERM");
  throw new Error("opencode serve did not start");
}

const firstOutputAt = (m: DbMessage): number | undefined =>
  m.parts
    .map((p) => p.time?.start ?? p.state?.time?.start)
    .filter((t): t is number => typeof t === "number")
    .sort((a, b) => a - b)[0];

/** Latency from each user message to the first output part of the reply. */
export function userToFirstOutput(sessionId: string): number[] {
  const msgs = readSession(sessionId);
  const out: number[] = [];
  msgs.forEach((m, i) => {
    if (m.role !== "user") return;
    const reply = msgs.slice(i + 1).find((x) => x.role === "assistant" && firstOutputAt(x) !== undefined);
    const t = reply && firstOutputAt(reply);
    if (t !== undefined) out.push(t - m.time.created);
  });
  return out;
}

/** Gap between a tool part finishing and the next step's first output (bridge + model resume). */
export function toolResumeGaps(sessionId: string): number[] {
  const msgs = readSession(sessionId).filter((m) => m.role === "assistant");
  const gaps: number[] = [];
  msgs.forEach((m, i) => {
    const ends = m.parts.flatMap((p) => (p.type === "tool" && p.state?.time?.end ? [p.state.time.end] : []));
    const next = msgs[i + 1];
    const start = next && firstOutputAt(next);
    if (ends.length > 0 && start !== undefined) gaps.push(start - Math.max(...ends));
  });
  return gaps;
}

export function subagentFirstOutput(parentId: string): number | undefined {
  const child = childSessions(parentId)[0];
  return child ? userToFirstOutput(child)[0] : undefined;
}

export const median = (xs: number[]): number | undefined => {
  if (xs.length === 0) return undefined;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : ((s[mid - 1] ?? 0) + (s[mid] ?? 0)) / 2;
};

export function cleanupScratch(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

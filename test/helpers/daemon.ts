import { spawn } from "node:child_process";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { removeDirs, removeKiroSessionsUnder, tempDir } from "./cleanup.ts";

const ROOT = new URL("../..", import.meta.url).pathname;

export type Daemon = {
  base: string;
  token: string;
  stateDir: string;
  logLines: () => Array<Record<string, unknown>>;
  stop: () => Promise<void>;
};

let nextPort = 48100 + Math.floor(Math.random() * 500);
export const freePort = (): number => nextPort++;

/** Write a `kiro-cli` stand-in that runs the fake fixture; returns its path. */
export function fakeKiroBin(dir: string): string {
  const bin = join(dir, "fake-kiro-cli");
  writeFileSync(
    bin,
    `#!/bin/sh\nexec "${process.execPath}" "${join(ROOT, "test/fixtures/fake-kiro.ts")}" "$@"\n`,
  );
  chmodSync(bin, 0o755);
  return bin;
}

/** Start an isolated daemon (own state dir and port). `kiroBin` defaults to the fake kiro-cli. */
export async function startDaemon(env: Record<string, string> = {}, kiroBin?: string): Promise<Daemon> {
  const stateDir = tempDir("state");
  const port = freePort();
  const bin = kiroBin ?? fakeKiroBin(stateDir);
  const child = spawn(process.execPath, [join(ROOT, "src/cli/main.ts"), "start", "--foreground"], {
    env: {
      ...process.env,
      KBW_STATE_DIR: stateDir,
      KBW_PORT: String(port),
      KBW_KIRO_BIN: bin,
      KBW_DEBUG: "1",
      ...env,
    },
    stdio: ["ignore", "ignore", "ignore"],
  });
  const base = `http://127.0.0.1:${port}`;
  let token = "";
  for (let i = 0; i < 200; i++) {
    await new Promise((r) => setTimeout(r, 50));
    try {
      token = readFileSync(join(stateDir, "token"), "utf8").trim();
      const res = await fetch(`${base}/health`, { headers: { authorization: `Bearer ${token}` } });
      const h = (await res.json()) as { processes?: number };
      if (res.ok && (h.processes ?? 0) > 0) break;
    } catch {
      token = "";
    }
  }
  if (!token) throw new Error("daemon did not start");
  return {
    base,
    token,
    stateDir,
    logLines: () =>
      readFileSync(join(stateDir, "daemon.log"), "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as Record<string, unknown>),
    stop: async () => {
      await fetch(`${base}/v1/shutdown`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      }).catch(() => child.kill("SIGTERM"));
      await new Promise<void>((r) => {
        if (child.exitCode !== null) r();
        else child.once("exit", () => r());
      });
      removeKiroSessionsUnder([stateDir]);
      removeDirs([stateDir]);
    },
  };
}

export type Chunk = { choices: Array<{ delta: Record<string, unknown>; finish_reason: string | null }> };

export async function chat(
  d: Daemon,
  body: Record<string, unknown>,
  session = "ses_test",
  signal?: AbortSignal,
  extraHeaders: Record<string, string> = {},
): Promise<{ status: number; chunks: Chunk[]; raw: string }> {
  const res = await fetch(`${d.base}/v1/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${d.token}`,
      "content-type": "application/json",
      "x-session-affinity": session,
      ...extraHeaders,
    },
    body: JSON.stringify({ model: "fake-model", stream: true, ...body }),
    ...(signal ? { signal } : {}),
  });
  const raw = await res.text();
  const chunks = raw
    .split("\n")
    .filter((l) => l.startsWith("data: {"))
    .map((l) => JSON.parse(l.slice(6)) as Partial<Chunk>)
    .filter((c): c is Chunk => Array.isArray(c.choices));
  return { status: res.status, chunks, raw };
}

export const textOf = (chunks: Chunk[]): string =>
  chunks.map((c) => String(c.choices[0]?.delta.content ?? "")).join("");

export const finishOf = (chunks: Chunk[]): string | null | undefined =>
  chunks.map((c) => c.choices[0]?.finish_reason).find((f) => f);

export type ToolCallDelta = { id: string; function: { name: string; arguments: string } };
export const toolCallsOf = (chunks: Chunk[]): ToolCallDelta[] =>
  chunks.flatMap((c) => (c.choices[0]?.delta.tool_calls as ToolCallDelta[] | undefined) ?? []);

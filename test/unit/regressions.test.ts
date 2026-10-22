import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readdirSync, writeFileSync } from "node:fs";
import { connect, createServer } from "node:net";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { KiroProcess } from "../../src/acp/process.ts";
import { ensureDaemon } from "../../src/client.ts";
import { loadConfig } from "../../src/config.ts";
import { estimateUsage } from "../../src/http/sse.ts";
import { createLogger } from "../../src/log.ts";
import { Pool } from "../../src/pool/pool.ts";
import { classifyError } from "../../src/router/turn.ts";
import {
  acquireLock,
  ensureStateDirs,
  readLockPid,
  releaseLock,
  statePaths,
  writeAgentConfig,
} from "../../src/state.ts";
import { removeDirs, tempDir } from "../helpers/cleanup.ts";
import {
  chat,
  type Daemon,
  fakeKiroBin,
  freePort,
  startDaemon,
  textOf,
  toolCallsOf,
} from "../helpers/daemon.ts";

const ALPHA = [
  { type: "function", function: { name: "alpha", parameters: { type: "object", properties: {} } } },
];
const quietLog = createLogger("/dev/null", false);

async function health(d: Daemon): Promise<{ activeTurns: number }> {
  const res = await fetch(`${d.base}/health`, { headers: { authorization: `Bearer ${d.token}` } });
  return (await res.json()) as { activeTurns: number };
}

describe("regressions (daemon, fake kiro-cli)", () => {
  let d: Daemon;
  before(async () => {
    d = await startDaemon({
      KBW_STALL_SECONDS: "1",
      KBW_TOOL_TIMEOUT_MINUTES: "0.02",
      FAKE_COMPACT_MS: "2500",
    });
  });
  after(async () => {
    await d.stop();
  });

  it("retry after a stall where kiro ignores session/cancel does not hang", async () => {
    const r1 = await chat(d, { messages: [{ role: "user", content: "WEDGE" }] }, "b-hard");
    assert.equal(r1.status, 503);
    const msgs = [
      { role: "user", content: "WEDGE" },
      { role: "user", content: "retry" },
    ];
    const r2 = await chat(d, { messages: msgs }, "b-hard", AbortSignal.timeout(15_000));
    assert.equal(r2.status, 200);
    assert.equal(textOf(r2.chunks), "fake: retry");
    assert.equal((await health(d)).activeTurns, 0);
  });

  it("kiro compaction progress keeps the turn alive past the stall timeout", async () => {
    const r = await chat(d, { messages: [{ role: "user", content: "COMPACTSLOW" }] }, "b-compact");
    assert.equal(r.status, 200);
    assert.equal(textOf(r.chunks), "fake: COMPACTSLOW");
  });

  it("above 70% context the system prompt is re-sent once, not on every message", async () => {
    const sys = { role: "system", content: "SYS" };
    const m1 = [sys, { role: "user", content: "PCT:80 ECHOSYS" }];
    assert.equal(textOf((await chat(d, { messages: m1 }, "b-hw")).chunks), "sys=yes");
    const m2 = [...m1, { role: "assistant", content: "sys=yes" }, { role: "user", content: "ECHOSYS a" }];
    assert.equal(textOf((await chat(d, { messages: m2 }, "b-hw")).chunks), "sys=yes");
    const m3 = [...m2, { role: "assistant", content: "sys=yes" }, { role: "user", content: "ECHOSYS b" }];
    assert.equal(textOf((await chat(d, { messages: m3 }, "b-hw")).chunks), "sys=no");
  });

  it("after the tool timeout the turn ends instead of staying active", async () => {
    const r = await chat(
      d,
      { messages: [{ role: "user", content: "RETRYTOOL:alpha" }], tools: ALPHA },
      "b-tt",
    );
    assert.equal(toolCallsOf(r.chunks).length, 1);
    await new Promise((res) => setTimeout(res, 3000));
    assert.equal((await health(d)).activeTurns, 0);
  });

  it("a bridge socket error does not crash the daemon", async () => {
    const sock = readdirSync(join(d.stateDir, "s")).find((f) => f.endsWith(".sock"));
    assert.ok(sock, "expected a spare session bridge socket");
    const c = connect(join(d.stateDir, "s", sock));
    await new Promise<void>((r) => c.once("connect", () => r()));
    for (let i = 0; i < 50; i++)
      c.write(`${JSON.stringify({ jsonrpc: "2.0", id: i, method: "tools/list" })}\n`);
    c.destroy();
    await new Promise((r) => setTimeout(r, 1000));
    assert.equal(
      (await fetch(`${d.base}/health`, { headers: { authorization: `Bearer ${d.token}` } })).status,
      200,
    );
  });

  it("revert + edit of the last user message reaches kiro", async () => {
    await chat(d, { messages: [{ role: "user", content: "first question" }] }, "b-edit");
    const r = await chat(d, { messages: [{ role: "user", content: "EDITED question" }] }, "b-edit");
    assert.equal(textOf(r.chunks), "fake: EDITED question");
  });

  it("a request aborted while queued behind another sends no prompt", async () => {
    const prompts = (): number =>
      d.logLines().filter((l) => l.event === "acp.rpc" && l.dir === "out" && l.method === "session/prompt")
        .length;
    const before = prompts();
    const first = [{ role: "user", content: "SLOWSTART" }];
    const slow = chat(d, { messages: first }, "b-queue");
    await new Promise((r) => setTimeout(r, 100));
    const ac = new AbortController();
    const queued = chat(
      d,
      { messages: [...first, { role: "user", content: "queued" }] },
      "b-queue",
      ac.signal,
    ).catch(() => undefined);
    setTimeout(() => ac.abort(), 200);
    await slow;
    await queued;
    const t0 = Date.now();
    const third = [
      ...first,
      { role: "assistant", content: "fake: SLOWSTART" },
      { role: "user", content: "third" },
    ];
    assert.equal(textOf((await chat(d, { messages: third }, "b-queue")).chunks), "fake: third");
    assert.ok(Date.now() - t0 < 1000, `third request waited ${Date.now() - t0} ms`);
    assert.equal(prompts() - before, 2);
  });

  it("kiro answering after giving up on a handed-off tool call is not lost", async () => {
    const msgs = [{ role: "user", content: "TOOLGIVEUP" }];
    const r1 = await chat(d, { messages: msgs, tools: ALPHA }, "b-giveup");
    const [call] = toolCallsOf(r1.chunks);
    assert.ok(call);
    await new Promise((r) => setTimeout(r, 1000));
    const cont = [
      ...msgs,
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: call.id, type: "function", function: call.function }],
      },
      { role: "tool", tool_call_id: call.id, content: "late result" },
    ];
    const r2 = await chat(d, { messages: cont, tools: ALPHA }, "b-giveup");
    assert.equal(textOf(r2.chunks), "GAVE-UP-ANSWER");
  });

  it("/v1/warm with a malformed body is a 400", async () => {
    const res = await fetch(`${d.base}/v1/warm`, {
      method: "POST",
      headers: { authorization: `Bearer ${d.token}` },
      body: "{not json",
    });
    assert.equal(res.status, 400);
  });

  it("the final chunk reports usage derived from kiro's context % and the window size", async () => {
    const r = await chat(d, { messages: [{ role: "user", content: "PCT:40" }] }, "b-usage", undefined, {
      "x-kbw-context-limit": "100000",
    });
    const last = r.raw
      .split("\n")
      .filter((l) => l.startsWith("data: {"))
      .map((l) => JSON.parse(l.slice(6)) as { usage?: Record<string, number> })
      .at(-1);
    assert.equal(last?.usage?.total_tokens, 40_000);
    assert.ok((last?.usage?.completion_tokens ?? 0) > 0);
    assert.equal((last?.usage?.prompt_tokens ?? 0) + (last?.usage?.completion_tokens ?? 0), 40_000);
  });

  it("identical retry after a stalled turn does not re-send the user message", async () => {
    const msgs = [{ role: "user", content: "hello HICCUP" }];
    assert.equal((await chat(d, { messages: msgs }, "b-dup")).status, 503);
    const r = await chat(d, { messages: msgs }, "b-dup");
    assert.equal(r.status, 200);
    assert.doesNotMatch(textOf(r.chunks), /hello HICCUP/);
  });
});

describe("regressions (components)", () => {
  const dirs: string[] = [];
  after(() => removeDirs(dirs));
  const cfgFor = (over: Record<string, string> = {}) => {
    const stateDir = tempDir("rg");
    dirs.push(stateDir);
    const cfg = loadConfig(
      { KBW_KIRO_BIN: fakeKiroBin(stateDir), KBW_PORT: String(freePort()), ...over },
      { stateDir },
    );
    ensureStateDirs(cfg);
    writeAgentConfig(cfg);
    return cfg;
  };

  it("a kiro-cli that dies during start does not evict a healthy process from the pool", async () => {
    const cfg = cfgFor({ KBW_MAX_SESSIONS_PER_PROCESS: "1" });
    const pool = new Pool(cfg, quietLog);
    await pool.warmUp([cfg.workDir]);
    assert.equal(pool.processCount(), 1);
    process.env.FAKE_INIT_EXIT = "1";
    try {
      await assert.rejects(pool.take(join(cfg.stateDir)));
      await new Promise((r) => setTimeout(r, 1000));
    } finally {
      delete process.env.FAKE_INIT_EXIT;
    }
    assert.equal(pool.processCount(), 1);
    await pool.close();
  });

  it("concurrent takes respect maxSessionsPerProcess", async () => {
    const cfg = cfgFor({ KBW_MAX_SESSIONS_PER_PROCESS: "2" });
    const pool = new Pool(cfg, quietLog);
    const sessions = await Promise.all(
      Array.from({ length: 6 }, (_, i) => pool.take(join(cfg.stateDir, `c${i % 3}`))),
    );
    const perProc = new Map<unknown, number>();
    for (const s of sessions) perProc.set(s.proc, (perProc.get(s.proc) ?? 0) + 1);
    assert.ok(
      [...perProc.values()].every((n) => n <= 2),
      JSON.stringify([...perProc.values()]),
    );
    for (const s of sessions) pool.release(s);
    await pool.close();
  });

  it("usage is omitted without a context %, and output never exceeds the total", () => {
    assert.equal(estimateUsage({ metadata: undefined, wallMs: 1 }, 200_000, 100), undefined);
    const tiny = estimateUsage(
      { metadata: { sessionId: "s", contextUsagePercentage: 0.001 }, wallMs: 1 },
      200_000,
      4000,
    );
    assert.deepEqual(tiny, { prompt_tokens: 0, completion_tokens: 2, total_tokens: 2 });
  });

  it("only auth-like errors are classified as auth", () => {
    for (const m of [
      "Not logged in. Run kiro-cli login",
      "Unauthorized",
      "token expired",
      "Please sign in again",
    ]) {
      assert.equal(classifyError(new Error(m), true).kind, "auth", m);
    }
    for (const m of [
      "ThrottlingException: assigning capacity",
      "designing the response",
      "Request expired",
      "x",
    ]) {
      assert.equal(classifyError(new Error(m), true).kind, "kiro", m);
    }
  });

  it("stopping a kiro-cli that ignores SIGTERM still completes", { timeout: 20_000 }, async () => {
    const cfg = cfgFor();
    process.env.FAKE_IGNORE_TERM = "1";
    const proc = new KiroProcess(cfg, quietLog);
    try {
      await proc.start();
    } finally {
      delete process.env.FAKE_IGNORE_TERM;
    }
    await proc.stop();
    assert.equal(proc.isAlive, false);
  });

  it("a stale lock whose PID now belongs to another process is not treated as the daemon", async () => {
    const cfg = cfgFor();
    const other = spawn("/bin/sleep", ["30"]);
    try {
      writeFileSync(statePaths(cfg).lockFile, String(other.pid));
      assert.equal(readLockPid(cfg), undefined);
      assert.equal(acquireLock(cfg), true);
      releaseLock(cfg);
    } finally {
      other.kill();
    }
  });

  it("ensureDaemon fails fast when the port is taken by something else", { timeout: 30_000 }, async () => {
    const cfg = cfgFor();
    const squatter = createServer(() => undefined);
    await new Promise<void>((r) => squatter.listen(cfg.port, "127.0.0.1", () => r()));
    const t0 = Date.now();
    try {
      await assert.rejects(ensureDaemon(cfg));
    } finally {
      squatter.close();
    }
    assert.ok(Date.now() - t0 < 5000, `took ${Date.now() - t0} ms`);
  });
});

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { KiroProcess } from "../../src/acp/process.ts";
import { ensureDaemon } from "../../src/client.ts";
import { loadConfig } from "../../src/config.ts";
import { createLogger } from "../../src/log.ts";
import { Pool } from "../../src/pool/pool.ts";
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
const quietLog = createLogger(join("/private/tmp", "kbw-null.log"), false);

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
    removeDirs(["/private/tmp/kbw-null.log"]);
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

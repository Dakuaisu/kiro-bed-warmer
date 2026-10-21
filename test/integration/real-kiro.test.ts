import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { removeDirs, removeKiroSessionsUnder, tempDir } from "../helpers/cleanup.ts";
import { chat, type Daemon, finishOf, startDaemon, textOf, toolCallsOf } from "../helpers/daemon.ts";

const MODEL = "claude-haiku-4.5";
const READ = {
  type: "function",
  function: {
    name: "read_file",
    description: "Read a file and return its contents",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  },
};

describe("real kiro-cli (claude-haiku-4.5)", { timeout: 300_000 }, () => {
  let d: Daemon;
  let cwd: string;
  const headers = (): Record<string, string> => ({ "x-kbw-cwd": cwd });
  before(async () => {
    cwd = tempDir("it-cwd");
    mkdirSync(join(cwd, "sub"));
    d = await startDaemon({ KBW_STALL_SECONDS: "60" }, "kiro-cli");
  });
  after(async () => {
    const state = d.stateDir;
    await d.stop();
    removeKiroSessionsUnder([cwd, state]);
    removeDirs([cwd]);
  });

  const ask = (messages: unknown[], session: string, tools?: unknown[]) =>
    chat(d, { model: MODEL, messages, ...(tools ? { tools } : {}) }, session, undefined, headers());

  it("answers, then keeps context on the live session without session/load", async () => {
    const m1 = [
      { role: "system", content: "You are terse." },
      { role: "user", content: "For this test my favourite colour is teal. Reply with exactly: OK" },
    ];
    const r1 = await ask(m1, "it-ctx");
    assert.equal(r1.status, 200);
    assert.match(textOf(r1.chunks), /OK/);
    const m2 = [
      ...m1,
      { role: "assistant", content: textOf(r1.chunks) },
      { role: "user", content: "Which colour did I name? One word." },
    ];
    const r2 = await ask(m2, "it-ctx");
    assert.match(textOf(r2.chunks).toLowerCase(), /teal/);
    const methods = d
      .logLines()
      .filter((l) => l.event === "acp.rpc")
      .map((l) => l.method);
    assert.ok(!methods.includes("session/load"));
  });

  it("round-trips parallel tool calls", async () => {
    const files: Record<string, string> = { "a.txt": "apple", "b.txt": "banana" };
    const m1 = [
      { role: "system", content: "Use the read_file tool. Issue independent reads in parallel in one step." },
      {
        role: "user",
        content:
          "Read a.txt and b.txt (both in parallel), then reply with the two words joined by '+', nothing else.",
      },
    ];
    const r1 = await ask(m1, "it-tools", [READ]);
    assert.equal(finishOf(r1.chunks), "tool_calls");
    const calls = toolCallsOf(r1.chunks);
    assert.equal(calls.length, 2);
    const results = calls.map((c) => {
      const path = String((JSON.parse(c.function.arguments) as { path: string }).path).replace(/^.*\//, "");
      return { role: "tool", tool_call_id: c.id, content: files[path] ?? "not found" };
    });
    const m2 = [
      ...m1,
      {
        role: "assistant",
        content: textOf(r1.chunks) || null,
        tool_calls: calls.map((c) => ({ id: c.id, type: "function", function: c.function })),
      },
      ...results,
    ];
    const r2 = await ask(m2, "it-tools", [READ]);
    assert.equal(finishOf(r2.chunks), "stop");
    assert.match(textOf(r2.chunks), /apple\s*\+\s*banana/);
  });
});

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { chat, type Daemon, finishOf, startDaemon, textOf, toolCallsOf } from "../helpers/daemon.ts";

const TOOLS = ["alpha", "beta", "gamma"].map((name) => ({
  type: "function",
  function: {
    name,
    description: `tool ${name}`,
    parameters: { type: "object", properties: { name: { type: "string" } } },
  },
}));

describe("daemon with fake kiro-cli", () => {
  let d: Daemon;
  before(async () => {
    d = await startDaemon({ KBW_STALL_SECONDS: "1" });
  });
  after(async () => {
    await d.stop();
  });

  it("rejects requests without the bearer token", async () => {
    const res = await fetch(`${d.base}/health`);
    assert.equal(res.status, 401);
  });

  it("streams text and reasoning, then stop", async () => {
    const r = await chat(
      d,
      {
        messages: [
          { role: "system", content: "S" },
          { role: "user", content: "hello" },
        ],
      },
      "s-text",
    );
    assert.equal(r.status, 200);
    assert.equal(textOf(r.chunks), "fake: hello");
    assert.ok(r.chunks.some((c) => c.choices[0]?.delta.reasoning_content === "thinking"));
    assert.equal(finishOf(r.chunks), "stop");
  });

  it("second user turn is sent as a delta on the same kiro session", async () => {
    const m1 = [{ role: "user", content: "first" }];
    await chat(d, { messages: m1 }, "s-delta");
    const r = await chat(
      d,
      {
        messages: [...m1, { role: "assistant", content: "fake: first" }, { role: "user", content: "second" }],
      },
      "s-delta",
    );
    assert.equal(textOf(r.chunks), "fake: second");
    const metrics = (await (
      await fetch(`${d.base}/metrics`, { headers: { authorization: `Bearer ${d.token}` } })
    ).json()) as {
      router: { deltas: number };
    };
    assert.ok(metrics.router.deltas >= 1);
  });

  it("parallel MCP calls become one batched tool_calls response, results resume the turn", async () => {
    const messages = [{ role: "user", content: "CALLTOOLS:alpha,beta,gamma" }];
    const r1 = await chat(d, { messages, tools: TOOLS }, "s-tools");
    assert.equal(finishOf(r1.chunks), "tool_calls");
    const calls = toolCallsOf(r1.chunks);
    assert.deepEqual(calls.map((c) => c.function.name).sort(), ["alpha", "beta", "gamma"]);
    assert.ok(calls.every((c) => JSON.parse(c.function.arguments).name === c.function.name));
    const cont = [
      ...messages,
      {
        role: "assistant",
        content: textOf(r1.chunks),
        tool_calls: calls.map((c) => ({ id: c.id, type: "function", function: c.function })),
      },
      ...calls.map((c) => ({ role: "tool", tool_call_id: c.id, content: `R-${c.function.name}` })),
    ];
    const r2 = await chat(d, { messages: cont, tools: TOOLS }, "s-tools");
    assert.equal(textOf(r2.chunks), "tools said R-alpha|R-beta|R-gamma");
    assert.equal(finishOf(r2.chunks), "stop");
  });

  it("stall before any output -> HTTP 503 with retryable error body", async () => {
    const r = await chat(d, { messages: [{ role: "user", content: "STALL" }] }, "s-stall");
    assert.equal(r.status, 503);
    const body = JSON.parse(r.raw) as { error: { code: string; message: string } };
    assert.equal(body.error.code, "kiro_stall");
    assert.match(body.error.message, /service unavailable/);
  });

  it("stall after partial output -> SSE error chunk, and the session stays usable", async () => {
    const r = await chat(d, { messages: [{ role: "user", content: "PARTIAL" }] }, "s-partial");
    assert.equal(r.status, 200);
    assert.equal(textOf(r.chunks), "partial answer...");
    assert.match(r.raw, /"code":"kiro_stall"/);
    const again = await chat(
      d,
      {
        messages: [
          { role: "user", content: "PARTIAL" },
          { role: "user", content: "ok now" },
        ],
      },
      "s-partial",
    );
    assert.equal(textOf(again.chunks), "fake: ok now");
  });

  it("time spent waiting for opencode to run a tool is not a stall", async () => {
    const messages = [{ role: "user", content: "CALLTOOLS:alpha" }];
    const r1 = await chat(d, { messages, tools: TOOLS }, "s-slowtool");
    const [call] = toolCallsOf(r1.chunks);
    assert.ok(call);
    await new Promise((r) => setTimeout(r, 1800));
    const cont = [
      ...messages,
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: call.id, type: "function", function: call.function }],
      },
      { role: "tool", tool_call_id: call.id, content: "late" },
    ];
    const r2 = await chat(d, { messages: cont, tools: TOOLS }, "s-slowtool");
    assert.equal(textOf(r2.chunks), "tools said late");
  });

  it("client disconnect cancels the turn and the session is reused", async () => {
    const ac = new AbortController();
    const pending = chat(d, { messages: [{ role: "user", content: "STALL" }] }, "s-abort", ac.signal).catch(
      () => undefined,
    );
    await new Promise((r) => setTimeout(r, 300));
    ac.abort();
    await pending;
    const r = await chat(
      d,
      {
        messages: [
          { role: "user", content: "STALL" },
          { role: "user", content: "hi" },
        ],
      },
      "s-abort",
    );
    assert.equal(textOf(r.chunks), "fake: hi");
    assert.ok(d.logLines().some((l) => l.event === "turn.abort" && l.reason === "client_disconnected"));
  });

  it("logged-out kiro-cli -> HTTP 401 telling the user to run kiro-cli login", async () => {
    const r = await chat(d, { messages: [{ role: "user", content: "AUTHFAIL" }] }, "s-auth");
    assert.equal(r.status, 401);
    assert.match(r.raw, /kiro-cli login/);
  });

  it("kiro-cli crash: process respawns and the session is rebuilt from history", async () => {
    const m1 = [{ role: "user", content: "before crash" }];
    await chat(d, { messages: m1 }, "s-crash");
    const pids = d
      .logLines()
      .filter((l) => l.event === "acp.started")
      .map((l) => Number(l.pid));
    for (const pid of pids) {
      try {
        process.kill(pid, "SIGKILL");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err;
      }
    }
    await new Promise((r) => setTimeout(r, 500));
    const msgs = [
      ...m1,
      { role: "assistant", content: "fake: before crash" },
      { role: "user", content: "after crash" },
    ];
    const r = await chat(d, { messages: msgs }, "s-crash");
    assert.equal(r.status, 200);
    assert.equal(textOf(r.chunks), "fake: after crash");
    const events = d.logLines().map((l) => l.event);
    assert.ok(events.includes("acp.exited"));
    assert.ok(events.includes("router.session_lost"));
    assert.ok(events.filter((e) => e === "acp.started").length > pids.length);
  });

  it("invalid body -> 400", async () => {
    const r = await chat(d, { messages: [] }, "s-bad");
    assert.equal(r.status, 400);
  });
});

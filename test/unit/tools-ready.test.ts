import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { chat, type Daemon, startDaemon, textOf } from "../helpers/daemon.ts";

const TOOLS = [
  { type: "function", function: { name: "alpha", parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "beta", parameters: { type: "object", properties: {} } } },
];

const prompts = (d: Daemon): number =>
  d.logLines().filter((l) => l.event === "acp.rpc" && l.dir === "out" && l.method === "session/prompt")
    .length;

describe("a prompt never runs before kiro has registered the tools", () => {
  const daemons: Daemon[] = [];
  after(async () => {
    await Promise.all(daemons.map((d) => d.stop()));
  });

  it("waits for kiro's registration even when it lags the bridge's tools/list", async () => {
    const d = await startDaemon({ FAKE_REGISTER_DELAY_MS: "1500" });
    daemons.push(d);
    const r = await chat(d, { messages: [{ role: "user", content: "ECHOTOOLS" }], tools: TOOLS }, "tr-slow");
    assert.equal(r.status, 200);
    assert.equal(textOf(r.chunks), "tools=2");
  });

  it("re-lists once when kiro misses the change notification", async () => {
    const d = await startDaemon({ FAKE_IGNORE_FIRST_LIST_CHANGED: "1", KBW_TOOLS_READY_SECONDS: "0.5" });
    daemons.push(d);
    const r = await chat(d, { messages: [{ role: "user", content: "ECHOTOOLS" }], tools: TOOLS }, "tr-deaf");
    assert.equal(r.status, 200);
    assert.equal(textOf(r.chunks), "tools=2");
  });

  it("fails retryably without prompting when kiro never registers, then recovers on a fresh session", async () => {
    const d = await startDaemon({ FAKE_NEVER_REGISTER: "1", KBW_TOOLS_READY_SECONDS: "0.5" });
    daemons.push(d);
    const msgs = [{ role: "user", content: "ECHOTOOLS" }];
    const r = await chat(d, { messages: msgs, tools: TOOLS }, "tr-never");
    assert.equal(r.status, 503);
    assert.match(r.raw, /kiro_tools/);
    assert.equal(prompts(d), 0);
    assert.ok(d.logLines().some((l) => l.event === "router.tools_not_registered" && l.retrying === true));
    const toolless = await chat(d, { messages: msgs }, "tr-never");
    assert.equal(toolless.status, 200);
  });
});

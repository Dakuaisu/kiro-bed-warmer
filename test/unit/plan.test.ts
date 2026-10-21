import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fingerprint, hashSystem, type Msg, normalize } from "../../src/router/messages.ts";
import { planRequest, type SessionView } from "../../src/router/plan.ts";

const user = (text: string): Msg => ({ role: "user", text, images: [], files: [] });
const asst = (text: string, ids: string[] = []): Msg => ({
  role: "assistant",
  text,
  toolCalls: ids.map((id) => ({ id, name: "read", args: "{}" })),
});
const tool = (id: string, text = "ok"): Msg => ({ role: "tool", toolCallId: id, text });
const fps = (ms: Msg[]): string[] => ms.map(fingerprint);
const SYS = hashSystem("sys");

function view(known: Msg[], over: Partial<SessionView> = {}): SessionView {
  return {
    history: fps(known),
    systemHash: SYS,
    lastOutcome: "completed",
    pendingToolIds: undefined,
    ...over,
  };
}

describe("planRequest", () => {
  it("unknown session -> reset", () => {
    const msgs = [user("hi")];
    assert.deepEqual(planRequest(undefined, msgs, fps(msgs), SYS, "redeliver"), {
      kind: "reset",
      reason: "unknown_session",
    });
  });

  it("new user turn after our completed reply -> delta with only the new message", () => {
    const known = [user("one")];
    const msgs = [...known, asst("ONE"), user("two")];
    const plan = planRequest(view(known), msgs, fps(msgs), SYS, "redeliver");
    assert.equal(plan.kind, "delta");
    assert.deepEqual(plan.kind === "delta" && plan.messages, [user("two")]);
  });

  it("tool continuation with all pending results -> continue_tools", () => {
    const known = [user("read")];
    const msgs = [...known, asst("", ["c1", "c2"]), tool("c2", "B"), tool("c1", "A")];
    const plan = planRequest(
      view(known, { pendingToolIds: ["c1", "c2"] }),
      msgs,
      fps(msgs),
      SYS,
      "redeliver",
    );
    assert.equal(plan.kind, "continue_tools");
    if (plan.kind === "continue_tools") {
      assert.equal(plan.results.get("c1"), "A");
      assert.equal(plan.results.get("c2"), "B");
    }
  });

  it("pending tools but a result is missing -> abort_tools", () => {
    const known = [user("read")];
    const msgs = [...known, asst("", ["c1", "c2"]), tool("c1")];
    assert.equal(
      planRequest(view(known, { pendingToolIds: ["c1", "c2"] }), msgs, fps(msgs), SYS, "redeliver").kind,
      "abort_tools",
    );
  });

  it("pending tools but user sent a new message instead -> abort_tools", () => {
    const known = [user("read")];
    const msgs = [...known, user("never mind")];
    assert.equal(
      planRequest(view(known, { pendingToolIds: ["c1"] }), msgs, fps(msgs), SYS, "redeliver").kind,
      "abort_tools",
    );
  });

  it("revert/undo (history shorter) -> reset history_mismatch", () => {
    const known = [user("one"), asst("ONE"), user("two"), asst("TWO")];
    const msgs = [user("one"), asst("ONE"), user("two again")];
    const plan = planRequest(view(known), msgs, fps(msgs), SYS, "redeliver");
    assert.deepEqual(plan, { kind: "reset", reason: "history_mismatch" });
  });

  it("compaction (assistant summary replaces history) -> reset", () => {
    const known = [user("one"), asst("ONE", ["c1"]), tool("c1")];
    const msgs = [user("summarize"), asst("Summary of the conversation"), user("continue")];
    assert.equal(planRequest(view(known), msgs, fps(msgs), SYS, "redeliver").kind, "reset");
  });

  it("system change -> reset only when configured", () => {
    const known = [user("one")];
    const msgs = [...known, asst("ONE"), user("two")];
    const other = hashSystem("different system");
    assert.deepEqual(planRequest(view(known), msgs, fps(msgs), other, "reset"), {
      kind: "reset",
      reason: "system_changed",
    });
    assert.equal(planRequest(view(known), msgs, fps(msgs), other, "redeliver").kind, "delta");
  });

  it("assistant output produced elsewhere (after interruption) -> catch_up with those messages", () => {
    const known = [user("task")];
    const msgs = [...known, asst("", ["x1"]), tool("x1"), asst("done elsewhere"), user("next")];
    const plan = planRequest(view(known, { lastOutcome: "interrupted" }), msgs, fps(msgs), SYS, "redeliver");
    assert.equal(plan.kind, "catch_up");
    assert.equal(plan.kind === "catch_up" && plan.messages.length, 4);
  });

  it("identical retry: nudge after a cancelled turn, resend after a kiro error", () => {
    const known = [user("one")];
    const after = (o: SessionView["lastOutcome"]) =>
      planRequest(view(known, { lastOutcome: o }), known, fps(known), SYS, "redeliver");
    assert.deepEqual(after("interrupted"), { kind: "retry" });
    assert.deepEqual(after("failed"), { kind: "delta", messages: [user("one")] });
  });
});

describe("fingerprints", () => {
  it("ignore plugin rewrites of earlier user text and pruned tool output", () => {
    assert.equal(fingerprint(user("a")), fingerprint(user("a\n[reminder injected later]")));
    assert.equal(
      fingerprint(tool("c1", "long output")),
      fingerprint(tool("c1", "[Old tool result content cleared]")),
    );
    assert.notEqual(fingerprint(tool("c1")), fingerprint(tool("c2")));
    assert.notEqual(fingerprint(asst("x")), fingerprint(asst("y")));
  });

  it("system hash ignores skill location paths and line order", () => {
    const a =
      "rules\n<skill>\n<name>pdf</name>\n<location>/a/pdf/SKILL.md</location>\n</skill>\n<skill>\n<name>xlsx</name>\n</skill>";
    const b =
      "rules\n<skill>\n<name>xlsx</name>\n</skill>\n<skill>\n<name>pdf</name>\n<location>/b/pdf/SKILL.md</location>\n</skill>";
    assert.equal(hashSystem(a), hashSystem(b));
    assert.notEqual(hashSystem(a), hashSystem(`${a}\nnew rule`));
  });

  it("normalize joins system messages and maps tool calls", () => {
    const conv = normalize({
      messages: [
        { role: "system", content: "A" },
        { role: "system", content: [{ type: "text", text: "B" }] },
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: "{}" } }],
        },
        { role: "tool", tool_call_id: "c1", content: "file" },
      ],
    });
    assert.equal(conv.system, "A\n\nB");
    assert.deepEqual(conv.messages[1], asst("", ["c1"]));
    assert.deepEqual(conv.messages[2], tool("c1", "file"));
  });
});

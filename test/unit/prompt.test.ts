import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Msg } from "../../src/router/messages.ts";
import { catchUpPrompt, deltaPrompt, seedPrompt, transcript } from "../../src/router/prompt.ts";

const user = (text: string): Msg => ({ role: "user", text, images: [], files: [] });
const textOf = (blocks: ReturnType<typeof seedPrompt>): string =>
  blocks[0]?.type === "text" ? blocks[0].text : "";

describe("prompt building", () => {
  it("first message: system instructions + user text, no transcript", () => {
    const t = textOf(seedPrompt("SYS", [user("hello")]));
    assert.equal(t, "<system_instructions>\nSYS\n</system_instructions>\n\nhello");
  });

  it("seeding with history replays a transcript including tool calls/results", () => {
    const msgs: Msg[] = [
      user("read a"),
      { role: "assistant", text: "", toolCalls: [{ id: "c1", name: "read", args: '{"path":"a"}' }] },
      { role: "tool", toolCallId: "c1", text: "AAA" },
      { role: "assistant", text: "a says AAA", toolCalls: [] },
      user("and b?"),
    ];
    const t = textOf(seedPrompt("SYS", msgs));
    assert.match(t, /<context>\nUser: read a/);
    assert.match(t, /\[Tool call read \{"path":"a"\}\]/);
    assert.match(t, /\[Tool result read: AAA\]/);
    assert.match(t, /Resume and act on the following message\.\n\nand b\?$/);
  });

  it("seeding that ends in tool results restates the open request", () => {
    const msgs: Msg[] = [
      user("find the uuid"),
      { role: "assistant", text: "", toolCalls: [{ id: "c1", name: "read", args: "{}" }] },
      { role: "tool", toolCallId: "c1", text: "uuid-1" },
    ];
    assert.match(
      textOf(seedPrompt("", msgs)),
      /Continue working on the latest user request.*\n\nfind the uuid$/s,
    );
  });

  it("delta sends only new user text, with instructions only when asked", () => {
    assert.equal(textOf(deltaPrompt(undefined, [user("two")])), "two");
    assert.match(textOf(deltaPrompt("SYS", [user("two")])), /^<system_instructions>\nSYS/);
  });

  it("images become ACP image blocks", () => {
    const blocks = deltaPrompt(undefined, [
      { role: "user", text: "see", images: [{ data: "AAAA", mimeType: "image/png" }], files: [] },
    ]);
    assert.deepEqual(blocks[1], { type: "image", data: "AAAA", mimeType: "image/png" });
  });

  it("catch-up wraps foreign steps in context", () => {
    const t = textOf(
      catchUpPrompt(undefined, [
        { role: "assistant", text: "other model said hi", toolCalls: [] },
        user("ok"),
      ]),
    );
    assert.match(t, /outside this session/);
    assert.match(t, /Assistant: other model said hi/);
    assert.match(t, /ok$/);
  });

  it("long transcripts keep the most recent part", () => {
    const big = Array.from({ length: 400 }, (_, i) => user(`${i}:${"x".repeat(1000)}`));
    const t = transcript(big);
    assert.ok(t.length < 310_000);
    assert.match(t, /^\[earlier history omitted\]/);
    assert.match(t, /399:x/);
  });
});

#!/usr/bin/env node
// Fake `kiro-cli acp` for tests. Prompt text controls behaviour:
//   contains "PARTIAL"   -> one text chunk, then silence until session/cancel
//   contains "STALL"     -> never answers until session/cancel
//   contains "AUTHFAIL"  -> JSON-RPC error like a logged-out kiro-cli
//   last line "SLOWSTART" -> thought chunks for FAKE_SLOW_MS, then the answer
//   contains "CALLTOOLS:a,b" -> calls those MCP tools in parallel via the session's MCP server, echoes results
//   last line has "WEDGE" -> never answers, ignores session/cancel too
//   contains "HICCUP"    -> first prompt on the session stalls until cancel, later ones answer
//   contains "COMPACTSLOW" -> compaction progress notices for FAKE_COMPACT_MS, then answers
//   contains "PCT:<n>"   -> session context usage becomes n% (reported in metadata)
//   contains "ECHOSYS"   -> replies "sys=yes|no" (whether <system_instructions> was in the prompt)
//   contains "RETRYTOOL:<name>" -> calls the tool, calls it again if the result is an error, then answers
//   contains "TOOLGIVEUP" -> calls alpha, cancels that MCP call after 500 ms, answers GAVE-UP-ANSWER
//   otherwise            -> streams "fake: <last line>" and ends the turn
// Env: FAKE_INIT_EXIT=1 exits on initialize; FAKE_IGNORE_TERM=1 ignores SIGTERM and stdin EOF;
//      FAKE_IGNORE_LIST_CHANGED=1 never re-lists tools.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

type Json = Record<string, unknown>;
const out = (m: Json): void => {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...m })}\n`);
};
type Sess = { mcp?: ReturnType<typeof spawn>; cancel?: () => void; pct?: number; stalledOnce?: boolean };
const sessions = new Map<string, Sess>();
if (process.env.FAKE_IGNORE_TERM) {
  process.on("SIGTERM", () => undefined);
  setInterval(() => undefined, 60_000);
}
let n = 0;

let callSeq = 0;
function mcpCall(sid: string, name: string): Promise<string> {
  const mcp = sessions.get(sid)?.mcp;
  if (!mcp?.stdin || !mcp.stdout) return Promise.resolve("no mcp");
  const id = `call-${++callSeq}`;
  return new Promise((resolve) => {
    const rl = createInterface({ input: mcp.stdout as NodeJS.ReadableStream });
    rl.on("line", (l) => {
      const m = JSON.parse(l) as Json;
      if (m.id === id) {
        rl.close();
        const content = ((m.result as Json)?.content as Json[]) ?? [];
        resolve(content.map((c) => String(c.text ?? "")).join(""));
      }
    });
    mcp.stdin?.write(
      `${JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: { name } } })}\n`,
    );
  });
}

function update(sessionId: string, u: Json): void {
  out({ method: "session/update", params: { sessionId, update: u } });
}

async function prompt(id: unknown, p: Json): Promise<void> {
  const sid = String(p.sessionId);
  const blocks = (p.prompt as Json[]) ?? [];
  const text = blocks.map((b) => String(b.text ?? "")).join("\n");
  const last = text.trim().split("\n").at(-1) ?? "";
  const s = sessions.get(sid) ?? {};
  sessions.set(sid, s);
  const cancelled = new Promise<void>((r) => {
    s.cancel = r;
  });
  if (text.includes("AUTHFAIL")) {
    return out({
      id,
      error: { code: -32603, message: "Not logged in. Run kiro-cli login to authenticate." },
    });
  }
  const pct = /PCT:(\d+)/.exec(text)?.[1];
  if (pct) s.pct = Number(pct);
  if (last.includes("WEDGE")) return;
  if (text.includes("HICCUP") && !s.stalledOnce) {
    s.stalledOnce = true;
    await cancelled;
    return out({ id, result: { stopReason: "cancelled" } });
  }
  if (text.includes("COMPACTSLOW")) {
    const until = Date.now() + Number(process.env.FAKE_COMPACT_MS ?? 2500);
    while (Date.now() < until) {
      out({
        method: "_kiro.dev/compaction/status",
        params: { sessionId: sid, status: { type: "in_progress" } },
      });
      await new Promise((r) => setTimeout(r, 300));
    }
    out({ method: "_kiro.dev/compaction/status", params: { sessionId: sid, status: { type: "completed" } } });
  }
  if (text.includes("TOOLGIVEUP")) {
    const mcp = s.mcp;
    const callId = `call-${++callSeq}`;
    mcp?.stdin?.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: callId, method: "tools/call", params: { name: "alpha", arguments: {} } })}\n`,
    );
    await new Promise((r) => setTimeout(r, 500));
    mcp?.stdin?.write(
      `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: callId } })}\n`,
    );
    update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "GAVE-UP-ANSWER" } });
    return out({ id, result: { stopReason: "end_turn" } });
  }
  const retryTool = /RETRYTOOL:(\w+)/.exec(text)?.[1];
  if (retryTool) {
    let res = await mcpCall(sid, retryTool);
    if (res.includes("Error")) res = await mcpCall(sid, retryTool);
    update(sid, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: `tool said ${res}` },
    });
    return out({ id, result: { stopReason: "end_turn" } });
  }
  if (text.includes("PARTIAL")) {
    update(sid, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: "partial answer..." },
    });
    await cancelled;
    return out({ id, result: { stopReason: "cancelled" } });
  }
  if (text.includes("STALL")) {
    await cancelled;
    return out({ id, result: { stopReason: "cancelled" } });
  }
  if (last.includes("SLOWSTART")) {
    const until = Date.now() + Number(process.env.FAKE_SLOW_MS ?? 2000);
    while (Date.now() < until) {
      update(sid, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "." } });
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  const tools = /CALLTOOLS:([\w,]+)/.exec(text)?.[1]?.split(",");
  if (tools) {
    update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "calling " } });
    const results = await Promise.all(tools.map((t) => mcpCall(sid, t)));
    update(sid, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: `tools said ${results.join("|")}` },
    });
    return out({ id, result: { stopReason: "end_turn" } });
  }
  update(sid, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking" } });
  const reply = text.includes("ECHOSYS")
    ? `sys=${text.includes("<system_instructions>") ? "yes" : "no"}`
    : `fake: ${last}`;
  update(sid, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: reply } });
  out({
    method: "_kiro.dev/metadata",
    params: { sessionId: sid, contextUsagePercentage: s.pct ?? 1.5, turnDurationMs: 5 },
  });
  out({ id, result: { stopReason: "end_turn" } });
}

function newSession(id: unknown, p: Json): void {
  const sid = `fake-${process.pid}-${++n}`;
  const servers = (p.mcpServers as Json[]) ?? [];
  const spec = servers[0];
  const s: Sess = {};
  if (spec) {
    const mcp = spawn(String(spec.command), (spec.args as string[]) ?? [], {
      stdio: ["pipe", "pipe", "ignore"],
    });
    s.mcp = mcp;
    mcp.stdin?.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: "init", method: "initialize", params: { protocolVersion: "2025-11-25" } })}\n`,
    );
    createInterface({ input: mcp.stdout as NodeJS.ReadableStream }).on("line", (l) => {
      if (
        !process.env.FAKE_IGNORE_LIST_CHANGED &&
        (JSON.parse(l) as Json).method === "notifications/tools/list_changed"
      ) {
        mcp.stdin?.write(
          `${JSON.stringify({ jsonrpc: "2.0", id: `list-${++callSeq}`, method: "tools/list", params: {} })}\n`,
        );
      }
    });
  }
  sessions.set(sid, s);
  out({
    id,
    result: {
      sessionId: sid,
      models: { currentModelId: "auto", availableModels: [{ modelId: "fake-model", name: "fake-model" }] },
    },
  });
}

createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line) as Json;
  const p = (m.params as Json) ?? {};
  switch (m.method) {
    case "initialize":
      if (process.env.FAKE_INIT_EXIT) process.exit(1);
      return out({ id: m.id, result: { protocolVersion: 1, agentInfo: { name: "fake", version: "0" } } });
    case "session/new":
      return newSession(m.id, p);
    case "session/set_model":
      return out({ id: m.id, result: {} });
    case "_kiro.dev/commands/execute":
      return out({ id: m.id, result: { success: true } });
    case "session/prompt":
      return void prompt(m.id, p);
    case "session/cancel":
      return sessions.get(String(p.sessionId))?.cancel?.();
    default:
      if (m.id !== undefined) out({ id: m.id, result: null });
  }
});
process.stdin.on("end", () => {
  if (process.env.FAKE_IGNORE_TERM) return;
  for (const s of sessions.values()) s.mcp?.kill();
  process.exit(0);
});
